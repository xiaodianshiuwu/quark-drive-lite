# 备份（Windows 重装前海量文件批量上传）

Phase-2 交付：把整个本地目录树（10 万+ 文件）分批、限速、可恢复地备份到夸克网盘指定目录。

## 能力概览

| 能力 | 行为 |
|---|---|
| 分批发现 | 每批 ~500 条（`discoveryBatchSize`，1..5000），批次间让出事件循环 |
| 队列背压 | channel 容量 = `highWatermark`（默认 1000），扫描端 send 满即阻塞；消费后自然恢复（低水位 `lowWatermark` 用于展示） |
| 上传并发 | `uploadConcurrency` 默认 2（1..8），与传输分片并发正交 |
| 持久任务库 | SQLite WAL，`<资料目录>/backup/bk<rootDir 哈希>.db`；同目录重开自动续扫（增量） |
| 任务身份 | (account, rootDir, targetFid, relPath) 主键；重扫幂等——mtime/size 未变的终态条目不重跑 |
| 状态机 | discovered → pending → uploading → verifying → success；failed/skipped/canceled 可回 pending（手动重试）；崩溃恢复 uploading/verifying → pending |
| 源变更检测 | 上传前重 stat：size/mtime 与发现时不一致 → 重新入队（不盲传旧快照） |
| 冲突策略 | 默认不覆盖：远端同名存在 → skipped（错误信息含远端 fid） |
| 幂等建目录 | relPath 逐级 list 确认 → mkdir → 轮询拿 fid；映射持久化在任务库 |
| 退避重试 | 指数 2^n × `retryBaseMs`（默认 30s），上限 `maxAttempts`（默认 6）；手动「重试失败」清零 attempts |
| 验证 | 清单核对（relPath/size/remoteFid 逐目录比对）+ 抽样下载 SHA-256 比对（`sampleRatePpm`，默认 1% 且 ∈[5,20]；验收用 1000000=全量） |
| 完成判定 | 扫描结束 ∧ pending/uploading/verifying=0 ∧ failed 全部重试或接受 → 可核对完成；**测试通过 ≠ 你的备份已完成**（报告分层） |
| 源安全 | 只读本地源；绝不删除/移动本地文件；云端只写 `targetFid` 子树 |

## 使用（UI）

1. 侧栏「备份」→ 选择本地目录 → 填云端目标目录 fid（可在「文件」视图复制，或用默认根）。
2. 「预览」看 files/dirs/warnings/totalBytes；「开始备份」启动。
3. 运行区实时水位与计数；失败可「重试失败」；「取消」保留任务现场（再次开始同一目录=续扫）。
4. 完成后「验证」：verified=清单全过+抽样哈希一致；partial/failed 看 issues 列表。

## 使用（命令行 / qk_call）

```
backup.plan   {rootDir, targetFid}
backup.start  {account, rootDir, targetFid, config?{discoveryBatchSize,highWatermark,lowWatermark,uploadConcurrency,retryBaseMs,maxAttempts}}
backup.status
backup.retry
backup.cancel
backup.verify {sampleRatePpm}
```

## 配置迁移与回滚

- 全部配置带默认值（500/1000/500/2/30000/6）；不设置即用默认，settings 无需迁移。
- 回滚：不使用备份功能即无任何持久状态；任务库是独立 SQLite 文件，删除 `<资料目录>/backup/` 即完全移除（不影响会话/传输/Agent 数据）。

## 已知边界（如实）

- 上传经 TransferManager 单文件入队 → 等终态 → clear：任务会**短暂出现在 GUI 传输列表**（每文件一条）；海量场景下传输列表会被备份任务刷屏（可接受的权衡，后续可把 upload.rs 核心提为独立入口绕开）。
- 分片级断点续传沿用 quark-transfer 现有能力（X-Oss-Hash-Ctx 并行分片，任务级 checkpoint）；**无"字节级任意断点"**——单个文件中断后重传从该文件的分片 checkpoint 续。
- Windows 真机验证未做（本阶段 macOS 开发）：长路径（\\?\ 前缀）、Windows 保留名（CON/COM1…）、junction、大小写不敏感冲突的**发现期标注**已实现（`windows_name_risk`），但**运行时行为未在 Windows 上实测**。
- 10 万条目离线性能（Apple M 系列）：扫描 ~11.4 万条/秒、SQLite upsert ~11.5 万条/秒、认领 ~2.5 万条/秒（`cargo test -p quark-backup --test massive_scan`）。Windows 机械硬盘数字会低一个数量级，属正常。
- 空目录：只建云端目录，不产生上传任务（如实）。
- 抽样验证是**抽样**：未抽中的文件只有"远端存在且 size 一致"证据，无内容哈希证据。要全量哈希核对，用 `sampleRatePpm: 1000000`。
- UI 侧：云端目标目录为 fid 文本输入（可在「文件」视图复制），暂无目录树选择器；大目录「预览」期间无进度反馈（后端全量扫完才返回）；verify 固定 1% 抽样率未在 UI 暴露配置。

## 验证记录（真实账号）

- `cargo run -p quark-backup --example backup_acceptance`：
  UUID 测试目录 8 文件（中文/空格名 + 子目录 + 空文件 + 300KB）→ 上传 8/8 success →
  清单核对 listed_ok=8 → 抽样下载 SHA-256 比对 8/8 一致 → `{"ok":true,...}` → 云端测试目录删除（回收站）。
