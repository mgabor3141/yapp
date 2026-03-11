import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadCounter, saveCounter, stateFilePath, todayStr } from "../src/counter.js";

describe("todayStr", () => {
	it("formats as YYYY-MM-DD", () => {
		const result = todayStr(new Date(2026, 2, 11)); // March 11, 2026
		expect(result).toBe("2026-03-11");
	});

	it("pads single-digit months and days", () => {
		const result = todayStr(new Date(2026, 0, 5)); // Jan 5, 2026
		expect(result).toBe("2026-01-05");
	});
});

describe("counter persistence", () => {
	const testDate = "2099-01-01";
	const testPath = stateFilePath(testDate);

	afterEach(() => {
		try {
			unlinkSync(testPath);
		} catch {}
	});

	it("returns fresh counter when no file exists", () => {
		const counter = loadCounter(testDate);
		expect(counter).toEqual({ date: testDate, messagesUsed: 0 });
	});

	it("round-trips through save and load", () => {
		const state = { date: testDate, messagesUsed: 3 };
		saveCounter(state);
		expect(existsSync(testPath)).toBe(true);

		const loaded = loadCounter(testDate);
		expect(loaded).toEqual(state);
	});

	it("returns fresh counter when file has wrong date", () => {
		writeFileSync(testPath, JSON.stringify({ date: "2098-12-31", messagesUsed: 5 }));
		const counter = loadCounter(testDate);
		expect(counter).toEqual({ date: testDate, messagesUsed: 0 });
	});

	it("returns fresh counter when file is corrupt", () => {
		writeFileSync(testPath, "not json");
		const counter = loadCounter(testDate);
		expect(counter).toEqual({ date: testDate, messagesUsed: 0 });
	});
});
