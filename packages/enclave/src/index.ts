/**
 * pi-enclave
 *
 * VM-isolated enclave for pi with automatic secret protection.
 * All pi tools (bash, read, write, edit) execute inside a Gondolin micro-VM.
 * Secrets never enter the VM; the HTTP proxy injects them on the wire.
 *
 * See README.md for architecture and configuration details.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";

import {
	addPackageToConfig,
	ensureGlobalConfig,
	globalConfigPath,
	globalDropInDir,
	initProjectConfig,
	loadConfig,
	projectConfigPath,
	tildify,
} from "./config.js";
import type { ResolvedSecret } from "./config.js";
import { resolveEnv, resolveSecrets } from "./secrets.js";
import { createVmBashOps, createVmEditOps, createVmReadOps, createVmWriteOps, shQuote } from "./tools.js";
import { EnclaveVM, checkQemuAvailable } from "./vm.js";

// ---------------------------------------------------------------------------
// Package name extraction: "ripgrep-14.1.1-r0" -> "ripgrep"
// ---------------------------------------------------------------------------

function extractPkgName(versionedName: string): string {
	const match = versionedName.match(/^(.+?)-\d/);
	return match ? match[1] : versionedName;
}

// ---------------------------------------------------------------------------
// /enclave add: search, confirm, install, persist
// ---------------------------------------------------------------------------

async function handleAddPackage(
	query: string,
	enclaveVm: EnclaveVM,
	cwd: string,
	ctx: {
		ui: {
			notify: (message: string, level?: "info" | "warning" | "error") => void;
			confirm: (title: string, message: string) => Promise<boolean>;
			select: (title: string, options: string[]) => Promise<string | undefined>;
		};
	},
): Promise<void> {
	const vm = enclaveVm.rawVm;

	// Shell-safe query for apk commands
	const q = shQuote(query);

	// Try exact match (apk add during VM startup populates the index cache)
	let exactResult = await vm.exec(`apk search --exact ${q}`);

	// If the cache is missing, try refreshing it
	if (!exactResult.ok && exactResult.stderr.includes("No such file")) {
		await vm.exec("apk update --quiet");
		exactResult = await vm.exec(`apk search --exact ${q}`);
	}

	let targetPkg: string | undefined;

	if (exactResult.ok && exactResult.stdout.trim()) {
		// Exact package exists, show info and confirm
		const infoResult = await vm.exec(`apk info ${q}`);
		const info = infoResult.ok ? infoResult.stdout.trim() : `Package: ${query}`;
		const ok = await ctx.ui.confirm(`🧊 Install ${query}?`, info);
		if (ok) targetPkg = query;
	} else {
		// Substring search on package names
		const searchResult = await vm.exec(`apk search ${q}`);
		const rawLines = searchResult.ok ? searchResult.stdout.trim().split("\n").filter(Boolean) : [];

		// Filter out -doc, -dev, -completion, -pyc subpackages
		const filtered = rawLines.filter(
			(l) => !/-(?:doc|dev|lang|dbg|bash-completion|zsh-completion|fish-completion|pyc)-\d/.test(l),
		);

		if (filtered.length === 0) {
			ctx.ui.notify(`No packages found for "${query}".`, "warning");
			return;
		}

		// Get descriptions for each match
		const pkgNames = filtered.slice(0, 10).map(extractPkgName);
		const uniqueNames = [...new Set(pkgNames)];

		const options: string[] = [];
		for (const name of uniqueNames) {
			const descResult = await vm.exec(`apk info --description ${shQuote(name)}`);
			const desc = descResult.ok
				? descResult.stdout
						.trim()
						.split("\n")
						.find((l) => !l.includes("description:") && l.trim())
				: undefined;
			options.push(desc ? `${name} \u2014 ${desc.trim()}` : name);
		}
		options.push("Cancel");

		const choice = await ctx.ui.select(`🧊 No exact match for "${query}". Select a package:`, options);
		if (!choice || choice === "Cancel") return;

		targetPkg = choice.split(" \u2014 ")[0];
	}

	if (!targetPkg) return;

	// Install
	const installResult = await enclaveVm.installPackage(targetPkg);
	if (!installResult.ok) {
		ctx.ui.notify(`\u274C Failed to install ${targetPkg}: ${installResult.stderr.slice(0, 200)}`, "error");
		return;
	}

	// Offer to persist
	const saveChoice = await ctx.ui.select(`\u2705 Installed ${targetPkg}. Save to config?`, [
		"Save to project (.pi/enclave.toml)",
		`Save to global (${tildify(globalConfigPath())})`,
		"Don't save (this session only)",
	]);

	if (saveChoice === "Save to project (.pi/enclave.toml)") {
		addPackageToConfig(cwd, targetPkg, "project");
		ctx.ui.notify(`🧊 Added ${targetPkg} to .pi/enclave.toml`);
	} else if (saveChoice?.startsWith("Save to global")) {
		addPackageToConfig(cwd, targetPkg, "global");
		ctx.ui.notify(`🧊 Added ${targetPkg} to ${tildify(globalConfigPath())}`);
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** Session entry type for recording per-session on/off toggle. */
const SESSION_ENTRY_TYPE = "enclave:active";

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// Pre-flight: check QEMU
	// -----------------------------------------------------------------------
	const qemu = checkQemuAvailable();
	if (!qemu.available) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(qemu.message!, "error");
		});
		return;
	}

	// -----------------------------------------------------------------------
	// Ensure global config template exists
	// -----------------------------------------------------------------------
	ensureGlobalConfig();

	// -----------------------------------------------------------------------
	// Load config and secrets
	// -----------------------------------------------------------------------
	const localCwd = process.cwd();
	const { merged, policies, hasGlobalConfig, hasProjectConfig, dropIns } = loadConfig(localCwd);
	const image = merged.image;
	const packages = merged.packages ?? [];
	const extraMounts = merged.mounts ?? [];
	const gitCredentials = merged["git-credentials"] ?? [];
	// Network allowlist is derived from secret hosts (Gondolin builds the allowlist)
	const allowedHosts: string[] | undefined = undefined;

	// Resolve env vars from config (non-secret, injected as real VM env vars)
	const extraEnv = resolveEnv(merged.env);
	const setupScript = merged.setup;

	let secrets: ResolvedSecret[];
	try {
		secrets = resolveSecrets(merged.secrets);
	} catch (err) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`pi-enclave: failed to resolve secrets: ${(err as Error).message}`, "error");
		});
		return;
	}

	// -----------------------------------------------------------------------
	// Activation state
	// -----------------------------------------------------------------------
	// enabled from config (undefined = not configured)
	const configEnabled = merged.enabled;
	// session override (set by /enclave on|off, or from session log on resume)
	let sessionOverride: boolean | undefined;

	function isActive(): boolean {
		if (sessionOverride !== undefined) return sessionOverride;
		return configEnabled === true;
	}

	function getSessionActivation(ctx: ExtensionContext): boolean | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === SESSION_ENTRY_TYPE) {
				return entry.data as boolean;
			}
		}
		return undefined;
	}

	// -----------------------------------------------------------------------
	// VM lifecycle
	// -----------------------------------------------------------------------
	let enclaveVm: EnclaveVM | undefined;
	let vmStarting: Promise<EnclaveVM> | undefined;

	async function shutdownVm() {
		if (enclaveVm) {
			await enclaveVm.close();
			enclaveVm = undefined;
		}
		vmStarting = undefined;
	}

	async function ensureVm(ctx: ExtensionContext): Promise<EnclaveVM | null> {
		if (!isActive()) return null;

		if (enclaveVm?.isRunning) return enclaveVm;
		if (vmStarting) return vmStarting;

		vmStarting = (async () => {
			ctx.ui.setStatus("enclave", "🧊 Starting VM...");

			const instance = new EnclaveVM({
				workspaceDir: localCwd,
				image,
				packages,
				extraMounts,
				secrets,
				gitCredentials,
				extraEnv,
				setupScript,
				allowedHosts,
				policies,
				onPolicyPrompt: async (method, url, hostname) => {
					if (!ctx.hasUI) return false;
					return ctx.ui.confirm(
						"Network request needs approval",
						`${method} ${url}\nHost: ${hostname}\n\nAllow this request?`,
					);
				},
				onStatus: (message) => {
					ctx.ui.setStatus("enclave", `🧊 ${message}`);
				},
			});

			await instance.start();
			enclaveVm = instance;
			ctx.ui.setStatus("enclave", "🧊 Enclave active");
			setTimeout(() => ctx.ui.setStatus("enclave", undefined), 5000);

			return instance;
		})();

		return vmStarting;
	}

	// -----------------------------------------------------------------------
	// Session start: restore override, show hint if not configured
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// Restore session override from log (handles resume)
		const prev = getSessionActivation(ctx);
		if (prev !== undefined) {
			sessionOverride = prev;
		}

		if (isActive()) {
			// Start VM eagerly so it's ready when the first tool runs
			ensureVm(ctx);
			// Send hint if not already in this session's history
			if (!isLastHintActive(ctx)) {
				sendEnclaveHint();
			}
		} else if (configEnabled === undefined && sessionOverride === undefined) {
			ctx.ui.notify("🧊 pi-enclave is installed but not enabled. Run /enclave init to set up.");
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		await shutdownVm();
		ctx.ui.setStatus("enclave", undefined);
		// Restore from new session's log
		sessionOverride = getSessionActivation(ctx);

		if (isActive()) {
			ensureVm(ctx);
			if (!isLastHintActive(ctx)) {
				sendEnclaveHint();
			}
		}
	});

	// -----------------------------------------------------------------------
	// Register VM-backed tools
	// -----------------------------------------------------------------------
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await ensureVm(ctx);
			if (!vm) return localRead.execute(id, params, signal, onUpdate);
			return createReadTool(localCwd, { operations: createVmReadOps(vm.rawVm) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await ensureVm(ctx);
			if (!vm) return localWrite.execute(id, params, signal, onUpdate);
			return createWriteTool(localCwd, { operations: createVmWriteOps(vm.rawVm) }).execute(
				id,
				params,
				signal,
				onUpdate,
			);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await ensureVm(ctx);
			if (!vm) return localEdit.execute(id, params, signal, onUpdate);
			return createEditTool(localCwd, { operations: createVmEditOps(vm.rawVm) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await ensureVm(ctx);
			if (!vm) return localBash.execute(id, params, signal, onUpdate);
			return createBashTool(localCwd, { operations: createVmBashOps(vm.rawVm) }).execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", (_event, _ctx) => {
		if (!enclaveVm?.isRunning) return;
		return { operations: createVmBashOps(enclaveVm.rawVm) };
	});

	// -----------------------------------------------------------------------
	// Enclave context messages (added to conversation, not system prompt)
	// -----------------------------------------------------------------------
	const ENCLAVE_HINT =
		"🧊 Enclave active. All tools are running inside an isolated Alpine Linux VM. If a command is not found, install it with `/enclave add <package>`. Package names may differ from binary names (e.g. `github-cli` for `gh`).";

	/** Check if the most recent enclave message is an "on" hint (not an "off"). */
	function isLastHintActive(ctx: ExtensionContext): boolean {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom_message" && e.customType === "enclave:info") return true;
			if (e.type === "custom_message" && e.customType === "enclave:off") return false;
		}
		return false;
	}

	function sendEnclaveHint() {
		pi.sendMessage({ customType: "enclave:info", content: ENCLAVE_HINT, display: true }, { deliverAs: "nextTurn" });
	}

	function sendEnclaveOff() {
		pi.sendMessage(
			{ customType: "enclave:off", content: "🧊 Enclave disabled. Tools are running on the host.", display: true },
			{ deliverAs: "nextTurn" },
		);
	}

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------
	pi.registerCommand("enclave", {
		description: "Manage enclave: /enclave [status|init|on|off|restart|add <pkg>]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] || "status";

			switch (subcommand) {
				case "status": {
					const lines: string[] = [];

					// State
					if (enclaveVm?.isRunning) {
						lines.push("🧊 Enclave active");
					} else if (isActive()) {
						lines.push("🧊 Enabled, VM starts on next tool use");
					} else {
						lines.push("🧊 Not enabled");
					}
					lines.push("");

					// Config sources
					const configLines: string[] = [];
					if (hasGlobalConfig) configLines.push(`  ${tildify(globalConfigPath())}`);
					if (dropIns.length) configLines.push(`  ${tildify(globalDropInDir())}/*`);
					if (hasProjectConfig) configLines.push(`  ${tildify(join(localCwd, ".pi", "enclave.toml"))}`);
					if (configLines.length) {
						lines.push("Config:");
						lines.push(...configLines);
					} else {
						lines.push("Config: none");
					}
					lines.push("");

					// What's inside
					lines.push(`Packages:  ${packages.join(", ")}`);

					const secretNames = secrets.map((s) => s.name).join(", ");
					if (secretNames) lines.push(`Secrets:   ${secretNames}`);

					const envNames = Object.keys(extraEnv).join(", ");
					if (envNames) lines.push(`Env:       ${envNames}`);

					const hostNames = [...policies.keys()].join(", ");
					if (hostNames) lines.push(`Policies:  ${hostNames}`);

					ctx.ui.notify(lines.join("\n"));
					break;
				}

				case "init": {
					const createdGlobal = ensureGlobalConfig();
					const createdProject = initProjectConfig(localCwd);

					const messages: string[] = [];
					for (const path of createdGlobal) {
						messages.push(`Created ${tildify(path)}`);
					}
					if (createdProject) {
						messages.push("Created .pi/enclave.toml with enabled = true");
						// Activate for this session too
						sessionOverride = true;
						pi.appendEntry(SESSION_ENTRY_TYPE, true);
					} else {
						messages.push(".pi/enclave.toml already exists");
					}

					ctx.ui.notify(`🧊 ${messages.join("\n")}`);

					if (createdProject) {
						ctx.ui.notify("Reload with /reload to apply the new config.", "info");
					}
					break;
				}

				case "on": {
					sessionOverride = true;
					pi.appendEntry(SESSION_ENTRY_TYPE, true);
					sendEnclaveHint();
					break;
				}

				case "off": {
					sessionOverride = false;
					pi.appendEntry(SESSION_ENTRY_TYPE, false);
					await shutdownVm();
					ctx.ui.setStatus("enclave", undefined);
					sendEnclaveOff();
					break;
				}

				case "restart": {
					await shutdownVm();
					ctx.ui.notify("🧊 pi-enclave: VM will restart on next tool use.");
					break;
				}

				case "add": {
					const query = parts.slice(1).join(" ");
					if (!query) {
						ctx.ui.notify("Usage: /enclave add <package-name>", "warning");
						return;
					}

					// Enable for this session if not already
					if (!isActive()) {
						sessionOverride = true;
						pi.appendEntry(SESSION_ENTRY_TYPE, true);
					}

					const vmForAdd = await ensureVm(ctx);
					if (!vmForAdd) {
						ctx.ui.notify("Failed to start VM.", "error");
						return;
					}
					await handleAddPackage(query, vmForAdd, localCwd, ctx);
					break;
				}

				default:
					ctx.ui.notify("Usage: /enclave [status|init|on|off|restart|add <pkg>]", "warning");
			}
		},
	});

	// -----------------------------------------------------------------------
	// Shutdown
	// -----------------------------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!enclaveVm) return;
		ctx.ui.setStatus("enclave", "🧊 Stopping enclave...");
		await shutdownVm();
	});
}
