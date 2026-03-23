# pi-enclave

> From [yapp](https://github.com/mgabor3141/yapp) · yet another pi pack

VM-isolated enclave for [pi](https://pi.dev). Runs all tools inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM so secrets never enter the agent's execution environment.

```bash
pi install npm:pi-enclave
```

Requires QEMU: `brew install qemu` (macOS) or `sudo apt install qemu-system-aarch64` (Linux).

## How it works

pi-enclave starts an Alpine Linux micro-VM (QEMU/aarch64) and redirects all tool execution into it. Your workspace is mounted read-write at the same path inside the VM, so tools see identical paths on host and guest. File changes are bidirectional.

The core security property: **secrets never enter the VM**. Secrets configured in your TOML config (like `gh auth token`) are resolved on the host, and their values are replaced with random placeholders inside the VM. Gondolin's HTTP proxy substitutes real values on the wire, only for requests to configured hosts.

```
┌─────────────────────────────────────────────────────┐
│  Gondolin VM (Alpine Linux)                         │
│                                                     │
│  /home/user/project ← bidirectional mount           │
│  GH_TOKEN = "GONDOLIN_SECRET_a8f3..." (placeholder) │
│  All pi tools execute here                          │
└──────────────────────────┬──────────────────────────┘
                           │ HTTP
                           ▼
┌─────────────────────────────────────────────────────┐
│  HTTP proxy (host-side)                             │
│  placeholder → real value (only for allowed hosts)  │
└─────────────────────────────────────────────────────┘
```

## Getting started

```
/enclave init
```

This creates:
- `~/.pi/agent/extensions/pi-enclave.toml` — global config (env vars, base packages)
- `~/.pi/agent/extensions/pi-enclave.d/` — drop-in files (git, jj, GitHub)
- `.pi/enclave.toml` — project config with `enabled = true`

Once enabled, all tools (bash, read, write, edit) execute inside the VM automatically.

## Drop-in files

Service integrations live in `pi-enclave.d/` as self-contained TOML files. Each can contribute packages, setup scripts, secrets, and host policies. Delete a file to disable that integration.

```
~/.pi/agent/extensions/
├── pi-enclave.toml              # base config: curl, jq, env vars
└── pi-enclave.d/
    ├── git.toml                 # git + user identity
    ├── github.toml              # github-cli + secrets + policies
    └── jj.toml                  # jujutsu + user identity
```

Example drop-in (`git.toml`):

```toml
packages = ["git"]
setup = """
git config --global safe.directory '*'
git config --global user.name "$USER_NAME"
git config --global user.email "$USER_EMAIL"
"""
```

`USER_NAME` and `USER_EMAIL` are defined in the main config as env vars resolved from the host:

```toml
[env]
USER_NAME = { command = "git config --global user.name" }
USER_EMAIL = { command = "git config --global user.email" }
```

## Configuration

### Env vars

Non-secret values available in the VM and setup scripts. Three source types:

```toml
[env]
EDITOR = "vim"                                     # static
USER_NAME = { command = "git config user.name" }   # host command
GOPATH = { env = "GOPATH" }                        # host env var
```

### Secrets

Like env vars, but values never enter the VM. The HTTP proxy injects them on the wire.

```toml
[secrets.GH_TOKEN]
command = "gh auth token"
hosts = ["api.github.com", "github.com", "*.githubusercontent.com"]
```

### Git credentials

Configures git credential helpers using secret placeholders:

```toml
[[git-credentials]]
host = "github.com"
username = "x-access-token"
secret = "GH_TOKEN"
```

### Host policies

Access control per host. `unmatched` determines what happens to requests that don't match any allow/deny rule.

```toml
[hosts."api.github.com"]
unmatched = "prompt"
allow.GET = ["/**"]

[hosts."api.github.com".graphql]
endpoint = "/graphql"
allow.query = ["*"]
allow.mutation = ["createPullRequest", "createIssue", "addComment"]
```

GraphQL policy parses the request body and checks actual field names (not the spoofable operation name).

### Mounts

Additional directories to mount in the VM (e.g. for jj workspaces):

```toml
mounts = [
  "~/dev/myproject/.jj",
  "~/dev/myproject/.git",
]
```

For read-only mounts, use the object form:

```toml
mounts = [
  "~/dev/myproject/.jj",
  { path = "~/shared/configs", readonly = true },
]
```

### Config layering

Two locations: global (`~/.pi/agent/extensions/pi-enclave.toml` + drop-ins) and project (`.pi/enclave.toml`). Project overrides global. Packages accumulate across all layers; secrets, hosts, and env merge by key (later wins).

```toml
# .pi/enclave.toml — allow all GitHub operations in this project
enabled = true

[hosts."api.github.com"]
unmatched = "allow"
```

## Commands

| Command | Description |
|---------|-------------|
| `/enclave` or `/enclave status` | Show VM state, packages, secrets |
| `/enclave init` | Create project and global config files, enable enclave |
| `/enclave on` | Enable VM isolation for this session |
| `/enclave off` | Disable VM isolation for this session (shuts down VM) |
| `/enclave restart` | Restart VM on next tool use |
| `/enclave add <package>` | Search for and install an Alpine package |
