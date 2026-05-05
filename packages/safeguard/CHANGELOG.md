# pi-safeguard

## 2.0.2

### Patch Changes

- 18f2c99: Preserve auth headers from `getApiKeyAndHeaders` so header-authenticated providers work.

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
  interface BudgetModel {
    model: Model<Api>;
    apiKey: string;
  }

  // after
  interface BudgetModel {
    model: Model<Api>;
    auth: BudgetModelAuth;
  }
  type BudgetModelAuth = { apiKey?: string; headers?: Record<string, string> };
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

- Updated dependencies [18f2c99]
- Updated dependencies [18f2c99]
  - pi-budget-model@2.0.0

## 2.0.1

### Patch Changes

- 72b0e72: Show verdict counts in a widget instead of the status bar. Persists until the agent goes idle.

## 2.0.0

### Major Changes

- af8ec18: Replace pattern matching with signal-based flagging. The flagger is now a wide-net boolean gate (high recall, no reasoning); the judge sees raw actions only — no flagger bias.

  Broadened sensitive file detection beyond `.env*`: files outside cwd, dotfiles in `$HOME`, system paths, paths with secret keywords.

  New signals: `rm -r`/`rm -f` flagged independently, inline code interpreters (`eval`, `bash -c`, `python -c`, `node -e`), `chmod u+s`/`g+s`, `su`/`doas`/`pkexec`, private key material, known API key formats.

### Minor Changes

- 04d1a1a: Add user-configurable `commands`, `patterns`, and `instructions` to safeguard config. Support project-level config at `.pi/extensions/pi-safeguard.json` (additive only — cannot weaken global settings). Add `\bsafeguard\b` to built-in string patterns.
- f624ef6: Add `propose_trust` tool that lets the agent request permission when blocked by the security guardrail. The user sees the proposed trust rule with the agent's reasoning and can accept or reject with one keypress. Accepted rules work like `/guard` — they persist for the session.
- e7b8ba5: Add string pattern matching in addition to AST-based detection — dangerous keywords like `sudo` are now caught anywhere in tool input text, not just as parsed command names. Fix post-denial circumvention check cascade.

## 1.0.1

### Patch Changes

- 70122cd: Clean up package metadata, migrate to Yarn Berry
- Updated dependencies [70122cd]
  - pi-budget-model@1.0.1
