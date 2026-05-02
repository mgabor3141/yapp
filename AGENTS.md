# AGENTS.md

## Repository overview

Monorepo of extensions and libraries for [pi](https://pi.dev). Managed with Yarn Berry (PnP) workspaces, built with tsup, tested with vitest, linted with biome.

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
| pi-no-soft-cursor | `packages/no-soft-cursor/` | pi extension |
| pi-jujutsu | `packages/jujutsu/` | pi extension |
| pi-bash-bg | `packages/bash-bg/` | pi extension |

## Workflow

```bash
yarn build          # build all packages
yarn test           # run all tests
yarn lint           # biome check
yarn lint:fix       # biome check --write
```

After completing changes, include a changeset file for affected packages (`yarn changeset`). Keep changeset summaries to a single line whenever possible; users see them rendered in the CHANGELOG, so be concise. See `DEVELOPMENT.md` for the release workflow.

## Gotchas

- Package README install examples should use `pi install npm:<package-name>` for npm packages.
