#!/usr/bin/env bash
# Run under an isolated Xvfb and D-Bus session.
set -euo pipefail

binary=$(realpath "$1")
report=$(realpath -m "$2")
sandbox=$(mktemp -d)
mkdir -p "$(dirname "$report")" "$sandbox/files/chosen"
echo "Linux desktop fixture" >"$sandbox/files/upload fixture.txt"
export LANG=C.UTF-8 GDK_BACKEND=x11 GTK_USE_PORTAL=0
export QK_PROFILE_DIR="$sandbox/profile" QK_SMOKE_REPORT="$report" QK_SMOKE_DESKTOP=1 QK_SMOKE_EXIT=1
export QK_SMOKE_SOURCE="$sandbox/files"

app_pid=
wm_pid=
file_manager_pid=
drag_pid=
cleanup() {
  for pid in "$app_pid" "$file_manager_pid" "$drag_pid" "$wm_pid"; do
    if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$sandbox"
}
trap cleanup EXIT
openbox &
wm_pid=$!
dbus-update-activation-environment DISPLAY XAUTHORITY
thunar --daemon &
file_manager_pid=
drag_pid=$!
"$binary" &
app_pid=$!

find_window() {
  local windows
  echo "Waiting for window: $1" >&2
  if ! windows=$(timeout 25s xdotool search --onlyvisible --sync "${2:---name}" "$1"); then
    wmctrl -lx >&2
    if [[ -f $report ]]; then cat "$report" >&2; fi
    return 1
  fi
  printf '%s\n' "${windows%%$'\n'*}"
}

choose() {
  local chooser
  chooser=$(find_window "$1")
  xdotool windowactivate --sync "$chooser"
  xdotool key --clearmodifiers ctrl+l
  xdotool type --clearmodifiers "$2"
  xdotool key Return
}

main=$(find_window '^夸克网盘 · 极简版$')
choose '^选择文件$' "$QK_SMOKE_SOURCE/upload fixture.txt"
choose '^选择文件夹$' "$QK_SMOKE_SOURCE/chosen"
save=$(find_window '^选择保存目录$')
xdotool windowactivate --sync "$save" key Escape
confirm=$(find_window '^Linux QA 确认$')
xdotool windowactivate --sync "$confirm"
eval "$(xdotool getwindowgeometry --shell "$confirm")"
xdotool mousemove --window "$confirm" "$((WIDTH - 55))" "$((HEIGHT - 24))" click 1

files=$(find_window '[Tt]hunar' --class)
xdotool windowactivate --sync "$files"
# ShowItems must select the test file. F2 opens the rename dialog only on a selection.
xdotool key F2
rename=$(find_window '^Rename')
xdotool windowactivate --sync "$rename" key Escape
# Use another GTK process as the drag source so the test sends a real Xdnd offer.
python3 - "$QK_SMOKE_SOURCE/upload fixture.txt" <<'PYGTK' &
import sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, Gio, Gtk
window = Gtk.Window(title="QDL drag source")
window.set_default_size(240, 120)
button = Gtk.Button(label="Drag file")
uri = Gio.File.new_for_path(sys.argv[1]).get_uri()
button.drag_source_set(Gdk.ModifierType.BUTTON1_MASK,
                       [Gtk.TargetEntry.new("text/uri-list", 0, 0)], Gdk.DragAction.COPY)
button.connect("drag-data-get", lambda source, context, data, info, time: data.set_uris([uri]))
window.add(button)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
PYGTK
drag_pid=$!
source=$(find_window '^QDL drag source$')
wmctrl -i -r "$(printf '0x%x' "$main")" -e 0,385,70,1000,780
wmctrl -i -r "$(printf '0x%x' "$source")" -e 0,5,25,240,120
xdotool windowactivate --sync "$source"
xdotool mousemove --window "$source" 100 60 mousedown 1 sleep 0.2 mousemove 275 125 sleep 0.3 mousemove --window "$main" 540 330 sleep 0.8 mouseup 1

login=$(find_window '^登录夸克网盘 · 扫码后自动返回$')
# Let the login loop read the WebKitGTK cookie store before closing the window.
sleep 4
wmctrl -ic "$(printf '0x%x' "$login")"
timeout 20s tail --pid="$app_pid" -f /dev/null
wait "$app_pid"
app_pid=
node -e 'const report=require(process.argv[1]); if (!report.passed) { console.error(report); process.exitCode=1; } else { console.log(report.checks.length+" native checks passed"); }' "$report"
