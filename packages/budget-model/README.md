# pi-budget-model

> From [yapp](https://github.com/mgabor3141/yapp) · yet another pi pack

Auto-select the cheapest available model for background tasks — guardrails, summarization, tagging, and anything where cost matters more than peak capability.

## Install

```bash
npm install pi-budget-model
```

## Usage

```typescript
import { completeSimple } from "@mariozechner/pi-ai";
import { findBudgetModel, NoBudgetModelError } from "pi-budget-model";

// Simple — cheapest in same provider, latest major version
const { model, auth } = await findBudgetModel(ctx);

// `auth` is `{ apiKey?: string; headers?: Record<string, string> }`, ready to
// spread into pi-ai's stream/completeSimple options.
await completeSimple(model, ctx, { ...auth, signal });

// Cross-provider — cheapest across all providers with usable auth
const { model, auth } = await findBudgetModel(ctx, {
  strategy: "any-provider",
});

// Include previous major version (often much cheaper)
const { model, auth } = await findBudgetModel(ctx, {
  majorVersions: 2,    // latest + previous major version
  costRatio: 0.5,      // must be ≤ half the active model's cost
});

// Pin a specific model, skip auto-selection
const { model, auth } = await findBudgetModel(ctx, {
  modelOverride: "anthropic/claude-haiku-4-5",
});

// Pin a model AND supply credentials directly, bypassing the registry's auth
// resolution. Use as an escape hatch when the registry's auth pipeline
// misbehaves for your provider.
const { model, auth } = await findBudgetModel(ctx, {
  modelOverride: {
    model: "openai/gpt-4o-mini",
    auth: { apiKey: process.env.OPENAI_API_KEY },
  },
});

// Only free models
const { model, auth } = await findBudgetModel(ctx, {
  costRatio: 0,
});
```

## What gets picked

With default settings (`same-provider`, `costRatio: 0.5`, `majorVersions: 1`):

| Active model | Budget model picked | Why |
|---|---|---|
| `anthropic/claude-sonnet-4-5` ($3/M) | `claude-haiku-4-5` ($1/M) | Cheapest Anthropic model in latest major version (4) |
| `anthropic/claude-opus-4-5` ($5/M) | `claude-haiku-4-5` ($1/M) | Same |
| `anthropic/claude-haiku-4-5` ($1/M) | *(none — already cheapest)* | No cheaper model in major version 4 |
| `openai/gpt-5` ($1.25/M) | `gpt-5-nano` ($0.05/M) | 25× cheaper, same major version (5) |
| `openai/gpt-4o` ($2.50/M) | `gpt-5-nano` ($0.05/M) | OpenAI's latest major version is 5 — nano is cheapest there |
| `google/gemini-2.5-pro` ($1.25/M) | `gemini-3.1-flash-lite-preview` ($0/M) | Free model in Google's latest major version (3) |
| `xai/grok-4` ($3/M) | `grok-4-1-fast` ($0.20/M) | Cheapest xAI model in major version 4 |

> **Note:** `majorVersions` selects from the provider's latest N major versions, not from the active model's version. This is why gpt-4o (version 4) gets a gpt-5 budget model — OpenAI's latest major version is 5.

When the active model is already the cheapest (like Haiku 4.5), you can widen the search:

| Option | Effect for `claude-haiku-4-5` |
|---|---|
| `majorVersions: 2` | Includes previous major version → picks `claude-3-haiku` ($0.25/M) |
| `strategy: "any-provider"` | Searches all providers → picks cheapest available across providers |

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `modelOverride` | `"provider/model-id"` \| `{ model, auth }` | — | Pin a specific model, bypassing auto-selection entirely |
| `strategy` | `"same-provider"` \| `"any-provider"` | `"same-provider"` | Where to search for budget models |
| `costRatio` | `0`–`1` | `0.5` | Max cost as fraction of active model (0 = free only) |
| `majorVersions` | `0`, `1`, `2`, ... | `1` | How many major versions to search (1 = latest, 2 = latest + previous, 0 = all) |

Options are validated at runtime with [valibot](https://valibot.dev). Invalid values throw immediately.

### `modelOverride`

When set, **all other options are ignored**. The model is resolved directly from the registry by provider and ID — no strategy, cost ratio, or version filtering applies. Throws `NoBudgetModelError` if the model doesn't exist in the registry.

Two forms:

- **String** `"provider/model-id"`: registry resolves both the model metadata and the auth credentials. Use this for pinning a known-good model in config files or for testing.
- **Object** `{ model: "provider/model-id", auth: { apiKey?, headers? } }`: registry resolves the model metadata via `find()`, but auth is taken straight from the option — the registry's auth pipeline (`getApiKeyAndHeaders`) is not invoked. Use this as an escape hatch when the registry's auth resolution misbehaves for your provider, or to inject credentials from a non-pi source.

### Reusable options schema

The `BudgetModelOptions` valibot schema is exported for embedding in extension configs:

```typescript
import { BudgetModelOptions } from "pi-budget-model";
import * as v from "valibot";

const MyConfig = v.object({
  model: v.optional(BudgetModelOptions, {}),   // all budget-model options
});
```

This gives consumers a consistent model selection interface — users who know `modelOverride` / `strategy` / `costRatio` / `majorVersions` from one extension will recognize them in others.

## Algorithm

For `same-provider` (default):

1. Filter to models in the active provider
2. Extract major version from each model ID, select the top N (descending)
3. Find the cheapest model(s) by input cost
4. Verify the cheapest is within the cost ratio vs the active model
5. Among ties: higher version numbers win, aliases preferred over dated snapshots
6. Return the first candidate the registry can authenticate (any `ok: true` result, including header-only and SDK-resolved auth)

For `any-provider`: same steps but across all providers, grouped independently per provider then merged.

## Error handling

Throws `NoBudgetModelError` when no suitable model is found. The error includes structured candidates for custom fallback logic:

```typescript
try {
  const { model, auth } = await findBudgetModel(ctx);
} catch (err) {
  if (err instanceof NoBudgetModelError) {
    err.reason;          // why it failed
    err.sameProvider;    // best same-provider candidate (may have failed cost check)
    err.cheapestOverall; // cheapest across all providers
  }
}
```

If uncaught in a pi extension, the error propagates to pi's error handler which surfaces a descriptive message to the user identifying the calling extension.

## Version extraction

Model IDs use wildly different naming conventions. The version parser handles all of them:

| Model ID | Major version |
|----------|:-------------:|
| `claude-sonnet-4-5` | 4 |
| `gpt-5-nano` | 5 |
| `o3-mini` | 3 |
| `gemini-2.5-flash` | 2 |
| `grok-4-1-fast` | 4 |
| `claude-3-5-haiku-20241022` | 3 |

Date-like tokens (≥8 digits) are skipped. The `(\d+)` regex extracts the first number from any token, handling prefixed names like `o3`.
