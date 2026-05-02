---
"pi-budget-model": minor
---

Allow supplying auth credentials directly via the `modelOverride` option.

`modelOverride` now accepts an object form in addition to the existing
`"provider/model-id"` string. The object form skips the registry's auth
pipeline entirely; the registry is only consulted to resolve the model
metadata via `find()`. This is an escape hatch for when the registry's
auth resolution misbehaves for a given provider.

```ts
findBudgetModel(ctx, {
  modelOverride: {
    model: "openai/gpt-4o-mini",
    auth: { apiKey: process.env.OPENAI_API_KEY },
  },
});
```

The string form is unchanged. A new `BudgetModelAuth` valibot schema is
exported and reusable as the auth shape across `findBudgetModel`'s result
and the override option.
