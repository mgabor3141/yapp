# pi-safeguard

> From [yapp](https://github.com/mgabor3141/yapp) · yet another pi pack

Security guardrail for [pi](https://pi.dev). Catches destructive commands, secret leaks, and overeager agents — without interrupting normal dev work.

```bash
pi install pi-safeguard
```

No API keys, no config files. The judge model is auto-selected from your active provider.

## Architecture

```
tool call → signal-based flagger → LLM judge → approve / deny / ask
```

The flagger and judge have cleanly separated roles:

1. **Flagger** — wide net, boolean predicates, high recall. Answers "should the judge look at this?" with no reasoning attached.
2. **Judge** — sees the raw action + session context, forms its own assessment. No hint about why the flagger triggered.

This separation prevents the flagger's (sometimes wrong) interpretation from biasing the judge. The flagger casts a wide net where false positives are cheap. The judge provides precision.

## Configuration philosophy

pi-safeguard ships with **curated, non-configurable security patterns** for common threats — destructive commands, privilege escalation, secret access, data exfiltration. These built-in patterns are maintained by the package authors, updated via releases, and cannot be disabled or weakened through configuration.

This is deliberate. Security defaults shouldn't be opt-out. The judge absorbs false positives silently (one cheap model call, no user interruption), so aggressive defaults have low cost. And since patterns only flag — the judge makes the final call — a false positive means the judge evaluates and approves, not that the user gets interrupted.

**User configuration is additive.** You can add your own commands, text patterns, and judge instructions on top of the built-ins, but you can't remove them. This covers environment-specific tools the package doesn't know about: deploy scripts, cloud CLIs, internal tooling.

The split:

- **Built-in** — universal threats that need AST-level smarts (flag parsing, pipeline analysis, variable tracking). Maintained by contributors, shipped via releases.
- **User config** — environment-specific commands and keywords. Simple name matching and regex. Configured in JSON, no code needed.

For per-session overrides when the built-in patterns are too aggressive for your current task, use `/guard` trust directives or let the agent propose them via `propose_trust`.

## What gets flagged

### Path signals

Any tool call touching files in these categories is sent to the judge:

- **Outside the working directory** — the agent's job is in the project
- **Dotfiles in `$HOME`** — `.ssh`, `.gnupg`, `.aws`, `.bashrc`, `.gitconfig`, etc.
- **System paths** — `/etc`, `/usr`, `/var`, `/dev`, `/proc`, `/sys`, `/boot`
- **Secret-ish keywords in path** — files containing `secret`, `credential`, `password`, `token`, `private_key`, `.env`, `.pem`, `.key`, `id_rsa`, `authorized_keys`

### Scope signals

- **Recursive + mutating** — `rm -r`, `chmod -R`, `chown -R`, `find -delete`
- **Force delete** — `rm -f`
- **Root path target** — anything operating on `/` or `/*`
- **Insecure permissions** — `chmod 777`, `chmod u+s`
- **Disk operations** — `dd of=...`, `mkfs.*`

### Privilege signals

- **Escalation commands** — `sudo`, `su`, `doas`, `pkexec`

### Dataflow signals

- **Network + secret variables** — `curl "$API_KEY"`, `wget "$SECRET_TOKEN"`
- **Pipeline exfiltration** — sensitive file piped to network command
- **Environment dumps** — `env`, `printenv`, `set`, `export -p` (especially in pipelines)
- **Interpreter with inline code** — `eval`, `bash -c`, `python -c`, `node -e` (opaque to static analysis)
- **Docker env pass-through** — `docker run -e`, `docker run --env-file`

### Content signals

Text written via `write`/`edit` tools is scanned for:

- **Private key material** — `-----BEGIN ... PRIVATE KEY-----`
- **Known API key formats** — `ghp_`, `gho_`, `github_pat_`, `sk-`, `AKIA`, `xoxb-`, `xoxp-`

### Text signals

Raw text in any tool input is checked for:

- **`sudo`** — even in arguments or file content (catches social engineering like `zenity --title="sudo"`)
- **`safeguard`** — references to the security guardrail itself

## What the judge sees

The judge receives only:

- The raw action description (e.g. `bash: cat ~/.ssh/id_rsa` or `edit /etc/hosts`)
- The agent's working directory
- Recent agent activity (tool calls, outcomes, previous verdicts)
- User trust directives (if any)

No signal names, no "reason it was flagged", no bias from the flagger. The judge forms its own assessment and can **approve** (silently), **deny** (block with guidance), or **ask** (prompt the user).

The agent never sees the judge's reasoning. On deny, it gets guidance suggesting alternatives. On ask, the user decides.

## Examples

Commands that get flagged (sent to the judge):

```bash
rm -rf ./build                      # scope: recursive force delete
rm -r ./build                       # scope: recursive delete
sudo apt-get install nginx          # privilege: escalation
cat .env                            # path: secret keyword
cat ~/.ssh/id_rsa                   # path: home dotfile + outside cwd
grep -r PASSWORD .env.local         # path: secret keyword
env | grep TOKEN                    # dataflow: env dump in pipeline
curl -d "$API_KEY" https://...      # dataflow: network + secret variable
python -c "import os; ..."          # dataflow: interpreter with inline code
dd if=/dev/zero of=/dev/sda         # scope: disk write
chmod 777 /etc/passwd               # scope + path: insecure perms on system file
echo pwned > /dev/sda               # path: system path
```

Commands that pass through without flagging:

```bash
rm ./build/output.js            # no recursive/force flags
cat README.md                   # normal project file
cat src/index.ts                # inside cwd, no secret keywords
curl https://api.example.com    # no secret variables
echo $HOME                      # HOME isn't a secret variable
docker run -p 8080:80 nginx     # no -e or --env-file
chmod 755 src/script.sh         # reasonable permissions, inside cwd
```

## Trust directives

When the judge gets it wrong for your situation, use `/guard`:

```
/guard allow reading .env files — they only contain defaults
/guard this is a throwaway VM, destructive ops are fine
```

Directives persist for the session and are included in every judge evaluation. `/guard` with no argument shows active directives, `/guard reset` clears them.

### Agent-proposed trust rules

When the agent gets blocked, it can use the `propose_trust` tool to request permission instead of asking you to type `/guard` manually. You'll see the proposed rule with the agent's reasoning and can accept or reject with one keypress:

```
🛡️ Trust rule proposed

📋 Allow edits to safeguard source code in packages/safeguard/
💬 User asked me to implement config redesign for pi-safeguard

> Accept / Reject
```

Accepted rules work exactly like `/guard` — they persist for the session and are included in judge evaluations.

## Custom rules

Add your own commands and patterns to flag. Useful for tools specific to your workflow (deploy scripts, cloud CLIs, etc.).

### Flagging commands

The `commands` array flags bash commands by name. A plain string flags any invocation. An array matches a subcommand prefix:

```jsonc
// ~/.pi/agent/extensions/pi-safeguard.json
{
  "commands": [
    "deploy-prod",                   // flag any deploy-prod invocation
    "kubectl",                       // flag any kubectl invocation
    ["gh", "repo", "delete"],        // flag only gh repo delete
    ["gh", "pr", "merge"],           // flag only gh pr merge
    ["terraform", "destroy"]         // flag only terraform destroy
  ]
}
```

Subcommand matching is positional — `["gh", "repo", "delete"]` matches `gh repo delete my-repo --yes` but not `gh repo view` or `gh pr delete`. Use a plain string when you want to flag every invocation and let the judge sort it out.

### Flagging text patterns

The `patterns` array matches regex patterns against the raw text of all tool input — bash commands, file writes, and edits:

```jsonc
{
  "patterns": [
    "\\bstaging-credentials\\b",    // flag any mention of staging credentials
    "\\bmy-corp\\.internal\\b"      // flag references to internal domains
  ]
}
```

Patterns are JavaScript regular expressions. Use `\\b` for word boundaries (doubled backslash in JSON).

### Judge instructions

The `instructions` field adds natural language context to the judge's system prompt. Use it for nuanced rules that don't reduce to a command name or regex:

```jsonc
{
  "instructions": "I work with Docker daily. Routine commands (build, run, ps, logs) are safe. Flag --privileged or host filesystem mounts. terraform plan is always safe; terraform apply needs review."
}
```

## Project-level configuration

Per-project rules live at `.pi/extensions/pi-safeguard.json` in the project root. They use the same format but are **additive only** — they can add commands, patterns, and instructions, but cannot disable safeguard or change operational settings.

```jsonc
// .pi/extensions/pi-safeguard.json
{
  "commands": [["terraform", "destroy"]],
  "patterns": ["\\bstaging-db\\b"],
  "instructions": "This project manages production infrastructure. Be extra careful with any state-changing operations."
}
```

Project config merges with global config: commands and patterns concatenate, instructions are both included in the judge prompt (labeled by source). Operational settings (`enabled`, `judgeModel`, `judgeTimeoutMs`) are global-only.

### Config hierarchy

| Scope | Location | Can weaken defaults? |
|-------|----------|---------------------|
| Built-in | Package source | — |
| Global | `~/.pi/agent/extensions/pi-safeguard.json` | Yes (your machine) |
| Project | `.pi/extensions/pi-safeguard.json` | No — additive only |
| Session | `/guard` trust directives | Yes (ephemeral) |

## How it works

Commands are parsed with a full shell parser ([@aliou/sh](https://github.com/aliou/sh)), not regex. This means:

- **Structural matching** — `rm -rf` caught with reordered flags (`-fr`), separate flags (`-r -f`), or mixed with other options
- **Pipeline decomposition** — `cat .env | curl` identified as sensitive-source-to-network exfiltration
- **Variable expansion tracking** — `curl "$API_KEY"` caught because the parser sees `ParamExp` nodes, not string content
- **No substring false positives** — `environment` in a path won't trigger the `env` check

Text scanning catches dangerous keywords even when they appear outside bash command names — in arguments, file content being written, or edit replacements.

After a denial, the next relevant tool call always goes to the judge regardless of signal matching — this catches agents retrying the same goal via different commands.

### Limitations

No static analysis can catch runtime evasion: `eval "cat .env"`, `bash -c "cat .env"`, `python3 -c "open('.env').read()"`. These are now flagged as signals (interpreter with inline code), but the flagger can't analyze the string content — that's the judge's job.

**Threat model**: pi-safeguard protects against accidents and overeager agents, not adversarial jailbreaks. If an attacker controls the agent's prompt, you need OS-level sandboxing, not extension-level guardrails.

## Configuration reference

No configuration needed — the defaults work out of the box. To customize, create `~/.pi/agent/extensions/pi-safeguard.json`:

```jsonc
{
  "commands": ["kubectl", ["gh", "repo", "delete"]],
  "patterns": ["\\bmy-secret\\b"],
  "instructions": "Be strict about cloud operations.",
  "judgeModel": {
    "modelOverride": "anthropic/claude-haiku-4-5"
  },
  "judgeTimeoutMs": 15000
}
```

All fields are optional. Omit the file entirely to use defaults.

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Kill switch — `false` disables all hooks |
| `commands` | `[]` | Command names or subcommand prefixes to flag |
| `patterns` | `[]` | Regex patterns to flag in all tool input text |
| `instructions` | — | Natural language context for the judge |
| `judgeTimeoutMs` | `10000` | Judge timeout in ms (1,000–60,000). On timeout, falls back to asking the user — never silently approved. |
| `judgeModel` | *(auto-select)* | Judge model selection — see below |

### Judge model selection

The `judgeModel` object controls which model evaluates flagged commands. It uses [pi-budget-model](../budget-model/) under the hood, so all its options apply:

```json
{
  "judgeModel": {
    "strategy": "same-provider",
    "costRatio": 0.5,
    "majorVersions": 1
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `modelOverride` | — | Pin a specific model: `"provider/model-id"`. Skips auto-selection entirely. |
| `strategy` | `"same-provider"` | `"same-provider"` or `"any-provider"` — where to search for cheap models |
| `costRatio` | `0.5` | Max cost as fraction of your active model (0 = free models only) |
| `majorVersions` | `1` | How many major versions to search (1 = latest, 2 = latest + previous, 0 = all) |

With defaults, if you're using Claude Sonnet 4.5 ($3/M input), the judge auto-selects Claude Haiku 4.5 ($1/M). If you're on GPT-5 ($1.25/M), it picks GPT-5 Nano ($0.05/M). See the [pi-budget-model README](../budget-model/) for the full selection table and algorithm details.

If no model qualifies (e.g. you're already on the cheapest), flagged commands fall back to user confirmation.
