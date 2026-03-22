# yapp

***y**et **a**nother **p**i **p**ack*

Utilities for running [pi](https://pi.dev) agents with less babysitting: sandbox tools in a VM, auto-review risky shell commands, compress noisy terminal output before it bloats context, and get notified when unattended work finishes.

## The Pack

Install the extensions together, or pick only the ones you want. Defaults are tuned for good behavior out of the box.

```bash
pi install npm:pi-enclave npm:pi-safeguard npm:pi-bash-trim npm:pi-desktop-notify npm:pi-no-soft-cursor
```

### [pi-enclave](packages/enclave/)

VM-isolated sandbox. All agent tools (bash, read, write, edit) execute inside a Gondolin micro-VM (QEMU/aarch64 Alpine Linux). Secrets are resolved on the host and injected via HTTP proxy; the VM never sees real credential values. Per-host policies control what the agent can do: GraphQL mutations are checked at the AST level, git pushes require approval, reads pass through. Configuration is modular: drop-in files in `pi-enclave.d/` add tool support (git, jj, GitHub) with their own packages, setup scripts, and policies. Delete a file to disable that integration.

### [pi-safeguard](packages/safeguard/)

LLM-as-judge guardrail. Every bash command the agent runs is parsed into an AST and checked against known-dangerous patterns — `rm -rf`, reading `.env` files, `curl` with secret variables, `sudo`, and more. Flagged commands go to a smaller model that evaluates them with the full parsed context — structured AST, recent tool history, and user trust directives. The tight scope makes even lightweight models very reliable here. Most dev commands pass silently; you're only interrupted when there's genuine ambiguity.

The judge model is auto-selected from your active provider via pi-budget-model.

### [pi-bash-trim](packages/bash-trim/)

Smart bash output trimming. Intercepts tool results before they enter the context window — long lines get their middles cut, repetitive blocks collapse into `[× N similar: …]` summaries, and oversized output is head/tail trimmed with the full version saved to a temp file. A 16,000-line `pnpm ls` becomes ~100 lines. The agent sees the structure and can read the full file if it needs more.

### [pi-desktop-notify](packages/desktop-notify/)

Desktop notifications with terminal focus tracking. Notifications are suppressed while the terminal is in the foreground and only fire when you've tabbed away — so you hear about finished tasks without being interrupted mid-thought. Click-to-focus brings the terminal back. Works on macOS (terminal-notifier) and Linux (notify-send), with compositor support for niri, sway, and hyprland.

### [pi-no-soft-cursor](packages/no-soft-cursor/)

Remove the reverse-video block cursor from the editor. Your terminal already shows a blinking cursor via the hardware cursor marker — the highlighted character block the editor draws on top is just visual noise. This strips it.

## Libraries

### [pi-budget-model](packages/budget-model/)

Auto-select the cheapest available model for background tasks. Given the active model and provider, finds the cheapest alternative within the same provider's latest major version — Haiku for Anthropic users, GPT-5 Nano for OpenAI, and so on. Configurable strategy, cost ratio, and version depth. Used internally by pi-safeguard; useful for any extension that needs a lightweight model for behind-the-scenes work.

Install via `npm install pi-budget-model` — this is a library, not a pi extension.
