---
"pi-enclave": minor
---

Redirect /tmp file operations from host-side extensions into the VM. Files written to /tmp by other pi extensions (e.g. librarian saving fetched content) are now visible inside the enclave at their original paths. Uses ESM loader hooks and CJS monkey-patching for comprehensive interception without exposing the full host /tmp. Users who need complete /tmp visibility can add `mounts = ["/tmp"]` to their enclave config.
