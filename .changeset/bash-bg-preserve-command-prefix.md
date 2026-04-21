---
"pi-bash-bg": patch
---

Stop re-registering the `bash` tool. Previously the extension called `createBashTool(process.cwd())` and `pi.registerTool(...)` to append a background-job note to the tool description. That freshly-constructed tool replaced pi's built-in `bash`, silently dropping the `shellCommandPrefix`, `shellPath`, and any `spawnHook` options pi configures on the built-in tool — so settings like `"shellCommandPrefix": "..."` never ran for any bash invocation once this extension was loaded.

The background-job guidance now goes into the system prompt via a `before_agent_start` hook instead, leaving the built-in bash tool untouched.
