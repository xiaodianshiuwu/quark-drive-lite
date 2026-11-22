# 夸克网盘极简客户端 — 内部接口契约 (IPC Contract v1)

> 当前运行框架为 Tauri 2 / Rust；下文 Electron 专用实现说明为历史参考，以 `tauri-bridge.js` 和 Rust `qk_call` 为当前分发依据。
> 本文件是渲染进程（UI）与主进程（核心）之间的**唯一约定**。
> 主进程负责全部网络访问、Cookie 管理、文件系统写入；渲染进程**不得**直接发起跨域请求或触碰 Node/Electron API。

## 0. 当前 Tauri 调用与安全边界

渲染器通过 `window.qk` → `tauri-bridge.js` → `invoke('qk_call')` 白名单分发。Rust `trusted()` 核对窗口标签和页面来源；仅 `main` 能调用业务接口，登录窗口仅用于认证。CSP 禁止远程脚本、子 frame 和表单外发，渲染器无 Node，不能读取 Cookie。

Rust 业务错误以 `{code,message,...}` reject，前端 `normalizeError()` 保留错误码并展示；登录过期的 `NEED_LOGIN` 触发登录提示。权限限制由 Rust Agent 工具层实施，不能依赖 UI 开关。GUI 删除确认和 Agent dry-run/name 确认分别适用。

`src/preload.js` / Electron 的 `ipcRenderer` 信封协议只供历史参考；当前原生链路由 `npm run verify:native` 覆盖，不能用 Electron 冒烟结果替代。

## 1. 数据类型

```ts
// 云盘文件/目录条目
interface FileItem {
  fid: string;            // 唯一 id；根目录为 "0"
  name: string;           // 已做 HTML 实体反转义
  dir: boolean;           // true=文件夹
  size: number;           // 字节；目录为 0
  updatedAt: number;      // 毫秒时间戳
  createdAt: number;      // 毫秒时间戳
  category: number;       // 0=未知 1=视频 2=图片 3=文档 4=音频 5=压缩包 ...
  ext: string;            // 小写扩展名，不含点
  pdirFid: string;        // 父目录 fid
}

// 分页结果（目录分页加载的核心结构）
interface PageResult {
  list: FileItem[];
  total: number;          // 服务端返回的总数；未知时为 -1
  page: number;           // 当前页，从 1 开始
  size: number;           // 每页条数
  hasMore: boolean;       // 是否还有下一页
}

// 面包屑
interface Crumb { fid: string; name: string }

// 异步任务受理结果
interface TaskAccepted {
  taskId?: string;        // 服务端返回的异步任务 id（若为异步）
  done: boolean;          // 是否同步已完成
}

// 传输任务
type TransferStatus =
  | 'pending' | 'running' | 'paused' | 'error' | 'done' | 'canceled';

interface TransferTask {
  id: string;             // 本地生成 uuid
  kind: 'upload' | 'download';
  name: string;
  size: number;           // 总字节
  transferred: number;    // 已完成字节
  status: TransferStatus;
  error?: string;         // 人类可读错误
  errorCode?: string;     // 原始错误码，便于判断是否需重新登录
  attempts: number;       // 已重试次数
  createdAt: number;
  updatedAt: number;
  // upload
  localPath?: string;
  pdirFid?: string;
  // download
  fid?: string;
  localDir?: string;
  // 实时指标（由主进程计算）
  speed: number;          // 字节/秒，0 表示无
  eta: number;            // 秒，-1 表示未知
}

// 账号状态
interface AccountState {
  loggedIn: boolean;
  expired: boolean;       // Cookie 失效，需重新登录
  nickname?: string;
  avatar?: string;
  memberLabel?: string;   // 如 "普通用户" / "SVIP"
  userId?: string;
}

interface QuotaInfo { total: number; used: number; free: number }
interface Settings { downloadDir: string; uploadConcurrency: number; downloadConcurrency: number; downloadParallel: number; uploadPartConcurrency: number; theme: 'light' | 'dark' }
```

## 2. `window.qk.auth`

| 方法 | 签名 | 说明 |
|---|---|---|
| `status()` | `() => Promise<AccountState>` | 读取本地安全存储中的登录态，**不**发起网络请求 |
| `verify()` | `() => Promise<AccountState>` | 主动调用云盘接口校验 Cookie 是否有效，失效则置 `expired=true` |
| `login()` | `() => Promise<AccountState>` | 打开内嵌登录窗口（或复用浏览器 Cookie 抓取），成功后持久化 |
| `logout()` | `() => Promise<void>` | 停止传输并清空本地登录态及登录浏览器分区，保留设置 |
| `quota()` | `() => Promise<QuotaInfo>` | 容量信息 |
| `onChange(cb)` | `(cb: (s: AccountState) => void) => () => void` | 订阅登录态变化；返回取消订阅函数 |

## 3. `window.qk.fs`

| 方法 | 签名 | 说明 |
|---|---|---|
| `list(p)` | `({ pdirFid: string, page?: number, size?: number, sort?: string, cat?: string }) => Promise<PageResult>` | 目录分页加载。`sort` 形如 `file_type:asc,updated_at:desc` |
| `search(p)` | `({ keyword: string, page?: number, size?: number, cat?: string }) => Promise<PageResult>` | 按文件名搜索 |
| `info(fid)` | `(fid: string) => Promise<FileItem>` | 单文件详情 |
| `crumbs(fid)` | `(fid: string) => Promise<Crumb[]>` | 从根到该目录的路径链 |
| `mkdir(p)` | `({ pdirFid: string, name: string }) => Promise<TaskAccepted>` | 新建文件夹 |
| `rename(p)` | `({ fid: string, name: string }) => Promise<TaskAccepted>` | 重命名（服务端通常无 task_id，返回 `{done:true}`） |
| `move(p)` | `({ fids: string[], toFid: string }) => Promise<TaskAccepted>` | 移动（异步任务） |
| `copy(p)` | `({ fids: string[], toFid: string }) => Promise<TaskAccepted>` | 复制（异步任务） |
| `remove(p)` | `({ fids: string[] }) => Promise<TaskAccepted>` | 批量删除（进入回收站，异步任务） |
| `taskStatus(p)` | `({ taskIds: string[], opType?: number }) => Promise<Array<{ taskId: string, status: number, done: boolean }>>` | 批量查询异步任务状态 |

**错误约定**：所有方法失败时 `reject` 一个 `Error`，其 `message` 为中文可读文案，并附带：
- `err.code: string` — 规范化后的错误码（如 `'NEED_LOGIN'`、`'RATE_LIMIT'`、`'NETWORK'`、`'TASK_FAILED'`）
- `err.raw` — 原始响应对象（便于排错）

当 `err.code === 'NEED_LOGIN'` 时，UI 必须展示"Cookie 已失效，请重新登录"提示条并引导调用 `auth.login()`。主进程在检测到该错误时也会主动推送 `auth.onChange`。

## 4. `window.qk.transfer`

| 方法 | 签名 | 说明 |
|---|---|---|
| `list()` | `() => Promise<TransferTask[]>` | 当前全部传输任务快照 |
| `upload(p)` | `({ localPaths: string[], pdirFid: string }) => Promise<string[]>` | 入队上传，返回任务 id 数组 |
| `download(p)` | `({ fids: string[], localDir: string }) => Promise<string[]>` | 入队下载，返回任务 id 数组 |
| `pause(id)` | `(id: string) => Promise<void>` | 暂停并等待旧执行器退出 |
| `resume(id)` | `(id: string) => Promise<void>` | 当前进程内继续，下载续用临时文件、上传续用已完成分片 |
| `retry(id)` | `(id: string) => Promise<void>` | 失败重试 |
| `cancel(id)` | `(id: string) => Promise<void>` | 取消并清理临时文件 |
| `clear(ids)` | `(ids: string[]) => Promise<void>` | 从列表移除已结束任务 |
| `onUpdate(cb)` | `(cb: (tasks: TransferTask[]) => void) => () => void` | 全量推送（节流 ≤ 4 次/秒） |
| `on('qk:chat-event')` | 对话进度事件（round/assistant_note/tool_start/tool_end/done/error） | Agent 内置对话（0.3.0-alpha，见下方新章节） |

**行为要求**
- 上传/下载均在主进程异步执行，`upload()`/`download()` 立即返回，**不得阻塞 UI**。
- 下载须支持 HTTP Range 断点续传：临时文件 `<name>.qkdownloading` + 同名 `.cfg` 记录进度。
- 下载瞬时错误最多重试 3 次，链接失效重取；上传在分片级重试，整次预登记不自动重放。未登录、容量不足和无效参数不自动重试。
- 上传支持绑定前缀哈希的受控并行 PUT，并在协议不支持时按顺序回退。任务队列持久保存，重启后暂停；须显式恢复。
- 并发数由设置控制，默认下载 2、上传 2。

## 5. `window.qk.dialog` / `window.qk.settings`

| 方法 | 签名 | 说明 |
|---|---|---|
| `dialog.pickDirs()` | `() => Promise<string[]>` | 选择本地目录（原生对话框） |
| `dialog.pickFiles()` | `() => Promise<string[]>` | 选择本地文件 |
| `dialog.saveDir(defaultPath?)` | `() => Promise<string \| null>` | 选择单个目录 |
| `dialog.confirm(p)` | `({ title: string, message: string, detail?: string, confirmText?: string, danger?: boolean }) => Promise<boolean>` | 原生二次确认；UI 亦可用自绘弹窗，但危险操作必须确认 |
| `dialog.openPath(p)` | `(path: string) => Promise<void>` | 用系统默认程序打开文件/目录 |
| `dialog.showInFolder(p)` | `(path: string) => Promise<void>` | 在资源管理器中定位 |
| `settings.get()` | `() => Promise<Settings>` | 读取设置 |
| `settings.set(patch)` | `(patch: Partial<Settings>) => Promise<Settings>` | 写入设置 |

## 6. 主进程推送通道（renderer 订阅）

| 通道 | 载荷 | 频率 |
|---|---|---|
| `qk:auth-changed` | `AccountState` | 事件驱动 |
| `qk:transfer-update` | `TransferTask[]`（全量） | ≤ 4 次/秒 |
| `qk:toast` | `{ level: 'info'\|'warn'\|'error', message: string }` | 事件驱动 |

## 7. UI 功能范围（严格对齐需求，超出即删除）

**保留**：文件浏览（面包屑 + 列表 + 目录分页加载）、一次性增量备份、搜索、新建文件夹、移动、复制、重命名、批量删除、上传、下载、传输任务管理、登录/退出、设置（下载目录/并发数）。

**禁止出现**：音视频播放器、推广/会员购买/活动入口、自动同步盘、分享、回收站深度恢复、相册/时间线、文档预览转换、加速器。（0.3.0-alpha 起，Agent 接入与内置对话为已批准功能，见下方章节。）

## 8. 视觉要求

- 界面简洁：左侧极简导航（全部文件 / 传输列表 / 备份 / 对话 / 设置），右侧主区。
- 顶部：面包屑 + 搜索框 + 上传按钮。
- 列表：复选框、图标、名称、大小、修改时间、行内操作。
- 传输抽屉：进度条、速度、剩余时间、暂停/继续/重试/取消。
- 中文文案；深浅色主题跟随设置。

## Agent 接入与内置对话（0.3.0-alpha 新增）

`qk_call` 新增 `agent.*` 与 `chat.*` 两组方法（Rust 侧分发见 `crates/quark-agent/src/runtime.rs` 的 `handle`）：

| 方法 | 参数 | 返回 |
|---|---|---|
| `agent.status` | `{}` | 状态快照（开关/端点/写模式/授权目录/连接数/审计文件名；不含 token） |
| `agent.enable` | 可选配置补丁 | 启用接入并启动本机网关（失败自动回滚停用） |
| `agent.disable` | `{}` | 停止网关并删除桥接凭据文件 |
| `agent.updateScope` | `{ writeMode?, remoteRoots?, localReadRoots?, localWriteRoots? }` | 修改授权范围（运行中即时生效，无需重启） |
| `agent.rotate` | `{}` | 重新生成网关凭据（旧凭据立即失效） |
| `agent.journal` | `{ limit }` | `{ records: [...] }` 已脱敏操作记录 |
| `agent.mcpConfig` | `{}` | MCP 客户端配置片段（命令/参数/环境变量，不含凭据值） |
| `agent.tools` | `{}` | 20 个工具定义（OpenAI tools 形状） |
| `chat.status` / `chat.history` / `chat.clear` | `{}` / `{ limit }` | 对话状态 / 历史（不含 Key）/ 清空 |
| `chat.saveConfig` / `chat.clearConfig` | 配置补丁（apiKey 省略=保留，null=清空） | 对话配置（加密存储，快照仅 `hasKey`） |
| `chat.test` / `chat.models` | `{}` | 连接测试 / 模型列表（走用户配置的 OpenAI 兼容端点） |
| `chat.send` | `{ text }` | 发送一条消息并跑完工具循环；过程事件经 `qk:chat-event` 推送 |

事件 `qk:chat-event` 载荷类型：`round` / `assistant_note` / `tool_start` / `tool_end` / `done` / `error`（字段见 `crates/quark-agent/src/chat.rs`）。

错误形状沿用 `qk_call` 统一错误（`code`/`message`，Agent 的操作提示合并进 `message`）。

## 增量备份（当前已批准产品范围）

`window.qk.backup` 提供 plan/start/status/retry/cancel/verify/pause/resume/tasks/export 十个命令。参数及核验强度以 [BACKUP.md](BACKUP.md) 为准。账号来自 Rust 会话，前端 account 字段不授予身份。扫描结束和核验结束是不同状态；不能用 `running=false` 隐藏报告或宣称备份完整。

### Agent 写操作结果语义

`accepted=true` 表示服务端成功受理，`completed` 表示同步完成，不能互换。重命名的 `verified` 来自清除调用内缓存后的元数据核对；仍未观察到新名称时应稍后复核。删除以逐项 `results[].status` 为准，只有全部 `deleted` 才返回 `deleted_to_recycle=true`；`uncertain` 不能视为完成。
