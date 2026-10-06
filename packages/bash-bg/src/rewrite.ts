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
 * Safety: @aliou/sh gives us the AST but no source positions, so statement
 * boundaries are located by a lexer (`splitTopLevel`) and then cross-checked
 * against the AST (statement count, background flags, and a re-parse of each
 * background statement's text). On any disagreement or lexer error, the
 * command is returned unchanged — running it as written is always safe.
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
	/** Offset of the first character of the statement. */
	start: number;
	/** Offset just past the last non-blank character (before the terminator). */
	end: number;
	/** Offset of the terminating background `&`, or -1 if not backgrounded. */
	ampPos: number;
}

class LexError extends Error {}

const KEYWORD_CLOSERS: Record<string, string> = {
	"{": "}",
	if: "fi",
	case: "esac",
	// loop headers may contain `;` before `do`, so open the construct here
	for: "done",
	select: "done",
	while: "done",
	until: "done",
	"[[": "]]",
};
/** Reserved words after which we are still at command position. */
const CMD_PREFIX_WORDS = new Set(["then", "else", "elif", "do", "!", "time", "{", "if", "while", "until"]);
const META = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

/**
 * Split a bash script into top-level statements, recording which ones are
 * terminated by a background `&`. Handles quotes, `$'…'`, `$(…)`, `${…}`,
 * backticks, `$((…))`, `(…)`, `{ …; }`, `if/case/do…done/[[ ]]`, comments,
 * heredocs, line continuations and the `&&`, `|&`, `>&`, `<&`, `&>`, `&>>`
 * operators. Throws LexError if the input isn't understood.
 */
export function splitTopLevel(src: string): StatementSpan[] {
	const n = src.length;
	const spans: StatementSpan[] = [];
	const pendingHeredocs: { delim: string; strip: boolean }[] = [];
	let i = 0;

	const fail = (msg: string): never => {
		throw new LexError(`${msg} at ${i}`);
	};

	/** Consume heredoc bodies queued on the line that just ended (i is just past '\n'). */
	function consumeHeredocs() {
		while (pendingHeredocs.length > 0) {
			const { delim, strip } = pendingHeredocs.shift() as { delim: string; strip: boolean };
			for (;;) {
				if (i >= n) fail("unterminated heredoc");
				const nl = src.indexOf("\n", i);
				const lineEnd = nl === -1 ? n : nl;
				let line = src.slice(i, lineEnd);
				if (strip) line = line.replace(/^\t+/, "");
				i = nl === -1 ? n : nl + 1;
				if (line === delim) break;
			}
		}
	}

	function skipSingle() {
		// at opening '
		const close = src.indexOf("'", i + 1);
		if (close === -1) fail("unterminated '");
		i = close + 1;
	}

	function skipAnsiC() {
		// at $'
		i += 2;
		while (i < n && src[i] !== "'") i += src[i] === "\\" ? 2 : 1;
		if (i >= n) fail("unterminated $'");
		i++;
	}

	function skipBacktick() {
		i++;
		while (i < n && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
		if (i >= n) fail("unterminated `");
		i++;
	}

	function skipDouble() {
		i++;
		while (i < n) {
			const c = src[i];
			if (c === "\\") i += 2;
			else if (c === '"') {
				i++;
				return;
			} else if (c === "`") skipBacktick();
			else if (c === "$") skipDollar();
			else i++;
		}
		fail('unterminated "');
	}

	/** At '$'. Skips $(…), $((…)), ${…}, $'…', or a plain '$'. */
	function skipDollar() {
		const nx = src[i + 1];
		if (nx === "(") {
			i += 2;
			scanCommands(")");
		} else if (nx === "{") {
			i += 2;
			let depth = 1;
			while (i < n && depth > 0) {
				const c = src[i];
				if (c === "\\") i += 2;
				else if (c === "'") skipSingle();
				else if (c === '"') skipDouble();
				else if (c === "`") skipBacktick();
				else if (c === "$") skipDollar();
				else {
					if (c === "{") depth++;
					else if (c === "}") depth--;
					i++;
				}
			}
			if (depth > 0) fail("unterminated ${");
		} else if (nx === "'") {
			skipAnsiC();
		} else {
			i++;
		}
	}

	/** Read one word starting at i (non-meta). Returns its raw text. */
	function readWord(): string {
		const start = i;
		while (i < n) {
			const c = src[i];
			if (META.has(c)) {
				// <( and >( process substitution inside a word is handled by the caller
				break;
			}
			if (c === "\\") i += 2;
			else if (c === "'") skipSingle();
			else if (c === '"') skipDouble();
			else if (c === "`") skipBacktick();
			else if (c === "$") skipDollar();
			else i++;
		}
		return src.slice(start, Math.min(i, n));
	}

	function unquoteDelim(w: string): string {
		return w.replace(/\\(.)/g, "$1").replace(/["']/g, "");
	}

	/**
	 * Scan a command list until `closer` (")" for subshells/substitutions) or
	 * end of input (closer === null, top level). Records statement spans only
	 * at the top level with no open keyword/brace constructs.
	 */
	function scanCommands(closer: ")" | null) {
		const stack: string[] = [];
		let atCmd = true;
		let stmtStart = -1;
		let lastEnd = -1;
		let continuation = false; // after && || | |& a newline doesn't end the statement
		let expectHeredocDelim: { strip: boolean } | null = null;
		const top = () => closer === null && stack.length === 0;

		const endStmt = (amp: number) => {
			if (top() && stmtStart !== -1) {
				spans.push({ start: stmtStart, end: lastEnd, ampPos: amp });
			}
			if (stack.length === 0) stmtStart = -1;
			atCmd = true;
			continuation = false;
		};
		const mark = (end: number, start: number) => {
			if (stmtStart === -1 && stack.length === 0) stmtStart = start;
			lastEnd = end;
		};

		while (i < n) {
			const c = src[i];
			const start = i;

			if (c === " " || c === "\t") {
				i++;
				continue;
			}
			if (c === "\\" && src[i + 1] === "\n") {
				i += 2;
				continue;
			}
			if (c === "\n") {
				i++;
				consumeHeredocs();
				if (!continuation && stmtStart !== -1 && stack.length === 0) endStmt(-1);
				else atCmd = atCmd || stack.length > 0 || continuation;
				if (stack.length > 0) atCmd = true;
				continue;
			}
			if (c === "#") {
				// a comment only at word start (we're at a token boundary here)
				while (i < n && src[i] !== "\n") i++;
				continue;
			}
			if (c === ")") {
				if (stack.length > 0 && stack[stack.length - 1] === "esac") {
					// case pattern terminator
					i++;
					mark(i, start);
					atCmd = true;
					continue;
				}
				if (closer === ")" && stack.length === 0) {
					i++;
					return;
				}
				fail("unbalanced )");
			}
			if (c === "(") {
				i++;
				scanCommands(")");
				mark(i, start);
				atCmd = true; // allows `f() { …; }` and `(…) }`-style closers
				continuation = false;
				continue;
			}
			if (c === ";") {
				if (src[i + 1] === ";") {
					i += src[i + 2] === "&" ? 3 : 2;
					mark(i, start);
					atCmd = true;
					continue;
				}
				if (src[i + 1] === "&") {
					i += 2;
					mark(i, start);
					atCmd = true;
					continue;
				}
				i++;
				if (stack.length === 0) endStmt(-1);
				else atCmd = true;
				continue;
			}
			if (c === "&") {
				if (src[i + 1] === "&") {
					i += 2;
					atCmd = true;
					continuation = true;
					continue;
				}
				if (src[i + 1] === ">") {
					// &> / &>> redirection
					i += src[i + 2] === ">" ? 3 : 2;
					mark(i, start);
					continue;
				}
				// background operator
				i++;
				if (stack.length === 0) {
					if (stmtStart === -1) fail("& without command");
					endStmt(start);
				} else atCmd = true;
				continue;
			}
			if (c === "|") {
				if (src[i + 1] === "|") i += 2;
				else if (src[i + 1] === "&") i += 2;
				else i++;
				atCmd = true;
				continuation = true;
				continue;
			}
			if (c === "<" || c === ">") {
				if (src[i + 1] === "(") {
					// process substitution
					i += 2;
					scanCommands(")");
					mark(i, start);
					atCmd = false;
					continue;
				}
				if (c === "<" && src[i + 1] === "<" && src[i + 2] === "<") i += 3;
				else if (c === "<" && src[i + 1] === "<") {
					i += 2;
					const strip = src[i] === "-";
					if (strip) i++;
					expectHeredocDelim = { strip };
				} else if (src[i + 1] === ">" || src[i + 1] === "&" || src[i + 1] === "|") i += 2;
				else if (c === "<" && src[i + 1] === ">") i += 2;
				else i++;
				mark(i, start);
				continuation = false;
				continue;
			}

			// A word.
			const word = readWord();
			if (word === "") fail("unexpected character");
			mark(i, start);
			continuation = false;

			if (expectHeredocDelim) {
				pendingHeredocs.push({ delim: unquoteDelim(word), strip: expectHeredocDelim.strip });
				expectHeredocDelim = null;
				continue;
			}

			// A trailing word followed directly by '(' is a function name — fine.
			if (atCmd) {
				const topOfStack = stack[stack.length - 1];
				if (word === topOfStack) {
					stack.pop();
					atCmd = false;
					continue;
				}
				if (word === "[[") {
					// scan until the matching ]] word
					stack.push("]]");
					atCmd = true;
					continue;
				}
				if (word in KEYWORD_CLOSERS) {
					stack.push(KEYWORD_CLOSERS[word]);
					// `case WORD in` — patterns follow; let ')' terminate patterns
					atCmd = !["case", "for", "select"].includes(word);
					continue;
				}
				if (CMD_PREFIX_WORDS.has(word)) {
					atCmd = true;
					continue;
				}
				// `done`/`fi`/`esac`/`}` that don't match the stack top
				if (["done", "fi", "esac", "}"].includes(word)) fail(`unexpected ${word}`);
				atCmd = false;
				continue;
			}
			// Inside [[ … ]], ]] appears in argument position; inside case, `esac` after `;;`.
			if (stack[stack.length - 1] === "]]" && word === "]]") {
				stack.pop();
				continue;
			}
			if (stack[stack.length - 1] === "esac" && word === "esac") stack.pop();
		}

		if (closer !== null) fail("unterminated (");
		if (stack.length > 0) fail(`unterminated ${stack[stack.length - 1]}`);
		if (pendingHeredocs.length > 0 || expectHeredocDelim) fail("unterminated heredoc");
		if (stmtStart !== -1) endStmt(-1);
	}

	scanCommands(null);
	return spans;
}

/**
 * Find the positions of top-level background `&` operators in the command text.
 * Returns [] if the command can't be lexed.
 */
export function findBgOperatorPositions(text: string): number[] {
	try {
		return splitTopLevel(text)
			.filter((s) => s.ampPos !== -1)
			.map((s) => s.ampPos);
	} catch {
		return [];
	}
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

/**
 * Locate and verify the text span of every top-level statement. Returns null
 * if anything about the lexing disagrees with the parser's view.
 */
function locateStatements(command: string, ast: Program): StatementSpan[] | null {
	let spans: StatementSpan[];
	try {
		spans = splitTopLevel(command);
	} catch {
		return null;
	}
	if (spans.length !== ast.body.length) return null;
	for (let k = 0; k < spans.length; k++) {
		const bg = spans[k].ampPos !== -1;
		if (bg !== Boolean(ast.body[k].background)) return null;
		if (!bg) continue;
		// Re-parse the statement text alone; it must be the same command.
		const sub = parseProgram(command.slice(spans[k].start, spans[k].end));
		if (!sub || sub.body.length !== 1 || sub.body[0].background) return null;
		if (JSON.stringify(sub.body[0].command) !== JSON.stringify(ast.body[k].command)) return null;
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
