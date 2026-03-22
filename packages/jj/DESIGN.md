# pi-jj Design Document

Automatic jj snapshots and repo status for [pi](https://pi.dev). After each
agent response, shows what changed on disk and how to restore the previous
state. No prompts, no interactivity, just information.

## Goals

1. **Snapshot every prompt.** Capture the jj operation ID before the agent
   runs. After it finishes, snapshot the working copy. If nothing changed,
   stay silent.

2. **Show what happened.** Display file-level diff stats, new commits,
   and bookmark movements. Full detail for the latest response, compact
   summary in scrollback.

3. **Make restore easy.** Every snapshot line includes the restore command
   (`jj op restore <id>`). The user can copy it from scrollback at any time.

4. **Persist across sessions.** Snapshot data is stored as session entries
   so it survives restarts and session resumes.

5. **Fail visibly.** If snapshotting fails, notify the user. Never silently
   skip; the user may be relying on the safety net.

## Non-goals

- No checkpoint restore UI (the restore command is enough).
- No stacked PR workflow (that's a separate concern).
- No onboarding or `jj init` prompts. If the repo isn't a jj repo, stay
  silent.

## Display Architecture

Three layers, each serving a different purpose:

### Widget (full diff, latest only)

`setWidget("pi-jj", lines)` placed above the editor after `agent_end`.
Shows the full `--stat` output: per-file changes with +/- counts, totals,
committed descriptions, bookmark movements, and the restore command.

Cleared on `before_agent_start` to avoid showing stale data while the agent
works. Replaced with the new diff when the next prompt completes.

### Custom message (compact summary, scrollback)

`sendMessage({customType: "jj-snapshot", display: true, ...})` after
`agent_end`. A one-liner like:

```
jj: 9 files (+1326, -2) · committed "add login" · restore: jj op restore abc123
```

Lives in the session message stream. The LLM sees it too, which is useful:
the agent gains repo state awareness without having to generate it. Cost is
roughly 15 tokens per prompt.

Styled with `registerMessageRenderer`: dim text, colored counts. Ctrl+O
expands to show the full file-level stat from `details`.

### Session entries (persistence)

`appendEntry("jj-snapshot", data)` after `agent_end`. Stores the raw
snapshot data (pre/post operation IDs, commit ID, change ID, diff stats).
Not sent to the LLM, not rendered. On `session_start`, these entries are
read to restore state, rebuild the widget for the latest snapshot, and
set the footer status.

## Event Flow

```
session_start       →  detect jj repo
                       restore snapshot history from custom entries
                       rebuild widget for latest snapshot
                       set footer status

before_agent_start  →  capture pre-op ID (with --ignore-working-copy to
                         avoid triggering a snapshot)
                       clear widget

agent_end           →  jj util snapshot
                       capture post-op ID
                       if pre_op == post_op: skip (nothing changed)
                       collect diff data:
                         jj op diff --from PRE --to POST --stat
                         parse per-file stats, total stats
                         parse "Changed commits" for descriptions
                         parse "Changed local/remote bookmarks"
                       sendMessage (compact one-liner)
                       setWidget (full stat display)
                       appendEntry (raw snapshot data)
                       set footer status
```

## jj Commands Used

| Purpose | Command | Notes |
|---------|---------|-------|
| Snapshot working copy | `jj util snapshot` | Idempotent: prints "No snapshot needed" and creates no operation if clean |
| Read operation ID | `jj --ignore-working-copy op log -n 1 --no-graph -T 'self.id()'` | `--ignore-working-copy` prevents triggering a snapshot |
| Read short op ID | Same with `self.id().short()` | For display |
| Diff between ops | `jj op diff --from PRE --to POST --stat` | Shows per-file stats, commits, bookmark changes |
| Current commit | `jj --ignore-working-copy log -r @ --no-graph -T 'commit_id.short()'` | For the snapshot entry |
| Current change | Same with `change_id.short()` | Stable identity across rewrites |

## Output Format

### Widget (full diff)

```
 src/index.ts        | 336 +++++++-
 src/config.ts       | 250 +++++++
 test/config.test.ts | 158 ++++
 yarn.lock           |   8 +
 4 files changed, 750 insertions(+), 2 deletions(-)
 committed: "add login endpoint"
 bookmarks: main→origin
 restore: jj op restore abc123
```

### Compact message (scrollback)

```
jj: 4 files (+750, -2) · committed "add login endpoint" · main→origin · restore: jj op restore abc123
```

### Nothing changed

No widget, no message, no entry.

## Configuration

Runtime config via `~/.pi/agent/extensions/pi-jj.json`, validated with
valibot:

```json
{
  "enabled": true
}
```

Minimal for now. More options can be added later without breaking changes.

## Persistence Format

Each `appendEntry("jj-snapshot", data)` stores:

```typescript
interface SnapshotEntry {
  preOpId: string;        // operation ID before agent ran
  preOpShort: string;
  postOpId: string;       // operation ID after snapshot
  postOpShort: string;
  commitId: string;       // commit at post-op
  commitShort: string;
  changeId: string;       // change at post-op
  changeShort: string;
  timestamp: number;
  summary: string;        // compact one-liner for display
  stat: string;           // full --stat output for widget rebuild
}
```

## Error Handling

- `jj` not installed or not on PATH: silent skip (not a jj user).
- Not a jj repo (no `.jj/` directory): silent skip.
- `jj util snapshot` fails: `notify("pi-jj: snapshot failed: ...", "error")`.
- `jj op diff` or other query fails: show snapshot entry without diff
  detail, `notify` the error.
- Any unexpected error: `notify` with the error message, never crash the
  extension.
