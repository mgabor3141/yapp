import { describe, expect, it } from "vitest";
import {
	buildWidgetLines,
	colorizeFileLine,
	formatParentOneLiner,
	formatSummaryLine,
	labelFor,
	truncate,
	visibleLen,
} from "../src/format.js";
import type { ThemeFg } from "../src/types.js";

// Minimal theme that wraps text in brackets for easy assertion
const theme: ThemeFg = {
	fg: (color, text) => `[${color}:${text}]`,
};

// ---------------------------------------------------------------------------
// visibleLen
// ---------------------------------------------------------------------------

describe("visibleLen", () => {
	it("returns length of plain text", () => {
		expect(visibleLen("hello")).toBe(5);
	});

	it("ignores ANSI escape sequences", () => {
		expect(visibleLen("\x1b[32mhello\x1b[0m")).toBe(5);
	});

	it("handles multiple ANSI sequences", () => {
		expect(visibleLen("\x1b[1m\x1b[32mhi\x1b[0m")).toBe(2);
	});

	it("returns 0 for empty string", () => {
		expect(visibleLen("")).toBe(0);
	});

	it("returns 0 for ANSI-only string", () => {
		expect(visibleLen("\x1b[0m")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
	it("truncates plain text to maxWidth", () => {
		expect(truncate("hello world", 5)).toBe("hello\x1b[0m");
	});

	it("preserves ANSI codes before the cut point", () => {
		const input = "\x1b[32mhello world\x1b[0m";
		const result = truncate(input, 5);
		expect(result).toBe("\x1b[32mhello\x1b[0m");
		expect(visibleLen(result)).toBe(5);
	});

	it("returns full string with reset if already within maxWidth", () => {
		expect(truncate("hi", 10)).toBe("hi\x1b[0m");
	});

	it("handles zero maxWidth", () => {
		expect(truncate("hello", 0)).toBe("\x1b[0m");
	});

	it("handles ANSI at the cut boundary", () => {
		// "ab" + color + "cd" truncated to 3 visible chars
		const input = "ab\x1b[31mcd";
		const result = truncate(input, 3);
		expect(visibleLen(result)).toBe(3);
		expect(result).toBe("ab\x1b[31mc\x1b[0m");
	});
});

// ---------------------------------------------------------------------------
// colorizeFileLine
// ---------------------------------------------------------------------------

describe("colorizeFileLine", () => {
	it("colorizes + and - in the bar portion", () => {
		const line = " src/index.ts | 12 +++---";
		const result = colorizeFileLine(line, theme);
		expect(result).toBe(" src/index.ts | 12 [toolDiffAdded:+++][toolDiffRemoved:---]");
	});

	it("does not colorize hyphens in filenames", () => {
		const line = " my-component.ts | 5 +++++";
		const result = colorizeFileLine(line, theme);
		// The hyphen in "my-component" should NOT be colored
		expect(result).toContain("my-component.ts |");
		expect(result).toContain("[toolDiffAdded:+++++]");
		expect(result).not.toContain("[toolDiffRemoved:-]");
	});

	it("returns line unchanged if no pipe found", () => {
		const line = "no pipe here";
		expect(colorizeFileLine(line, theme)).toBe("no pipe here");
	});

	it("handles deletion-only lines", () => {
		const line = " old-file.ts | 8 --------";
		const result = colorizeFileLine(line, theme);
		expect(result).toContain("old-file.ts |");
		expect(result).toContain("[toolDiffRemoved:--------]");
	});
});

// ---------------------------------------------------------------------------
// formatSummaryLine
// ---------------------------------------------------------------------------

describe("formatSummaryLine", () => {
	it("formats compact summary with both insertions and deletions", () => {
		const line = " 3 files changed, 44 insertions(+), 8 deletions(-)";
		expect(formatSummaryLine(line, theme)).toBe("3 files ([toolDiffAdded:+44], [toolDiffRemoved:-8])");
	});

	it("handles singular file", () => {
		const line = " 1 file changed, 1 insertion(+), 1 deletion(-)";
		expect(formatSummaryLine(line, theme)).toBe("1 file ([toolDiffAdded:+1], [toolDiffRemoved:-1])");
	});

	it("handles insertions only", () => {
		const line = " 1 file changed, 5 insertions(+)";
		expect(formatSummaryLine(line, theme)).toBe("1 file ([toolDiffAdded:+5])");
	});

	it("handles deletions only", () => {
		const line = " 1 file changed, 3 deletions(-)";
		expect(formatSummaryLine(line, theme)).toBe("1 file ([toolDiffRemoved:-3])");
	});

	it("returns line unchanged if pattern does not match", () => {
		expect(formatSummaryLine("something else", theme)).toBe("something else");
	});
});

// ---------------------------------------------------------------------------
// buildWidgetLines
// ---------------------------------------------------------------------------

describe("buildWidgetLines", () => {
	it("includes all file lines when under limit", () => {
		const wc = {
			fileLines: [" a.ts | 1 +", " b.ts | 2 ++"],
			summaryLine: " 2 files changed, 3 insertions(+)",
		};
		const lines = buildWidgetLines(wc, theme);
		// 2 file lines + 1 summary line
		expect(lines).toHaveLength(3);
	});

	it("truncates when more than 8 files and shows count", () => {
		const fileLines = Array.from({ length: 12 }, (_, i) => ` file${i}.ts | 1 +`);
		const wc = {
			fileLines,
			summaryLine: " 12 files changed, 12 insertions(+)",
		};
		const lines = buildWidgetLines(wc, theme);
		// 7 file lines + 1 "... and N more" + 1 summary = 9
		expect(lines).toHaveLength(9);
		expect(lines[7]).toContain("5 more files");
	});

	it("uses singular 'file' for exactly one hidden", () => {
		const fileLines = Array.from({ length: 9 }, (_, i) => ` file${i}.ts | 1 +`);
		const wc = {
			fileLines,
			summaryLine: " 9 files changed, 9 insertions(+)",
		};
		const lines = buildWidgetLines(wc, theme);
		// 7 shown + 1 overflow + 1 summary = 9, with "2 more files"
		expect(lines[7]).toContain("2 more files");
	});
});

// ---------------------------------------------------------------------------
// formatParentOneLiner
// ---------------------------------------------------------------------------

describe("formatParentOneLiner", () => {
	it("formats description with insertions and deletions", () => {
		const result = formatParentOneLiner("add login", " 2 files changed, 49 insertions(+), 11 deletions(-)", theme);
		expect(result).toBe("[accent:@-] add login[muted: \u00b7 ]2 files ([toolDiffAdded:+49], [toolDiffRemoved:-11])");
	});

	it("formats insertions only", () => {
		const result = formatParentOneLiner("new file", " 1 file changed, 5 insertions(+)", theme);
		expect(result).toBe("[accent:@-] new file[muted: \u00b7 ]1 file ([toolDiffAdded:+5])");
	});

	it("handles unrecognized summary line", () => {
		const result = formatParentOneLiner("something", "garbage", theme);
		expect(result).toBe("[accent:@-] something");
	});
});

// ---------------------------------------------------------------------------
// labelFor
// ---------------------------------------------------------------------------

describe("labelFor", () => {
	it("returns first bookmark when available", () => {
		expect(labelFor({ empty: false, description: "desc", bookmarks: ["main", "dev"], changeShort: "abc" })).toBe(
			"main",
		);
	});

	it("falls back to description when no bookmarks", () => {
		expect(labelFor({ empty: false, description: "add login", bookmarks: [], changeShort: "abc" })).toBe("add login");
	});

	it("falls back to changeShort when no bookmarks or description", () => {
		expect(labelFor({ empty: true, description: "", bookmarks: [], changeShort: "v" })).toBe("v");
	});
});
