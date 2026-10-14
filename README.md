> 公开版本已脱敏。官方客户端解包、安装标记、原始日志、历史原型与研究二进制保留在原私有归档，不随本仓库公开；产品构建不需要这些材料。

# 夸克网盘极简桌面客户端

一个**极简**的夸克网盘 Windows 桌面客户端。只做最基本的文件管理：**浏览、搜索、新建、移动、复制、重命名、批量删除、上传、下载、传输任务管理**。

方案 A 中不包含：AI 助手、音视频播放器、推广/会员购买、同步盘/备份、分享、相册、文档转换、加速器等无关功能。

本项目提供**两个方案**，按你的需求选择：

| 方案 | 命令 | 特点 |
|---|---|---|
| **A. 独立极简版（推荐）** | `npm run pack` | 自主实现的 Electron 应用。并行分片下载、断点续传及本次真实账号链路已验证。绿色便携，双击即用 |
| **B. 官方原生精简版** | `npm run native` | **复用官方客户端全部原生代码**（下载/上传/网络栈/登录态都是官方实现，使用官方网络栈，不能保证风控结果），运行时隐藏侧边栏的「备份/快传/工具」，只留「首页/传输」 |

> 方案 A 的常用操作已通过本次真实账号验证；方案 B 仅隐藏导航并减负。完整性能等价尚未验证。

---

## 方案 A：独立极简版（绿色便携，双击即用）

```powershell
npm run pack        # 一键生成 dist/夸克网盘极简版/
```

产出 `dist/夸克网盘极简版/夸克网盘极简版.exe`（约 180MB），**把整个文件夹拷到任意 Windows 机器，双击 exe 即用**，无需安装、无需 Node。

---

## 方案 B：官方原生精简版

```powershell
npm run native      # 启动官方客户端，自动隐藏 备份/快传/工具
npm run stability   # 稳定性专项测试（13 项，含 90 秒长跑）
```

- 文件管理 / 搜索 / 上传 / 下载 / 传输 = **官方原生实现**，体验与官方完全一致
- 复用官方网络实现；是否触发风控取决于实际服务端策略，不能保证
- 侧边栏只显示「首页 / 传输」，隐藏「备份 / 快传 / 工具」等无用项
- **性能减负**（quark.dll 逆向取证的官方内部开关）：
  - `--disable-apollo` 系列 → 播放器进程消失
  - `--disable-quantum-node --no-node` → 量子桥第二实例消失
  - 实测内存 **1875MB → 1254~1341MB（约 -28%）**，长跑中持续回落无泄漏

### 稳定性验证（13 项全通过）

| 场景 | 结果 |
|---|---|
| S1 冷启动 | 主窗口出现、隐藏注入成功、首页/传输保留 |
| S2 隐藏持久 | 30 秒 6 次采样全部稳定 |
| S3 导航往返 | 切传输页再回主页，隐藏仍生效 |
| S4 刷新恢复 | 页面重载后隐藏自动恢复 |
| S5 稳定运行 90 秒 | 无崩溃、无内存泄漏（-327MB）、隐藏持续生效 |

> 稳定性测试曾抓出一个真实缺陷并已修复：原隐藏脚本用「`window.__qkMiniHide` 存在即 return」做幂等短路，
> 但 `Page.reload` 后新文档复用上下文时该标记残留为 true，导致 hide()/Observer/Interval 全部被跳过、
> 隐藏静默失效。已改为「hide() 无条件执行 + interval 句柄防重复」，并在 13 项稳定性测试中固化。

---

## 快速开始

```powershell
# 1) 安装依赖（仅 electron 一个开发依赖）
pnpm install
node node_modules/electron/install.js   # 若 electron 二进制未自动下载

# 2) 启动
npm start
```

> **重要**：请务必用 `npm start`（它走 `scripts/start.js`）。
> 直接运行 `electron.exe` 在本机可能失败，因为环境里设置了 `ELECTRON_RUN_AS_NODE=1`，
> 这会让 Electron 以**纯 Node 模式**启动，报出极具误导性的
> `TypeError: Cannot read properties of undefined (reading 'whenReady')`。
> `scripts/start.js` 会在启动前清除该变量，并给出明确的中文报错。

## 首次使用：登录（两种方式）

### 方式一：应用内登录（推荐）

```powershell
npm start
```

点击右上角「登录」，会弹出一个**真实的登录窗口**（加载 `pan.quark.cn`），你在里面扫码 / 输手机号完成登录。
登录成功后应用自动读取该会话的 Cookie 并加密保存，窗口自动关闭；**下次启动免扫码**。

> 这套机制与**官方 PC 客户端完全一致**——官方客户端本身也不实现登录协议，
> 而是调用 Chromium 原生能力打开登录窗口，登录后直接读取浏览器 Cookie。

### 方式二：辅助登录（弹出独立窗口扫码，适合配合自动化验证）

```powershell
npm run login            # 弹出可见浏览器窗口，你扫码登录
npm run import-session   # 或从 Chrome/Edge 已登录的账号直接导入
```

登录成功后即可运行真实端到端验证：

```powershell
npm run e2e
```

Cookie 失效时，界面顶部会出现醒目的中文提示条「登录状态已失效，请重新登录」，点一下即可重新登录。

---

## 本地登录态的安全存储

- Cookie 经 **Electron `safeStorage`**（Windows 下为 DPAPI，绑定当前用户）加密后落盘。
- 落盘位置：`%APPDATA%\quark-mini\session.bin`（Electron 的 userData 目录）。
- 写入采用**原子替换**（先写 `.tmp` 再 `rename`），避免断电产生半截文件。
- **绝不在日志中输出 Cookie 值**。
- 正式应用及登录工具强制使用系统加密；加密失败时拒绝保存凭证。

---

## 功能与限制（如实说明）

### 已实现

| 功能 | 说明 |
|---|---|
| 文件浏览 | 面包屑导航、双击进入、**滚动到底自动分页加载** |
| 搜索 | 按文件名搜索 |
| 新建文件夹 | 带非法字符校验 |
| 重命名 / 移动 / 复制 | 移动与复制需选择目标目录（逐层浏览） |
| 批量删除 | 多选（Ctrl / Shift / 全选）+ **二次确认**（红色危险按钮，显示将删除的项目数与名称） |
| 上传 | 支持多选、**拖拽上传**；大文件自动分片 |
| 下载 | 支持多选、**断点续传**、失败自动重试 |
| 传输任务管理 | 进度、速度、剩余时间、暂停/继续/重试/取消、清除记录 |
| 设置 | 下载目录、上传/下载并发数、深浅色主题（持久化） |

### 技术特性

- **网络操作全部异步**，运行在主进程，绝不阻塞 UI（`upload()`/`download()` 入队后立即返回任务 id）。
- **断点续传**：临时文件 `*.qkdownloading` + 进度文件 `*.qkdownloading.cfg`；
  续传发送 `Range` 请求；若服务端返回 200 而非 206（不支持 Range），**自动降级为整体重下**，绝不产生损坏文件。
- **大文件并行分片下载**（对齐官方 `multipartDownload`）：>8MB 且服务端支持 Range 时，
  按 8MB/片、默认 4 连接并行下载，用显式文件偏移并发写入；分片级断点续传只补缺失分片；
  分片字节数不符自动重下该片（对齐官方 `CONTENT_MISMATCH`）；分片中 403 自动重取链。
- **大文件分片上传**：按服务端返回的 `part_size` 分片（必须为 65536 整数倍），默认 2 路预读、顺序 PUT（实际存储端要求连续编号）。
- **失败重试**：指数退避 1s / 2s / 4s；「未登录」类错误不重试，直接提示重新登录。
- **下载直链过期（403）自动重新取链**并继续续传。
- **上传秒传**：支持服务端 `finish` 与 `update/hash` 两条秒传路径。
- 最终文件要么完整、要么不存在（完成时才原子改名）。

#### 并发设置（区分「多文件」与「大文件」两种场景）

| 设置项 | 含义 | 范围 | 默认 |
|---|---|---|---|
| 同时上传的文件数 | 多文件上传时的任务并发 | 1–8 | 2 |
| 单文件上传分片预读 | 上传分片预读并发，真正 PUT 按顺序执行 | 1–8 | 2 |
| 同时下载的文件数 | 多文件下载时的任务并发 | 1–5 | 2 |
| 单文件下载并行连接数 | 大文件多连接并行下载（决定单文件速度） | 1–16 | 4 |

> 说明：文件级并发过高容易被服务端限流；分片级并发（官方 `partitionParallelNum` 同类）才是大文件提速的关键。

### 请求形态与官方一致（降低风控风险）

- **UA 严格按官方模板拼装**，非自造。官方构造（取自其 `app.asar`）：
  `${baseUA} quark-cloud-drive/2.5.40 Channel/pckk_other_ch`，
  且官方自身用 `UA.indexOf("QuarkPC") > -1` 识别自家客户端。
  本项目 UA：
  `… Chrome/130.0.6723.191 Safari/537.36 QuarkPC/4.1.5.397 quark-cloud-drive/2.5.40 Channel/pckk_other_ch`
  （版本号取自本机已装客户端 `build_info.json`，Chromium 版本取自本项目实际 Electron，保证自洽）
- **公共查询参数按官方字面值**，不是占位空串。取证其 axios 拦截器：
  ```js
  e.params = { uc_param_str: UC_PARAMS_STR, device_model: getDeviceNameSync(), ...e.params, ...getUcParams() }
  // UC_PARAMS_STR = "dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt"
  ```
  本项目统一为 `pr=ucpro&fr=pc&uc_param_str=<官方常量>&device_model=<本机型号>`，
  由 `http.js` 的 `COMMON_QUERY` 单点定义，三个 API 模块复用，避免各写一份而不一致。

  > 注：这里**曾误传 `uc_param_str=''`**——当时只观察到匿名请求（未登录页面顺带发起的那几次）
  > 就下了"必须传空串"的结论，并写进了注释。取证官方拦截器后已纠正，
  > 并在测试中固化「不得为空 + 必须带 device_model」。

### 关于「是不是套了网页版」

**不是。** 本项目不加载网页版页面、不自动化 DOM，而是**直接调用官方 PC 客户端使用的同一套 HTTP API**
（`drive-pc.quark.cn/1/clouddrive/*`，官方 `app.asar` 中 `cloudDriveUrl` 即为此值）。
唯一加载网页的地方是登录窗口——而这恰好与官方一致。详见 `docs/API_NOTES.md` 第 11–13 节。

**为什么没有直接复用官方代码**（详见 `docs/API_NOTES.md` 第 14 节）：
官方 JS 深度依赖只存在于其定制环境的私有 API（`quantum.*`、`chrome.quark*`、`unet`、`xdrive` 等），
实测引用共 **7,231 处**；其依赖 `@ali/xdrive`、`@ali/quark-pdfsdk` 是阿里私有包。
搬出这些 JS 在标准 Electron 里根本跑不起来。因此本项目采取**行为等价**路线：
搬运协议与算法（端点、参数、UA、OSS 签名、并行分片模型、原生 Cookie 登录），
本次文件管理和传输链路已验证，性能对比仍待实测。

### 2026-10-13 审查与真实验证

本次已修复 HTTP 中止、上传参数/顺序、下载文件冲突、任务竞态、加密与测试误判等缺陷。单元测试 216/216、集成 48/48、真实 Electron 冒烟 28/28、真实账号 E2E 29/29、官方方案稳定性 13/13 全部通过。

真实账号已完成：登录、浏览、创建目录、8400953 字节随机文件分片上传、按精确文件验证搜索、重命名、复制、下载 MD5 校验、移动、批量删除和回滚清理。测试只修改自建对象。整个便携目录约 268.3 MB，主程序约 180 MB。

### 已知限制

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


## 验证方式

项目有四层自动化验证，全部可复现：

```powershell
npm test                # 216 个单元测试
npm run verify          # 48 项模块间集成验证（含 OSS 签名字节级比对）
npm run verify:smoke    # 28 项真机冒烟（真实启动 Electron 应用）
npm run e2e             # 29 项真实账号端到端（需先登录）
npm run verify:all      # 前三层全跑
```

| 层次 | 覆盖内容 |
|---|---|
| 单元测试（216） | Cookie 合并/过期/失效、安全存储、响应归一化、请求参数与请求体、**公共查询参数**、**OSS 签名逐字节比对**、**绝对 URL 构造**、断点续传、Range 降级、并行分片、403 重取链、重试、取消清理、重名避让、并发上限 |
| 集成验证（48） | 模块导出签名、`session→http→fs→transfer` 装配、真实形状假响应下的请求正确性、登录失效冒泡、传输任务不阻塞、设置钳制 |
| 真机冒烟（28） | 真实启动应用、preload 桥契约完整性、渲染进程沙箱隔离、UI 关键元素渲染、**无外部网络请求**、**界面无 AI/播放器/推广/同步盘/会员/分享字样**、IPC 真实往返、**未登录时错误为中文且 `code === 'NEED_LOGIN'`** |
| **真实账号 E2E（29）** | 登录判活、目录分页、新建目录、真实上传、搜索、**真实下载（字节级校验）**、批量删除与回滚验证。全程只操作测试自建数据，**绝不触碰你已有的文件** |

### 实测确认的关键技术结论

| 结论 | 证据 |
|---|---|
| **下载直链必须带 Cookie** | 不带 → `412 Precondition Failed`；带 → `200` |
| **CDN 完整支持 Range** | `Range: bytes=0-1023` → `206` + `accept-ranges: bytes` |
| **CDN/OSS 必须走原生 fetch** | 同进程同一直链同样头：原生 `fetch` → 206；Electron `net.fetch` → 挂起或 403 |
| **搜索参数是 `q`** | `keyword`/`_keyword`/`key`/`file_name`/`query` 全被服务端**忽略**（返回默认列表，看似成功） |
| **容量来自 `member`** | `total_capacity`/`use_capacity`；`quota/remain` **必须带 `type=DL_FLOW`** 且那是下载流量 |
| **`32003` 是容量不足** | 真实响应 `{"code":32003,"message":"capacity limit[{0}]","metadata":{"missing_capacity":...}}`，**不是限流** |

### 开发过程中被测试/实测抓出并修复的真实缺陷

按严重程度排列：

1. **URL 构造错误导致下载必然 403（最严重）**：绝对 URL 分支误写成 `buildUrl(path, '/', query)`，
   把完整 CDN 直链当 base、`'/'` 当 path，导致**路径与查询串全部丢失**，请求打到 CDN 根路径并 403。
   由于 Cookie/Range/Referer 全对，极像"直链过期"，极具误导性。已拆出 `buildAbsoluteUrl` 并加 6 条回归断言。
2. **POST 请求丢失公共查询参数**：`api-files.js` 的 POST 调用传了 `{}` 而非 `{query: COMMON_QUERY}`，
   服务端因缺 `pr=ucpro&fr=pc` 把请求当**未登录 guest**，所有写操作（新建/重命名/移动/复制/删除）全部 401。
   错误信息却是"未登录"，会把人引向排查 Cookie。已修复并新增 9 条专项回归测试。
3. **IPC 错误字段丢失**：主进程抛 `Error` 经 `ipcRenderer.invoke` 后自定义字段全丢；
   且 preload 里 `throw new Error` 跨 `contextBridge` 时 `code` 也被剥离（实测 `Object.keys(err)` 为空）。
   → 改为「结果信封 + 抛普通对象」，否则**「Cookie 失效」提示条会静默失效**。
4. **`32003` 误判为限流**：真实含义是容量不足，原映射把用户引向"稍后再试"这个错误方向。
5. **Electron `net.fetch` 对 CDN 直链不可用**：挂起或 403，必须分流到原生 fetch。
6. **`account.status()` 是 async 却被直接送进 `webContents.send`** → `Failed to serialize arguments`，只在 stderr 出现、不中断流程，极易漏掉。
7. **`http.js` 超时设为 0 会立即中止请求**（`setTimeout(fn, 0)`），大文件下载必然失败。
8. **下载续传时未维护写入偏移**，`'r+'` 句柄会从 0 覆盖写，产生损坏文件。
9. **上传 `partSize` 非法/缺失时 `divideParts` 返回空数组** → 跳过全部分片直接 `uploadFinish`，静默产生"上传成功但文件为空"。
10. **`HttpClient` 在构造时 bind 了当时的 `globalThis.fetch`** → 测试打桩失效并静默打真实网络。
11. **UI 复选框 `preventDefault()` 导致 checked 被浏览器回滚**（由 UI 开发者实测发现）。
12. **`isDir` 宽松判定过宽**，`{dir:false, file_type:0}` 被误判为目录。

> 完整的踩坑记录（含方案 B 的刷新失效、打包失败、磁盘事故等后续发现）见
> [docs/HANDOVER.md](docs/HANDOVER.md) 第 10 节。

---

## 项目结构

```
src/
  main/
    main.js                 主进程装配 + IPC 白名单 + 窗口
    preload.js              唯一的桥（结果信封协议）
    core/
      errors.js             统一错误模型（中文文案 + 业务码映射）
      http.js               传输层（超时/重试/中止/Set-Cookie 回写）
      secure-store.js       加密本地存储（原子写入）
      session.js            Cookie jar 与会话状态
      login.js              登录（Electron 原生 Cookie 方案）
      normalize.js          响应归一化（永不抛异常）
      api-files.js          文件类接口封装
      api-transfer.js       传输类接口封装（含 OSS 签名纯函数）
      download.js           下载引擎（断点续传/Range 降级）
      upload.js             上传引擎（分片/秒传）
    modules/
      account.js            账号
      fs.js                 文件业务层
      transfer.js           传输任务队列
      settings.js           设置
  renderer/                 纯原生 HTML/CSS/JS（零框架、零 CDN、零外部请求）
docs/
  HANDOVER.md               接手文档（架构/全文件清单/踩坑记录/禁区，面向开发者）
  CLOUD_DEV.md              云端开发环境搭建指南（哪些能跑、哪些不能跑、逆向分析怎么开展）
  CODE_REVIEW_2026-10-13.md 代码审查与修复报告（P1/P2 缺陷清单、修复内容、验证边界）
  IPC_CONTRACT.md           渲染进程与主进程的唯一契约
  API_NOTES.md              接口唯一真相来源（含证据与待确认清单）
tools/
  make-portable.js          生成便携版 exe
  quark-mini-native.js      方案 B 启动器（官方原生精简版）
  stability-test.js         方案 B 稳定性专项测试
verify/
  integration.js            集成验证
  smoke-electron.js         真机冒烟
reference/                  官方客户端反编译产物与开源驱动源码（研究用）
```

---

## 接口来源与可信度

本项目**不凭猜测实现任何接口**。所有端点来自三条可追溯的证据链：

1. **本机官方客户端反编译**（`app.asar` v7.3.5.1009，提取 3019 个文件 / 188.8 MB JS，挖掘出 273 个真实端点）
2. **开源驱动源码逐行核对**（OpenList / alist 的 Quark 驱动，含已归档的 PC cookie 驱动）
3. **本机实测**（401/31001 判活、路由存在性 405 探测法等）

**路由存在性判定方法**：该 API 是 Spring Boot 应用，用**错误的方法**请求一个存在的路由会返回 `405 HttpRequestMethodNotSupportedException`，不存在的路由返回 `404 "No message available"`。借此可在无登录态下证伪网上流传的假接口（例如 `file/list`、`file/recycle/restore` 均不存在）。

每一项未确认的内容都在 `docs/API_NOTES.md` 第 9 节「待确认清单」中列明降级策略，代码中亦有对应注释。
