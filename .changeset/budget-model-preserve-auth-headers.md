---
"pi-budget-model": major
"pi-safeguard": patch
---

Preserve auth headers from `getApiKeyAndHeaders` so header-authenticated providers work.

The previous wrapper extracted only `auth.apiKey` from the registry's
`getApiKeyAndHeaders` result and discarded `auth.headers`. Providers that
authenticate via headers (e.g. an out-of-band `Authorization` header, or AWS
Bedrock with SDK-resolved credentials) were rejected during selection because
they returned `{ ok: true, apiKey: undefined, headers: {...} }` and the wrapper
gated on `apiKey` truthiness. They are now selected and their headers are
forwarded to `pi-ai`'s `completeSimple`/`stream` (which already accepts
`headers` on its options object).

`pi-safeguard` is updated to forward the new auth shape; no consumer-visible
change.

## Migration guide (BREAKING)

`BudgetModel` now has a nested `auth` field instead of a flat `apiKey`:

```ts
// before
interface BudgetModel { model: Model<Api>; apiKey: string }

// after
interface BudgetModel { model: Model<Api>; auth: BudgetModelAuth }
type BudgetModelAuth = { apiKey?: string; headers?: Record<string, string> }
```

Update consumers that read `apiKey` directly:

```diff
 const judge = await findBudgetModel(ctx);
-await completeSimple(judge.model, ctx, { apiKey: judge.apiKey, signal });
+await completeSimple(judge.model, ctx, { ...judge.auth, signal });
```

If you can't switch to spreading, read `judge.auth.apiKey` (note: now
`string | undefined`, since header-only providers return `auth` without an
`apiKey`).

The minimum required version of `@mariozechner/pi-coding-agent` and
`@mariozechner/pi-ai` is now `0.63.0` (for the `getApiKeyAndHeaders` registry
method and the `headers` field on `StreamOptions`). The `peerDependencies`
range has been tightened to `>=0.63.0` accordingly.
