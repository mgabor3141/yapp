---
"pi-safeguard": minor
---

Add string pattern matching in addition to AST-based detection. Dangerous keywords like `sudo` are now caught anywhere in tool input text (e.g. scripts being written or edited), not just when they appear as parsed command names. Also fix post-denial circumvention check cascade where a single denial could trigger repeated checks on every subsequent tool call.
