# pi-jujutsu

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
