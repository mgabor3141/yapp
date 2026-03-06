# pi-budget-model

Auto-select the cheapest available model for background tasks — guardrails, summarization, tagging, and anything where cost matters more than peak capability.

## Install

```bash
npm install pi-budget-model
```

## Usage

```typescript
import { findBudgetModel, NoBudgetModelError } from "pi-budget-model";

// Simple — cheapest in same provider, latest generation
const { model, apiKey } = await findBudgetModel(ctx);

// Cross-provider — cheapest across all providers with an API key
const { model, apiKey } = await findBudgetModel(ctx, {
  strategy: "any-provider",
});

// Include previous generation (often much cheaper)
const { model, apiKey } = await findBudgetModel(ctx, {
  generations: 2,       // latest + previous gen
  costRatio: 0.5,       // must be ≤ half the active model's cost
});

// Pin a specific model, skip auto-selection
const { model, apiKey } = await findBudgetModel(ctx, {
  modelOverride: "anthropic/claude-haiku-4-5",
});

// Only free models
const { model, apiKey } = await findBudgetModel(ctx, {
  costRatio: 0,
});
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `modelOverride` | `"provider/model-id"` | — | Pin a specific model, bypassing auto-selection entirely |
| `strategy` | `"same-provider"` \| `"any-provider"` | `"same-provider"` | Where to search for budget models |
| `costRatio` | `0`–`1` | `0.5` | Max cost as fraction of active model (0 = free only) |
| `generations` | `0`, `1`, `2`, ... | `1` | Model generations to search (1 = latest, 2 = latest + previous, 0 = all) |

Options are validated at runtime with [valibot](https://valibot.dev). Invalid values throw immediately.

### `modelOverride`

When set, **all other options are ignored**. The model is resolved directly from the registry by provider and ID — no strategy, cost ratio, or generation filtering applies. Throws `NoBudgetModelError` if the model doesn't exist or has no API key.

This is useful for pinning a known-good model in config files, or for testing.

### Reusable options schema

The `BudgetModelOptions` valibot schema is exported for embedding in extension configs:

```typescript
import { BudgetModelOptions } from "pi-budget-model";
import * as v from "valibot";

const MyConfig = v.object({
  model: v.optional(BudgetModelOptions, {}),   // all budget-model options
});
```

This gives consumers a consistent model selection interface — users who know `modelOverride` / `strategy` / `costRatio` / `generations` from one extension will recognize them in others.

## Algorithm

1. Group models by provider, extract major version from each model ID
2. Select the top N generations (by major version, descending)
3. Find the cheapest model(s) by input cost
4. Verify the cheapest is within the cost ratio vs the active model
5. Among ties: higher version numbers win, aliases preferred over dated snapshots
6. Return the first candidate with an available API key

## Error handling

Throws `NoBudgetModelError` when no suitable model is found. The error includes structured candidates for custom fallback logic:

```typescript
try {
  const { model, apiKey } = await findBudgetModel(ctx);
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

## License

MIT
