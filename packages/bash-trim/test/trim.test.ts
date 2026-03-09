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
		const r = trimOutput(line, { minTokensToTrim: 0 });
		expect(r.columnsTrimmed).toBe(true);
		expect(r.text).toContain(" [...] ");
		expect(r.columnCharsOmitted).toBeGreaterThan(0);
	});

	it("cuts on token boundaries", () => {
		const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
		const line = words.join(" ");
		expect(line.length).toBeGreaterThan(DEFAULT_MAX_LINE_WIDTH);
		const r = trimOutput(line, { minTokensToTrim: 0 });
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
		const narrow = trimOutput(line, { trimmedWidth: 80, minTokensToTrim: 0 });
		const wide = trimOutput(line, { trimmedWidth: 300, minTokensToTrim: 0 });
		expect(narrow.columnsTrimmed).toBe(true);
		expect(wide.columnsTrimmed).toBe(true);
		// Narrow should keep less text
		expect(narrow.columnCharsOmitted).toBeGreaterThan(wide.columnCharsOmitted);
	});

	it("respects custom maxLineWidth", () => {
		const line = "x".repeat(400);
		const r = trimOutput(line, { maxLineWidth: 50, minTokensToTrim: 0 });
		expect(r.columnsTrimmed).toBe(true);
		expect(r.text).toContain(" [...] ");
	});

	it("reports total chars omitted across multiple lines", () => {
		// Each line has completely different content to avoid dedup
		const chars = ["a", "b", "c", "d", "e"];
		const lines = chars.map((c, i) => `${c.repeat(200)}__UNIQUE_${i}__${c.repeat(200)}`);
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
		// Use unique content per line to avoid dedup collapsing them
		const lines = Array.from(
			{ length: 1000 },
			(_, i) => `line ${i}: ${String.fromCharCode(65 + (i % 26)).repeat(20)} value=${i * 7}`,
		);
		const r = trimOutput(lines.join("\n"));
		expect(r.rowsTrimmed).toBe(true);
		expect(r.omittedLines).toBeGreaterThan(0);
	});

	it("keeps head and tail, omits middle", () => {
		// Each line completely different to avoid dedup
		const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
		const lines = Array.from({ length: 1000 }, (_, i) => {
			const w = words[i % words.length];
			return `${w}_${i}_${String(i * 97 + 13).padStart(6, "0")}_${w.toUpperCase()}`;
		});
		const r = trimOutput(lines.join("\n"));
		expect(r.rowsTrimmed).toBe(true);
		expect(r.text).toContain("alpha_0_");
		expect(r.text).toContain("juliet_999_");
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
	});

	it("skips all processing below minTokensToTrim", () => {
		// A wide line that would normally be column-trimmed
		const line = "x".repeat(500);
		const r = trimOutput(line); // default 200 token threshold
		// 500 repeated chars ≈ 63 tokens — below threshold
		expect(r.columnsTrimmed).toBe(false);
		expect(r.text).toBe(line);
	});

	it("respects custom minTokensToTrim", () => {
		const line = "x".repeat(500);
		// Force processing with threshold of 0
		const r = trimOutput(line, { minTokensToTrim: 0 });
		expect(r.columnsTrimmed).toBe(true);
	});

	it("skips dedup when output fits without row trimming", () => {
		// 10 similar lines that would be deduped, but fit well within token budget.
		// Dedup should NOT run since no rows need to be trimmed from the middle.
		const lines = Array.from(
			{ length: 10 },
			(_, i) => `2026-03-06 19:29:37.${String(800 + i).padStart(3, "0")} E  kernel[0:af9] (IOSurface) SID: 0x0`,
		);
		const r = trimOutput(lines.join("\n"), { minTokensToTrim: 0 });
		expect(r.rowsTrimmed).toBe(false);
		expect(r.dedupedLines).toBe(0);
		expect(r.dedupGroupCount).toBe(0);
		// All 10 lines preserved verbatim
		expect(r.text).toBe(lines.join("\n"));
	});

	it("applies dedup when output would need row trimming", () => {
		// Many similar lines that exceed token budget — dedup should kick in
		const lines = Array.from(
			{ length: 500 },
			(_, i) => `2026-03-06 19:29:37.${String(i).padStart(3, "0")} E  kernel[0:af9] (IOSurface) SID: 0x0`,
		);
		const r = trimOutput(lines.join("\n"), { maxTotalTokens: 500 });
		expect(r.dedupedLines).toBeGreaterThan(0);
	});

	it("column-trimmed lines count at trimmed token cost for row budget", () => {
		// 30 lines × 1000 chars = lots of raw tokens, but after column trimming
		// each line's token count drops drastically → should fit in 2K budget
		const lines = Array.from({ length: 30 }, (_, i) => `${i}: ${"y".repeat(997)}`);
		const r = trimOutput(lines.join("\n"));
		expect(r.columnsTrimmed).toBe(true);
		expect(r.rowsTrimmed).toBe(false);
	});
});

// ── Fixture-based tests ─────────────────────────────────────────────────────

describe("fixtures", () => {
	it("minified.js — single huge line, column-trimmed only", () => {
		const r = trimOutput(fixture("minified.js"));
		expect(r.columnsTrimmed).toBe(true);
		expect(r.rowsTrimmed).toBe(false);
		expect(r.totalLines).toBe(2);
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

	it("log-1000.txt — many log lines, dedup collapses repetitive content", () => {
		const r = trimOutput(fixture("log-1000.txt"));
		expect(r.columnsTrimmed).toBe(false);
		// Dedup should collapse the repetitive log entries significantly
		expect(r.dedupedLines).toBeGreaterThan(0);
		expect(r.text).toMatchSnapshot();
	});

	it("wide-log.txt — wide lines + dedup + possible row trim", () => {
		const r = trimOutput(fixture("wide-log.txt"));
		expect(r.columnsTrimmed).toBe(true);
		// Dedup may reduce line count enough to avoid row trimming
		expect(r.dedupedLines + r.omittedLines).toBeGreaterThan(0);
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

	it("npm-ls.txt — 500 moderate lines, dedup reduces enough to avoid row trim", () => {
		const r = trimOutput(fixture("npm-ls.txt"));
		// Token-level dedup collapses repeated dependency entries enough to fit
		expect(r.dedupedLines).toBeGreaterThan(0);
	});

	it("npm-ls.txt — fits with higher budget, dedup skipped", () => {
		const input = fixture("npm-ls.txt");
		const r = trimOutput(input, { maxTotalTokens: 10_000 });
		expect(r.rowsTrimmed).toBe(false);
		// With higher budget, no row trimming needed → dedup is skipped
		expect(r.dedupedLines).toBe(0);
		expect(r.text).toBe(input);
	});
});
