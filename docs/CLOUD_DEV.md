> 公开版本：官方完整解包、原始日志、安装标识、历史原型和二进制只在私有归档中保存。下文对原研究材料的路径说明需在有权限的私有 checkout 中使用，产品构建不需要这些材料。

# 云端开发环境搭建指南（CLOUD_DEV）

> 面向：在 **Linux 云端环境**（容器 / 云主机 / GitHub Codespaces 等）克隆本仓库后开展开发与逆向分析。
> 目标：明确**哪些能跑、哪些不能跑、需要什么条件**，避免在云端浪费时间去调本机才有的东西。

当前 P0 的系统支持范围、原生 CI 与验收边界见 [三平台适配说明](P0_COMPATIBILITY.md)。

---

## 1. 仓库内容与体积

| 内容 | 体积 | 是否需要额外下载 |
|---|---|---|
| 源码 / 测试 / 工具 / 文档 | 约 2 MB | 否 |
| `reference/quark_asar/`（官方前端解包产物，3019 文件） | 188.8 MB | 否，**已在仓库内** |
| `reference/quark_official/`（官方元数据与小体积本体） | 15.6 MB | 否 |
| `quark.dll` / `app.asar` / 便携版 zip | 306 / 261 / 110 MB | **是**，见 [Release](https://github.com/xiaodianshiuwu/quark-drive-lite/releases) |

仓库约 **206 MB**。若只需源码做代码开发、暂不需要逆向材料：

```bash
# 稀疏克隆：只取源码与文档，不拉 190MB 的逆向材料
git clone --filter=blob:none --sparse https://github.com/xiaodianshiuwu/quark-drive-lite.git
cd quark-drive-lite
git sparse-checkout set src test verify scripts tools docs package.json README.md
```

需要逆向材料时再补：

```bash
git sparse-checkout add reference
```

---

## 2. 环境依赖

| 依赖 | 版本 | 用途 | 必需性 |
|---|---|---|---|
| Node.js | **24.18+** | 源码、测试、CDP 工具与原生环境代理 | 必需 |
| pnpm | **11.25.0** | 按锁文件安装依赖 | 推荐 |
| Python | ≥ 3.8 | `tools/*.py`（端点挖掘、字符串取证） | 逆向分析时必需 |
| Electron | **44.7.2**（显式运行官方安装器） | 真机冒烟 / 打包 | 跑 Electron 相关验证时必需 |

```bash
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
```

> 安装使用仓库锁文件，并只显式执行 Electron 安装器。该安装器会下载对应平台二进制（约 100 MB）。
> **若只跑纯 Node 的单元/集成测试**，可省略安装器步骤：
> ```bash
> pnpm install --frozen-lockfile --ignore-scripts
> ```
> 但这样 `verify:smoke` 与 `pack` 无法运行。

---

## 3. 各类命令在云端的可行性（**重要**）

| 命令 | 云端 Linux | 说明 |
|---|---|---|
| `npm test` | ✅ **可直接跑** | 262 项。纯 Node，不需要 Electron、不需要外部网络、不需要登录 |
| `npm run verify` | ✅ **可直接跑** | 48 项集成验证。纯 Node |
| `npm run verify:smoke` | ⚠️ **需要虚拟显示** | 28 项。会真实启动 Electron，见下方 §3.1 |
| `npm run e2e` | ❌ **云端不可用** | 需要**真实夸克账号扫码登录**（人工交互），且会操作真实网盘 |
| `npm run stability` | ❌ **云端不可用** | 依赖 **Windows 版官方客户端**（`quark.exe`），Linux 无法运行 |
| `npm run native` | ❌ **云端不可用** | 同上，方案 B 只能在 Windows 上跑 |
| `npm run pack` | ✅ **可生成 Windows 目录** | 自动构建匹配版本的 Windows x64 运行时并组装便携目录；原生运行由 Windows CI 验证 |
| `npm run pack:linux` | ✅ **可直接跑** | Linux 原生目录构建；产物冒烟需要图形会话；旧格式样本额外需要密钥环服务 |
| `npm run pack:mac` | ❌ **Linux 不适用** | 在 macOS 原生构建与验证，CI 覆盖 Intel 和 Apple Silicon |
| `tools/*.py`（字符串取证、端点挖掘） | ✅ **可直接跑** | 纯文件读取分析，**Linux 上完全可用** |
| `tools/dll_research/*` | ✅ 部分可用 | 字符串取证/Mojo 分析可跑；**实际启动客户端验证的部分不可用** |

### 3.1 在无头 Linux 上跑真机冒烟

```bash
# 在已配置 D-Bus 并解锁系统密钥环的 Linux 会话中
xvfb-run -a npm run verify:smoke

# 已安装上述依赖的无头验收环境，使用一次性的测试密钥环
bash scripts/ci-linux-gui.sh npm run verify:all
```

当前应用使用免系统密码的本地随机密钥，日常验证可直接使用 `xvfb-run`。一次性验收脚本不能用于真实账号日常启动。
旧系统密文的兼容验收仍需 D-Bus、libsecret 与临时 Secret Service 密钥环；正常应用不依赖解锁。保留 Electron 沙箱和 TLS 验证。
本次托管实例已配置辅助入口，可运行：

```bash
/workspace/.cloud-setup/quark-drive-lite/run-gui.sh npm run verify:smoke
```

实例安装、启动说明位于 `/workspace/.cloud-setup/quark-drive-lite/START.md`。
这些辅助文件位于仓库外，仅适用于当前实例；新实例需自行配置上述系统服务。

> 冒烟测试用 CDP 附加到 Electron 窗口（端口 9777）。**必须清掉 `ELECTRON_RUN_AS_NODE` 环境变量**，
> 否则 Electron 会以纯 Node 模式启动，报出极具误导性的
> `TypeError: Cannot read properties of undefined (reading 'whenReady')`。
> 项目已通过 `scripts/start.js` 处理该问题；但若你手工调用 `electron`，需自行 `unset`。

---

## 4. 逆向分析（云端的主战场）

这部分**完全可以在 Linux 上做**，因为都是静态分析：

### 4.1 官方前端代码分析（已在仓库内，开箱即用）

```bash
# 官方主进程：基址、UA、登录机制
less reference/quark_asar/dist/main/main.js

# 渲染层主包（8.4 MB）：273 个端点与核心算法
less reference/quark_asar/dist/renderer/index.js

# 官方的依赖清单与私有包证据
cat reference/quark_asar/package.json
ls  reference/quark_asar/node_modules/@ali/    # @ali/xdrive、@ali/quark-pdfsdk（私有包）
```

配套工具：

```bash
python3 tools/mine_endpoints.py       # 使用仓库相对路径，输出到 .work/MINED_ENDPOINTS.md
python3 tools/count_private_api.py    # 统计私有 API 引用（文档记录为 7231 处）
python tools/ctx.py                   # 抽取任意 JS 的上下文，用于查证参数名
```

### 4.2 quark.dll 静态分析（需先下载 Release 附件）

```bash
# 从 Release 下载 quark.dll（306 MB）
gh release download research-assets-2026-10-14 --repo xiaodianshiuwu/quark-drive-lite-private-archive -p 'quark.dll'

# 校验（必须是原版）
sha256sum quark.dll
# 期望: 47579001A37074138EF1EF9223FB504902D6FED6115AAAE955460690A24AE831
```

> `tools/dll_research/` 下的脚本**写死了 Windows 路径**，在 Linux 上需要先改路径常量。
> 涉及 PE 结构解析（`step6_locate_patch.py`）与字符串取证的脚本是纯 Python 逻辑，改路径即可运行。

### 4.3 协议验证（需要真实账号，注意边界）

路由存在性探测**无需登录**，可在任意环境执行：

```bash
# Spring Boot 特征：错误方法 + 存在路由 → 405；不存在 → 404 "No message available"
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'https://drive-pc.quark.cn/1/clouddrive/file/search'
# 期望 405 ⇒ 路径存在
curl -s -o /dev/null -w '%{http_code}\n' 'https://drive-pc.quark.cn/1/clouddrive/file/list'
# 期望 404 ⇒ 该路径不存在（网上流传的错误写法）
```

---

## 5. 云端开发的注意事项

### 5.1 不要提交的东西

`.gitignore` 已排除，但请留意**别用 `git add -f` 绕过**：

- 登录态：`session.bin`、任何 Cookie 文件 —— **严禁入库**
- `dist/`（536 MB 构建产物）、根 `node_modules/`（357 MB）
- `.work/`（逆向临时产物，可能含数百 MB 的 DLL 副本）
- 任何 `>100 MB` 的单文件 —— GitHub 会直接拒绝推送

> 顺带记录两个**曾经踩过的 `.gitignore` 坑**（已修复，勿重蹈）：
> 1. `dist/` 未锚定仓库根 → 误伤 `reference/quark_asar/dist/`，导致官方前端**主代码被静默忽略**。
>    正确写法：`/dist/`。
> 2. `node_modules/` 未锚定 → 误伤 asar 内的官方依赖包。正确写法：`/node_modules/`。

### 5.2 大文件走 Release，不进 git

GitHub 单文件上限 **100 MB**（硬限制，超了直接拒绝 push）。超过的走 Release 附件（上限 2 GB）：

```bash
# 上传新的大文件附件
gh release upload research-assets-2026-10-14 <文件> --repo xiaodianshiuwu/quark-drive-lite
```

### 5.3 行尾符

仓库设置了 `core.autocrlf=true`（Windows 侧）。在 Linux 克隆后文件为 LF，属正常现象；
若发现 diff 显示整个文件被改写，检查 `git config core.autocrlf` 是否为 `input`。

### 5.4 Node 版本差异

- 完整开发、CDP 验证与原生环境代理使用 **Node 24.18+**。
- ⚠️ **不要用裸 `node --test`**：它会把 `tools/` 下的工具脚本也当成测试（其中稳定性工具会尝试
  启动并强杀官方客户端）。正确口径是 `npm test`（脚本已限定为 `node --test test/*.test.js`）。
  - `npm test` → **262 项**；裸 `node --test` 会误把历史工具计入测试。

---

## 6. 云端可完成的完整工作流（示例）

```bash
# 1. 克隆
git clone https://github.com/xiaodianshiuwu/quark-drive-lite.git
cd quark-drive-lite

# 2. 安装（跳过 Electron 二进制以加速）
pnpm install --frozen-lockfile --ignore-scripts

# 3. 代码级验证（不需要 Electron / 网络 / 登录）
npm run check      # 语法与构建配置
npm test           # 262/262
npm run verify     # 48/48

# 4. 协议与逆向分析
python tools/mine_endpoints.py
python tools/count_private_api.py
grep -n 'cloudDriveUrl' reference/quark_asar/dist/main/main.js

# 5. 修改代码后回归
npm test && npm run verify
```

---

## 7. 云端**做不到**的事（需要原生系统或真实账号）

| 事项 | 原因 |
|---|---|
| 真实账号 E2E | 需人工扫码登录 + 操作真实网盘 |
| 方案 B（官方原生精简版） | 依赖 Windows 版官方客户端 |
| 方案 B 稳定性测试 | 同上 |
| 实际运行 Windows 便携版 | Linux 可生成目录；原生运行和界面验证由 Windows CI 执行 |
| 验证实际下载/上传速度 | 需真实账号且受账号等级限速 |
| 账号容量相关验证 | 当前实例未登录；历史账号容量限制见 `docs/HANDOVER.md` §2.3 |

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| [docs/HANDOVER.md](HANDOVER.md) | 接手文档：架构、全文件清单、16 条踩坑记录、禁区 |
| [docs/API_NOTES.md](API_NOTES.md) | 接口唯一真相来源（含证据链与待确认清单） |
| [docs/IPC_CONTRACT.md](IPC_CONTRACT.md) | 渲染层与主进程的契约 |
| [docs/CODE_REVIEW_2026-10-13.md](CODE_REVIEW_2026-10-13.md) | 代码审查与修复报告（P1/P2 缺陷） |
| [reference/quark_official/MANIFEST.md](../reference/quark_official/MANIFEST.md) | 官方客户端文件清单与大文件获取方式 |
| [reference/README.md](../reference/README.md) | 逆向材料的证据优先级与验证方法 |
