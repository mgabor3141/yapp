# pi-desktop-notify

> From [yapp](../../) · yet another pi pack

Desktop notifications for terminal applications. Focus-aware — suppresses notifications when the terminal is in the foreground. Click-to-focus brings the terminal back when you interact with a notification.

## Features

- **Focus tracking** — detects terminal focus via DECSET 1004 escape sequences. Notifications are suppressed while the terminal is focused (configurable).
- **Click-to-focus** — clicking a notification focuses the terminal window. Supports macOS, niri, sway, and hyprland.
- **Cross-platform** — macOS via `terminal-notifier`, Linux via `notify-send`.
- **Zero dependencies** — uses `node:child_process` directly.

## Install

As a pi extension:
```bash
pi install pi-desktop-notify
```

As a library:
```bash
npm install pi-desktop-notify
```

### Platform requirements

**macOS:** Install [terminal-notifier](https://github.com/julienXX/terminal-notifier):

```bash
brew install terminal-notifier
```

**Linux:** `notify-send` (usually pre-installed, part of `libnotify`).

## Usage

```typescript
import {
  sendNotification,
  startFocusTracking,
  captureWindowId,
} from "pi-desktop-notify";

// Call once at startup
startFocusTracking();     // begin tracking terminal focus
await captureWindowId();  // capture window ID for click-to-focus

// Send notifications
await sendNotification({
  title: "Task complete",
  body: "Build finished successfully",
});

// Notifications are suppressed when focused (default).
// Override with skipIfFocused: false
await sendNotification({
  title: "Important",
  body: "Something needs attention",
  skipIfFocused: false,
});
```

## API

### `sendNotification(options)`

Send a desktop notification.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | `string` | required | Notification title |
| `body` | `string` | required | Notification body |
| `cwd` | `string` | `process.cwd()` | Working directory (used for macOS click-to-focus in Zed) |
| `skipIfFocused` | `boolean` | `true` | Suppress when terminal is focused |

### `startFocusTracking()`

Start tracking terminal focus via DECSET 1004. Idempotent — safe to call multiple times. Listens on `process.stdin` for focus in/out escape sequences.

### `stopFocusTracking()`

Stop tracking and disable focus reporting.

### `isTerminalFocused()`

Returns `true` if the terminal is currently focused. Defaults to `true` before tracking starts.

### `captureWindowId()`

Capture the currently focused window's compositor ID. Call when the terminal is guaranteed to be focused. Used by `focusWindow()` for click-to-focus on notifications.

### `focusWindow()`

Focus the previously captured terminal window. Called automatically on notification click.

## How it works

**Focus tracking** uses the DECSET 1004 terminal escape sequence. When enabled, the terminal sends `\x1b[I` (focus gained) and `\x1b[O` (focus lost). These are intercepted on `process.stdin` before other handlers see them. Works with kitty, wezterm, foot, alacritty, iTerm2, Zed, and most modern terminals. Also works through tmux and abduco.

**Click-to-focus** captures the terminal's window ID at initialization, then uses compositor-specific commands to focus it when a notification is clicked:

| Platform | Method |
|----------|--------|
| macOS | `osascript` / `terminal-notifier -activate` |
| niri | `niri msg action focus-window --id` |
| sway | `swaymsg [con_id=...] focus` |
| hyprland | `hyprctl dispatch focuswindow address:...` |
