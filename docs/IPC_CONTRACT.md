# 夸克网盘极简客户端 — 内部接口契约 (IPC Contract v1)

> 本文件是渲染进程（UI）与主进程（核心）之间的**唯一约定**。
> 主进程负责全部网络访问、Cookie 管理、文件系统写入；渲染进程**不得**直接发起跨域请求或触碰 Node/Electron API。

## 0. 安全基线

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`（渲染进程无 Node）。
- 渲染进程仅能通过 `window.qk` 调用下列方法，全部经 `ipcRenderer.invoke` / `ipcRenderer.on` 白名单转发。
- IPC 仅接受主窗口的主框架调用。UI 对删除、移动、复制显示二次确认；创建和重命名通过输入对话框提交；下载不覆盖已有文件。

### 0.1 IPC 错误传递协议（实测确定，勿改）

两个 Electron 陷阱，本项目已实测确认并规避：

1. **主进程处理器不抛异常**。`ipcRenderer.invoke` 在处理器抛出时只会把错误序列化成一句
   `Error invoking remote method 'x': ...`，`code`/`bizCode`/`raw` **全部丢失**。
   因此主进程统一返回结果信封：
   - 成功：`{ __qk: true, data: <结果> }`
   - 失败：`{ __qk: false, error: { code, message, bizCode?, httpStatus?, raw? } }`

2. **preload 中必须 `throw` 普通对象，不能 `throw new Error()`**。实测：
   跨 `contextBridge` 抛 `Error` 时只有 `message` 存活（`Object.keys(err)` 为空），`code` 被剥离；
   抛普通对象则字段完整。
   渲染侧 `api.js` 的 `normalizeError()` 会把该对象归一化成带 `code` 的 `Error`。

> 为什么必须如此严格：UI 依赖 `err.code === 'NEED_LOGIN'` 弹出「登录状态已失效，请重新登录」提示条
> （需求明确要求）。上述任一环节写错，该提示条就会静默失效——真机冒烟测试 `verify/smoke-electron.js`
> 专门覆盖了这条链路。

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

**行为要求**
- 上传/下载均在主进程异步执行，`upload()`/`download()` 立即返回，**不得阻塞 UI**。
- 下载须支持 HTTP Range 断点续传：临时文件 `<name>.qkdownloading` + 同名 `.cfg` 记录进度。
- 下载瞬时错误最多重试 3 次，链接失效重取；上传在分片级重试，整次预登记不自动重放。未登录、容量不足和无效参数不自动重试。
- 上传分片并发仅用于预读；当前存储目标的 PUT 必须按编号顺序执行。任务队列不跨应用重启保存。
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

**保留**：文件浏览（面包屑 + 列表 + 目录分页加载）、搜索、新建文件夹、移动、复制、重命名、批量删除、上传、下载、传输任务管理、登录/退出、设置（下载目录/并发数）。

**禁止出现**：AI 助手/问答、音视频播放器、推广/会员购买/活动入口、同步盘/备份、分享、回收站深度恢复、相册/时间线、文档预览转换、加速器、聊天。

## 8. 视觉要求

- 界面简洁：左侧极简导航（全部文件 / 传输列表 / 设置），右侧主区。
- 顶部：面包屑 + 搜索框 + 上传按钮。
- 列表：复选框、图标、名称、大小、修改时间、行内操作。
- 传输抽屉：进度条、速度、剩余时间、暂停/继续/重试/取消。
- 中文文案；深浅色主题跟随设置。
