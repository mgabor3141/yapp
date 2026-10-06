/**
 * Command rewriting for background processes.
 *
 * Takes a bash command string and the detection results, then rewrites each
 * top-level background statement (`stmt &`) to:
 * 1. Redirect stdout/stderr to its own temp log file (if not already redirected)
 * 2. `disown` it (if the script doesn't already)
 * 3. Immediately print a `[bg] pid=… label=… log=…` line for that job
 *
 * This prevents background processes from holding the bash tool's pipes
 * open, which would otherwise hang the tool call indefinitely.
 *
 * Safety: statement spans come from @aliou/sh source positions, and each
 * background statement is re-parsed from its span and compared to the
 * original AST. On any disagreement or parse error the command is returned
 * unchanged — running it as written is always safe.
 *
 * Policy: if a top-level `wait` follows a background statement, the script
 * wants to block on its jobs, so it is returned unchanged (disowned jobs
 * can't be waited for).
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Program, parse } from "@aliou/sh";
import type { BgStatement } from "./detect.js";

/** Info about a background process started by the rewritten command. */
export interface BgProcessInfo {
	/** Unique index for this background process within the command. */
	index: number;
	/** Human-readable label from AST analysis. */
	label: string;
	/**
	 * Path to the log file capturing stdout/stderr, or empty string if
	 * the command already had full redirections (no log file created).
	 */
	logFile: string;
}

/** Result of rewriting a command. */
export interface RewriteResult {
	/** The rewritten command string. */
	command: string;
	/** Info about each background process. */
	processes: BgProcessInfo[];
}

/** A top-level statement span in the source text. */
export interface StatementSpan {
	/** Offset of the first character of the command. */
	start: number;
	/** Offset just past the command (before the background `&`). */
	end: number;
	/** Offset of the terminating background `&`, or -1 if not backgrounded. */
	ampPos: number;
}

/**
 * Find the positions of top-level background `&` operators in the command text.
 * Returns [] if the command can't be parsed or positions don't check out.
 */
export function findBgOperatorPositions(text: string): number[] {
	const ast = parseProgram(text);
	const spans = ast && locateStatements(text, ast);
	return spans ? spans.filter((s) => s.ampPos !== -1).map((s) => s.ampPos) : [];
}

/**
 * Monotonic suffix used to keep temp log file names unique.
 */
let nextLogId = 1;

function slugifyLabel(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);

	return slug || "background";
}

/**
 * Generate a unique, human-readable log file path for a background process.
 */
function makeLogPath(label: string, usedPaths: Set<string>): string {
	const slug = slugifyLabel(label);

	while (true) {
		const candidate = join(tmpdir(), `pi-bg-${slug}-${nextLogId++}.log`);
		if (usedPaths.has(candidate) || existsSync(candidate)) {
			continue;
		}
		usedPaths.add(candidate);
		return candidate;
	}
}

function parseProgram(command: string): Program | null {
	try {
		return parse(command, { dialect: "bash" }).ast;
	} catch {
		return null;
	}
}

type WordLike = { parts: { type: string; value?: string }[] };

function literalWord(w: WordLike | undefined): string | null {
	const parts = w?.parts;
	return parts?.length === 1 && parts[0].type === "Literal" ? (parts[0].value ?? null) : null;
}

/**
 * Does this AST node call `wait` in the current shell? Ignores places where
 * a `wait` can't see the parent's jobs: subshells, substitutions, background
 * statements, and pipeline elements (each runs in a subshell). The exception
 * is the last pipeline element when the script mentions `lastpipe`, since
 * with `shopt -s lastpipe` it runs in the current shell. Sees through the
 * `command` and `builtin` prefixes.
 */
function callsWait(node: unknown, lastpipe: boolean): boolean {
	if (!node || typeof node !== "object") return false;
	if (Array.isArray(node)) return node.some((n) => callsWait(n, lastpipe));
	const obj = node as Record<string, unknown>;
	const type = obj.type;
	if (obj.background === true) return false;
	if (type === "Subshell" || type === "CmdSubst" || type === "ProcSubst") return false;
	if (type === "Pipeline" && Array.isArray(obj.commands) && obj.commands.length > 1) {
		return lastpipe && callsWait(obj.commands[obj.commands.length - 1], lastpipe);
	}
	if (type === "SimpleCommand") {
		const words = (obj.words as WordLike[] | undefined) ?? [];
		let k = 0;
		while (k < words.length && ["command", "builtin"].includes(literalWord(words[k]) ?? "")) k++;
		if (literalWord(words[k]) === "wait") return true;
	}
	return Object.values(obj).some((v) => callsWait(v, lastpipe));
}

/** Deep-copy an AST node without source positions, for structural comparison. */
function stripPositions(node: unknown): string {
	return JSON.stringify(node, (k, v) => (k === "pos" || k === "end" ? undefined : v));
}

/**
 * Get the source span of every top-level statement from the parser's
 * positions, and sanity-check them: the background `&` must be where the
 * parser says, and each background command's text must re-parse to the same
 * command (re-parsed together with the rest of the script, so heredoc bodies
 * still attach). Returns null if anything doesn't check out.
 */
function locateStatements(command: string, ast: Program): StatementSpan[] | null {
	const spans: StatementSpan[] = [];
	for (const stmt of ast.body) {
		const start = stmt.command.pos?.offset;
		const end = stmt.command.end?.offset;
		const stmtEnd = stmt.end?.offset;
		if (start === undefined || end === undefined || stmtEnd === undefined) return null;
		if (!stmt.background) {
			spans.push({ start, end, ampPos: -1 });
			continue;
		}
		const ampPos = stmtEnd - 1;
		if (command[ampPos] !== "&" || ampPos < end || command.slice(end, ampPos).trim() !== "") return null;
		// Re-parse the command text with the `&` removed. The rest of the script
		// is kept so heredoc bodies that follow on later lines still resolve.
		const sub = parseProgram(`${command.slice(start, end)};${command.slice(ampPos + 1)}`);
		if (!sub || sub.body.length === 0 || sub.body[0].background) return null;
		if (stripPositions(sub.body[0].command) !== stripPositions(stmt.command)) return null;
		spans.push({ start, end, ampPos });
	}
	return spans;
}

/** Quote a string as a single bash word. */
function shQuote(s: string): string {
	if (/^[\w./-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrite a bash command to detach background processes from pipes.
 *
 * Returns the command unchanged (with no processes) when there is nothing to
 * do, when the script waits on its jobs, or when it can't be transformed with
 * confidence.
 */
export function rewriteCommand(command: string, bgStatements: BgStatement[]): RewriteResult {
	const unchanged: RewriteResult = { command, processes: [] };
	if (bgStatements.length === 0) return unchanged;

	const ast = parseProgram(command);
	if (!ast) return unchanged;

	// Wait policy: a top-level `wait` after a background job means the user
	// wants to block on it. Run as written.
	const lastpipe = /\blastpipe\b/.test(command);
	const firstBg = ast.body.findIndex((s) => s.background);
	if (firstBg !== -1 && ast.body.slice(firstBg + 1).some((s) => callsWait(s, lastpipe))) return unchanged;

	const spans = locateStatements(command, ast);
	if (!spans) return unchanged;

	const bgSpans = spans.filter((s) => s.ampPos !== -1);
	const byIndex = new Map(bgStatements.map((b) => [b.index, b]));
	if (bgSpans.length !== bgStatements.length) return unchanged;
	// Spans must be in order and non-overlapping.
	for (let k = 1; k < spans.length; k++) if (spans[k].start < spans[k - 1].end) return unchanged;

	const processes: BgProcessInfo[] = [];
	const usedLogPaths = new Set<string>();
	const pieces: string[] = [];
	let cursor = 0;
	let jobIndex = 0;

	for (let k = 0; k < spans.length; k++) {
		const span = spans[k];
		if (span.ampPos === -1) continue;
		const stmt = byIndex.get(k);
		if (!stmt) return unchanged;

		const body = command.slice(span.start, span.end);
		const fullyRedirected = stmt.hasStdoutRedirect && stmt.hasStderrRedirect;

		// Compound commands (&&, ||, pipelines, subshells, groups) ALWAYS need
		// wrapping: inner redirects only affect individual commands, but the
		// background subshell itself still holds the pipe fds open.
		let rewritten: string;
		let logFile = "";
		if (stmt.isCompound) {
			logFile = makeLogPath(stmt.label, usedLogPaths);
			rewritten = `{ ${body}; } > ${shQuote(logFile)} 2>&1 &`;
		} else if (fullyRedirected) {
			rewritten = `${body} &`;
		} else if (!stmt.hasStdoutRedirect && !stmt.hasStderrRedirect) {
			logFile = makeLogPath(stmt.label, usedLogPaths);
			rewritten = `${body} > ${shQuote(logFile)} 2>&1 &`;
		} else {
			// stdout redirected but not stderr: send stderr wherever stdout goes.
			rewritten = `${body} 2>&1 &`;
		}

		if (!stmt.followedByDisown) rewritten += " disown $!;";
		const logPart = logFile ? ` log=${logFile}` : "";
		rewritten += ` printf '%s\\n' "[bg] pid=$! "${shQuote(`label=${stmt.label}${logPart}`)};`;

		processes.push({ index: jobIndex++, label: stmt.label, logFile });
		pieces.push(command.slice(cursor, span.start), rewritten);
		cursor = span.ampPos + 1;
	}
	pieces.push(command.slice(cursor));

	return { command: pieces.join(""), processes };
}
