/**
 * Auth-resolution tests for findBudgetModel.
 *
 * These exercise budget-model's handling of `getApiKeyAndHeaders`, the upstream
 * registry primitive whose contract is:
 *
 *   { ok: true, apiKey?: string, headers?: Record<string, string> }
 *   | { ok: false, error: string }
 *
 * Both `apiKey` and `headers` are optional on success, so the package must
 * forward whatever the registry returns and treat `ok: true` (not `apiKey`
 * truthiness) as the gate for "model is usable". Header-only providers
 * (e.g. AWS Bedrock with SDK auth) are the regression case this guards.
 *
 * The model list is loaded from the installed @mariozechner/pi-ai package
 * (per the repo's "live data, not fixtures" rule). The registry itself is
 * faked because we're testing the seam between budget-model and the registry,
 * not the registry's resolution logic.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { findBudgetModel } from "../src/index.js";
import { loadModels, modelsForProvider } from "./load-models.js";

type ResolvedRequestAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

interface FakeRegistry {
	getAll(): Model<Api>[];
	getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>;
	hasConfiguredAuth(model: Model<Api>): boolean;
	find(provider: string, modelId: string): Model<Api> | undefined;
}

function makeCtx(
	models: Model<Api>[],
	resolve: (model: Model<Api>) => ResolvedRequestAuth,
	activeModel: Model<Api> | undefined,
): ExtensionContext {
	const registry: FakeRegistry = {
		getAll: () => models,
		getApiKeyAndHeaders: async (model) => resolve(model),
		hasConfiguredAuth: (model) => {
			const r = resolve(model);
			return r.ok;
		},
		find: (provider, modelId) => models.find((m) => String(m.provider) === provider && m.id === modelId),
	};
	// Cast: we only exercise modelRegistry + model on this fake.
	return {
		modelRegistry: registry as unknown as ExtensionContext["modelRegistry"],
		model: activeModel,
	} as unknown as ExtensionContext;
}

/**
 * Pick a provider that has at least three models with a cost spread, so the
 * cost-ratio check can pass for a cheaper candidate. We deliberately don't
 * hardcode a provider name: the live model list moves over time.
 */
async function pickProviderAndActiveModel(): Promise<{ models: Model<Api>[]; active: Model<Api> }> {
	const all = await loadModels();
	const providers = new Set(all.map((m) => String(m.provider)));
	for (const p of providers) {
		const ms = modelsForProvider(all, p);
		if (ms.length < 2) continue;
		const sorted = [...ms].sort((a, b) => b.cost.input - a.cost.input);
		const expensive = sorted[0];
		const cheapest = sorted[sorted.length - 1];
		// Need a real spread so the default 0.5 cost ratio admits something.
		if (cheapest.cost.input > 0 && cheapest.cost.input < expensive.cost.input * 0.5) {
			return { models: all, active: expensive };
		}
	}
	throw new Error("no provider in live model list has a usable cost spread for these tests");
}

describe("findBudgetModel auth resolution", () => {
	it("forwards apiKey from the registry on BudgetModel.auth", async () => {
		const { models, active } = await pickProviderAndActiveModel();
		const ctx = makeCtx(models, () => ({ ok: true, apiKey: "sk-test" }), active);

		const result = await findBudgetModel(ctx);

		expect(result.auth.apiKey).toBe("sk-test");
		expect(result.auth.headers).toBeUndefined();
	});

	it("forwards headers from the registry, even when apiKey is absent", async () => {
		// Regression case: providers that authenticate via headers (Bedrock-style)
		// had auth.ok === true with apiKey undefined. The pre-fix wrapper rejected
		// them as "no key"; the fix must accept them.
		const { models, active } = await pickProviderAndActiveModel();
		const ctx = makeCtx(models, () => ({ ok: true, headers: { Authorization: "Bearer header-only" } }), active);

		const result = await findBudgetModel(ctx);

		expect(result.auth.apiKey).toBeUndefined();
		expect(result.auth.headers).toEqual({ Authorization: "Bearer header-only" });
	});

	it("forwards both apiKey and headers when the registry resolves both", async () => {
		const { models, active } = await pickProviderAndActiveModel();
		const ctx = makeCtx(models, () => ({ ok: true, apiKey: "sk-test", headers: { "X-Trace": "abc" } }), active);

		const result = await findBudgetModel(ctx);

		expect(result.auth).toEqual({ apiKey: "sk-test", headers: { "X-Trace": "abc" } });
	});

	it("treats ok:false as 'no auth' and surfaces NoBudgetModelError", async () => {
		const { models, active } = await pickProviderAndActiveModel();
		const ctx = makeCtx(models, () => ({ ok: false, error: "401" }), active);

		await expect(findBudgetModel(ctx)).rejects.toThrow(/no API key available/);
	});

	it("accepts ok:true with neither apiKey nor headers (SDK-resolved auth)", async () => {
		// Some providers (e.g. AWS Bedrock with SDK credentials) report ok:true
		// with both fields empty. The downstream provider in pi-ai handles auth
		// itself; budget-model must not gate on apiKey/headers truthiness.
		const { models, active } = await pickProviderAndActiveModel();
		const ctx = makeCtx(models, () => ({ ok: true }), active);

		const result = await findBudgetModel(ctx);

		expect(result.auth.apiKey).toBeUndefined();
		expect(result.auth.headers).toBeUndefined();
		expect(result.model).toBeDefined();
	});
});
