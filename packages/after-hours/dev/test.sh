#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "Error on line $LINENO: $BASH_COMMAND" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"

# --- Usage ---
usage() {
  cat <<EOF
Usage: $(basename "$0") [preset] [-- pi-args...]

Builds the extension and launches pi with a test config preset.
Everything after -- is passed through to pi.

Presets (from dev/):
  quick       Always quiet hours, 2 messages, no auto-sleep (default)
  immediate   Always quiet hours, 0 messages (instant block)
  sleep       Always quiet hours, 2 messages, 10s auto-sleep countdown
  default     Production defaults (only active 23:00–07:00)

Examples:
  ./dev/test.sh                     # quick preset
  ./dev/test.sh sleep               # test auto-sleep countdown
  ./dev/test.sh immediate           # instant block screen
  ./dev/test.sh -- -p "hello"       # quick preset, print mode
EOF
  exit 0
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage

# --- Parse args ---
PRESET="${1:-quick}"
shift || true

# Consume -- separator if present
[[ "${1:-}" == "--" ]] && shift

CONFIG="$SCRIPT_DIR/$PRESET.json"
if [[ ! -f "$CONFIG" ]]; then
  echo "Unknown preset: $PRESET" >&2
  echo "Available: $(ls "$SCRIPT_DIR"/*.json | xargs -I{} basename {} .json | tr '\n' ' ')" >&2
  exit 1
fi

# --- Build ---
echo "Building..."
(cd "$PKG_DIR" && yarn build 2>&1 | grep -E '(error|Build success)' || true)

# --- Launch ---
echo "Preset: $PRESET ($CONFIG)"
echo "---"
exec env PI_AFTER_HOURS_CONFIG="$CONFIG" \
  pi -ne -e "$PKG_DIR/dist/index.js" --no-skills --no-prompt-templates --no-session "$@"
