# P0 三平台适配与链路验收

保留 Electron 主进程、preload 白名单及原生 HTML/JS 界面。Electron 固定为 44.7.2，开发使用 Node 24.18+、pnpm 11.25.0。

## 平台与验收边界

| 平台 | 支持目标 | 验证方式 |
|---|---|---|
| Windows | Windows 10/11 x64 | windows-2022 原生 CI；本机生成 x64 目录和便携版 |
| Linux | 主流 x86_64 桌面 | ubuntu-22.04 原生 CI；本机生成 x64 ELF 目录 |
| macOS | macOS 13+ Intel / Apple Silicon | macos-15-intel / macos-15 原生 CI；本机 Apple Silicon 源码和签名产物验证 |

Electron 44 不支持 macOS 12。未增加 Windows ARM64 或 Linux ARM64 支持。
CI 配置见 `.github/workflows/p0-compatibility.yml`；必须以对应提交的作业结果为准，不能把历史通过记录当成本次代码的验收。

## 本机续作（2026-10-14）

PR #1 提供环境和打包配置修复；PR #2 继承 #1，并加入三平台与传输链路修复。
本机续作完成 macOS 构建、登录态迁移、启动和真实账号验收，并按用户要求取消日常系统密码要求。
最终审查、检查数量与 CI 记录见 [审查与验收记录](REVIEW_2026-10-14.md)。

- 本机已验证源码冒烟 28 项、打包产物冒烟 29 项，包含开发工具/产物密文互通。
- Electron 33.4.11 的系统密文可经显式迁移转为 QCK2，打包应用读取迁移资料及重新保存通过。
- 真实账号 E2E 29 项通过：随机文件 8400953 字节上传、搜索、重命名、复制、下载 MD5 回读、移动和自建对象清理。
- P0 扩展真实验收 13 项通过：零字节、UTF-8 名称、多文件并发、33566777 字节上传/下载中断恢复、SHA256 回读、秒传及测试目录清理。
- 服务端自然触发的秒传路径是 `update/hash`；`pre.finish` 分支由离线测试覆盖，本次未自然触发。
- 多 GB 完整回读按用户选择留待后续；5 GiB 稀疏文件测试仅证明偏移处理，不能替代真实大文件传输。

## 免系统密码的登录资料

日常应用和命令行使用本地随机 32 字节密钥与 AES-256-GCM，不调用系统 `safeStorage`，不设置主密码。
密文格式为 QCK2，保存在 `session.bin`；密钥为同 profile 中的 `session.key`。Unix 文件权限为 0600。
密钥和密文同属当前用户数据目录；备份、迁移或恢复时需要同时保存二者。能读取这个目录及密钥的人可以解密资料；本版不提供系统钥匙串的应用隔离。

macOS Chromium 在本应用内使用 `use-mock-keychain`，Linux 使用 `password-store=basic`，避免浏览器内部 Cookie 存储另行访问系统密钥环。
登录窗口使用内存分区 `quark-login`；跨启动登录态由应用本地随机密钥保存。这些设置不修改系统配置、其他应用或 TLS 校验。
Windows 日常应用同样使用本地随机密钥，不设置系统密码交互。

旧 QCK1 系统密文是独立的兼容场景。需要时先运行：

```bash
npm run migrate-session
```

该命令只在迁移旧格式时使用原系统解密，可能需要一次原系统授权；迁移后日常启动不再调用它。
原密文保留为 `session.bin.legacy-QCK1`。普通应用不会弹出旧系统密码窗口；未迁移的旧资料可重新登录，首次保存新资料时保留原件。
真实登录资料、密钥、旧密文备份、运行日志和测试 profile 均不提交。

默认用户目录：Windows `%APPDATA%/quark-mini`，macOS `~/Library/Application Support/quark-mini`，Linux `$XDG_CONFIG_HOME/quark-mini` 或 `~/.config/quark-mini`。
CLI 可用 `QCK_USER_DATA_DIR` 指定 profile。默认下载目录采用 Electron 的原生目录接口，既有自定义路径保持有效。

## 安装、验证与构建

```bash
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
npm run check
npm run verify:all
npm run verify:encryption
npm start
```

Linux 无显示会话使用 Xvfb；日常应用不再要求 Secret Service 解锁。旧格式兼容 CI 仍使用临时 D-Bus/密钥环生成旧样本。

```bash
npm run pack:win     # 明确 x64；在 Apple Silicon 上也不会误生成 ARM64
npm run pack:linux   # 明确 x64
npm run pack:mac
node verify/packaged-smoke.js
```

所有构建显式 `--publish never`。macOS 在 `~/Library/Caches/quark-mini-builds/<项目标识>/` 构建并 ad-hoc 签名，
避免 Documents 文件提供者持续重建 FinderInfo 导致签名失败。`.work/macos-build.json` 记录真实产物位置，冒烟和 CI 读取该清单。
签名之前只清理新生成的构建目录元数据。Developer ID、正式公证和首次安装 Gatekeeper 验证不在本次本地签名验收内。
跨平台生成 Windows/Linux 产物不等于在目标系统实际运行；原生验收由对应 CI 作业完成。

旧格式迁移与产物兼容：

```bash
node scripts/prepare-legacy-runtime.js
node verify/encryption-roundtrip.js --legacy
QCK_SMOKE_SEED_LEGACY=1 node verify/packaged-smoke.js
```

旧运行时 33.4.11 来自官方发布并检查 SHA256，仅位于忽略目录 `.work/`，不进入产品构建。
macOS CI 的临时旧样本使用 ad-hoc 签名；随机测试密钥在独立 CI 密钥环内授权测试进程，签名分区保持校验；不读取或修改用户钥匙串。

真实账号验收只操作专用自建目录：

```bash
npm run e2e
npm run verify:p0-real
# 用户明确选择继续多 GB 验收时：
npm run verify:p0-real -- --large
```

## 传输完成判定与保留范围

上传前记录同名文件，完成后核对目标可见性与大小。旧同名等长文件、多个新增同名文件、大小不符不能直接标记成功。
提交后的核对重试复用原结果，不重复预登记或上传；本地文件变化时拒绝复用。无法确认的同 fid 覆盖保守提示核对，不猜测成功、不自动删除远端文件。
目录可见性与大小不能代替内容哈希，因此真实验收使用下载回读哈希。
零字节 Range 416、截断、错误 Range、取消、登录失效、重名避让和超过 4 GiB 的偏移均有离线覆盖。

本次保留顺序 PUT 与分片预读；不增加跨重启队列恢复、文件夹传输或虚拟列表。
HTTP/Chromium/Node 网络栈遵循环境代理，保持 TLS 校验。未登录文件 IPC 在本地返回 NEED_LOGIN。
项目是纯 JavaScript，无独立 TypeScript 配置；静态检查执行 JavaScript 语法与正式打包配置校验。
