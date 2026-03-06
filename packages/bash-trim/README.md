# pi-bash-trim

Smart bash output trimming for [pi](https://pi.dev). Replaces pi's built-in truncation (50KB / 2000 lines) with token-aware trimming that preserves useful structure while cutting noise.

## Install

```bash
pi install pi-bash-trim
```

No configuration needed — it works as a pi extension out of the box.

## Why

Pi's bash tool dumps up to 50KB / 2000 lines into the LLM context. This floods the context with:

- **Minified JS blobs** — one 50KB line of `var a=function(){...}`
- **Wide log lines** — timestamps + JSON payloads spanning 2000+ chars
- **Verbose build output** — thousands of lines when head + tail would suffice

pi-bash-trim applies two passes using actual BPE token counts (via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer)):

1. **Column trimming** — lines wider than 180 chars get their middle replaced with `[...]`, keeping ~150 chars total (80% from the start, 20% from the end). Cuts land on token boundaries so the LLM never sees partial BPE tokens.

2. **Row trimming** — if total tokens (after column trimming) exceed 2K, middle rows are omitted, keeping head and tail. The agent can always `read` the temp file for full output.

Short output passes through untouched. The budget is measured in actual BPE tokens, not characters — so dense code uses more budget per line than simple output like `seq 1 500`.

## What happens to the full output?

When trimming occurs, the full unmodified output is saved to a temp file and referenced in a notice:

```
[`[...]` marks content trimmed from 15 long lines (3,421 chars omitted total).
 142 lines omitted from the middle of 500 total.
 Full output: /tmp/yap-bash-trim-12345-1-full.log]
```

The agent can `read` these files if it needs the full content.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxLineWidth` | 180 | Character width that triggers column trimming |
| `trimmedWidth` | 150 | Approximate character width after column trimming |
| `headRatio` | 0.8 | Fraction of kept content from the start of the line (0.0–1.0) |
| `maxTotalTokens` | 2,000 | BPE token budget before row trimming (~80–100 lines of head+tail) |

Pass options to `trimOutput` when using as a library:

```typescript
import { trimOutput } from "pi-bash-trim";

const result = trimOutput(hugeString, {
  maxLineWidth: 120,
  maxTotalTokens: 5000,
});
```

### `TrimResult`

```typescript
result.text               // trimmed output
result.columnsTrimmed     // were any visible lines column-trimmed?
result.rowsTrimmed        // were rows omitted from the middle?
result.columnCharsOmitted // total chars removed by column trimming (visible lines only)
result.columnLinesTrimmed // number of visible lines that were column-trimmed
result.omittedLines       // how many rows were cut
result.totalLines         // original line count
```

## Known issues

**Error output is not trimmed.** Pi's extension API fires `tool_result` for failed commands but ignores modifications to the result. This means commands that exit with a non-zero status (compilation errors, failed tests, timeouts) bypass trimming entirely. This is a pi framework limitation — the output is available but the modified version is discarded. ([Upstream issue pending.](#))

## License

MIT
