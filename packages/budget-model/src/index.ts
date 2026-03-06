/**
 * pi-budget-model — auto-select the cheapest available model for background tasks.
 *
 * Single entry point: `findBudgetModel(ctx, options?)` with configurable strategy:
 * - `"same-provider"` (default) — cheapest in the active provider.
 *   On failure, includes the cheapest-overall candidate on the error.
 * - `"any-provider"` — cheapest across ALL providers with an API key.
 *
 * The `generations` option controls how many version generations to search:
 * - 1 (default) = latest generation only
 * - 2 = latest + previous generation (often dramatically cheaper)
 * - 0 = all generations
 *
 * Both strategies enforce a cost ratio check against the active model.
 * Options are validated at runtime with valibot.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as v from "valibot";

// --- Public types ---

export const ModelStrategy = v.picklist(["same-provider", "any-provider"]);
export type ModelStrategy = v.InferOutput<typeof ModelStrategy>;

export const BudgetModelOptions = v.object({
	/** Pin a specific model, bypassing auto-selection entirely. Format: "provider/model-id". */
	modelOverride: v.optional(v.pipe(v.string(), v.regex(/^[^/]+\/.+$/, 'must be "provider/model-id"'))),
	strategy: v.optional(ModelStrategy, "same-provider"),
	costRatio: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.5),
	/** How many generations to search. 1 = latest only, 2 = latest + previous, 0 = all. */
	generations: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 1),
});
export type BudgetModelOptions = v.InferOutput<typeof BudgetModelOptions>;

export interface BudgetModel {
	model: Model<Api>;
	apiKey: string;
}

/** A model candidate found during search — may not have passed all checks. */
export interface ModelCandidate {
	provider: string;
	modelId: string;
	costInput: number;
	costOutput: number;
	hasApiKey: boolean;
}

/**
 * Error thrown when no suitable budget model can be found.
 *
 * - `reason`: why the search failed
 * - `sameProvider`: best candidate from the active provider (only for "same-provider" strategy)
 * - `cheapestOverall`: cheapest model across all providers (only for "same-provider" strategy)
 *
 * Callers can catch this and use the candidates for custom fallback logic,
 * or let it propagate — pi surfaces the message to the user.
 */
export class NoBudgetModelError extends Error {
	readonly reason: string;
	readonly sameProvider: ModelCandidate | null;
	readonly cheapestOverall: ModelCandidate | null;

	constructor(
		reason: string,
		candidates: { sameProvider?: ModelCandidate | null; cheapestOverall?: ModelCandidate | null } = {},
	) {
		const lines = [
			"Tried to auto-detect a budget model for a background task, but couldn't find one.",
			`Reason: ${reason}`,
		];
		if (candidates.sameProvider) {
			const c = candidates.sameProvider;
			lines.push(
				`Best same-provider option: ${c.provider}/${c.modelId} ($${c.costInput}/$${c.costOutput} per M tokens)`,
			);
		}
		if (candidates.cheapestOverall?.hasApiKey) {
			const c = candidates.cheapestOverall;
			lines.push(`Cheapest with API key: ${c.provider}/${c.modelId} ($${c.costInput}/$${c.costOutput} per M tokens)`);
		}
		lines.push(
			"To fix: configure a model explicitly in the extension settings, or switch to a provider with cheaper models.",
		);

		super(lines.join("\n"));
		this.name = "NoBudgetModelError";
		this.reason = reason;
		this.sameProvider = candidates.sameProvider ?? null;
		this.cheapestOverall = candidates.cheapestOverall ?? null;
	}
}

// --- Public API ---

/**
 * Find the cheapest available model for background tasks.
 *
 * @param ctx - Extension context
 * @param options - Strategy, cost ratio, and generations (validated at runtime)
 * @throws NoBudgetModelError if no suitable model is found
 */
export async function findBudgetModel(ctx: ExtensionContext, options?: BudgetModelOptions): Promise<BudgetModel> {
	const opts = v.parse(BudgetModelOptions, options ?? {});

	// Explicit override — resolve directly, skip auto-selection
	if (opts.modelOverride) {
		return resolveModelOverride(ctx, opts.modelOverride);
	}

	const activeModel = ctx.model;
	if (!activeModel) {
		throw new NoBudgetModelError("no active model set");
	}

	if (opts.strategy === "any-provider") {
		return findAnyProvider(ctx, activeModel, opts.costRatio, opts.generations);
	}
	return findSameProvider(ctx, activeModel, opts.costRatio, opts.generations);
}

// --- Strategies ---

async function findSameProvider(
	ctx: ExtensionContext,
	activeModel: Model<Api>,
	costRatio: number,
	generations: number,
): Promise<BudgetModel> {
	const activeProvider = String(activeModel.provider);
	const allModels = ctx.modelRegistry.getAll();
	const providerModels = allModels.filter((m) => String(m.provider) === activeProvider);

	// Lazy: only compute cross-provider candidates when we need them for error context
	const lazyCheapestOverall = () => findCheapestCandidate(ctx, allModels, generations);

	if (providerModels.length === 0) {
		throw new NoBudgetModelError(`no models found for provider "${activeProvider}"`, {
			cheapestOverall: await lazyCheapestOverall(),
		});
	}

	const candidates = findCheapestInGenerations(providerModels, generations);

	if (candidates.length === 0) {
		throw new NoBudgetModelError(`no versioned models found for provider "${activeProvider}"`, {
			cheapestOverall: await lazyCheapestOverall(),
		});
	}

	// Cost ratio check
	const minCost = candidates[0].cost.input;
	if (minCost >= activeModel.cost.input * costRatio) {
		const sameProvider = await toCandidate(ctx, candidates[0], activeProvider);
		throw new NoBudgetModelError(
			`cheapest model in ${activeProvider} is $${minCost}/M input — not significantly cheaper than active model ($${activeModel.cost.input}/M input)`,
			{ sameProvider, cheapestOverall: await lazyCheapestOverall() },
		);
	}

	for (const candidate of candidates) {
		if (candidate.cost.input >= activeModel.cost.input * costRatio) break;
		const apiKey = await ctx.modelRegistry.getApiKey(candidate);
		if (apiKey) {
			return { model: candidate, apiKey };
		}
	}

	const sameProvider = await toCandidate(ctx, candidates[0], activeProvider);
	throw new NoBudgetModelError(`no API key available for cheapest models in provider "${activeProvider}"`, {
		sameProvider,
		cheapestOverall: await lazyCheapestOverall(),
	});
}

async function findAnyProvider(
	ctx: ExtensionContext,
	activeModel: Model<Api>,
	costRatio: number,
	generations: number,
): Promise<BudgetModel> {
	const allModels = ctx.modelRegistry.getAll();

	const byProvider = new Map<string, Model<Api>[]>();
	for (const m of allModels) {
		const p = String(m.provider);
		if (!byProvider.has(p)) byProvider.set(p, []);
		byProvider.get(p)!.push(m);
	}

	const allCandidates: Model<Api>[] = [];
	for (const [, models] of byProvider) {
		allCandidates.push(...findCheapestInGenerations(models, generations));
	}
	allCandidates.sort((a, b) => a.cost.input - b.cost.input);

	const cheapestCost = allCandidates[0]?.cost.input ?? Number.POSITIVE_INFINITY;
	if (cheapestCost >= activeModel.cost.input * costRatio) {
		throw new NoBudgetModelError(
			`cheapest model across all providers is $${cheapestCost}/M input — not significantly cheaper than active model ($${activeModel.cost.input}/M input)`,
		);
	}

	for (const model of allCandidates) {
		if (model.cost.input >= activeModel.cost.input * costRatio) break;
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (apiKey) {
			return { model, apiKey };
		}
	}

	throw new NoBudgetModelError("no budget models with API keys found across any provider");
}

// --- Model override ---

async function resolveModelOverride(ctx: ExtensionContext, override: string): Promise<BudgetModel> {
	const slashIndex = override.indexOf("/");
	const provider = override.slice(0, slashIndex);
	const modelId = override.slice(slashIndex + 1);

	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		throw new NoBudgetModelError(`model override "${override}" not found in registry`);
	}

	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new NoBudgetModelError(`no API key for model override "${override}"`);
	}

	return { model, apiKey };
}

// --- Shared internals ---

/**
 * Find the cheapest models across the top N generation groups, sorted by cost then version.
 *
 * @param models - All models to search (typically filtered to one provider)
 * @param generations - How many generations: 1 = latest only, 2 = latest + previous, 0 = all
 * @returns Cheapest models sorted by cost (ascending) then version (descending)
 */
export function findCheapestInGenerations(models: Model<Api>[], generations: number): Model<Api>[] {
	// Collect all unique major versions, sorted descending
	const majorVersions = new Set<number>();
	for (const m of models) {
		const ver = extractMajorVersion(m.id);
		if (ver !== null) majorVersions.add(ver);
	}
	const sorted = [...majorVersions].sort((a, b) => b - a);

	if (sorted.length === 0) return [];

	// Select which generations to include
	const included = generations === 0 ? sorted : sorted.slice(0, generations);
	const includedSet = new Set(included);

	// Filter models to included generations
	const eligible = models.filter((m) => {
		const ver = extractMajorVersion(m.id);
		return ver !== null && includedSet.has(ver);
	});

	// Sort by cost ascending, then version descending (for tiebreaking)
	eligible.sort((a, b) => {
		const costDiff = a.cost.input - b.cost.input;
		if (costDiff !== 0) return costDiff;
		return compareVersions(a, b);
	});

	return eligible;
}

/** Build a ModelCandidate from a Model (checks API key availability). */
async function toCandidate(ctx: ExtensionContext, model: Model<Api>, provider: string): Promise<ModelCandidate> {
	const apiKey = await ctx.modelRegistry.getApiKey(model);
	return {
		provider,
		modelId: model.id,
		costInput: model.cost.input,
		costOutput: model.cost.output,
		hasApiKey: !!apiKey,
	};
}

/** Find the single cheapest model across all providers (for error context). */
async function findCheapestCandidate(
	ctx: ExtensionContext,
	allModels: Model<Api>[],
	generations: number,
): Promise<ModelCandidate | null> {
	const byProvider = new Map<string, Model<Api>[]>();
	for (const m of allModels) {
		const p = String(m.provider);
		if (!byProvider.has(p)) byProvider.set(p, []);
		byProvider.get(p)!.push(m);
	}

	let best: { model: Model<Api>; provider: string } | null = null;
	for (const [provider, models] of byProvider) {
		const candidates = findCheapestInGenerations(models, generations);
		if (candidates[0] && (!best || candidates[0].cost.input < best.model.cost.input)) {
			best = { model: candidates[0], provider };
		}
	}

	if (!best) return null;
	return toCandidate(ctx, best.model, best.provider);
}

// --- Version extraction ---

/**
 * Extract the major version number from a model ID.
 * Finds the first digit sequence in any token, skipping date-like tokens (≥8 digits).
 */
export function extractMajorVersion(id: string): number | null {
	const tokens = id.replace(/[._\-:]/g, " ").split(/\s+/);
	for (const t of tokens) {
		if (/^\d+$/.test(t) && t.length >= 8) continue;
		const m = t.match(/(\d+)/);
		if (m) return Number.parseInt(m[1], 10);
	}
	return null;
}

/**
 * Extract version numbers from a model ID, skipping date-like tokens.
 */
export function extractVersionNumbers(id: string): number[] {
	const tokens = id.replace(/[._\-:]/g, " ").split(/\s+/);
	const nums: number[] = [];
	for (const t of tokens) {
		if (/^\d+$/.test(t) && t.length >= 8) continue;
		const m = t.match(/(\d+)/);
		if (m) nums.push(Number.parseInt(m[1], 10));
	}
	return nums;
}

/** Higher version numbers first, then prefer shorter vectors (aliases over dated snapshots). */
function compareVersions(a: Model<Api>, b: Model<Api>): number {
	const av = extractVersionNumbers(a.id);
	const bv = extractVersionNumbers(b.id);
	for (let i = 0; i < Math.max(av.length, bv.length); i++) {
		const diff = (bv[i] ?? 0) - (av[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return av.length - bv.length;
}
