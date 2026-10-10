# pi-bash-bg

Makes `command &` work in pi's bash tool by detaching background processes from pipes.

## Problem

The bash tool pipes stdout/stderr from the spawned shell. When a command backgrounds a process with `&`, the background process inherits these pipe file descriptors and keeps them open. Node.js waits for all pipe readers to close, so the tool hangs until the background process exits.

## Solution

This extension intercepts bash tool calls, parses the command with [@aliou/sh](https://github.com/nicolo-ribaudo/sh) to detect background processes (`stmt.background === true`), appends background-job guidance to the system prompt, and rewrites the command to:

1. **Redirect output** to temp log files with human-readable names based on the command label, so background processes release the pipes
2. **Add `disown`** to detach from job control (if not already present)
3. **Append echo** reporting PID, label, and log path

The agent sees something like:

```
[bg] pid=12345 label=npm run dev log=/tmp/pi-bg-npm-run-dev-1.log
```

It can then `cat` the log file or `kill` the PID.

## Install

```bash
pi install npm:pi-bash-bg
```

## How it works

### Simple commands

```bash
# Before:
npm run dev &
# After:
npm run dev > /tmp/pi-bg-npm-run-dev-1.log 2>&1 & disown $!;
echo "[bg] pid=$! label=npm run dev log=/tmp/pi-bg-npm-run-dev-1.log"
```

### Compound commands (&&, ||, pipelines)

Compound commands are wrapped in braces so the redirect applies to the entire background subshell, not just the last command in the chain:

```bash
# Before:
cd /app && npm start &
# After:
{ cd /app && npm start; } > /tmp/pi-bg-npm-start-2.log 2>&1 & disown $!;
echo "[bg] pid=$! label=npm start log=/tmp/pi-bg-npm-start-2.log"
```

### Existing redirections

If a simple command already redirects both stdout and stderr, the extension only adds `disown` (no log file is created):

```bash
# Before:
node server.js > /dev/null 2>&1 &
# After:
node server.js > /dev/null 2>&1 & disown $!;
echo "[bg] pid=$! label=node server.js"
```

Compound commands are always wrapped in braces, even if their inner commands have redirections. This is necessary because the background subshell itself holds the pipe file descriptors open regardless of what its child commands do:

```bash
# Before:
cd /app && npm start > /dev/null 2>&1 &
# After:
{ cd /app && npm start > /dev/null 2>&1; } > /tmp/pi-bg-npm-start-3.log 2>&1 & disown $!;
echo "[bg] pid=$! label=npm start log=/tmp/pi-bg-npm-start-3.log"
```

### Multiple jobs

Each top-level `&` job gets its own log file and its own `[bg]` line, printed right after it starts (so `$!` is that job's PID):

```bash
# Before:
(make a) & (make b) & echo started
# After:
{ (make a); } > /tmp/pi-bg-subshell-4.log 2>&1 & disown $!; printf '%s\n' "[bg] pid=$! "'label=(subshell) log=/tmp/pi-bg-subshell-4.log'; { (make b); } > /tmp/pi-bg-subshell-5.log 2>&1 & disown $!; printf '%s\n' "[bg] pid=$! "'label=(subshell) log=/tmp/pi-bg-subshell-5.log'; echo started
```

### `wait`

If a top-level `wait` follows the background jobs (e.g. `a & b & wait`), the script is **not rewritten**. It runs as written and blocks until the jobs finish. Disowned jobs can't be waited for, so that is the only way such a script can work.

### Fail-safe

Each job's text comes from @aliou/sh's source positions. That text is re-parsed and must match the original AST before anything is rewritten. If it doesn't, or the command doesn't parse, it runs unchanged. The known parser gap that hits this path today is `|&`.

### Existing disown

If the command already has `disown` after the `&`, no duplicate is added.

### System prompt guidance

The extension appends a short background-job section to the system prompt via the `before_agent_start` hook, so the model sees how to use `command &`, where to find log files, and how to stop processes. The built-in `bash` tool definition is left untouched so pi's `shellCommandPrefix`, `shellPath`, and any `spawnHook` wiring continue to apply.

## Supported patterns

| Pattern | Handled |
|---------|---------|
| `npm run dev &` | Yes |
| `cd /dir && npm start &` | Yes (wrapped in braces) |
| `tail -f log \| grep error &` | Yes (wrapped in braces) |
| `nohup node server.js &` | Yes |
| `PORT=3000 node server.js &` | Yes |
| `while true; do sleep 1; done &` | Yes (wrapped in braces) |
| `(sleep 10 && echo done) &` | Yes (wrapped in braces) |
| `cmd &> /dev/null &` | Yes (skips adding redirects for simple commands) |
| `cmd & disown $!` | Yes (skips adding disown) |
| `echo "foo & bar"` | Ignored (& inside string) |
| `cmd1 && cmd2` | Ignored (no background) |
