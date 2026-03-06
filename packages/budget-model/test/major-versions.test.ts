import type { Api, Model } from "@mariozechner/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { extractMajorVersion, findCheapestInMajorVersions } from "../src/index.js";
import { loadModels, modelsForProvider } from "./load-models.js";

let allModels: Model<Api>[];

beforeAll(async () => {
	allModels = await loadModels();
});

describe("findCheapestInMajorVersions", () => {
	describe("anthropic", () => {
		it("majorVersions: 1 picks from latest gen only", () => {
			const anthropic = modelsForProvider(allModels, "anthropic");
			const result = findCheapestInMajorVersions(anthropic, 1);

			// All results should be the same (latest) generation
			const gens = new Set(result.map((m) => extractMajorVersion(m.id)));
			expect(gens.size).toBe(1);

			// Cheapest current-gen anthropic model is haiku at $1
			expect(result[0].id).toMatch(/claude-haiku-4/);
			expect(result[0].cost.input).toBe(1);
		});

		it("majorVersions: 2 includes previous gen — cheaper haiku at $0.25", () => {
			const anthropic = modelsForProvider(allModels, "anthropic");
			const result = findCheapestInMajorVersions(anthropic, 2);
			const gens = new Set(result.map((m) => extractMajorVersion(m.id)));
			expect(gens.size).toBe(2);

			// Gen 3 haiku at $0.25 is cheaper than gen 4 haiku at $1
			expect(result[0].id).toBe("claude-3-haiku-20240307");
			expect(result[0].cost.input).toBe(0.25);
		});

		it("majorVersions: 0 includes all major versions", () => {
			const anthropic = modelsForProvider(allModels, "anthropic");
			const all = findCheapestInMajorVersions(anthropic, 0);
			const gens = new Set(all.map((m) => extractMajorVersion(m.id)));
			expect(gens.size).toBeGreaterThanOrEqual(2);
			expect(all[0].cost.input).toBe(0.25);
		});
	});

	describe("openai", () => {
		it("majorVersions: 1 picks from gen 5 — nano at $0.05", () => {
			const openai = modelsForProvider(allModels, "openai");
			const result = findCheapestInMajorVersions(openai, 1);

			expect(result[0].id).toBe("gpt-5-nano");
			expect(result[0].cost.input).toBe(0.05);
		});

		it("majorVersions: 2 adds gen 4 models but nano is still cheapest", () => {
			const openai = modelsForProvider(allModels, "openai");
			const result = findCheapestInMajorVersions(openai, 2);
			const gens = new Set(result.map((m) => extractMajorVersion(m.id)));
			expect(gens).toContain(4);
			expect(gens).toContain(5);

			// gpt-5-nano still wins
			expect(result[0].id).toBe("gpt-5-nano");
			// gpt-4o-mini ($0.15) is in the list
			expect(result.some((m) => m.id === "gpt-4o-mini")).toBe(true);
		});

		it("o-series models belong to their version generation", () => {
			const openai = modelsForProvider(allModels, "openai");
			const result = findCheapestInMajorVersions(openai, 2);
			const ids = result.map((m) => m.id);
			// o4-mini is gen 4 — included in top 2 gens (4+5)
			expect(ids).toContain("o4-mini");
			// o1 is gen 1 — not in top 2
			expect(ids).not.toContain("o1");
		});
	});

	describe("google", () => {
		it("majorVersions: 1 finds free model in latest gen", () => {
			const google = modelsForProvider(allModels, "google");
			const result = findCheapestInMajorVersions(google, 1);

			// gemini-3.1-flash-lite-preview is $0
			expect(result[0].cost.input).toBe(0);
			expect(result[0].id).toMatch(/gemini-3/);
		});

		it("majorVersions: 2 adds gen 2 models", () => {
			const google = modelsForProvider(allModels, "google");
			const result = findCheapestInMajorVersions(google, 2);
			const gens = new Set(result.map((m) => extractMajorVersion(m.id)));
			expect(gens).toContain(2);
			expect(gens).toContain(3);
		});
	});

	describe("xai", () => {
		it("majorVersions: 1 picks grok-4 fast variants at $0.2", () => {
			const xai = modelsForProvider(allModels, "xai");
			const result = findCheapestInMajorVersions(xai, 1);
			expect(result[0].cost.input).toBe(0.2);
			expect(extractMajorVersion(result[0].id)).toBe(4);
		});

		it("majorVersions: 2 adds gen 3 — grok-3-mini at $0.3 is more expensive", () => {
			const xai = modelsForProvider(allModels, "xai");
			const result = findCheapestInMajorVersions(xai, 2);
			// grok-4-fast at $0.2 still cheapest
			expect(result[0].cost.input).toBe(0.2);
			// grok-3-mini present
			expect(result.some((m) => m.id === "grok-3-mini")).toBe(true);
		});
	});

	describe("sorting and tiebreaking", () => {
		it("results are sorted by cost ascending", () => {
			const anthropic = modelsForProvider(allModels, "anthropic");
			const result = findCheapestInMajorVersions(anthropic, 2);
			for (let i = 1; i < result.length; i++) {
				expect(result[i].cost.input).toBeGreaterThanOrEqual(result[i - 1].cost.input);
			}
		});

		it("prefers alias over dated variant at same cost", () => {
			const anthropic = modelsForProvider(allModels, "anthropic");
			const result = findCheapestInMajorVersions(anthropic, 1);
			const haikuModels = result.filter((m) => m.cost.input === 1);
			const aliasIdx = haikuModels.findIndex((m) => m.id === "claude-haiku-4-5");
			const datedIdx = haikuModels.findIndex((m) => m.id === "claude-haiku-4-5-20251001");
			if (aliasIdx >= 0 && datedIdx >= 0) {
				expect(aliasIdx).toBeLessThan(datedIdx);
			}
		});
	});

	describe("edge cases", () => {
		it("returns empty for no versioned models", () => {
			const unversioned = [
				{ id: "codex-mini-latest", provider: "openai", cost: { input: 1.5, output: 6 } },
			] as unknown as Model<Api>[];
			expect(findCheapestInMajorVersions(unversioned, 1)).toEqual([]);
		});

		it("returns empty for empty input", () => {
			expect(findCheapestInMajorVersions([], 1)).toEqual([]);
		});

		it("majorVersions larger than available returns same as majorVersions: 0", () => {
			const anthropic = modelsForProvider(allModels, "anthropic");
			const all = findCheapestInMajorVersions(anthropic, 0);
			const huge = findCheapestInMajorVersions(anthropic, 100);
			expect(huge.length).toBe(all.length);
		});
	});
});
