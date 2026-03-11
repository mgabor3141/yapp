import { describe, expect, it } from "vitest";
import { sleepCommand } from "../src/sleep.js";

describe("sleepCommand", () => {
	it("returns systemctl suspend for linux", () => {
		expect(sleepCommand("linux")).toBe("systemctl suspend");
	});

	it("returns pmset sleepnow for darwin", () => {
		expect(sleepCommand("darwin")).toBe("pmset sleepnow");
	});

	it("returns empty string for unsupported platforms", () => {
		expect(sleepCommand("win32")).toBe("");
		expect(sleepCommand("freebsd")).toBe("");
	});
});
