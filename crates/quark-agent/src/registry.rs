//! Agent 工具注册表接口。
//!
//! 工具层由 host 接线（src-tauri）实现：它把 quark-core/quark-transfer 的业务能力
//! 包装成 19+1 个工具，并集中执行范围校验、写权限与审计。本模块只定义共享形状，
//! 使 gateway / chat / tests 可以不依赖具体业务实现工作（qck 同构设计）。

use crate::policy::AgentToolError;
use serde_json::{json, Value};

/// 单个工具的元数据（名称、描述、参数 schema）。
#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// OpenAI tools 格式的参数 schema（JSON 对象）。
    pub parameters: Value,
    /// 是否需要 scoped-write 写权限。
    pub requires_write: bool,
}

/// 工具执行上下文：由 host 在每次调用时构造。
#[derive(Debug, Clone)]
pub struct ToolContext {
    /// 调用方：'user'（GUI 对话）或 'agent'（外部 Agent 网关）。
    pub actor: String,
    /// 会话 generation（用于 Core::post_in_session 等需要 generation 的调用）。
    pub generation: u64,
    /// 授权范围（由 config.scope() 计算，网盘根 + 本地读写根 + 写模式）。
    pub scope: crate::config::ScopeSnapshot,
}

/// 工具执行结果：Ok(Value) 直接回给模型；Err(AgentToolError) 统一序列化。
pub type ToolResult = Result<Value, AgentToolError>;

/// 工具注册表：gateway 与 chat 共用的最小接口。
pub trait ToolRegistry: Send + Sync {
    /// 全部工具定义（按固定顺序，保证 openAiTools 输出稳定）。
    fn tools(&self) -> Vec<ToolDef>;
    /// 执行一个工具调用。name 不存在时返回 INVALID_ARG。
    fn call_tool(&self, ctx: &ToolContext, name: &str, args: &Value) -> ToolResult;
}

/// 把 AgentToolError 统一转成给模型/调用方的 JSON 载荷。
pub fn error_payload(e: &AgentToolError) -> Value {
    json!({ "error": e.to_json() })
}
