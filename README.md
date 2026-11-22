# 夸克网盘极简版 · Quark Drive Lite

> **v0.3.0-beta.1（Tauri 2 + Rust 正式主线）**  
> 本版本已完成从 Electron 向 **Tauri 2 + Rust 原生核心** 的全量替换：更小安装包、更低内存占用、更快启动与传输响应，同时完整保留并升级所有网盘核心能力。

## 核心特性

- **轻量原生架构（Tauri 2 + Rust）**：系统 WebView 承载本地界面，Rust 核心负责会话加密、网盘协议与自研高速分片传输引擎；已精简移除重装前备份模块与 SQLite 依赖，体积更小、内存更低，运行不依赖 Node.js 或 Electron。
- **高效文件管理工作台**：
  - 完整多级目录导航：工具栏「后退 / 前进 / 上一级」按钮、深层目录智能面包屑（4 级及以上常驻根目录 + 中间层级「···」一键下拉直达 + 鼠标滚轮与 `<`/`>` 箭头横向滚动，兼顾 Mac 触控板与 Windows 鼠标用户）、鼠标侧键与 `Alt+↑` / `Backspace` / `Alt+←` / `Alt+→` 快捷键；对服务端异常路径响应内置多重兜底。
  - 文件浏览增强：分类快筛（全部 / 文件夹 / 图片 / 视频 / 文档 / 音频 / 压缩包）、子工具栏实时传输状态胶囊（传输中实时展示速度、进度与当前文件）、多字段排序、列表/网格双视图切换、右侧可收起「文件详情」面板、底部实时状态栏。
  - 智能自动刷新：当前目录每 60 秒后台静默刷新；账号状态与网盘剩余空间每 90 秒后台同步一次（上传/删除完成或恢复前台时立即补刷）；下载/上传队列 `< 10` 个任务时每完成一项自动刷新，`≥ 10` 个任务时每 15 秒节流刷新并在批次完成后补一次收尾刷新，刷新不闪屏、不丢失滚动与选中态。
  - 目录切换 SWR 本地缓存 + 同步节点池虚拟滚动（大目录流畅无卡顿）、拖拽上传、复选框增量多选、右键上下文菜单（支持单文件/多选「下载到指定位置…」与空白处新建/刷新）。
  - 升级版目录选择器：支持「上一级」与弹窗内直接「新建文件夹」，移动/复制目标路径实时预览。
- **高速自研传输引擎**：
  - Rust 事件驱动调度器（空闲零轮询、状态即时推送），支持并发分片上传（2 MiB 同步分片读取 + 批量检查点持久化 + SHA-1 前缀状态握手）与多线程分片下载（自适应 1–4 MiB 分片 + 单共享句柄无锁随机位置写入 + 256 KiB 缓冲写入 + 单流边写边算哈希 + 强 ETag 绑定与断点续传）。
  - 灵活下载目录：支持默认同一文件夹保存，也可切换为「每次询问目录」或右键/详情栏单文件「下载到指定位置…」。
  - 宽松并发上限与阈值提醒：取消下载/上传并发数人工硬上限（不设限），超出推荐阈值时在设置页主动提醒（防止内存升高、卡顿或限流）。
  - 传输筛选标签（全部 / 进行中 / 已暂停 / 已完成 / 失败）、实时总速率展示、一键「全部暂停 / 全部继续 / 重试失败」、侧栏常驻速率胶囊与容量进度条。
- **可选的作者服务器连接（默认关闭 · 零外传承诺）**：
  - 首次启动弹窗询问是否开启连接，随时可在设置页开关。**未开启时 Rust 底层强制拦截，绝不向作者服务器发送任何请求或数据。**
  - 开启后支持：① 接收最新更新日志、公告通知并从作者服务器直链下载经 **Ed25519 验签 + SHA-256 校验** 的安装包；② 侧栏「反馈」直接向作者提交建议或问题（可选附带并预先查看脱敏运行日志）；③ 匿名上传严格脱敏的非敏感错误/性能/传输速度摘要（绝不含文件名、路径、Cookie、账号或隐私）。
  - 全链路采用 **HTTPS TLS 1.3 + X25519/AES-256-GCM 端到端前向保密加密**；服务端配套独立管理控制台（源码位于 `server/qdl-hub/`，不含任何私钥或密码）。服务器部署于海外节点（日本东京），国内直连如遇失败或延迟可开启代理/梯子重试，不连接也完全不影响网盘本地核心使用。
- **AI 实验室（Beta 测试功能 · 默认关闭）**：
  - 包含「内置对话（Beta）」与「Agent 接入 / MCP 网关（Beta）」。
  - **默认关闭**，不展示入口、不启动后台网关；如需体验，请手动进入 **设置 → AI 实验室（Beta 测试功能）** 开启后使用，可随时关闭恢复极简网盘模式（已保存配置保留）。
  - 外部 Agent 默认只读，写入/删除需显式授权目录与权限并经二次确认，操作记录自动脱敏保存于本地 `agent/journal.jsonl`。

## 数据与隐私安全

- **独立资料目录**：macOS `~/Library/Application Support/cn.quarkdrive.lite.tauri`；Windows `%APPDATA%\cn.quarkdrive.lite.tauri`；Linux `$XDG_DATA_HOME/cn.quarkdrive.lite.tauri`。
- **本地加密存储**：登录态采用 QCK2 AES-256-GCM 加密保存在本机资料目录；扫码登录在独立原生窗口完成，Cookie 仅由 Rust 后端读写发送，不注入渲染页。
- **默认零外传 / 严格脱敏**：界面无外链脚本与远程字体，严格 CSP 零 `innerHTML` 渲染；可选的作者服务器连接默认关闭（关闭状态下零网络请求），开启后仅在端到端加密下发送经客户端与服务端双重脱敏的非敏感摘要；开启 AI 对话时仅直连用户自行填写的 OpenAI 兼容服务地址，API Key 本地加密只写不读。

## 开发与验证

需要 Rust stable、Node.js 24 与对应平台的 [Tauri 2 原生构建依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci --ignore-scripts
npm start
```

常用检查与打包命令：

```sh
npm run check          # JS 语法 / JSON 配置 + Rust workspace 静态检查
npm run test:rust      # Rust 全量单元测试（core / transfer / backup / agent / tauri）
npm test               # 前端契约、AI Beta 门控、Agent/Chat/Backup 及无头 Chrome DOM 回归测试
npm run verify:native  # 启动原生 Tauri WebView 运行端到端冒烟验收
npm run verify:all     # 一键运行以上全部验证
npm run build          # 打包当前平台桌面客户端
```

> `npm start` / `npm run build` 自动将 Rust 构建缓存置于用户缓存目录，避免云盘同步目录引发签名或锁冲突；也可通过 `CARGO_TARGET_DIR` 自定义。

## Windows 版打包与实机验收

- Windows x64 构建配置位于 `src-tauri/tauri.windows.conf.json`（NSIS 安装包支持简体中文/英文、当前用户安装、自动引导 WebView2，同时可打包绿色免安装 ZIP）。
- 实机验收流程与逐项核对表见 [docs/WINDOWS_QA_CHECKLIST.md](docs/WINDOWS_QA_CHECKLIST.md)。

## 相关文档与许可

- 产品范围：[docs/PRODUCT.md](docs/PRODUCT.md)
- 架构说明：[docs/TAURI_ARCHITECTURE.md](docs/TAURI_ARCHITECTURE.md)
- 桥接契约：[docs/IPC_CONTRACT.md](docs/IPC_CONTRACT.md)
- 协议笔记：[docs/API_NOTES.md](docs/API_NOTES.md)
- 平台支持：[docs/PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md)
- 源码许可：MIT，详见 [LICENSE](LICENSE)
