# pi-jujutsu

## 0.1.3

### Patch Changes

- 18f2c99: Align `@mariozechner/pi-coding-agent` (and `@mariozechner/pi-tui` for `pi-no-soft-cursor`) `devDependency` to `^0.63.0`.

  `devDependency`-only update; no runtime change. Published `dist/*.d.ts` may reference newer upstream types from pi 0.63 (e.g. the `signal` property on `ExtensionContext`), so consumers writing extensions against these packages should be on pi ≥ 0.63 to match. Required to keep `tsup --dts` working alongside `pi-budget-model`, which now depends on the 0.63 registry API.

## 0.1.2

### Patch Changes

- c98b535: Show jj error details in snapshot failure notifications instead of a generic message.

## 0.1.1

### Patch Changes

- 14bda46: Fix extension not loading when installed from npm: pi.extensions entry pointed to src/index.ts which is not included in the published package. Changed to dist/index.js.

## 0.1.0

### Minor Changes

- 11c2d65: Initial release of pi-jujutsu: live jj working copy status and repo context for pi.

  - Footer patch: replaces `(detached)` with jj context (bookmark, description, or change ID; stack depth; empty prefix)
  - Working copy widget: colored diff stat above the editor, updates between agent turns
  - Falls back to showing `@-` when `@` is empty (e.g. after `jj commit`)
  - Op watcher: detects external jj operations and refreshes automatically
  - Toggle widget with `Ctrl+Shift+J`
  - Silently does nothing in non-jj repos
