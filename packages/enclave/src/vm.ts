/**
 * VM lifecycle management.
 *
 * Creates and manages the Gondolin micro-VM, wiring up:
 * - Workspace mount (RealFSProvider with ShadowProvider for config protection)
 * - HTTP hooks (secret injection + policy enforcement)
 * - Package installation
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	type CreateHttpHooksOptions,
	type ExecResult,
	RealFSProvider,
	type SecretDefinition,
	ShadowProvider,
	VM,
	createHttpHooks,
	createShadowPathPredicate,
} from "@earendil-works/gondolin";

import type { GitCredentialDef, ResolvedHostPolicy, ResolvedSecret } from "./config.js";
import { checkGraphQLPolicy, parseGraphQLBody } from "./graphql.js";
import { evaluateRequest } from "./policy.js";
import { type TmpRedirect, installTmpRedirect } from "./tmp-redirect.js";

export interface ExtraMount {
	path: string;
	readonly: boolean;
}

export interface EnclaveVMOptions {
	/** Host directory to mount inside the VM */
	workspaceDir: string;
	/** Alpine packages to install */
	packages: string[];
	/** Additional directories to mount in the VM */
	extraMounts: ExtraMount[];
	/** Resolved secrets for proxy injection */
	secrets: ResolvedSecret[];
	/** Git credential helpers to configure */
	gitCredentials: GitCredentialDef[];
	/** Extra env vars to set in the VM (non-secret, from config [env] section) */
	extraEnv: Record<string, string>;
	/** Concatenated setup scripts to run after package install */
	setupScript: string | undefined;
	/** Host allowlist (undefined = allow all) */
	allowedHosts: string[] | undefined;
	/** Per-host HTTP policies */
	policies: Map<string, ResolvedHostPolicy>;
	/** Callback when a request needs user prompt */
	onPolicyPrompt?: (method: string, url: string, hostname: string) => Promise<boolean>;
	/** Callback for debug/status messages */
	onStatus?: (message: string) => void;
}

export class EnclaveVM {
	private vm: VM | undefined;
	private tmpRedirect: TmpRedirect | undefined;
	private closed = false;
	private readonly options: EnclaveVMOptions;

	/** Access the underlying Gondolin VM for creating tool operations. */
	get rawVm(): VM {
		if (!this.vm) throw new Error("pi-enclave: VM not started");
		return this.vm;
	}

	constructor(options: EnclaveVMOptions) {
		this.options = options;
	}

	/**
	 * Start the VM. Call once before exec().
	 */
	async start(): Promise<void> {
		if (this.vm) return;
		if (this.closed) throw new Error("pi-enclave: VM has been closed");

		const { workspaceDir, secrets, allowedHosts, policies, onPolicyPrompt } = this.options;

		this.options.onStatus?.("Starting VM...");

		// Build secret definitions for Gondolin
		const secretDefs: Record<string, SecretDefinition> = {};
		for (const secret of secrets) {
			secretDefs[secret.name] = {
				hosts: secret.hosts,
				value: secret.value,
			};
		}

		// Build HTTP hooks
		const hookOptions: CreateHttpHooksOptions = {
			secrets: secretDefs,
			blockInternalRanges: true,
		};

		// Gondolin's createHttpHooks builds an allowlist from secret hosts.
		// If that list is non-empty, only those hosts are reachable.
		// We must always include Alpine repos (for apk) and, when the user
		// configured an explicit allowlist, merge that in too.
		const secretHosts = secrets.flatMap((s) => s.hosts);
		const needsAllowlist = allowedHosts || secretHosts.length > 0;
		if (needsAllowlist) {
			hookOptions.allowedHosts = [...(allowedHosts ?? []), "dl-cdn.alpinelinux.org", ...secretHosts];
		}

		// Policy enforcement via isRequestAllowed (method + path).
		// For hosts with a graphql policy, POST to the graphql endpoint is
		// allowed at this level; the onRequest hook does deeper inspection.
		if (policies.size > 0) {
			hookOptions.isRequestAllowed = async (request: Request) => {
				const url = new URL(request.url);
				const hostPolicy = policies.get(url.hostname);

				// If the request targets a GraphQL endpoint that has a policy,
				// let it through to onRequest for body-level inspection.
				if (hostPolicy?.graphql && request.method === "POST" && url.pathname === hostPolicy.graphql.endpoint) {
					return true;
				}

				const decision = evaluateRequest(policies, url.hostname, request.method, url.pathname);

				if (decision === "allow") return true;
				if (decision === "deny") return false;

				// "prompt" - ask user if callback provided, otherwise deny
				if (decision === "prompt" && onPolicyPrompt) {
					return onPolicyPrompt(request.method, request.url, url.hostname);
				}

				return false;
			};
		}

		// GraphQL policy enforcement via onRequest (has access to body).
		// When a host has a graphql policy, parse the body and check
		// operations against the allow lists.
		hookOptions.onRequest = async (request: Request) => {
			if (request.method !== "POST") return;
			const url = new URL(request.url);

			// Find the host policy with a matching GraphQL endpoint
			const hostPolicy = policies.get(url.hostname);
			if (!hostPolicy?.graphql || url.pathname !== hostPolicy.graphql.endpoint) return;

			const gqlPolicy = hostPolicy.graphql;

			// Parse the GraphQL body
			let bodyText: string;
			try {
				const cloned = request.clone();
				bodyText = await cloned.text();
			} catch {
				return;
			}

			const operations = parseGraphQLBody(bodyText);
			if (!operations) {
				// Can't parse the GraphQL body. Fail closed: treat as denied.
				if (gqlPolicy.unmatched === "allow") return;
				return new Response(
					JSON.stringify({ errors: [{ message: "Blocked by pi-enclave: unparseable GraphQL body" }] }),
					{ status: 403, headers: { "Content-Type": "application/json" } },
				);
			}
			if (operations.length === 0) return;

			const result = checkGraphQLPolicy(operations, gqlPolicy.allow);
			if (result.allowed) return;

			// Some operations were denied, check unmatched policy
			if (gqlPolicy.unmatched === "allow") return;
			if (gqlPolicy.unmatched === "deny") {
				return new Response(
					JSON.stringify({ errors: [{ message: `Blocked by pi-enclave: ${result.deniedFields.join(", ")}` }] }),
					{ status: 403, headers: { "Content-Type": "application/json" } },
				);
			}

			// Prompt user
			if (onPolicyPrompt) {
				const fieldList = result.deniedFields.join(", ");
				const allowed = await onPolicyPrompt(
					"GRAPHQL",
					`${url.hostname}${gqlPolicy.endpoint}: ${fieldList}`,
					url.hostname,
				);
				if (!allowed) {
					return new Response(JSON.stringify({ errors: [{ message: `Blocked by pi-enclave: ${fieldList}` }] }), {
						status: 403,
						headers: { "Content-Type": "application/json" },
					});
				}
			} else {
				return new Response(JSON.stringify({ errors: [{ message: "Blocked by pi-enclave policy" }] }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
		};

		const { httpHooks, env } = createHttpHooks(hookOptions);

		// Build VFS: mount workspace at the same path as on the host.
		// This makes the VM transparent: paths match between host and guest.
		const realFs = new RealFSProvider(workspaceDir);
		const shadowedFs = new ShadowProvider(realFs, {
			shouldShadow: createShadowPathPredicate(["/.pi/enclave.toml"]),
			writeMode: "deny",
		});

		const mounts: Record<string, RealFSProvider | ShadowProvider> = {
			[workspaceDir]: shadowedFs,
		};

		// Extra mounts (e.g. jj repo root, shared directories).
		// Skip paths that don't exist on the host (common with optional mounts like .jj/.git).
		for (const extra of this.options.extraMounts) {
			if (mounts[extra.path]) continue; // workspace already mounted
			if (!existsSync(extra.path)) continue;
			const provider = new RealFSProvider(extra.path);
			if (extra.readonly) {
				mounts[extra.path] = new ShadowProvider(provider, {
					shouldShadow: () => true,
					writeMode: "deny",
				});
			} else {
				mounts[extra.path] = provider;
			}
		}

		// Redirect /tmp file operations from host-side extensions into a
		// dedicated subdirectory and mount it at /tmp in the VM. This makes
		// files written by extensions (e.g. librarian saving fetched content
		// to /tmp/pi-librarian/...) visible inside the guest at their
		// original paths, without exposing all of host /tmp.
		//
		// Two layers of interception:
		// - ESM loader hooks (module.register) replace node:fs imports with
		//   wrapper modules, catching static named imports in extensions
		//   loaded after the hooks are registered.
		// - CJS monkey-patches on require("fs") do the actual path rewriting.
		//
		// Not intercepted: code that imported node:fs before hook
		// registration (pi internals, this extension), and child processes.
		// Users who need full /tmp visibility can add mounts = ["/tmp"]
		// in their enclave config.
		if (!mounts["/tmp"]) {
			this.tmpRedirect = installTmpRedirect();
			mounts["/tmp"] = new RealFSProvider(this.tmpRedirect.sharedDir);
		}

		// Create and start VM
		this.vm = await VM.create({
			httpHooks,
			env: {
				...env,
				...this.options.extraEnv,
				HOME: "/root",
				TERM: "xterm-256color",
			},
			vfs: {
				mounts,
			},
			sessionLabel: "pi-enclave",
		});

		this.options.onStatus?.("Installing packages...");

		// Install packages first (git, jj, etc. aren't in base Alpine)
		const packages = this.options.packages;
		if (packages.length > 0) {
			const result = await this.vm.exec(`apk add --no-progress ${packages.map(shellEscape).join(" ")}`);
			if (!result.ok) {
				this.options.onStatus?.(`Enclave active (package install warning: ${result.stderr.trim().split("\n").pop()})`);
				return;
			}
		}

		// Git: credential helpers from config
		// Secret env vars contain Gondolin placeholders; the HTTP proxy
		// decodes Basic auth, swaps placeholders for real values, re-encodes.
		for (const cred of this.options.gitCredentials) {
			await this.vm.exec(
				`git config --global credential.https://${shellEscape(cred.host)}.helper ` +
					`'!f() { echo "username=${shellEscape(cred.username)}"; echo "password=$${cred.secret}"; }; f'`,
			);
		}

		// Run setup scripts from config (each drop-in's setup, concatenated)
		if (this.options.setupScript) {
			this.options.onStatus?.("Running setup...");
			const result = await this.vm.exec(this.options.setupScript);
			if (!result.ok) {
				this.options.onStatus?.(`Enclave active (setup warning: ${result.stderr.trim().split("\n").pop()})`);
				return;
			}
		}

		this.options.onStatus?.("VM ready");
	}

	/**
	 * Install additional packages at runtime.
	 */
	async installPackage(pkg: string): Promise<ExecResult> {
		if (!this.vm) throw new Error("pi-enclave: VM not started");
		return this.vm.exec(`apk add --no-progress ${shellEscape(pkg)}`);
	}

	/**
	 * Check if the VM is running.
	 */
	get isRunning(): boolean {
		return this.vm !== undefined && !this.closed;
	}

	/**
	 * Shut down the VM.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.tmpRedirect) {
			this.tmpRedirect.uninstall();
			this.tmpRedirect = undefined;
		}
		if (this.vm) {
			await this.vm.close();
			this.vm = undefined;
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Check if QEMU is available on the host.
 */
export function checkQemuAvailable(): { available: boolean; message?: string } {
	try {
		execSync("which qemu-system-aarch64", { stdio: "ignore" });
		return { available: true };
	} catch {
		const platform = process.platform;
		let installHint: string;
		if (platform === "darwin") {
			installHint = "Install with: brew install qemu";
		} else if (platform === "linux") {
			installHint =
				"Install with: sudo apt install qemu-system-aarch64 (Debian/Ubuntu) or sudo pacman -S qemu-full (Arch)";
		} else {
			installHint = "QEMU is required but your platform may not be supported.";
		}

		return {
			available: false,
			message: `pi-enclave requires QEMU but qemu-system-aarch64 was not found.\n${installHint}`,
		};
	}
}
