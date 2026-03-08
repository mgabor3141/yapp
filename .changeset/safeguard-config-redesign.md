---
"pi-safeguard": minor
---

Add user-configurable `commands`, `patterns`, and `instructions` fields to safeguard config. Commands support flat string (flag any invocation) and subcommand prefix arrays (`["gh", "repo", "delete"]`). Patterns are regexes matched against all tool input text. Instructions are natural language appended to the judge system prompt.

Support project-level config at `.pi/extensions/pi-safeguard.json` (additive only — cannot weaken global settings). Global and project configs merge: commands and patterns concatenate, instructions are labeled by source.

Add `\bsafeguard\b` to built-in string patterns to flag attempts to reference or modify the security guardrail.
