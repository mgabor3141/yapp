# pi-bash-bg

Makes `command &` work in pi's bash tool by detaching background processes from pipes.

## Problem

The bash tool pipes stdout/stderr from the spawned shell. When a command backgrounds a process with `&`, the background process inherits these pipe file descriptors and keeps them open. Node.js waits for all pipe readers to close, so the tool hangs until the background process exits.

## Solution

This extension intercepts bash tool calls, parses the command with [@aliou/sh](https://github.com/nicolo-ribaudo/sh) to detect background processes (`stmt.background === true`), and rewrites the command to:

1. **Redirect output** to temp log files so background processes release the pipes
2. **Add `disown`** to detach from job control (if not already present)
3. **Append echo** reporting PID, label, and log path

The agent sees something like:

```
[bg] pid=12345 label=npm run dev log=/tmp/pi-bg-abc-0.log
```

It can then `cat` the log file or `kill` the PID.

## Install

```bash
pi install pi-bash-bg
```

## How it works

### Simple commands

```bash
# Before:
npm run dev &
# After:
npm run dev > /tmp/pi-bg-xxx-0.log 2>&1 & disown $!;
echo "[bg] pid=$! label=npm run dev log=/tmp/pi-bg-xxx-0.log"
```

### Compound commands (&&, ||, pipelines)

Compound commands are wrapped in braces so the redirect applies to the entire background subshell, not just the last command in the chain:

```bash
# Before:
cd /app && npm start &
# After:
{ cd /app && npm start; } > /tmp/pi-bg-xxx-0.log 2>&1 & disown $!;
echo "[bg] pid=$! label=npm start log=/tmp/pi-bg-xxx-0.log"
```

### Existing redirections

If the command already redirects both stdout and stderr, the extension only adds `disown`:

```bash
# Before:
node server.js > /dev/null 2>&1 &
# After:
node server.js > /dev/null 2>&1 & disown $!;
echo "[bg] pid=$! label=node server.js log=/tmp/pi-bg-xxx-0.log"
```

### Existing disown

If the command already has `disown` after the `&`, no duplicate is added.

### System prompt

The extension replaces the default "command & doesn't work" guidance in the system prompt with instructions on how to use background processes and check their output.

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
| `cmd &> /dev/null &` | Yes (skips adding redirects) |
| `cmd & disown $!` | Yes (skips adding disown) |
| `echo "foo & bar"` | Ignored (& inside string) |
| `cmd1 && cmd2` | Ignored (no background) |
