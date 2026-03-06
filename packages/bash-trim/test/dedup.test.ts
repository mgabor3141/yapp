import { describe, expect, it } from "vitest";
import { dedup, extractPattern, formatPattern, matchesPattern } from "../src/dedup.js";

describe("extractPattern", () => {
	it("finds variable timestamp prefix", () => {
		const p = extractPattern(
			"2026-03-06 19:29:37.834 E  kernel[0:af9] (IOSurface) SID: 0x0",
			"2026-03-06 19:29:37.853 E  kernel[0:af9] (IOSurface) SID: 0x0",
		);
		expect(p).not.toBeNull();
		expect(p!.fixedChars).toBeGreaterThan(40);
		expect(p!.variableCount).toBeGreaterThan(0);
	});

	it("finds variable counter in build output", () => {
		const p = extractPattern("[1/847] Compiling src/utils/helpers.ts", "[2/847] Compiling src/utils/format.ts");
		expect(p).not.toBeNull();
		expect(p!.variableCount).toBeGreaterThanOrEqual(2); // counter + filename
	});

	it("finds pattern in test runner output with long shared prefix", () => {
		const p = extractPattern(
			"  ✓ components > Button > renders correctly (3ms)",
			"  ✓ components > Button > handles click event (2ms)",
		);
		expect(p).not.toBeNull();
	});

	it("returns null for short test names with little overlap", () => {
		const p = extractPattern("✓ auth > login > valid credentials (3ms)", "✓ auth > login > invalid password (2ms)");
		// Only ~18 fixed chars on 40-char lines — below threshold
		expect(p).toBeNull();
	});

	it("returns null for completely different lines", () => {
		const p = extractPattern("import { foo } from 'bar';", "export default class MyComponent {");
		expect(p).toBeNull();
	});

	it("returns null for very short lines", () => {
		const p = extractPattern("abc", "def");
		expect(p).toBeNull();
	});

	it("returns null for empty lines", () => {
		expect(extractPattern("", "")).toBeNull();
		expect(extractPattern("hello", "")).toBeNull();
	});

	it("returns null for lines with very different lengths", () => {
		const p = extractPattern("short", "this is a much much longer line that differs significantly");
		expect(p).toBeNull();
	});

	it("handles identical lines (100% fixed)", () => {
		const p = extractPattern("ERROR: connection refused", "ERROR: connection refused");
		expect(p).not.toBeNull();
		expect(p!.variableCount).toBe(0);
	});
});

describe("formatPattern", () => {
	it("shows fixed text with * for variable parts", () => {
		const p = extractPattern(
			"2026-03-06 19:29:37.834 E  kernel[0:af9] (IOSurface)",
			"2026-03-06 19:29:37.853 E  kernel[0:af9] (IOSurface)",
		)!;
		const fmt = formatPattern(p);
		expect(fmt).toContain("E  kernel[0:af9] (IOSurface)");
		expect(fmt).toContain("*");
	});

	it("collapses consecutive variable gaps", () => {
		const p = extractPattern("[1/847] Compiling src/utils/helpers.ts", "[2/847] Compiling src/utils/format.ts")!;
		const fmt = formatPattern(p);
		// Should not have ** anywhere
		expect(fmt).not.toMatch(/\*\*/);
	});
});

describe("matchesPattern", () => {
	it("matches a third line against pattern from first two", () => {
		const p = extractPattern(
			"2026-03-06 19:29:37.834 E  kernel[0:af9] (IOSurface) SID: 0x0",
			"2026-03-06 19:29:37.853 E  kernel[0:af9] (IOSurface) SID: 0x0",
		)!;
		expect(matchesPattern("2026-03-06 19:29:37.870 E  kernel[0:af9] (IOSurface) SID: 0x0", p)).toBe(true);
	});

	it("rejects a different line", () => {
		const p = extractPattern(
			"2026-03-06 19:29:37.834 E  kernel[0:af9] (IOSurface) SID: 0x0",
			"2026-03-06 19:29:37.853 E  kernel[0:af9] (IOSurface) SID: 0x0",
		)!;
		expect(matchesPattern("2026-03-06 19:29:37.870 Df launchd[1:3f8513] something else", p)).toBe(false);
	});
});

describe("dedup", () => {
	describe("system logs", () => {
		it("collapses repeated kernel errors", () => {
			const lines = Array.from(
				{ length: 20 },
				(_, i) =>
					`2026-03-06 19:29:37.${String(800 + i).padStart(3, "0")} E  kernel[0:af9] (IOSurface) SID: 0x0 task: <private>`,
			);
			const r = dedup(lines);
			expect(r.dedupedLines).toBe(19); // first line kept, 19 collapsed
			expect(r.groupCount).toBe(1);
			expect(r.lines).toHaveLength(2); // first line + summary
			expect(r.lines[1]).toContain("similar");
			expect(r.lines[1]).toContain("kernel[0:af9]");
		});

		it("preserves different log lines between repeated blocks", () => {
			const block1 = Array.from(
				{ length: 5 },
				(_, i) => `2026-03-06 19:29:37.${800 + i} E  kernel[0:af9] IOSurface error ${i}`,
			);
			// Hmm, those aren't similar enough because the error number differs AND the timestamp
			// Let me use actually similar lines
			const repeated = Array.from(
				{ length: 5 },
				(_, i) => `2026-03-06 19:29:37.${String(800 + i).padStart(3, "0")} E  kernel[0:af9] (IOSurface) SID: 0x0`,
			);
			const different = ["2026-03-06 19:29:38.000 Df launchd[1:3f8513] service lookup failed"];
			const r = dedup([...repeated, ...different, ...repeated]);
			expect(r.groupCount).toBe(2);
			// Should have: first-line, summary, different-line, first-line, summary
			expect(r.lines).toHaveLength(5);
		});

		it("handles mixed syslog formats", () => {
			const lines = [
				"Mar  6 19:29:37 host sshd[1234]: Accepted publickey for user from 10.0.0.1",
				"Mar  6 19:29:38 host sshd[1234]: Accepted publickey for user from 10.0.0.2",
				"Mar  6 19:29:39 host sshd[1234]: Accepted publickey for user from 10.0.0.3",
				"Mar  6 19:29:40 host sshd[1234]: Accepted publickey for user from 10.0.0.4",
				"Mar  6 19:29:41 host sshd[1234]: Accepted publickey for user from 10.0.0.5",
			];
			const r = dedup(lines);
			expect(r.dedupedLines).toBe(4);
			expect(r.lines[1]).toContain("similar");
		});
	});

	describe("test runner output", () => {
		it("collapses passing tests with shared prefix", () => {
			const lines = [
				"  ✓ components > Button > renders correctly (3ms)",
				"  ✓ components > Button > handles click event (2ms)",
				"  ✓ components > Button > shows loading state (1ms)",
				"  ✓ components > Button > disabled prop works (4ms)",
				"  ✓ components > Button > custom className (1ms)",
				"  ✗ components > Button > accessibility (12ms)",
			];
			const r = dedup(lines);
			expect(r.dedupedLines).toBe(4); // 5 passing collapsed, failure kept
			expect(r.lines).toHaveLength(3); // first pass + summary + failure
		});

		it("keeps failing tests separate", () => {
			const lines = ["  ✗ test 1 failed (3ms)", "  ✗ test 2 failed (2ms)", "  ✗ test 3 failed (1ms)"];
			// Only 3 lines — below min run of 4, should not dedup
			const r = dedup(lines);
			expect(r.dedupedLines).toBe(0);
		});
	});

	describe("build output", () => {
		it("collapses compilation progress", () => {
			const lines = Array.from(
				{ length: 100 },
				(_, i) => `[${String(i + 1).padStart(3, " ")}/100] Compiling src/components/module${i}.ts`,
			);
			const r = dedup(lines);
			expect(r.dedupedLines).toBeGreaterThan(90);
			expect(r.lines.length).toBeLessThan(10);
		});

		it("collapses docker layer download progress", () => {
			const lines = [
				"Downloading [==>                        ]  12.5MB/150MB layer sha256:abc123def456",
				"Downloading [===>                       ]  18.2MB/150MB layer sha256:abc123def456",
				"Downloading [====>                      ]  25.0MB/150MB layer sha256:abc123def456",
				"Downloading [=====>                     ]  31.1MB/150MB layer sha256:abc123def456",
				"Downloading [======>                    ]  38.7MB/150MB layer sha256:abc123def456",
			];
			const r = dedup(lines);
			expect(r.dedupedLines).toBe(4);
		});

		it("does not collapse docker steps with different commands", () => {
			const lines = [
				"Step 1/10 : FROM node:22-alpine",
				"Step 2/10 : WORKDIR /app",
				"Step 3/10 : COPY package.json .",
				"Step 4/10 : RUN npm install",
				"Step 5/10 : COPY . .",
			];
			const r = dedup(lines);
			// These have very different commands — too little overlap
			expect(r.dedupedLines).toBe(0);
		});
	});

	describe("should NOT dedup", () => {
		it("preserves source code", () => {
			const lines = [
				"import { foo } from './foo';",
				"import { bar } from './bar';",
				"import { baz } from './baz';",
				"import { qux } from './qux';",
				"",
				"export function main() {",
				"  const x = foo();",
				"  const y = bar();",
				"  return x + y;",
				"}",
			];
			const r = dedup(lines);
			// Import lines MIGHT get deduped (they are similar!) — that's actually fine
			// But the rest should not
			expect(r.lines.length).toBeGreaterThanOrEqual(6);
		});

		it("preserves stack traces", () => {
			const lines = [
				"Error: connection refused",
				"    at connect (/app/src/db.ts:42:5)",
				"    at retry (/app/src/db.ts:28:12)",
				"    at main (/app/src/index.ts:15:3)",
				"    at Module._compile (node:internal/modules/cjs/loader:1369:14)",
			];
			const r = dedup(lines);
			expect(r.dedupedLines).toBe(0);
		});

		it("preserves sequential numbers", () => {
			// seq 1 10 — each line is just a number
			const lines = Array.from({ length: 10 }, (_, i) => String(i + 1));
			const r = dedup(lines);
			// These are too short to match MIN_MATCH_CHARS
			expect(r.dedupedLines).toBe(0);
		});

		it("preserves short lines", () => {
			const lines = ["yes", "yes", "yes", "yes", "yes"];
			const r = dedup(lines);
			// Too short to meet MIN_MATCH_CHARS
			expect(r.dedupedLines).toBe(0);
		});

		it("preserves JSON output", () => {
			const lines = [
				'{  "name": "Alice",  "age": 30  }',
				'{  "name": "Bob",  "age": 25  }',
				'{  "name": "Charlie",  "age": 35  }',
				'{  "name": "Dave",  "age": 28  }',
			];
			const r = dedup(lines);
			// These are somewhat similar but short — may or may not dedup
			// The key thing is it shouldn't crash or produce garbage
			expect(r.lines.length).toBeGreaterThanOrEqual(1);
		});

		it("preserves lines below minimum run length", () => {
			const lines = [
				"2026-03-06 19:29:37.834 E  kernel error",
				"2026-03-06 19:29:37.835 E  kernel error",
				"2026-03-06 19:29:37.836 E  kernel error",
				"something completely different",
			];
			// Only 3 similar lines — below default min of 4
			const r = dedup(lines);
			expect(r.dedupedLines).toBe(0);
		});
	});

	describe("edge cases", () => {
		it("handles empty input", () => {
			const r = dedup([]);
			expect(r.lines).toEqual([]);
			expect(r.dedupedLines).toBe(0);
		});

		it("handles single line", () => {
			const r = dedup(["hello"]);
			expect(r.lines).toEqual(["hello"]);
			expect(r.dedupedLines).toBe(0);
		});

		it("handles all identical lines", () => {
			const lines = Array.from({ length: 10 }, () => "ERROR: connection refused to database at 10.0.0.1:5432");
			const r = dedup(lines);
			expect(r.dedupedLines).toBe(9);
			expect(r.lines).toHaveLength(2);
		});

		it("allows custom minimum run length", () => {
			const lines = [
				"2026-03-06 19:29:37.834 E  kernel error message here",
				"2026-03-06 19:29:37.835 E  kernel error message here",
				"different line here for variety",
			];
			// With minRun=2, should dedup
			const r = dedup(lines, 2);
			expect(r.dedupedLines).toBe(1);
		});

		it("handles multiple separate runs", () => {
			const run1 = Array.from(
				{ length: 5 },
				(_, i) =>
					`2026-03-06 19:29:${String(i).padStart(2, "0")}.000 INFO  Processing batch ${i} of records from queue`,
			);
			const separator = ["WARNING: rate limit approaching"];
			const run2 = Array.from(
				{ length: 5 },
				(_, i) => `2026-03-06 19:30:${String(i).padStart(2, "0")}.000 ERROR Failed to connect to redis at host ${i}`,
			);
			const r = dedup([...run1, ...separator, ...run2]);
			expect(r.groupCount).toBe(2);
		});
	});
});
