> 公开版本：官方完整解包、原始日志、安装标识、历史原型和二进制只在私有归档中保存。下文对原研究材料的路径说明需在有权限的私有 checkout 中使用，产品构建不需要这些材料。

# reference/ — 逆向研究与协议对照材料

> ⚠️ **本目录仅用于开发期协议核对，不是项目运行依赖。**
> 这些文件帮助我们确认「夸克网盘的真实接口长什么样」，从而避免凭猜测写代码。
> 生产代码**不引用**本目录的任何文件。

---

## 1. 本目录内容

### 1.1 我们自己挖掘的成果

| 文件 | 内容 | 来源 |
|---|---|---|
| `MINED_ENDPOINTS.md` | 从官方 PC 客户端 JS 中挖掘出的 **273 个端点**及出现次数 | 本机官方客户端 `app.asar` 提取后由 `tools/mine_endpoints.py` 统计 |
| `PC_API_REFERENCE.md` | 实测型参考：二维码登录流程、路由存在性探测、状态码 | 联网研究整理 |
| `API_REFERENCE.md` | 28 个开源驱动源码的逐行取证参考 | GitHub（经镜像下载） |

### 1.2 官方客户端反编译产物 —— **已在仓库内，开箱即用**

`reference/quark_asar/`（**3019 个文件 / 188.8 MB**）是官方 `app.asar` 的完整解包产物，
**已随仓库提供**（私有仓库），克隆后即可直接用于协议分析，无需自行解包。

| 路径 | 内容 |
|---|---|
| `dist/main/main.js` | 官方主进程：API 基址（`cloudDriveUrl`）、UA 拼装、登录机制 |
| `dist/renderer/index.js` | 渲染层主包（8.4 MB）：**273 个端点与核心算法集中地** |
| `dist/renderer/*.js` | 各功能分包（各窗口独立 bundle） |
| `package.json` | 依赖清单与**私有包证据**（`@ali/xdrive`、`@ali/quark-pdfsdk`） |
| `node_modules/` | 官方打包进 asar 的三方依赖与私有包（2808 文件 / 6.4 MB） |

> 为什么把它纳入仓库：云端开发环境（Linux 容器）**无法安装 Windows 版官方客户端**，
> 若不入库，则云端根本无法解包、无法做协议分析。它正是「克隆即用」的关键材料。

**如需重新解包**（例如官方客户端升级后比对差异）：

```bash
# 1) 从 Release 下载 app.asar（261 MB）
gh release download research-assets-2026-10-14 \
  --repo xiaodianshiuwu/quark-drive-lite-private-archive -p 'app.asar'

# 2) 解包
node -e "require('@electron/asar').extractAll('app.asar','reference/quark_asar')"
# 或
python tools/extract_asar.py
```

### 1.3 官方客户端本体文件（`quark_official/`）

小体积的官方文件（`build_info.json`、`quark.exe`、`results.txt` 等）位于
`reference/quark_official/`，清单与 SHA256 见该目录的 `MANIFEST.md`。

**超过 GitHub 单文件 100 MB 限制的三个大文件**（`quark.dll` 306 MB、`app.asar` 261 MB、
便携版 zip 110 MB）通过 **Release 附件**提供：

```bash
gh release download research-assets-2026-10-14 --repo xiaodianshiuwu/quark-drive-lite
```

### 1.4 第三方开源驱动源码（`*.go`、`_src/`）

用于**交叉验证协议细节**（Cookie 轮换、分片上传签名、删除重试等）。
各自版权归原作者所有，均为公开 GitHub 仓库代码：

| 文件前缀 | 上游项目 | 说明 |
|---|---|---|
| `alist_quark_*` | [alist-org/alist](https://github.com/alist-org/alist) | Quark UC / PC 驱动（含删除与上传可靠性实现及测试） |
| `openlist_quark_*` | [OpenListTeam/OpenList](https://github.com/OpenListTeam/OpenList) | Quark UC / TV / Open 驱动 |
| `_src/*.py` | 多个第三方 Quark Python 客户端 | 登录与 API 交互参考 |

> 若上游要求，可在后续提交中移除这些文件——**项目本身不依赖它们**。

---

## 2. 证据优先级（本项目铁律）

```
① 本机官方客户端二进制挖掘（最可信，能拿到真实参数名）
        ↓
② 本机实测（真实账号打请求，观察结果集是否真的变化）
        ↓
③ 开源驱动源码（交叉印证，可能存在版本滞后）
```

**任何端点或参数，若未在上述来源中出现过，一律不得写进实现代码。**
新发现必须补录到 `docs/API_NOTES.md` 并标注证据来源。

---

## 3. 用到的验证手段（可复用）

### 3.1 路由存在性探测（无需登录）

该 API 是 Spring Boot 应用：

- 用**错误的方法**请求**存在**的路由 → `405` + `HttpRequestMethodNotSupportedException` ⇒ 路径存在
- 请求**不存在**的路由 → `404` + `"No message available"` ⇒ 路径不存在

借此已证伪多个网上流传的假接口（`file/list`、`file/recycle/restore` 均为 404）。

### 3.2 "参数是否真的生效"验证法

**不能只看"有没有报错/有没有结果"**。必须验证**结果集随参数变化**。

实例（真实账号实测搜索参数）：

| 参数 | 结果 | 判定 |
|---|---|---|
| `q` | 完整文件名→1 项；前缀→5 项；`a`→14 项 | ✅ 有效 |
| `keyword` / `_keyword` / `key` / `file_name` / `query` | 一律返回根目录默认 20 项 | ❌ 被服务端**静默忽略** |

> 后 5 个看起来"也成功了"（HTTP 200 / code 0 / 有结果），
> 但实际是服务端忽略了参数、返回默认列表。只检查"是否报错"会得出完全错误的结论。
