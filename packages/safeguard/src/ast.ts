/**
 * Bash command AST analysis — extracts structured signals from shell commands.
 *
 * Uses @aliou/sh to parse commands into an AST, then walks the tree to identify:
 * - Command names and arguments (from SimpleCommand words)
 * - File targets (arguments, redirect targets)
 * - Environment variable references (ParamExp nodes)
 * - Pipeline structure (what feeds into what)
 *
 * Falls back gracefully on parse errors — returns partial results from what
 * we could extract, or empty analysis if parsing fails entirely.
 */

import {
	type Command,
	type Program,
	type Redirect,
	type SimpleCommand,
	type Statement,
	type Word,
	type WordPart,
	parse,
} from "@aliou/sh";

// --- Public types ---

/** A single command in a pipeline or standalone. */
export interface CommandInfo {
	/** The command name (first word), e.g. "rm", "curl", "cat" */
	name: string;
	/** All arguments (words after the command name) */
	args: string[];
	/** All redirect targets (file paths in >, >>, etc.) */
	redirectTargets: string[];
	/** Environment variable names referenced via $VAR or ${VAR} */
	paramRefs: string[];
}

/** Full analysis of a bash command string. */
export interface BashAnalysis {
	/** Whether parsing succeeded */
	parsed: boolean;
	/** All commands found (flattened from pipelines, logical chains, etc.) */
	commands: CommandInfo[];
	/** Whether this is a pipeline (commands connected with |) */
	isPipeline: boolean;
	/** All file paths mentioned anywhere (args + redirect targets) */
	allFiles: string[];
	/** All environment variable references across all commands */
	allParamRefs: string[];
}

// --- Public API ---

/** Parse a bash command and extract structured signals. */
export function analyzeBashCommand(cmd: string): BashAnalysis {
	const empty: BashAnalysis = { parsed: false, commands: [], isPipeline: false, allFiles: [], allParamRefs: [] };

	let ast: Program;
	try {
		({ ast } = parse(cmd, { dialect: "bash" }));
	} catch {
		return empty;
	}

	const commands: CommandInfo[] = [];
	let isPipeline = false;

	for (const stmt of ast.body) {
		walkStatement(stmt, commands, (v) => {
			isPipeline = isPipeline || v;
		});
	}

	const allFiles = commands.flatMap((c) => [...c.args.filter(looksLikePath), ...c.redirectTargets]);
	const allParamRefs = [...new Set(commands.flatMap((c) => c.paramRefs))];

	return { parsed: true, commands, isPipeline, allFiles, allParamRefs };
}

// --- AST walking ---

function walkStatement(stmt: Statement, out: CommandInfo[], setPipeline: (v: boolean) => void): void {
	walkCommand(stmt.command, out, setPipeline);
}

function walkCommand(cmd: Command, out: CommandInfo[], setPipeline: (v: boolean) => void): void {
	switch (cmd.type) {
		case "SimpleCommand":
			out.push(extractSimpleCommand(cmd));
			break;
		case "Pipeline":
			setPipeline(true);
			for (const s of cmd.commands) {
				walkStatement(s, out, setPipeline);
			}
			break;
		case "Logical":
			walkStatement(cmd.left, out, setPipeline);
			walkStatement(cmd.right, out, setPipeline);
			break;
		case "Subshell":
		case "Block":
			for (const s of cmd.body) {
				walkStatement(s, out, setPipeline);
			}
			break;
		case "IfClause":
			for (const s of [...cmd.cond, ...cmd.then, ...(cmd.else ?? [])]) {
				walkStatement(s, out, setPipeline);
			}
			break;
		case "WhileClause":
			for (const s of [...cmd.cond, ...cmd.body]) {
				walkStatement(s, out, setPipeline);
			}
			break;
		case "ForClause":
			for (const s of cmd.body) {
				walkStatement(s, out, setPipeline);
			}
			break;
		case "CaseClause":
			for (const item of cmd.items ?? []) {
				for (const s of item.body) {
					walkStatement(s, out, setPipeline);
				}
			}
			break;
		case "DeclClause":
			// declare/local/export — extract any word values
			out.push(extractDeclClause(cmd));
			break;
		case "TimeClause":
			if (cmd.command) walkStatement(cmd.command, out, setPipeline);
			break;
		case "FunctionDecl":
			// Don't walk into function bodies — they're definitions, not executions
			break;
		// Ignore: TestClause, ArithCmd, CoprocClause, LetClause, CStyleLoop, SelectClause
		default:
			break;
	}
}

function extractSimpleCommand(cmd: SimpleCommand): CommandInfo {
	const words = (cmd.words ?? []).map(wordToString);
	const name = words[0] ?? "";
	const args = words.slice(1);
	const redirectTargets = (cmd.redirects ?? []).map((r: Redirect) => wordToString(r.target));
	const paramRefs = collectParamRefs(cmd);

	return { name, args, redirectTargets, paramRefs };
}

function extractDeclClause(cmd: {
	type: "DeclClause";
	variant: string;
	args?: Word[];
	words?: Word[];
	assigns?: unknown[];
}): CommandInfo {
	// @aliou/sh uses `args` for DeclClause, not `words`
	const wordList = cmd.args ?? cmd.words ?? [];
	const args = wordList.map(wordToString);
	return { name: cmd.variant, args, redirectTargets: [], paramRefs: collectParamRefsFromWords(wordList) };
}

// --- Word extraction ---

/** Flatten a Word to a string, resolving literals and marking expansions. */
function wordToString(word: Word): string {
	return word.parts.map(partToString).join("");
}

function partToString(part: WordPart): string {
	switch (part.type) {
		case "Literal":
			return part.value;
		case "SglQuoted":
			return part.value;
		case "DblQuoted":
			return part.parts.map(partToString).join("");
		case "ParamExp":
			return `$${part.param?.value ?? ""}`;
		case "CmdSubst":
			return "$(...)";
		case "ArithExp":
			return "$((...))";
		case "ProcSubst":
			return "<(...)";
		default:
			return "";
	}
}

// --- Param ref collection ---

function collectParamRefs(cmd: SimpleCommand): string[] {
	const refs: string[] = [];
	for (const w of cmd.words ?? []) {
		collectParamRefsFromParts(w.parts, refs);
	}
	for (const r of cmd.redirects ?? []) {
		collectParamRefsFromParts(r.target.parts, refs);
	}
	return refs;
}

function collectParamRefsFromWords(words: Word[]): string[] {
	const refs: string[] = [];
	for (const w of words) {
		collectParamRefsFromParts(w.parts, refs);
	}
	return refs;
}

function collectParamRefsFromParts(parts: WordPart[], refs: string[]): void {
	for (const p of parts) {
		if (p.type === "ParamExp" && p.param?.value) {
			refs.push(p.param.value);
		}
		if (p.type === "DblQuoted") {
			collectParamRefsFromParts(p.parts, refs);
		}
	}
}

// --- Helpers ---

/** Heuristic: does this string look like a file path? */
function looksLikePath(s: string): boolean {
	return s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~") || s.includes(".");
}
