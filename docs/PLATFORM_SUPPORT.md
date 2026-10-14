# 平台支持与构建

本文件说明应用支持的平台范围、构建方式，以及各平台实际验证到什么程度。

## 平台支持

| 平台 | 支持目标 | 构建目标 | 验证方式 |
|---|---|---|---|
| Windows | Windows 10 / 11 x64 | 便携版目录 + NSIS 安装包 | `windows-2022` 原生 CI；本机生成目录与便携版并冒烟 |
| Linux | 主流 x86_64 桌面发行版 | 目录形式（`dir`），无 AppImage / deb / rpm | `ubuntu-22.04` 原生 CI；本机生成 x64 目录 |
| macOS | macOS 13 或更高，Intel 与 Apple Silicon | 目录形式（`dir`） | `macos-15-intel` / `macos-15` 原生 CI |

- 运行时固定为 Electron 44.7.2。Electron 44 不支持 macOS 12，因此最低系统版本为 macOS 13。
- 暂不支持 Windows ARM64 与 Linux ARM64。
- 跨平台生成产物不等于在目标系统实际运行；原生运行验证由对应平台的 CI 作业完成。

## 发布产物

预发布由 [`.github/workflows/release-prerelease.yml`](../.github/workflows/release-prerelease.yml) 在指定的三平台验证运行全部成功后创建，产物命名规则为：

```
quark-drive-lite-<版本>-Windows-x64.zip
quark-drive-lite-<版本>-Linux-x64.tar.gz
quark-drive-lite-<版本>-macOS-arm64.zip
quark-drive-lite-<版本>-macOS-x64.zip
```

每个产物附带同名 `.sha256` 校验文件。发布作业会逐一校验产物哈希，附件数量或哈希不符时不会创建发布。

各产物的内容与运行方式见 [README 的下载与安装章节](../README.md#下载与安装)。

### 签名状态

| 平台 | 签名 |
|---|---|
| Windows | 未做发行者代码签名（`signAndEditExecutable: false`） |
| macOS | ad-hoc 签名（`identity: "-"`），未做 Developer ID 签名与 Apple 公证 |
| Linux | 不涉及 |

因此 Windows 首次运行会出现 SmartScreen 提示，macOS 首次打开需要右键选择「打开」或在「隐私与安全性」中放行。

## 从源码构建

### 环境要求

| 项目 | 版本 |
|---|---|
| Node.js | 24.18.0 或更高 |
| pnpm | 11.25.0 |
| Electron | 44.7.2（由依赖锁定） |

```bash
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
```

### 构建命令

```bash
npm run pack:win     # Windows x64 目录构建，随后生成便携版
npm run pack:linux   # Linux x64 目录构建
npm run pack:mac     # macOS 目录构建与 ad-hoc 签名（需在 macOS 上执行）
```

所有构建显式使用 `--publish never`，不会自动上传产物。

macOS 构建在 `~/Library/Caches/quark-mini-builds/<项目标识>/` 下完成并签名，产物位置记录在 `.work/macos-build.json`，冒烟脚本与 CI 通过该清单定位产物。这样安排是因为在受文件提供者管理的目录（例如「文稿」）内签名会受到 FinderInfo 竞态影响。

Windows 便携版由 `tools/make-portable.js` 生成：它会比对应用归档内 `package.json` 的版本，并逐字节校验 `src/` 中的全部文件与归档内容一致，不一致时直接报错，避免用旧缓存产出发布包。

### Linux 无显示环境

无图形会话下运行需要虚拟显示：

```bash
xvfb-run -a npm run verify:smoke
```

CI 使用 `scripts/ci-linux-gui.sh` 提供一次性的图形与密钥环环境，仅用于自动化验收。

## 验证范围

### 自动化层次

| 层次 | 命令 | 说明 |
|---|---|---|
| 静态检查 | `npm run check` | JavaScript 语法与打包配置 |
| 单元测试 | `npm test` | 纯 Node，不需要 Electron、网络或登录 |
| 集成验证 | `npm run verify` | 模块装配与请求构造，纯 Node |
| 冒烟测试 | `npm run verify:smoke` | 真实启动 Electron，检查桥接契约、沙箱隔离与界面元素 |
| 真实账号 E2E | `npm run e2e` | 需要先登录，只操作测试自建的目录与文件 |

`npm run verify:all` 依次运行单元测试、集成验证与冒烟测试。

### 已完成验证的内容

- 三平台目录构建与产物冒烟，包括打包应用的启动与界面渲染。
- 登录资料的加密存储与跨进程回读，以及旧格式的显式迁移。
- 真实账号下的登录判活、目录分页、新建目录、分片上传、搜索、重命名、复制、下载内容校验、移动、批量删除与清理。
- 中断恢复：32 MiB 级别文件的上传与下载中断后恢复，并通过内容哈希回读校验。
- 零字节文件、含中日韩字符的文件名、多文件并发、重复内容秒传与临时文件收尾。

### 明确未完成的验证

- **多 GB 文件的完整上传下载回读**尚未执行。当前完成的规模为 32 MiB。
  5 GiB 稀疏文件的测试只能证明偏移处理正确，不能替代真实大文件传输。
- **长时间弱网场景**未做专项验证。
- **与官方客户端的性能对比**未做实测。
- 秒传的 `pre.finish` 分支有离线测试覆盖，但未在真实服务端自然触发；实际自然触发的是 `update/hash` 路径。
- 扫码登录与系统原生文件拖拽属于人工交互，未在自动化中代替用户完成。

## 登录资料与用户目录

登录状态使用本机随机 32 字节密钥与 AES-256-GCM 加密保存，不调用系统 `safeStorage`，也没有主密码。日常启动不触发系统钥匙串或密钥环授权。

| 文件 | 内容 |
|---|---|
| `session.bin` | 加密后的登录资料与设置（密文格式 `QCK2`） |
| `session.key` | 本机随机密钥（32 字节） |

两个文件位于同一用户数据目录，Unix 权限为 `0600`，目录为 `0700`。它们不具备系统钥匙串级别的应用隔离：能读取该目录的人即可解密。**备份、迁移或恢复时必须同时保存这两个文件。**

默认用户数据目录：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\quark-mini` |
| macOS | `~/Library/Application Support/quark-mini` |
| Linux | `$XDG_CONFIG_HOME/quark-mini` 或 `~/.config/quark-mini` |

命令行工具可用 `QCK_USER_DATA_DIR` 指定其他 profile 目录。

### 旧格式迁移

早期版本使用系统加密保存登录资料。如果需要继续使用旧资料，可显式执行迁移：

```bash
npm run migrate-session
```

迁移会把原密文保留为 `session.bin.legacy-QCK1`，再写入新格式。在 macOS 上迁移旧格式可能需要一次系统授权；未迁移时也可以在应用内重新登录。

## 相关文档

| 文档 | 内容 |
|---|---|
| [README](../README.md) | 下载、安装与使用说明 |
| [CHANGELOG](CHANGELOG.md) | 版本变更记录 |
| [DEVELOPMENT](DEVELOPMENT.md) | 架构、模块职责与开发约定 |
| [API_NOTES](API_NOTES.md) | 接口参考与证据链 |
