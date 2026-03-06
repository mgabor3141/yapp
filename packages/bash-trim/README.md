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
- **Repetitive output** — hundreds of identical log entries or build progress lines
- **Verbose build output** — thousands of lines when head + tail would suffice

## How it works

Three passes, applied in order:

1. **Column trimming** — lines wider than 180 chars get their middle replaced with `[...]`, keeping ~150 chars (80% from the start, 20% from the end). Cuts land on BPE token boundaries so the LLM never sees partial tokens.

2. **Line dedup** — consecutive lines following the same pattern are collapsed. `[× 847 similar: * E  kernel[0:af9] (IOSurface) SID: 0x0]` tells the agent what's repeating without wasting context. The pattern is detected by column-aligned comparison — no timestamp parsing needed.

3. **Row trimming** — if total tokens (after column trimming and dedup) exceed the budget, middle rows are omitted, keeping head and tail.

Short output (under 200 tokens) passes through completely untouched.

## What happens to the full output?

When trimming occurs, the full unmodified output is saved to a temp file and referenced in a notice:

```
[`[...]` marks content trimmed from 15 long lines (3,421 chars omitted total).
 847 repetitive lines collapsed into 3 summaries.
 142 lines omitted from the middle of 500 total.
 Full output: /tmp/yap-bash-trim-12345-1-full.log]
```

The agent can `read` these files if it needs the full content.

## Library usage

The trimming functions are exported for use outside pi:

```typescript
import { trimOutput } from "pi-bash-trim";

const result = trimOutput(hugeString);
result.text               // trimmed output
result.columnsTrimmed     // were any visible lines column-trimmed?
result.rowsTrimmed        // were rows omitted from the middle?
result.dedupedLines       // lines collapsed by dedup
result.columnCharsOmitted // total chars removed by column trimming
result.omittedLines       // rows cut from the middle
result.totalLines         // original line count
```

## Advanced configuration

The defaults are tuned for typical development output. Most users won't need to change them.

```typescript
trimOutput(output, {
  maxLineWidth: 180,     // trigger column trimming above this width
  trimmedWidth: 150,     // approximate width after column trimming
  headRatio: 0.8,        // 80% head, 20% tail for line trimming
  maxTotalTokens: 2000,  // BPE token budget before row trimming
  minTokensToTrim: 200,  // skip all processing below this token count
  minDedupLines: 4,      // minimum consecutive similar lines to collapse
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxLineWidth` | 180 | Character width that triggers column trimming |
| `trimmedWidth` | 150 | Approximate character width after column trimming |
| `headRatio` | 0.8 | Fraction of kept content from the start of the line (0.0–1.0). Line beginnings (command names, keys, timestamps) are almost always more informative than middles. |
| `maxTotalTokens` | 2,000 | BPE token budget before row trimming. ~80–100 lines of typical output. |
| `minTokensToTrim` | 200 | Below this token count, output is returned completely unmodified. Prevents dedup and column trimming from changing short script output where the modifications would be more confusing than helpful. |
| `minDedupLines` | 4 | Minimum consecutive similar lines before collapsing into a summary. Higher values are more conservative — set to 6+ if you see false collapses. |

## Known issues

**Error output is not trimmed.** Pi's extension API fires `tool_result` for failed commands but ignores modifications to the result. This means commands that exit with a non-zero status (compilation errors, failed tests, timeouts) bypass trimming entirely. This is a pi framework limitation.

## License

MIT
