# pi-jujutsu

Live working copy status and repo context for [jj](https://jj-vcs.dev/) repos
in [pi](https://pi.dev). No prompts, no commands, no configuration required.

## Install

```bash
pi install npm:pi-jujutsu
```

Or in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-jujutsu"]
}
```

## What it does

### Footer

In jj colocated repos, pi's footer normally shows `(detached)` because git
sees a detached HEAD. pi-jujutsu replaces this with useful context:

- **Bookmark name** if `@` has one: `(main)`
- **Commit description** otherwise: `(add login endpoint)`
- **Shortest unique change ID** as fallback: `(v)`
- **Stack depth** when working on a stack: `(add login [3])`
- **Empty prefix** when `@` has no changes: `(empty: main)`

### Working copy widget

A colored widget above the editor shows the current working copy diff stat
(`@` vs `@-`), with green/red for insertions and deletions:

```
 src/index.ts  | 48 +++++++++++++++++++++++++++++++++++++-----------
 src/config.ts | 12 ++++++++++++
 2 files (+49, -11)
```

When `@` is empty (e.g. right after `jj commit`), the widget collapses
to a one-liner showing the parent commit:

```
 @- add login endpoint · 2 files (+49, -11)
```

The widget updates live between agent turns and stays visible after the
agent finishes. It also appears on session start if the working copy has
uncommitted changes. Stat bars adapt to terminal width on resize.

Changes from other terminals (e.g. running `jj commit` elsewhere) are
detected automatically and the widget and footer update within moments.

Toggle the widget with `Ctrl+Shift+J`. The widget is display-only;
nothing is sent to the LLM.

## Requirements

- [jj](https://jj-vcs.dev/) installed and on PATH
- A jj repository (colocated or standalone)

The extension silently does nothing in non-jj repos.
