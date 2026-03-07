/**
 * Load the real model list from the installed @mariozechner/pi-ai package.
 *
 * The models.generated.js file isn't in the package's exports map, so we
 * resolve the package location via the PnP API at runtime.
 */

import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Model } from "@mariozechner/pi-ai";

interface RawModel {
	id: string;
	provider: string;
	cost: { input: number; output: number };
}

function findModelsFile(): string {
	const pnp = require("pnpapi");
	const resolved = pnp.resolveToUnqualified("@mariozechner/pi-ai/package.json", __filename);
	return join(dirname(resolved), "dist", "models.generated.js");
}

let cached: Model<Api>[] | null = null;

/**
 * Load all models from the installed pi-ai package, cast to Model<Api>[].
 * Only id, provider, and cost fields are populated — sufficient for budget-model tests.
 */
export async function loadModels(): Promise<Model<Api>[]> {
	if (cached) return cached;

	const modelsFile = findModelsFile();
	const { MODELS } = await import(pathToFileURL(modelsFile).href);

	const flat: Model<Api>[] = [];
	for (const models of Object.values(MODELS) as Record<string, RawModel>[]) {
		for (const m of Object.values(models)) {
			flat.push({
				id: m.id,
				provider: m.provider,
				cost: m.cost,
			} as unknown as Model<Api>);
		}
	}

	cached = flat;
	return flat;
}

/** Filter models to a single provider. */
export function modelsForProvider(models: Model<Api>[], provider: string): Model<Api>[] {
	return models.filter((m) => String(m.provider) === provider);
}
