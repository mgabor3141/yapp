/**
 * Line deduplication for repetitive output.
 *
 * Uses word-level tokenization: each line is split into words, numbers,
 * and symbols. Token-level comparison naturally handles digit-width changes
 * ("Request 1" → "Request 200" are both 3 tokens with a number in the middle)
 * and cleanly separates structural differences ("✓ PASS" vs "× FAIL" differ
 * in two non-number tokens) from counter/timestamp variation.
 */

/** Minimum consecutive similar lines to trigger dedup. */
const MIN_RUN_LENGTH = 4;

/** Minimum fixed characters to consider a pattern valid. */
const MIN_MATCH_CHARS = 15;

/** Minimum ratio of fixed chars to total chars. */
const MIN_MATCH_RATIO = 0.5;

/** Maximum length ratio between lines in a run. */
const MAX_LENGTH_RATIO = 1.5;

// ── Tokenizer ───────────────────────────────────────────────────────────────

interface Token {
	text: string;
	isNumber: boolean;
}

/**
 * Split a line into tokens: word runs, digit runs, whitespace runs,
 * and individual symbol characters.
 *
 * Examples:
 *   "Request 200 processed" → ["Request", " ", "200", " ", "processed"]
 *   "test/module-1.ts"      → ["test", "/", "module", "-", "1", ".", "ts"]
 *   "19:29:37.800"          → ["19", ":", "29", ":", "37", ".", "800"]
 */
function tokenize(line: string): Token[] {
	const result: Token[] = [];
	for (const m of line.matchAll(/[a-zA-Z_]+|\d+|\s+|./g)) {
		result.push({ text: m[0], isNumber: /^\d+$/.test(m[0]) });
	}
	return result;
}

// ── Pattern ─────────────────────────────────────────────────────────────────

type PatternSlot = { type: "fixed"; text: string } | { type: "number-var" };

/**
 * A pattern extracted from comparing two token arrays.
 *
 * Structure: prefix slots | optional variable middle | suffix slots.
 * The prefix and suffix contain fixed-text and number-variable slots.
 * The middle (if present) is a gap where tokens differ freely.
 */
export interface LinePattern {
	/** Token slots from the start of the line. */
	prefix: PatternSlot[];
	/** Token slots from the end of the line (stored in reverse: index 0 = last token). */
	suffix: PatternSlot[];
	/** Whether there's a variable middle section between prefix and suffix. */
	hasMiddle: boolean;
	/** Total characters in fixed slots (for validation). */
	fixedChars: number;
	/** Number of variable (number-var) slots. */
	variableCount: number;
}

/**
 * Compare two token arrays and extract a prefix+suffix pattern.
 * Returns null if lines are too different.
 */
function extractTokenPattern(tokA: Token[], tokB: Token[], lenA: number, lenB: number): LinePattern | null {
	const maxLen = Math.max(lenA, lenB);
	const minLen = Math.min(lenA, lenB);

	if (maxLen === 0) return null;
	if (minLen > 0 && maxLen / minLen > MAX_LENGTH_RATIO) return null;

	// Match from start until tokens diverge
	const prefix: PatternSlot[] = [];
	let prefixLen = 0;
	while (prefixLen < tokA.length && prefixLen < tokB.length) {
		const a = tokA[prefixLen];
		const b = tokB[prefixLen];
		if (a.text === b.text) {
			prefix.push({ type: "fixed", text: a.text });
		} else if (a.isNumber && b.isNumber) {
			prefix.push({ type: "number-var" });
		} else {
			break;
		}
		prefixLen++;
	}

	// Match from end until tokens diverge (not overlapping prefix)
	const suffix: PatternSlot[] = [];
	let suffixLen = 0;
	while (suffixLen < tokA.length - prefixLen && suffixLen < tokB.length - prefixLen) {
		const a = tokA[tokA.length - 1 - suffixLen];
		const b = tokB[tokB.length - 1 - suffixLen];
		if (a.text === b.text) {
			suffix.push({ type: "fixed", text: a.text });
		} else if (a.isNumber && b.isNumber) {
			suffix.push({ type: "number-var" });
		} else {
			break;
		}
		suffixLen++;
	}

	// Check middle section
	const midA = tokA.slice(prefixLen, tokA.length - suffixLen);
	const midB = tokB.slice(prefixLen, tokB.length - suffixLen);
	const hasMiddle = midA.length > 0 || midB.length > 0;

	// The middle is at most one semantic zone. The real guard is the
	// fixedChars ratio — if the prefix+suffix are short relative to the
	// line length (meaning the middle dominates), the pattern gets rejected.

	// Calculate fixed chars
	const fixedChars = [...prefix, ...suffix]
		.filter((s): s is { type: "fixed"; text: string } => s.type === "fixed")
		.reduce((sum, s) => sum + s.text.length, 0);

	if (fixedChars < MIN_MATCH_CHARS) return null;
	if (fixedChars / maxLen < MIN_MATCH_RATIO) return null;

	const variableCount =
		prefix.filter((s) => s.type === "number-var").length +
		suffix.filter((s) => s.type === "number-var").length +
		(hasMiddle ? 1 : 0);

	return { prefix, suffix, hasMiddle, fixedChars, variableCount };
}

/**
 * Compare two lines and extract a token-level pattern.
 * Returns null if lines are too different to be considered the same pattern.
 */
export function extractPattern(a: string, b: string): LinePattern | null {
	return extractTokenPattern(tokenize(a), tokenize(b), a.length, b.length);
}

/**
 * Check if a tokenized line matches a pattern.
 * Prefix and suffix slots must match; the middle can vary freely.
 */
function matchTokenPattern(tok: Token[], pattern: LinePattern): boolean {
	if (tok.length < pattern.prefix.length + pattern.suffix.length) return false;

	// Check prefix
	for (let i = 0; i < pattern.prefix.length; i++) {
		const slot = pattern.prefix[i];
		const t = tok[i];
		if (slot.type === "fixed" && slot.text !== t.text) return false;
		if (slot.type === "number-var" && !t.isNumber) return false;
	}

	// Check suffix (from end)
	for (let i = 0; i < pattern.suffix.length; i++) {
		const slot = pattern.suffix[i];
		const t = tok[tok.length - 1 - i];
		if (slot.type === "fixed" && slot.text !== t.text) return false;
		if (slot.type === "number-var" && !t.isNumber) return false;
	}

	return true;
}

/**
 * Check if a line matches an existing pattern.
 */
export function matchesPattern(line: string, pattern: LinePattern): boolean {
	return matchTokenPattern(tokenize(line), pattern);
}

/**
 * Format a pattern for display.
 * Shows fixed tokens as-is, variable slots as `*`, middle gap as `*`.
 */
export function formatPattern(pattern: LinePattern): string {
	const parts: string[] = [];

	for (const slot of pattern.prefix) {
		parts.push(slot.type === "fixed" ? slot.text : "*");
	}

	if (pattern.hasMiddle) {
		parts.push("*");
	}

	// Suffix is stored in reverse order (index 0 = last token)
	for (let i = pattern.suffix.length - 1; i >= 0; i--) {
		const slot = pattern.suffix[i];
		parts.push(slot.type === "fixed" ? slot.text : "*");
	}

	return parts
		.join("")
		.replace(/\*{2,}/g, "*")
		.trim();
}

// ── Dedup pass ──────────────────────────────────────────────────────────────

export interface DedupResult {
	/** Output lines after dedup (some original lines replaced with summary). */
	lines: string[];
	/** Total lines removed by dedup. */
	dedupedLines: number;
	/** Number of dedup groups. */
	groupCount: number;
}

/**
 * Deduplicate consecutive similar lines.
 *
 * Runs of 4+ lines following the same token-level pattern are collapsed to:
 *   [first line of run]
 *   [× N similar: pattern]
 *
 * @param lines Input lines
 * @param minRun Minimum run length to trigger dedup (default: 4)
 */
export function dedup(lines: string[], minRun = MIN_RUN_LENGTH): DedupResult {
	if (lines.length < minRun) return { lines: [...lines], dedupedLines: 0, groupCount: 0 };

	// Tokenize all lines upfront
	const allTokens = lines.map(tokenize);

	const result: string[] = [];
	let dedupedLines = 0;
	let groupCount = 0;

	let i = 0;
	while (i < lines.length) {
		// Try to start a run from this line
		let pattern: LinePattern | null = null;
		if (i + 1 < lines.length) {
			pattern = extractTokenPattern(allTokens[i], allTokens[i + 1], lines[i].length, lines[i + 1].length);
		}

		if (!pattern) {
			result.push(lines[i]);
			i++;
			continue;
		}

		// Extend the run: the pattern from the first pair is the lock.
		// Subsequent lines must match all fixed token positions.
		let runEnd = i + 2;
		while (runEnd < lines.length) {
			if (!matchTokenPattern(allTokens[runEnd], pattern)) break;
			runEnd++;
		}

		const runLength = runEnd - i;

		if (runLength < minRun) {
			// Run too short — emit lines as-is
			for (let j = i; j < runEnd; j++) {
				result.push(lines[j]);
			}
			i = runEnd;
			continue;
		}

		// Emit first line + summary
		result.push(lines[i]);
		const collapsed = runLength - 1;
		const patternStr = formatPattern(pattern);
		result.push(`[× ${collapsed} similar: ${patternStr}]`);
		dedupedLines += collapsed;
		groupCount++;
		i = runEnd;
	}

	return { lines: result, dedupedLines, groupCount };
}
