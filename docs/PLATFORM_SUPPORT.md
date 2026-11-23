# 当前 Tauri 平台与构建状态

本页记录 v1.0.0 Tauri 2 / Rust 客户端的平台支持。

| 平台 | 产品目标 | 本轮证据 |
|---|---|---|
| macOS Apple Silicon | 原生桌面、系统 WebView、应用包 | 以本轮独立审计报告为准：自动化、隐藏原生 WebView 与受控云端测试分别记录 |
| Windows 10/11 x64 | 原生桌面、WebView2、高速并发传输、本机 Agent 命名管道 | 已在真实 Windows 11 家庭版 24H2（Build 26100，x64，WebView2 `157.0.4341.60`）完成实机验证：154/154 原生 Rust 测试（含 Windows `seek_write` 并发传输、`\\.\pipe\...` 命名管道网关与跨语言 Hub E2E）、65/65 Chrome/Node 前端测试、27/27 Edge WebView2 原生冒烟、SHA256 核验、中文空格路径便携版启动/单实例锁/真机截图/零残留退出，以及 NSIS 当前用户静默安装/启动/卸载清理；真机真实账号扫码登录与云端大文件传输入库见 [WINDOWS_QA_CHECKLIST.md](WINDOWS_QA_CHECKLIST.md) |
| Linux x64 | DEB、AppImage、WebKitGTK 4.1 与 Unix socket | Ubuntu 22.04 x64 原生构建。Rust 159 项、前端 66 项。X11 原生桌面 36 项检查通过，覆盖文件与目录选择、确认框、Thunar 文件选中、原生拖拽及关闭登录窗口。Weston 无头 Wayland 的 WebKitGTK 冒烟 30 项通过。 |
| macOS Intel x64 | 应用 ZIP、WKWebView 与 Unix socket | macOS 15 Intel 原生构建。Rust 159 项、前端 66 项、WKWebView 冒烟 29 项全部通过。ZIP 解包、x86_64 架构、本地签名和启动通过。 |
| Windows ARM64 | | 未验证 |

`src-tauri/tauri.conf.json` 配置的 macOS 最低版本为 11.0；这是一项构建配置，不代表已在该版本实测。现有 CI 配置见 `.github/workflows/p0-compatibility.yml`；配置文件存在不能证明当前代码的 CI 已运行。

[查看 GitHub Actions 原生测试和打包记录](https://github.com/xiaodianshiuwu/quark-drive-lite/actions/runs/45166907866)。

## Linux 安装包

- 在 x86_64 桌面上运行。DEB 由 APT 安装，系统需提供 GTK 3 和 WebKitGTK 4.1。Ubuntu 22.04 是构建和验证基线。
- AppImage 运行时需要兼容的 Linux 桌面和 FUSE 2。没有 FUSE 时可运行 `./QuarkDriveLite-1.0.0-Linux-x64.AppImage --appimage-extract-and-run`。
- 文件、目录选择和确认均使用 GTK 原生对话框。桌面可使用 XDG 门户。支持 `org.freedesktop.FileManager1` 的文件管理器会选中文件，其他桌面会打开相应目录。
- 构建与验收命令见[兼容性工作流](../.github/workflows/p0-compatibility.yml)。Windows、macOS 与 Linux 分别使用原生构建环境。

## Linux 真实账号验收

在隔离 Ubuntu 22.04 x64 会话中实际完成扫码登录，通过生产接口验证了沙盒测试目录中的 32 MiB 上传、改名、复制、移动、搜索、下载暂停和恢复，上传前与下载后的 SHA-256 一致。测试目录随后移入回收站，客户端确认它已离开原位置。

## 开发与构建

安装 README 所述原生构建依赖及 Node.js 24，执行：

```sh
npm ci
cargo test --workspace --locked
npm test
npm run verify:native
npm run build
```

`npm test` 在检测到 Chrome 时启动独立无头会话，退出后清理；无浏览器时会明确跳过浏览器套件。可用 `QCK_BROWSER_PATH` 指定浏览器可执行文件。

`verify:native` 使用隔离临时 profile 和隐藏窗口，验证真实 Tauri IPC；不读取用户登录资料。GUI 文件选择、真实扫码或 Windows 真机操作不能由此替代。

macOS 构建默认只生成 `.app`，脚本验证完整 bundle 的本地签名，必要时进行 ad-hoc 签名；不代表 Developer ID 签名或 Apple 公证。构建不会自动发布。`scripts/build-env.js` 默认把产物放到按工作区哈希区分的用户缓存中，也可显式设置 `CARGO_TARGET_DIR`。

桌面应用本身不需要 Node。外部 MCP 客户端使用 `node` 运行应用内置并安装到 `<profile>/agent/adapters/<内容哈希>/` 的脚本，需能找到 Node.js；不再依赖源码树当前目录。

资料目录：macOS `~/Library/Application Support/cn.quarkdrive.lite.tauri`，Windows `%APPDATA%\cn.quarkdrive.lite.tauri`，Linux `$XDG_DATA_HOME/cn.quarkdrive.lite.tauri` 或 `~/.local/share/cn.quarkdrive.lite.tauri`。`QK_PROFILE_DIR` 可覆盖开发/验收 profile。

会话、Agent 和对话配置均含敏感资料，不能放入代码或交付包。配置损坏时写入会拒绝覆盖原文件；对话配置可通过明确的清除操作重设。Windows 实机验收见 [WINDOWS_QA_CHECKLIST.md](WINDOWS_QA_CHECKLIST.md)。

Windows x64安装版、免安装版和可复现命令见 [Windows构建交付（2026-10-20）](WINDOWS_BUILD_2026-10-20.md)。交叉编译和解包校验不等于Windows真机验收。
