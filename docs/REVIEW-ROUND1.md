# Phase 1 第一轮全量审查记录（alpha：AI 子系统移植 + 删除功能）

**审查对象树**：分支 `feat/ai-agent-compat-and-delete`，HEAD `f14794b`，树哈希 `b35ee7c37395318bf21b81951e1ff4a0bdc81020`（提交前基线）→ 提交后待复核。
**基线提交**：`c3a8a80`（迁移主干 main HEAD）。
**审查时间**：2026-10-18 17:00–18:30（Asia/Shanghai）。

## 1. 覆盖范围

| 模块 | 文件 | 审查方式 |
|---|---|---|
| Agent 工具层 | crates/quark-agent/src/tools.rs（~2600 行） | 通读 + 20 工具逐个假网盘测试 |
| 计划仓库 | plans.rs | 通读 + 4 测试（八步绑定/TTL/prune） |
| 网关 | gateway.rs（2037 行） | 子智能体深审（进行中）+ 23 测试 |
| 对话 | chat.rs（1848 行）+ chat_config.rs | 子智能体深审（进行中）+ 21 测试 |
| 配置/凭据 | config.rs、journal.rs、policy.rs | 通读 + 13 测试 |
| 运行时 | runtime.rs、host.rs、src-tauri/main.rs 接线 | 自查 + 编译零警告 |
| 渲染层 | src/renderer/*（+1450 行 app.js 等） | UI 子智能体 42 新用例 + 既有 11 项回归 |
| MCP/CLI 适配器 | tools/agent-{mcp,cli}.js、agent-bridge-client.js | 移植 + 真实子进程 e2e（Rust 测试 + 手工 stdio 协议验证） |
| 真实账号链路 | examples/agent_acceptance.rs | 实跑 4 轮（2 轮发现问题 → 修复 → 2 轮通过） |

排除项：qck 参考目录（只读，未改）；crates/quark-core、quark-transfer（本阶段未改动，基线已验证）。

## 2. 测试与验证证据（全部实跑）

- `cargo test -p quark-agent --offline` → **75 passed / 0 failed**（8.9s）
- `cargo check --workspace --offline` → 0 error 0 warning
- `QCK_BROWSER_PATH=…Chrome npm test` → **53 pass / 0 fail**（新增 42 用例）
- 无浏览器 CI 模式 → 46 pass / 1 skip / 0 fail
- 真实账号受控验收（examples/agent_acceptance.rs，仅本轮 UUID 测试目录）：
  - create_folder → created_fid 确认 ✓
  - upload_file(wait) → status=done ✓
  - list_dir → 文件可见 ✓
  - delete_entries dry_run → 条目清单正确 ✓
  - delete_entries(dry_run=false, confirm_names) → **status=deleted（文件+目录）** ✓
  - deleted_to_recycle=true（回收站语义）✓
  - 退出码 0；台账已打印（无用户数据触碰）
- 真实网关 + Node CLI 子进程 e2e（Rust 测试）：status/tools(20 工具)/call list_dir/错误 token 拒绝 ✓
- MCP stdio 协议验证（手工，假网关）：server/discover(resultType=complete+supportedVersions)、tools/list(ttlMs+cacheScope)、tools/call(content 透传) ✓
- CLI 错误路径：无凭据 exit=3+中文提示；无参数 exit=2+用法 ✓

## 3. 发现并已修复的问题（第一轮内闭环）

| # | 严重度 | 问题 | 修复 | 复测 |
|---|---|---|---|---|
| 1 | P0 | safe_info 把上游 NOT_FOUND(21001/404) 当 transient 重试，删除后被 recent 兜底成"仍存在"→ 验收 uncertain | NOT_FOUND 判终态立即返回（is_not_found） | 验收第 4 轮 deleted ✓ |
| 2 | P0 | host 错误映射把数字 biz_code 写进 upstream_code，字符串判定失效 | upstream_code 保留字符串 code；biz 只进提示 | 同上 |
| 3 | P1 | info/list 缓存进程级共享，写入后读到旧数据 | 缓存改单次工具调用作用域（对齐 qck opts.cache） | 11 fake_tests ✓ |
| 4 | P1 | locate_child_dir 写入后读缓存 → plan 找不到新目录 | 定位改用新鲜列表 | plan 测试 ✓ |
| 5 | P2 | 删除核对单次判定 vs 服务端异步删除 | 改轮询等待（15×2s） | 验收 ✓ |
| 6 | P2 | ConfigSourceAdapter.generation 恒 0 | 注入真实 generation 闭包 | 编译+测试 ✓ |

## 4. 语义对应抽查（qck ↔ Rust，10 项）

1. NDJSON 行帧 ✓（子智能体核对 qck 源码确认非长度前缀）
2. 未认证池 2 / 总池 8 / 5s 认证超时 / 50 RPS / 排队 32 ✓
3. 工具循环 8 轮上限 20、单轮 8 调用补 AGENT_LIMIT ✓
4. redact 先于截断 20000 ✓（测试断言签名直链脱敏）
5. plans 八步授权绑定 + content_hash 二次复核 ✓
6. delete_entries 双阶段确认（新增工具，超出 qck）✓ 真实验收
7. 网关每调用实时读范围（改范围无需重启）✓
8. Key 只写不读、snapshot 仅 hasKey ✓
9. baseUrl 仅 https/本机回环 http ✓
10. MCP 新旧双协议时代适配 ✓（qck 移植 + 实测）

## 5. 待子智能体报告后补充

- gateway/chat/host/runtime 深审报告结论与遗留项
- 前端/文档一致性报告结论

## 6. 第一轮审查报告结论与修复闭环（2026-10-18 19:10 补记）

三路审查（Rust 深审 5dbe5938 / 前端文档 c95cff9f / c05b0043）全部回收：

### 发现汇总与处置
| 来源 | 级别 | 问题 | 处置 | 复测 |
|---|---|---|---|---|
| 深审 | P0 | main.rs 错误映射丢 raw_code（NEED_LOGIN 链路失效） | 已修 deff965+b2002f4：raw_code 优先透传 | 前端 53/53 + 验收 ✓ |
| 深审 | P1-1 | from_upstream 死分支（规格 §2.2 透传未实现） | 已修 deff965：raw_code 字段+白名单透传 | 75/75（断言更新） |
| 深审 | P1-2 | emit 回调 panic 炸 qk_call | 已修 b2002f4：catch_unwind 隔离 | 75/75 |
| 深审 | P1-3 | 畸形 tool_calls（缺 name）回传致每轮 400 | 已修 b2002f4：规范化阶段丢弃 | 75/75 |
| 深审 | P1-4 | enable 失败回滚不完整（凭据残留） | 已修 b2002f4：rotate_token+审计 | 75/75 |
| 深审 | P2-g2 | stop 不追踪 worker（停用后仍可能写盘） | 已修 deff965：worker abort 登记 | 75/75 |
| 深审 | P2-c1 | 缺 id 回传 null 致严格服务 400 | 已修 deff965：缺 id 省略字段 | 75/75 |
| 深审 | P2-h1 | generation 忽略（跨账号静默继续） | 已修 deff965：前后 ensure_session | 75/75 |
| 深审 | P2-r4 | journal 数字 params 恒回落 30 | 已修 b2002f4 | 75/75 |
| 深审 | P2-6 | started 审计端点含 token 片段 | 已修 b2002f4：只落文件名 | 75/75 |
| 前端 | P2 | PLATFORM_SUPPORT 资料目录错误 | 已修 e1617f5 | 文档核对 ✓ |
| 前端 | P2 | journal 静默回 [] | 已修 e1617f5：warn | 53/53 |
| 前端 | 文档 | README/IPC/DEVELOPMENT/MIGRATION 无 Agent | 已修 5fae4f8/33ceb86/4d321b4 | 核对 ✓ |

### 未修复（记录原因）
- P2 传输轮询 250ms 全量 snapshot：**基线既有行为**（非本次引入），改动触及传输核心风险大于收益，记入后续优化。
- P2 chat.clear 不查 busy：与 qck 同构的已知边界（qck 同样存在），保持参照语义。
- P2-7 硬编码 no_proxy：有意设计（注释说明对齐 qck/TUN，避免 Key 经环境代理），保持。
- Windows named-pipe TODO / 打包资源路径：明确记入 MIGRATION_STATUS 边界。

### 最终回归（修复后）
- cargo test -p quark-agent：**75/75**
- agent_loop_verify 离线闭环：**16/16**
- cargo check --workspace：0 error 0 warning
- npm test（Chrome）：**53/53**
- 真实账号验收：**exit=0**（file_deleted=true, dir_deleted=true, ok=true）

### 第一轮审查结论
候选树 `b2002f4` 通过第一轮全量审查；所有 P0/P1 与关键 P2 已修复并复测。
