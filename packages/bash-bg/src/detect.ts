/**
 * AST-based detection of background commands in bash scripts.
 *
 * Uses @aliou/sh to parse commands and identify statements with `background: true`.
 * Extracts metadata needed for rewriting: whether redirections already exist,
 * whether disown follows, and a human-readable label for the process.
 */

import {
	type Command,
	type Logical,
	type Pipeline,
	type Program,
	type Redirect,
	type SimpleCommand,
	type Statement,
	type Word,
	parse,
} from "@aliou/sh";

/** Metadata about a single background statement in the script. */
export interface BgStatement {
	/** Index into the Program.body array. */
	index: number;
	/** Human-readable label for the process (e.g. "npm run dev"). */
	label: string;
	/** Whether stdout is already redirected (>, >>, &>, &>>). */
	hasStdoutRedirect: boolean;
	/** Whether stderr is already redirected (2>, 2>>, >&, &>, &>>). */
	hasStderrRedirect: boolean;
	/** Whether the next statement is a `disown` command. */
	followedByDisown: boolean;
	/**
	 * Whether the command is compound (Logical, Pipeline, Subshell, Block, etc.).
	 * Compound commands need to be wrapped in `{ ...; }` so that the redirect
	 * applies to the whole background subshell, not just the last simple command.
	 */
	isCompound: boolean;
}

/** Result of analyzing a bash command for background processes. */
export interface DetectResult {
	/** The parsed AST (null if parsing failed). */
	ast: Program | null;
	/** Background statements found. Empty if none or parse failure. */
	bgStatements: BgStatement[];
}

/** Parse a bash command and find all background statements. */
export function detectBackground(command: string): DetectResult {
	let ast: Program;
	try {
		({ ast } = parse(command, { dialect: "bash" }));
	} catch {
		return { ast: null, bgStatements: [] };
	}

	const bgStatements: BgStatement[] = [];

	for (let i = 0; i < ast.body.length; i++) {
		const stmt = ast.body[i];
		if (!stmt.background) continue;

		const label = extractLabel(stmt);
		const { hasStdoutRedirect, hasStderrRedirect } = checkRedirects(stmt.command);
		const followedByDisown = isFollowedByDisown(ast.body, i);
		const isCompound = stmt.command.type !== "SimpleCommand" && stmt.command.type !== "DeclClause";

		bgStatements.push({
			index: i,
			label,
			hasStdoutRedirect,
			hasStderrRedirect,
			followedByDisown,
			isCompound,
		});
	}

	return { ast, bgStatements };
}

// ── Redirect detection ───────────────────────────────────────────────────────

function checkRedirects(cmd: Command): { hasStdoutRedirect: boolean; hasStderrRedirect: boolean } {
	const redirects = collectRedirects(cmd);
	let hasStdoutRedirect = false;
	let hasStderrRedirect = false;

	for (const r of redirects) {
		const op = r.op;
		const fd = r.fd;

		// &> and &>> redirect both stdout and stderr
		if (op === "&>" || op === "&>>") {
			hasStdoutRedirect = true;
			hasStderrRedirect = true;
			continue;
		}

		// > or >> without fd, or with fd=1: stdout redirect
		if ((op === ">" || op === ">>" || op === ">|") && (fd === undefined || fd === "1")) {
			hasStdoutRedirect = true;
			continue;
		}

		// >& (dup): 2>&1 redirects stderr to stdout
		if (op === ">&" && fd === "2") {
			hasStderrRedirect = true;
			continue;
		}

		// 2> or 2>>: explicit stderr redirect
		if ((op === ">" || op === ">>") && fd === "2") {
			hasStderrRedirect = true;
		}
	}

	return { hasStdoutRedirect, hasStderrRedirect };
}

/**
 * Collect all redirects from a command, walking into compound structures.
 * For Logical (&&, ||), the redirects that matter for pipe inheritance
 * are on the rightmost command (the one that actually runs in background).
 */
function collectRedirects(cmd: Command): Redirect[] {
	switch (cmd.type) {
		case "SimpleCommand":
			return cmd.redirects ?? [];
		case "Logical":
			// In `cd /dir && npm start &`, npm start is the rightmost
			return collectRedirects(cmd.right.command);
		case "Pipeline":
			// Last command in the pipeline inherits the pipes
			if (cmd.commands.length > 0) {
				return collectRedirects(cmd.commands[cmd.commands.length - 1].command);
			}
			return [];
		default:
			return [];
	}
}

// ── Disown detection ─────────────────────────────────────────────────────────

function isFollowedByDisown(body: Statement[], bgIndex: number): boolean {
	// Check subsequent statements (not just the immediate next one)
	// for patterns like: cmd & PID=$!; disown $PID
	for (let j = bgIndex + 1; j < body.length; j++) {
		const next = body[j];
		if (next.background) break; // Another background command, stop looking
		const name = getCommandName(next.command);
		if (name === "disown") return true;
		// Keep looking past assignments like PID=$!
		if (next.command.type === "SimpleCommand" && !next.command.words?.length) continue;
		// Any other real command means disown isn't coming
		if (name !== null) break;
	}
	return false;
}

// ── Label extraction ─────────────────────────────────────────────────────────

const WRAPPER_COMMANDS = new Set(["nohup", "env", "nice", "ionice", "time", "strace", "sudo"]);

/** Extract a human-readable label for a background command. */
function extractLabel(stmt: Statement): string {
	return extractCommandLabel(stmt.command);
}

function extractCommandLabel(cmd: Command): string {
	switch (cmd.type) {
		case "SimpleCommand":
			return getSimpleCommandLabel(cmd);
		case "Logical":
			// For "cd /dir && npm start &", use the rightmost command
			return extractCommandLabel(cmd.right.command);
		case "Pipeline": {
			const parts = cmd.commands.map((s) => extractCommandLabel(s.command));
			return parts.join(" | ");
		}
		case "Subshell":
			return "(subshell)";
		case "Block":
			return "{block}";
		case "WhileClause":
			return "while loop";
		case "ForClause":
			return `for ${cmd.name}`;
		default:
			return cmd.type;
	}
}

function getSimpleCommandLabel(cmd: SimpleCommand): string {
	if (!cmd.words?.length) return "(assignment)";
	const words = cmd.words.map(wordToString);

	// Skip wrapper commands (nohup, env, sudo, etc.)
	let start = 0;
	while (start < words.length && WRAPPER_COMMANDS.has(words[start])) start++;

	const meaningful = words.slice(start);
	return meaningful.length > 0 ? meaningful.join(" ") : words.join(" ");
}

function wordToString(word: Word): string {
	return word.parts
		.map((p) => {
			switch (p.type) {
				case "Literal":
					return p.value;
				case "SglQuoted":
					return `'${p.value}'`;
				case "DblQuoted":
					return p.parts
						.map((dp) => (dp.type === "Literal" ? dp.value : `$${dp.type === "ParamExp" ? dp.param.value : "(...)"}`))
						.join("");
				case "ParamExp":
					return `$${p.param.value}`;
				case "CmdSubst":
					return "$(...)";
				default:
					return "";
			}
		})
		.join("");
}

function getCommandName(cmd: Command): string | null {
	if (cmd.type === "SimpleCommand" && cmd.words?.length) {
		return wordToString(cmd.words[0]);
	}
	return null;
}
