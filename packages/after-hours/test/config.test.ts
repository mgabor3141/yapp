import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { AfterHoursConfig, isInQuietHours, isPastWarningTime, toMinutes } from "../src/config.js";

describe("AfterHoursConfig schema", () => {
	it("parses empty object with defaults", () => {
		const result = v.parse(AfterHoursConfig, {});
		expect(result.enabled).toBe(true);
		expect(result.quietHoursStart).toBe("23:00");
		expect(result.quietHoursEnd).toBe("07:00");
		expect(result.messageLimit).toBe(3);
		expect(result.warningTime).toBe("23:30");
		expect(result.blockMessage).toContain("rest now");
		expect(result.autoSleep).toBe(true);
		expect(result.autoSleepDelay).toBe(30);
	});

	it("parses full config", () => {
		const result = v.parse(AfterHoursConfig, {
			enabled: false,
			quietHoursStart: "22:00",
			quietHoursEnd: "06:00",
			messageLimit: 5,
			warningTime: "22:30",
			blockMessage: "Go to sleep!",
			autoSleep: false,
			autoSleepDelay: 60,
		});
		expect(result.enabled).toBe(false);
		expect(result.quietHoursStart).toBe("22:00");
		expect(result.quietHoursEnd).toBe("06:00");
		expect(result.messageLimit).toBe(5);
		expect(result.warningTime).toBe("22:30");
		expect(result.blockMessage).toBe("Go to sleep!");
		expect(result.autoSleep).toBe(false);
		expect(result.autoSleepDelay).toBe(60);
	});

	it("rejects invalid time format", () => {
		expect(() => v.parse(AfterHoursConfig, { quietHoursStart: "9pm" })).toThrow();
		expect(() => v.parse(AfterHoursConfig, { quietHoursStart: "25:00" })).toThrow();
		expect(() => v.parse(AfterHoursConfig, { quietHoursStart: "9:00" })).toThrow();
		expect(() => v.parse(AfterHoursConfig, { quietHoursStart: "23:60" })).toThrow();
		expect(() => v.parse(AfterHoursConfig, { quietHoursStart: "99:99" })).toThrow();
	});

	it("accepts boundary time values", () => {
		expect(v.parse(AfterHoursConfig, { quietHoursStart: "00:00" }).quietHoursStart).toBe("00:00");
		expect(v.parse(AfterHoursConfig, { quietHoursStart: "23:59" }).quietHoursStart).toBe("23:59");
	});

	it("allows messageLimit of 0 (immediate block)", () => {
		const result = v.parse(AfterHoursConfig, { messageLimit: 0 });
		expect(result.messageLimit).toBe(0);
	});

	it("rejects negative messageLimit", () => {
		expect(() => v.parse(AfterHoursConfig, { messageLimit: -1 })).toThrow();
	});

	it("rejects non-integer messageLimit", () => {
		expect(() => v.parse(AfterHoursConfig, { messageLimit: 2.5 })).toThrow();
	});

	it("rejects autoSleepDelay below minimum", () => {
		expect(() => v.parse(AfterHoursConfig, { autoSleepDelay: 4 })).toThrow();
		expect(() => v.parse(AfterHoursConfig, { autoSleepDelay: 0 })).toThrow();
		expect(() => v.parse(AfterHoursConfig, { autoSleepDelay: -1 })).toThrow();
	});

	it("rejects autoSleepDelay above maximum", () => {
		expect(() => v.parse(AfterHoursConfig, { autoSleepDelay: 301 })).toThrow();
	});

	it("accepts autoSleepDelay at boundaries", () => {
		expect(v.parse(AfterHoursConfig, { autoSleepDelay: 5 }).autoSleepDelay).toBe(5);
		expect(v.parse(AfterHoursConfig, { autoSleepDelay: 300 }).autoSleepDelay).toBe(300);
	});

	it("rejects non-integer autoSleepDelay", () => {
		expect(() => v.parse(AfterHoursConfig, { autoSleepDelay: 10.5 })).toThrow();
	});

	it("allows partial config", () => {
		const result = v.parse(AfterHoursConfig, { messageLimit: 10 });
		expect(result.messageLimit).toBe(10);
		expect(result.quietHoursStart).toBe("23:00"); // default preserved
	});
});

describe("toMinutes", () => {
	it("converts HH:MM to minutes since midnight", () => {
		expect(toMinutes("00:00")).toBe(0);
		expect(toMinutes("23:00")).toBe(23 * 60);
		expect(toMinutes("07:30")).toBe(7 * 60 + 30);
		expect(toMinutes("12:00")).toBe(720);
	});
});

describe("isInQuietHours", () => {
	it("handles same-day range (e.g. 01:00–06:00)", () => {
		const start = toMinutes("01:00");
		const end = toMinutes("06:00");
		expect(isInQuietHours(toMinutes("00:30"), start, end)).toBe(false);
		expect(isInQuietHours(toMinutes("01:00"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("03:00"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("05:59"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("06:00"), start, end)).toBe(false);
		expect(isInQuietHours(toMinutes("23:00"), start, end)).toBe(false);
	});

	it("handles midnight-crossing range (e.g. 23:00–07:00)", () => {
		const start = toMinutes("23:00");
		const end = toMinutes("07:00");
		expect(isInQuietHours(toMinutes("22:59"), start, end)).toBe(false);
		expect(isInQuietHours(toMinutes("23:00"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("23:59"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("00:00"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("03:00"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("06:59"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("07:00"), start, end)).toBe(false);
		expect(isInQuietHours(toMinutes("12:00"), start, end)).toBe(false);
	});

	it("handles full-day range (e.g. 00:00–23:59)", () => {
		const start = toMinutes("00:00");
		const end = toMinutes("23:59");
		expect(isInQuietHours(toMinutes("00:00"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("12:00"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("23:58"), start, end)).toBe(true);
		expect(isInQuietHours(toMinutes("23:59"), start, end)).toBe(false); // end is exclusive
	});
});

describe("isPastWarningTime", () => {
	it("returns false when not in quiet hours", () => {
		expect(isPastWarningTime(toMinutes("12:00"), toMinutes("23:30"), toMinutes("07:00"), false)).toBe(false);
	});

	it("returns true when past warning in same-evening portion", () => {
		// 23:45, warning at 23:30, end at 07:00, in quiet hours
		expect(isPastWarningTime(toMinutes("23:45"), toMinutes("23:30"), toMinutes("07:00"), true)).toBe(true);
	});

	it("returns false when before warning in same-evening portion", () => {
		// 23:15, warning at 23:30, end at 07:00, in quiet hours
		expect(isPastWarningTime(toMinutes("23:15"), toMinutes("23:30"), toMinutes("07:00"), true)).toBe(false);
	});

	it("returns true in early morning (after midnight, warning was previous evening)", () => {
		// 02:00, warning at 23:30, end at 07:00, in quiet hours
		expect(isPastWarningTime(toMinutes("02:00"), toMinutes("23:30"), toMinutes("07:00"), true)).toBe(true);
	});

	it("handles warning same as start", () => {
		// Warning at 23:00, currently 23:00
		expect(isPastWarningTime(toMinutes("23:00"), toMinutes("23:00"), toMinutes("07:00"), true)).toBe(true);
	});
});
