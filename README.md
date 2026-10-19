# 夸克网盘极简版 · Tauri 迁移开发版

> [!WARNING]
> **该项目为 beta 版本，持续开发中：功能均尚未完善，可能遇到无法正常使用的各类问题，敬请注意。**

原有界面迁移到 Tauri 2，系统 WebView 承载本地界面，Rust 核心负责网络、会话、文件操作和传输。应用运行不需要 Node.js 或 Electron；Node.js 仅用于开发工具。

本分支尚未合并、发布。当前独立审计、修复及验证边界见 [2026-10-19 审计交付](docs/AUDIT-2026-10-19.md) 和 [逐功能验收矩阵](docs/AUDIT-2026-10-19-MATRIX.csv)。历史迁移进度与恢复入口见 [MIGRATION_STATUS.md](MIGRATION_STATUS.md)。原版 Electron 实现保留在 `src/main` 供协议对照，不参与 Tauri 构建；历史使用说明见基线提交。

## 开发

需要 Rust stable、Node.js 24 和对应平台的 [Tauri 2 原生构建依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm start
```

```sh
npm run test:rust
npm test
npm run verify:native
npm run build
```

`npm start` / `npm run build` 自动把 Rust 产物放到当前用户的构建缓存中，避免 macOS 云端文档目录引入签名扩展属性；也可用 `CARGO_TARGET_DIR` 指定目录。纯 Rust 核心可单独 `cargo test -p quark-core -p quark-transfer --locked`。

## 数据与登录

Tauri 使用独立应用资料目录 `cn.quarkdrive.lite.tauri`，不会自动复制原客户端登录资料。点击右上角登录，在独立原生登录窗口扫码；Cookie 仅由 Rust 读取及发送。远端登录网页没有本地文件或传输权限。

会话采用 QCK2 AES-256-GCM 加密，本地随机密钥与密文均保存在用户资料目录，日常启动不调用系统钥匙串或要求系统密码。同目录密钥不能防止拥有相同文件权限的其他进程；备份时需同时保管密文和密钥。

任务与分片进度保存在应用资料目录，重启后中断任务显示为暂停，由用户继续。上传支持 SHA-1 前缀状态握手的并行 PUT（默认 3），并保留顺序兼容设置及协议拒绝时的降级。下载使用 1 MiB 分片、受控并发、强 ETag 绑定、Range/长度及回读校验，安全发布时不覆盖已有文件。重新扫码会隔离旧登录的任务；同一登录态重启可继续。真实传输验证的剩余限制见迁移状态。

## 安全测试边界

真实账号测试仅能操作本轮新建的唯一测试目录及其子项。不得清理用户原有文件；不得提交 Cookie、签名直链或用户资料目录。Windows/Linux 原生构建与运行验证以迁移状态文档的实际记录为准。

## 协议与许可

接口证据见 [docs/API_NOTES.md](docs/API_NOTES.md)、桥接契约见 [docs/IPC_CONTRACT.md](docs/IPC_CONTRACT.md)。原型和第三方协议参考保留各自许可；本应用源码采用 MIT，详见 [LICENSE](LICENSE)。

## Agent 接入与内置对话

本版本移植了原 Electron 版的 AI Agent 子系统（工具层 + 本机网关 + 内置对话），全部运行在 Rust 侧：

- **接入**：设置页「Agent 接入」卡启用后，客户端在本机 Unix socket 上提供 MCP 兼容网关；外部 Agent（如 Claude Desktop、Cursor）通过应用内置的 `agent-mcp.js` 适配器连接，凭据在资料目录 `agent/bridge.json`（0600，启用时生成、停用时删除）。命令行可用 `node tools/agent-cli.js status|tools|call <tool> '<json>'` 直接验证。
- **授权**：默认只读；写入需把写入模式切到「授权范围内可写」并添加授权目录（网盘目录与本地读写目录分开授权）。修改授权即时生效，无需重启。操作记录（已脱敏）保存在资料目录 `agent/journal.jsonl`。
- **删除**：Agent 工具层提供 `delete_entries`（本版本新增，原版未开放）。双阶段确认——先 `dry_run` 返回目标清单，再带与清单一致的 `confirm_names` 执行；删除进入夸克网盘回收站（可恢复），逐项返回 `deleted/uncertain` 核对状态。客户端界面的删除功能不受影响。
- **内置对话**：「对话」视图配置任意 OpenAI 兼容端点（Base URL 仅允许 https 或本机回环 http；API Key 加密保存在资料目录 `agent/chat.bin`，只写不读）。对话与外部 Agent 共用同一套工具与授权范围，批量改动走 plan_create/plan_execute（带 revision + content_hash 授权绑定）。
- **资料目录**：macOS `~/Library/Application Support/cn.quarkdrive.lite.tauri`；Windows `%APPDATA%\cn.quarkdrive.lite.tauri`（Windows 命名管道已实现但本轮未经过 Windows 原生验收）。

## 重装前备份

侧栏「备份」选择本地源与云端目录即可开始，后台边扫描边上传；预览是可选的有界样本。支持持久任务、真实队列背压、暂停继续、单项错误、分页清单导出和抽样/全量哈希读回。上传结束后仍须核验；存在跳过、失败或排除时不会显示完整备份。

使用、恢复、配置和 Windows 验收步骤见 [docs/BACKUP.md](docs/BACKUP.md)，当前产品范围见 [docs/PRODUCT.md](docs/PRODUCT.md)。本轮审计报告将独立列出自动化、原生运行、真实账号与未验证项目，旧审查报告不能替代当前验收。
