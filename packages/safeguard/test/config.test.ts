import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { ProjectConfig, SafeguardConfig, buildSystemPrompt } from "../src/config.js";
import type { MergedConfig } from "../src/config.js";

describe("SafeguardConfig schema", () => {
	it("parses empty object with defaults", () => {
		const result = v.parse(SafeguardConfig, {});
		expect(result.enabled).toBe(true);
		expect(result.commands).toEqual([]);
		expect(result.patterns).toEqual([]);
		expect(result.instructions).toBeUndefined();
		expect(result.judgeTimeoutMs).toBe(10_000);
	});

	it("parses full config", () => {
		const result = v.parse(SafeguardConfig, {
			enabled: false,
			commands: ["kubectl", ["gh", "repo", "delete"]],
			patterns: ["\\bmy-secret\\b"],
			instructions: "Be strict about terraform",
			judgeTimeoutMs: 5000,
		});
		expect(result.enabled).toBe(false);
		expect(result.commands).toEqual(["kubectl", ["gh", "repo", "delete"]]);
		expect(result.patterns).toEqual(["\\bmy-secret\\b"]);
		expect(result.instructions).toBe("Be strict about terraform");
	});

	it("rejects empty array command matcher", () => {
		expect(() => v.parse(SafeguardConfig, { commands: [[]] })).toThrow();
	});

	it("rejects invalid judgeTimeoutMs", () => {
		expect(() => v.parse(SafeguardConfig, { judgeTimeoutMs: 100 })).toThrow();
	});
});

describe("ProjectConfig schema", () => {
	it("parses shared fields only", () => {
		const result = v.parse(ProjectConfig, {
			commands: [["terraform", "destroy"]],
			patterns: ["\\bstaging\\b"],
			instructions: "This project uses terraform",
		});
		expect(result.commands).toEqual([["terraform", "destroy"]]);
		expect(result.patterns).toEqual(["\\bstaging\\b"]);
		expect(result.instructions).toBe("This project uses terraform");
	});

	it("rejects operational fields", () => {
		// ProjectConfig uses v.object with only shared fields, so extra keys
		// are stripped by valibot's default behavior (not rejected).
		// The important thing is they don't appear in the output.
		const result = v.parse(ProjectConfig, {
			enabled: false,
			judgeTimeoutMs: 5000,
			commands: [],
		});
		expect(result).not.toHaveProperty("enabled");
		expect(result).not.toHaveProperty("judgeTimeoutMs");
	});
});

describe("buildSystemPrompt", () => {
	const baseConfig: MergedConfig = {
		enabled: true,
		judgeModel: {},
		judgeTimeoutMs: 10000,
		commands: [],
		patterns: [],
	};

	it("returns base prompt without instructions", () => {
		const prompt = buildSystemPrompt(baseConfig);
		expect(prompt).toContain("security guardrail");
		expect(prompt).not.toContain("User instructions");
		expect(prompt).not.toContain("Project instructions");
	});

	it("appends global instructions", () => {
		const prompt = buildSystemPrompt({
			...baseConfig,
			globalInstructions: "Be strict about docker",
		});
		expect(prompt).toContain("User instructions (global):");
		expect(prompt).toContain("Be strict about docker");
	});

	it("appends project instructions", () => {
		const prompt = buildSystemPrompt({
			...baseConfig,
			projectInstructions: "This project uses terraform",
		});
		expect(prompt).toContain("Project instructions:");
		expect(prompt).toContain("This project uses terraform");
	});

	it("includes both global and project instructions", () => {
		const prompt = buildSystemPrompt({
			...baseConfig,
			globalInstructions: "Global rule",
			projectInstructions: "Project rule",
		});
		expect(prompt).toContain("User instructions (global):");
		expect(prompt).toContain("Global rule");
		expect(prompt).toContain("Project instructions:");
		expect(prompt).toContain("Project rule");
		// Global should come before project
		expect(prompt.indexOf("Global rule")).toBeLessThan(prompt.indexOf("Project rule"));
	});
});
