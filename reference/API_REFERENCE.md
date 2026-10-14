# Quark Cloud Drive (夸克网盘) HTTP API — Evidence-Backed Reference

**Scope:** file management, upload, download. Derived **only** from real open-source driver code
downloaded into this directory. Every claim cites `file:line`. Anything not provable from these
sources is marked **UNVERIFIED** — no parameter names have been guessed.

---

## 0. Source inventory & provenance

| Local file | Upstream (raw) | Bytes |
|---|---|---|
| `openlist_quark_open_util.go` | `OpenListTeam/OpenList@main:drivers/quark_open/util.go` | 12986 |
| `openlist_quark_open_driver.go` | `OpenListTeam/OpenList@main:drivers/quark_open/driver.go` | 5661 |
| `openlist_quark_open_types.go` | `OpenListTeam/OpenList@main:drivers/quark_open/types.go` | 3634 |
| `openlist_quark_open_meta.go` | `OpenListTeam/OpenList@main:drivers/quark_open/meta.go` | 1322 |
| `openlist_quark_uc_util.go` | `OpenListTeam/OpenList@main:drivers/quark_uc/util.go` | 9828 |
| `openlist_quark_uc_driver.go` | `OpenListTeam/OpenList@main:drivers/quark_uc/driver.go` | 5768 |
| `openlist_quark_uc_types.go` | `OpenListTeam/OpenList@main:drivers/quark_uc/types.go` | 8433 |
| `openlist_quark_uc_meta.go` | `OpenListTeam/OpenList@main:drivers/quark_uc/meta.go` | 1906 |
| `openlist_quark_uc_tv_util.go` | `OpenListTeam/OpenList@main:drivers/quark_uc_tv/util.go` | 7564 |
| `openlist_quark_uc_tv_driver.go` | `OpenListTeam/OpenList@main:drivers/quark_uc_tv/driver.go` | 4210 |
| `openlist_quark_uc_tv_types.go` | `OpenListTeam/OpenList@main:drivers/quark_uc_tv/types.go` | 3245 |
| `openlist_quark_uc_tv_meta.go` | `OpenListTeam/OpenList@main:drivers/quark_uc_tv/meta.go` | 2091 |
| `alist_quark_pc_util.go` ¹ | `AlistGo/alist@ef68f847:drivers/quark/util.go` | 7184 |
| `alist_quark_pc_driver.go` ¹ | `AlistGo/alist@ef68f847:drivers/quark/driver.go` | 6670 |
| `alist_quark_pc_types.go` ¹ | `AlistGo/alist@ef68f847:drivers/quark/types.go` | 4221 |
| `alist_quark_pc_meta.go` ¹ | `AlistGo/alist@ef68f847:drivers/quark/meta.go` | 637 |
| `alist_quark_uc_util.go` | `AlistGo/alist@main:drivers/quark_uc/util.go` | 14911 |
| `alist_quark_uc_driver.go` | `AlistGo/alist@main:drivers/quark_uc/driver.go` | 9687 |
| `alist_quark_uc_types.go` | `AlistGo/alist@main:drivers/quark_uc/types.go` | 6351 |
| `alist_quark_uc_meta.go` | `AlistGo/alist@main:drivers/quark_uc/meta.go` | 2247 |
| `alist_quark_uc_token.go` | `AlistGo/alist@main:drivers/quark_uc/uc_token.go` | 1183 |
| `alist_quark_uc_upload_reliability.go` | `AlistGo/alist@main:drivers/quark_uc/upload_reliability.go` | 10705 |
| `alist_quark_uc_delete_reliability.go` | `AlistGo/alist@main:drivers/quark_uc/delete_reliability.go` | 10698 |
| `alist_quark_uc_delete_reliability_test.go` | `.../delete_reliability_test.go` | 19995 |
| `alist_quark_uc_delete_request_test.go` | `.../delete_reliability_request_test.go` | 5795 |
| `alist_quark_uc_delete_context_test.go` | `.../delete_reliability_context_test.go` | 4352 |
| `alist_quark_uc_driver_test.go` | `.../driver_test.go` | 9524 |
| `alist_quark_uc_util_test.go` | `.../util_test.go` | 8984 |
| `MINED_ENDPOINTS.md` ² | string-mine of the **official Quark PC client** JS bundles | 49655 |

² **Not produced by this task.** `MINED_ENDPOINTS.md` was already present in this directory
(created 2026-10-11 21:42) and is a frequency-ranked extraction of URL paths, hosts, cookie names
and identifier strings from the shipped Quark PC client bundles (`main\main.js`,
`renderer\ai-knowledge.js`, `renderer\create-share-window.js`, `renderer\share-link-window.js`,
`renderer\pdf-viewer.js`, …). It is the **strongest available evidence of endpoint existence** —
it is the client's own code — but it records **paths and names only**: frequencies, no HTTP verbs,
no parameter lists, no response shapes. It is used in §4.4 strictly for existence claims, and it
supersedes several earlier UNVERIFIED entries.

¹ **Recovered from git history.** The cookie-based PC `drivers/quark` package was **deleted** in
`AlistGo/alist` commit `89f76d7899` ("feat: add `UC` driver", 2023-05-27), whose parent is
`ef68f84787621cd1909298d85c63afd59271f52e`. Upstream renamed `drivers/quark*` and the removed
files live only at that parent SHA. The commit diff for `89f76d7899` lists
`renamed drivers/quark_uc/{driver,types,util}.go` + `removed drivers/quark/meta.go`, i.e. the
current `quark_uc` package **is** the old `quark` package carried forward.
PR `AlistGo/alist#4459` states outright (author `zqxiaojin`): *"Because UC Drive and Quark Drive
have identical protocols, I copied it directly for compatibility."*

### How to read the "families"

* **PC / cookie family** — `https://drive.quark.cn/1/clouddrive` + the user's own browser cookie.
  This is the desktop-web API. Sources: `alist_quark_pc_*` (original), `alist_quark_uc_*` and
  `openlist_quark_uc_*` (current, `Quark` + `UC` multiplexed into one struct).
* **Open-platform family** — `https://open-api-drive.quark.cn` + `/open/v1/...`, authenticated by
  `access_token` + `app_id` + `sign_key` (no cookie). Source: `openlist_quark_open_*`.
* **TV family** — `https://open-api-drive.quark.cn` (Quark) / `https://open-api-drive.uc.cn` (UC),
  OAuth device flow + `x-pan-*` signature. Source: `openlist_quark_uc_tv_*`. Read-only.

---

## 1. Base URLs, prefix construction, and per-request query params

### 1.1 Host table

| Family | Base (`conf.api`) | Evidence |
|---|---|---|
| PC cookie — Quark | `https://drive.quark.cn/1/clouddrive` | `openlist_quark_uc_meta.go:36`, `alist_quark_uc_meta.go:40` |
| PC cookie — UC | `https://pc-api.uc.cn/1/clouddrive` | `openlist_quark_uc_meta.go:52`, `alist_quark_uc_meta.go:56` |
| Open platform — Quark | `https://open-api-drive.quark.cn` | `openlist_quark_open_meta.go:37` |
| TV — Quark | `https://open-api-drive.quark.cn` | `openlist_quark_uc_tv_meta.go:42` |
| TV — UC | `https://open-api-drive.uc.cn` | `openlist_quark_uc_tv_meta.go:60` |
| TV — OAuth code exchange (3rd-party) | `http://api.extscreen.com/quarkdrive` / `.../ucdrive` | `openlist_quark_uc_tv_meta.go:47,65` |

**Other Quark hosts present in the official client** (existence confirmed by `MINED_ENDPOINTS.md`;
which one serves `/1/clouddrive` is **UNVERIFIED**): `https://drive-pc.quark.cn` (`:324`),
`https://pan-api.quark.cn` (`:330`), `https://pan.quark.cn` (`:312`),
`https://open-api-drive.quark.cn` (`:334`), `https://access-open.quark.cn` (`:333`),
plus pre-release mirrors `pre-drive.quark.cn`, `pan-pre.quark.cn`,
`pre-open-api-drive.quark.cn` (`:307,306,323`). The drivers use `drive.quark.cn` and
`open-api-drive.quark.cn`; `drive-pc.quark.cn` / `pan-api.quark.cn` are plausible but unused
alternates.

**Prefix construction.** The client appends the pathname to the base verbatim:

```go
u := d.conf.api + pathname          // openlist_quark_uc_util.go:28
u := "https://drive.quark.cn/1/clouddrive" + pathname  // alist_quark_pc_util.go:26
u := d.conf.api + pathname          // openlist_quark_open_util.go:28
```

So a full URL looks like `https://drive.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&...`.
The `/1/clouddrive` segment is part of the base, **not** repeated in the method paths.

### 1.2 Mandatory per-request query params (PC/cookie family)

Every request — including `GET /config` — carries:

| Param | Quark value | UC value | Evidence |
|---|---|---|---|
| `pr` | `ucpro` | `UCBrowser` | `openlist_quark_uc_util.go:35`, `openlist_quark_uc_meta.go:37,53`; `alist_quark_pc_util.go:33` |
| `fr` | `pc` | `pc` | `openlist_quark_uc_util.go:36`, `alist_quark_pc_util.go:34` |

`pr`/`fr` are applied by the shared request helper, so they appear on **all** cookie-family calls.

### 1.3 Open-platform / TV signature params (no cookie)

`openlist_quark_open_util.go:403-417` builds the signature:

```
timestamp    = 13-digit unix-ms string
x-pan-token  = hex(sha256( method + "&" + pathname + "&" + timestamp + "&" + signKey ))
req_id       = uuid v4 (random)
```

Sent as headers `x-pan-tm` / `x-pan-token` / `x-pan-client-id` plus query `req_id` + `access_token`
(`openlist_quark_open_util.go:44-54`).

TV variant (`openlist_quark_uc_tv_util.go:204-223`) uses the **same** token formula but derives
`req_id = md5(deviceID + timestamp)` instead of a UUID, and adds a large fixed device-identity
query set (`app_ver`, `device_id`, `device_brand`, `platform`, `device_name`, `device_model`,
`build_device`, `build_product`, `device_gpu`, `activity_rect`, `channel`) at
`openlist_quark_uc_tv_util.go:46-60`, with constants at `:22-32`.

> For the **upload pre-registration only**, `openlist_quark_open_util.go:131-134` re-derives the
> signature manually so the resulting `x-pan-token` can be fed into the proof computation.

---

## 2. Required headers

### 2.1 PC/cookie family

Shared helper sets exactly three headers:

| Header | Value | Evidence |
|---|---|---|
| `Cookie` | caller's cookie string (verbatim) | `openlist_quark_uc_util.go:31`, `alist_quark_pc_util.go:29`, `alist_quark_uc_util.go:109` |
| `Accept` | `application/json, text/plain, */*` | `openlist_quark_uc_util.go:32`, `alist_quark_pc_util.go:30` |
| `Referer` | `https://pan.quark.cn` (Quark) / `https://drive.uc.cn` (UC) | `openlist_quark_uc_meta.go:35,51`; `alist_quark_pc_util.go:31` uses `https://pan.quark.cn/` |

`User-Agent` is **not** set by the helper. It is set per-call only for:
* `POST /file/download` — `req.SetHeader("User-Agent", ua)` (`openlist_quark_uc_util.go:120`)
* `POST /file/v2/play/project` — (`openlist_quark_uc_util.go:149`)

UA literals:

```
Quark: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch
       — openlist_quark_uc_meta.go:34 ; alist_quark_uc_meta.go:38 ; alist_quark_pc_driver.go:62
UC:    Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch
       — openlist_quark_uc_meta.go:50 ; alist_quark_uc_meta.go:54
```

**`Origin` is never set in any of these sources — UNVERIFIED.**
`Referer` is access-control relevant: alist commit `c413c22201` is titled
*"fix(quark): denied by Referer ACL"*, and the OSS upload leg hardcodes
`Referer: https://pan.quark.cn/` (`openlist_quark_uc_util.go:242,315`).

### 2.2 Download-response headers (must match the signing request)

The download URL's signature is bound to the cookie presented when it was minted:

> *"the download URL signature is generated based on the cookie carried when requesting
> `/file/download`; the download request headers must match, otherwise the upstream judges the
> signature invalid and returns 403."* — `alist_quark_uc_util.go:194-196`

Therefore the download GET must send the **same cookie snapshot**:

| Header | Value | Evidence |
|---|---|---|
| `Cookie` | exact snapshot taken before `/file/download` | `alist_quark_uc_util.go:197-217`, test `alist_quark_uc_util_test.go:166-203` |
| `Referer` | `conf.referer` | `alist_quark_uc_util.go:218` |
| `User-Agent` | `conf.ua` | `alist_quark_uc_util.go:219` |

### 2.3 Open-platform family headers

| Header | Value | Evidence |
|---|---|---|
| `Accept` | `application/json, text/plain, */*` | `openlist_quark_open_util.go:45` |
| `User-Agent` | `go-resty/3.0.0-beta.1 (https://resty.dev)` | `openlist_quark_open_meta.go:36` |
| `x-pan-tm` | ms timestamp | `openlist_quark_open_util.go:47` |
| `x-pan-token` | signature (see §1.3) | `openlist_quark_open_util.go:48` |
| `x-pan-client-id` | the app's `app_id` | `openlist_quark_open_util.go:49` |

For object **downloads** the open platform instead expects a cookie:
`x_pan_client_id=<appID>; x_pan_access_token=<accessToken>` (`openlist_quark_open_util.go:466-470`,
applied at `openlist_quark_open_driver.go:83-85`).

### 2.4 Cookie names

| Cookie | Meaning | Evidence |
|---|---|---|
| `__puus` | **Session cookie. Server rotates it; it expires.** Must be merged back and persisted. | `openlist_quark_uc_util.go:49-53`; `alist_quark_uc_util.go:62-66`; validity comment *"`__puus` is valid for about 3 hours"* at `alist_quark_uc_util.go:28` |
| `__pus` | Only merged when `UseTransCodingAddress` **and** driver is Quark | `openlist_quark_uc_util.go:55-61`; `alist_quark_uc_util.go:67-73` |
| `x_pan_client_id`, `x_pan_access_token` | open-platform download auth | `openlist_quark_open_util.go:468` |

> The **full set** of auth cookies a user must paste for the PC API is not enumerated anywhere in
> these sources — **UNVERIFIED**. The code only names the two it actively rotates (`__puus`,
> `__pus`).

**`__puus` refresh protocol** (important, subtle): the server only re-issues `__puus` when the
request **omits** it. `alist_quark_uc_util.go:270-297` therefore strips `__puus`, calls
`GET /config`, and adopts the new value; refresh interval is 100 min ± 5 min jitter
(`alist_quark_uc_util.go:31-34,251-260`). Test `alist_quark_uc_util_test.go:81-83` asserts the
refresh request must not carry `__puus`.

---

## 3. Response envelope and status codes

### 3.1 Envelope shape

Two distinct envelopes exist.

**(a) PC/cookie family** (`openlist_quark_uc_types.go:11-17`, `alist_quark_uc_types.go:10-16`):

```json
{ "status": 200, "code": 0, "message": "ok", "data": { ... }, "metadata": { ... } }
```

`data` is an object for most endpoints but an **array** for `/file/download`
(`openlist_quark_uc_types.go:104-133`). Paginated responses put `_total`/`_size`/`_page`/`_count`
in a sibling `metadata` object (`openlist_quark_uc_types.go:95-101`).

Success test used by the drivers: `e.Status >= 400 || e.Code != 0` ⇒ error
(`openlist_quark_uc_util.go:63`, `alist_quark_pc_util.go:52`, `alist_quark_uc_util.go:128`).

**(b) Open-platform family** (`openlist_quark_open_types.go:8-17`):

```json
{ "status": 200, "req_id": "...", "errno": 0, "error_info": "", "data": { ... } }
```

Success test: `e.Status >= 400 || e.Errno != 0` ⇒ error (`openlist_quark_open_util.go:79-81`).

**(c) TV family** (`openlist_quark_uc_tv_types.go:10-19`) — same `{status, req_id, errno, error_info}`
as (b). The OAuth token endpoint instead returns `{code, message, data:{status,errno,error_info,
access_token, refresh_token, expires_in, scope}}` and checks `code != 200`
(`openlist_quark_uc_tv_types.go:21-34`, `openlist_quark_uc_tv_util.go:182-184`).

### 3.2 Code table

Observed provider signatures, all taken from the negative-case fixtures in
`alist_quark_uc_delete_reliability_test.go:194-244` and `:214-217`, plus the
driver-level checks:

| HTTP | `status` | `code` | Meaning | Evidence |
|---|---|---|---|---|
| 200 | 200 | `0` | **Success** | `alist_quark_uc_delete_reliability_test.go:50-54` |
| 400 | 400 | `14001` | Bad parameter / invalid fid | `alist_quark_uc_delete_reliability_test.go:199-203` |
| 401 | 401 | `31001` | **Not logged in / need login** | `alist_quark_uc_delete_reliability_test.go:204-208` |
| 403 | 403 | `31002` | Permission denied | `alist_quark_uc_delete_reliability_test.go:209-213` |
| 404 | 404 | `21001` | **File not found** (only absence signature accepted) | `alist_quark_uc_delete_reliability.go:29`, test `:58-68` |
| 409 | 409 | `32003` | Conflict — mkdir same-name | `alist_quark_uc_driver_test.go:123,152` with `mkdirConflictMessage` = `file is doloading[同名冲突]` (`alist_quark_uc_driver.go:28`) |
| 429 | 429 | `32003` | **Rate limited** — `"too many requests"` | `alist_quark_uc_delete_reliability_test.go:214-217`; also `alist_quark_uc_delete_request_test.go:183` |
| 500 | 500 | `500` | Transient `"inner error, requestId …"` — retryable | `alist_quark_uc_delete_context_test.go:61`; `alist_quark_uc_delete_reliability.go:65-71` |

> `32003` is used for **both** conflict and rate-limit; the HTTP status (409 vs 429) is what
> disambiguates. The driver deliberately preserves HTTP status alongside the envelope for exactly
> this reason (`alist_quark_uc_types.go:18-31`, `providerError`).

**Token-expiry signatures by family:**

| Family | Condition | Evidence |
|---|---|---|
| Open platform (Quark) | `status == -1 && (errno == 11001 \|\| (errno == 14001 && error_info contains "access_token"))` | `openlist_quark_open_util.go:68-77` |
| TV | `status == -1 && (errno == 10001 \|\| errno == 11001)`, **or** `error_info` contains `access token` / `access_token` / `token无效` / `token 无效` | `openlist_quark_uc_tv_util.go:74-91` |
| PC/cookie | No dedicated code — auth failure surfaces as `31001` (§3.2). Session death is instead handled by the `__puus` refresh loop | `alist_quark_uc_util.go:239-297` |
| TV OAuth | `code != 200` on `/token` | `openlist_quark_uc_tv_util.go:182-184` |

**Captcha / human-verify:** there is **no captcha parameter or header anywhere**. The only
verification flow is TV QR login: `GET /oauth/authorize` returns `qr_data` (base64 JPEG) +
`query_token`, and the driver surfaces `"need verify: <img src=data:image/jpeg;base64,…>"` to the
operator (`openlist_quark_uc_tv_util.go:99-126`, `openlist_quark_uc_tv_driver.go:49-73`).
Per-request captcha / risk-verification for the PC API is **UNVERIFIED**.

---

## 4. Endpoint catalogue

### 4.1 PC / cookie family (Quark `drive.quark.cn/1/clouddrive`, UC `pc-api.uc.cn/1/clouddrive`)

All requests additionally carry `pr` + `fr=pc` (§1.2).

| # | Method | Path | Purpose | Body / query | Evidence |
|---|---|---|---|---|---|
| 1 | GET | `/config` | Session probe / `__puus` refresh | none | `alist_quark_pc_driver.go:39`; `alist_quark_uc_driver.go:69`; `alist_quark_uc_util.go:277` |
| 2 | GET | `/file/sort` | **List directory** | query `pdir_fid`, `_page`, `_size`, `_fetch_total`, `fetch_all_file`, `fetch_risk_file_name`, `_sort` | `alist_quark_pc_util.go:58-86`; `alist_quark_uc_util.go:139-178`; `openlist_quark_uc_util.go:69-111` |
| 3 | GET | `/file/info` | **Per-FID existence / metadata** | query `fid` | `alist_quark_uc_delete_reliability.go:245-282` (path `:252`, param `:255`) |
| 4 | POST | `/file` | **Create folder** | JSON `dir_init_lock`, `dir_path`, `file_name`, `pdir_fid` | `alist_quark_pc_driver.go:128-142`; `alist_quark_uc_driver.go:122-131` |
| 5 | POST | `/file/rename` | Rename | JSON `fid`, `file_name` | `alist_quark_pc_driver.go:157-166`; `alist_quark_uc_driver.go:260-269` |
| 6 | POST | `/file/move` | Move | JSON `action_type`, `exclude_fids`, `filelist`, `to_pdir_fid` | `alist_quark_pc_driver.go:144-155`; `alist_quark_uc_driver.go:247-258` |
| 7 | POST | `/file/delete` | **Delete** (single or batch) | JSON `action_type`, `exclude_fids`, `filelist` | `alist_quark_pc_driver.go:172-182`; `alist_quark_uc_delete_reliability.go:215-236` |
| 8 | POST | `/file/download` | **Mint download URL** | JSON `fids` (array) [+ query `ut` for UC] | `alist_quark_pc_driver.go:57-70`; `alist_quark_uc_util.go:180-224`; `openlist_quark_uc_util.go:113-137` |
| 9 | POST | `/file/v2/play/project` | Transcode/streaming URL | JSON `fid`, `resolutions`, `supports` | `openlist_quark_uc_util.go:139-168` |
| 10 | GET | `/member` | Quota / membership | query `fetch_subscribe`, `_ch`, `fetch_identity` | `openlist_quark_uc_util.go:347-362` |
| 11 | POST | `/file/upload/pre` | Upload pre-registration | see §5.2 | `openlist_quark_uc_util.go:170-188`; `alist_quark_uc_util.go:329-375` |
| 12 | POST | `/file/update/hash` | Hash check / instant-upload | JSON `md5`, `sha1`, `task_id` | `openlist_quark_uc_util.go:190-202` |
| 13 | POST | `/file/upload/auth` | **Sign an OSS leg** | JSON `auth_info`, `auth_meta`, `task_id` | `openlist_quark_uc_util.go:204-260,262-330` |
| 14 | POST | `/file/upload/finish` | **Commit upload** | JSON `obj_key`, `task_id` | `openlist_quark_uc_util.go:332-345` |

**Copy is not implemented** in any source — `Copy()` returns `errs.NotSupport`
(`alist_quark_uc_driver.go:271-273`, `openlist_quark_uc_driver.go:116-118`). The path
`/1/clouddrive/file/copy` **does** exist in the official client (`MINED_ENDPOINTS.md:124`, §4.4),
but its method, parameters and response are **UNVERIFIED**.

**Search is not implemented in any driver**, but the endpoint **does exist** — see §4.4.

#### 4.1.1 File listing — exact contract

Query parameters (values verbatim from `alist_quark_uc_util.go:143-154`):

| Param | Value | Note |
|---|---|---|
| `pdir_fid` | parent folder fid (`"0"` = root) | `DefaultRoot: "0"` (`alist_quark_uc_meta.go:36`) |
| `_page` | `1`-based page number | reassigned per loop iteration |
| `_size` | `100` | |
| `_fetch_total` | `1` | required for `metadata._total` |
| `fetch_all_file` | `1` | added by current code |
| `fetch_risk_file_name` | `1` | added by current code |
| `_sort` | `file_type:asc,<orderBy>:<direction>` | only when `OrderBy != "none"` |

`_sort` build, verbatim:

```go
query["_sort"] = "file_type:asc," + d.OrderBy + ":" + d.OrderDirection   // alist_quark_uc_util.go:151
```

Allowed `order_by` options (`alist_quark_uc_meta.go:11`): `none, file_type, file_name, updated_at`;
`order_direction`: `asc, desc`.

Pagination termination (`alist_quark_uc_util.go:172-175`): `if page*size >= resp.Metadata.Total { break }`.
Current alist also handles a `_total` of `0` by falling back to "short page means last page"
(`alist_quark_uc_driver.go:237-243`, `alist_quark_uc_upload_reliability.go:330-336`).

Response (test fixture `alist_quark_uc_driver_test.go:213-222`):

```json
{
  "status": 200, "code": 0,
  "data": { "list": [ { "fid": "file-1", "file_name": "Pool", "file": true } ] },
  "metadata": { "_size": 100, "_page": 1, "_count": 1, "_total": 1, "way": "..." }
}
```

#### 4.1.2 File record shape

Fields actually mapped (`alist_quark_uc_types.go:33-57`):

| Field | JSON | Type |
|---|---|---|
| Fid | `fid` | string |
| FileName | `file_name` | string |
| Category | `category` | int — `1` = video (`openlist_quark_uc_util.go:96`) |
| Size | `size` | int64 |
| LCreatedAt | `l_created_at` | int64 |
| LUpdatedAt | `l_updated_at` | int64 |
| **IsFile** | `file` | **bool** |
| CreatedAt | `created_at` | int64 (unix ms) |
| UpdatedAt | `updated_at` | int64 (unix ms) |

Additional fields **present in the real payload but commented out** of the struct
(`alist_quark_uc_types.go:36-56`) — the JSON tags are authoritative even though the Go fields are
disabled: `pdir_fid`, `file_type` (int), `format_type`, `status`, `tags`, `name_space`,
`include_items`, `risk_type`, `backup_sign`, `duration`, `file_source`, `_private_extra`,
`obj_category`, `thumbnail`.

**How "is folder" is encoded — three different ways depending on family:**

| Family | Encoding | Evidence |
|---|---|---|
| PC/cookie | `"file": false` ⇒ **folder** | `IsDir() { return !f.File }` — `alist_quark_uc_types.go:85-87`, `openlist_quark_uc_types.go:74-76`; used as `!file.File` in `alist_quark_uc_driver.go:232` |
| Open platform | `"file_type": "0"` (string) ⇒ folder | `IsFolder: f.FileType == "0"` — `openlist_quark_open_types.go:44,58` |
| TV | `"isdir": 1` ⇒ folder | `IsDir() { return f.Isdir == 1 }` — `openlist_quark_uc_tv_types.go:43,69-71` |

Timestamps are unix **milliseconds**: `time.UnixMilli(f.UpdatedAt)`
(`alist_quark_uc_types.go:64`, `openlist_quark_open_types.go:57`).

`file_name` is **HTML-escaped** by the provider and must be unescaped:
`file.FileName = html.UnescapeString(file.FileName)` (`alist_quark_uc_util.go:163`), proven by the
`"A&amp;B"` → `"A&B"` fixture (`alist_quark_uc_driver_test.go:265,278-284`).

#### 4.1.3 Mutations are **synchronous** — no task id, no polling

`/file` (mkdir), `/file/rename`, `/file/move`, `/file/delete` all return the plain envelope with no
task identifier. The drivers treat the response as final and **no driver ever polls a task
endpoint**. This is a statement about the drivers, not the API: the official client does expose a
task system (`/1/clouddrive/task`, `/task/status`, … — see §4.4), so an async operation *may* return
an id in some flows. Whether any of the four mutations above is in fact asynchronous is
**UNVERIFIED**; on the evidence of four independent drivers, they are treated as synchronous.

Two documented async-lag caveats are handled by client-side retry, not by polling:

* **mkdir eventual consistency.** `alist_quark_uc_driver.go:136-160` re-lists the parent
  (up to 6 attempts, 200 ms→800 ms backoff, `:28-33`) to confirm the new directory is visible and
  to obtain its fid, because *"Quark may acknowledge a mkdir before /file/sort reflects the new
  directory."* A same-name **file** is explicitly rejected as a directory match
  (`alist_quark_uc_driver.go:232`, test `alist_quark_uc_driver_test.go:207-234`).
* **upload-finish visibility.** `alist_quark_uc_upload_reliability.go:205-288` verifies the
  uploaded fid by re-listing before declaring success.

Also note `/file` carries a 1-second post-write sleep in the older code
(`alist_quark_pc_driver.go:138-140`, `openlist_quark_uc_driver.go:83-85`).

#### 4.1.4 Delete — batch semantics and reliability

Request body (`alist_quark_uc_delete_reliability.go:286-290`):

```json
{ "action_type": 1, "exclude_fids": [], "filelist": ["<fid>"] }
```

* **Batch** = put more than one fid in `filelist`; every source only ever sends one, so the
  multi-element form is **UNVERIFIED as exercised**, though it is plainly an array.
* Destructive calls run with **Resty retries disabled** and redirects off
  (`alist_quark_uc_delete_reliability.go:113-122`).
* Ambiguous outcome handling: on a retryable error the driver verifies via
  `GET /file/info?fid=…` before replaying, because *"Quark may have accepted the delete before
  returning the error"* (`:314-334`). Retry budget is 3 attempts, 250 ms→500 ms (`:20-23`).
* Absence is proven **only** by the exact triple `HTTP 404` + `status 404` + `code 21001`
  (`:96-104`). Everything else — including 401/403/429/5xx, malformed JSON, HTML gateway pages,
  a missing `data` object, or a mismatched fid — fails closed (`:238-282`, tests `:194-244`).

#### 4.1.5 `GET /file/info`

* Query: `fid=<single fid>` (`alist_quark_uc_delete_reliability.go:255`).
* Present ⇒ HTTP 200, `status 200`, `code 0`, `data.fid` equal to the requested fid
  (`alist_quark_uc_delete_reliability_test.go:46-56`).
* A `GET /file?fids=…` list-based form is explicitly described as the **disproven oracle** and must
  not be used (`alist_quark_uc_delete_reliability_test.go:19,127-135`).

### 4.2 Open-platform family (Quark, `open-api-drive.quark.cn/open/v1/...`)

| # | Method | Path | Body / query | Evidence |
|---|---|---|---|---|
| 1 | GET | `/open/v1/user/info` | — → `data.{user_id,nickname,avatar_url}` | `openlist_quark_open_driver.go:41`; types `openlist_quark_open_types.go:19-28` |
| 2 | POST | `/open/v1/file/list` | `parent_fid`, `size`, `sort`, `query_cursor` | `openlist_quark_open_util.go:86-123` |
| 3 | POST | `/open/v1/dir` | `dir_path`, `pdir_fid` | `openlist_quark_open_driver.go:91-101` |
| 4 | POST | `/open/v1/file/rename` | `fid`, `file_name`, `conflict_mode` | `openlist_quark_open_driver.go:116-127` |
| 5 | POST | `/open/v1/file/move` | `action_type`, `fid_list`, `to_pdir_fid` | `openlist_quark_open_driver.go:103-114` |
| 6 | POST | `/open/v1/file/delete` | `action_type`, `fid_list` | `openlist_quark_open_driver.go:133-143` |
| 7 | POST | `/open/v1/file/get_download_url` | `fid` | `openlist_quark_open_driver.go:69-89` |
| 8 | POST | `/open/v1/file/upload_pre` | see §5.3 | `openlist_quark_open_util.go:125-173` |
| 9 | POST | `/open/v1/file/get_upload_urls` | `task_id`, `part_info_list` | `openlist_quark_open_util.go:310-328` |
| 10 | POST | `/open/v1/file/upload_finish` | `task_id`, `part_info_list` | `openlist_quark_open_util.go:358-394` |

Notes:
* **Batch mutations use `fid_list`** (plural key — this differs from the cookie family's
  `filelist`). Cursor pagination uses `last_page` + `next_query_cursor {version, token}`
  (`openlist_quark_open_types.go:65-77`).
* `sort` here is `<field>:<direction>` with no `file_type:asc,` prefix; options
  `none,file_type,file_name,updated_at,created_at`, default `"file_name:asc"`
  (`openlist_quark_open_meta.go:10-11`, `openlist_quark_open_util.go:94`).
* `rename` sends `conflict_mode: "REUSE"` (`openlist_quark_open_driver.go:120`).
* **Copy is not supported** (`openlist_quark_open_driver.go:129-131`).

### 4.3 TV family (read-only)

| # | Method | Path | Params | Evidence |
|---|---|---|---|---|
| 1 | GET | `/file` | `method=list`, `parent_fid`, `order_by`, `desc`, `category`, `source`, `ex_source`, `list_all`, `page_size`, `page_index` | `openlist_quark_uc_tv_driver.go:108-121` |
| 2 | GET | `/file` | `method=download`, `group_by`, `fid`, `resolution`, `support` | `openlist_quark_uc_tv_util.go:254-274` |
| 3 | GET | `/file` | `method=streaming`, `group_by`, `fid`, `resolution`, `support` | `openlist_quark_uc_tv_util.go:225-252` |
| 4 | GET | `/user` | `method=user_info` | `openlist_quark_uc_tv_util.go:195-202` |
| 5 | GET | `/oauth/authorize` | `auth_type=code`, `client_id`, `scope=netdisk`, `qrcode=1`, `qr_width`, `qr_height` | `openlist_quark_uc_tv_util.go:99-126` |
| 6 | GET | `/oauth/code` | `client_id`, `scope`, `query_token` | `openlist_quark_uc_tv_util.go:128-146` |
| 7 | POST | `/token` (on `codeApi`) | `req_id`, device params, + `refresh_token` or `code` | `openlist_quark_uc_tv_util.go:148-193` |

TV `order_by` is a numeric enum: `"3"` = default (updated_at), `"1"` = file_name; `desc` is `"1"`/`"0"`
(`openlist_quark_uc_tv_driver.go:98-105`). Mutations and upload are `errs.NotImplement`
(`openlist_quark_uc_tv_driver.go:147-169`).

---

### 4.4 Endpoints proven to exist by the official client bundle (`MINED_ENDPOINTS.md`)

These paths appear verbatim in the shipped Quark PC client. **Existence is proven; HTTP method,
parameters and response shape are NOT** — the mine records paths only. Treat every row here as
"confirmed path, otherwise UNVERIFIED".

**File management (the gaps in §4.1/§4.3):**

| Path | Line |
|---|---|
| `/1/clouddrive/file/search` | `MINED_ENDPOINTS.md:43,94` |
| `/1/clouddrive/file/content_search` | `:95` |
| `/1/clouddrive/file/general_search` | `:100` |
| `/1/clouddrive/file/search/source/list` | `:226` |
| `/1/clouddrive/file/copy` | `:124` |
| `/1/clouddrive/file/advanced_sort` | `:5` |
| `/1/clouddrive/file/category` | `:14` |
| `/1/clouddrive/file/mix_list` | `:16` |
| `/1/clouddrive/file/info/list` | `:66` |
| `/1/clouddrive/file/info/path_list` | `:48` |
| `/1/clouddrive/file/v2/info/list` | `:57` |
| `/1/clouddrive/file/current/list` | `:42` |
| `/1/clouddrive/file/cursor/list` | `:81` |
| `/1/clouddrive/file/sort/dir_tree` | `:78` |
| `/1/clouddrive/file/sort/extension` | `:92` |
| `/1/clouddrive/file/list_by_save_at` | `:91` |
| `/1/clouddrive/file/count` | `:214` |
| `/1/clouddrive/file/system_path` | `:33` |
| `/1/clouddrive/folder/list` | `:26` |
| `/1/clouddrive/folder/update`, `/1/clouddrive/folder/delete` | `:170,219` |
| `/1/clouddrive/dir/detail`, `/1/clouddrive/dir/detail/list` | `:144,213` |

**Upload (extends §5.1):**

`/1/clouddrive/file/upload/pre` (`:7`), `/file/upload/auth` (`:20`), `/file/upload/finish` (`:12`),
`/file/update/hash` (`:18`), `/file/upload/getUploadUrls` (`:38`), `/file/upload/listPart` (`:154`),
`/file/formupload/pre` (`:17`), `/file/upload` (`:275`).

> **OSS hosts** used for the part PUTs appear as `https://dl-c-sz-u.drive.quark.cn` and
> `https://dl-c-zb-u.drive.quark.cn` (`MINED_ENDPOINTS.md:347-348`). This matches the
> `https://{bucket}.{upload_url[7:]}/{obj_key}` construction in §5.1 (`upload_url[7:]` is a
> `*.drive.quark.cn` host) and corroborates the bucket-prefixed OSS host.

**Download / media:**

`/1/clouddrive/file/download` (`:10`), `/1/clouddrive/file/play`, `/file/play/project`,
`/file/v2/play/project` (`:83-85`), `/file/v2/current/list` (`:86`),
`/1/clouddrive/download/list` (`:8`), `/download/list/export` (`:35`).

**Task / async status — this resolves the open question in §4.1.3:**

| Path | Line |
|---|---|
| `/1/clouddrive/task` | `:4` |
| `/1/clouddrive/task/status` | `:24` |
| `/1/clouddrive/task/list` | `:140` |
| `/1/clouddrive/task/current/list` | `:64` |
| `/1/clouddrive/task/count` | `:230` |
| `/1/clouddrive/task/delete/all` | `:231` |

> The client maintains a genuine task system (`taskSync`, `running_tasks`, `taskPool`,
> `finish_task`, `taskState`, `cancel_task` — `MINED_ENDPOINTS.md:484-596`). The drivers do not use
> it because they issue no async operations, but **`/1/clouddrive/task` + `/task/status` are the
> polling endpoints** an async client would use. Their request/response schemas remain UNVERIFIED.

**Auth / session (extends §2.4):**

`/1/clouddrive/config` (`:132`), `/1/clouddrive/auth/pc/flush` (`:40`),
`/1/clouddrive/member` (`:152`), `/1/clouddrive/storage/detail` (`:206`),
`/quota/use` + `/quota/remain` (`:232-233`), `/1/clouddrive/devices/check` (`:50`),
`/device/list` (`:34`), `/1/clouddrive/secret/v2/login` (`:151`).

**Account paths** (`MINED_ENDPOINTS.md:278-289`): `/account/userinfo`, `/account/get_user_profile`,
`/account/logout`, `/account/send_auth_verification_code`, `/account/send_auth_verification_info`,
`/account/swap_uid`, `/account/web_login_token`, `/account/get_st`.

> `send_auth_verification_code` / `send_auth_verification_info` are the **closest thing to a
> verification/captcha flow** found anywhere. They are account-security endpoints, not a per-request
> captcha. There is still **no evidence of a per-request captcha parameter**.

**Cookie names** (`MINED_ENDPOINTS.md:463-473`) — the full observed set:

`__itrace_wid`, `b-user-id`, `__wpkreporterwid_`, `__uus`, `__pc`, `__kuus`, `__uid`, `__pu`,
`__pus`.

> Note: **`__puus` does not appear in this list**, nor does `__pus` appear beyond a single hit in
> `pdf-viewer.js`. Most of these names (`__itrace_wid`, `__wpkreporterwid_`) are Alibaba
> telemetry/reporting identifiers, not auth. What the drivers actually authenticate with —
> `__puus` (§2.4) — is set by the server and merged from `Set-Cookie`, so it need not appear as a
> literal in the bundle. **The authoritative auth-cookie set for the PC API remains UNVERIFIED**;
> `b-user-id`, `__uid`, `__pu`, `__kuus`, `__uus`, `__pc` are plausible session candidates but
> **unproven**.

## 5. Upload flow, end to end

**There is no `multipart/form-data` anywhere.** No `FormData`, no multipart field names exist in
any source. Uploads are **Aliyun OSS multipart PUT with a server-side callback**, which is why the
client asks the control plane to sign each leg.

### 5.1 Cookie-family sequence (`alist_quark_uc_driver.go:279-361`)

```
1. compute md5 + sha1 of the whole file
2. POST /file/upload/pre                     -> task_id, upload_id, obj_key, upload_url,
                                                bucket, auth_info, metadata.part_size
3. POST /file/update/hash {md5, sha1, task_id}  -> data.finish == true  ==> INSTANT UPLOAD, done
4. for each part N (part_size from metadata):
     POST /file/upload/auth  {auth_info, auth_meta(PUT...), task_id} -> data.auth_key
     PUT  https://{bucket}.{upload_url[7:]}/{obj_key}?partNumber=N&uploadId={upload_id}
          Authorization: <auth_key>, Content-Type: <mime>, Referer, x-oss-date, x-oss-user-agent
       -> capture ETag
5. POST /file/upload/auth {auth_info, auth_meta(POST...x-oss-callback...), task_id} -> auth_key
   POST https://{bucket}.{upload_url[7:]}/{obj_key}?uploadId={upload_id}
        body = CompleteMultipartUpload XML, x-oss-callback: <base64 callback>
6. POST /file/upload/finish {obj_key, task_id}
```

**Step 2 — `/file/upload/pre`** body (`openlist_quark_uc_util.go:172-182`,
`alist_quark_uc_util.go:331-341`):

```json
{ "ccp_hash_update": true, "dir_name": "", "file_name": "<name>",
  "format_type": "<mime>", "l_created_at": <unix-ms>, "l_updated_at": <unix-ms>,
  "pdir_fid": "<parent fid>", "size": <bytes> }
```
`same_path_reuse` is present but **commented out** in both
(`openlist_quark_uc_util.go:181`, `alist_quark_uc_util.go:340`). This call is deliberately
**single-attempt, redirect-disabled**, because *"a lost response may still have allocated a
task/FID"* (`alist_quark_uc_util.go:80-102,162-164`).

Response (`alist_quark_uc_types.go:184-208`): `data.{task_id, finish, upload_id, obj_key,
upload_url, fid, bucket, callback{callbackUrl, callbackBody}, format_type, size, auth_info}` and
`metadata.{part_thread, acc1, acc2, part_size}`.

**Step 3 — `/file/update/hash`** (`openlist_quark_uc_util.go:190-202`): `{md5, sha1, task_id}` →
`data.finish`. When `true`, the file already existed server-side and no bytes are transferred.

**Step 4 — `auth_meta` string format.** Exact layout (`alist_quark_uc_util.go:396-403`):

```
PUT

<mime>
<http-date>
x-oss-date:<http-date>
x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit
/<bucket>/<obj_key>?partNumber=<N>&uploadId=<upload_id>
```

Date format is `time.Now().UTC().Format(http.TimeFormat)` (`:393`). The OSS target host is built as
`https://{bucket}.{upload_url[7:]}/{obj_key}` (`:422`) — i.e. **strip the scheme prefix from
`upload_url` and use it as the endpoint suffix**. Current alist validates this shape before use
(`alist_quark_uc_upload_reliability.go:108-130`).

Part PUT headers: `Authorization: <auth_key>`, `Content-Type: <mime>`,
`Referer: https://pan.quark.cn/`, `x-oss-date`, `x-oss-user-agent` (`:425-430`); query
`partNumber`, `uploadId` (`:431-434`); response `Etag` header is captured (`:441`, and `:259` in
the OpenList variant). A non-200 aborts with the OSS body (`:438-440`).

**Step 5 — commit.** The body is an OSS `CompleteMultipartUpload` XML:
`<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload><Part><PartNumber>i</PartNumber>
<ETag>…</ETag></Part>…</CompleteMultipartUpload>` (`:448-459`). `Content-MD5` is the base64 MD5 of
that XML (`:460-462`); `x-oss-callback` is base64 of the JSON `pre.Data.Callback` (`:463-467`).
`auth_meta` switches to the `POST` form documented at `:470-479`.

**Step 6 — `/file/upload/finish`** (`:514-527`): `{obj_key, task_id}`, then a 1-second sleep.

`upload_pre` is only ever sent once per file; `hash`/`part`/`commit`/`finish` are retried up to 3×
with 1 s→2 s backoff, and only for the provider transients
`complete_upload_lock_timeout` / `inner error … requestid`
(`alist_quark_uc_upload_reliability.go:20-28,37-61,77-106`).

### 5.2 Open-platform sequence (`openlist_quark_open_driver.go:145-236`)

```
1. md5 + sha1
2. POST /open/v1/file/upload_pre   (with proof_* fields)  -> finish?, task_id, fid, part_size,
                                                             common_headers, upload_urls[]
   finish == true ==> instant upload, done
3. POST /open/v1/file/get_upload_urls {task_id, part_info_list:[{part_number, part_size}]}
                                   -> upload_urls[{part_number, signature_info.signature,
                                                   upload_url}], common_headers, upload_id
4. PUT <upload_urls[i].upload_url>
      Authorization: <signature_info.signature>, X-Oss-Date, X-Oss-Content-Sha256,
      Accept-Encoding: gzip, User-Agent: Go-http-client/1.1   -> ETag
5. POST /open/v1/file/upload_finish {task_id,
      part_info_list:[{part_number, part_size, etag}]}       -> data.finish
```

`part_info_list` for step 3 is generated by chunking on `pre.Data.PartSize`
(`openlist_quark_open_util.go:284-308`).

**`/open/v1/file/upload_pre` body** (`openlist_quark_open_util.go:142-157`): `file_name`, `size`,
`format_type`, `md5`, `sha1`, `l_created_at`, `l_updated_at`, `pdir_fid`, `same_path_reuse: true`,
and the proof set `proof_version`, `proof_seed1`, `proof_seed2`, `proof_code1`, `proof_code2`.

**The proof algorithm** (unique to this API, `openlist_quark_open_util.go:176-282`):

* `proof_version = "v1"` (constant).
* `proof_seed1 = md5hex(userId + xPanToken)` where `xPanToken` is the token **generated for
  `/open/v1/file/upload_pre`** (`:200-204`).
* `proof_seed2 = md5hex(decimal_string(fileSize))` (`:207-210`).
* Range: `index = uint64(hex(seedMd5)[:16]) % fileSize`; read **8 bytes** from `index`
  (clamped to EOF) (`:257-282`).
* `proof_codeN = base64StdBytes of the 8 bytes read using seedN` (`:218-254`).
* Zero-length file ⇒ empty proof codes (`:258-260`).

`common_headers` keys are literally `"X-Oss-Content-Sha256"` and `"X-Oss-Date"`
(`openlist_quark_open_types.go:95-98,122-125`).

---

## 6. Download flow, end to end

### 6.1 Cookie family

```
POST /file/download   {"fids": ["<fid>"]}          + UA header
   -> data: [ { "download_url": "https://..." } ]  (ARRAY)
GET <download_url>
   Cookie: <same snapshot> ; Referer: <conf.referer> ; User-Agent: <conf.ua>
```

Evidence: `alist_quark_uc_util.go:189-223`; `alist_quark_pc_driver.go:58-70`;
`openlist_quark_uc_util.go:114-136`; response type `alist_quark_uc_types.go:115-149`
(`Data []struct{ DownloadUrl string \`json:"download_url"\` }`).
Fixture: `alist_quark_uc_util_test.go:169-199`.

* **Time-limited: yes.** The URL is signed, and the signature is bound to the minting cookie —
  presenting a different cookie yields **403** (`alist_quark_uc_util.go:194-196`). The concrete
  TTL in seconds is **not stated in these sources — UNVERIFIED**.
* **HTTP Range: supported.** The archived PC driver implements ranged reads directly and *requires*
  `206 Partial Content`:

  ```go
  req.Header.Set("Range", "bytes=<start>-<end-1>")
  ...
  if resp.StatusCode != http.StatusPartialContent { return fmt.Errorf(...) }   // alist_quark_pc_driver.go:96-114
  ```
  It streams in **10 MB** chunks (`:90`), and honors an inbound `Range` request header by
  translating it into a `206` link with `Content-Range`/`Content-Length`
  (`:75-87`). Current alist expresses the same thing declaratively via
  `link.Concurrency = 3` / `link.PartSize = 10 MB`
  (`openlist_quark_uc_util.go:134-135`; `alist_quark_uc_util.go:227-237`, defaults from
  `alist_quark_uc_meta.go:15-16`). Ranged download can be disabled by setting concurrency `0`.

* **UC-specific extra:** `/file/download` takes an extra query param `ut` for UC only — an
  AES-128-CBC device token (`alist_quark_uc_util.go:181-188`), computed from a 24-byte `UTDID` with
  fixed key/IV `2106f55fd41e800c` and a 2-byte big-endian prefix `13801`
  (`alist_quark_uc_token.go:13-39`). This is **UC-only**, not Quark.
* **Transcoding alternative:** `POST /file/v2/play/project` with
  `{fid, resolutions: "low,normal,high,super,2k,4k", supports: "fmp4_av,m3u8,dolby_vision"}`
  yields `data.video_list[].video_info.url` (`openlist_quark_uc_util.go:139-168`); selected for
  video files (`category == 1`) when enabled. An `plf_invalid` error falls back to the normal
  download link (`alist_quark_uc_driver.go:106-120`).

### 6.2 Open-platform family

`POST /open/v1/file/get_download_url` with `{"fid": "<fid>"}` returns
`data.download_url` (`openlist_quark_open_driver.go:69-89`, type
`openlist_quark_open_types.go:79-87`). The returned link is used with
`Cookie: x_pan_client_id=<appID>; x_pan_access_token=<accessToken>`
(`openlist_quark_open_util.go:466-470`) and downloaded with concurrency 3 / 10 MB parts
(`openlist_quark_open_driver.go:81-88`). Time-limit specifics are **UNVERIFIED**.

### 6.3 TV family

`GET /file?method=download&group_by=source&fid=…&resolution=low,normal,high,super,2k,4k&support=dolby_vision`
→ `data.download_url` (`openlist_quark_uc_tv_util.go:254-274`, type
`openlist_quark_uc_tv_types.go:120-128`). `method=streaming` returns per-resolution video URLs
(`:225-252`).

---

## 7. Out of scope (not needed for basic file management) and not covered here

Marked out-of-scope per the brief, and **not analysed**:

* Share creation / share links / share token redemption / "save to my drive" from a share.
* Offline download (magnet/URL tasks) and any task-list UI.
* `/file/v2/play/project` transcoding and TV `method=streaming` — documented only for completeness
  in §6.1/§6.3 because the drivers expose it as a download variant.
* Membership / quota (`GET /member`) — documented only because it is the sole `GetDetails` source.
* OAuth login acquisition: `POST /token`, `/oauth/authorize`, `/oauth/code` (TV family) — needed to
  bootstrap a token, not for file management.

---

## 8. Consolidated UNVERIFIED list

Revised after incorporating `MINED_ENDPOINTS.md` (official client bundle). Items that moved from
UNVERIFIED to "path confirmed, schema still unknown" are marked accordingly.

| Item | Status |
|---|---|
| `POST /file/search` | **Path CONFIRMED** (`MINED_ENDPOINTS.md:43`); method, params, response **UNVERIFIED** |
| `/file/content_search`, `/file/general_search`, `/file/search/source/list` | **Paths CONFIRMED** (`:95,:100,:226`); everything else **UNVERIFIED** |
| Task-status / polling endpoint | **Paths CONFIRMED**: `/1/clouddrive/task`, `/task/status`, `/task/list`, `/task/current/list`, `/task/count` (`:4,:24,:140,:64,:230`); request/response schema **UNVERIFIED** |
| Whether mkdir/rename/move/delete are async | **UNVERIFIED** — all four drivers treat them as synchronous and none polls a task |
| Copy endpoint | **Path CONFIRMED** (`/1/clouddrive/file/copy`, `:124`); method/params/response **UNVERIFIED**; unimplemented in all drivers |
| `Origin` header requirement | **UNVERIFIED** — never set in any source |
| Authoritative auth-cookie set for the PC API | **UNVERIFIED** — 9 cookie names mined (`:463-473`) but `__puus` (the one the drivers use) is absent from the bundle; candidates `b-user-id`, `__uid`, `__pu`, `__kuus`, `__uus`, `__pc` are unproven |
| Download URL TTL (seconds/minutes) | **UNVERIFIED** — signature-binding to the minting cookie is proven; duration is not |
| Per-request captcha / risk-verification | **UNVERIFIED** — none found. Closest analogues: `/account/send_auth_verification_code` (`:280`) and TV QR login (`§3.2`) |
| Exact integer code for "need captcha/verify" | **UNVERIFIED** — no such code appears |
| Multi-element `filelist` / `fid_list` batch behaviour | **UNVERIFIED as exercised** — shape is an array, but every call site sends exactly one fid |
| `same_path_reuse` on `/file/upload/pre` | Present in the open-platform body; **commented out** in the cookie family |
| Whether `pr`/`fr` are strictly required vs. merely sent | **UNVERIFIED** — always sent, never omitted, so requirement is not proven |
| `/file/info` behaviour for folders | **UNVERIFIED** — only a file case is exercised (`"file": true`) |
| `/file/formupload/pre` | **Path CONFIRMED** (`:17`); this is the likely **multipart/form-data** counterpart to the OSS flow — its field names are **UNVERIFIED** and it is used by no driver |

---

## 9. Quick-reference request template (PC/cookie family)

```
POST https://drive.quark.cn/1/clouddrive/file/sort
     ?pr=ucpro&fr=pc
     &pdir_fid=0&_page=1&_size=100&_fetch_total=1
     &fetch_all_file=1&fetch_risk_file_name=1
     &_sort=file_type:asc,file_name:asc
Cookie: <browser cookie, incl. __puus>
Accept: application/json, text/plain, */*
Referer: https://pan.quark.cn
```
