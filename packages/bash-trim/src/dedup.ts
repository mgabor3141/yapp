/**
 * Line deduplication for repetitive output.
 *
 * Detects runs of consecutive lines that follow the same pattern —
 * same text at the same column positions, with variable segments
 * (timestamps, counters, PIDs, paths) in between.
 *
 * No timestamp parsing needed: column-aligned comparison finds the
 * fixed and variable parts automatically.
 */

/** Minimum consecutive similar lines to trigger dedup. */
const MIN_RUN_LENGTH = 4;

/** Minimum ratio of matching chars to consider lines "same pattern". */
const MIN_MATCH_RATIO = 0.5;

/** Minimum absolute matching chars. Short lines need this floor. */
const MIN_MATCH_CHARS = 15;

/** Maximum length difference between lines in a run (ratio). */
const MAX_LENGTH_RATIO = 1.5;

/** Minimum length of a segment to include in the pattern display. */
const MIN_SEGMENT_DISPLAY = 3;

// --- Pattern extraction ---

/** A segment is either fixed text or a variable gap. */
interface Segment {
	type: "fixed" | "variable";
	/** The text (for fixed) or length hint (for variable). */
	text: string;
	start: number;
	length: number;
}

/** A pattern extracted from comparing consecutive lines. */
export interface LinePattern {
	segments: Segment[];
	/** Total chars in fixed segments. */
	fixedChars: number;
	/** Number of variable gaps. */
	variableCount: number;
}

/**
 * Compare two lines char-by-char and extract fixed/variable segments.
 * Returns null if lines are too different to be considered the same pattern.
 */
export function extractPattern(a: string, b: string): LinePattern | null {
	const len = Math.min(a.length, b.length);
	const maxLen = Math.max(a.length, b.length);

	if (maxLen === 0) return null;
	if (len > 0 && maxLen / len > MAX_LENGTH_RATIO) return null;

	const segments: Segment[] = [];
	let fixedChars = 0;
	let i = 0;

	while (i < len) {
		if (a[i] === b[i]) {
			// Start of a fixed segment
			const start = i;
			while (i < len && a[i] === b[i]) i++;
			const text = a.slice(start, i);
			segments.push({ type: "fixed", text, start, length: text.length });
			fixedChars += text.length;
		} else {
			// Start of a variable segment
			const start = i;
			while (i < len && a[i] !== b[i]) i++;
			segments.push({ type: "variable", text: "*", start, length: i - start });
		}
	}

	// Trailing chars in the longer line count as variable
	if (a.length !== b.length) {
		segments.push({ type: "variable", text: "*", start: len, length: maxLen - len });
	}

	// Check if enough of the line is fixed
	if (fixedChars < MIN_MATCH_CHARS) return null;
	if (fixedChars / maxLen < MIN_MATCH_RATIO) return null;

	const variableCount = segments.filter((s) => s.type === "variable").length;
	return { segments, fixedChars, variableCount };
}

/**
 * Check if a line matches an existing pattern.
 * The fixed segments must appear at the same positions.
 */
export function matchesPattern(line: string, pattern: LinePattern): boolean {
	for (const seg of pattern.segments) {
		if (seg.type !== "fixed") continue;
		// Check that the fixed text appears at the expected position
		if (line.length < seg.start + seg.length) return false;
		if (line.slice(seg.start, seg.start + seg.length) !== seg.text) return false;
	}
	return true;
}

/**
 * Format a pattern for display.
 * Shows fixed parts with `*` for variable gaps.
 */
export function formatPattern(pattern: LinePattern): string {
	return (
		pattern.segments
			.map((s) => {
				if (s.type === "variable") return "*";
				// Skip very short fixed segments between variables (likely partial matches)
				if (s.length < MIN_SEGMENT_DISPLAY) return "*";
				return s.text;
			})
			.join("")
			// Collapse consecutive * markers
			.replace(/\*{2,}/g, "*")
			.trim()
	);
}

/**
 * Merge two patterns: any position that is variable in either pattern
 * becomes variable in the result. Returns null if patterns are incompatible
 * (different fixed text at the same position).
 */
function mergePatterns(a: LinePattern, b: LinePattern): LinePattern | null {
	// Walk both patterns' segments and build merged result.
	// Since both are column-aligned, we can walk by character position.
	const aLen = a.segments.reduce((sum, s) => sum + s.length, 0);
	const bLen = b.segments.reduce((sum, s) => sum + s.length, 0);
	if (aLen === 0 || bLen === 0) return null;
	const maxLen = Math.max(aLen, bLen);

	// Build per-char arrays: fixed char or null (variable)
	const aChars = patternToChars(a, maxLen);
	const bChars = patternToChars(b, maxLen);

	// Merge: position is fixed only if both have the same fixed char
	const segments: Segment[] = [];
	let fixedChars = 0;
	let i = 0;
	while (i < maxLen) {
		if (aChars[i] !== null && bChars[i] !== null && aChars[i] === bChars[i]) {
			const start = i;
			let text = "";
			while (i < maxLen && aChars[i] !== null && bChars[i] !== null && aChars[i] === bChars[i]) {
				text += aChars[i];
				i++;
			}
			segments.push({ type: "fixed", text, start, length: text.length });
			fixedChars += text.length;
		} else {
			const start = i;
			while (i < maxLen && !(aChars[i] !== null && bChars[i] !== null && aChars[i] === bChars[i])) {
				i++;
			}
			segments.push({ type: "variable", text: "*", start, length: i - start });
		}
	}

	if (fixedChars < MIN_MATCH_CHARS && fixedChars / maxLen < MIN_MATCH_RATIO) return null;
	if (fixedChars / maxLen < MIN_MATCH_RATIO) return null;

	const variableCount = segments.filter((s) => s.type === "variable").length;
	return { segments, fixedChars, variableCount };
}

/** Expand a pattern into per-character array: char if fixed, null if variable. */
function patternToChars(p: LinePattern, length: number): (string | null)[] {
	const chars: (string | null)[] = new Array(length).fill(null);
	for (const seg of p.segments) {
		if (seg.type === "fixed") {
			for (let i = 0; i < seg.length && seg.start + i < length; i++) {
				chars[seg.start + i] = seg.text[i];
			}
		}
	}
	return chars;
}

// --- Dedup pass ---

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
 * Runs of 4+ lines following the same column-aligned pattern are collapsed to:
 *   [first line of run]
 *   [× N similar lines]
 *
 * @param lines Input lines
 * @param minRun Minimum run length to trigger dedup (default: 4)
 */
export function dedup(lines: string[], minRun = MIN_RUN_LENGTH): DedupResult {
	if (lines.length < minRun) return { lines: [...lines], dedupedLines: 0, groupCount: 0 };

	const result: string[] = [];
	let dedupedLines = 0;
	let groupCount = 0;

	let i = 0;
	while (i < lines.length) {
		// Try to start a run from this line
		const runStart = i;
		let pattern: LinePattern | null = null;

		// Look ahead: can we form a run?
		if (i + 1 < lines.length) {
			pattern = extractPattern(lines[i], lines[i + 1]);
		}

		if (!pattern) {
			// No pattern — emit line as-is
			result.push(lines[i]);
			i++;
			continue;
		}

		// Extend the run as far as it goes.
		// Compare each new line against the previous one (not the first),
		// and widen the pattern by merging variable positions.
		let runEnd = i + 2; // we know i and i+1 match
		while (runEnd < lines.length) {
			const pairPattern = extractPattern(lines[runEnd - 1], lines[runEnd]);
			if (!pairPattern) break;
			const merged = mergePatterns(pattern, pairPattern);
			if (!merged) break;
			pattern = merged;
			runEnd++;
		}

		const runLength = runEnd - runStart;

		if (runLength < minRun) {
			// Run too short — emit lines as-is
			for (let j = runStart; j < runEnd; j++) {
				result.push(lines[j]);
			}
			i = runEnd;
			continue;
		}

		// Emit first line + summary
		result.push(lines[runStart]);
		const collapsed = runLength - 1;
		const patternStr = formatPattern(pattern);
		result.push(`[× ${collapsed} similar: ${patternStr}]`);
		dedupedLines += collapsed;
		groupCount++;
		i = runEnd;
	}

	return { lines: result, dedupedLines, groupCount };
}
