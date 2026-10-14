#!/usr/bin/env bash
set -euo pipefail
# 仅允许在临时 CI 机器创建独立验收密钥环，不能用于用户日常系统。
if [ "${CI:-}" != true ] || [ -z "${RUNNER_TEMP:-}" ]; then
  echo '此脚本仅用于 CI 临时密钥环。' >&2
  exit 1
fi
umask 077
keychain="$RUNNER_TEMP/quark-ci.keychain-db"
executables=$(node -e 'console.log(require("electron")); console.log(require("./.work/legacy-runtime.json").executable)')
# 源码测试 profile 已清理；产物阶段使用新的测试密钥环，避免签名工具改变前一阶段的状态。
if [ "${1:-}" = --authorize-packed ]; then
  keychain="$RUNNER_TEMP/quark-ci-packed.keychain-db"
  executable=$(node -e 'console.log(require("./.work/macos-build.json").executable)')
  codesign --verify --deep --strict "$(dirname "$(dirname "$(dirname "$executable")")")"
  executables="$executables"$'\n'"$executable"
elif [ -n "${1:-}" ]; then
  echo '未知的 CI 密钥环阶段。' >&2; exit 1
fi
if [ -e "$keychain" ]; then echo '验收密钥环已存在，拒绝覆盖。' >&2; exit 1; fi
keychain_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
echo "::add-mask::$keychain_password"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security list-keychains -d user -s "$keychain"
security default-keychain -d user -s "$keychain"
security default-keychain
# ACL 与签名分区是两个独立条件；此处只有临时随机测试密钥，不读取用户资料。
# ad-hoc 主应用与其 Chromium 辅助进程均属于 unsigned 分区；这些许可仅覆盖随机测试密钥。
partition_list='apple-tool:,apple:,unsigned:'
trusted_apps=()
while IFS= read -r executable; do
  trusted_apps+=(-T "$executable")
  signature=$(codesign -dv --verbose=4 "$executable" 2>&1 || true)
  cdhash=$(printf '%s\n' "$signature" | sed -n 's/^CDHash=//p')
  team=$(printf '%s\n' "$signature" | sed -n 's/^TeamIdentifier=//p')
  # 有团队签名的旧运行时以 teamid 判定分区；ad-hoc 应用以 cdhash 判定。
  if [ -n "$team" ] && [ "$team" != 'not set' ]; then
    partition_list="$partition_list,teamid:$team"
  fi
  if [ -z "$cdhash" ]; then
    if [[ "$signature" == *'code object is not signed at all'* ]]; then
      partition_list="$partition_list,unsigned:"
      continue
    fi
    echo '无法读取测试运行时签名。' >&2; exit 1
  fi
  partition_list="$partition_list,cdhash:$cdhash"
done <<< "$executables"
# Electron 的服务名为 app_name + Safe Storage。临时随机测试密钥允许 CI 进程读取，避免不同辅助进程身份触发许可弹窗。
# 每个应用名称使用不同口令，保持跨版本应用名称不一致时的解密失败可被检测。
for app_name in quark-mini Electron Chrome Chromium '夸克网盘极简版'; do
  fixture_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
  echo "::add-mask::$fixture_password"
  security add-generic-password -a "$app_name" -s "$app_name Safe Storage" -w "$fixture_password" -A "$keychain"
  security set-generic-password-partition-list -a "$app_name" -s "$app_name Safe Storage" -S "$partition_list" -k "$keychain_password" "$keychain" >/dev/null
done
unset keychain_password fixture_password signature
