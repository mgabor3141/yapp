---
"pi-safeguard": minor
---

Add string pattern matching in addition to AST-based detection — dangerous keywords like `sudo` are now caught anywhere in tool input text, not just as parsed command names. Fix post-denial circumvention check cascade.
