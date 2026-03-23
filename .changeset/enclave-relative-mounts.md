---
"pi-enclave": minor
---

Support relative mount paths and skip missing directories.

Mount paths in config are now resolved against the workspace directory, so project configs can use short relative paths like `mounts = [".jj", ".git"]` instead of hardcoded absolute paths. Missing mount paths are silently skipped at VM start, making optional mounts safe to declare unconditionally.
