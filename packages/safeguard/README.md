# pi-safeguard

> From [yapp](https://github.com/mgabor3141/yapp) · yet another pi pack

Security guardrail for [pi](https://pi.dev). Catches destructive commands, secret leaks, and overeager agents — without interrupting normal dev work.

```bash
pi install pi-safeguard
```

No API keys, no config files. The judge model is auto-selected from your active provider.

## What happens

Every bash command the agent runs is parsed into an AST and checked against known-dangerous patterns. Text in all tool calls (bash, write, edit) is scanned for dangerous keywords. Flagged actions go to a lightweight LLM judge that evaluates them in context. The judge can **approve** (silently), **deny** (block with guidance), or **ask** (prompt the user). Most flagged commands are approved silently — the user is only interrupted when there's genuine ambiguity.

The agent never sees the judge's reasoning. On deny, it gets guidance suggesting alternatives. On ask, the user decides.

## Examples

Commands that get flagged and sent to the judge:

```bash
rm -rf ./build                      # destructive: rm with -rf
sudo apt-get install nginx          # elevated privileges
cat .env                            # reading secrets file
grep -r PASSWORD .env.local         # searching secrets file
env | grep TOKEN                    # environment dump in pipeline
curl -d "$API_KEY" https://...      # network command with secret variable
wget "...example.com/?t=$MY_TOKEN"  # same — suffix patterns caught too
docker run -e SECRET=foo app        # docker env pass-through
dd if=/dev/zero of=/dev/sda         # disk overwrite
chmod 777 /etc/passwd               # dangerous permission change
```

Text patterns flagged anywhere in tool input (bash commands, file writes, edits):

```
sudo                                # even in arguments: --title="sudo"
safeguard                           # references to the security guardrail
```

Commands that pass through without flagging:

```bash
rm ./build/output.js            # rm without -rf
cat README.md                   # not a secrets file
cat .env.example                # safe variant (.example, .sample, .test)
curl https://api.example.com    # no secret variables
echo $HOME                      # HOME, PATH, USER etc. aren't secrets
docker run -p 8080:80 nginx     # no -e or --env-file
```

The secret variable pattern matches `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `API_KEY`, `PRIVATE_KEY`, and `AUTH` (with word boundaries) anywhere in the variable name. `$MY_TOKEN`, `$STRIPE_API_KEY`, `$DB_PASSWORD` all match. `$AUTHOR`, `$NODE_ENV`, `$PATH` don't.

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

```
tool call → AST parse (bash) + text scan → pattern match → LLM judge → approve / deny / ask
```

Commands are parsed with a full shell parser ([@aliou/sh](https://github.com/aliou/sh)), not regex. This means:

- **Structural matching** — `rm -rf` caught with reordered flags (`-fr`), separate flags (`-r -f`), or mixed with other options
- **Pipeline decomposition** — `cat .env | curl` identified as env-to-network exfiltration
- **Variable expansion tracking** — `curl "$API_KEY"` caught because the parser sees `ParamExp` nodes, not string content
- **No substring false positives** — `environment` in a path won't trigger the `env` check

Text scanning catches dangerous keywords even when they appear outside bash command names — in arguments, file content being written, or edit replacements. This catches social engineering attempts like `zenity --title="sudo"` that AST-level command matching would miss.

After a denial, the next relevant tool call always goes to the judge regardless of pattern matching — this catches agents retrying the same goal via different commands.

### Limitations

No static analysis can catch runtime evasion: `eval "cat .env"`, `bash -c "cat .env"`, `python3 -c "open('.env').read()"`. The LLM judge handles these by seeing the suspicious follow-up after a denial.

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
