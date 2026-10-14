# Quark Cloud Drive (夸克网盘) PC HTTP API — Evidence-Based Reference

**Compiled:** 2026-10-11
**Method:** Source-code mining of real open-source clients + **live HTTP probing** of the production API (no proxy, direct network).

> **Citation convention.** Every claim carries a source. Sources are either:
> - **`CODE:<repo>/<path>`** — a real client source file (URL given in [§9 Sources](#9-sources)).
> - **`LIVE:<timestamp>`** — a request I actually issued against the production service on 2026-10-11 (Asia/Shanghai), with the verbatim response quoted.
>
> Anything not backed by one of those two is in [§8 UNVERIFIED / CONFLICTS](#8-unverified--conflicts).

---

## 0. TL;DR — what is actually proven

| Question | Answer | Confidence |
|---|---|---|
| Is `drive-pc.quark.cn/1/clouddrive/*` real? | **Yes.** Responds with business JSON, not an HTML 404 page. | Live-proven |
| Is there a **from-scratch QR login** with no prior session? | **Yes — two independent flows**, both exercised live end-to-end up to the human-scan step. | Live-proven |
| Can login complete **without a phone scan**? | **No.** Both flows require a real Quark app scan. The final cookie-setting response is therefore **not directly observed** — see [§8](#8-unverified--conflicts). | — |
| Are `__puus` / `__pus` real? | **Yes**, and `__puus` **rotates on every response** and must be re-saved. | Code-proven |
| Are `__kp` / `b-user-id` real? | **Not found in any source.** Treat as unverified. | Unverified |
| Confirmed endpoints | **48 total** = 35 PC `/1/clouddrive/*` ([§3.1](#31-read--list-operations)–[§3.3](#33-upload-family)) + 7 Open API ([§6](#6-official-open-api-open-api-drivequarkcn-openv1)) + 6 login ([§4](#4-login-flows)) | — |
| Proven **non-existent** routes | **58** ([§3.4](#34-routes-that-do-not-exist-negative-results)) — recorded so they are not re-invented | Live-proven |

---

## 1. Hosts, base path, and common query parameters

### 1.1 Hosts — all live-probed

`GET https://<host>/1/clouddrive/config?pr=ucpro&fr=pc` — measured 2026-10-11:

| Host | Result | Verdict |
|---|---|---|
| `drive-pc.quark.cn` | `401 {"status":401,"code":31001,...}` | **Primary PC API host** |
| `drive.quark.cn` | `401 {"status":401,"code":31001,...}` | Same API, shared backend |
| `drive-h.quark.cn` | `401 {"status":401,"code":31001,...}` | Same API (host used by `CODE:sunshineJAS09/QuarkPanDirectLink/Core/File.cs:34`) |
| `pan.quark.cn` | `401 {"status":401,"code":31001,...}` | Also serves the API, and hosts `/account/info` |
| `pc-api.uc.cn` | `401 {"status":401,"code":31001,...}` | UC Drive equivalent (`CODE:OpenListTeam/OpenList/drivers/quark_uc/meta.go:52`) |
| `drive.uc.cn` | `200` + **HTML** | Web app, **not** an API host |

`LIVE`: all five API hosts returned the identical envelope, so they are interchangeable for `/1/clouddrive/*`.

### 1.2 Base path

```
https://drive-pc.quark.cn/1/clouddrive
```

`CODE:lich0821/QuarkPan/quark_client/config.py:38` — `BASE_URL = 'https://drive-pc.quark.cn/1/clouddrive'`
`CODE:OpenListTeam/OpenList/drivers/quark_uc/meta.go:36` — `api: "https://drive.quark.cn/1/clouddrive"`

### 1.3 Common query parameters

| Param | Value | Source |
|---|---|---|
| `pr` | `ucpro` (Quark) / `UCBrowser` (UC) | `CODE:…/quark_uc/meta.go:37,53` |
| `fr` | `pc` | `CODE:…/quark_uc/util.go:36` |
| `uc_param_str` | empty string | `CODE:lich0821/QuarkPan/quark_client/config.py:46` |
| `__t` | 13-digit ms timestamp | `CODE:…/core/api_client.py:62` |
| `__dt` | `1000` (fixed) / `21192` in the task call | `CODE:…/core/api_client.py:63`; `CODE:ihmily/QuarkPanTool/quark.py:423` |
| `req_id` | per-request UUID / md5(deviceID+ts) | `CODE:…/quark_open/util.go:52` |

### 1.4 Required headers

| Header | Value | Source |
|---|---|---|
| `User-Agent` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch` | `CODE:…/quark_uc/meta.go:34` |
| `Referer` | `https://pan.quark.cn` | `CODE:…/quark_uc/util.go:33` |
| `Origin` | `https://pan.quark.cn` | `CODE:lich0821/QuarkPan/quark_client/config.py:26` |
| `Accept` | `application/json, text/plain, */*` | `CODE:…/quark_uc/util.go:32` |
| `Content-Type` | `application/json` | `CODE:…/config.py:30` |
| `Cookie` | session cookies — see [§2](#2-session-cookies) | `CODE:…/quark_uc/util.go:31` |

> **UA matters.** `CODE:ihmily/QuarkPanTool/quark.py:373-374` retries with a bumped `quark-cloud-drive/2.5.56` UA when the response `code == 23018`. A stale UA is a real failure mode.

---

## 2. Session cookies

### 2.1 Confirmed cookie names

| Cookie | Status | Semantics | Source |
|---|---|---|---|
| `__puus` | **CONFIRMED** | Rotating session token. The client **re-reads it from every response's `Set-Cookie` and persists it.** If you do not update it, the session breaks. | `CODE:OpenListTeam/OpenList/drivers/quark_uc/util.go:49-53` |
| `__pus` | **CONFIRMED** | Session token. Updated from `Set-Cookie` **only when `use_transcoding_address` is enabled** for the Quark driver. Sufficient on its own for file ops per the C# client. | `CODE:…/quark_uc/util.go:55-61`; `CODE:sunshineJAS09/QuarkPanDirectLink/Core/File.cs:47-51` |
| `__kps` | **CONFIRMED** | Listed as a required login cookie. | `CODE:lich0821/QuarkPan/quark_client/auth/login.py:249`; `…/simple_login.py:139` |
| `__uid` | **CONFIRMED** | Listed as a required login cookie. | `CODE:…/login.py:249`; `…/simple_login.py:139` |
| `_UP_*` (`_UP_A4A_11_`, `_UP_D_`, `_UP_28A_52_`, `_UP_6D1_64_`, `_UP_F7E_8D_`, `_UP_BT_`) | **CONFIRMED** | Set by `uop.quark.cn` during QR login. | `LIVE` (see [§4.1](#41-flow-a--uopquarkcn-client_id532-primary)) |
| `ctoken` | **CONFIRMED** | Set by `pan.quark.cn` on a plain GET. | `LIVE`: `Set-Cookie: ctoken=REDACTED; path=/` |
| `__kp` | **NOT FOUND** | Requested by the task brief; absent from every source I read. | → [§8](#8-unverified--conflicts) |
| `b-user-id` | **NOT FOUND** | Requested by the task brief; absent from every source I read. | → [§8](#8-unverified--conflicts) |

### 2.2 Which cookies must be sent?

**The minimal working set is `__puus` + `__pus` + `__kps` + `__uid`.**

- `__puus` and `__pus` are the ones the OpenList driver actually maintains and re-sends (`CODE:…/quark_uc/util.go:49-61`).
- `__kps` and `__uid` are enforced by the login validator: `required_cookies = ['__pus', '__kps', '__uid']` (`CODE:…/login.py:249`) and `['__kps', '__uid']` (`CODE:…/simple_login.py:139`).
- The C# client proves `__pus` alone is accepted for a subset of file operations: `_cookie = "__pus=" + __pus;` (`CODE:…/File.cs:47-51`).

### 2.3 Rotation rule (important)

```
__puus := GetCookie(response.SetCookie, "__puus")   # after EVERY response
if __puus != nil: persist(__puus)
```

`CODE:OpenListTeam/OpenList/drivers/quark_uc/util.go:49-53`:

```go
__puus := cookie.GetCookie(res.Cookies(), "__puus")
if __puus != nil {
    d.Cookie = cookie.SetStr(d.Cookie, "__puus", __puus.Value)
    op.MustSaveDriverStorage(d)
}
```

> Implement this as a **response interceptor**. A client that sends a stale `__puus` will eventually fail even though the user never logged out.

### 2.4 Detecting an expired session

| Signal | Meaning | Source |
|---|---|---|
| HTTP `401` | Authentication failure → re-login | `CODE:…/core/api_client.py:146-147` |
| HTTP `403` | "Cookie 过期" — cookie expired | `CODE:…/core/api_client.py:148-149` |
| `code == 31001` | `require login` | `LIVE` |
| Body `status == 401` | Same as the above, body-level | `CODE:sunshineJAS09/…/File.cs:264-267` |

---

## 3. Confirmed endpoint table

**How these were confirmed.** The PC API is a Spring Boot application. Probing a route with the *wrong* HTTP method returns **`405 Method Not Allowed` with a `org.springframework.web.HttpRequestMethodNotSupportedException`** — which proves the path is routed. The oracle is:

| Probe result | Meaning |
|---|---|
| `405 Method Not Allowed` | **Path EXISTS**, wrong method |
| `401 / code 31001` | **Path EXISTS**, needs auth |
| `400 / code 14001` | **Path EXISTS**, missing required param (the message *names* the param) |
| `404 "No message available"` with a `path` field | **Path does NOT exist** |

Every row below was probed this way on 2026-10-11, in addition to having a code citation.

### 3.1 Read / list operations

| Purpose | Method | URL pattern | Params | Source |
|---|---|---|---|---|
| Client config / init | `GET` | `/1/clouddrive/config` | `pr,fr` | `LIVE` 401; `CODE:…/quark_uc/driver.go:37` |
| **List folder** | `GET` | `/1/clouddrive/file/sort` | `pdir_fid,_page,_size,_fetch_total,fetch_all_file,fetch_risk_file_name,_sort` | `CODE:…/quark_uc/util.go:73-88`; `LIVE` 401 |
| **Search** | `GET` | `/1/clouddrive/file/search` | `q,_page,_size,_fetch_total,_sort,_is_hl` | `CODE:…/qp_svc_file.py:206-218`; `CODE:sunshineJAS09/…/File.cs:87-97`; `LIVE` 401 |
| File/folder info | `GET` | `/1/clouddrive/file/info` | — | `LIVE` 401 |
| Category browse | `GET` | `/1/clouddrive/file/category` | — | `LIVE` 401 |
| Category list | `GET` | `/1/clouddrive/file/category/list` | `_page` (required) … | `LIVE` 400 `Required Integer parameter '_page' is not present` |
| Folder tree list | `GET` | `/1/clouddrive/file/tree/list` | `_page` (required) | `LIVE` 400 |
| **Recycle bin list** | `GET` | `/1/clouddrive/file/recycle/list` | `_page` (required), `_size` | `LIVE` 400→401 |
| Membership / quota | `GET` | `/1/clouddrive/member` | `fetch_subscribe,_ch,fetch_identity` | `CODE:…/quark_uc/util.go:349-357`; `LIVE` 401 |
| **Task polling** | `GET` | `/1/clouddrive/task` | `task_id,retry_index,__dt,__t` | `CODE:ihmily/QuarkPanTool/quark.py:422-423`; `LIVE` 401 |
| My shares | `GET` | `/1/clouddrive/share/mypage/detail` | `_page,_size,_order_field,_order_type,_fetch_total,_fetch_notify_follow` | `CODE:…/qp_svc_share.py:185-193`; `LIVE` 401 |
| Shared-page browse | `GET` | `/1/clouddrive/share/sharepage/detail` | `pwd_id` **and** `stoken` (both required); `pdir_fid,_page,_size` | `LIVE` 400 `guest missing pwd_id or stoken`; `CODE:…/qp_svc_share.py:306` |
| Video play info | `GET` | `/1/clouddrive/file/play` | — | `LIVE` 401 |
| Document preview | `GET` | `/1/clouddrive/file/preview` | — | `LIVE` 401 |
| Thumbnail | `GET` | `/1/clouddrive/file/thumbnail` | — | `LIVE` 401 `require login [auth not found]` |

### 3.2 Mutating operations (all `POST`)

| Purpose | Method | URL pattern | Body | Source |
|---|---|---|---|---|
| **Create folder** | `POST` | `/1/clouddrive/file` | `dir_init_lock,dir_path,file_name,pdir_fid` | `CODE:…/quark_uc/driver.go:74-82`; `CODE:ihmily/QuarkPanTool/quark.py:176-186` |
| **Rename** | `POST` | `/1/clouddrive/file/rename` | `fid,file_name` | `CODE:…/quark_uc/driver.go:106-112`; `LIVE` 405-on-GET |
| **Move** | `POST` | `/1/clouddrive/file/move` | `action_type:1,exclude_fids:[],filelist:[fid],to_pdir_fid` | `CODE:…/quark_uc/driver.go:93-101`; `CODE:sunshineJAS09/…/File.cs:56-64` |
| **Copy** | `POST` | `/1/clouddrive/file/copy` | same shape as move | `LIVE` 405-on-GET, 401-on-POST |
| **Delete** | `POST` | `/1/clouddrive/file/delete` | `action_type,exclude_fids:[],filelist:[fid]` | `CODE:…/quark_uc/driver.go:121-128`; `LIVE` 405-on-GET |
| **Download URL** | `POST` | `/1/clouddrive/file/download` | `{"fids":["<fid>"]}` | `CODE:…/quark_uc/util.go:114-122`; `LIVE` 400 `fids is empty!` |
| Restore from recycle bin | `POST` | `/1/clouddrive/file/recycle/recover` | — | `LIVE` 405-on-GET, 401-on-POST |
| Purge from recycle bin | `POST` | `/1/clouddrive/file/recycle/remove` | — | `LIVE` 405-on-GET, 401-on-POST |
| File existence / check | `POST` | `/1/clouddrive/file/check` | — | `LIVE` 405-on-GET |
| Transcode / play project | `POST` | `/1/clouddrive/file/v2/play/project` | `fid,resolutions,supports` | `CODE:…/quark_uc/util.go:142-151` |
| (v2 play route) | `POST` | `/1/clouddrive/file/v2/play` | — | `LIVE` 405-on-GET |
| **Create share** | `POST` | `/1/clouddrive/share` | `fid_list,…` | `CODE:ihmily/QuarkPanTool/quark.py:533`; `LIVE` 401 |
| Share password | `POST` | `/1/clouddrive/share/password` | `share_id,passcode` | `CODE:…/qp_svc_share.py:166`; `LIVE` 405-on-GET |
| Delete/cancel share | `POST` | `/1/clouddrive/share/delete` | `share_id[]` | `CODE:…/qp_svc_share.py:619`; `LIVE` 405-on-GET |
| Share token (pwd_id→stoken) | `POST` | `/1/clouddrive/share/sharepage/token` | `pwd_id,passcode` | `CODE:…/qp_svc_share.py:268`; `LIVE` 404 `code 41006 分享不存在` |
| **Save share to own drive** | `POST` | `/1/clouddrive/share/sharepage/save` | `fid_list,to_pdir_fid,pwd_id` | `CODE:ihmily/QuarkPanTool/quark.py:303`; `LIVE` 401 |

### 3.3 Upload family

| Purpose | Method | URL pattern | Body | Source |
|---|---|---|---|---|
| Pre-upload | `POST` | `/1/clouddrive/file/upload/pre` | `ccp_hash_update,parallel_upload,pdir_fid,dir_name,size,file_name,format_type,l_created_at,l_updated_at` | `CODE:…/quark_uc/util.go:172-183`; `CODE:…/qp_svc_upload.py:184-206` |
| Instant-upload hash check | `POST` | `/1/clouddrive/file/update/hash` | `md5,sha1,task_id` | `CODE:…/quark_uc/util.go:191-198` |
| Per-part OSS auth | `POST` | `/1/clouddrive/file/upload/auth` | `auth_info,auth_meta,task_id` | `CODE:…/quark_uc/util.go:207-218` |
| Finish upload | `POST` | `/1/clouddrive/file/upload/finish` | `obj_key,task_id` | `CODE:…/quark_uc/util.go:333-337` |

**`upload/pre` response** (`CODE:…/quark_uc/types.go:216-240`):

```json
{
  "status": 200, "code": 0, "message": "ok",
  "data": { "task_id": "...", "finish": false, "upload_id": "...", "obj_key": "...",
            "upload_url": "...", "fid": "...", "bucket": "ul-zb", "auth_info": "...",
            "callback": { "callbackUrl": "...", "callbackBody": "..." } },
  "metadata": { "part_thread": 3, "part_size": 8388608 }
}
```

**`upload/auth` response** → `data.auth_key` (`CODE:…/types.go:253-261`).

**OSS upload target** — the object is PUT to Aliyun OSS, not to Quark:

```
PUT https://{bucket}.pds.quark.cn/{obj_key}?partNumber={n}&uploadId={upload_id}
Authorization: {auth_key}
x-oss-date: {http-date}
x-oss-user-agent: aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit
Referer: https://pan.quark.cn/
```

`CODE:…/qp_svc_upload.py:529-540`; `CODE:…/quark_uc/util.go:235-248`

**`auth_meta` (the string that gets signed)** — canonical form for a part PUT (`CODE:…/quark_uc/util.go:209-217`):

```
PUT

{content-type}
{http-date}
x-oss-date:{http-date}
x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit
/{bucket}/{obj_key}?partNumber={n}&uploadId={upload_id}
```

`auth_meta` for the completion POST uses `application/xml`, adds `x-oss-callback:{base64}`, and ends with `?uploadId={upload_id}` (`CODE:…/quark_uc/util.go:288-297`).

**Upload sequence** (`CODE:…/quark_uc/driver.go:160-222`):
1. `upload/pre` → `task_id`, `bucket`, `obj_key`, `upload_id`, `auth_info`, `metadata.part_size`
2. `update/hash` → if `data.finish == true`, **the file already exists server-side; done, skip all upload** (instant upload)
3. For each part: `upload/auth` → PUT to OSS → capture `ETag`
4. `POST https://{bucket}.pds.quark.cn/{obj_key}?uploadId=…` with the `CompleteMultipartUpload` XML → commit
5. `upload/finish` with `obj_key` + `task_id`

### 3.4 Routes that do NOT exist (negative results)

Probed and returned `404 "No message available"`. **Do not use these.** They appear in LLM-generated or speculative lists, so recording them is as valuable as the positives.

`/1/clouddrive/capacity` · `/1/clouddrive/file/list` · `/1/clouddrive/file/detail` · `/1/clouddrive/file/sort_by_fids` · `/1/clouddrive/file/star` · `/1/clouddrive/file/starred` · `/1/clouddrive/file/tree` · `/1/clouddrive/file/path` · `/1/clouddrive/file/breadcrumb` · `/1/clouddrive/file/recycle/restore` · `/1/clouddrive/file/recycle/delete` · `/1/clouddrive/file/recycle/clear` · `/1/clouddrive/file/recycle` (bare) · `/1/clouddrive/file/upload/part` · `/1/clouddrive/file/upload/commit` · `/1/clouddrive/file/upload/update/hash` · `/1/clouddrive/file/upload/prefetch` · `/1/clouddrive/file/save` · `/1/clouddrive/file/transcode` · `/1/clouddrive/file/media` · `/1/clouddrive/file/label` · `/1/clouddrive/file/collection` · `/1/clouddrive/file/history` · `/1/clouddrive/file/recent` · `/1/clouddrive/file/doc` · `/1/clouddrive/file/doc/preview` · `/1/clouddrive/file/thumb` · `/1/clouddrive/file/streaming` · `/1/clouddrive/file/zip` · `/1/clouddrive/file/unzip` · `/1/clouddrive/file/compress` · `/1/clouddrive/file/copy_task` · `/1/clouddrive/file/move_task` · `/1/clouddrive/file/create` · `/1/clouddrive/file/mkdir` · `/1/clouddrive/file/folder` · `/1/clouddrive/file/conflict` · `/1/clouddrive/file/exists` · `/1/clouddrive/user` · `/1/clouddrive/vip` · `/1/clouddrive/activity` · `/1/clouddrive/notice` · `/1/clouddrive/message` · `/1/clouddrive/version` · `/1/clouddrive/upgrade` · `/1/clouddrive/setting` · `/1/clouddrive/config/list` · `/1/clouddrive/offline/download` · `/1/clouddrive/share/list` · `/1/clouddrive/share/page` · `/1/clouddrive/share/save` · `/1/clouddrive/share/create` · `/1/clouddrive/share/token` · `/1/clouddrive/share/detail` · `/1/clouddrive/share/info` · `/1/clouddrive/share/report` · `/1/clouddrive/share/sharepage` · `/1/clouddrive/share/sharepage/list`

> ⚠️ **Conflict:** `CODE:lich0821/QuarkPan/quark_client/services/file_service.py:237` calls `GET file/tree` for `get_folder_tree()`. I probed it: **404**. That method is broken against the live API. Use `file/tree/list` instead.

---

## 4. Login flows

Two **independent** from-scratch QR flows exist. Neither requires a prior session.

### 4.1 Flow A — `uop.quark.cn`, `client_id=532` (primary)

Source: `CODE:lich0821/QuarkPan/quark_client/auth/api_login.py`.
**I executed steps 1–4 live on 2026-10-11 and reproduce the responses verbatim.**

#### Step 1 — Create QR token

```http
GET https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin
    ?client_id=532
    &v=1.2
    &request_id={uuid4}
Headers: Accept: application/json, text/plain, */*
         Referer: https://pan.quark.cn/
         Origin:  https://pan.quark.cn
```

**Measured response (HTTP 200):**

```json
{"status":2000000,"message":"ok","data":{"members":{"token":"REDACTED"}}}
```

`Set-Cookie` (verbatim, truncated values):

```
_UP_28A_52_=532; Max-Age=604800; Path=/; Domain=uop.quark.cn; HTTPOnly
_UP_BT_=; Max-Age=0; Path=/; Domain=.quark.cn; HTTPOnly
_UP_F7E_8D_=OU7RkS5...; Max-Age=600; Path=/; Domain=.quark.cn; HTTPOnly
_UP_6D1_64_=069; Max-Age=86400; Path=/; Domain=uop.quark.cn; HTTPOnly
_UP_A4A_11_=wba321a56e584f7b9f265c8c9c590a47; Max-Age=31536000; Path=/; Domain=.quark.cn; HTTPOnly
_UP_D_=pc; Max-Age=604800; Path=/; Domain=.quark.cn; HTTPOnly
```

> A **cookie jar is mandatory** — `uop.quark.cn` issues per-login-attempt state cookies. A stateless client will fail at step 3.

- `data.members.token` → the **QR token** (`sta…` prefix).
- Code asserts success via `status == 2000000` (`CODE:…/api_login.py:120`).

#### Step 2 — Render the QR for the user

```
https://su.quark.cn/4_eMHBJ?token={token}&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0
```

`CODE:…/api_login.py:143-171` (`_build_qr_url`). The user scans this with the Quark mobile app.
`CODE:…/utils/qr_code.py` renders it as ASCII in the terminal.

#### Step 3 — Poll for scan status

```http
GET https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken
    ?client_id=532
    &v=1.2
    &token={qr_token}
    &request_id={uuid4}
```

Poll every **~2 s** (`CODE:…/api_login.py:393`), timeout 300 s (`CODE:…/api_login.py:18`).

**Measured responses (all HTTP 200 — the status code is always 200; only the body distinguishes states):**

| Body | Meaning | Evidence |
|---|---|---|
| `{"status":50004001,"message":"Query result is empty"}` | **Waiting — not yet scanned.** Continue polling. | **LIVE-measured** |
| `{"status":50004002,"message":"Token Not Found"}` | **Invalid or expired token.** Restart at step 1. | **LIVE-measured** (also observed for a valid-but-stale token ~4 min after issue → QR lifetime is short) |
| `{"status":2000000,"message":"ok","data":{"members":{"service_ticket":"…"}}}` | **Scanned and confirmed.** Proceed to step 4. | `CODE:…/api_login.py:318-324` |

Additional failure states asserted in code but **not** live-verified: `50004003`, `50004004` (`CODE:…/api_login.py:337`).

`50004001` is explicitly treated as *"waiting"*, not an error (`CODE:…/api_login.py:335` — *"不包括50004001，那是等待状态"*).

Example poll loop:

```python
while time.time() - start < timeout:
    r = session.get(POLL_URL, params={...}, headers=H).json()
    if r["status"] == 2000000 and r.get("data", {}).get("members", {}).get("service_ticket"):
        break                      # scanned
    if r["status"] in (50004002, 50004003, 50004004):
        raise LoginFailed(r.get("message"))
    # 50004001 -> keep waiting
    time.sleep(2)
```

#### Step 4 — Exchange the service ticket (this is what sets the session cookies)

```http
GET https://pan.quark.cn/account/info?st={service_ticket}&lw=scan
```

`CODE:…/api_login.py:437-441`. **This call is what plants the login cookies** — the source comment at `:457` reads *"此时Cookie应该已经被自动设置到client中"* ("the cookie should now have been set on the client automatically").

**Measured (bogus ticket), proving the route and its error shape:**

```json
{"success":false,"data":null,"code":"AUTH_ERROR:50051","msg":"Invalid service ticket"}
```

`LIVE`. On success this returns the user profile and emits the session `Set-Cookie` set. Note this endpoint uses the `{"success","data","code","msg"}` envelope, **not** the `{"status","code","message"}` envelope used by `/1/clouddrive/*`.

#### Step 5 — Collect cookies

`CODE:…/api_login.py:490-497` harvests every cookie whose domain contains `quark.cn` and joins them into `name=value; name=value`.

### 4.2 Flow B — `open-api-drive.quark.cn` (TV/Open-API client, HMAC-signed)

Source: `CODE:OpenListTeam/OpenList/drivers/quark_uc_tv/util.go`. **Steps 1–2 executed live and confirmed.**

#### Request signing

```
x-pan-tm        = 13-digit ms timestamp
x-pan-token     = SHA256hex( "<METHOD>&<path>&<tm>&<signKey>" )
x-pan-client-id = <clientID>
req_id          = md5hex( deviceID + timestamp )
```

`CODE:…/quark_uc_tv/util.go:204-223`.

| Client | `client_id` / `x-pan-client-id` | `signKey` | `app_ver` | `channel` |
|---|---|---|---|---|
| QuarkTV | `d3194e61504e493eb6222857bccfed94` | `kw2dvtd7p4t3pjl2d9ed9yc8yej8kw2d` | `1.8.2.2` | `GENERAL` |
| UCTV | `5acf882d27b74502b7040b0c65519aa7` | `l3srvtd7p42l0d0x1u8d7yc8ye9kki4d` | `1.7.2.2` | `UCTVOFFICIALWEB` |

`CODE:…/quark_uc_tv/meta.go:42-48,60-66`. Required query params: `app_ver, device_id, device_brand, platform, device_name, device_model, build_device, build_product, device_gpu, activity_rect, channel` (`CODE:…/util.go:46-60`).

**Confirmed required-headers error (live, unsigned request):**

```json
{"status":-1,"errno":10001,"error_info":"公参缺失，x-pan-client-id, x-pan-tm, x-pan-token不能为空"}
```

#### Step 1 — Request QR

```http
GET https://open-api-drive.quark.cn/oauth/authorize
    ?auth_type=code&client_id={clientID}&scope=netdisk
    &qrcode=1&qr_width=460&qr_height=460
```

**Measured response (HTTP 200, signed request):**

```json
{"status":0,
 "req_id":"fc17cd46e3e5dac90a574194aebcb498",
 "qr_data":"iVBORw0KGgoAAAANSUhEUgAAAcwAAAHMCAIAAADXuQ/RAAAOB0lEQVR42u3bwXFcMRBDwc0/aTkEV9kSBWD6BUD9JTlNX/z5kiT9WB9bIEmQlSTISpIgK0mQlSTISpIgK0mQlSTISpIgK0mQlSTISpIgK0mQlSTISpIgK0mQlSTISpIgK0mQlSRBVpIgK0mQlSRBVpIgK0mQ/dtyN3pxMP/9DRsblfAnEjaqYgXTDVnIQhaykIUsZCELWchC1jFAFrKQNd2QhSxkIQtZyDoGyEIWspCFLGQhC1nTDVnIQhaykIWsY4AsZCELWchCFrKQNd2QhSxkIQtZyL7lqQI4uDzT58hZbNzJiumGLGQhC1nIQhaykIUsZCELWchCFrKmG7KQhSxkIQtZyEIWspCFLGQhC1nImm7IQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGRfHeTGUCVcpoq53ajiRTTdkIUsZCELWcg6BshCFrKmG7KQhSxkIQtZyEIWspCFrGOALGQha7ohC1nIQhaykIUsZCELWcg6BshCFrKmG7KQNXWQhSxkHQNkIQtZyELWr2i+8RWGelMhC1m/ArKQNReQdZkgC1lzAVk8QRaykIUsZP0KyELWXEDWZYIsZCELWTxBFrKQhSxk/QrIQtZcQBaykIUsZCHrGPwKyEIWspD1KyALWXMB2dFjqJhbChedRcJxm27IGmzIQtZ0QxaykHUWkIWsYzDYkIWs6YaswYYsZE03ZCELWWcBWcg6BoMNWciabsgabMhCFrKQdQyQdRaQhaxjMNiQhazphqzBhqyzgCxk5+yo0KfiLCp+RdMNWchCFrKQhaxjgCxkIWu6IQtZyEIWspCFLGQhC1nHAFnIQtZ0QxaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyEIWspCFLGQhC1nIQhaykIUsZCELWchCFrKQhSxkIQtZyP5/U7YFkkZ3O4AAAAAASUVORK5CYII=",
 "query_token":"REDACTED"}
```

- `qr_data` is a **base64-encoded PNG** (measured length **4844** chars) — decode and display directly. No external QR library needed.
- `query_token` (`sta…` prefix) is the polling handle.

#### Step 2 — Poll for scan

```http
GET https://open-api-drive.quark.cn/oauth/code?client_id={clientID}&scope=netdisk&query_token=REDACTED
```

**Measured responses (HTTP 400 with a JSON body):**

| Body | Meaning | Evidence |
|---|---|---|
| `{"status":-1,"errno":11003,"error_info":"用户未确认授权","req_id":"…"}` | **Waiting — user has not confirmed.** Continue polling. | **LIVE-measured** |
| `{"status":-1,"errno":11002,"error_info":"授权码Code二维码过期","req_id":"…"}` | **QR expired / unknown query_token.** Restart at step 1. | **LIVE-measured** |
| *(expected)* `{"status":0,…,"code":"…"}` | Success → `code`. Inferred from code reading `resp.Code`. | `CODE:…/util.go:128-146` — **not live-verified** |

#### Step 3 — Exchange `code` for tokens

```http
POST {codeApi}/token
Content-Type: application/json
Body: {"code":"<code>", "req_id":…, "app_ver":…, "device_id":…, …}
   or {"refresh_token":"REDACTED", …}   # when refreshing
```

Response → `data.access_token`, `data.refresh_token`; success gated on `code == 200` (`CODE:…/util.go:148-193`).

> ⚠️ **Important:** in the OpenList QuarkTV driver, `{codeApi}` is **not** a Quark host — it is the third-party relay `http://api.extscreen.com/quarkdrive` (`CODE:…/quark_uc_tv/meta.go:47`). The `/token` path on `open-api-drive.quark.cn` itself also exists (it returned `400 errno 10001 "_timestamp格式错误"` to an unsigned probe), but the QuarkTV driver does **not** use it. Treat the "official" token endpoint here as **unverified**.

### 4.3 Login sequence diagram (Flow A)

```
 client                                    uop.quark.cn                pan.quark.cn
   |                                            |                            |
   |-- 1. GET /cas/ajax/getTokenForQrcodeLogin ->|                            |
   |<-- {"status":2000000,"data":{"members":{"token":"REDACTED"}}} + _UP_* cookies |
   |                                            |                            |
   |   (render https://su.quark.cn/4_eMHBJ?token=sta…  for the user to scan)  |
   |                                            |                            |
   |-- 2. GET /cas/ajax/getServiceTicketByQrcodeToken?token=sta… ------------>|
   |<-- {"status":50004001,"message":"Query result is empty"}   [keep polling]|
   |                        … repeat every ~2s …                               |
   |<-- {"status":2000000,"data":{"members":{"service_ticket":"ST…"}}}         |
   |                                            |                            |
   |-- 3. GET https://pan.quark.cn/account/info?st=ST…&lw=scan -------------->|
   |<-- {"success":true,"data":{…user…},"code":"OK"} + Set-Cookie: session    |
   |                                            |                            |
   |   (persist __puus / __pus / __kps / __uid; re-read __puus every response) |
```

---

## 5. Error and status code semantics

### 5.1 `/1/clouddrive/*` envelope

Success: `{"status":200,"code":0,"message":"ok","data":{…},"metadata":{…}}`
Failure: `{"status":<http-like>,"code":<business>,"message":"…","req_id":"…","timestamp":…}`

Gate on **both**: `CODE:…/quark_uc/util.go:63` → `if e.Status >= 400 || e.Code != 0 { error }`.

| `code` | `status` | Meaning | Confidence / source |
|---|---|---|---|
| `0` | `200` | **Success** | `CODE:…/quark_uc/util.go:63`; `CODE:ihmily/QuarkPanTool/quark.py:188` |
| `31001` | `401` | **Requires login / session invalid.** Message variants observed: `require login [guest]`, `require login [auth not found]`, `require login [share missing]` | **LIVE-proven repeatedly** |
| `14001` | `400` | **Bad parameter.** Message names the missing param, e.g. `Bad Parameter: [Required Integer parameter '_page' is not present]`, `[fids is empty!]`, `[guest missing pwd_id or stoken]` | **LIVE-proven repeatedly** |
| `41006` | `404` | **分享不存在** — share does not exist | **LIVE-proven**: `POST share/sharepage/token` with a bogus `pwd_id` |
| `23008` | — | **Folder name conflict** (`文件夹同名冲突`) | `CODE:ihmily/QuarkPanTool/quark.py:195` |
| `23018` | — | **Client rejected — stale UA/version.** Retry with `quark-cloud-drive/2.5.56` UA. | `CODE:ihmily/QuarkPanTool/quark.py:373-374` |
| `32003` | — | **Capacity limit exceeded** (message contains `capacity limit`) | `CODE:ihmily/QuarkPanTool/quark.py:441` |
| `41013` | — | **Target folder does not exist** | `CODE:ihmily/QuarkPanTool/quark.py:443` |

### 5.2 Open-API (`open-api-drive.quark.cn`) envelope — different schema

```json
{"status": -1, "errno": 10001, "error_info": "…", "req_id": "…"}
```

Gate on `status >= 400 || errno != 0` (`CODE:…/quark_open/util.go:79`).

| `errno` | Meaning | Source |
|---|---|---|
| `10001` | Missing common params (`公参缺失，x-pan-client-id, x-pan-tm, x-pan-token不能为空`) **or** bad `_timestamp` | **LIVE-proven**; `CODE:…/quark_uc_tv/util.go:76` treats it as token-invalid |
| `11001` | `access_token` expired → refresh | `CODE:…/quark_open/util.go:68` |
| `11002` | **QR code expired** (`授权码Code二维码过期`) | **LIVE-proven** |
| `11003` | **User has not confirmed authorization** (`用户未确认授权`) | **LIVE-proven** |
| `14001` | Expired *and* `error_info` contains `access_token` → refresh | `CODE:…/quark_open/util.go:68` |

### 5.3 Login endpoint status space (`uop.quark.cn`) — yet another schema

| `status` | Meaning | Source |
|---|---|---|
| `2000000` | **OK / success** | **LIVE-proven** |
| `50004001` | Waiting for scan (not an error) | **LIVE-proven** |
| `50004002` | Token not found / expired | **LIVE-proven** |
| `50004003`, `50004004` | Failure states | `CODE:…/api_login.py:337` — **not live-verified** |

### 5.4 Task status (`GET /1/clouddrive/task`)

| `data.status` | Meaning | Source |
|---|---|---|
| `0` | Pending | `CODE:ag200/quark.py:1235` |
| `2` | **Completed** | `CODE:…/qp_svc_file.py:458`; `CODE:ihmily/QuarkPanTool/quark.py:431` |
| `3` | **Failed** | `CODE:…/qp_svc_file.py:460`; `CODE:…/qp_svc_share.py:146` |

Poll interval comes from `metadata.tq_gap` (observed `500` ms) (`CODE:…/qp_svc_file.py:424`).

---

## 6. Official Open API (`open-api-drive.quark.cn`, `/open/v1/…`)

A separate, **signature-authenticated** surface for third-party apps. All routes below returned `500` to an unsigned GET probe, and every other path on this host demanded the `x-pan-*` headers — so the prefix is real, but I could not obtain responses without valid credentials.

| Purpose | Method | Path | Source |
|---|---|---|---|
| List files | `POST` | `/open/v1/file/list` | `CODE:…/quark_open/util.go:106` |
| Pre-upload | `POST` | `/open/v1/file/upload_pre` | `CODE:…/quark_open/util.go:133,168` |
| Get upload URLs | `POST` | `/open/v1/file/get_upload_urls` | `CODE:…/quark_open/util.go:318` |
| Finish upload | `POST` | `/open/v1/file/upload_finish` | `CODE:…/quark_open/util.go:381` |
| User info | `GET` | `/user?method=user_info` | `CODE:…/quark_uc_tv/util.go:196-200` |
| Download link | `GET` | `/file?method=download&group_by=source&fid=…` | `CODE:…/quark_uc_tv/util.go:256-263` |
| Streaming link | `GET` | `/file?method=streaming&group_by=source&fid=…` | `CODE:…/quark_uc_tv/util.go:227-234` |

**Auth:** query params `access_token` + `req_id`; headers `x-pan-tm`, `x-pan-token`, `x-pan-client-id` (`CODE:…/quark_open/util.go:44-54`).
**`/open/v1/file/list` body:** `{"parent_fid":"0","size":100,"sort":"file_name:asc","query_cursor":{"version":"…","token":"REDACTED"}}` → `data.file_list[]`, `data.last_page`, `data.next_query_cursor` (`CODE:…/quark_open/util.go:91-119`, `types.go:70-77`).

---

## 7. File object shape (`file/sort` → `data.list[]`)

Confirmed fields from `CODE:OpenListTeam/OpenList/drivers/quark_uc/types.go:21-45`:

| Field | Type | Notes |
|---|---|---|
| `fid` | string | File ID — used as `pdir_fid`, `filelist[]`, `fids[]` |
| `file_name` | string | HTML-escaped; the driver runs `html.UnescapeString` on it (`…/util.go:93`) |
| `pdir_fid` | string | Parent folder ID |
| `category` | int | `1` = video (`…/quark_uc/util.go:96`) |
| `size` | int64 | Bytes |
| `file` | bool | `true` = file; **`IsDir()` is `!file`** (`types.go:74-76`) |
| `file_type` | int | In the Open API shape, `"0"` = folder (`quark_open/types.go:58`) |
| `created_at` / `updated_at` | int64 | ms epoch |
| `l_created_at` / `l_updated_at` | int64 | ms epoch (client-supplied on upload) |

`metadata` block: `_size`, `_page`, `_count`, `_total`, `way` (`types.go:95-101`).
**Pagination loop:** `while page*size < metadata._total` (`…/util.go:104-107`).

`file/download` → `data[]` with **`download_url`** and (per `…/qp_svc_download.py:90-91`) `fid`, `file_name`, `size` (`…/quark_uc/types.go:104-138`).
`file/v2/play/project` → `data.video_list[].video_info.url|size|duration|width|height|codec|fps`, plus `data.default_resolution`, `data.thumbnail` (`…/types.go:140-214`).
`member` → `data.total_capacity`, `data.use_capacity`, `data.member_type`, `data.member_status.{VIP,Z_VIP,MINI_VIP,SUPER_VIP}` (`…/types.go:263-284`).

---

## 8. UNVERIFIED / CONFLICTS

### 8.1 Not confirmed — do not rely on these

| # | Item | Status | Best guess (clearly a **GUESS**) |
|---|---|---|---|
| 1 | **Final cookie set from a successful login** | **NOT OBSERVED.** Steps 1–4 of Flow A are live-proven; step 5 depends on a real phone scan I cannot perform. | `pan.quark.cn/account/info?st=…` success emits `__puus`, `__pus`, `__kps`, `__uid` — inferred from `CODE:…/login.py:249` + `CODE:…/quark_uc/util.go:49-61`. **Not directly seen.** |
| 2 | **`__kp` cookie** | **NOT FOUND** in any of the ~20 sources read. | Possibly a typo/variant of `__kps`, or a UC-only cookie. **GUESS.** |
| 3 | **`b-user-id` cookie** | **NOT FOUND** in any source. | Possibly a UC Drive or web-app cookie, not used by the PC clouddrive API. **GUESS.** |
| 4 | Whether `__puus` is mandatory vs. optional | Not isolated by experiment. | Evidence says it rotates and is persisted; treat as required. |
| 5 | `50004003` / `50004004` login states | Asserted in code only. | Distinct terminal failures. **GUESS** as to cause. |
| 6 | Success response of `/oauth/code` (Flow B) | Not observed (needs a scan). | `{"status":0,…,"code":"…"}`. **GUESS.** |
| 7 | `/token` on `open-api-drive.quark.cn` | Route exists (400 `_timestamp格式错误`) but **no client source uses it**. | The OpenList driver posts to a **third-party** relay `api.extscreen.com/quarkdrive` instead. Official-doc path unconfirmed. |
| 8 | Exact params of `file/recycle/recover`, `file/recycle/remove`, `file/check`, `file/copy` | Route existence proven (405/401); body fields **not** observed. | Presumed `filelist[]` + `exclude_fids[]` like `file/delete`. **GUESS.** |
| 9 | `file/tree/list`, `file/category/list` full param sets | `_page` proven required; the rest unknown. | — |
| 10 | `file/info`, `file/category`, `file/play`, `file/preview`, `file/thumbnail` params | Route existence proven (401); params unknown. | — |
| 11 | Rate limits / risk control (`风控`) | No evidence found. | — |
| 12 | Whether the 512-char `__puus` is opaque or decodable | Not investigated. | Opaque. |
| 13 | Official Open API documentation page | Not located. `open-api-drive.quark.cn` served no docs at probed paths. | — |

### 8.2 Conflicts between sources

| Conflict | Detail | Resolution |
|---|---|---|
| **`file/tree`** | `CODE:lich0821/QuarkPan/…/file_service.py:237` calls `GET file/tree`. | **The code is wrong.** Live probe → `404 "No message available"`. `file/tree/list` is the real route. |
| **Base host** | `drive-pc.quark.cn` (`CODE:lich0821/…/config.py:38`) vs `drive.quark.cn` (`CODE:…/quark_uc/meta.go:36`) vs `drive-h.quark.cn` (`CODE:…/File.cs:34`) | **Not a real conflict** — I probed all three plus `pan.quark.cn`; all serve the identical API. |
| **`search` param name** | `q` (`CODE:…/file_service.py:207`, `CODE:…/File.cs:91`) — never `keyword`, `file_name`, or `query`. | `q` is consistent across both independent clients. `file/search_by_name` → 404. |
| **`file/delete` `action_type`** | `1` in `CODE:…/quark_uc/driver.go:122` vs `2` in `CODE:…/File.cs:133` | **Unresolved.** Both may be valid (delete-to-trash vs permanent). Not tested — requires auth. |
| **`uc_param_str`** | Sometimes empty (`CODE:…/config.py:46`), sometimes omitted entirely (`CODE:…/File.cs:126-128` includes it). | Optional; the API accepts both. |
| **UA string** | Many variants. | Must look like a `quark-cloud-drive/*` Electron client; `code 23018` signals rejection. |
| **OpenList `quark_open` login** | `refreshToken()` calls an online API with `driver_txt=quarkyun_oa`; local refresh is `TODO / not implemented` (`CODE:…/quark_open/util.go:438-464`). | **No self-contained login exists in that driver.** Not a source for from-scratch login. |

### 8.3 Method notes and limitations

- **No GitHub token was available**, so `api.github.com` **code search** and `github.com/search?type=code` were unavailable. Discovery relied on: `api.github.com` **repository** search (works unauthenticated), repo tree/blob endpoints, and `raw.githubusercontent.com` (frequently timed out — the contents API with base64 decode was far more reliable). `grep.app` returned **HTTP 429 / Vercel security checkpoint**. `web_search` was **unavailable** (no API key), and `sourcegraph`/`searchcode` were not reachable in the time available. This narrows the corpus; the endpoint list may be incomplete.
- Every endpoint marked `LIVE` was probed from this machine with no proxy on 2026-10-11.
- **No credential was ever used.** All probing was unauthenticated; `31001` responses are evidence of *route existence*, not of *working functionality*. Parameter names for authenticated calls come from the cited source code, not from live traffic.

---

## 9. Sources

### 9.1 Source repositories (all fetched 2026-10-11)

| Ref | Repository | Files used |
|---|---|---|
| `CODE:OpenListTeam/OpenList` | https://github.com/OpenListTeam/OpenList | `drivers/quark_uc/{driver,meta,types,util}.go`, `drivers/quark_open/{driver,meta,types,util}.go`, `drivers/quark_uc_tv/{driver,meta,types,util}.go` |
| `CODE:lich0821/QuarkPan` | https://github.com/lich0821/QuarkPan | `quark_client/auth/{api_login,login,simple_login}.py`, `quark_client/config.py`, `quark_client/core/api_client.py`, `quark_client/services/{file_service,share_service,file_upload_service,file_download_service}.py` |
| `CODE:ihmily/QuarkPanTool` | https://github.com/ihmily/QuarkPanTool | `quark.py`, `quark_login.py` |
| `CODE:alwaysgot200/QuarkPanTool` | https://github.com/alwaysgot200/QuarkPanTool | `quark.py`, `quark_login.py` |
| `CODE:sunshineJAS09/QuarkPanDirectLink` | https://github.com/sunshineJAS09/QuarkPanDirectLink | `Core/Cookie.cs`, `Core/File.cs` |

Exact blob URL form used:
`https://api.github.com/repos/<owner>/<repo>/contents/<path>` (base64 `content` field decoded to disk).

### 9.2 Local evidence copies

Downloaded upstream driver sources are kept under `reference/` with the `alist_` / `openlist_` prefixes:

```
openlist\quark_uc__{driver,meta,types,util}.go
openlist\quark_open__{driver,meta,types,util}.go
openlist\quark_uc_tv__{driver,meta,types,util}.go
qp_auth_api_login.py      qp_auth_login.py       qp_auth_simple_login.py
qp_config.py              qp_core_api_client.py
qp_svc_file.py            qp_svc_share.py        qp_svc_upload.py      qp_svc_download.py
ihmily_quark.py           ihmily_quark_login.py
ag200_quark.py            ag200_quark_login.py
sjas_file.cs              sjas_cookie.cs
```

### 9.3 Raw live evidence (verbatim)

**E1 — QR token creation (Flow A step 1)**

```
GET https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=3163df7c-0d9c-438f-a1cb-8b650a293a82
HTTP 200
{"status":2000000,"message":"ok","data":{"members":{"token":"REDACTED"}}}
Set-Cookie: _UP_28A_52_=532; Max-Age=604800; Path=/; Domain=uop.quark.cn; HTTPOnly,
            _UP_BT_=; Max-Age=0; Path=/; Domain=.quark.cn; HTTPOnly,
            _UP_F7E_8D_=OU7RkS5…; Max-Age=600; Path=/; Domain=.quark.cn; HTTPOnly,
            _UP_6D1_64_=069; Max-Age=86400; Path=/; Domain=uop.quark.cn; HTTPOnly,
            _UP_A4A_11_=wba321a56e584f7b9f265c8c9c590a47; Max-Age=31536000; Path=/; Domain=.quark.cn; HTTPOnly,
            _UP_D_=pc; Max-Age=604800; Path=/; Domain=.quark.cn; HTTPOnly
```

**E2 — QR polling, unscanned (Flow A step 3)**

```
GET https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=sta32633389dmoh14n77y1u6b74y1vag&request_id=92fcb5c5-…
HTTP 200
{"status":50004001,"message":"Query result is empty"}
```

**E3 — QR polling, invalid token (Flow A step 3)**

```
GET …/getServiceTicketByQrcodeToken?…&token=sta0000000000000000000000000000000
HTTP 200
{"status":50004002,"message":"Token Not Found"}
```
Also observed for a **previously valid** token re-polled after ~4 minutes → QR codes are short-lived.

**E4 — Service ticket exchange (Flow A step 4)**

```
GET https://pan.quark.cn/account/info?st=BOGUSTICKET&lw=scan
HTTP 200
{"success":false,"data":null,"code":"AUTH_ERROR:50051","msg":"Invalid service ticket"}
```

**E5 — `account/info` without a ticket**

```
GET https://pan.quark.cn/account/info
HTTP 200
{"success":true,"data":{},"code":"OK"}
Set-Cookie: ctoken=REDACTED; path=/
```

**E6 — Signed OAuth QR creation (Flow B step 1)**

```
GET https://open-api-drive.quark.cn/oauth/authorize?auth_type=code&client_id=d3194e61504e493eb6222857bccfed94
    &scope=netdisk&qrcode=1&qr_width=460&qr_height=460&req_id=…&app_ver=1.8.2.2&…
Headers: x-pan-tm: <13-digit ms>; x-pan-token: <sha256hex>; x-pan-client-id: d3194e…
HTTP 200
{"status":0,"req_id":"fc17cd46e3e5dac90a574194aebcb498","qr_data":"iVBORw0KGgoAAAANSUhEUgAAAcwAAAHM…(4844 chars)…","query_token":"REDACTED"}
```

**E7 — OAuth polling states (Flow B step 2)**

```
GET https://open-api-drive.quark.cn/oauth/code?client_id=d3194e…&scope=netdisk&query_token=REDACTED
HTTP 400 {"status":-1,"errno":11003,"error_info":"用户未确认授权","req_id":"738b26fac12c5f57159ffeaf302d9aeb"}

GET …/oauth/code?…&query_token=REDACTED
HTTP 400 {"status":-1,"errno":11002,"error_info":"授权码Code二维码过期","req_id":"625252252eec07fbbaeac13954ef8d5d"}
```

**E8 — Signature enforcement on the Open API host**

```
GET https://open-api-drive.quark.cn/oauth/authorize?…        (unsigned)
HTTP 400 {"status":-1,"errno":10001,"error_info":"公参缺失，x-pan-client-id, x-pan-tm, x-pan-token不能为空"}

GET https://open-api-drive.quark.cn/token                     (unsigned)
HTTP 400 {"status":-1,"errno":10001,"error_info":"_timestamp格式错误"}
```

**E9 — Representative route-existence probes**

```
GET  /1/clouddrive/file/move      → 405 HttpRequestMethodNotSupportedException   (exists, POST-only)
POST /1/clouddrive/file/download  → 400 code 14001 "fids is empty!"              (exists, param named)
POST /1/clouddrive/file/download  → 401 code 31001 "require login [share missing]"
GET  /1/clouddrive/file/recycle/list → 400 code 14001 "Required Integer parameter '_page' is not present"
POST /1/clouddrive/share/sharepage/token → 404 code 41006 "分享不存在"
GET  /1/clouddrive/file/recycle/restore  → 404 "No message available"            (does NOT exist)
GET  /1/clouddrive/file/tree             → 404 "No message available"            (does NOT exist)
```

---

## 10. Minimum viable from-scratch login (Flow A)

```python
import time, uuid, requests

S = requests.Session()
S.headers.update({
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "Referer": "https://pan.quark.cn/",
    "Origin":  "https://pan.quark.cn",
})

# 1. QR token
r = S.get("https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin",
          params={"client_id": "532", "v": "1.2", "request_id": str(uuid.uuid4())}).json()
assert r["status"] == 2000000
token = r["data"]["members"]["token"]

# 2. QR url for the user  (or render qr_data in Flow B)
qr_url = ("https://su.quark.cn/4_eMHBJ?token=%s&client_id=532&ssb=weblogin"
          "&uc_param_str=&uc_biz_str=S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0" % token)
print("Scan:", qr_url)

# 3. poll
while True:
    p = S.get("https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken",
              params={"client_id": "532", "v": "1.2", "token": token,
                      "request_id": str(uuid.uuid4())}).json()
    if p["status"] == 2000000:
        st = p["data"]["members"]["service_ticket"]; break
    if p["status"] in (50004002, 50004003, 50004004):
        raise RuntimeError(p.get("message"))      # expired / failed -> restart
    time.sleep(2)                                  # 50004001 = keep waiting

# 4. exchange -> session cookies land in S.cookies
S.get("https://pan.quark.cn/account/info", params={"st": st, "lw": "scan"})

cookies = "; ".join(f"{c.name}={c.value}" for c in S.cookies if "quark.cn" in (c.domain or ""))
print(cookies)   # send as Cookie: on every /1/clouddrive/* call
```

Then poll every response for a rotated `__puus` and persist it ([§2.3](#23-rotation-rule-important)).

---

*End of reference.*
