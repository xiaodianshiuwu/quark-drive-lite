# Windows x64 构建交付（2026-10-20）

已补交 Windows 10/11 x64 的 NSIS 安装版和免安装 ZIP，包含 `212ffd1` 的“上一级”按钮、面包屑和 Alt+↑修复。构建主机为 macOS arm64，目标 `x86_64-pc-windows-msvc`，不将其称为Windows原生运行验收。

- [安装版EXE](../.work/windows-build-20261020/deliverables/QuarkDriveLite-0.3.0-alpha.1-Windows-x64-setup.exe)：4,774,553字节，默认当前用户安装，支持简体中文和英语；缺少WebView2时从微软下载组件，需联网。
- [免安装ZIP](../.work/windows-build-20261020/deliverables/QuarkDriveLite-0.3.0-alpha.1-Windows-x64-portable.zip)：解压运行`QuarkDriveLite.exe`，要求系统已有WebView2；缺失时先使用安装版。附README和备份说明。
- [SHA256清单](../.work/windows-build-20261020/deliverables/SHA256SUMS.txt)，[结构化证据](../verify/windows-build-2026-10-20/summary.json)。不包含账号、凭证、聊天状态或用户备份数据。

## 验证及剩余边界

实际完成：MSVC x64 release交叉编译、NSIS构建、`cargo xwin check --workspace --all-targets --locked --target x86_64-pc-windows-msvc`（0错误、0warning）、macOS上Rust workspace 166/166、7-Zip安装器完整性检查/解包、ZIP完整性检查、PE架构与GUI subsystem、DLL导入表检查和SHA256。

主程序为PE32+ AMD64、GUI subsystem=2。NSIS安装器壳为32位、承载64位应用，属于NSIS的正常结构。安装器内部EXE与原构建EXE仅相差Tauri的固定bundle标识补丁（`UNK`→`NSS`），逐字节核对除此以外完全一致；免安装版保留原始`UNK`标识。没有把正常的bundle补丁差异隐藏为哈希完全相同。

本轮修复了Windows专用未使用变量警告，以及网关测试中未正确隔离的Unix socket文件断言；不可读目录测试变量在Windows不适用时明确忽略。生产逻辑未简化，Unix测试断言保留。

**仍未验收**：Windows上安装/卸载、首次启动/扫码、WebView2实际下载、命名管道运行、长路径/保留名/junction、真实备份与恢复。Windows测试只编译，未运行；166项是macOS宿主测试。未签名、未做Authenticode签名验收；Windows ARM64和32位应用未交付。

release链接有MSVC静态库缺少厂商PDB的LNK4099调试信息警告；NSIS提示非Windows宿主忽略OUTPUTCHARSET，Tauri提示跨平台打包实验性和未签名。这些日志如实保留，不声称整个构建零警告。没有永久删除或真实云端副作用操作。

## 可复现构建

依据 [Tauri官方Windows安装器与交叉编译文档](https://v2.tauri.app/distribute/windows-installer/)，本机新增LLVM/NSIS，cargo-xwin和SDK缓存在项目忽略目录；没有修改全局PATH。

macOS工具准备（本轮版本：LLVM23.1.3、NSIS3.13、cargo-xwin0.23.1、Rust1.98.1）：

```sh
brew install llvm nsis
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin --root .work/windows-build-20261020/tools
```

从仓库根构建：

```sh
PATH="$PWD/.work/windows-build-20261020/tools/bin:/opt/homebrew/opt/llvm/bin:$PATH" \
XWIN_CACHE_DIR="$PWD/.work/windows-build-20261020/xwin-cache" \
CARGO_TARGET_DIR="$PWD/target" CARGO_BUILD_JOBS=4 \
npm run build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

`src-tauri/tauri.windows.conf.json`为Windows专用配置：NSIS、SimpChinese/English、currentUser。Windows本机装好Tauri/MSVC依赖后可使用`npm ci`和`npm run build`；不要在Mac上运行Windows EXE作为验收。

产物：`target/x86_64-pc-windows-msvc/release/bundle/nsis/`。所有改动只做本地提交，没有推送、GitHub Actions触发或远端发布。

终端证据仅去除行尾空白及末尾空行，保留原警告、检查及测试结果。
