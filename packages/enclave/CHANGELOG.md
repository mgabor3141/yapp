# pi-enclave

## 0.1.1

### Patch Changes

- b1506e1: Support bare strings in mounts config for simpler syntax.

  Before:

  ```toml
  [[mounts]]
  path = "~/dev/myproject/.jj"

  [[mounts]]
  path = "~/dev/myproject/.git"
  ```

  After:

  ```toml
  mounts = ["~/dev/myproject/.jj", "~/dev/myproject/.git"]
  ```

  Object form still works for read-only mounts. Also fixes ASCII chart alignment in README.

## 0.1.0

### Minor Changes

- 468b85f: Initial release of pi-enclave: VM-isolated enclave with automatic secret protection.

  - All tools (bash, read, write, edit) execute inside a Gondolin micro-VM
  - Modular drop-in config files (`pi-enclave.d/`): git, jj, GitHub ship by default
  - Generic `[env]` section: inject host values (static, command, env var) into the VM
  - `setup` scripts per drop-in: raw shell, run after package install
  - Secrets with HTTP proxy injection (never enter the VM)
  - `[[git-credentials]]` for explicit git auth over HTTPS
  - Per-host HTTP policies with allow/deny/prompt for method+path patterns
  - GraphQL-aware policy: parses request bodies, checks actual field names (not spoofable operation names)
  - `[[mounts]]` for additional directories (e.g. jj workspace parent repos)
  - Cascading config: global + drop-ins + project
  - Packages accumulate additively across all config layers
  - `/enclave init`, `/enclave on|off`, `/enclave add` with interactive search
  - Eager VM startup on session start/resume
