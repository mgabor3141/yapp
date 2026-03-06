import * as path from "node:path";
import type { ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { type BashAnalysis, analyzeBashCommand } from "./ast.js";

// --- File patterns ---

const ENV_PATTERNS = [".env", ".env.local", ".env.production", ".env.prod", ".dev.vars"];
const ENV_SAFE = [".env.example", ".env.sample", ".env.test"];

export function isEnvFile(filePath: string): boolean {
	const base = path.basename(filePath);
	if (ENV_SAFE.some((s) => base === path.basename(s))) return false;
	return ENV_PATTERNS.some((p) => base === path.basename(p) || base.startsWith(`${path.basename(p)}.`));
}

// --- Network and env-related command sets ---

const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "rsync", "ftp", "sftp"]);
const ENV_READ_COMMANDS = new Set(["cat", "less", "head", "tail", "bat", "more", "strings", "base64", "xxd", "od"]);
const ENV_DUMP_COMMANDS = new Set(["printenv", "env", "set"]);
const SEARCH_COMMANDS = new Set(["grep", "rg", "ag", "ack"]);

/**
 * Variable names that look like secrets.
 *
 * Most keywords match anywhere in the name — SECRET, TOKEN, PASSWORD etc.
 * are unambiguous regardless of prefix/suffix (MY_TOKEN, DB_PASSWORD_RO).
 *
 * AUTH is the exception: it appears in non-secret names like AUTHOR,
 * AUTHORIZE, AUTHENTICATION_LOG. So it requires underscore/start/end
 * boundaries to match only AUTH_TOKEN, BASIC_AUTH, AUTH, etc.
 *
 * Matches:  MY_TOKEN, STRIPE_API_KEY, DB_PASSWORD, AUTH_TOKEN, PRIVATE_KEY
 * Skips:    HOME, PATH, NODE_ENV, AUTHOR, AUTHORIZE_DOCS
 */
const SECRET_VAR_PATTERN =
	/(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API[_.]?KEY|PRIVATE[_.]?KEY|(?:^|_)AUTH(?:_|$))/i;

// --- AST-based bash classifiers ---

/** Check if any command in the analysis touches env files. */
function touchesEnvFile(analysis: BashAnalysis): boolean {
	return analysis.allFiles.some(isEnvFile);
}

/** Check if analysis contains a network command. */
function hasNetworkCommand(analysis: BashAnalysis): boolean {
	return analysis.commands.some((c) => NETWORK_COMMANDS.has(c.name));
}

/** Check if analysis references secret-looking environment variables. */
function hasSecretParamRefs(analysis: BashAnalysis): boolean {
	return analysis.allParamRefs.some((ref) => SECRET_VAR_PATTERN.test(ref));
}

/**
 * Classify a bash command using AST analysis.
 * Returns a description of why it was flagged, or undefined if safe.
 */
export function classifyBashCommand(cmd: string): string | undefined {
	const analysis = analyzeBashCommand(cmd);

	// Unparseable command = suspicious. Agents almost never produce invalid syntax,
	// so a parse failure is itself a signal. Send to the judge.
	if (!analysis.parsed) {
		return "unparseable command (syntax error)";
	}

	for (const c of analysis.commands) {
		// --- Destructive commands ---
		if (c.name === "rm" && hasFlags(c.args, "r") && hasFlags(c.args, "f")) {
			return "rm -rf: recursive force delete";
		}
		if (c.name === "dd" && c.args.some((a) => a.startsWith("of="))) {
			return "dd: disk write operation";
		}
		if (c.name.startsWith("mkfs")) {
			return `${c.name}: filesystem format`;
		}
		if (c.name === "chmod" && c.args.includes("777")) {
			return "chmod 777: insecure permissions";
		}
		if (c.name === "chown" && hasFlags(c.args, "R")) {
			return "chown -R: recursive ownership change";
		}

		// --- Superuser ---
		if (c.name === "sudo") {
			return "sudo: superuser command";
		}

		// --- Environment/secret access ---
		if (ENV_READ_COMMANDS.has(c.name) && c.args.some(isEnvFile)) {
			return `${c.name}: reading env/secret file`;
		}
		if (SEARCH_COMMANDS.has(c.name) && c.args.some(isEnvFile)) {
			return `${c.name}: searching env/secret file`;
		}
		if (c.name === "source" && c.args.some(isEnvFile)) {
			return "source: loading env file";
		}
		if (c.name === "cp" && c.args.some(isEnvFile)) {
			return "cp: copying env/secret file";
		}
		if (c.name === "mv" && c.args.some(isEnvFile)) {
			return "mv: moving env/secret file";
		}

		// --- Environment dumping ---
		if (ENV_DUMP_COMMANDS.has(c.name)) {
			return `${c.name}: dumping environment variables`;
		}
		if (c.name === "export" && c.args.includes("-p")) {
			return "export -p: dumping exported variables";
		}

		// --- Docker env pass-through ---
		if (c.name === "docker" && (c.args.includes("-e") || c.args.includes("--env-file"))) {
			return "docker: passing environment variables";
		}
	}

	// --- Cross-command patterns (pipelines, etc.) ---

	// Exfiltration: env file → network command in pipeline
	if (analysis.isPipeline && touchesEnvFile(analysis) && hasNetworkCommand(analysis)) {
		return "pipeline: env file piped to network command";
	}

	// Secret leak: network command with secret-looking variable references
	if (hasNetworkCommand(analysis) && hasSecretParamRefs(analysis)) {
		return "network command with secret variable reference";
	}

	// Env dump piped somewhere (env | ..., printenv | ...)
	if (analysis.isPipeline && analysis.commands.some((c) => ENV_DUMP_COMMANDS.has(c.name))) {
		return "environment dump in pipeline";
	}

	return undefined;
}

// --- Flag detection ---

/** Check if any arg contains all specified flag characters (e.g. hasFlags(["-rf"], "r") → true) */
function hasFlags(args: string[], ...flags: string[]): boolean {
	return args.some((a) => {
		if (!a.startsWith("-") || a.startsWith("--")) return false;
		return flags.every((f) => a.includes(f));
	});
}

// --- Tool event interface (unchanged public API) ---

/** Check if a tool call should be flagged. Returns a reason string or undefined. */
export function matchPatterns(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("bash", event)) {
		const reason = classifyBashCommand(event.input.command);
		if (reason) return `bash: ${event.input.command} [${reason}]`;
	}

	const target = getFilePath(event);
	if (target && isEnvFile(target)) {
		return describeAction(event);
	}

	return undefined;
}

/** Tools that could be used for circumvention (checked after a denial). */
export function isRelevantTool(event: ToolCallEvent): boolean {
	return ["bash", "read", "write", "edit", "grep", "find", "ls"].includes(event.toolName);
}

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

function getFilePath(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("read", event)) return event.input.path;
	if (isToolCallEventType("write", event)) return event.input.path;
	if (isToolCallEventType("edit", event)) return event.input.path;
	if (isToolCallEventType("grep", event)) return event.input.path;
	return undefined;
}
