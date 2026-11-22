# 当前 Tauri 平台与构建状态

本分支为 Tauri 2 / Rust 开发版。旧 Electron 的目录构建与发布结论不能用来证明本分支通过。

| 平台 | 产品目标 | 本轮证据 |
|---|---|---|
| macOS Apple Silicon | 原生桌面、系统 WebView、应用包 | 以本轮独立审计报告为准：自动化、隐藏原生 WebView 与受控云端测试分别记录 |
| Windows 10/11 x64 | 原生桌面、WebView2、高速并发传输、本机 Agent 命名管道 | 已交叉编译 x64 主程序、NSIS 安装包与绿色便携 ZIP，并通过 Windows 全目标编译检查；Windows 实机安装/运行验收请按 [WINDOWS_QA_CHECKLIST.md](WINDOWS_QA_CHECKLIST.md) 执行 |
| Linux x64 | Tauri 桌面与 Unix socket | 本轮未原生构建或运行 |
| macOS Intel / Windows ARM64 | 非本轮实际验收平台 | 未验证 |

`src-tauri/tauri.conf.json` 配置的 macOS 最低版本为 11.0；这是一项构建配置，不代表已在该版本实测。现有 CI 配置见 `.github/workflows/p0-compatibility.yml`；配置文件存在不能证明当前代码的 CI 已运行。

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

资料目录：macOS `~/Library/Application Support/cn.quarkdrive.lite.tauri`，Windows `%APPDATA%\cn.quarkdrive.lite.tauri`，Linux `$XDG_CONFIG_HOME/cn.quarkdrive.lite.tauri` 或 `~/.config/cn.quarkdrive.lite.tauri`。`QK_PROFILE_DIR` 可覆盖开发/验收 profile。

会话、Agent 和对话配置均含敏感资料，不能放入代码或交付包。配置损坏时写入会拒绝覆盖原文件；对话配置可通过明确的清除操作重设。Windows 实机验收见 [WINDOWS_QA_CHECKLIST.md](WINDOWS_QA_CHECKLIST.md)。

Windows x64安装版、免安装版和可复现命令见 [Windows构建交付（2026-10-20）](WINDOWS_BUILD_2026-10-20.md)。交叉编译和解包校验不等于Windows真机验收。
