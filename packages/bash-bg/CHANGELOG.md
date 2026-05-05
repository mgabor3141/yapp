# pi-bash-bg

## 0.1.3

### Patch Changes

- 18f2c99: Align `@mariozechner/pi-coding-agent` (and `@mariozechner/pi-tui` for `pi-no-soft-cursor`) `devDependency` to `^0.63.0`.

  `devDependency`-only update; no runtime change. Published `dist/*.d.ts` may reference newer upstream types from pi 0.63 (e.g. the `signal` property on `ExtensionContext`), so consumers writing extensions against these packages should be on pi ≥ 0.63 to match. Required to keep `tsup --dts` working alongside `pi-budget-model`, which now depends on the 0.63 registry API.

## 0.1.2

### Patch Changes

- 6c014b5: Stop replacing pi's built-in `bash` tool so `shellCommandPrefix`, `shellPath`, and `spawnHook` keep working; background-job guidance is now injected into the system prompt instead.

## 0.1.1

### Patch Changes

- c845100: Fix the README install command to use the correct `npm:` package prefix for `pi install`.

## 0.1.0

### Minor Changes

- ce02a93: New package: pi-bash-bg. Makes `command &` work in pi's bash tool by intercepting bash tool calls, detecting background processes via AST parsing (@aliou/sh), and rewriting commands to redirect output to temp log files and disown. Compound commands (&&, ||, pipelines) are wrapped in braces so the redirect applies to the entire background subshell. The agent sees the PID, label, and log file path in the tool output.

### Patch Changes

- ce02a93: Append background-job behavior guidance to the bash tool description so models see that background jobs keep running, output is captured to a log file, and the PID plus log path are returned.
- ce02a93: Make background log file names human-readable by basing them on the detected command label and using a simple numeric suffix for uniqueness.
