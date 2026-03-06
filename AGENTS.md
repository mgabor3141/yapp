# AGENTS.md

## Repository overview

Monorepo of extensions and libraries for [pi](https://pi.dev). Managed with pnpm workspaces, built with tsup, tested with vitest, linted with biome.

## Rules

1. **Runtime schema validation on all configs.** Every package that accepts user-facing options must validate them at runtime with [valibot](https://valibot.dev). Export the schema so consumers can reuse it. No `interface`-only options — if it's configurable, it's validated.

2. **Tests use live data, not fixtures, for model-dependent behavior.** `pi-budget-model` tests import from the installed `@mariozechner/pi-ai` package. Tests should break usefully when the upstream package updates.

3. **Fail closed.** Errors, timeouts, or missing config should fall back to the safest behavior (ask user, skip optimization), never silently allow.

## Package layout

| Package | Path | Type |
|---------|------|------|
| pi-safeguard | `packages/safeguard/` | pi extension |
| pi-bash-trim | `packages/bash-trim/` | pi extension |
| pi-desktop-notify | `packages/desktop-notify/` | pi extension + library |
| pi-budget-model | `packages/budget-model/` | library |

## Workflow

```bash
pnpm build          # build all packages
pnpm test           # run all tests
pnpm lint           # biome check
pnpm lint:fix       # biome check --write
```

Commit directly to `main`. No feature branches.
