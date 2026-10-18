//! Agent 接入子系统。
//!
//! 功能来源：`quark-drive-lite`（AI 精简版，qck 工作副本 2026-10-16 未提交成果）的
//! `src/main/agent/`。本 crate 把同一套授权模型、工具层、网关与对话适配到 Tauri 架构：
//! 业务能力（fs/transfer）来自 `quark-core` 与 `quark-transfer`，而不是 Electron 主进程模块。
//!
//! 三条硬约束（与 qck docs/AGENT_ACCESS.md §3 一致）：
//! 1. 每个涉及网盘或本地路径的参数都必须先过范围校验，再调用业务层；
//!    范围校验按当前真实归属判定，不信任调用方给的路径字符串。
//! 2. 输出一律裁剪：不透传上游 `raw`、Cookie、鉴权头、带签名的下载直链。
//! 3. 完整性信息必须显式：分页截断、递归截断、部分失败、待核对状态都要如实返回。

pub mod policy;
pub mod config;
pub mod journal;
pub mod registry;
pub mod plans;
pub mod gateway;
pub mod chat;
pub mod chat_config;
pub mod tools;
pub mod runtime;

pub use plans::PlanStore;
pub use policy::{AgentError, AgentToolError};
