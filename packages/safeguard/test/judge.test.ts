import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/judge.js";

describe("parseVerdict", () => {
	it("parses approve", () => {
		const v = parseVerdict('{"verdict":"approve","reason":"safe","guidance":""}');
		expect(v.verdict).toBe("approve");
		expect(v.reason).toBe("safe");
	});

	it("parses deny", () => {
		const v = parseVerdict('{"verdict":"deny","reason":"dangerous","guidance":"try something else"}');
		expect(v.verdict).toBe("deny");
		expect(v.guidance).toBe("try something else");
	});

	it("parses ask", () => {
		const v = parseVerdict('{"verdict":"ask","reason":"not sure","guidance":"ask user"}');
		expect(v.verdict).toBe("ask");
	});

	it("extracts JSON from surrounding text", () => {
		const v = parseVerdict('Here is my response: {"verdict":"approve","reason":"ok","guidance":""} done.');
		expect(v.verdict).toBe("approve");
	});

	it("throws on missing JSON", () => {
		expect(() => parseVerdict("no json here")).toThrow("no JSON object found");
	});

	it("throws on invalid verdict", () => {
		expect(() => parseVerdict('{"verdict":"maybe","reason":"idk","guidance":""}')).toThrow('invalid verdict "maybe"');
	});

	it("defaults missing fields to empty string", () => {
		const v = parseVerdict('{"verdict":"approve"}');
		expect(v.reason).toBe("");
		expect(v.guidance).toBe("");
	});
});
