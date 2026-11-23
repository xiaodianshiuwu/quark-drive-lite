#!/usr/bin/env bash
set -euo pipefail

executable=$1
screenshot=$2
profile=$(mktemp -d)
app_pid=
wm_pid=
cleanup() {
  if [[ -n $app_pid ]]; then kill "$app_pid" 2>/dev/null || true; fi
  if [[ -n $wm_pid ]]; then kill "$wm_pid" 2>/dev/null || true; fi
  rm -rf "$profile"
}
trap cleanup EXIT

openbox &
wm_pid=$!
export QK_PROFILE_DIR="$profile"
# Run the AppImage via its embedded runtime even on runners without /dev/fuse.
export APPIMAGE_EXTRACT_AND_RUN=1
"$executable" &
app_pid=$!
window=$(timeout 45s xdotool search --sync --onlyvisible --name '^夸克网盘 · 极简版$')
kill -0 "$app_pid"
test -f "$profile/app.lock"

# Capture the packaged window after the embedded UI has loaded.
sleep 3
import -window "$window" "$screenshot"
wmctrl -ic "$(printf '0x%x' "$window")"
timeout 15s tail --pid="$app_pid" -f /dev/null
wait "$app_pid"
app_pid=
echo "Packaged window opened and exited cleanly: $executable"
