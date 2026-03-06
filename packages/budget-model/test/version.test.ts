import { describe, expect, it } from "vitest";
import { extractMajorVersion, extractVersionNumbers } from "../src/index.js";

describe("extractMajorVersion", () => {
	it("extracts from claude-style IDs", () => {
		expect(extractMajorVersion("claude-sonnet-4-5")).toBe(4);
		expect(extractMajorVersion("claude-haiku-4-5")).toBe(4);
		expect(extractMajorVersion("claude-3-5-haiku-20241022")).toBe(3);
		expect(extractMajorVersion("claude-3-opus-20240229")).toBe(3);
	});

	it("extracts from gpt-style IDs", () => {
		expect(extractMajorVersion("gpt-5-nano")).toBe(5);
		expect(extractMajorVersion("gpt-4.1-mini")).toBe(4);
		expect(extractMajorVersion("gpt-4o-mini")).toBe(4);
	});

	it("extracts from o-series IDs", () => {
		expect(extractMajorVersion("o1")).toBe(1);
		expect(extractMajorVersion("o1-pro")).toBe(1);
		expect(extractMajorVersion("o3-mini")).toBe(3);
		expect(extractMajorVersion("o4-mini")).toBe(4);
	});

	it("extracts from gemini-style IDs", () => {
		expect(extractMajorVersion("gemini-2.5-flash")).toBe(2);
		expect(extractMajorVersion("gemini-3.1-flash-lite-preview")).toBe(3);
	});

	it("extracts from other providers", () => {
		expect(extractMajorVersion("grok-4-1-fast")).toBe(4);
		expect(extractMajorVersion("glm-5")).toBe(5);
		expect(extractMajorVersion("MiniMax-M2.5")).toBe(2);
	});

	it("returns null for unversioned IDs", () => {
		expect(extractMajorVersion("codex-mini-latest")).toBeNull();
	});

	it("skips date-like tokens", () => {
		expect(extractMajorVersion("claude-haiku-4-5-20251001")).toBe(4);
	});
});

describe("extractVersionNumbers", () => {
	it("extracts version vector", () => {
		expect(extractVersionNumbers("claude-haiku-4-5")).toEqual([4, 5]);
		expect(extractVersionNumbers("gpt-5.1-codex")).toEqual([5, 1]);
		expect(extractVersionNumbers("gemini-3.1-flash-lite-preview")).toEqual([3, 1]);
	});

	it("skips date-like tokens", () => {
		expect(extractVersionNumbers("claude-haiku-4-5-20251001")).toEqual([4, 5]);
		expect(extractVersionNumbers("claude-3-5-haiku-20241022")).toEqual([3, 5]);
	});

	it("handles o-series", () => {
		expect(extractVersionNumbers("o3-mini")).toEqual([3]);
		expect(extractVersionNumbers("o4-mini")).toEqual([4]);
	});
});

describe("BudgetModelOptions validation", () => {
	it("accepts valid modelOverride format", async () => {
		const { BudgetModelOptions } = await import("../src/index.js");
		const { parse } = await import("valibot");
		expect(() => parse(BudgetModelOptions, { modelOverride: "anthropic/claude-haiku-4-5" })).not.toThrow();
		expect(() => parse(BudgetModelOptions, { modelOverride: "openai/gpt-5-nano" })).not.toThrow();
	});

	it("rejects modelOverride without provider slash", async () => {
		const { BudgetModelOptions } = await import("../src/index.js");
		const { parse } = await import("valibot");
		expect(() => parse(BudgetModelOptions, { modelOverride: "claude-haiku-4-5" })).toThrow();
		expect(() => parse(BudgetModelOptions, { modelOverride: "" })).toThrow();
	});
});
