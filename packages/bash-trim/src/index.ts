/**
 * Smarter bash output trimming for LLM context.
 *
 * Post-processes bash tool results with three passes:
 *
 * 1. **Column trimming** — Lines wider than MAX_LINE_WIDTH get their middle
 *    replaced with `[...]`, cutting on BPE token boundaries.
 *
 * 2. **Dedup** — Consecutive similar lines collapsed into summaries.
 *
 * 3. **Row trimming** — If total tokens exceed MAX_TOTAL_TOKENS, middle rows
 *    are omitted, keeping head and tail.
 *
 * Full unmodified output is saved to a temp file when any trimming happens.
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
	TrimOptionsSchema,
	DEFAULT_MAX_LINE_WIDTH,
	DEFAULT_TRIMMED_WIDTH,
	DEFAULT_HEAD_RATIO,
	DEFAULT_MAX_TOTAL_TOKENS,
	DEFAULT_MIN_TOKENS_TO_TRIM,
} from "./trim.js";
export type { TrimResult, TrimOptions, RowTrimResult, ColTrimmedLine } from "./trim.js";
export { dedup, extractPattern, formatPattern, matchesPattern } from "./dedup.js";
export type { LinePattern, DedupResult } from "./dedup.js";

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

		if (!result.columnsTrimmed && !result.rowsTrimmed && result.dedupedLines === 0) return;

		// ── Temp file ────────────────────────────────────────────────────
		const fullPath = existingFullPath ?? (await writeTempFile(fullOutput, "full"));

		// ── Build output ─────────────────────────────────────────────────
		const parts: string[] = [];
		if (result.dedupedLines > 0) parts.push(`${result.dedupedLines} repetitive lines collapsed`);
		if (result.rowsTrimmed) parts.push(`${result.omittedLines} lines omitted`);
		if (result.columnsTrimmed) parts.push("long lines shortened with [...]");

		const header = `[Trimmed: ${parts.join(", ")}. Full output: ${fullPath}]`;
		let resultText = `${header}\n${result.text}`;

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
