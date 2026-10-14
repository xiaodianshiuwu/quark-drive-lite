# 夸克网盘极简客户端 — 交接文档（HANDOVER）

> **本文档的目标读者**：接手本项目的下一个 Agent（或工程师）。
> **读完之后你应该能够**：独立启动、修改、验证、打包本项目，并且**不重复踩已知的坑**。
>
> 最后更新：2026-10-13　项目根目录：`C:\Users\USER\Documents\qck`

---

## 0. 建议阅读顺序

| 顺序 | 文件 | 为什么 |
|---|---|---|
| 1 | 本文档（HANDOVER.md） | 全局认知 + 坑清单 |
| 2 | `docs/IPC_CONTRACT.md` | UI ↔ 主进程的唯一契约（数据结构定义在这里） |
| 3 | `docs/API_NOTES.md` | 夸克接口的**唯一真相来源**（含证据与待确认项） |
| 4 | `README.md` | 面向用户的功能说明与限制 |
| 5 | `src/main/main.js` | 看装配与 IPC 白名单，最能快速建立代码地图 |
| 6 | `src/main/core/download.js`、`upload.js` | 两个最复杂的引擎 |

> ⚠️ **铁律（贯穿全项目）**：`docs/API_NOTES.md` 中**没有出现过**的端点或参数，
> **一律不得写进实现代码**。任何新发现必须先补录到该文件并标注证据来源。
> 这是本项目对抗"网上抄来的假接口"的核心纪律。

---

## 1. 项目定义

### 1.1 一句话

一个**极简**的夸克网盘 Windows 桌面客户端：只保留文件管理（浏览/搜索/新建/移动/复制/重命名/批量删除/上传/下载/传输管理），彻底移除 AI、播放器、推广、同步盘等无关功能。

### 1.2 用户的原始需求（逐条，勿遗漏）

以下为用户的**原始要求**，是所有设计决策的最终依据：

1. **功能范围**：保留文件浏览、搜索、新建、移动、复制、重命名、批量删除、上传、下载及传输任务管理；**彻底移除** AI、播放器、推广、同步盘等无关功能。界面简洁，**目录分页加载**，**网络操作异步执行，不阻塞 UI**。
2. **接口研究**：重点分析正常操作所用接口、任务创建与状态查询；查看测试夸克网盘上传与下载时使用的端口、接口、各类参数；**无法验证接口时保留明确的待实现状态**。
3. **安全与健壮**：实现安全的本地登录态存储、Cookie 失效提示、下载断点续传、失败重试、文件操作二次确认。**优先调用现有项目成熟接口，先审查仓库代码和测试覆盖，再实现最小可用版本，不要凭空假定未验证的 API 可用。**
4. **优先用官方接口**：优先且尽量使用夸克网盘自身的接口与功能，速度和功能完善度做到和官方几乎无异；GitHub 项目仅供参考，如无参考价值弃用，**完全自己写**。
5. **性能与反风控**（后期追加，且被反复强调）：
   - 大文件 + 多文件上传下载需求，**确认和 app 功能一致、性能一致**，但精简其他无用功能；
   - **尽量做到请求看起来都和正常 app 发的一样，避免被服务器识别封控封号**；
   - 可以的话**直接逆向夸克网盘 app，尽量全部使用官方的各种代码功能，只去除其他无用功能**；
   - **必须提升性能、删除臃肿**；
   - 允许最高权限（用户明确授权），可自由操作本机。
6. **交付形态**：必须是**真正的桌面 app**（可双击运行），不是网页套壳。
7. **质量要求**：提交前做**全量代码审查**，确认需求全部实现完成。
8. **语言要求**：**所有输出（思考、注释、文档、界面、日志）一律使用简体中文**。

### 1.3 明确的"禁止出现"清单（UI 中一旦出现即视为 bug）

AI 助手/问答、音视频播放器、推广/会员购买/活动入口、同步盘/备份、分享、回收站深度恢复、相册/时间线、文档预览转换、加速器、聊天。

> 真机冒烟测试 `verify/smoke-electron.js` 会检查**渲染进程不发起任何外部网络请求**，用于兜住这条要求。

---

## 2. 当前状态（2026-10-13 全量审查修复后）

### 2.1 本次验证

| 验证层 | 命令/方式 | 结果 |
|---|---|---|
| 单元测试 | npm test（限定 test/*.test.js） | 216 / 216 |
| 集成验证 | npm run verify | 48 / 48 |
| 真实 Electron 冒烟 | npm run verify:smoke | 28 / 28 |
| 真实账号 E2E | npm run e2e | 29 / 29，0 失败、0 跳过 |
| 官方方案稳定性 | npm run stability | 13 / 13，含 90 秒运行 |
| UI、便携版与加密辅助进程专项 | 真实 Electron / CDP，独立测试 profile | 14 / 14 |
| 静态语法 | 本项目及参考原型 | 58 个 JS、36 个 Python 文件通过 |

旧版本的“195 / 195”包含两个被 node --test 意外发现的 tools 脚本；实际原单元测试为 193 项。新增 23 项回归测试后为 216 项。最初 22 个缺陷用例在修改前全部失败，修复后通过。

真实 E2E 使用 8400953 字节随机文件，强制走真实 OSS 分片上传，下载 MD5 与源文件一致；移动按精确 fid 核验源目录和目标目录；自建测试文件与目录已清理。本次账号有效，容量上限 10737418240 字节，审查前占用 31526833 字节。旧账号容量超限与登录失效记录属于历史。

### 2.2 两种交付形态

| 方案 | 入口 | 实际范围 |
|---|---|---|
| A 独立极简版 | npm run pack → dist/夸克网盘极简版/夸克网盘极简版.exe | 自主 Electron 客户端；主程序约 180 MB，整个便携目录约 268.3 MB。RunAsNode、NODE_OPTIONS、Node inspect fuses 已关闭 |
| B 官方导航精简版 | npm run native | 复用官方进程，隐藏备份/快传/工具导航并使用减负参数；没有彻底移除官方附加能力 |

### 2.3 仍需明确的限制

| # | 项目 | 当前限制 |
|---|---|---|
| 1 | 文件列表 | rAF 分批渲染，最多 4000 项；没有真正的虚拟滚动 |
| 2 | 传输任务持久化 | 任务队列只保存在内存，关闭应用后需重新选择文件；下载临时数据可续用，上传分片进度仅在当前进程保留 |
| 3 | 上传并发 | 实测 pds 目标要求顺序 PUT；设置中的分片并发用于预读，不代表并行 PUT |
| 4 | 极大文件与性能 | 本次真实验证 8400953 字节随机文件，以及只读下载 31526833 字节文件；多 GB、长期弱网和官方性能对比尚未实测 |
| 5 | 异步任务枚举 | 未确认的数值继续轮询并超时提示；不能推断所有批量操作状态 |
| 6 | 登录资料 | 未确认的昵称/头像字段继续留空，扫码及拖拽路径需用户实际交互 |
| 7 | 官方方案 B | 隐藏三项导航并应用减负参数，未彻底删除官方附加功能；不能保证风控结果 |
| 8 | 历史工具 | 逆向、Cookie 解密、旧协议原型不是生产入口，不能把语法通过当成真实操作可用 |
| 9 | **秒传是否需补调 `uploadFinish`（未确认）** | 当前实现：两条秒传路径（`pre.finish===true`、`updateHash` 返回 true）**均不调用** `uploadFinish`，直接返回 `{instant:true}`（见 `src/main/core/upload.js` L269-L286，`test/upload.test.js` L315/L333 有对应断言）。<br>但历史上曾有相反实现（秒传后仍补调 `uploadFinish` 落库），并在 `test/upload.test.js` 中断言过"秒传仍应调用 uploadFinish"。<br>**两者未在真实账号下验证过**（账号容量超限，`upload/pre` 返回 32003，无法触发秒传），因此该语义仍属未确认项。<br>若日后拿到可用账号，应优先实测：秒传后文件是否真的出现在目标目录（只测接口返回码不足以判定）。 |

---

## 3. 环境与启动（**三个必须知道的陷阱**）

### 3.1 启动方式：必须用 `npm start`

```powershell
cd C:\Users\USER\Documents\qck
npm start           # 走 scripts/start.js
```

> **陷阱 1**：本机环境变量里存在 **`ELECTRON_RUN_AS_NODE=1`**。
> 若直接运行 `node_modules\electron\dist\electron.exe`，Electron 会以**纯 Node 模式**启动，
> 报出极具误导性的 `TypeError: Cannot read properties of undefined (reading 'whenReady')`。
> `scripts/start.js` 会在启动前 `delete process.env.ELECTRON_RUN_AS_NODE`，并给出明确中文报错。
> **在任何自动化脚本里 spawn Electron 之前，都必须先删除该变量。**

### 3.2 依赖与路径

```powershell
pnpm install
node node_modules/electron/install.js    # 若 electron 二进制未下载（注意镜像）
```

- 唯一的运行时"依赖"是 Electron 本身；**主进程零第三方依赖**（只用 Node 内置模块 + `electron`）。
- 开发依赖：`electron@33`、`@electron/asar`、`electron-builder`、`playwright-core`。
- 本机 Node（DSH 自带）：`C:\Users\USER\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

> **陷阱 2**：Electron 33 内置 Chromium 130 / Node 20.18.3，**没有全局 `WebSocket`**。
> 因此 `verify/smoke-electron.js` 等脚本里那些"极简 CDP 客户端"用的是 Node **24**（DSH 自带）来跑，
> 不能假设 Electron 主进程里也能直接用 `new WebSocket()`。

> **陷阱 3**：`node --test test/`（带目录）在本机 Node 下会失败，**必须用 `node --test test/*.test.js`**（明确限定测试目录，避免执行 tools）。

### 3.3 常用命令全表

| 命令 | 作用 |
|---|---|
| `npm start` | 启动独立版（开发模式） |
| `npm test` | 单元测试（216） |
| `npm run verify` | 集成验证（48） |
| `npm run verify:smoke` | 真机冒烟（28，会真实启动 Electron） |
| `npm run verify:all` | 依次跑上面三项 |
| `npm run e2e` | 真实账号端到端（需登录；`--keep` 保留测试文件，`--root=<fid>` 指定目录） |
| `npm run login` | 弹出独立窗口扫码登录 |
| `npm run import-session` | 从 Chrome/Edge 已登录会话导入（`--list` 列出候选） |
| `npm run native` | **方案 B**：启动官方客户端精简版 |
| `npm run stability` | 方案 B 稳定性专项（13 项，含 90 秒长跑） |
| `npm run pack` | 生成便携版 exe 到 `dist/夸克网盘极简版/` |

---

## 4. 架构总览

### 4.1 进程模型

```
┌──────────────────────────── 主进程 (Node) ────────────────────────────┐
│  main.js ── 装配 ──┬─ core/http.js        ← 唯一出网口（含 Cookie/UA/超时）│
│                    ├─ core/session.js     ← Cookie jar（含 __puus 轮换回写）│
│                    ├─ core/secure-store.js← 加密落盘（DPAPI + 原子写）     │
│                    ├─ core/login.js       ← 登录窗口（读原生 Cookie）      │
│                    ├─ core/api-files.js   ← 文件类协议封装                │
│                    ├─ core/api-transfer.js← 传输类协议 + OSS 签名纯函数    │
│                    ├─ core/download.js    ← 下载引擎（并行分片/续传）      │
│                    ├─ core/upload.js      ← 上传引擎（分片/秒传）          │
│                    ├─ modules/fs.js       ← 业务层（+ 异步任务轮询）        │
│                    ├─ modules/transfer.js ← 任务队列（并发/重试/限速推送）  │
│                    ├─ modules/account.js  ← 账号/容量/会员                 │
│                    └─ modules/settings.js ← 设置                          │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ IPC（结果信封协议，见 §6）
┌───────────────────────────────┴───────────────────────────────────────┐
│  preload.js  ← 唯一的桥：白名单 + 解信封 + 抛普通对象                    │
├───────────────────────────────────────────────────────────────────────┤
│  渲染进程：index.html + app.js + api.js + styles.css                   │
│  纯原生 HTML/CSS/JS，零框架、零 CDN、CSP connect-src 'none'            │
└───────────────────────────────────────────────────────────────────────┘
```

### 4.2 安全基线（不可放松）

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`
- 渲染进程**只能**通过 `window.qk` 调用白名单方法，**绝不暴露 `ipcRenderer` 本体**
- `will-navigate` 拦截一切非 `file://` 导航；`setWindowOpenHandler` 一律 `deny`
- CSP：`connect-src 'none'`（渲染进程不允许发任何网络请求）
- **绝不在日志中输出 Cookie 值**
- 登录态加密：Electron `safeStorage`（绑定当前 Windows 用户及 profile 密钥），原子写入（先写 `.tmp` 再 `rename`）

### 4.3 关键数据流

**登录**（与官方客户端机制一致）：
```
用户点「登录」→ login.js 开一个 BrowserWindow（partition: 'persist:quark-login'）
  → 加载 https://pan.quark.cn/ → 用户扫码
  → session.cookies.get() 读该分区**全部** Cookie（含 HttpOnly 值）
  → 判活 GET /1/clouddrive/config → 成功则 secure-store 加密落盘
```

**下载**：
```
UI 选文件 → transfer.download({fids, localDir}) → 立即返回 taskIds（不阻塞）
  → 队列 pump → fs 取文件名 → api-transfer 取直链（POST /file/download）
  → download.js：探测 Range → 支持且 >8MB → 并行分片；否则单流降级
  → 进度节流推送（≤4 次/秒）→ 完成校验字节数
```

**上传**（四步，与官方一致）：
```
POST /file/upload/pre（预登记）→ POST /file/upload/auth（取 OSS 签名）
  → PUT/POST OSS 分片直传 → POST /file/upload/finish
  → 若 pre 返回 data.finish === true 则为秒传，直接结束
```

---

## 5. 完整文件清单

> 路径相对项目根目录。行数为 2026-10-13 实测。

### 5.1 主进程

| 文件 | 行数 | 职责与关键点 |
|---|---|---|
| `src/main/main.js` | 423 | **装配 + IPC 白名单 + 窗口**。定义 `handle()` 结果信封包装；`pushAuthState` 是 async（必须 await 后再 send）；`sanitizeTask()` 把任务裁剪成可序列化纯数据 |
| `src/main/preload.js` | 161 | **唯一的桥**。`errorDescriptor()` 构造跨隔离世界仍保留字段的错误对象；`invoke()` 解信封；`subscribe` / `subscribeAsync`（后者专用于 auth，兼容 Promise 载荷） |

### 5.2 核心层（`src/main/core/`）

| 文件 | 行数 | 导出 | 职责与关键点 |
|---|---|---|---|
| `storage-host.js` | 21 | 无公共导出 | Node 登录工具通过 Electron 系统加密后端读写，必须使用目标 profile 的密钥 |
| `errors.js` | 244 | `ErrCode` `QuarkError` `CODE_NEED_LOGIN` `BIZ_CODE_MAP` `isNeedLogin` `isRetryable` `fromEnvelope` `asNetworkError` | 统一错误模型。**业务码 32003 语义依赖 HTTP 状态码**（429 限流 / 409 冲突 / 400 容量不足），有 `NO_SPACE` 专项处理 |
| `http.js` | 431 | `HttpClient` `DEFAULT_UA` `DEFAULT_REFERER` `DEFAULT_ORIGIN` `buildUrl` `buildAbsoluteUrl` `sleep` `COMMON_QUERY` `UC_PARAMS_STR` `DEFAULT_DEVICE_MODEL` `QUARK_PRODUCT_VERSION` `QUARK_CLOUD_DRIVE_VERSION` `QUARK_CHANNEL` | **唯一出网口**。超时/重试/中止/Set-Cookie 回写；`direct:true` 的请求**强制走原生 fetch**（Electron `net.fetch` 对 CDN 不可用） |
| `secure-store.js` | 277 | `createSecureStore` `isEncryptionAvailable` | 加密本地存储。magic `QCK1`；原子写入；正式模式强制加密，失败时拒绝保存；仅纯测试模式允许明文 |
| `session.js` | 384 | `createSession` `parseSetCookie` `isDeletion` `toMillis` `normalizeExternalCookie` `normalizeRecord` | Cookie jar。**`__puus` 会随响应轮换，必须逐响应回写** |
| `login.js` | 341 | `LoginController` `buildCookieHeader` `mergeCookies` `ALIVE_PATH` `ALIVE_URL` `LOGIN_URL` `LOGIN_PARTITION` `COOKIE_DOMAINS` | 登录窗口 + 判活。总超时 180s，轮询 1500ms，单次判活 20s |
| `normalize.js` | 302 | `toFileItem` `toFileItems` `toPageResult` `extOf` `isDir` `unescapeHtml` `toNum` `toStr` `toBool` | 响应归一化，**永不抛异常**。`isDir` 需宽松（容忍 `true/1/"1"`）但**不能过宽**（曾有 `{dir:false,file_type:0}` 误判 bug） |
| `api-files.js` | 555 | `createFilesApi` `PATH` `COMMON_QUERY` `ACTION_TYPE` `DEFAULT_SORT` | 文件类 11 个方法：`list search info crumbs mkdir rename move copy remove taskStatus queryTask`。**所有 POST 必须带 `{query: COMMON_QUERY}`** |
| `api-transfer.js` | 326 | `createTransferApi` `buildAuthMetaPut` `buildAuthMetaComplete` `buildCompleteXml` `divideParts` `resolveOssUrl` `ossDateNow` `PART_SIZE_ALIGN` `OSS_USER_AGENT` `DEFAULT_PART_SIZE` | 传输协议 + **OSS 签名纯函数**（可单测）。`PART_SIZE_ALIGN = 65536` |
| `download.js` | 726 | `downloadFile` `cleanupPartial` `hasPartial` `safeFileName` `uniquePath` `divideParts` `probeRange` `isLinkExpired` `iterateBody` `TEMP_SUFFIX` `CFG_SUFFIX` `MULTIPART_THRESHOLD` `PART_SIZE` | 下载引擎。阈值 8 MB，片大小 8 MB，默认 4 并行；临时文件 `.qkdownloading` + `.cfg` 进度 |
| `upload.js` | 466 | `uploadFile` `guessMime` `calcHashes` `readRange` `mapLimit` `uploadedTotal` `MIME_MAP` `DEFAULT_CONCURRENCY` `PART_RETRIES` | 上传引擎。默认并发预读 2、顺序 PUT，分片重试 3 次；**必须有 partSize 防御性校验** |

### 5.3 业务层（`src/main/modules/`）

| 文件 | 行数 | 对外方法 | 职责与关键点 |
|---|---|---|---|
| `account.js` | 487 | `status` `verify` `login` `logout` `quota` `getUserInfo` `onStateChange`（+ `_buildState` `_emit` 供测试） | 账号/容量/会员。容量取自 `GET /1/clouddrive/member` 的 `total_capacity`/`use_capacity` |
| `fs.js` | 331 | `list` `search` `info` `crumbs` `mkdir` `rename` `move` `copy` `remove` `taskStatus`（+ 内部 `queryTask` `waitTask` `listAll`） | 文件业务层。`wrap()` 统一中文错误；异步任务轮询（间隔 1s，超时 180s，分片 sleep 防卡死）；`listAll` 上限 500 页 |
| `transfer.js` | 483 | `list` `upload` `download` `pause` `resume` `retry` `cancel` `clear` `openItem` | 任务队列。进度节流 250ms（≤4 次/秒）；测速窗口 3s；最大重试 3 次；`upload()`/`download()` **立即返回**任务 id 数组（用 `queueMicrotask(pump)` 启动） |
| `settings.js` | 98 | `get` `set` `getDownloadDir` `getConcurrency` | 设置。并发分两类：文件级 `uploadConcurrency`(1-8)/`downloadConcurrency`(1-5)，分片级 `downloadParallel`(1-16)/`uploadPartConcurrency`(1-8) |

### 5.4 渲染层（`src/renderer/`）

| 文件 | 行数 | 说明 |
|---|---|---|
| `index.html` | 309 | 三个视图：`#view-files` / `#view-transfers` / `#view-settings`；左侧导航 `#nav`（`data-view` 三项）。**没有**任何 CDN 引用 |
| `app.js` | 2137 | 全部 UI 逻辑。`state` 对象集中在文件开头（`view/fid/crumbs/mode/items/itemMap/page/hasMore/total/selected/account/quota/settings/transfers/expired`）。列表用 `insertChunked()`（rAF 分批） |
| `api.js` | 823 | 桥接包装层。`CONTRACT` 清单自检；`normalizeError()`；**`onNeedLogin()` 统一上报**（任何接口抛 `NEED_LOGIN` 都会触发，UI 只需订阅一次）；内置**默认关闭**的 `?mock=1` 假数据模式 |
| `styles.css` | 619 | 样式（含深浅色主题） |

### 5.5 测试与验证

| 文件 | 行数 | 覆盖 |
|---|---|---|
| `test/audit-regression.test.js` | 247 | 20 项 HTTP、下载完整性、上传顺序、取消、加密失败回归 |
| `test/main-security.test.js` | 66 | 3 项 IPC 来源、启动判活、传输登录失效回归 |
| `test/session.test.js` | 770 | Cookie jar / Set-Cookie 解析 / 轮换回写 |
| `test/api-files.test.js` | 732 | 11 个文件接口（含错误路径） |
| `test/download.test.js` | 636 | 分片划分、并发峰值、字节正确性、Range 降级、续传偏移 |
| `test/upload.test.js` | 463 | 分片、hash、MIME、partSize 防御 |
| `test/secure-store.test.js` | 304 | 加密/明文降级/原子写入 |
| `test/normalize.test.js` | 284 | 字段归一化（含 `isDir` 边界） |
| `test/common-query.test.js` | 234 | **POST 必须带公共查询参数**（9 条，防回归） |
| `test/build-url.test.js` | 73 | **URL 构造 6 条回归断言**（防"下载必然 403"复发） |
| `verify/integration.js` | 622 | 48 项集成验证（主进程模块级） |
| `verify/smoke-electron.js` | 333 | 28 项真机冒烟（真实 Electron + CDP 断言，端口 9777） |
| `verify/e2e-real.js` | 634 | 真实账号端到端（端口 9788，`--keep`/`--root=` 可选） |

### 5.6 脚本与工具

| 文件 | 说明 |
|---|---|
| `scripts/start.js` | Electron 启动器，**清除 `ELECTRON_RUN_AS_NODE`**（见 §3.1 陷阱 1） |
| `tools/make-portable.js` | 生成便携版：把源码打成 `app.asar` 放进 Electron 运行时，重命名 exe 为中文名 |
| `tools/quark-mini-native.js` | **方案 B 启动器**（见 §12） |
| `tools/stability-test.js` | 方案 B 稳定性专项测试（13 项） |
| `tools/login-assisted.js` | 辅助登录（独立窗口扫码） |
| `tools/import-browser-session.js` | 从 Chrome/Edge 导入会话 |
| `tools/check-session.js` / `check-quota.js` / `list-root.js` | 诊断脚本 |
| `tools/reset-login.js` | 重置登录态；默认不按名称前缀删除远端数据；须明确提供 --delete-fids，--clean-only 保留登录态 |
| `tools/probe_api.js` / `cdp_probe.js` | 接口探针 / CDP 登录态原型 |
| `tools/dll_research/` | quark.dll 逆向全套脚本（见 §12.4） |
| `tools/ab-test.js` | DLL 补丁 A/B 对照实验 |
| `tools/decrypt_cookies.js` / `dump_cookies.py` / `extract_key.ps1` | Chromium Cookie 解密链路（DPAPI + AES-256-GCM + 域名哈希） |
| `tools/mine_endpoints.py` / `ctx.py` | 端点挖掘 / JS 上下文抽取 |
| `tools/count_private_api.py` | 统计官方 JS 对私有 API 的引用次数（见 §14） |
| `builder.config.json` | electron-builder 配置（**实际打包不用它**，见 §13.3） |

---

## 6. IPC 契约（完整表）

### 6.1 通道总表（主进程注册 **33** 个 invoke + 3 个推送；preload 暴露 **33** 个）

| 分组 | 通道 | 入参 | 返回 |
|---|---|---|---|
| **auth** | `qk:auth:status` | — | `AccountState` |
| | `qk:auth:verify` | — | `AccountState` |
| | `qk:auth:login` | — | `AccountState` |
| | `qk:auth:logout` | — | `boolean` |
| | `qk:auth:quota` | — | `QuotaInfo` |
| | `qk:auth:user-info` | — | 用户资料对象 |
| **fs** | `qk:fs:list` | `{pdirFid, page?, size?, sort?, cat?}` | `PageResult` |
| | `qk:fs:search` | `{keyword, page?, size?, cat?}` | `PageResult` |
| | `qk:fs:info` | `fid` | `FileItem` |
| | `qk:fs:crumbs` | `fid` | `Crumb[]`（失败降级为根目录，不抛错） |
| | `qk:fs:mkdir` | `{pdirFid, name}` | `TaskAccepted` |
| | `qk:fs:rename` | `{fid, name}` | `TaskAccepted` |
| | `qk:fs:move` | `{fids, toFid}` | `TaskAccepted` |
| | `qk:fs:copy` | `{fids, toFid}` | `TaskAccepted` |
| | `qk:fs:remove` | `{fids}` | `TaskAccepted` |
| | `qk:fs:task-status` | `{taskIds, opType?}` | `Array<{taskId,status,done,raw}>` |
| **transfer** | `qk:transfer:list` | — | `TransferTask[]` |
| | `qk:transfer:upload` | `{localPaths, pdirFid?}` | `string[]`（任务 id，**立即返回**） |
| | `qk:transfer:download` | `{fids, localDir?, names?}` | `string[]`（任务 id，**立即返回**） |
| | `qk:transfer:pause` | `id` | `void` |
| | `qk:transfer:resume` | `id` | `void` |
| | `qk:transfer:retry` | `id` | `void` |
| | `qk:transfer:cancel` | `id` | `void`（并清理临时文件） |
| | `qk:transfer:clear` | `ids` | `void`（仅允许清除已结束任务） |
| | `qk:transfer:open-item` | `id` | `boolean`（文件→资源管理器定位；目录→打开） |
| **dialog** | `qk:dialog:pick-dirs` | — | `string[]` |
| | `qk:dialog:pick-files` | — | `string[]` |
| | `qk:dialog:save-dir` | `defaultPath?` | `string \| null` |
| | `qk:dialog:confirm` | `{title, message, detail?, confirmText?, danger?}` | `boolean`（**二次确认**） |
| | `qk:dialog:open-path` | `path` | `boolean` |
| | `qk:dialog:show-in-folder` | `path` | `boolean` |
| **settings** | `qk:settings:get` | — | `Settings` |
| | `qk:settings:set` | `patch` | `Settings` |

> 已删除未使用的 qk:local:exists 通道。下载引擎通过目标路径占用、临时文件 fid 核验和独占收尾避免覆盖；同名任务分别生成 (1)、(2) 等路径。

**推送通道**（渲染进程订阅，preload 已封装为 `onXxx(cb)` 并返回取消订阅函数）：

| 通道 | 载荷 | 频率 |
|---|---|---|
| `qk:auth-changed` | `AccountState` | 事件驱动 |
| `qk:transfer-update` | `TransferTask[]`（全量） | ≤ 4 次/秒（250ms 节流） |
| `qk:toast` | `{level:'info'\|'warn'\|'error', message}` | 事件驱动 |

### 6.2 错误传递协议（**实测确定，改动前务必读完**）

这是本项目**最容易被改坏**的地方：

1. **主进程 IPC 处理器不抛异常**，而是返回结果信封：
   - 成功 `{ __qk: true, data }`
   - 失败 `{ __qk: false, error: { code, message, bizCode?, httpStatus?, raw? } }`

   **原因**：`ipcRenderer.invoke` 在处理器抛出时，只把错误序列化成一句
   `Error invoking remote method 'x': ...`，**自定义字段（code/bizCode/raw）全部丢失**。

2. **preload 中必须 `throw` 普通对象，不能 `throw new Error()`**。

   **原因**：实测跨 `contextBridge` 抛 `Error` 时只有 `message` 存活（`Object.keys(err)` 为空），
   `code` 被剥离；抛普通对象则字段完整。

3. 渲染侧 `api.js` 的 `normalizeError()` 把该对象归一化成带 `code` 的真正的 `Error`。

> **为什么必须如此严格**：UI 依赖 `err.code === 'NEED_LOGIN'` 弹出
> 「登录状态已失效，请重新登录」提示条（**需求明确要求**）。
> 上述任一环节写错，该提示条就会**静默失效**。`verify/smoke-electron.js` 专门覆盖了这条链路。

4. 主进程检测到 `NEED_LOGIN` 时会主动 `session.markExpired()` + `pushAuthState()` 广播。

---

## 7. 夸克 API 全表（本项目实际使用的）

> 基址：`https://drive-pc.quark.cn`　公共查询参数：`pr=ucpro&fr=pc&uc_param_str=<常量>&device_model=<本机型号>`
> **所有 POST 都必须带上这组公共参数**（不带会被当未登录 guest → 401）。

### 7.1 文件类

| 功能 | 方法 | 路径 | 关键参数 | 证据 |
|---|---|---|---|---|
| 列表（分页） | GET | `/1/clouddrive/file/sort` | `pdir_fid`、`_page`、`_size`、`_fetch_total=1`、`_sort`、`cat`、`fetch_all_file=1`、`fetch_risk_file_name=1` | 客户端 + OpenList |
| 搜索 | GET | `/1/clouddrive/file/search` | **`q`**（唯一有效关键字参数） | **真实账号实测** |
| 单文件详情 | GET | `/1/clouddrive/file/info` | `fid`、`_fetch_full_path`、`need_profile_tags` | 客户端 |
| 路径链（面包屑） | GET | `/1/clouddrive/file/info/path_list` | `fid` | 客户端 |
| 新建文件夹 | POST | `/1/clouddrive/file` | `pdir_fid`、`file_name`、`dir_path`、`dir_init_lock` | 客户端 |
| 重命名 | POST | `/1/clouddrive/file/rename` | `fid`、`file_name` | 客户端 |
| 移动 | POST | `/1/clouddrive/file/move` | `to_pdir_fid`、`filelist`、`exclude_fids`、`action_type` | 客户端 |
| 复制 | POST | `/1/clouddrive/file/copy` | `to_pdir_fid`、`filelist`、`action_type`、`copy_source:1` | 客户端 |
| 批量删除 | POST | `/1/clouddrive/file/delete` | `filelist`、`exclude_fids`、`action_type` | 客户端（**实测通过**） |
| 异步任务状态 | POST | `/1/clouddrive/task/status` | `task_ids`、`op_type`（默认 1） | 客户端 |
| 单任务查询 | GET | `/1/clouddrive/task` | `task_id` | 客户端 |

**`ACTION_TYPE`**：`SYNC = 1`、`ASYNC = 2`。
官方：删除/复制用 `ASYNC(2)`，移动用 `SYNC(1)`。本项目与官方一致。

### 7.2 传输类

| 功能 | 方法 | 路径 | 关键点 |
|---|---|---|---|
| 取下载直链 | POST | `/1/clouddrive/file/download` | `{fids:[...]}` → `data[i].download_url` |
| 上传预登记 | POST | `/1/clouddrive/file/upload/pre` | 返回 `task_id`/`obj_key`/`bucket`/`upload_id`/`upload_url`/`auth_info`/`callback` + `metadata.part_size` |
| 取分片签名 | POST | `/1/clouddrive/file/upload/auth` | body `{task_id, auth_info, auth_meta}` → `data.auth_key` |
| 完成上传 | POST | `/1/clouddrive/file/upload/finish` | body `{obj_key, task_id}` |
| hash 秒传预校验 | POST | `/1/clouddrive/file/update/hash` | md5/sha1 |

### 7.3 账号类

| 功能 | 方法 | 路径 | 关键点 |
|---|---|---|---|
| 判活 | GET | `/1/clouddrive/config` | 已登录 200/`code:0`；未登录 401/`31001` |
| 容量与会员 | GET | `/1/clouddrive/member` | **容量真相来源**：`total_capacity`/`use_capacity` |
| 下载流量 | GET | `/1/clouddrive/quota/remain?type=DL_FLOW` | **必须带 `type`**，且这是流量不是存储容量 |
| 存储明细 | GET | `/1/clouddrive/storage/detail` | 按来源分类占用 |

### 7.4 错误码表

| code | HTTP | 含义 | 可重试 | 本项目映射 |
|---|---|---|---|---|
| `0` | 200 | 成功 | — | — |
| `31001` | 401 | 未登录 / Cookie 失效 | 否 | `NEED_LOGIN` |
| `31002` | — | 无权限 | 否 | `FORBIDDEN` |
| `14001` | 400 | 参数错误 | 否 | `INVALID_ARG` |
| `21001` | 404 | 文件不存在 | 否 | `NOT_FOUND` |
| `22001` | — | 操作失败 | 是 | `UNKNOWN`（可重试） |
| `32003` | 400/409/429 | **语义依赖 HTTP 状态码** | 见左 | 400→`NO_SPACE`（容量不足）；409→`CONFLICT`；429→`RATE_LIMIT` |
| `500` | 500 | 服务端错误 | 是 | `SERVER` |
| `41006` | — | 分享不存在 | — | 本项目不涉及分享 |

---

## 8. 核心算法细节

### 8.1 并行分片下载（`download.js`）

- **阈值**：`> 8 MB` 且服务端支持 Range → 并行分片；否则单流。
- **片大小** 8 MB，**默认 4 并行连接**（对齐官方 `partitionParallelNum`）。
- **写盘**：用**显式偏移 `pwrite`** 并发写同一文件句柄。**绝不能用 `'r+'` 从头写**（曾有把文件写坏的 bug）。
- **续传**：临时文件 `<name>.qkdownloading`，同目录 `<name>.cfg` 记录已完成分片；恢复时**只重下缺失分片**。
- **校验**：每片下完校验字节数，不符则**重下该片**（对齐官方 `CONTENT_MISMATCH`）。
- **403 处理**：分片中 403 → 重新取链 → 只补该片。
- **Range 探测**：`probeRange()` 运行时探测；若返回 200（不支持 Range）→ **降级整体重下**，绝不静默产生损坏文件。
- **原子性**：取消/失败时 `cleanupPartial()` 清理临时文件与进度文件，保证"**要么完整、要么不存在**"。
- **实测提速**：同账号同文件，串行 0.20 MB/s → 并行 0.31 MB/s = **1.55 倍**（45 MB / 8MB×6 片）。

### 8.2 上传四步（`upload.js` + `api-transfer.js`）

1. **预登记** `POST /file/upload/pre`：
   - `metadata.part_size` **必须是 65536 的整数倍**，否则客户端报 `PART_SIZE_WRONG`；缺失报 `PART_SIZE_NULL`。
   - 返回 `data.finish === true` → **秒传**，直接结束。
2. **取签名** `POST /file/upload/auth`：`auth_meta` 是按 OSS 规范拼的待签字符串（PUT 分片 / POST 完成，格式不同）。
3. **直传 OSS**：`PUT https://{bucket}.{upload_url 的主机名}/{obj_key}?partNumber={n}&uploadId={id}`。
   - 头：`Authorization`、`Content-Type`、`Referer: https://pan.quark.cn/`、`x-oss-date`、`x-oss-user-agent`。
   - 每片保留响应头 `Etag`。
4. **完成**：`POST` 同一 OSS 地址（`?uploadId=`）带 `CompleteMultipartUpload` XML + `Content-MD5` + `x-oss-callback`，然后 `POST /file/upload/finish`。

**防御性校验（必须有）**：`partSize` 非法/缺失时 `divideParts` 会返回空数组，
曾导致**跳过全部分片直接 finish，静默产生"上传成功但文件为空"**。

### 8.3 OSS 主机解析（`resolveOssUrl`）

官方逻辑（取自官方 `dist/renderer/ai-knowledge.js`）：
```js
const u = new URL(t.upload_url);
service_domain = u.hostname.replace(`${bucket}.`, '');
if (bucket.startsWith('ul-')) { /* 拼回 ul- 前缀 */ }
```
即 **OSS 主机 = `{bucket}.{upload_url 的主机名}`**，且 bucket 可能带 `ul-` 前缀。
本项目实现一致，并有 5 条单元测试（含带/不带协议、尾斜杠、objKey 前导斜杠）。

### 8.4 会话 Cookie（`session.js`）

- 保存服务端下发的**全部** Cookie，**不硬编码某几个名字**。
- `__puus` **会随响应轮换**，必须在每个响应后回写（`onSetCookie` 回调），否则会话会静默失效。
- 删除判定：`Set-Cookie` 带过期时间且已过期 → 视为删除。
- 判活：`GET /1/clouddrive/config`。

### 8.5 传输任务队列（`transfer.js`）

- `upload()`/`download()` **立即返回任务 id 数组**，真正的执行用 `queueMicrotask(pump)` 启动。
- 进度推送**节流 250ms**（≤4 次/秒），避免高频 IPC 拖垮 UI。
- 速度用 3 秒滑动窗口计算；`eta` 未知时为 `-1`。
- 最大自动重试 3 次，指数退避；`403`/链接过期时**自动重新取链**。
- `clear()` **只允许清除已结束任务**（`done`/`error`/`canceled`），避免把运行中的任务从列表抹掉。

---

## 9. 请求形态对齐（反风控，用户重点要求）

### 9.1 UA（严格按官方模板拼装）

官方源码（`dist/main/main.js`）：
```js
generateUserAgentForFusionQuantumWindow =
  `${await quarkApp.getUserAgent()} quark-cloud-drive/${isPackaged?"2.5.40":"1.0.0"} Channel/${"pckk@other_ch".replace(/^(\w+?)@/,"$1_")}`
// 官方还用 UA 里的 QuarkPC 识别自家客户端：
//   isPcQuark = getUA().indexOf("QuarkPC") > -1
//   getPcQuarkVersion: /QuarkPC\/(\d+\.\d+\.\d+)/
```

本项目 `src/main/core/http.js` 的 `DEFAULT_UA`：
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
Chrome/130.0.6723.191 Safari/537.36 QuarkPC/4.1.5.397
quark-cloud-drive/2.5.40 Channel/pckk_other_ch
```
- `4.1.5.397` = 本机官方客户端 `build_info.json` 的 `product_version`
- `130.0.6723.191` = 本项目实际用的 Electron 内置 Chromium 版本（保证自洽）

### 9.2 其余对齐项

| 项 | 值 | 来源 |
|---|---|---|
| `pr` | `ucpro` | 官方 `getBrowserName() -> "ucpro"` |
| `fr` | `pc` | 官方 |
| `uc_param_str` | `dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt` | 官方 axios 拦截器常量 |
| `device_model` | 本机型号 | 官方每条请求都带 |
| `Referer` | `https://pan.quark.cn/` | OpenList + 客户端 |
| `Origin` | `https://pan.quark.cn` | 客户端 |

> ⚠️ **曾经犯过的错**：早期只根据匿名页面请求，误以为 `uc_param_str` 必须是空串，并把该结论写进了注释。
> 后来从官方 axios 拦截器取证证明**每条请求都带该常量 + `device_model`**，已纠正代码、文档与测试。
> 这个例子说明：**只看一次观测就下结论是危险的**。

### 9.3 端口与协议

**全部 HTTPS 443，没有任何自定义端口**。官方那套 P2P 加速组件（`quark_proxy.exe`）本项目未使用。

---

## 10. 踩坑清单（全部为真实发生过的事故）

> **接手时请逐条阅读**。这些坑的共同特征：**看起来像别的问题**，极易误导排查方向。
> 每条都标注了症状 → 根因 → 修复位置。

| # | 症状（最容易被误判成什么） | 根因 | 修复位置 / 回归测试 |
|---|---|---|---|
| 1 | 下载**必然 403**（看起来像"直链过期"或"Cookie 不匹配"） | `buildUrl(path,'/',query)` 参数顺序写错，`new URL('/', fullUrl)` 把 CDN 路径+查询串全丢了，请求打到 CDN 根路径 | `http.js` 新增 `buildAbsoluteUrl(url,query)`；`test/build-url.test.js` 6 条断言 |
| 2 | 所有写操作（新建/重命名/移动/复制/删除）**401**（看起来像 Cookie 失效） | `api-files.js` 的 POST 传了 `{}` 而非 `{query: COMMON_QUERY}`，服务端当**未登录 guest** | 全部 6 个 POST 补上；`test/common-query.test.js` 9 条测试 |
| 3 | 「Cookie 已失效」提示条**永远不出现**（静默失效） | ① 主进程抛 `Error` 经 IPC 后自定义字段丢失；② preload `throw new Error` 跨 `contextBridge` 时 `code` 被剥离（实测 `Object.keys(err)` 为空） | 结果信封协议 + preload 抛普通对象；冒烟测试覆盖 |
| 4 | 提示"稍后再试"（把用户引向错误方向） | `32003` 被统一映射为限流，真实含义是**容量不足** | 新增 `ErrCode.NO_SPACE` + 中文文案（"网盘容量不足（还需约 175 GB）"） |
| 5 | Electron `net.fetch` 下载 CDN 直链：**挂起或 403**（同一 URL 原生 fetch 却 206） | Electron `net.fetch` 对夸克 CDN 不可用 | `http.js` 传输层分流：`direct:true` 强制原生 fetch |
| 6 | 主进程 stderr 出现 `Failed to serialize arguments`，但**流程不中断**（极易漏掉） | `account.status()` 是 async，却被直接送进 `webContents.send` | `pushAuthState()` 改 async 并 await；`sanitizeTask()` 裁剪任务对象 |
| 7 | 大文件下载**必然失败** | `http.js` 超时设为 `0` → `setTimeout(fn, 0)` 立即中止 | 加 `timeout > 0` 守卫 |
| 8 | 续传后文件**损坏** | 下载续传未维护写入偏移，`'r+'` 句柄从 0 覆盖写 | 改用显式 `pos` 偏移写入 |
| 9 | "上传成功但文件为空"（静默！） | `partSize` 非法/缺失 → `divideParts` 返回 `[]` → 跳过全部分片直接 finish | 加防御性校验；`test/upload.test.js` |
| 10 | 测试打桩失效并**静默打真实网络** | `HttpClient` 构造时 bind 了当时的 `globalThis.fetch` | 改 `_resolveFetch()` 每次解析 |
| 11 | 复选框勾选后**自己被回滚** | UI `preventDefault()` 阻止了浏览器默认切换 | 调整事件处理 |
| 12 | 文件夹与文件**误判** | `isDir` 宽松判定过宽，`{dir:false, file_type:0}` 被当目录 | 收紧判定并加边界测试 |
| 13 | 方案 B 页面**刷新后无用项又出现** | 隐藏脚本用 `window.__qkMiniHide` 做幂等短路，但 `Page.reload` 后新文档复用上下文时标记残留为 `true`，导致 `hide()`/Observer/Interval **全部被跳过** | 改为「`hide()` 无条件执行 + interval 句柄防重复」；`tools/stability-test.js` S4 固化 |
| 14 | `npm run e2e` 报"未登录"却查不出原因 | 调试时多次强杀官方进程 + 清理动作把登录态弄失效了 | 属环境问题；`npm run login` 重新扫码 |
| 15 | 打包时 `electron-builder` 报 `No JSON content found in output` | `PnpmNodeModulesCollector` 解析 pnpm 输出失败（pnpm 污染了 `pnpm list` 输出） | **绕开 electron-builder**，改用手工组装（见 §13.3） |
| 16 | 磁盘被占满（C 盘只剩 0.23 GB），复制文件报 `ENOSPC` | 调试期间产生多份 306 MB 的 `quark.dll` 副本 | 清理冗余副本；**任何 DLL/asar 实验只保留必要副本** |

> **教训总结**：本项目大量 bug 的共同点是「**错误信息指向了错误的方向**」。
> 因此纪律是：**任何"看起来像 X"的结论，都必须再做一次能区分 X 与 Y 的对照实验**（例如 A/B 对照、同条件复现）。

---


### 10.1 本次审查修复的新增问题

| 问题 | 修复 |
|---|---|
| 单次 timeout 被忽略，响应头返回后无法停止下载 | 覆盖 req.timeout，响应体消费完成才释放中止监听 |
| 上传 PUT 缺少签名串要求的查询参数 | 实际 URL 带 partNumber 与 uploadId |
| 并行 PUT 被实际存储端拒绝 PartNotSequential | 并发预读、顺序签名和 PUT |
| 秒传完成又调用 finish | update/hash finish=true 直接结束 |
| 同名并发下载共用临时文件，收尾可能覆盖后来出现的文件 | 路径占用、fid 检查、独占创建目标 |
| Range 错误或并发失败可能导致损坏与关闭句柄竞态 | 校验 Content-Range，失败后中止并等待所有 worker，200 降级单流 |
| 暂停后继续、取消与重试状态竞态 | 按真实执行器占用并发，等待退出后再调度和清理 |
| 搜索 keyword 与容量 DL_FLOW 降级已被文档证伪 | 只用 q 搜索；未知存储容量返回 -1 |
| 启动判活遗漏 await、传输报登录失效未标记会话 | 等待 status 并统一更新/推送认证状态 |
| 正式加密失败退明文、Node 登录工具无法解密 | 正式模式拒绝降级；Electron 辅助进程使用同一 profile 密钥 |
| E2E 只复制密文导致误报未登录 | 在内存解密并按测试 profile 重新加密；跳过返回退出码 2 |
| node --test 执行 tools，测试数字包含调试脚本 | 限定 test/*.test.js |
| 旧列表/面包屑覆盖新目录、目录选择器漏分页 | 请求序号防陈旧结果，增加分页入口 |
| IPC 未校验发送窗口/框架，退出登录保留浏览器会话 | 主窗口主框架白名单；登出清空登录分区并停止传输 |
| 方案 B 的检测标记缺失且新文档脚本反复注册 | 标记检测、按 target 去重；稳定性只关闭自建进程 |
| 调试脚本打印 Cookie、仅凭名称前缀删除远端对象 | 不输出值；删除须提供精确 fid |

## 11. 验证体系（四层，缺一不可）

| 层 | 命令 | 覆盖什么 | 为什么必须有这一层 |
|---|---|---|---|
| 1 单元 | `npm test` | 纯函数与模块逻辑（含协议拼装、分片数学、Cookie 解析） | 最快、可在无网络无登录下跑 |
| 2 集成 | `npm run verify` | 主进程模块装配与协作 | 抓"模块能各自跑但不能一起跑"的问题 |
| 3 冒烟 | `npm run verify:smoke` | **真实启动 Electron**，CDP 附加断言：preload 桥存在、11 项 UI 元素渲染、无未捕获异常、**无外部网络请求** | 唯一同时覆盖主进程+preload+渲染进程的方式 |
| 4 真实 E2E | `npm run e2e` | 真实账号：登录校验→列目录→建目录→**真上传**→核对大小→搜索→重命名→复制→**真下载**→**字节比对**→批量删除→回滚确认 | 唯一能消除"上传/下载从未真实执行过"这一风险的手段 |

### 11.1 E2E 的安全纪律（**极重要**）

- **所有破坏性操作只允许作用于自建的测试对象，绝不动用户已有文件**。
- `verify/e2e-real.js` 实现了 `verifyDownloadOnly()` 兜底：当找不到自建文件时，跳过重命名/移动/删除。
- 测试结束会清理自己创建的内容并做回滚确认。

### 11.2 路由存在性探测法（本项目对抗假接口的核心手段）

该 API 是 Spring Boot 应用：

- 用**错误的方法**请求一个**存在**的路由 → `405` + `HttpRequestMethodNotSupportedException` ⇒ **路径存在**
- 请求**不存在**的路由 → `404` + `"No message available"` ⇒ **路径不存在**

已在无登录态下证伪多个网上流传的假接口：`file/list`（404）、`file/recycle/restore`（404）。
同时证实 `file/recycle/recover`（405）才是正确路径。

---

## 12. 方案 B：官方原生精简版（quark.dll 逆向全记录）

> 用户的核心诉求之一是「尽量全部使用官方的代码功能，只去除无用功能」+「避免风控」。
> 方案 B 就是这条诉求的实现：**直接复用官方客户端本体**。

### 12.1 原理

启动**官方 `quark.exe`**（原生代码、原生网络栈、原生登录态；风控结果不能保证），
再通过 **CDP 注入**隐藏侧边栏的无用项。**不修改官方任何文件**（默认路径下）。

### 12.2 官方侧边栏的真实结构（CDP 实测）

```
首页 / 传输 / 备份 / 快传 / 工具
```
- **保留**：首页（文件管理）、传输
- **隐藏**：备份、快传、工具

DOM 结构（实测）：
```html
<div id="nav-item-备份" class="SiderNav__nav-item--aqK4a">
  <div class="nav-one-ico SiderNav__nav-icon--Ll9Zr">…</div>
  <span class="SiderNav__nav-item-label--Lb6fk">备份</span>
</div>
```
→ 因此隐藏策略是**按 id 精确定位**：`document.getElementById('nav-item-备份').style.display='none'`。

### 12.3 性能减负（从 quark.dll 取证到的**官方内部开关**）

用字符串取证从 `quark.dll`（306 MB）的 `.rdata` 段挖出官方自己的调试开关：

| 开关 | 效果（实测） |
|---|---|
| `--disable-apollo` 及 3 个衍生（`-web-audio` / `-memorybuffer-video-output` / `-qmni-asr-provider`） | **播放器进程消失**（-294 MB） |
| `--disable-quantum-node` `--no-node` | 量子桥第二实例消失 |
| `--disable-background-networking` `--disable-component-update` `--no-pings` | 减少后台活动 |

**最终效果（实测）**：

| 指标 | 原版 | 精简版 |
|---|---|---|
| 进程数 | 18 | 15～17 |
| 内存 | 1875 MB | **1254～1341 MB（约 -28%）** |
| 90 秒长跑 | — | 内存**不升反降**（-327 MB），无泄漏 |

### 12.4 已尝试但**放弃**的路线（附实测证据，避免重复投入）

| 路线 | 结果 |
|---|---|
| 二进制补丁：把 `.rdata` 里 3 个 Mojo 服务名字符串等长替换为无效名 | ⚠️ **技术可行**：程序不崩溃、3 个服务确实消失（`passage_embeddings` / `uc.wpk` / `node.quantum`）。**但服务进程仍被拉起**（只是名字变了），**不能减少进程**；且属修改官方文件，收益/风险不成比例 → **已放弃，官方 DLL 已按 SHA256 逐字节还原** |
| 标准 Chromium 开关压 AI 向量 / 埋点 | ❌ 无效（它们是私有 Mojo 服务，不走 Chromium feature 机制） |
| `--single-process` 合并进程 | ❌ 官方定制 Chromium 直接拒绝，**进程数 0（起不来）** |

**还原方法**（无需备份文件，源码级可逆）：`tools/dll_research/restore_dll.py` 把 3 个偏移写回原始字符串，
校验目标 SHA256 前缀 `47579001A3707413`。**动过官方 DLL 后一定要跑这个脚本确认哈希。**

### 12.5 稳定性验证（13 项，`npm run stability`）

| 场景 | 内容 |
|---|---|
| S1 冷启动 | 主窗口出现、3 项隐藏成功、2 项保留可见 |
| S2 隐藏持久 | 30 秒 × 6 次采样状态稳定 |
| S3 导航往返 | 切到传输页再回主页，隐藏仍生效 |
| S4 刷新恢复 | `Page.reload` 后隐藏自动恢复（**曾抓出真实缺陷，见 §10 第 13 条**） |
| S5 稳定运行 90 秒 | 无崩溃、无内存泄漏、隐藏持续生效 |

启动器 `tools/quark-mini-native.js` 内置**每 4 秒检查真实导航隐藏状态并自动重注入**兜底。

### 12.6 关于「能否直接复用官方 JS 代码」

**不可行**（证据：`reference/quark_asar/package.json` + `tools/count_private_api.py`）：

- 依赖 `@ali/xdrive`、`@ali/quark-pdfsdk` 是**阿里私有包**；`better-sqlite3`/`ffi-napi`/`ref-napi` 都是**打过补丁的版本**；仓库在内网 GitLab。
- 官方 JS 深度依赖**只存在于其定制环境**的私有 API，实测引用次数：

| 类别 | 引用次数 |
|---|---|
| `unet` / `netLib`（自研网络栈） | 2,333 |
| `quantum.*`（原生桥，quark.dll） | 1,936 |
| `chrome.quark*`（定制 Chromium 扩展） | 1,544 |
| `chrome.account`（私有登录 API） | 1,310 |
| `xdrive`（本地文件系统原生模块） | 105 |
| `process.quantum*` | 3 |
| **合计** | **7,231** |

→ 把这些 JS 搬到标准 Electron 里**根本跑不起来**。

**因此本项目走「行为等价」路线**：不搬运代码，而搬运**协议与算法**（同样的端点、参数、UA、OSS 签名、并行分片模型、原生 Cookie 登录机制）。方案 A 的本次常用功能链路已验证，完整性能对比尚未完成；方案 B 复用官方本体。

---

## 13. 打包与发布

### 13.1 方案 A 便携版（推荐路径）

```powershell
npm run pack        # → dist/夸克网盘极简版/夸克网盘极简版.exe
```

`tools/make-portable.js` 做的事：
1. 检查 `dist/win-unpacked/electron.exe` 是否存在；缺失时从已安装 Electron 复制运行时
2. 把 `src/` + `package.json` 复制到 `.build-staging/`
3. 用 `@electron/asar` 的 `createPackage()` 打成 `dist/win-unpacked/resources/app.asar`
4. 复制到 `dist/夸克网盘极简版/`，把 `electron.exe` 重命名为 `夸克网盘极简版.exe`，并关闭 RunAsNode、NODE_OPTIONS 和 Node inspect fuses
5. 写入 `使用说明.txt`

### 13.2 asar 格式（若需自己实现打包器）

```
[0:4]   uint32 LE = 4                    （pickle size 字段本身占 4 字节）
[4:8]   uint32 LE = header_pickle_size
[8:12]  uint32 LE = 4 + json_len
[12:16] uint32 LE = json_len
[16:16+json_len] header JSON (UTF-8)
[数据区]  各文件按 offset 顺序拼接，offset 相对数据区起点（**注意 offset 是字符串**）
```
- 目录节点：`{ "files": { <子节点名>: <节点> } }`
- 文件节点：`{ "size": N, "offset": "M" }`

> **坑**：本项目曾自己实现 asar 打包器（`tools/build_asar.py`），因**少写了一层 Chromium Pickle 头**
> 导致 Electron 报 `Failed to parse header from ... app.asar` 且进程无法启动。
> **结论：直接用 `@electron/asar` 的 `createPackage()`，不要手写。**

### 13.3 为什么不使用 electron-builder

`electron-builder` 在本机会失败：
```
⨯ No JSON content found in output
  at PnpmNodeModulesCollector.parseDependenciesTree / extractJsonFromPollutedOutput
```
原因：pnpm 污染了 `pnpm list` 的输出，解析器拿不到合法 JSON。

**由于主进程零第三方依赖**（只有 Node 内置模块 + `electron`），可以安全地**跳过 node_modules 收集**，
因此改用手工组装（§13.1）。`builder.config.json` 仍保留，但**当前打包流程不使用它**。

---

## 14. 接手后的禁区与检查清单

### 14.1 绝对不要做的事

1. **不要凭空假定未验证的 API 可用**（用户明确要求）。新端点必须先取证并补录 `docs/API_NOTES.md`。
2. **不要修改官方客户端安装目录下的任何文件**，除非你同时准备好还原方案并验证过 SHA256。
   官方 `quark.dll` 的正确 SHA256 前缀：`47579001A3707413`。
3. **不要用 `Error` 跨 IPC 传错误**（见 §6.2），否则「Cookie 失效」提示条会静默失效。
4. **不要给 POST 请求漏掉 `{query: COMMON_QUERY}`**，否则服务端当未登录 guest。
5. **不要用 `buildUrl` 处理绝对 URL**，必须用 `buildAbsoluteUrl`。
6. **不要让 CDN/OSS 请求走 Electron `net.fetch`**，必须走原生 `fetch`。
7. **不要对用户的真实文件做破坏性操作**。E2E 只能动自建测试对象。
8. **不要在日志里输出 Cookie 值**。
9. **不要引入第三方运行时依赖**（保持"主进程零依赖"这条特性，它让打包与审计都变得简单）。
10. **不要删除"待确认状态"的降级路径**。用户明确要求"无法验证的接口保留明确的待实现状态"。

### 14.2 修改代码后的检查清单

```powershell
# 1) 语法全量检查（含 tools/verify/test）
Get-ChildItem src,scripts,verify,test -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }

# 2) 四层验证
npm test                    # 期望 216 / 216
npm run verify              # 期望 48 / 48
npm run verify:smoke        # 期望 28 / 28
npm run e2e                 # 需登录；期望 29 项通过，跳过时退出码为 2

# 3) 若改了方案 B 相关代码
npm run stability           # 期望 13 / 13

# 4) 若改了源码外观/资源，重新打包并**实际双击验证**
npm run pack
```

### 14.3 需求符合性自检表（提交前逐条打勾）

- [ ] 文件浏览（面包屑 + 列表 + **目录分页加载**）可用
- [ ] 搜索可用（参数是 `q`）
- [ ] 新建文件夹 / 重命名 / 移动 / 复制 / **批量删除** 可用
- [ ] 上传可用，且**异步不阻塞 UI**
- [ ] 下载可用，**支持断点续传**、**失败重试**
- [ ] 传输任务管理（进度/速度/剩余时间/暂停/继续/重试/取消）可用
- [ ] **文件操作有二次确认**
- [ ] 登录态**加密存储**；Cookie 失效有**明确中文提示条**且可一键重新登录
- [ ] UI 中**不存在** AI / 播放器 / 推广 / 同步盘 / 分享 / 相册 等任何入口
- [ ] 渲染进程**不发起任何外部网络请求**
- [ ] 请求头与官方一致（UA / `pr` / `fr` / `uc_param_str` / `device_model` / `Referer`）
- [ ] 全部界面文案与日志为**简体中文**
- [ ] 未验证的接口**保留了明确的待实现/降级状态**，没有假装成功

---

## 15. 附录：关键路径速查

| 项 | 路径 |
|---|---|
| 项目根 | `C:\Users\USER\Documents\qck` |
| 便携版 exe | `dist\夸克网盘极简版\夸克网盘极简版.exe` |
| 便携版 app.asar | `dist\win-unpacked\resources\app.asar` |
| 登录态落盘 | `%APPDATA%\quark-mini\session.bin` |
| 下载临时文件 | 目标目录下 `<name>.qkdownloading` + `<name>.cfg` |
| 官方客户端 | `C:\Users\USER\AppData\Local\Programs\Quark\quark.exe` |
| 官方 quark.dll | `...\Quark\7.3.5.1009\quark.dll`（原版 SHA256 前缀 `47579001A3707413`） |
| 官方客户端登录态 | `C:\Users\USER\AppData\Local\Quark\User Data`（**与本项目登录态相互独立**） |
| 逆向证据 | `reference\quark_asar\`（3019 文件）、`reference\MINED_ENDPOINTS.md`（273 端点） |
| 备份 | `C:\Users\USER\Documents\qck-backup-*\`（含《备份说明.md》） |

### 15.1 调试小技巧

- **想看渲染进程状态**：用 CDP 附加。方案 A 的冒烟脚本用的端口是 `9777`，E2E 用 `9788`，方案 B 用 `9777`。
- **CDP 客户端**：本项目在 `verify/` 与 `tools/` 里内置了极简 CDP 实现（依赖 Node 24 的全局 `WebSocket`，**不要在 Electron 主进程里用**）。
- **官方客户端窗口 URL**：`uccd://cloud.quark/clouddrive/renderer/index.html?name=main#/list/all`。
  注意匹配主窗口时的正则要写 `index\.html\?name=main`（**曾因漏写 `.html` 导致"主窗口找不到"的误判**）。
- **网络受限**：`raw.githubusercontent.com` 在本机被 TLS 重置，取 GitHub 文件需经 `https://ghproxy.net/` 镜像，或使用 `api.github.com` contents API。

---

## 16. 文档维护约定

1. **`docs/API_NOTES.md` 是接口的唯一真相来源**。任何接口层面的新发现/更正都必须先改它，再改代码。
2. 本文档（`HANDOVER.md`）记录**项目状态、架构、坑、禁区**。发生以下情况时必须更新：
   - 新增/删除文件或 IPC 通道
   - 修复了一个"容易被误判"的 bug（补进 §10）
   - 完成了 §2.3 里某个"已知未完成"
   - 改变了打包/启动方式
3. `README.md` 面向**最终用户**，只讲怎么用、有什么限制；技术细节放 `docs/`。
4. 所有文档、注释、提交信息、界面文案**一律简体中文**。
