import type { JjInfo, ThemeFg, WcStats } from "./types.js";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible (non-ANSI) character count. */
export function visibleLen(s: string): number {
	return s.replace(ANSI_RE, "").length;
}

/** Truncate an ANSI-colored string to maxWidth visible characters. */
export function truncate(s: string, maxWidth: number): string {
	let visible = 0;
	let i = 0;
	while (i < s.length && visible < maxWidth) {
		if (s[i] === "\x1b") {
			const end = s.indexOf("m", i);
			i = end === -1 ? s.length : end + 1;
		} else {
			visible++;
			i++;
		}
	}
	return `${s.slice(0, i)}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Colorization
// ---------------------------------------------------------------------------

/** Colorize a stat file line: green for +, red for - in the bar portion. */
export function colorizeFileLine(line: string, theme: ThemeFg): string {
	// Split on the last | to isolate the bar portion (avoids coloring hyphens in filenames)
	const pipeIdx = line.lastIndexOf("|");
	if (pipeIdx === -1) return line;
	const prefix = line.slice(0, pipeIdx + 1);
	const bar = line.slice(pipeIdx + 1);
	const coloredBar = bar
		.replace(/([+]+)/g, (m) => theme.fg("toolDiffAdded", m))
		.replace(/([-]+)/g, (m) => theme.fg("toolDiffRemoved", m));
	return prefix + coloredBar;
}

/** Format and colorize the summary line into a compact form: "2 files (+49, -11)" */
export function formatSummaryLine(line: string, theme: ThemeFg): string {
	const match = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
	if (!match) return line;

	const files = match[1];
	const ins = match[2] ? Number.parseInt(match[2], 10) : 0;
	const del = match[3] ? Number.parseInt(match[3], 10) : 0;

	const parts: string[] = [];
	if (ins > 0) parts.push(theme.fg("toolDiffAdded", `+${ins}`));
	if (del > 0) parts.push(theme.fg("toolDiffRemoved", `-${del}`));

	const counts = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	return `${files} file${files === "1" ? "" : "s"}${counts}`;
}

// ---------------------------------------------------------------------------
// Widget line builder
// ---------------------------------------------------------------------------

const MAX_FILE_LINES = 8;

export function buildWidgetLines(wc: WcStats, theme: ThemeFg): string[] {
	const lines: string[] = [];

	if (wc.fileLines.length <= MAX_FILE_LINES) {
		for (const fl of wc.fileLines) lines.push(colorizeFileLine(fl, theme));
	} else {
		for (const fl of wc.fileLines.slice(0, MAX_FILE_LINES - 1)) lines.push(colorizeFileLine(fl, theme));
		const hidden = wc.fileLines.length - (MAX_FILE_LINES - 1);
		lines.push(theme.fg("muted", `  ... and ${hidden} more file${hidden === 1 ? "" : "s"}`));
	}

	lines.push(formatSummaryLine(wc.summaryLine, theme));
	return lines;
}

// ---------------------------------------------------------------------------
// Widget one-liner (empty working copy)
// ---------------------------------------------------------------------------

/** Format a compact one-liner for the widget when @ is empty: "@- description · 2 files (+49, -11)" */
export function formatParentOneLiner(description: string, summaryLine: string, theme: ThemeFg): string {
	const match = summaryLine.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);

	let stats = "";
	if (match) {
		const files = match[1];
		const ins = match[2] ? Number.parseInt(match[2], 10) : 0;
		const del = match[3] ? Number.parseInt(match[3], 10) : 0;
		const parts: string[] = [];
		if (ins > 0) parts.push(theme.fg("toolDiffAdded", `+${ins}`));
		if (del > 0) parts.push(theme.fg("toolDiffRemoved", `-${del}`));
		const counts = parts.length > 0 ? ` (${parts.join(", ")})` : "";
		stats = `${files} file${files === "1" ? "" : "s"}${counts}`;
	}

	const prefix = theme.fg("accent", "@-");
	const sep = stats ? theme.fg("muted", " · ") : "";
	return `${prefix} ${description}${sep}${stats}`;
}

// ---------------------------------------------------------------------------
// Footer label
// ---------------------------------------------------------------------------

export function labelFor(info: JjInfo): string {
	if (info.bookmarks.length > 0) return info.bookmarks[0];
	if (info.description) return info.description;
	return info.changeShort;
}
