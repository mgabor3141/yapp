---
"pi-bash-trim": patch
---

Only apply line deduplication when row trimming is actually needed. Output that fits within the token budget is no longer deduped.
