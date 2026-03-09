/**
 * Signal-based flagging — wide net, no reasoning.
 *
 * Each signal is a boolean predicate that answers "should the judge look at this?"
 * Signals never produce reason strings — the judge forms its own assessment
 * from the raw action description.
 *
 * Categories:
 *   - path:      where is this touching?
 *   - scope:     how much is affected?
 *   - privilege:  is this escalating?
 *   - dataflow:  is data leaving or entering unsafely?
 *   - content:   what's in the payload?
 *   - user:      user-configured command/pattern matchers
 */

import * as path from "node:path";
import type { ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { type BashAnalysis, analyzeBashCommand } from "./ast.js";
import type { CommandMatcher, MergedConfig } from "./config.js";

// ── Public types ──────────────────────────────────────────────────────────

export interface SignalContext {
	cwd: string;
	home: string;
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Should this tool call be sent to the judge?
 * Returns true if any signal fires. No reason is propagated.
 */
export function shouldFlag(event: ToolCallEvent, ctx: SignalContext, config?: MergedConfig): boolean {
	// Bash commands: run AST-based signals + text signals
	if (isToolCallEventType("bash", event)) {
		const analysis = analyzeBashCommand(event.input.command);
		if (bashSignals(analysis, event.input.command, ctx, config)) return true;
		if (textSignals(event.input.command, config)) return true;
		return false;
	}

	// File-targeting tools: check path signals + content signals
	const filePath = getFilePath(event);
	if (filePath && pathSignals(filePath, ctx)) return true;

	// Text content in write/edit: check content + text signals
	const text = extractToolText(event);
	if (text) {
		if (contentSignals(text)) return true;
		if (textSignals(text, config)) return true;
	}

	return false;
}

// ── Bash signals (AST-based) ──────────────────────────────────────────────

function bashSignals(analysis: BashAnalysis, _rawCmd: string, ctx: SignalContext, config?: MergedConfig): boolean {
	// Unparseable → suspicious
	if (!analysis.parsed) return true;

	for (const cmd of analysis.commands) {
		// ── Privilege signals ──
		if (PRIVILEGE_COMMANDS.has(cmd.name)) return true;

		// ── Scope signals ──
		if (isMutatingCommand(cmd.name) && hasFlag(cmd.args, "r", "R")) return true;
		if (cmd.name === "rm" && hasFlag(cmd.args, "f")) return true;
		if (hasRootTarget(cmd)) return true;
		if (cmd.name === "chmod" && cmd.args.includes("777")) return true;
		if (cmd.name === "chmod" && cmd.args.some((a) => a.includes("u+s") || a.includes("g+s"))) return true;

		// ── Destructive commands ──
		if (cmd.name === "dd" && cmd.args.some((a) => a.startsWith("of="))) return true;
		if (cmd.name.startsWith("mkfs")) return true;

		// ── Dataflow signals ──
		if (ENV_DUMP_COMMANDS.has(cmd.name)) return true;
		if (cmd.name === "export" && cmd.args.includes("-p")) return true;
		if (INTERPRETER_COMMANDS.has(cmd.name) && hasInlineCode(cmd.name, cmd.args)) return true;

		// ── Path signals (on file arguments) ──
		const files = [...cmd.args.filter(looksLikePath), ...cmd.redirectTargets];
		for (const f of files) {
			if (pathSignals(f, ctx)) return true;
		}

		// ── Docker env pass-through ──
		if (cmd.name === "docker" && (cmd.args.includes("-e") || cmd.args.includes("--env-file"))) return true;
	}

	// ── Cross-command signals ──

	// Network command with secret variable references
	if (hasNetworkCommand(analysis) && hasSecretParamRefs(analysis)) return true;

	// Pipeline from sensitive source to network
	if (analysis.isPipeline && hasSensitiveSource(analysis, ctx) && hasNetworkCommand(analysis)) return true;

	// Environment dump in pipeline
	if (analysis.isPipeline && analysis.commands.some((c) => ENV_DUMP_COMMANDS.has(c.name))) return true;

	// ── User-configured command matchers ──
	if (config?.commands && matchUserCommands(analysis, config.commands)) return true;

	return false;
}

// ── Path signals ──────────────────────────────────────────────────────────

/** Check if a file path should trigger flagging. */
export function pathSignals(filePath: string, ctx: SignalContext): boolean {
	const resolved = resolvePath(filePath, ctx.cwd);

	// Outside the working directory
	if (!isUnder(resolved, ctx.cwd)) return true;

	// Dotfile/dotdir in $HOME (but not inside cwd — already caught above)
	if (isHomeDotfile(resolved, ctx.home)) return true;

	// System paths
	if (isSystemPath(resolved)) return true;

	// Secret-ish keyword in path
	if (SECRET_PATH_PATTERN.test(filePath)) return true;

	return false;
}

export function resolvePath(filePath: string, cwd: string): string {
	if (filePath.startsWith("~")) {
		return path.resolve(process.env.HOME ?? "/home", filePath.slice(1).replace(/^\//, ""));
	}
	return path.resolve(cwd, filePath);
}

export function isUnder(resolved: string, dir: string): boolean {
	const norm = dir.endsWith("/") ? dir : `${dir}/`;
	return resolved === dir || resolved.startsWith(norm);
}

export function isHomeDotfile(resolved: string, home: string): boolean {
	if (!isUnder(resolved, home)) return false;
	const relative = resolved.slice(home.length).replace(/^\//, "");
	// First segment starts with a dot (e.g. .ssh/authorized_keys, .bashrc)
	const first = relative.split("/")[0];
	return first?.startsWith(".") ?? false;
}

const SYSTEM_PREFIXES = ["/etc", "/usr", "/var", "/boot", "/sys", "/proc", "/dev", "/sbin", "/lib"];

export function isSystemPath(resolved: string): boolean {
	return SYSTEM_PREFIXES.some((p) => resolved === p || resolved.startsWith(`${p}/`));
}

const SECRET_PATH_PATTERN =
	/(?:^|[/\\._-])(?:secret|credential|password|passwd|token|private[._-]?key|\.env(?:\.|$)|\.dev\.vars(?:$|[/\\])|id_rsa|id_ed25519|id_ecdsa|authorized_keys|known_hosts)|\.(?:pem|key)$/i;

// ── Scope signals ─────────────────────────────────────────────────────────

const MUTATING_COMMANDS = new Set(["rm", "chmod", "chown", "chgrp", "find", "xargs"]);

function isMutatingCommand(name: string): boolean {
	return MUTATING_COMMANDS.has(name);
}

function hasFlag(args: string[], ...flags: string[]): boolean {
	return args.some((a) => {
		if (!a.startsWith("-")) return false;
		if (a.startsWith("--")) {
			// Long flag: --recursive, --force
			return flags.some((f) => a === `--${LONG_FLAGS[f] ?? f}`);
		}
		// Short flags: -rf, -R, etc.
		return flags.some((f) => a.includes(f));
	});
}

const LONG_FLAGS: Record<string, string> = {
	r: "recursive",
	R: "recursive",
	f: "force",
};

function hasRootTarget(cmd: { args: string[]; redirectTargets: string[] }): boolean {
	const allTargets = [...cmd.args, ...cmd.redirectTargets];
	return allTargets.some((a) => a === "/" || a === "/*");
}

// ── Privilege signals ─────────────────────────────────────────────────────

const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas", "pkexec"]);

// ── Dataflow signals ──────────────────────────────────────────────────────

const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "rsync", "ftp", "sftp"]);
const ENV_DUMP_COMMANDS = new Set(["printenv", "env", "set"]);
const INTERPRETER_COMMANDS = new Set([
	"eval",
	"bash",
	"sh",
	"zsh",
	"fish",
	"python",
	"python3",
	"node",
	"ruby",
	"perl",
]);

const INTERPRETER_INLINE_FLAGS: Record<string, string[]> = {
	eval: [], // eval always has inline code
	bash: ["-c"],
	sh: ["-c"],
	zsh: ["-c"],
	fish: ["-c"],
	python: ["-c"],
	python3: ["-c"],
	node: ["-e", "--eval"],
	ruby: ["-e"],
	perl: ["-e"],
};

function hasInlineCode(name: string, args: string[]): boolean {
	const flags = INTERPRETER_INLINE_FLAGS[name];
	if (!flags) return false;
	if (flags.length === 0) return true; // eval — always inline
	return flags.some((f) => args.includes(f));
}

/**
 * Variable names that look like secrets.
 * AUTH requires underscore/start/end boundaries to avoid matching AUTHOR, AUTHORIZE.
 */
const SECRET_VAR_PATTERN =
	/(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API[_.]?KEY|PRIVATE[_.]?KEY|(?:^|_)AUTH(?:_|$))/i;

function hasNetworkCommand(analysis: BashAnalysis): boolean {
	return analysis.commands.some((c) => NETWORK_COMMANDS.has(c.name));
}

function hasSecretParamRefs(analysis: BashAnalysis): boolean {
	return analysis.allParamRefs.some((ref) => SECRET_VAR_PATTERN.test(ref));
}

function hasSensitiveSource(analysis: BashAnalysis, ctx: SignalContext): boolean {
	return analysis.allFiles.some((f) => pathSignals(f, ctx));
}

// ── Content signals ───────────────────────────────────────────────────────

const PRIVATE_KEY_PATTERN = /-----BEGIN\s[\w\s]*PRIVATE\sKEY-----/;
const SECRET_FORMAT_PATTERNS = [
	/ghp_[A-Za-z0-9_]{36,}/, // GitHub personal access token
	/gho_[A-Za-z0-9_]{36,}/, // GitHub OAuth token
	/ghs_[A-Za-z0-9_]{36,}/, // GitHub server token
	/github_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained PAT
	/sk-[A-Za-z0-9]{20,}/, // OpenAI / Stripe secret key
	/sk-proj-[A-Za-z0-9-_]{20,}/, // OpenAI project key
	/AKIA[0-9A-Z]{16}/, // AWS access key
	/xoxb-[0-9]+-[A-Za-z0-9]+/, // Slack bot token
	/xoxp-[0-9]+-[A-Za-z0-9]+/, // Slack user token
	/xoxs-[0-9]+-[A-Za-z0-9]+/, // Slack session token
];

/** Check if text content contains secret material. */
export function contentSignals(text: string): boolean {
	if (PRIVATE_KEY_PATTERN.test(text)) return true;
	for (const pattern of SECRET_FORMAT_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	return false;
}

// ── Text signals (string patterns) ────────────────────────────────────────

const BUILTIN_TEXT_PATTERNS = [/\bsudo\b/, /\bsafeguard\b/];

/** Check raw text against built-in and user-configured patterns. */
export function textSignals(text: string, config?: MergedConfig): boolean {
	for (const pattern of BUILTIN_TEXT_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	if (config?.patterns) {
		for (const pattern of config.patterns) {
			if (pattern.test(text)) return true;
		}
	}
	return false;
}

// ── User command matching ─────────────────────────────────────────────────

export function matchUserCommands(analysis: BashAnalysis, matchers: CommandMatcher[]): boolean {
	for (const cmd of analysis.commands) {
		for (const matcher of matchers) {
			if (typeof matcher === "string") {
				if (cmd.name === matcher) return true;
			} else {
				if (cmd.name !== matcher[0]) continue;
				const prefix = matcher.slice(1);
				if (prefix.length === 0 || prefix.every((sub, i) => cmd.args[i] === sub)) return true;
			}
		}
	}
	return false;
}

// ── Tool event helpers ────────────────────────────────────────────────────

function extractToolText(event: ToolCallEvent): string {
	if (isToolCallEventType("write", event)) return event.input.content;
	if (isToolCallEventType("edit", event)) return event.input.newText;
	return "";
}

function getFilePath(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("read", event)) return event.input.path;
	if (isToolCallEventType("write", event)) return event.input.path;
	if (isToolCallEventType("edit", event)) return event.input.path;
	if (isToolCallEventType("grep", event)) return event.input.path;
	return undefined;
}

/** Heuristic: does this string look like a file path? */
function looksLikePath(s: string): boolean {
	return (
		s.startsWith("/") ||
		s.startsWith("./") ||
		s.startsWith("../") ||
		s.startsWith("~") ||
		s.includes("/") ||
		s.startsWith(".") // dotfiles like .env, .bashrc
	);
}

// ── Action description (clean, no flagger reasoning) ──────────────────────

/** Describe the tool action for the judge. No signal/reason annotations. */
export function describeAction(event: ToolCallEvent): string {
	if (isToolCallEventType("bash", event)) return `bash: ${event.input.command}`;
	if (isToolCallEventType("read", event)) return `read ${event.input.path}`;
	if (isToolCallEventType("write", event)) return `write ${event.input.path}`;
	if (isToolCallEventType("edit", event)) return `edit ${event.input.path}`;
	if (isToolCallEventType("grep", event)) return `grep ${event.input.path ?? ""}`;
	if (isToolCallEventType("find", event)) return `find ${event.input.path ?? ""}`;
	if (isToolCallEventType("ls", event)) return `ls ${event.input.path ?? ""}`;
	return event.toolName;
}

/** Tools that could be used for circumvention (checked after a denial). */
export function isRelevantTool(event: ToolCallEvent): boolean {
	return ["bash", "read", "write", "edit", "grep", "find", "ls"].includes(event.toolName);
}
