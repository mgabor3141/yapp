# pi-jujutsu

## 0.1.0

### Minor Changes

- 11c2d65: Initial release of pi-jujutsu: live jj working copy status and repo context for pi.

  - Footer patch: replaces `(detached)` with jj context (bookmark, description, or change ID; stack depth; empty prefix)
  - Working copy widget: colored diff stat above the editor, updates between agent turns
  - Falls back to showing `@-` when `@` is empty (e.g. after `jj commit`)
  - Op watcher: detects external jj operations and refreshes automatically
  - Toggle widget with `Ctrl+Shift+J`
  - Silently does nothing in non-jj repos
