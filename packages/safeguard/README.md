# pi-safeguard

Zero-configuration security guardrail for [pi](https://pi.dev). Protects against accidental destructive commands, secret exposure, and overeager AI agents — without interrupting normal dev workflows.

Install it and forget about it. The defaults are designed to catch real problems while staying out of your way.

---

## Quick start

### Install

```bash
pi install pi-safeguard
```

That's it. No API keys, no config files, no setup. The judge model is auto-selected from your active provider — the cheapest one available.

### What happens

When the agent runs a bash command, pi-safeguard parses it and checks for dangerous patterns. Flagged commands go to a lightweight LLM judge that evaluates them in context. The judge can:

- **Approve** — proceed silently, the user sees nothing
- **Deny** — block the command, give the agent guidance to try something else
- **Ask** — present the command to the user for a decision

Most flagged commands get approved silently. The user is only interrupted when there's genuine ambiguity.

### Trust directives

Sometimes the judge gets it wrong for your specific situation. Use `/guard` to add session-level context:

```
/guard allow reading .env files in this project — they only contain defaults
/guard this is a throwaway test VM, destructive operations are fine
```

View active directives:
```
/guard
```

Reset all directives:
```
/guard reset
```

Directives persist for the session and are passed to the judge with every evaluation.

---

## Details

### How it works

```
bash command → AST parse → pattern match → LLM judge → approve / deny / ask
```

Every bash command is parsed into a structural AST using [@aliou/sh](https://github.com/aliou/sh), then checked against known-dangerous patterns. False positives at this stage are cheap — the LLM judge (auto-selected via [pi-budget-model](../budget-model/)) evaluates them in context and almost always approves silently.

The agent never sees the judge's internal reasoning. On deny or ask, it only receives guidance suggesting alternative approaches. All verdicts and trust directives are persisted in the pi session.

### What gets flagged

**Destructive commands** — `rm -rf`, `sudo`, `dd` with `of=`, `mkfs.*`, `chmod 777`, `chown -R`

**Secret/environment file access** — Reading, searching, copying, moving, or sourcing `.env`, `.env.local`, `.env.production`, `.env.prod`, `.dev.vars`. Safe variants (`.env.example`, `.env.sample`, `.env.test`) are excluded. Also catches file operations (read, write, edit, grep) via pi's tool system, not just bash.

**Environment variable exposure** — `printenv`, `env`, `set`, `export -p`. Also flagged when piped (`env | grep TOKEN`).

**Exfiltration patterns** — Pipeline analysis detects env files or environment dumps piped to network commands (`cat .env | curl ...`). Network commands with secret-looking variable references (`$API_KEY`, `$SECRET_TOKEN`) are also flagged.

**Docker environment pass-through** — `docker run -e` and `docker run --env-file`.

**Unparseable commands** — Commands that fail to parse are flagged as suspicious. AI agents almost never produce invalid bash syntax, so a parse failure is itself a signal.

**Post-denial circumvention** — After any denial, the next relevant tool call is always sent to the judge regardless of pattern matching. This catches an agent retrying the same goal via different commands.

### Why AST, not regex?

Pattern matching uses a full shell parser instead of regular expressions:

- **Structural matching** — `rm -rf` detected with reordered flags (`-fr`), separate flags (`-r -f`), or mixed with other options
- **Pipeline decomposition** — `cat .env | curl` identified as env-to-network exfiltration
- **Variable expansion tracking** — `curl -d "$API_KEY"` caught because the parser identifies `ParamExp` nodes
- **Redirect awareness** — `echo data > /dev/sda` catches the target from redirect metadata, not string matching
- **No substring false positives** — `environment` in a path won't trigger `env` detection

### Limitations

No static analysis — regex or AST — can catch runtime evasion: `printf "%s%s" .en v`, `eval "cat .env"`, `bash -c "cat .env"`, variable indirection, or commands in other languages (`python3 -c "open('.env').read()"`). These require actually executing the command to know what it does.

This is the LLM judge's job. And the post-denial circumvention check catches the common sequence: agent tries `cat .env` → denied → tries an evasion → judge sees the suspicious follow-up.

**Threat model**: pi-safeguard protects against accidents and overeager agents, not adversarial jailbreaks. If an attacker controls the agent's prompt and is actively evading, you need OS-level sandboxing (containers, seccomp), not extension-level guardrails.

### Design philosophy

**False positives are cheap.** The judge handles them silently — the user is only interrupted when there's genuine ambiguity. This means the pattern matcher can be aggressive.

**AST rules are precise and tested.** Each rule is a structural check with test coverage, not a regex that breaks on edge cases. If you encounter a command pattern that should be flagged, [open an issue or PR](https://github.com/mgabor3141/yap) — AST rules are straightforward to add and test.

**Zero configuration by default.** Security shouldn't require setup. Configuration exists for tuning, not for getting started.

---

## Configuration

Config file: `~/.pi/agent/extensions/pi-safeguard.json`

All fields are optional. If the file doesn't exist, defaults are used.

```json
{
  "enabled": true,
  "judgeModel": {
    "modelOverride": "anthropic/claude-haiku-4-5",
    "strategy": "same-provider",
    "costRatio": 0.5,
    "generations": 1
  },
  "judgeTimeoutMs": 10000
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Kill switch — `false` disables all hooks, zero overhead |
| `judgeTimeoutMs` | `1000`–`60000` | `10000` | Judge call timeout — exceeding this falls back to asking the user |

The `judgeModel` object uses the [pi-budget-model](../budget-model/) options schema directly. See its README for documentation of `modelOverride`, `strategy`, `costRatio`, and `generations`.

When `modelOverride` is set, auto-selection is bypassed — `strategy`, `costRatio`, and `generations` are ignored.

If no budget model qualifies (e.g. you're already on the cheapest model), flagged commands fall back to user confirmation — never silently approved.

## License

MIT
