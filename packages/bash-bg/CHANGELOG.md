# pi-bash-bg

## 0.1.1

### Patch Changes

- c845100: Fix the README install command to use the correct `npm:` package prefix for `pi install`.

## 0.1.0

### Minor Changes

- ce02a93: New package: pi-bash-bg. Makes `command &` work in pi's bash tool by intercepting bash tool calls, detecting background processes via AST parsing (@aliou/sh), and rewriting commands to redirect output to temp log files and disown. Compound commands (&&, ||, pipelines) are wrapped in braces so the redirect applies to the entire background subshell. The agent sees the PID, label, and log file path in the tool output.

### Patch Changes

- ce02a93: Append background-job behavior guidance to the bash tool description so models see that background jobs keep running, output is captured to a log file, and the PID plus log path are returned.
- ce02a93: Make background log file names human-readable by basing them on the detected command label and using a simple numeric suffix for uniqueness.
