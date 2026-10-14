# 夸克网盘接口参考（已核实 / 待确认）

> **证据优先级**：① 本机官方客户端二进制挖掘（`reference/quark_asar/`，app.asar v7.3.5.1009 = 产品 4.1.5.397）→ ② 本机实测（`tools/probe_api.js`）→ ③ OpenList/alist 开源驱动（`reference/*.go`）。
>
> **铁律**：未在上述来源中出现过的端点/参数**一律不得写进实现代码**。新发现必须补录到本文件并标注证据来源。

---

## 1. 主机与公共参数

| 用途 | 值 | 证据 |
|---|---|---|
| PC 云盘 API 基址 | `https://drive-pc.quark.cn` | 实测 401 + 客户端代码 `cloudDriveUrl` |
| 网页版 | `https://pan.quark.cn` | 实测 200 |
| 官方 Open API | `https://open-api-drive.quark.cn` | 实测返回 `{"errno":10001,"error_info":"_timestamp格式错误"}`，**需 app_id + 签名**，本期不使用 |
| 公共查询参数 | `pr=ucpro`&`fr=pc`&`uc_param_str=<官方常量>`&`device_model=<本机型号>` | 官方 axios 拦截器取证：`UC_PARAMS_STR="dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt"`，并带 `device_model`。**曾误传空串**，已纠正 |
| 必需请求头 | `Cookie`、`Referer: https://pan.quark.cn/`、`User-Agent` | OpenList `quark_uc__util.go` L30-34 |
| 成功判定 | 响应包络 `status === 200 && code === 0` | OpenList L63 `e.Status >= 400 \|\| e.Code != 0` |

响应包络形如 `{ status, code, message, data, metadata, req_id, timestamp }`。

---

## 2. 错误码

| code | HTTP | 含义 | 是否可重试 | 证据 |
|---|---|---|---|---|
| `0` | 200 | 成功 | — | OpenList / alist 驱动 |
| `31001` | 401 | **未登录 / Cookie 失效**（`require login [guest]`） | 否 | **本机实测**：`GET /1/clouddrive/config` 无 Cookie |
| `31002` | — | 无权限（forbidden） | 否 | alist 驱动源码 |
| `14001` | 400 | 参数错误（message 会点名缺失参数） | 否 | alist 驱动源码；适合排查 |
| `21001` | 404 | 文件不存在 | 否 | alist 驱动源码 |
| `32003` | 429 / 409 | 限流 **或** 重名冲突（**靠 HTTP 状态码区分**） | 429 可重试，409 不可 | alist 驱动源码 |
| `500` | 500 | 服务端内部错误 | 是 | alist 驱动源码 |
| `14001`/`22001`/`31001` | — | 官方客户端 `retryGetFileInfo` 内列为需重试的码 | — | `renderer/index.js` |
| `41006` | — | 分享不存在（本项目不涉及分享） | — | 实测 |

> ⚠️ 仍**待确认**：验证码/风控码。未确认前一律归入 `ErrCode.UNKNOWN` 并保留 `raw`，**不得猜测**。

### 2.1 各接口族的包络差异（重要，勿混用）

| 族 | 包络 | 备注 |
|---|---|---|
| PC `/1/clouddrive/*` | `{status, code, message, data, metadata}` | 本项目主用 |
| 官方 Open API | `{status, errno, error_info}` | 需 app_id + 签名，**本期不使用** |
| 登录类 `uop.quark.cn` | `{status, message, data}`，`status=2000000` 为成功 | 本期不使用（改用 CDP 抓取） |
| `pan.quark.cn/account/info` | `{success, data, code, msg}` | 不同的包络，勿与主族混用 |

---

## 2.2 路由存在性探测法（本项目采用的验证手段）

PC API 是 Spring Boot 应用，因此：

- 用**错误的方法**请求一个**存在**的路由 → `405` + `HttpRequestMethodNotSupportedException` ⇒ **路径存在**
- 请求一个**不存在**的路由 → `404` + `"No message available"` ⇒ **路径不存在**

**本机独立复核结果**（Lead 实测）：

| 请求 | 结果 | 结论 |
|---|---|---|
| `POST /1/clouddrive/file/search` | 405 | 路径存在 ✓ |
| `POST /1/clouddrive/file/sort` | 405 | 路径存在 ✓ |
| `GET /1/clouddrive/file/list` | 404 | 不存在（常见错误写法） |
| `GET /1/clouddrive/file/recycle/restore` | 404 | 不存在（常见错误写法） |
| `GET /1/clouddrive/file/recycle/recover` | 405 | 存在（正确的回收站恢复路径） |

> 该方法可在**无登录态**下验证路由真伪，是本项目对抗"网上抄来的假接口"的核心手段。

---

## 3. 登录与鉴权

### 3.1 关键事实

- **官方 PC 客户端本身不实现登录协议**：它调用浏览器原生接口 `chrome.account.openLoginWindow({loginType, viewType, webBusiness, checkRealName})`，由 Chromium 完成登录后回调 `result === "success"`。
  证据：`reference/quark_asar/dist/renderer/common-842530.entry.js` 中 `openLoginWindow` 实现。
- 登录方式常量：`LOGIN_WAY = { QUARK_QRCODE:'quark_qrcode', PHONE_NUMBER:'phone_number', WECHAT:'wechat', QQ:'qq', PASSWORD_FREE:'password_free' }`。
- 会话 Cookie 由服务端下发，客户端代码中出现 `flushPuus` → `GET /1/clouddrive/auth/pc/flush`，说明 `__puus` 可被主动刷新。
- OpenList 确认：响应 `Set-Cookie` 中的 **`__puus`**（以及可选 `__pus`）必须回写保存。

### 3.2 本项目采用的登录方案（已实测验证）

**CDP 抓取真实 Chromium 会话**——与本机官方客户端"复用浏览器登录态"的机制一致：

1. 启动独立 `--user-data-dir` 的 Edge/Chrome，带 `--remote-debugging-port`
2. 打开 `https://pan.quark.cn/`，用户在弹出的真实窗口内扫码/登录（含滑块验证，由真实浏览器完成）
3. 通过 CDP `Network.getAllCookies` 读取该域名下**全部** Cookie（含 HttpOnly）
4. 持久化到本地加密存储

**本机实测结果**（`tools/cdp_probe.js`）：成功读取 12 条 quark 域 Cookie，含
`ctoken`、`b-user-id`、`__wpkreporterwid_`、`grey-id`、`grey-id.sig`、`isQuark`、`isQuark.sig`、`_UP_A4A_11_`、`_UP_D_`、`_UP_F7E_8D_`、`_UP_28A_52_`、`_UP_6D1_64_`。

> ⚠️ **待确认**：登录成功后 `__puus`/`__pus` 的确切下发时机与名称（匿名访问尚不可见）。实现必须写成"**保存服务端下发的全部 Cookie 并对 Set-Cookie 增量合并**"，而不是硬编码某几个名字。

### 3.3 判活接口

`GET /1/clouddrive/config?pr=ucpro&fr=pc` — 已登录返回 200/`code:0`，未登录返回 401/`31001`。**本机实测**。

无痕/未登录探测点：`tools/probe_api.js`。

---

## 4. 文件与目录

| 功能 | 方法 | 路径 | 关键参数 | 证据 |
|---|---|---|---|---|
| 列表（目录分页） | GET | `/1/clouddrive/file/sort` | `pdir_fid`、`_page`、`_size`、`_fetch_total=1`、`_sort`、`cat`、`fetch_all_file=1`、`fetch_risk_file_name=1` | 客户端 `sortableList`；OpenList L69-108 |
| 搜索结果 | GET | `/1/clouddrive/file/search` | **`q`**（关键字）、`_page`、`_size`、`_fetch_total` | **真实账号实测**（见下方 §4.2） |
| 单文件详情 | GET | `/1/clouddrive/file/info` | `fid`、`_fetch_full_path`、`need_profile_tags` | 客户端 |
| 路径链 | GET | `/1/clouddrive/file/info/path_list` | `fid` | 客户端 |
| 新建文件夹 | POST | `/1/clouddrive/file` | `pdir_fid`、`file_name`、`dir_path`、`dir_init_lock` | 客户端 `createFolder` |
| 重命名 | POST | `/1/clouddrive/file/rename` | `fid`、`file_name` | 客户端 `rename` |
| 移动 | POST | `/1/clouddrive/file/move` | `to_pdir_fid`、`filelist`、`exclude_fids`、`action_type`、`lock_concurr_op` | 客户端 `move` |
| 复制 | POST | `/1/clouddrive/file/copy` | `to_pdir_fid`、`filelist`、`action_type`、`copy_source:1` | 客户端 `copy` |
| 删除 | POST | `/1/clouddrive/file/delete` | `filelist`、`exclude_fids`、`action_type`、`lock_concurr_op` | 客户端 `del` |
| 分类统计 | GET | `/1/clouddrive/file/category` | — | 客户端 |
| 回收站 | GET | `/1/clouddrive/file/recycle/list` | — | 客户端（**本期不实现**） |

- **`action_type`**：`SYNC = 1`、`ASYNC = 2`。证据：`renderer/index.js` 中 `{e[e.SYNC=1]="SYNC",e[e.ASYNC=2]="ASYNC"}`。
  - 客户端用 **`ASYNC(2)`** 做删除/复制，用 **`SYNC(1)`** 做移动。
- **`lock_concurr_op`**：`LockConcurrentOp.Enabled`，具体数值**待实测确认**；不确定时省略该字段（服务端有默认值）。
- **`X-U-Drive-Secret-Auth`** 头：来自隐私空间（secret）模块的 token。**普通文件操作不需要**，实现中不得携带。

### 4.2 搜索参数名（真实账号实测，2026-10）

用真实账号逐个试参数名，观察**是否真的改变了结果集**：

| 参数 | 结果 | 判定 |
|---|---|---|
| **`q`** | 传 `q=完整文件名` → 命中 **1** 项；传前缀 `qk-e2e-copy-` → 命中 **5** 项；传 `a` → 命中 **14** 项 | ✅ **有效** |
| `keyword` | 命中 20 项（与不传关键词时的默认列表相同） | ❌ 被忽略 |
| `_keyword` | 命中 20 项（同上） | ❌ 被忽略 |
| `key` | 命中 20 项（同上） | ❌ 被忽略 |
| `file_name` | 命中 20 项（同上） | ❌ 被忽略 |
| `query` | 命中 20 项（同上） | ❌ 被忽略 |

**重要教训**：后面 5 个"看起来也成功"（HTTP 200、code 0、有 20 条结果），
但实际上服务端**完全忽略了这些参数**，返回的是根目录默认列表——
如果只检查"有没有报错/有没有结果"，就会误判成"参数可用"。
**必须验证结果集随关键词变化**，才能确认参数生效。

**匹配语义**：`search` 按**文件名**匹配（支持完整名、前缀、模糊子串），**不匹配目录名**。

### 4.3 容量与会员（真实账号实测）

| 端点 | 实测结果 |
|---|---|
| `GET /1/clouddrive/member` | ✅ 返回 `total_capacity`（容量上限）、`use_capacity`（已用）、`member_status`、`secret_*`（隐私空间） |
| `GET /1/clouddrive/quota/remain`（无参） | ❌ `14001 参数错误` |
| `GET /1/clouddrive/quota/remain?type=DL_FLOW` | ✅ 返回 `{DL_FLOW:{total,used,remain,cycle_flag}}`，但这是**下载流量**，不是存储容量 |
| `GET /1/clouddrive/storage/detail` | ✅ 按来源分类的占用明细（UPLOAD / AUTO / BACKUP_ALL 等） |

### 4.4 上传被拒时的真实响应（真实账号实测）

容量超限时 `POST /1/clouddrive/file/upload/pre` 返回：
```json
{"status":400,"code":32003,"message":"capacity limit[{0}]",
 "metadata":{"missing_capacity":187622974108,"suggest_member_type":"SUPER_VIP"}}
```
即 **`32003` 在此场景代表容量不足，而非限流**。
曾把它统一映射为 `RATE_LIMIT`，会把用户引向"稍后再试"这个完全错误的方向；
现已按 `message`/`metadata` 区分并给出中文文案（"网盘容量不足（还需约 175 GB）"）。

### 4.5 下载直链（真实账号实测）

- 取链：`POST /1/clouddrive/file/download` → `data[0].download_url`，主机形如 `dl-pc-zb-j.drive.quark.cn`。
- **CDN 必须带 Cookie**：不带 Cookie → `412 Precondition Failed`；带 Cookie → `200`。
- **Range 完整支持**：`Range: bytes=0-1023` → `206` 且 `accept-ranges: bytes`，`Content-Range: bytes 0-1023/1048183`。
  → 证实并行分片下载方案可行。
- **传输层必须用原生 fetch**：同一进程内对同一条直链、同样的头，
  原生 `fetch` → 206 正常；Electron `net.fetch` → 挂起或 403。
  因此 `http.js` 对 `direct: true` 的请求强制走原生 fetch（见 §4.6）。

### 4.6 一个曾导致"下载必然 403"的 URL 构造 bug（已修复并加回归测试）

`buildUrl` 的签名是 `buildUrl(base, path, query)`，但绝对 URL 分支曾误写成：

```js
buildUrl(path, '/', query)          // ❌ 把完整直链当 base、把 '/' 当 path
// new URL('/', 'https://cdn/...../file?token=...')  →  https://cdn/     ← 路径与查询串全丢
```

结果是请求打到 **CDN 根路径**并返回 `403 Forbidden`。
由于 Cookie、Range、Referer 全部正确，这个错误极像"直链过期"或"Cookie 不匹配"，
排查时容易被误导。现已拆出 `buildAbsoluteUrl(url, query)` 专用于绝对 URL，
并在 `test/build-url.test.js` 中固化了 6 条断言防止复发。

### 4.8 端口与协议（实测 + 官方取证）

| 环节 | 主机 | 端口 | 协议 | 证据 |
|---|---|---|---|---|
| 夸克 API | `drive-pc.quark.cn` | 443 | HTTPS | 实测 |
| 登录页 | `pan.quark.cn` | 443 | HTTPS | 实测 |
| 下载取链 | `POST /1/clouddrive/file/download` | 443 | HTTPS | 实测 |
| 下载 CDN | `dl-pc-zb-j.drive.quark.cn`（形如 `dl-pc-*.drive.quark.cn`） | 443 | HTTPS | 实测，返回 `206` + `accept-ranges: bytes` |
| 上传预登记 | `POST /1/clouddrive/file/upload/pre` | 443 | HTTPS | 实测 |
| 上传 OSS | 由 `upload/pre` 返回的 `upload_url` 决定 | 443 | HTTPS | 官方取证（见下） |

**结论：全部为 HTTPS 443，没有任何自定义端口**，与官方客户端一致。
（官方的 `quark_proxy.exe` 等 P2P 加速组件本项目未使用，因此也不涉及额外端口。）

**上传目标主机的官方处理逻辑**（`dist/renderer/ai-knowledge.js`）：
```js
const u = new URL(t.upload_url);
service_domain = u.hostname.replace(`${bucket}.`, '');
if (bucket.startsWith('ul-')) { /* 拼回 ul- 前缀 */ }
```
即 **OSS 主机 = `{bucket}.{upload_url 的主机名}`**，且 bucket 可能带 `ul-` 前缀。
本项目 `resolveOssUrl()` 实现为 `https://${bucket}.${rest}/${objKey}`，已覆盖本次实测形态；完整等价不能由该拼接式单独证明，
并有 5 条单元测试覆盖（含带/不带协议、尾斜杠、objKey 前导斜杠等形态）。

> 注：上传 OSS 主机**未能真实实测** —— 当前账号容量超限，`upload/pre` 返回 `32003 capacity limit`，
> 拿不到 `upload_url`，故以官方代码取证为准（属 §9 待确认清单第 6 项）。

### 4.7 并行分片下载的实测提速（真实账号，2026-10）

同一个 45.45 MB 文件（`夸克网盘能干什么.mp4`，8 MB/片 → 6 片）：

| 模式 | 并行连接数 | 耗时 | 速度 | 大小校验 |
|---|---|---|---|---|
| 串行 | 1 | 224.8 s | 0.20 MB/s | ✓ 47654277 字节完全一致 |
| **并行** | **4** | **144.9 s** | **0.31 MB/s** | ✓ 完全一致 |

**提速 1.55 倍**，证明并行分片模型有效（与官方 `partitionParallelNum` 同思路）。

**关于绝对速度偏慢**：该账号为 `member_type: NORMAL`（SVIP 已于 2026-05 终止），
且配额已超限，服务端对下载做了限速。0.2–0.3 MB/s 属于**账号等级限速**，
不是客户端实现的瓶颈——同一账号下串行也仅 0.20 MB/s（并行仍快 1.55 倍）。
若要验证满速表现，需要会员账号或先解除配额超限状态。

`fid`、`file_name`（**须做 HTML 实体反转义**，OpenList L93 `html.UnescapeString`）、`dir`（bool，`true`=文件夹）、`size`、`file_type`、`category`（`1`=视频，见 OpenList L96 `file.Category == 1`）、`updated_at`、`created_at`、`pdir_fid`、`obj_category`、`md5`、`sha1`。

> ⚠️ **待实测确认**：`dir` 为布尔还是数字；`category` 全枚举。实现须做**宽松归一化**（同时容忍 `true/1/"1"`）。

---

## 5. 异步任务

| 功能 | 方法 | 路径 | 参数 | 证据 |
|---|---|---|---|---|
| 查单任务 | GET | `/1/clouddrive/task` | `task_id` | 客户端 `queryTask` |
| 批量查状态 | POST | `/1/clouddrive/task/status` | `task_ids`、`op_type` | 客户端 `batchOperTaskStatus` |
| 任务列表 | GET | `/1/clouddrive/task/current/list` | `_size`、`task_type`、`status`、`filter_*` | 客户端 `queryTaskList` |
| 任务计数 | GET | `/1/clouddrive/task/count` | `task_type`、`status` | 客户端 |

- 客户端轮询：`queryTask(taskId)` 间隔 `interval`（默认 500ms），状态常量 `finish`。
- **`op_type`**：客户端默认取 `1`；`changeTaskStatus` 中 `op_type:1` 对应继续/开始。
  > ⚠️ **待确认**：`op_type` 全枚举、`status` 数值枚举（进行中/成功/失败）。
- **实测确认**：任务状态字段名与数值枚举**尚未在真实账号下观测**，实现须以"**未知状态 → 继续轮询并设超时**"的保守策略处理。

---

## 6. 上传（完整链路，已从官方客户端与 OpenList 双重取证）

### 2026-10-13 全量审查新增实测

- 当前账号容量为 10737418240 字节，使用量为 31526833 字节；旧账号容量超限记录不能代表当前账号。
- 实际 `upload_url` 为 `http://pds.quark.cn`，`part_size` 为 4194304。上传 65537 字节已真实完成并清理测试目录。
- 8 MB 多分片并发直传被对象存储以 HTTP 400 / `PartNotSequential` 拒绝，提示必须按连续分片编号上传。当前目标采用顺序 PUT；并发设置只用于预读分片，不能宣称已支持并行 PUT。
- `update/hash` 返回 `finish=true` 时已经完成秒传，不得再调用 `upload/finish`。证据：`reference/openlist_quark_uc_driver.go` 中 `upHash` 后的 `if finish { up(100); return nil }`。

四步式，**与官方客户端一致**：

1. **预登记** `POST /1/clouddrive/file/upload/pre`
   body：`file_name`、`size`、`pdir_fid`、`format_type`(mime)、`dir_name`、`l_created_at`、`l_updated_at`、`ccp_hash_update`、`same_path_reuse?`
   → 返回 `data.task_id`、`data.obj_key`、`data.bucket`、`data.upload_id`、`data.upload_url`、`data.auth_info`、`data.callback`、`metadata.part_size`
   - **`part_size` 必须是 65536 的整数倍**，否则客户端直接报 `PART_SIZE_WRONG`（`renderer/index.js`）
   - `metadata.part_size` 缺失 → `PART_SIZE_NULL`
   - 若返回 `data.finish === true` → **秒传**，直接结束

2. **取分片签名** `POST /1/clouddrive/file/upload/auth`
   body：`{ task_id, auth_info, auth_meta }`
   `auth_meta` 是**按 OSS 规范拼出的待签字符串**，各方法格式不同（OpenList L204-260 / L262-330 / 客户端）：
   - **PUT 分片**：
     ```
     PUT

     {mime}
     {x-oss-date}
     x-oss-date:{x-oss-date}
     x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit
     /{bucket}/{obj_key}?partNumber={n}&uploadId={upload_id}
     ```
   - **POST 完成分片**：需带 `Content-MD5`、`Content-Type: application/xml`、`x-oss-callback:{base64(callback)}`
   → 返回 `data.auth_key`，用作 OSS 请求的 `Authorization`

3. **直传 OSS**：`PUT https://{bucket}.{upload_url[7:]}/{obj_key}?partNumber={n}&uploadId={id}`
   头：`Authorization`、`Content-Type`、`Referer: https://pan.quark.cn/`、`x-oss-date`、`x-oss-user-agent`
   → 返回头 `Etag`（每片保留）

4. **完成分片**：`POST` 同一 OSS 地址（`?uploadId=`），body 为 `CompleteMultipartUpload` XML，头含 `Content-MD5` + `x-oss-callback`
   然后 **`POST /1/clouddrive/file/upload/finish`** body：`{ obj_key, task_id }`

- 小文件走 `formupload/pre`（`reference/quark_asar`）；大文件走上述 multipart。
- 客户端另提供 `POST /1/clouddrive/file/update/hash` 做 md5/sha1 预校验秒传。

> ⚠️ **待确认**：`upload_url` 是否恒为 `https://` 前缀（OpenList 用 `[7:]` 硬切）；分片大小上限；并发分片数上限。实现须对 `upload_url` 做**健壮解析**（兼容带/不带协议）。

---

## 7. 下载

| 功能 | 方法 | 路径 | 参数 | 证据 |
|---|---|---|---|---|
| 取下载链接 | POST | `/1/clouddrive/file/download` | `{ fids: [...] }` | OpenList L113-137 |
| 下载记录 | GET | `/1/clouddrive/download/list` | — | 客户端 |

- 返回 `data[i].download_url`。OpenList 随后用该 URL 直接 GET，**并携带原 Cookie + Referer + UA**。
- OpenList 声明 `Concurrency: 3`、`PartSize: 10MB`，即**支持分片并发下载**。
- 客户端对 `AccessDenied` / `403:Forbidden` 的处理是**重新取链**（`下载链接过期，请重试`）。
- **断点续传**：夸克下载链接为 CDN 直链，标准做法是 `Range: bytes=start-`。
  > ⚠️ **待实测确认**：CDN 是否稳定支持 `Range`（返回 206）。实现必须在运行时探测：若响应无 `206`/`Content-Range`，则**退化为整体重下**，不得静默产生损坏文件。

---

## 8. 其余已挖掘但不实现的端点（明确排除）

AI/问答：`chat/*`、`ai-knowledge`、`wiki-*`、`asr_*`
播放器/预览：`file/play`、`file/v2/play*`、`file/advanced_preview`、`pdf/preview`
推广/会员：`activ/*`、`products/sold/scene`、`dl_accel_coupon/*`、`distribute/*`、`member`
同步盘/备份：`backup/*`、`pc/backup/*`
分享：`share/*`
其他：`wechat/*`、`series/*`、`offline/*`、`secret/*`（隐私空间）

---

## 9. 待确认清单（实现必须保留明确降级路径）

| # | 待确认项 | 降级策略 |
|---|---|---|
| 1 | 登录后 `__puus` 实际名称/时机 | 保存全部 Set-Cookie 并合并，不硬编码（第三方源码指出 `__puus` 每次响应都可能轮换，必须逐响应回写） |
| 2 | `/file/search` 的关键字参数 | **仅使用 `q`**（源码取证与现有实现）；已证伪的 `keyword` 不回退使用 |
| 3 | 任务 `status` / `op_type` 数值枚举 | 未知值继续轮询 + 超时；界面显示原始码 |
| 4 | `lock_concurr_op` 数值 | 省略该字段 |
| 5 | CDN `Range` 支持情况 | 第三方确认返回 206 且支持分片；仍做运行时探测，不支持则整体重下 |
| 6 | `dir` 字段类型、`category` 枚举 | 宽松归一化（true/1/'1' 均视为目录） |
| 7 | 限流/验证码错误码 | 已确认 `32003`（靠 HTTP 状态码区分限流/冲突）；验证码码仍未知，归入 UNKNOWN 并展示原始 code/message |
| 8 | `mkdir`/`rename`/`move`/`delete` 是否返回 task_id | 第三方驱动一致观察为**不返回**；实现须兼容"有则轮询、无则视为已完成" |

## 11. 「本项目是套了网页版吗？」——不是。附证据

**结论**：本项目**不加载网页版页面、不自动化 DOM**，而是**直接调用官方 PC 客户端使用的同一套 HTTP API**。

| 对比项 | 网页版（pan.quark.cn） | 官方 PC 客户端 | 本项目 |
|---|---|---|---|
| 载体 | 浏览器里的 Web 应用 | Electron 桌面应用 | Electron 桌面应用 |
| 数据获取 | 页面内 JS 发请求 | 主进程直接调 `drive-pc.quark.cn` | 主进程直接调 `drive-pc.quark.cn` |
| 是否渲染官方页面 | 是 | 否 | **否**（仅登录时加载登录页） |

证据（本机官方客户端 `app.asar`，`dist/main/main.js`）：
- `cloudDriveUrl: "https://drive-pc.quark.cn"` —— 与本项目基址一致
- `getBrowserName() -> "ucpro"` —— 正是查询参数 `pr=ucpro` 的来源

**唯一加载网页的地方是登录窗口**，而这恰好与官方一致：官方客户端自己不实现登录协议，
而是调用 Chromium 原生 `chrome.account.openLoginWindow()` 打开登录窗口，登录后读原生 Cookie。
本项目的 `login.js` 用 `session.fromPartition()` + `session.cookies.get()` 达成同样效果。

## 12. 请求形态对齐（降低被风控识别的概率）

UA 严格按官方模板拼装，而非自造（证据：`dist/main/main.js`）：

```js
// 官方
generateUserAgentForFusionQuantumWindow =
  `${await quarkApp.getUserAgent()} quark-cloud-drive/${isPackaged?"2.5.40":"1.0.0"} Channel/${"pckk@other_ch".replace(/^(\w+?)@/,"$1_")}`
// 官方还用 UA 里的 QuarkPC 识别自家客户端：
//   isPcQuark = getUA().indexOf("QuarkPC") > -1
//   getPcQuarkVersion: /QuarkPC\/(\d+\.\d+\.\d+)/
```

本项目 UA（`src/main/core/http.js` 的 `DEFAULT_UA`）：
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
Chrome/130.0.6723.191 Safari/537.36 QuarkPC/4.1.5.397
quark-cloud-drive/2.5.40 Channel/pckk_other_ch
```
其中 `4.1.5.397` 取自本机已装客户端的 `build_info.json`（`product_version`），
Chromium 版本取自本项目实际使用的 Electron 内置版本，保证自洽。

其余对齐项：查询参数 `pr=ucpro&fr=pc&uc_param_str=`、头 `Referer/Origin/Cookie/Accept`。

## 13. 大文件性能对齐（并行分片下载）

官方客户端下载**不是单连接流式**，而是并行分片（证据：`dist/renderer/index.js`）：
- 导出 `multipartDownload` / `downloadAllPart` / `downloadPart` / `downloadWhole`
- `partItem` 携带 `partNo` / `start` / `end` / `netReceived` / `getSize()`
- `partitionParallelNum` 控制并行分片数，支持 `scaleTasks(n)` 动态调整
- 每片下完校验字节数，不符则抛 `INNER_RESTART`（`CONTENT_MISMATCH`）并重下该片
- `switchLinkPlugin` 在下载途中切换直链（对应本项目 403 重取链）

本项目已按同一模型实现（`src/main/core/download.js`）：
- `>8MB` 且服务端支持 Range → 并行分片（默认 4 连接，8MB/片）
- 用显式文件偏移 `pwrite` 并发写同一句柄，偏移不会错位（有逐字节测试）
- 分片级断点续传：只重下缺失分片
- 分片字节数不符 → 该片重下（对齐官方 CONTENT_MISMATCH）
- 分片中 403 → 重新取链后只补该片
- 探测不支持 Range（返回 200）或小文件 → 自动降级为单流

并发分为两类，可分别设置（对应「多文件」与「大文件」两种场景）：
- 文件级：`downloadConcurrency`（1–5）、`uploadConcurrency`（1–8）
- 分片级：`downloadParallel`（1–16）、`uploadPartConcurrency`（1–8）

## 14. 「能否直接复用官方代码」的可行性评估

**不可行**（证据来自 `reference/quark_asar/package.json`）：

```json
{
  "name": "quark-cloud-drive", "version": "2.5.40", "main": "./dist/main/main.js",
  "repository": "git@gitlab.alibaba-inc.com:quark-pc/quark-desktop-app.git"   // 内网私有仓库
}
```
依赖中 `@ali/xdrive`、`@ali/quark-pdfsdk` 为**阿里私有包**（不在 npm 公开源），
`better-sqlite3`/`ffi-napi`/`ref-napi` 均为**打过补丁的版本**。

更关键的是，官方 JS 深度依赖**只存在于他们定制环境里的私有 API**：
- `chrome.quarkBizPrivate`、`chrome.quarkRoutePrivate`、`chrome.account` —— 定制 Chromium 的 C++ 扩展 API
- `quantum.*` —— 原生桥（`quark.dll` 306MB）
- `unet` / `libcurl` / `xdrive.node` —— 自研网络栈与本地文件系统

实测统计（`tools/count_private_api.py`，扫描 75 个 JS 文件）：官方 JS 对上述私有/原生 API 的引用共

| 类别 | 引用次数 |
|---|---|
| `unet` / `netLib`（自研网络栈） | 2,333 |
| `quantum.*`（原生桥，quark.dll） | 1,936 |
| `chrome.quark*`（定制 Chromium 扩展） | 1,544 |
| `chrome.account`（登录相关私有 API） | 1,310 |
| `xdrive`（本地文件系统原生模块） | 105 |
| `process.quantum*` | 3 |
| **合计** | **7,231** |

这意味着把他们的 JS 搬出来**在标准 Electron 里根本跑不起来**——缺失这些 API 会直接抛错。
（同一份扫描也解释了为什么许多开源第三方轮子行为不一致：它们无法触达这套原生栈。）

**因此本项目采取的是「行为等价」路线**：不搬运代码，而是搬运**协议与算法**——
同样的端点、参数、UA、OSS 签名算法、并行分片下载模型、原生 Cookie 登录机制。
本次常用功能已通过真实账号验证，完整性能对比仍待实测，同时保持代码干净、可控、可维护。

## 10. 参考文件索引

| 文件 | 内容 | 来源 |
|---|---|---|
| `reference/MINED_ENDPOINTS.md` | 从官方 PC 客户端 188MB JS 中挖掘的 273 个端点及其出现次数 | 本机 `app.asar` 提取 |
| `reference/API_REFERENCE.md` | 28 个开源驱动源码的逐行取证参考（含已归档的 PC cookie 驱动） | GitHub（经 ghproxy 镜像） |
| `reference/PC_API_REFERENCE.md` | 实测型参考：二维码登录流程、路由存在性、状态码 | 子代理联网研究 |
| `reference/quark_asar/` | 官方客户端反编译产物（原始 JS） | 本机安装 |
| `tools/mine_endpoints.py` | 端点挖掘脚本 | 本 Lead |
| `tools/ctx.py` | JS 上下文抽取脚本（查证参数用） | 本 Lead |
| `tools/probe_api.js` | 带 Cookie 的实测探针 | 本 Lead |
| `tools/cdp_probe.js` | **已验证可用**的 CDP 登录态抓取原型 | 本 Lead |
| `tools/decrypt_cookies.js` + `decrypt_cookies.py` | Chromium Cookie 解密链路（DPAPI + AES-256-GCM + 域名哈希） | 本 Lead |

> **说明**：`raw.githubusercontent.com` 在本机被 TLS 重置，下载需经 `https://ghproxy.net/` 镜像转发。

## 15. 2026-10-13 验证结论更新

真实账号 E2E 为 29/29；随机文件 8400953 字节分片上传及下载 MD5 一致，所有测试对象清理完成。旧章节中“当前账号容量超限”“上传未实测”指历史账号。pds 分片顺序要求见第 6 节新增记录。

## 16. 2026-10-14 P0 本机续作

真实账号已再次完成 29 项 UI/IPC E2E；扩展验收覆盖零字节、UTF-8 名称、多文件并发、33566777 字节文件的上传/下载中断恢复及 SHA256 回读。
相同内容上传真实触发 `update/hash` 秒传，未发送分片 PUT；`pre.finish` 分支仍由离线测试覆盖，本次服务端未自然返回该路径。
多 GB 完整回读按用户选择留待后续，不把稀疏文件偏移测试记为真实大文件传输。

HTTP UA 的协议后缀、产品版本和 OSS SDK 签名标识保持已取证值。Electron 中的 Chrome 版本使用实际 `process.versions.chrome`，
纯 Node 辅助工具保留已取证的 `130.0.6723.191`；后者不能表述为 Electron 44 的内置 Chromium 版本。
