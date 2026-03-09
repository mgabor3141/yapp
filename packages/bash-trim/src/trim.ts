import { decode, encode } from "gpt-tokenizer/encoding/o200k_base";
import * as v from "valibot";
import { dedup } from "./dedup.js";

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Characters per line before column trimming kicks in (visual width). */
export const DEFAULT_MAX_LINE_WIDTH = 180;

/**
 * Approximate character width of a line after column trimming.
 * The actual cut lands on the nearest token boundary, so the result
 * may be slightly longer or shorter.
 */
export const DEFAULT_TRIMMED_WIDTH = 150;

/**
 * Ratio of kept content allocated to the head (start of line).
 * 0.8 means 80% head, 20% tail. The beginning of a line is almost
 * always more informative than the middle.
 */
export const DEFAULT_HEAD_RATIO = 0.8;

/**
 * Maximum total tokens before row trimming kicks in.  2 000 tokens is roughly
 * 80-100 lines of head+tail — enough to see errors and summaries.  The full
 * output is always saved to a temp file.
 */
export const DEFAULT_MAX_TOTAL_TOKENS = 2_000;

/**
 * Below this token count, output is returned unmodified — no column trimming,
 * no dedup, no row trimming. Short outputs aren't worth touching.
 */
export const DEFAULT_MIN_TOKENS_TO_TRIM = 200;

// ── Options ──────────────────────────────────────────────────────────────────

export const TrimOptionsSchema = v.object({
	/** Lines wider than this get column-trimmed. Default: 180 */
	maxLineWidth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), DEFAULT_MAX_LINE_WIDTH),
	/** Approximate width of a trimmed line. Default: 150 */
	trimmedWidth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), DEFAULT_TRIMMED_WIDTH),
	/** Ratio of kept content from the head (0.0–1.0). Default: 0.8 */
	headRatio: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), DEFAULT_HEAD_RATIO),
	/** Total token budget before row trimming. Default: 2000 */
	maxTotalTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), DEFAULT_MAX_TOTAL_TOKENS),
	/** Below this token count, return output unmodified. Default: 200 */
	minTokensToTrim: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), DEFAULT_MIN_TOKENS_TO_TRIM),
	/** Minimum consecutive similar lines to collapse. Default: 4 */
	minDedupLines: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2)), 4),
});
export type TrimOptions = v.InferOutput<typeof TrimOptionsSchema>;

/** Marker inserted in column-trimmed lines. */
const COL_TRIM_MARKER = " [...] ";
const COL_TRIM_MARKER_TOKENS = encode(COL_TRIM_MARKER).length;

// ── Tokenized line ──────────────────────────────────────────────────────────

interface LineTokens {
	/** Original line text. */
	text: string;
	/** Token IDs for this line (excluding the trailing newline). */
	tokens: number[];
}

/**
 * Encode each line separately.  This gives clean per-line token arrays without
 * the complexity of splitting boundary tokens (BPE merges like `";\n"` make
 * single-encode line-splitting unreliable).  Performance is equivalent: both
 * approaches take ~2 ms for 1 000 lines.
 */
function tokenizeLines(lines: string[]): LineTokens[] {
	return lines.map((text) => ({ text, tokens: encode(text) }));
}

// ── Column trimming ─────────────────────────────────────────────────────────

export interface ColTrimmedLine {
	/** Resulting text (original if not trimmed, head + [...] + tail if trimmed). */
	text: string;
	/** Token count of the resulting text. */
	tokenCount: number;
	/** Whether this line was column-trimmed. */
	trimmed: boolean;
	/** Number of characters omitted (0 if not trimmed). */
	omittedChars: number;
}

/**
 * Column-trim a single line at token boundaries.
 *
 * The trigger threshold is character-based (maxLineWidth) because the purpose
 * is to catch visually wide lines.  But the cut points always land between
 * tokens so the LLM never sees a partial token.
 *
 * `trimmedWidth` controls the approximate width of the result.
 * `headRatio` controls how much of the kept content comes from the start
 * of the line (0.8 = 80% head, 20% tail).
 */
function colTrimLine(
	lt: LineTokens,
	maxWidth = DEFAULT_MAX_LINE_WIDTH,
	trimmedWidth = DEFAULT_TRIMMED_WIDTH,
	headRatio = DEFAULT_HEAD_RATIO,
): ColTrimmedLine {
	if (lt.text.length <= maxWidth) {
		return { text: lt.text, tokenCount: lt.tokens.length, trimmed: false, omittedChars: 0 };
	}

	const headKeepChars = Math.round(trimmedWidth * headRatio);
	const tailKeepChars = Math.round(trimmedWidth * (1 - headRatio));

	// Walk forward for head
	let headEnd = 0;
	let headChars = 0;
	for (let i = 0; i < lt.tokens.length; i++) {
		const decoded = decode([lt.tokens[i]]);
		if (headChars + decoded.length > headKeepChars && headEnd > 0) break;
		headChars += decoded.length;
		headEnd = i + 1;
	}

	// Walk backward for tail
	let tailStart = lt.tokens.length;
	let tailChars = 0;
	for (let i = lt.tokens.length - 1; i >= headEnd; i--) {
		const decoded = decode([lt.tokens[i]]);
		if (tailChars + decoded.length > tailKeepChars && tailStart < lt.tokens.length) break;
		tailChars += decoded.length;
		tailStart = i;
	}

	// If head and tail overlap or abut, no room to trim
	if (tailStart <= headEnd) {
		return { text: lt.text, tokenCount: lt.tokens.length, trimmed: false, omittedChars: 0 };
	}

	const headText = decode(lt.tokens.slice(0, headEnd));
	const tailText = decode(lt.tokens.slice(tailStart));
	const omittedChars = lt.text.length - headText.length - tailText.length;
	const resultTokenCount = headEnd + COL_TRIM_MARKER_TOKENS + (lt.tokens.length - tailStart);

	return {
		text: `${headText}${COL_TRIM_MARKER}${tailText}`,
		tokenCount: resultTokenCount,
		trimmed: true,
		omittedChars,
	};
}

// ── Row trimming ────────────────────────────────────────────────────────────

export interface RowTrimResult {
	lines: string[];
	omittedLines: number;
	omittedTokens: number;
	/** Index of first omitted line (= number of head lines kept). */
	headEnd: number;
	/** Index of first tail line kept. */
	tailStart: number;
}

/**
 * Trim rows from the middle when total token count exceeds the budget.
 *
 * Each line costs its own tokens plus 1 for the newline separator.
 */
export function trimRows(colLines: ColTrimmedLine[], maxTokens = DEFAULT_MAX_TOTAL_TOKENS): RowTrimResult {
	// Total tokens: sum of per-line tokens + (N-1) newline tokens
	const totalTokens = colLines.reduce((sum, l) => sum + l.tokenCount, 0) + Math.max(0, colLines.length - 1);
	if (totalTokens <= maxTokens) {
		return {
			lines: colLines.map((l) => l.text),
			omittedLines: 0,
			omittedTokens: 0,
			headEnd: colLines.length,
			tailStart: colLines.length,
		};
	}

	const budget = Math.floor(maxTokens / 2);

	// Walk forward for head
	let headEnd = 0;
	let headTokens = 0;
	while (headEnd < colLines.length) {
		const cost = colLines[headEnd].tokenCount + (headEnd > 0 ? 1 : 0); // +1 for \n
		if (headTokens + cost > budget) break;
		headTokens += cost;
		headEnd++;
	}

	// Walk backward for tail
	let tailStart = colLines.length;
	let tailTokens = 0;
	while (tailStart > headEnd) {
		const idx = tailStart - 1;
		const cost = colLines[idx].tokenCount + 1; // +1 for \n
		if (tailTokens + cost > budget) break;
		tailTokens += cost;
		tailStart--;
	}

	// Ensure at least 1 line on each side
	if (headEnd === 0) headEnd = 1;
	if (tailStart >= colLines.length) tailStart = colLines.length - 1;
	if (tailStart <= headEnd) {
		return {
			lines: colLines.map((l) => l.text),
			omittedLines: 0,
			omittedTokens: 0,
			headEnd: colLines.length,
			tailStart: colLines.length,
		};
	}

	const omittedLines = tailStart - headEnd;
	const omittedTokens = colLines.slice(headEnd, tailStart).reduce((sum, l) => sum + l.tokenCount + 1, -1); // +1 per newline, -1 for no trailing

	return {
		lines: [
			...colLines.slice(0, headEnd).map((l) => l.text),
			`[... ${omittedLines} lines omitted ...]`,
			...colLines.slice(tailStart).map((l) => l.text),
		],
		omittedLines,
		omittedTokens,
		headEnd,
		tailStart,
	};
}

// ── Full pipeline ───────────────────────────────────────────────────────────

export interface TrimResult {
	/** The trimmed output text. */
	text: string;
	/** Whether any column trimming happened in the visible output. */
	columnsTrimmed: boolean;
	/** Whether any row trimming happened. */
	rowsTrimmed: boolean;
	/** Characters omitted by column trimming in visible lines only. */
	columnCharsOmitted: number;
	/** Number of visible lines that were column-trimmed. */
	columnLinesTrimmed: number;
	/** Number of lines collapsed by dedup. */
	dedupedLines: number;
	/** Number of dedup groups. */
	dedupGroupCount: number;
	/** Number of lines omitted from the middle (0 if no row trimming). */
	omittedLines: number;
	/** Number of tokens omitted from the middle (0 if no row trimming). */
	omittedTokens: number;
	/** Total number of lines in the original input. */
	totalLines: number;
}

export function trimOutput(fullOutput: string, options?: Partial<TrimOptions>): TrimResult {
	const opts = v.parse(TrimOptionsSchema, options ?? {});
	const { maxLineWidth, trimmedWidth, headRatio, maxTotalTokens, minTokensToTrim, minDedupLines } = opts;

	const rawLines = fullOutput.split("\n");
	const tokenized = tokenizeLines(rawLines);

	// Short output — return unmodified, not worth touching
	const totalRawTokens = tokenized.reduce((sum, l) => sum + l.tokens.length, 0) + Math.max(0, rawLines.length - 1);
	if (totalRawTokens < minTokensToTrim) {
		return {
			text: fullOutput,
			columnsTrimmed: false,
			rowsTrimmed: false,
			columnCharsOmitted: 0,
			columnLinesTrimmed: 0,
			dedupedLines: 0,
			dedupGroupCount: 0,
			omittedLines: 0,
			omittedTokens: 0,
			totalLines: rawLines.length,
		};
	}

	// Phase 1: Column trimming
	const colTrimmed = tokenized.map((lt) => colTrimLine(lt, maxLineWidth, trimmedWidth, headRatio));
	const anyColumnsTrimmed = colTrimmed.some((l) => l.trimmed);

	// Phase 2: Dedup — only if row trimming is actually needed.
	// If the output fits within the token budget, dedup is counter-productive:
	// collapsing e.g. 10 similar `ls` rows when nothing is being cut from the
	// middle just destroys information for no benefit.
	const rowCheckWithoutDedup = trimRows(colTrimmed, maxTotalTokens);
	const needsRowTrimming = rowCheckWithoutDedup.omittedLines > 0;

	let dedupResult: { lines: string[]; dedupedLines: number; groupCount: number };
	let dedupColTrimmed: ColTrimmedLine[];

	if (needsRowTrimming) {
		// Dedup to reclaim space before row trimming
		const colTexts = colTrimmed.map((l) => l.text);
		dedupResult = dedup(colTexts, minDedupLines);

		if (dedupResult.dedupedLines > 0) {
			dedupColTrimmed = dedupResult.lines.map((text) => {
				// Try to find the original ColTrimmedLine for non-summary lines
				const origIdx = colTexts.indexOf(text);
				if (origIdx !== -1) return colTrimmed[origIdx];
				// Summary line — encode fresh
				return { text, tokenCount: encode(text).length, trimmed: false, omittedChars: 0 };
			});
		} else {
			dedupColTrimmed = colTrimmed;
		}
	} else {
		dedupResult = { lines: [], dedupedLines: 0, groupCount: 0 };
		dedupColTrimmed = colTrimmed;
	}

	// Phase 3: Row trimming (uses column-trimmed + deduped token counts)
	const rowResult = needsRowTrimming ? trimRows(dedupColTrimmed, maxTotalTokens) : rowCheckWithoutDedup;
	const rowsTrimmed = rowResult.omittedLines > 0;

	// Column-trim stats for visible lines only (after dedup + row trimming).
	// When rows are omitted, a trimmed line may land in the cut section —
	// reporting it would confuse users who can't see any [...] markers.
	const visibleColTrimmed = rowsTrimmed
		? [...dedupColTrimmed.slice(0, rowResult.headEnd), ...dedupColTrimmed.slice(rowResult.tailStart)]
		: dedupColTrimmed;
	const columnCharsOmitted = visibleColTrimmed.reduce((sum, l) => sum + l.omittedChars, 0);
	const columnLinesTrimmed = visibleColTrimmed.filter((l) => l.trimmed).length;
	const columnsTrimmed = columnLinesTrimmed > 0;

	return {
		text: rowResult.lines.join("\n"),
		columnsTrimmed,
		rowsTrimmed,
		columnCharsOmitted,
		columnLinesTrimmed,
		dedupedLines: dedupResult.dedupedLines,
		dedupGroupCount: dedupResult.groupCount,
		omittedLines: rowResult.omittedLines,
		omittedTokens: rowResult.omittedTokens,
		totalLines: rawLines.length,
	};
}
