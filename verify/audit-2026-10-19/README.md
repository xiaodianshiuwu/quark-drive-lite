# 独立审计证据（2026-10-19）

总体结论和限制见 ../../docs/AUDIT-2026-10-19.md，逐功能证据见同目录引用的CSV。

- summary.json：两轮实际结果、环境、源码指纹、打包和未验证范围。
- code-inventory.json：UTF-8源/配置/脚本/测试清单、逐文件SHA256及符号行。总体hash为按路径排序后拼接 `path + NUL + sha256 + LF` 的SHA256。文档、证据、构建物及旧Electron运行代码不计入此指纹；CI文件为工程参考。
- round1/round2：实际命令输出及每轮原生WebView报告；verification-runs.json记录退出码、耗时和每步未变的源指纹。
- cloud-summary.json：真实云端受控fixture结果以及中间失败/清理情况。原始云端日志保留在本机忽略目录，不把资料目录、账号绑定、认证配置或私人文件带入证据。
- screenshots/：独立无头Chrome真实渲染的Fixture业务状态，非用户真实云端GUI截屏。图像的UI源与本次交付一致。
- dependencies.json、glib依赖树：包含未关闭的Linux GLib健全性问题和4条弃维护警告，不能解释成安全全绿。
- package-summary.json：本地ad-hoc签名arm64包、解包校验与隔离profile隐藏启动10秒；不是发布包全功能验收。

测试并未复现断电、Windows真机、用户私人海量备份、真实模型服务或所有原生系统对话框。不要用测试数量替代上述边界。

终端文本证据仅移除末尾空行，测试内容和退出码不改动。
