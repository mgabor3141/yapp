import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_HEAD_RATIO,
	DEFAULT_MAX_LINE_WIDTH,
	DEFAULT_MAX_TOTAL_TOKENS,
	DEFAULT_TRIMMED_WIDTH,
	trimOutput,
	trimRows,
} from "../src/trim.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf-8");

// ── Column trimming ─────────────────────────────────────────────────────────

describe("column trimming", () => {
	it("passes through short lines unchanged", () => {
		const r = trimOutput("hello world");
		expect(r.columnsTrimmed).toBe(false);
		expect(r.text).toBe("hello world");
	});

	it("passes through lines at exactly MAX_LINE_WIDTH", () => {
		const line = "x".repeat(DEFAULT_MAX_LINE_WIDTH);
		const r = trimOutput(line);
		expect(r.columnsTrimmed).toBe(false);
		expect(r.text).toBe(line);
	});

	it("trims lines exceeding MAX_LINE_WIDTH", () => {
		const line = "x".repeat(500);
		const r = trimOutput(line);
		expect(r.columnsTrimmed).toBe(true);
		expect(r.text).toContain(" [...] ");
		expect(r.columnCharsOmitted).toBeGreaterThan(0);
	});

	it("cuts on token boundaries", () => {
		const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
		const line = words.join(" ");
		expect(line.length).toBeGreaterThan(DEFAULT_MAX_LINE_WIDTH);
		const r = trimOutput(line);
		expect(r.columnsTrimmed).toBe(true);
		const [head, tail] = r.text.split(" [...] ");
		expect(head).toMatch(/\w+$/);
		expect(tail).toMatch(/^\w+/);
	});

	it("keeps content proportional to headRatio", () => {
		const line = "abcdefgh ".repeat(100); // 900 chars
		const r = trimOutput(line);
		expect(r.columnsTrimmed).toBe(true);
		const [head, tail] = r.text.split(" [...] ");
		const expectedHead = Math.round(DEFAULT_TRIMMED_WIDTH * DEFAULT_HEAD_RATIO);
		const expectedTail = Math.round(DEFAULT_TRIMMED_WIDTH * (1 - DEFAULT_HEAD_RATIO));
		// Token boundaries make it approximate — allow ±50%
		expect(head.length).toBeGreaterThanOrEqual(expectedHead * 0.7);
		expect(head.length).toBeLessThanOrEqual(expectedHead * 1.5);
		expect(tail.length).toBeGreaterThanOrEqual(expectedTail * 0.5);
		expect(tail.length).toBeLessThanOrEqual(expectedTail * 2);
		// Head should be significantly longer than tail
		expect(head.length).toBeGreaterThan(tail.length);
	});

	it("respects custom headRatio", () => {
		const line = "abcdefgh ".repeat(100); // 900 chars
		// 50/50 split — head and tail should be roughly equal
		const r = trimOutput(line, { headRatio: 0.5 });
		expect(r.columnsTrimmed).toBe(true);
		const [head, tail] = r.text.split(" [...] ");
		expect(Math.abs(head.length - tail.length)).toBeLessThan(30);
	});

	it("respects custom trimmedWidth", () => {
		const line = "x".repeat(500);
		const narrow = trimOutput(line, { trimmedWidth: 80 });
		const wide = trimOutput(line, { trimmedWidth: 300 });
		expect(narrow.columnsTrimmed).toBe(true);
		expect(wide.columnsTrimmed).toBe(true);
		// Narrow should keep less text
		expect(narrow.columnCharsOmitted).toBeGreaterThan(wide.columnCharsOmitted);
	});

	it("respects custom maxLineWidth", () => {
		const line = "x".repeat(400);
		const r = trimOutput(line, { maxLineWidth: 50 });
		expect(r.columnsTrimmed).toBe(true);
		expect(r.text).toContain(" [...] ");
	});

	it("reports total chars omitted across multiple lines", () => {
		const lines = Array.from({ length: 5 }, () => "z".repeat(500));
		const r = trimOutput(lines.join("\n"));
		expect(r.columnLinesTrimmed).toBe(5);
		expect(r.columnCharsOmitted).toBeGreaterThan(0);
	});
});

// ── Row trimming ────────────────────────────────────────────────────────────

describe("row trimming", () => {
	it("does not trim output under token budget", () => {
		// 50 short lines — well under 2K tokens
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const r = trimOutput(lines.join("\n"));
		expect(r.rowsTrimmed).toBe(false);
	});

	it("trims when total tokens exceed budget", () => {
		const lines = Array.from(
			{ length: 1000 },
			(_, i) =>
				`2025-03-06T12:00:${String(i % 60).padStart(2, "0")}.000Z [INFO] Request ${i} processed in ${i % 100}ms`,
		);
		const r = trimOutput(lines.join("\n"));
		expect(r.rowsTrimmed).toBe(true);
		expect(r.omittedLines).toBeGreaterThan(0);
	});

	it("keeps head and tail, omits middle", () => {
		const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}: ${"x".repeat(50)}`);
		const r = trimOutput(lines.join("\n"));
		expect(r.rowsTrimmed).toBe(true);
		expect(r.text).toContain("line 0:");
		expect(r.text).toContain("line 999:");
		expect(r.text).toContain("[...");
		expect(r.text).toContain("lines omitted");
	});

	it("respects custom maxTotalTokens", () => {
		// 200 short lines — fits in default 2K but not in 500
		const lines = Array.from({ length: 200 }, (_, i) => `item ${i}: value`);
		const rDefault = trimOutput(lines.join("\n"));
		expect(rDefault.rowsTrimmed).toBe(false);

		const rSmall = trimOutput(lines.join("\n"), { maxTotalTokens: 500 });
		expect(rSmall.rowsTrimmed).toBe(true);
	});

	it("uses token budget, not character budget", () => {
		// 100 lines × 80 chars of code ≈ 8K chars but ~1.4K tokens — fits in 2K
		const lines = Array.from(
			{ length: 100 },
			(_, i) => `    const result${i} = await processItem(input${i}, options);`,
		);
		const totalTokens = lines.reduce((s, l) => s + encode(l).length, 0) + lines.length - 1;
		expect(totalTokens).toBeLessThan(DEFAULT_MAX_TOTAL_TOKENS);
		const r = trimOutput(lines.join("\n"));
		expect(r.rowsTrimmed).toBe(false);
	});
});

// ── Full pipeline ───────────────────────────────────────────────────────────

describe("trimOutput pipeline", () => {
	it("passes through small, narrow output unchanged", () => {
		const input = "line 1\nline 2\nline 3";
		const r = trimOutput(input);
		expect(r.columnsTrimmed).toBe(false);
		expect(r.rowsTrimmed).toBe(false);
		expect(r.text).toBe(input);
		expect(r.columnTrimmedFull).toBeNull();
	});

	it("column-trimmed lines count at trimmed token cost for row budget", () => {
		// 30 lines × 1000 chars = lots of raw tokens, but after column trimming
		// each line's token count drops drastically → should fit in 2K budget
		const lines = Array.from({ length: 30 }, (_, i) => `${i}: ${"y".repeat(997)}`);
		const r = trimOutput(lines.join("\n"));
		expect(r.columnsTrimmed).toBe(true);
		expect(r.rowsTrimmed).toBe(false);
	});

	it("produces columnTrimmedFull only when both trims happen", () => {
		// Column only
		const r1 = trimOutput("x".repeat(500));
		expect(r1.columnsTrimmed).toBe(true);
		expect(r1.rowsTrimmed).toBe(false);
		expect(r1.columnTrimmedFull).toBeNull();

		// Row only (many log lines)
		const logLines = Array.from({ length: 1000 }, (_, i) => `[INFO] Request ${i} processed in ${i % 100}ms`);
		const r2 = trimOutput(logLines.join("\n"));
		expect(r2.columnsTrimmed).toBe(false);
		expect(r2.rowsTrimmed).toBe(true);
		expect(r2.columnTrimmedFull).toBeNull();
	});
});

// ── Fixture-based tests ─────────────────────────────────────────────────────

describe("fixtures", () => {
	it("minified.js — single huge line, column-trimmed only", () => {
		const r = trimOutput(fixture("minified.js"));
		expect(r.columnsTrimmed).toBe(true);
		expect(r.rowsTrimmed).toBe(false);
		expect(r.totalLines).toBe(2);
		expect(r.columnTrimmedFull).toBeNull();
		expect(r.text).toMatchSnapshot();
	});

	it("source-300.ts — normal source file, row-trimmed at 2K default", () => {
		const r = trimOutput(fixture("source-300.ts"));
		// 315 lines, ~2477 tokens — just over 2K budget
		expect(r.columnsTrimmed).toBe(false);
		expect(r.rowsTrimmed).toBe(true);
	});

	it("source-300.ts — fits with higher budget", () => {
		const input = fixture("source-300.ts");
		const r = trimOutput(input, { maxTotalTokens: 4_000 });
		expect(r.rowsTrimmed).toBe(false);
		expect(r.text).toBe(input);
	});

	it("source-800.ts — large source file, row-trimmed at 2K default", () => {
		const r = trimOutput(fixture("source-800.ts"));
		expect(r.columnsTrimmed).toBe(false);
		expect(r.rowsTrimmed).toBe(true);
		expect(r.omittedLines).toBeGreaterThan(0);
	});

	it("source-800.ts — fits with higher budget", () => {
		const input = fixture("source-800.ts");
		const r = trimOutput(input, { maxTotalTokens: 10_000 });
		expect(r.rowsTrimmed).toBe(false);
		expect(r.text).toBe(input);
	});

	it("log-1000.txt — many log lines, row-trimmed", () => {
		const r = trimOutput(fixture("log-1000.txt"));
		expect(r.columnsTrimmed).toBe(false);
		expect(r.rowsTrimmed).toBe(true);
		expect(r.omittedLines).toBeGreaterThan(0);
		expect(r.columnTrimmedFull).toBeNull();
		expect(r.text).toMatchSnapshot();
	});

	it("wide-log.txt — wide lines + many rows, both trims", () => {
		const r = trimOutput(fixture("wide-log.txt"));
		expect(r.columnsTrimmed).toBe(true);
		expect(r.rowsTrimmed).toBe(true);
		expect(r.columnTrimmedFull).not.toBeNull();
		expect(r.text).toMatchSnapshot();
	});

	it("seq-2000.txt — 2000 very short lines, row-trimmed at 2K default", () => {
		const r = trimOutput(fixture("seq-2000.txt"));
		// 2000 lines × ~2.5 tokens = ~5000 tokens — over 2K budget
		expect(r.rowsTrimmed).toBe(true);
		expect(r.omittedLines).toBeGreaterThan(0);
	});

	it("seq-2000.txt — fits with higher budget", () => {
		const input = fixture("seq-2000.txt");
		const r = trimOutput(input, { maxTotalTokens: 10_000 });
		expect(r.rowsTrimmed).toBe(false);
		expect(r.text).toBe(input);
	});

	it("npm-ls.txt — 500 moderate lines, row-trimmed at 2K default", () => {
		const r = trimOutput(fixture("npm-ls.txt"));
		expect(r.rowsTrimmed).toBe(true);
		expect(r.omittedLines).toBeGreaterThan(0);
	});

	it("npm-ls.txt — fits with higher budget", () => {
		const input = fixture("npm-ls.txt");
		const r = trimOutput(input, { maxTotalTokens: 10_000 });
		expect(r.rowsTrimmed).toBe(false);
		expect(r.text).toBe(input);
	});
});
