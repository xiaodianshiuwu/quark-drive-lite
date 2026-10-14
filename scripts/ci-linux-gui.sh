#!/usr/bin/env bash
set -euo pipefail
umask 077
temporary=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/qck-ci-gui.XXXXXX")
export XDG_CONFIG_HOME="$temporary/config"
export XDG_DATA_HOME="$temporary/data"
export XDG_CACHE_HOME="$temporary/cache"
export XDG_RUNTIME_DIR="$temporary/runtime"
export XDG_CURRENT_DESKTOP=GNOME
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
export QCK_CI_KEYRING_PASSWORD_FILE="$temporary/password"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))' > "$QCK_CI_KEYRING_PASSWORD_FILE"
# 仅用于测试 profile 的临时密钥环；不会上传该目录或读取已有账号凭据。
dbus-run-session -- bash -c '
  set -euo pipefail
  gnome-keyring-daemon --unlock --components=secrets < "$QCK_CI_KEYRING_PASSWORD_FILE" > /dev/null
  exec xvfb-run -a "$@"
' quark-ci "$@"
