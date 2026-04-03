---
"pi-bash-bg": minor
---

New package: pi-bash-bg. Makes `command &` work in pi's bash tool by intercepting bash tool calls, detecting background processes via AST parsing (@aliou/sh), and rewriting commands to redirect output to temp log files and disown. Compound commands (&&, ||, pipelines) are wrapped in braces so the redirect applies to the entire background subshell. The agent sees the PID, label, and log file path in the tool output.
