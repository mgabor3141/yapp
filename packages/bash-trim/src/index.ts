/**
 * Smarter bash output trimming for LLM context.
 *
 * Post-processes bash tool results with two token-aware passes:
 *
 * 1. **Column trimming** — Lines wider than MAX_LINE_WIDTH get their middle
 *    replaced with `[...]`, cutting on token boundaries so the LLM never sees
 *    partial tokens.
 *
 * 2. **Row trimming** — If total tokens (after column trimming) exceed
 *    MAX_TOTAL_TOKENS, middle rows are omitted.  The budget is measured in
 *    actual BPE tokens, so `seq 1 2000` (5K tokens) passes through while a
 *    1000-line log (27K tokens) gets trimmed.
 *
 * Temp files:
 *   - Full output (unmodified) — always provided when any trimming happened.
 *   - Column-trimmed output (all rows, wide lines trimmed) — only when BOTH
 *     trims happened.
 */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";
import { trimOutput } from "./trim.js";

export {
	trimOutput,
	trimRows,
	DEFAULT_MAX_LINE_WIDTH,
	DEFAULT_TRIMMED_WIDTH,
	DEFAULT_HEAD_RATIO,
	DEFAULT_MAX_TOTAL_TOKENS,
} from "./trim.js";
export type { TrimResult, TrimOptions, RowTrimResult, ColTrimmedLine } from "./trim.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tempCounter = 0;

function tempPath(label: string): string {
	return join(tmpdir(), `pi-bash-trim-${process.pid}-${++tempCounter}-${label}.log`);
}

async function writeTempFile(content: string, label: string): Promise<string> {
	const p = tempPath(label);
	await writeFile(p, content, "utf-8");
	return p;
}

/**
 * Strip the built-in truncation notice that the bash tool appends.
 */
export function stripBuiltinNotice(input: string): {
	output: string;
	exitCodeLine: string | null;
	fullOutputPath: string | null;
} {
	let exitCodeLine: string | null = null;
	let fullOutputPath: string | null = null;
	let text = input;

	const exitMatch = text.match(/\n\nCommand exited with code \d+$/);
	if (exitMatch) {
		exitCodeLine = exitMatch[0];
		text = text.slice(0, exitMatch.index);
	}

	const pathMatch = text.match(/Full output: (.+?)\]$/);
	if (pathMatch) fullOutputPath = pathMatch[1];

	text = text.replace(/\n\n\[Showing (?:lines|last) .+?\]$/, "");

	return { output: text, exitCodeLine, fullOutputPath };
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		if (!isBashToolResult(event)) return;

		const details = event.details;
		let fullOutput: string | null = null;

		const textBlock = event.content.find((c: { type: string }) => c.type === "text") as
			| { type: "text"; text: string }
			| undefined;
		if (!textBlock) return;

		const parsed = stripBuiltinNotice(textBlock.text);

		const existingFullPath = details?.fullOutputPath ?? parsed.fullOutputPath;
		if (existingFullPath) {
			try {
				fullOutput = await readFile(existingFullPath, "utf-8");
			} catch {
				// Can't read — fall through to content
			}
		}

		if (!fullOutput) {
			fullOutput = parsed.output;
		}

		if (!fullOutput || fullOutput === "(no output)") return;

		// ── Trim ─────────────────────────────────────────────────────────
		const result = trimOutput(fullOutput);

		if (!result.columnsTrimmed && !result.rowsTrimmed) return;

		// ── Temp files ───────────────────────────────────────────────────
		const fullPath = existingFullPath ?? (await writeTempFile(fullOutput, "full"));

		let colTrimmedPath: string | null = null;
		if (result.columnTrimmedFull) {
			colTrimmedPath = await writeTempFile(result.columnTrimmedFull, "cols-trimmed");
		}

		// ── Build notices ────────────────────────────────────────────────
		const summaryParts: string[] = [];

		if (result.columnsTrimmed) {
			summaryParts.push(
				`\`[...]\` marks content trimmed from ${result.columnLinesTrimmed} long lines (${result.columnCharsOmitted.toLocaleString()} chars omitted total).`,
			);
		}
		if (result.rowsTrimmed) {
			summaryParts.push(`${result.omittedLines} lines omitted from the middle of ${result.totalLines} total.`);
		}
		if (colTrimmedPath) {
			summaryParts.push(`All rows (long lines trimmed): ${colTrimmedPath}`);
		}
		if (fullPath) {
			summaryParts.push(`Full output: ${fullPath}`);
		}

		const footer = `[${summaryParts.join(" ")}]`;

		// ── Build result text ────────────────────────────────────────────
		// Short header so the LLM knows this output is trimmed before it
		// starts reading.  Full details (file paths, counts) go at the end.
		let header: string;
		if (result.columnsTrimmed && result.rowsTrimmed) {
			header = `[WARNING: this is not the full output. ${result.omittedLines} lines were cut from the middle and long lines were shortened. See notice at the bottom of this output for details.]`;
		} else if (result.rowsTrimmed) {
			header = `[WARNING: this is not the full output. ${result.omittedLines} lines were cut from the middle. See notice at the bottom of this output for details.]`;
		} else {
			header =
				"[WARNING: long lines in this output have been shortened with [...] markers. See notice at the bottom of this output for details.]";
		}
		let resultText = `${header}\n${result.text}\n${footer}`;

		if (parsed.exitCodeLine) {
			resultText += parsed.exitCodeLine;
		}

		return {
			content: [{ type: "text" as const, text: resultText }],
			details: {
				// Only fullOutputPath — gives the user a clean yellow
				// "[Full output: /path]" in the TUI. We omit `truncation` so there's
				// no stale "50KB limit" message.
				fullOutputPath: fullPath,
			},
		};
	});
}
