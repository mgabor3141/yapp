---
"pi-enclave": patch
---

Use conversation messages instead of system prompt for enclave hints.

The enclave context hint is now a regular message added once per session, instead of being injected via `before_agent_start`. This avoids invalidating the prompt cache when toggling enclave on/off mid-session.
