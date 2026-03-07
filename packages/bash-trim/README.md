# pi-bash-trim

> From [yapp](../../) · yet another pi pack

Smart bash output trimming for [pi](https://pi.dev). Keeps context lean so the agent spends tokens on thinking, not on scrolling past 2000 lines of build output.

```bash
pi install pi-bash-trim
```

No configuration needed.

## The problem

Agents are usually smart about `head`, `tail`, and `grep` — but large outputs still slip through: a `find` that matches too many files, a test suite that dumps every assertion, a dependency tree that goes five levels deep. Once that output is in the context window, the only way to get rid of it is to branch before it. Every subsequent turn pays the token cost.

pi-bash-trim intercepts bash tool results *before* they reach the context. The agent sees the structure of the output — the beginning, the end, what's repeating — and can `read` the full temp file if it needs more. The tokens are saved before they become a problem.

## What it does

Three passes, in order. Short output (under ~200 tokens) passes through untouched.

1. **Line length trim** — lines over 180 chars get their middle replaced with `[...]`, cutting on BPE token boundaries. 80% kept from the start, 20% from the end.

2. **Deduplicate** — consecutive similar lines are collapsed. Pattern detection works at the word/token level: numbers at the same position vary freely (timestamps, counters, IDs), but structural changes (like `✓ PASS` vs `× FAIL`) break the group.

3. **Row trim** — if total tokens still exceed the budget (~2K tokens by default), middle rows are cut, keeping head and tail.

The full unmodified output is always saved to a temp file referenced in the header.

## Examples

| Command | Raw | Trimmed | What happened |
|---------|----:|--------:|---------------|
| `pnpm ls -r --depth 5` | 16,500 lines | ~100 lines | 2K lines deduped, 14K row-trimmed |
| `find … -name "*.json"` | 500 lines | 8 lines | 287 lines deduped into 3 summaries |
| `vitest run --verbose` | 180 lines | ~100 lines | 68 passing tests deduped, 40 row-trimmed |
| `curl lodash.min.js` | 170 lines | ~30 lines | Minified lines column-trimmed, rows cut |
| `log show --last 1m` | 500 lines | ~55 lines | Kernel spam deduped + column/row trimmed |
| `python3 -c '… 500 JSON records'` | 5,300 lines | ~200 lines | Row-trimmed (JSON structure too varied to dedup) |
| `system_profiler` | 300 lines | ~170 lines | Row-trimmed (each section unique) |
| `brew list` | 100 lines | 100 lines | Untouched — fits in budget |

A deduped test run looks like this:

```
[Trimmed: 68 repetitive lines collapsed, 40 lines omitted. Full output: /tmp/pi-bash-trim-…-full.log]
 ✓ dedup > system logs > collapses repeated kernel errors 2ms
 ✓ dedup > system logs > preserves different log lines 1ms
 ✓ dedup > system logs > handles mixed syslog formats 0ms
 ✓ dedup > test runner > collapses passing tests 1ms
 ✓ dedup > test runner > keeps failing tests separate 0ms
 ✓ dedup > build output > collapses compilation progress 6ms
[× 5 similar: ✓ dedup > should NOT dedup > preserves * 0ms]
 ✓ dedup > edge cases > handles empty input 1ms
 ...
```

Repetitive passes collapse into `[× N similar: …]` summaries. Failures, unique lines, and structural changes stand alone.

## Configuration

The defaults work well for typical development output. To customize, create `~/.pi/agent/extensions/pi-bash-trim.json`:

```json
{
  "maxTotalTokens": 3000,
  "minDedupLines": 6
}
```

All fields are optional — omitted fields use defaults.

| Option | Default | Description |
|--------|---------|-------------|
| `maxLineWidth` | 180 | Character width that triggers column trimming |
| `trimmedWidth` | 150 | Approximate width after column trimming |
| `headRatio` | 0.8 | Fraction of kept content from line start (0–1). Beginnings are usually more informative. |
| `maxTotalTokens` | 2,000 | BPE token budget before row trimming. ~80–100 lines of typical output. |
| `minTokensToTrim` | 200 | Below this, output passes through unmodified. |
| `minDedupLines` | 4 | Minimum consecutive similar lines to collapse. Raise to 6+ if you see false positives. |

## Library usage

The trimming functions are also exported for use outside pi:

```typescript
import { trimOutput } from "pi-bash-trim";

const result = trimOutput(hugeString, { maxTotalTokens: 5000 });
result.text               // trimmed output
result.columnsTrimmed     // were any visible lines column-trimmed?
result.rowsTrimmed        // were rows omitted from the middle?
result.dedupedLines       // lines collapsed by dedup
result.omittedLines       // rows cut from the middle
result.totalLines         // original line count
```

## Known issues

**Error output is not trimmed.** Pi's extension API fires `tool_result` for failed commands but ignores modifications to the result. Commands that exit non-zero bypass trimming entirely. This is a pi framework limitation.
