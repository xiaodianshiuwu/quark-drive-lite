# 开发说明

面向需要修改、调试或维护本项目代码的开发者。使用说明见 [README](../README.md)，平台与构建细节见 [平台支持与构建](PLATFORM_SUPPORT.md)。

## 1. 设计边界

本项目的定位是**只做文件管理**。修改代码时请保持这条边界：

**应当保留**：文件浏览与分页、搜索、新建文件夹、重命名、移动、复制、批量删除、上传、下载、传输任务管理、设置（下载目录 / 并发 / 主题）、账号与容量显示。

**不应引入**：AI 助手与问答、音视频播放器、推广与会员购买入口、同步盘与备份、分享、相册与时间线、文档预览转换、加速器、聊天。

`verify/smoke-electron.js` 会对界面做一次关键字检查，确认没有上述模块的入口残留。新增界面元素时不要引入这些字样。

## 2. 环境与启动

### 依赖版本

| 项目 | 版本 |
|---|---|
| Node.js | 24.18.0 或更高 |
| pnpm | 11.25.0 |
| Electron | 44.7.2（`devDependencies` 锁定） |

主进程**没有第三方运行时依赖**，只使用 Node 内置模块与 `electron`。开发依赖为 `electron`、`@electron/asar`、`electron-builder`、`playwright-core`。

### 启动

```bash
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
npm start
```

### 三个容易踩的坑

1. **必须用 `npm start` 启动。** 它走 `scripts/start.js`，会在启动前清除 `ELECTRON_RUN_AS_NODE`。该变量会让 Electron 以纯 Node 模式运行，表现为 `require('electron').app === undefined`，报出 `TypeError: Cannot read properties of undefined (reading 'whenReady')` 这类极具误导性的错误。任何自行 spawn Electron 的脚本都要先清除该变量。

2. **不要用裸 `node --test test/`。** 请使用 `npm test`（`node --test test/*.test.js`）。带目录的形式会把 `tools/` 下的脚本一并当作测试执行。

3. **不要假设 Electron 环境具备与 Node 相同的全局对象。** `verify/` 中的极简 CDP 客户端依赖 Node 24 的全局 `WebSocket`，请用项目声明的 Node 版本运行这些脚本，不要在 Electron 主进程内直接使用。

## 3. 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 以开发模式启动应用 |
| `npm run check` | JavaScript 语法与打包配置检查 |
| `npm test` | 单元测试 |
| `npm run verify` | 模块间集成验证 |
| `npm run verify:smoke` | 真机冒烟测试（会真实启动 Electron） |
| `npm run verify:all` | 依次运行单测、集成与冒烟 |
| `npm run e2e` | 真实账号端到端验证（需先登录） |
| `npm run login` | 弹出独立窗口辅助登录 |
| `npm run import-session` | 从 Chrome / Edge 已登录会话导入（`--list` 列出候选） |
| `npm run migrate-session` | 迁移旧格式登录资料 |
| `npm run pack:win` / `pack:linux` / `pack:mac` | 生成对应平台的构建产物 |

## 4. 架构

### 进程模型

```
┌──────────────────── 主进程（Node + Electron） ────────────────────┐
│  main.js ── 装配 ──┬─ core/http.js         唯一出网口             │
│                    ├─ core/session.js      Cookie jar             │
│                    ├─ core/secure-store.js 本地加密存储            │
│                    ├─ core/login.js        登录窗口与判活          │
│                    ├─ core/api-files.js    文件类协议              │
│                    ├─ core/api-transfer.js 传输类协议与请求签名     │
│                    ├─ core/download.js     下载引擎                │
│                    ├─ core/upload.js       上传引擎                │
│                    ├─ modules/fs.js        文件业务与异步任务轮询    │
│                    ├─ modules/transfer.js  传输任务队列            │
│                    ├─ modules/account.js   账号、容量              │
│                    └─ modules/settings.js  设置                   │
└──────────────────────────────┬───────────────────────────────────┘
                               │ IPC（结果信封协议，见第 6 节）
┌──────────────────────────────┴───────────────────────────────────┐
│  preload.js   唯一的桥：白名单方法 + 解信封 + 抛普通对象             │
├──────────────────────────────────────────────────────────────────┤
│  渲染进程：index.html + app.js + api.js + styles.css              │
│  纯原生 HTML / CSS / JS，无框架、无 CDN，CSP connect-src 'none'    │
└──────────────────────────────────────────────────────────────────┘
```

### 安全基线（不可放松）

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
- 渲染进程只能通过 `window.qk` 调用白名单方法，**不要暴露 `ipcRenderer` 本体或任意通道调用能力**。
- 主进程的 IPC 处理器会校验调用来源，只接受主窗口主框架的调用。
- `will-navigate` 拦截一切外部导航；`setWindowOpenHandler` 一律拒绝。
- 渲染页 CSP 为 `connect-src 'none'`，渲染进程不应发起任何网络请求。
- **不要在任何日志中输出 Cookie 值。**
- 登录资料必须加密落盘，写入采用「先写临时文件再原子替换」。

### 关键数据流

**登录**（与官方客户端机制一致）：

```
点击「登录」→ login.js 打开 BrowserWindow（内存分区 quark-login）
  → 加载 https://pan.quark.cn/ → 用户扫码或输入手机号
  → 轮询读取该分区全部 Cookie（含 HttpOnly）
  → 带 Cookie 请求判活接口，确认登录成功后加密落盘
```

判活使用 `GET /1/clouddrive/config`，只有 HTTP 200 且 `code === 0` 才算登录成功，不去猜测 Cookie 名称。

**下载**：

```
选择文件 → transfer.download({fids, localDir}) 立即返回任务 id
  → 队列调度 → 取文件名 → 取下载直链
  → download.js 探测 Range → 支持且大于阈值则并行分片，否则单流
  → 进度节流推送 → 完成后校验字节数并原子改名
```

**上传**（四步）：

```
POST /file/upload/pre（预登记）→ POST /file/upload/auth（取签名）
  → 分片直传对象存储 → POST /file/upload/finish
  → 若 pre 返回 finish === true 则为秒传，直接结束
```

## 5. 模块职责

### 主进程

| 文件 | 职责与关键点 |
|---|---|
| `src/main/main.js` | 装配、IPC 白名单、窗口。定义结果信封包装 `handle()`；`pushAuthState` 是 async，必须 await 后再 `send`；`sanitizeTask()` 把任务对象裁剪成可序列化的纯数据 |
| `src/main/preload.js` | 唯一的桥。`errorDescriptor()` 构造跨隔离世界仍保留字段的错误对象；`invoke()` 解信封；`subscribe` / `subscribeAsync` 用于推送订阅 |

### 核心层 `src/main/core/`

| 文件 | 职责与关键点 |
|---|---|
| `http.js` | 唯一出网口。负责超时、重试、中止、`Set-Cookie` 回写；直连请求强制走原生 `fetch` |
| `session.js` | Cookie jar。`__puus` 会随响应轮换，必须逐响应回写，否则会话会静默失效 |
| `secure-store.js` | 加密存储入口。默认使用本机随机密钥（`local-store.js`）；系统加密后端仅用于旧格式迁移与兼容验收 |
| `login.js` | 登录窗口与判活。总超时 180 秒，轮询间隔 1.5 秒，单次判活 20 秒 |
| `normalize.js` | 响应归一化，**永不抛异常**。`isDir` 判定需要容忍 `true` / `1` / `"1"`，但不能过宽 |
| `api-files.js` | 文件类接口封装。**所有 POST 都必须带公共查询参数**，否则会被服务端当作未登录访客 |
| `api-transfer.js` | 传输类接口与请求签名纯函数。分片大小必须是 65536 的整数倍 |
| `download.js` | 下载引擎。阈值 8 MiB，分片 8 MiB，默认 4 路并行；临时文件 `.qkdownloading` 与同名 `.cfg` 进度 |
| `upload.js` | 上传引擎。分片预读并发默认 2，写入按编号顺序执行，分片级重试 3 次；必须有分片大小防御性校验 |

### 业务层 `src/main/modules/`

| 文件 | 职责与关键点 |
|---|---|
| `account.js` | 账号、容量与会员信息。容量取自成员接口的 `total_capacity` / `use_capacity` |
| `fs.js` | 文件业务层。统一中文错误；异步任务轮询间隔 1 秒、超时 180 秒 |
| `transfer.js` | 任务队列。进度节流至每秒最多 4 次推送；测速窗口 3 秒；最大重试 3 次；`upload()` / `download()` 入队后立即返回任务 id |
| `settings.js` | 设置。并发分「文件级」与「分片级」两类，读写两侧都会做范围钳制 |

### 渲染层 `src/renderer/`

| 文件 | 说明 |
|---|---|
| `index.html` | 三个视图：`#view-files` / `#view-transfers` / `#view-settings`，左侧导航三项。无任何 CDN 引用 |
| `app.js` | 全部界面逻辑。列表使用 `insertChunked()` 按帧分批插入，避免长列表阻塞 |
| `api.js` | 桥接包装层。包含契约自检、错误归一化，以及默认关闭的 `?mock=1` 假数据模式 |
| `styles.css` | 样式，含深浅色主题 |

## 6. IPC 契约

通道总表见 [IPC_CONTRACT.md](IPC_CONTRACT.md)。以下是最容易被改坏的部分。

### 错误传递协议

1. **主进程的 IPC 处理器不抛异常**，而是返回结果信封：

   - 成功 `{ __qk: true, data }`
   - 失败 `{ __qk: false, error: { code, message, bizCode?, httpStatus?, raw? } }`

   原因：`ipcRenderer.invoke` 在处理器抛出时只会把错误序列化成一句 `Error invoking remote method '...'`，自定义字段会全部丢失。

2. **preload 中必须抛出普通对象，不要抛 `Error`。** 跨 `contextBridge` 抛 `Error` 时只有 `message` 能存活，`code` 会被剥离；抛普通对象则字段完整。

3. 渲染层 `api.js` 的 `normalizeError()` 把该对象还原成带 `code` 的 `Error`。

4. 主进程检测到登录失效时会主动标记会话过期并广播状态变化。

> 界面依赖 `err.code === 'NEED_LOGIN'` 来显示「登录状态已失效」提示条，上述任一环节写错都会让它静默失效。`verify/smoke-electron.js` 覆盖了这条链路。

## 7. 传输引擎要点

### 下载

- 先用 `Range: bytes=0-0` 探测服务端是否支持范围请求；支持且文件大于阈值时走并行分片。
- 临时文件为 `<文件名>.qkdownloading`，进度文件为 `<文件名>.qkdownloading.cfg`，进度定期原子刷盘。
- 续传前会校验文件标识、分片大小、总长度与 ETag；任一不匹配则清理临时文件后安全重下，避免产生损坏文件。
- 不支持范围请求时自动降级为单流下载。
- 下载直链过期（403）时会重新取链后继续。
- 完成后使用硬链接（失败时回落到独占创建）生成最终文件，**目标已存在时报冲突，绝不覆盖**。

### 上传

- 分片大小取自服务端返回的 `part_size`，必须是 65536 的整数倍；非法或缺失时直接报错，避免「上传成功但文件为空」。
- 实际存储端要求分片按连续编号顺序写入，因此实现为「分片预读并发 + 写入串行」。设置中的分片并发只影响预读，不代表并行上传。
- 秒传有两条路径：预登记直接返回完成，或客户端计算哈希后调用哈希更新接口。
- 上传不做整任务重试，改为**结果核对**：在目录中查找「新增且大小一致」的唯一匹配项，找不到或多于一个都判定为失败。

## 8. 验证体系

| 层次 | 命令 | 说明 |
|---|---|---|
| 静态检查 | `npm run check` | JavaScript 语法与打包配置 |
| 单元测试 | `npm test` | 纯 Node，不需要 Electron、网络或登录 |
| 集成验证 | `npm run verify` | 模块装配与请求构造 |
| 冒烟测试 | `npm run verify:smoke` | 真实启动 Electron，检查桥接契约、沙箱隔离与界面元素 |
| 真实账号 E2E | `npm run e2e` | 需要先登录 |

### 运行真实账号验证时的纪律

- 只在随机命名的专用测试目录内操作，**绝不动用户已有文件**。
- 上传使用随机内容，避免命中秒传而绕过真实上传链路。
- 校验以内容哈希回读为准，不以目录可见性或数字状态枚举推断完成。
- 测试结束后清理自建对象，并以目录中原文件标识已消失作为核对依据。
- 并发下载同名文件、并发写同一路径等场景不要在真实账号上手工试探。

### 路由存在性探测

服务端为 Spring Boot 应用：用错误的方法请求存在的路由返回 `405`，请求不存在的路由返回 `404` 且响应体为 `No message available`。可以在未登录状态下据此证伪流传的错误端点。

## 9. 打包与发布

```bash
npm run pack:win
npm run pack:linux
npm run pack:mac
```

- 所有构建显式使用 `--publish never`，不会自动上传产物。
- Windows 便携版由 `tools/make-portable.js` 生成，它会比对应用归档的版本并逐字节校验 `src/` 与归档一致，不一致时直接报错。
- 构建产物会关闭 `runAsNode`、`NODE_OPTIONS` 与 `--inspect` 相关的 Electron fuses，便携版生成后会复核这三项确实为关闭状态。
- 预发布由发布工作流在指定的验证运行全部成功、且产物哈希逐项校验通过后创建；验证运行的提交必须与当前 `main` 完全一致。
- 新增预发布版本时，需要同步新增 `docs/PRERELEASE_<版本>.md`，发布说明从该文件读取。

平台矩阵与产物命名见 [平台支持与构建](PLATFORM_SUPPORT.md)。

## 10. 维护约定

### 修改代码后的检查清单

```bash
npm run check
npm test
npm run verify
npm run verify:smoke
```

改动了界面或资源后，还需要重新打包并实际启动打包产物验证一次。

### 需要同步更新的内容

- 接口、参数或错误码有变化时，同步 [API_NOTES.md](API_NOTES.md)。
- IPC 通道或数据结构有变化时，同步 [IPC_CONTRACT.md](IPC_CONTRACT.md)。
- 用户可见的行为变化写入 [CHANGELOG.md](CHANGELOG.md)。
- 安装方式、支持平台或已知限制有变化时，同步 [README](../README.md) 与 [平台支持与构建](PLATFORM_SUPPORT.md)。

### 注意事项

- 不要提交登录资料、Cookie、密钥、测试 profile、运行日志与构建产物；`.gitignore` 已覆盖这些路径。
- 大文件不要进 Git 历史，走 Release 附件。
- `reference/` 与 `tools/` 中的取证材料和实验脚本不是产品运行依赖，产品打包只包含 `src/` 与 `package.json`。修改产品代码时不要引入对它们的依赖。
- 单元测试的入口是 `npm test`，它已明确限定测试目录；不要改成扫描整个仓库。
