<div align="center">

<img src="docs/assets/app-icon.png" alt="夸克网盘极简版图标" width="96" height="96" />

# 夸克网盘极简版 · Quark Drive Lite

<!-- BEGIN MAINTENANCE_NOTICE -->

> **维护公告**
>
> 最近一次更新遇到了一点问题，我正在重新整理仓库和版本，同时修复问题、优化使用体验。GitHub 和应用内的安装包暂时下架，之前收到的新版推送可以先忽略，已安装的版本可以照常使用。
>
> 项目仍在维护，仓库和历史记录会保留。预计北京时间今晚午夜前后发布新版，具体时间以实际发布为准。感谢大家耐心等待！

<!-- END MAINTENANCE_NOTICE -->

**轻巧、纯粹、高速的开源夸克网盘桌面客户端**  
基于 **Tauri 2 + Rust** 原生内核打造 · **3.4–5.7 MB 极致轻量体积** · 零广告 · 零后台常驻 · 隐私优先

[![Release](https://img.shields.io/github/v/release/xiaodianshiuwu/quark-drive-lite?style=flat-square&color=2F66F6&label=最新版本)](https://github.com/xiaodianshiuwu/quark-drive-lite/releases/latest)
[![Platform](https://img.shields.io/badge/平台-Windows%20x64%20%7C%20macOS%20arm64%20%2F%20x64%20%7C%20Linux%20x64-0ea5e9?style=flat-square)](https://github.com/xiaodianshiuwu/quark-drive-lite/releases/latest)
[![Stack](https://img.shields.io/badge/架构-Tauri%202%20%2B%20Rust-f97316?style=flat-square)](#核心架构与隐私承诺)
[![Privacy](https://img.shields.io/badge/遥测-默认完全关闭（零外传）-10b981?style=flat-square)](#核心架构与隐私承诺)
[![License](https://img.shields.io/badge/License-MIT-64748b?style=flat-square)](LICENSE)

[**立即下载最新版**](https://github.com/xiaodianshiuwu/quark-drive-lite/releases/latest) · [**30 秒上手**](#-30-秒快速上手) · [**界面预览**](#-界面预览) · [**完整更新日志**](CHANGELOG.md) · [**反馈问题**](https://github.com/xiaodianshiuwu/quark-drive-lite/issues)

</div>

---

> ### 🎉 v1.3.2 正式发布 · 全平台安装包瘦身 ~20% · 三层热更新与自研传输深度提速
> 感谢每一位点亮 **Star**、在 [Issues](https://github.com/xiaodianshiuwu/quark-drive-lite/issues) 与应用内「意见反馈」里提交真实体验建议的朋友！  
> 最新 **v1.3.2** 通过 Fat LTO 与原生 TLS 根证书复用，将全平台安装包体积直降约 **20%**（Windows 安装包仅约 **3.4 MB**、macOS `.zip` 仅 **4.8 MB**、Linux `.deb` 仅约 **5.1 MB**）；全面完善 **Linux AppImage / Windows 便携版精准更新识别与 GitHub Releases 备用引导**，并集成 **三层轻量更新体系（远端签名热配置 + 前端 UI 秒级热更新 + 应用内一键原位升级）**、**大文件按需并行哈希、小文件 ≤8 MiB 直下快车道、弱网 AIMD 动态并发调节**、**底部悬浮栏一键「云解压」** 与更通俗易懂的中文报错提示。

---

## ✨ 核心特性一览

官方客户端体积庞大、常驻多进程与广告推广；**夸克网盘极简版**用原生 Rust 内核专注做好文件浏览、高速并发传输与高频云工具：

| 维度 | 夸克网盘极简版 v1.3.2 |
|---|---|
| **原生轻量架构** | **Tauri 2 + Rust** 原生编译（Fat LTO + 原生 TLS），Windows 安装包仅 **~3.4 MB**、macOS/Linux `.deb` 仅 **~4.8–5.7 MB**，复用系统 WebView，启动快、低内存、退出即彻底清理无后台驻留 |
| **丝滑文件浏览** | **底部悬浮批量操作胶囊（选行 0px 位移，双击百发百中，单选压缩包一键直达「云解压」）**、深层目录面包屑（`···` 一键跳级 + 滚轮/侧键历史前进后退）、**文件夹真实大小自动回填（带异常目录智能冷却）**、分类快筛、列表/网格双视图虚拟滚动 |
| **自研高速传输引擎** | Rust 异步多线程分片下载（**大文件按需并行哈希削减 99% 卡顿** + **≤8 MiB 小文件跳过探测直下提速 3–5 倍** + **弱网 AIMD 动态降并发防重试风暴** + 1 MiB 写缓冲 + 8/16 MiB 自适应分片 + 403 单飞刷新 + 429 退避）、流式并发分片上传（复用哈希 + 秒传 + 实时进度）、**整个文件夹及子目录递归批量下载**、断点续传、跨文件系统（NTFS/APFS/exFAT/SMB）安全落盘与发布重试 |
| **五大极简云工具** | **压缩包云解压与在线浏览**（悬浮栏/右键一键打开，支持目录钻取 / 密码解锁 / 勾选部分解压 / 同名覆盖确认）、**增强文件详情 & 历史版本恢复**、**云盘空间占用分类明细**、**轻量回收站**、**实时状态栏与顶栏剩余空间直显** |
| **三层轻量更新与双向反馈** | 可选开启更新与反馈通道（**默认关闭、拒绝即底层零外传**）：① **L1 远端引擎热配置**（免重启调优参数）；② **L2 签名式前端 UI 秒级热更新**（~100 KB，8 秒看门狗自动防变砖回滚）；③ **L3 应用内一键安装原位升级**（Ed25519 + SHA-256 双校验）；内置双向意见反馈与进度追踪 |

---

## 📸 界面预览

### 浅色 / 深色双主题 · 文件夹真实大小自动统计 + 详情侧栏 + 实时传输胶囊

<table>
  <tr>
    <td width="50%">
      <img src="docs/assets/workspace-light.png" alt="浅色模式文件工作台与文件夹真实大小" />
      <div align="center"><sub>浅色工作台 · 文件夹真实大小自动回填 & 右侧增强详情</sub></div>
    </td>
    <td width="50%">
      <img src="docs/assets/workspace-dark.png" alt="深色模式文件工作台" />
      <div align="center"><sub>深色工作台 · 实时传输胶囊 & 顶部/侧栏剩余空间直显</sub></div>
    </td>
  </tr>
</table>

### 极简云工具 · 云解压 / 空间占用明细 / 回收站 / 首次引导教程

<table>
  <tr>
    <td width="50%">
      <img src="docs/assets/cloud-archive.png" alt="压缩包云解压与在线目录预览" />
      <div align="center"><sub>压缩包云解压 · 选中压缩包即可从底部悬浮栏一键打开</sub></div>
    </td>
    <td width="50%">
      <img src="docs/assets/storage-breakdown.png" alt="云盘空间占用分类明细" />
      <div align="center"><sub>空间占用明细 · 点击左下角空间卡片一键查看分类占比</sub></div>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/assets/recycle-bin.png" alt="轻量回收站视图" />
      <div align="center"><sub>轻量回收站 · 原路径与剩余保留天数一目了然</sub></div>
    </td>
    <td width="50%">
      <img src="docs/assets/onboarding-tutorial.png" alt="首次使用引导教程" />
      <div align="center"><sub>新手引导教程 · 4 步快速上手，支持随时「全部跳过」</sub></div>
    </td>
  </tr>
</table>

---

## 🚀 30 秒快速上手

### 1. 下载安装（全平台覆盖）

前往 [**GitHub Releases（最新版）**](https://github.com/xiaodianshiuwu/quark-drive-lite/releases/latest) 选择对应系统（已开启应用内更新的用户可直接一键校验下载并原位升级）：

| 平台 | 安装包文件 | 说明 |
|---|---|---|
| **Windows 10 / 11 (x64)** | `QuarkDriveLite-*-Windows-x64-Setup.exe` | **安装版**（支持简中/英文、当前用户免管理员安装、支持干净卸载） |
| **Windows 10 / 11 (x64)** | `QuarkDriveLite-*-Windows-x64-Portable.zip` | **便携版**（UTF-8 编码兼容，解压即运行） |
| **macOS Apple Silicon (arm64)** | `QuarkDriveLite-*-macOS-arm64.zip` | M 系列 Mac，解压后拖入「应用程序」即可使用（支持应用内原位升级） |
| **macOS Intel (x64)** | `QuarkDriveLite-*-macOS-x64.zip` | Intel 芯片 Mac，解压后拖入「应用程序」即可使用 |
| **Linux x64（Debian / Ubuntu）** | `QuarkDriveLite-*-Linux-x64.deb` | 运行 `sudo apt install ./QuarkDriveLite-*-Linux-x64.deb` 安装 |
| **Linux x64（通用便携版）** | `QuarkDriveLite-*-Linux-x64.AppImage` | 运行 `chmod +x QuarkDriveLite-*-Linux-x64.AppImage` 后直接运行 |

> 💡 **校验与 macOS 首次启动提示**：
> - 所有发行包均提供 `SHA256SUMS.txt` 校验文件；应用内直链下载与热更新包均强制验证 **Ed25519 数字签名 + SHA-256**。
> - Linux 依赖说明见 [平台支持文档](docs/PLATFORM_SUPPORT.md)。
> - 若 macOS 首次打开提示「无法验证开发者」（未签名开源构建），在终端执行一次：
>   ```sh
>   xattr -dr com.apple.quarantine "/Applications/QuarkDriveLite.app"
>   ```

### 2. 三步开始使用

1. **查看或跳过新手引导**：首次启动展示 4 步精简教程，可随时一键「全部跳过」，后续可在 `设置 → 查看使用教程` 重看。
2. **登录夸克账号**：点击右上角「登录」，在独立原生窗口完成扫码或账号登录（凭证自动加密存于本机）。
3. **日常高效操作**：
   - **双击**文件夹秒进、**双击**文件直接下载；**单选压缩包**后底部悬浮栏直接出现「**云解压**」按钮，右键同样支持「下载到指定位置…」「下载文件夹」「云解压 / 浏览内容…」；
   - **拖拽**本地文件到窗口直接上传至当前目录；
   - 点击左下角**剩余可用空间**卡片查看分类明细，并可直达回收站清理空间；
   - 开启可选更新与反馈通道后，可在左侧「反馈」提交问题、查看处理进度并与作者直接对话，支持轻量界面秒级热更新与大版本一键升级。

---

## ⌨️ 常用快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt + ↑` / `Backspace` | 返回上一级目录（或退出搜索返回原目录） |
| `Alt + ←` / `Alt + →` / 鼠标侧键 | 目录浏览历史后退 / 前进 |
| `Ctrl + F`（macOS: `⌘ + F`） | 聚焦全盘文件搜索 |
| `Ctrl + I`（macOS: `⌘ + I`） | 开关右侧文件详情抽屉 |
| `Ctrl + Shift + N`（macOS: `⌘ + ⇧ + N`） | 在当前目录新建文件夹 |
| `F2` | 重命名当前选中文件/文件夹 |
| `Enter` | 打开选中文件夹 / 下载选中文件 |
| `Ctrl + A`（macOS: `⌘ + A`） | 全选当前列表 |
| `Esc` | 取消当前选中 / 关闭弹窗 |
| `Delete`（macOS: `⌘ + Backspace`） | 删除选中项目至回收站 |
| `F5` / `Ctrl + R`（`⌘ + R`） | 刷新当前目录与剩余空间 |

---

## 🛡️ 核心架构与隐私承诺

- **本地加密、直连夸克官方接口**：登录 Cookie 使用 **QCK2 AES-256-GCM** 加密保存于本机独立资料目录（不注入前端页面），所有网盘请求均由 Rust 内核直连夸克官方 HTTPS 接口，无中转代理、不绕过官方权益规则。
- **可选的更新、热更新与反馈通道（默认关闭）**：
  - 首次启动弹窗征询同意；**选择「暂不开启」后，Rust 底层硬拦截一切相关网络请求，严格零外传。**
  - 开启后所有上报均走 **HTTPS TLS 1.3 + X25519 / AES-256-GCM 端到端加密**（已接入 Cloudflare 边缘代理）；所有远端热配置、前端热更新包与原生安装包均强制校验 **Ed25519 数字签名 + SHA-256**，前端热更新内置 **8 秒启动看门狗** 异常自动回滚至内置界面。
  - **严格零 PII 脱敏原则**：性能与稳定诊断仅采集纯数值/枚举指标（传输 5 阶段耗时、速率、大小区间、分片/并发/AIMD 次数、I/O 枚举与错误码、慢请求耗时、冷启动与主线程卡顿耗时、脱敏后的源码行号崩溃位置与进程内存），**绝不采集任何文件名、本地路径、FID、直链、Cookie、Token、账号或 IP**；用户主动附带的反馈日志同样经过客户端严格脱敏并支持提交前全文预览。
- **AI 实验室（Beta · 默认关闭）**：内置对话与 MCP / Agent 本地网关默认隐藏且不启动，需在 `设置 → AI 实验室` 手动开启，默认只读且严格受目录白名单约束。
- **独立资料目录**：
  - macOS：`~/Library/Application Support/cn.quarkdrive.lite.tauri`
  - Windows：`%APPDATA%\cn.quarkdrive.lite.tauri`
  - Linux：`$XDG_DATA_HOME/cn.quarkdrive.lite.tauri`（默认 `~/.local/share/cn.quarkdrive.lite.tauri`）

---

## 🛠️ 从源码构建与自动化验证

环境要求：**Rust stable**、**Node.js ≥ 24** 及对应平台的 [Tauri 2 构建依赖](https://v2.tauri.app/start/prerequisites/)：

```sh
git clone https://github.com/xiaodianshiuwu/quark-drive-lite.git
cd quark-drive-lite
npm ci --ignore-scripts
npm start
```

常用开发与发布命令：

```sh
npm run check          # JS 语法 / JSON 配置 + Rust workspace 静态检查
npm run test:rust      # Rust 全工作区单测与跨语言 E2EE/热更新联调测试（165+ 项）
npm test               # 前端契约、AI 门控与无头 Chrome 全量 DOM 回归（67+ 项）
npm run verify:native  # 原生 WebView 端到端冒烟验证（29 项）
npm run verify:all     # 一键执行全链路验证
npm run build          # 构建当前平台正式安装包
```

---

## 📚 进阶文档

- [完整更新日志（CHANGELOG.md）](CHANGELOG.md)
- [平台支持与 Linux 运行指南（docs/PLATFORM_SUPPORT.md）](docs/PLATFORM_SUPPORT.md)
- [夸克接口取证与实测笔记（docs/API_NOTES.md）](docs/API_NOTES.md)
- [Tauri 2 + Rust 架构说明（docs/TAURI_ARCHITECTURE.md）](docs/TAURI_ARCHITECTURE.md)
- [渲染层桥接契约（docs/IPC_CONTRACT.md）](docs/IPC_CONTRACT.md)
- [Windows 实机验收清单（docs/WINDOWS_QA_CHECKLIST.md）](docs/WINDOWS_QA_CHECKLIST.md)

---

## 📄 开源许可

本项目基于 [MIT License](LICENSE) 开源。如果觉得轻量顺手，欢迎点一个 **Star ⭐** 支持！
