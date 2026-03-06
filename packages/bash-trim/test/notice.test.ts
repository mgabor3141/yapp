import { describe, expect, it } from "vitest";
import { stripBuiltinNotice } from "../src/index.js";

describe("stripBuiltinNotice", () => {
	it("strips line-truncation notice", () => {
		const r = stripBuiltinNotice("output here\n\n[Showing lines 1901-2000 of 5000. Full output: /tmp/pi-bash-123.log]");
		expect(r.output).toBe("output here");
		expect(r.exitCodeLine).toBeNull();
		expect(r.fullOutputPath).toBe("/tmp/pi-bash-123.log");
	});

	it("strips byte-limit notice", () => {
		const r = stripBuiltinNotice("output\n\n[Showing lines 1-100 of 100 (50KB limit). Full output: /tmp/foo.log]");
		expect(r.output).toBe("output");
		expect(r.fullOutputPath).toBe("/tmp/foo.log");
	});

	it("strips last-line-partial notice", () => {
		const r = stripBuiltinNotice("partial\n\n[Showing last 50KB of line 1 (line is 2MB). Full output: /tmp/big.log]");
		expect(r.output).toBe("partial");
		expect(r.fullOutputPath).toBe("/tmp/big.log");
	});

	it("extracts exit code line", () => {
		const r = stripBuiltinNotice(
			"error output\n\n[Showing lines 1-50 of 50. Full output: /tmp/err.log]\n\nCommand exited with code 1",
		);
		expect(r.output).toBe("error output");
		expect(r.exitCodeLine).toBe("\n\nCommand exited with code 1");
		expect(r.fullOutputPath).toBe("/tmp/err.log");
	});

	it("handles plain output with no notices", () => {
		const r = stripBuiltinNotice("just some output\nwith lines");
		expect(r.output).toBe("just some output\nwith lines");
		expect(r.exitCodeLine).toBeNull();
		expect(r.fullOutputPath).toBeNull();
	});

	it("handles exit code without truncation notice", () => {
		const r = stripBuiltinNotice("error\n\nCommand exited with code 127");
		expect(r.output).toBe("error");
		expect(r.exitCodeLine).toBe("\n\nCommand exited with code 127");
		expect(r.fullOutputPath).toBeNull();
	});
});
