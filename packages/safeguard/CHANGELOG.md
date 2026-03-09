# pi-safeguard

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
