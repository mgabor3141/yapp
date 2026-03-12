# pi-after-hours

> From [yapp](https://github.com/mgabor3141/yapp) · yet another pi pack

Break the late-night engagement loop.

During quiet hours (default 23:00–07:00), you get a configurable number of messages (default 3). After the budget is spent, pi's UI is replaced with a full-screen block until quiet hours end. The agent continues processing your last message normally — check results in the morning.

When auto-sleep is enabled (default), the block screen tracks the agent's progress. Once the agent finishes, a countdown begins and the computer is put to sleep automatically. Press any key to cancel the countdown.

## Install

```bash
pi install npm:pi-after-hours
```

## Configuration

Place `pi-after-hours.json` in `~/.pi/agent/extensions/`:

```json
{
  "enabled": true,
  "quietHoursStart": "23:00",
  "quietHoursEnd": "07:00",
  "messageLimit": 3,
  "warningTime": "23:30",
  "blockMessage": "The agent is working. You can rest now and check results in the morning.",
  "autoSleep": true,
  "autoSleepDelay": 30
}
```

All fields are optional — defaults are shown above.

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable the extension |
| `quietHoursStart` | `"HH:MM"` | When quiet hours begin (local time) |
| `quietHoursEnd` | `"HH:MM"` | When quiet hours end (local time) |
| `messageLimit` | number (≥0) | Messages allowed during quiet hours (0 = block immediately) |
| `warningTime` | `"HH:MM"` | When to show the countdown widget |
| `blockMessage` | string | Text shown on the block screen |
| `autoSleep` | boolean | Suspend the computer after the agent finishes (default: true) |
| `autoSleepDelay` | number (5–300) | Seconds to wait before suspending (default: 30) |

Quiet hours crossing midnight (e.g. 23:00–07:00) are handled correctly.

## Behavior

**Before quiet hours:** Normal operation, no restrictions.

**During quiet hours, before warning time:** Normal operation, no UI changes.

**After warning time (or first message sent):** Widget shows above the editor:
> 🌙 Quiet hours active. 3 messages remaining tonight.

**After final message:** Full-screen block with centered box.

**While agent is working:** Block screen shows "🔄 Agent is still working…"

**When agent finishes:** Countdown begins: "💤 Computer will sleep in 30s" — ticks down every second, then suspends the system (`systemctl suspend` on Linux, `pmset sleepnow` on macOS).

**Cancel auto-sleep:** Press any key (except Ctrl+C/Ctrl+D) to cancel the countdown. The block screen stays but shows "Auto-sleep disabled".

**Exit pi:** Ctrl+C or Ctrl+D exits pi at any time from the block screen.

**Quiet hours end:** The block auto-dismisses when quiet hours end.

**Counter persistence:** Message count is stored in `/tmp/pi-after-hours-{date}.json` and resets daily. A reboot also resets it.

## Commands

- `/after-hours` — Show current status (quiet hours active, budget remaining, auto-sleep config)
