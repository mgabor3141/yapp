# pi-no-soft-cursor

Remove the reverse-video block cursor from pi's editor. Your terminal's native blinking cursor still shows the insertion point — just without the highlighted character block drawn on top.

## Install

```bash
pi install npm:pi-no-soft-cursor
```

## What it does

Pi's text editor renders a "soft cursor": the character under the cursor is shown in reverse video (a highlighted block). Some terminals already show a blinking cursor via the hardware cursor marker, making the soft cursor redundant or visually noisy.

This extension:

1. **Strips the soft cursor** — patches editor rendering to remove the last reverse-video span from each rendered line (the one the editor uses for the cursor block).
2. **Still works with editor-overriding extensions** — if another extension installs its own editor component, this package wraps that editor too instead of fighting to be the last `setEditorComponent()` call.
3. **Forces the hardware cursor on** — pi has a "Show hardware cursor" setting that is off by default. This extension enables it unconditionally so the terminal's native cursor is always visible.

> **Note:** With this extension active, pi's "Show hardware cursor" setting has no effect — the hardware cursor is always enabled.

## Setup

After installing, reload pi with `/reload` or restart it.

## Configuration

None. Install and it works.
