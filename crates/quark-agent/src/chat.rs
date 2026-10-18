//! 对话引擎：把用户的话交给大模型，让模型通过**既有的 Agent 工具**操作用户的网盘。
//!
//! 与 qck `src/main/agent/chat.js` 逐条对应（规格 §8.2–8.4）。
//!
//! 设计要点
//! 1. 「大脑」在用户自己的大模型服务上（OpenAI 兼容的 `/chat/completions`），客户端不内置模型。
//! 2. 模型能做的事**完全等于** MCP 外部 Agent 能做的事：都走同一份 `ToolRegistry`、
//!    同一套范围校验、同一份操作记录。对话界面不绕过任何授权检查。
//! 3. 工具结果在送给模型之前**先脱敏再截断**（带签名的直链、Cookie、token 不会外泄给第三方服务）；
//!    顺序不可反 —— 先截断会把敏感值切一半留在上下文里，再脱敏就找不到完整形态了。
//! 4. 非流式请求 + 进度事件：每次工具调用都会向界面推送事件，用户能看到"正在做什么"，
//!    而不必等整轮结束。这样实现比流式解析 SSE 可靠得多，且失败时错误位置清晰。
//! 5. 轮次上限（`maxRounds`，默认 8）、单轮工具数上限（8）与总时长上限（10 分钟），
//!    避免模型陷入无限工具循环（规格 §12.5 第 32 条：被丢弃的调用必须补 tool 响应，
//!    否则下一轮请求会被真实 OpenAI 兼容接口以 400 拒收）。

use crate::chat_config::{ChatConfig, ChatConfigManager};
use crate::gateway::ConfigSource;
use crate::journal::Journal;
use crate::policy::{AgentError, AgentToolError};
use crate::registry::{ToolContext, ToolRegistry};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use std::time::{Duration, Instant};

/// 单个工具结果送给模型前的字符上限（约 5k token），避免一次列表把上下文撑爆。
pub const MAX_TOOL_RESULT_CHARS: usize = 20_000;
/// 单条工具描述的上限，防止工具清单本身过大。
pub const MAX_TOOL_DESC_CHARS: usize = 900;
/// 保留的历史消息条数上限（超出后从最早的一轮开始丢）。
pub const MAX_HISTORY_MESSAGES: usize = 60;
/// 单次 send 的总时长上限。
pub const TOTAL_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// 单轮工具调用数上限（qck 硬编码 `calls.slice(0, 8)`）。
pub const MAX_TOOL_CALLS_PER_ROUND: usize = 8;
/// 单条用户消息上限（字符）。
pub const MAX_INPUT_CHARS: usize = 8_000;
/// 被丢弃的工具调用必须补的 tool 响应内容（qck `OVERFLOW_NOTE`）。
pub const OVERFLOW_NOTE: &str = "（本条未执行：单轮工具调用数已达上限，请减少一次请求的工具数量）";
/// 结果截断时附加的说明（qck 原文）。
const TRUNCATED_NOTE: &str = "…（结果过长，已截断；如需完整内容请缩小查询范围）";

/// 进度事件回调：主进程用于推送到界面。默认空操作。
///
/// 按值传递事件对象（与 qck `onEvent(event)` 的对象语义一致）：事件本身很小，
/// 且回调可能把事件移动到 IPC 通道，借用形式反而迫使调用方再克隆一次。
pub type EventCallback = StdArc<dyn Fn(Value) + Send + Sync>;

/// 一次 send 的结果（qck send 的返回对象）。
#[derive(Debug, Clone)]
pub struct SendOutcome {
    pub reply: String,
    pub rounds: u32,
    pub tool_calls: Vec<Value>,
    /// `None` 表示模型自行收敛；`Some("max_rounds")` 表示达到轮次上限。
    pub stopped: Option<String>,
    pub ms: u64,
}

impl SendOutcome {
    pub fn to_json(&self) -> Value {
        let mut out = json!({
            "reply": self.reply,
            "rounds": self.rounds,
            "toolCalls": self.tool_calls,
            "ms": self.ms,
        });
        if let Some(stopped) = &self.stopped {
            out["stopped"] = json!(stopped);
        }
        out
    }
}

struct ChatState {
    /// 与模型交互的消息序列（OpenAI 格式）。
    messages: Vec<Value>,
    /// 给界面看的历史（用户可读，不含工具原始结果）。
    transcript: Vec<Value>,
    last_error: String,
}

impl Default for ChatState {
    fn default() -> Self {
        Self { messages: Vec::new(), transcript: Vec::new(), last_error: String::new() }
    }
}

/// busy 标志的 RAII 复位（避免每个错误分支手写复位而漏掉）。
struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 内置对话引擎。
///
/// 注意：`new()` 会创建 [`reqwest::Client`]；请在 tokio 运行时内构造与使用
/// （src-tauri 的接线发生在运行时里，测试同样在 `#[tokio::test]` 内构造）。
pub struct AgentChat {
    source: StdArc<dyn ConfigSource>,
    registry: StdArc<dyn ToolRegistry>,
    config: StdArc<ChatConfigManager>,
    journal: Option<StdArc<Journal>>,
    /// 复用同一个 Client（连接池/超时配置不再每次重建）。
    client: reqwest::Client,
    state: StdMutex<ChatState>,
    busy: AtomicBool,
}

impl AgentChat {
    pub fn new(
        source: StdArc<dyn ConfigSource>,
        registry: StdArc<dyn ToolRegistry>,
        config: StdArc<ChatConfigManager>,
        journal: Option<StdArc<Journal>>,
    ) -> Self {
        Self {
            source,
            registry,
            config,
            journal,
            // 不用环境变量里的 HTTP(S)_PROXY：API Key 会随 Authorization 头经代理转发，
            // 而 qck（Electron/Chromium fetch）对本机回环同样直连。用户本机是 TUN 透明代理，
            // 不需要显式代理变量；需要显式代理的场景由宿主提供，不在此处隐式继承。
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            state: StdMutex::new(ChatState::default()),
            busy: AtomicBool::new(false),
        }
    }

    /// 发送一条用户消息，跑完整个工具调用循环。
    pub async fn send(
        &self,
        text: &str,
        on_event: Option<EventCallback>,
    ) -> Result<SendOutcome, AgentToolError> {
        let input = text.trim().to_string();
        if input.is_empty() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "消息不能为空"));
        }
        if input.chars().count() > MAX_INPUT_CHARS {
            return Err(AgentToolError::new(AgentError::InvalidArg, "单条消息过长（上限 8000 字）"));
        }
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(AgentToolError::new(AgentError::Conflict, "上一条消息还在处理中")
                .with_hint("请等待当前回复结束"));
        }
        let _guard = BusyGuard(&self.busy);
        // busy 抢占发生在配置检查之前：与 qck 的检查顺序一致（忙时优先报 CONFLICT）。
        let cfg = self.config.internal();
        if cfg.base_url.is_empty() || cfg.api_key.is_empty() || cfg.model.is_empty() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "尚未配置大模型")
                .with_hint("请在「对话」页面填写 Base URL、API Key 与模型名"));
        }
        {
            let mut st = self.state.lock().unwrap();
            st.last_error.clear();
            st.transcript.push(json!({
                "role": "user",
                "text": input,
                "at": crate::journal::now_ms(),
                "toolCalls": [],
            }));
            if st.messages.is_empty() {
                st.messages.push(system_message(&cfg));
            }
            st.messages.push(json!({ "role": "user", "content": input }));
            trim_history(&mut st.messages);
        }
        let started = Instant::now();
        let mut tool_calls: Vec<Value> = Vec::new();
        match self.run_loop(&cfg, started, &mut tool_calls, on_event.as_ref()).await {
            Ok(outcome) => Ok(outcome),
            Err(e) => {
                {
                    let mut st = self.state.lock().unwrap();
                    st.last_error = e.message.clone();
                    st.transcript.push(json!({
                        "role": "assistant",
                        "text": format!("❌ {}", e.message),
                        "at": crate::journal::now_ms(),
                        "toolCalls": tool_calls,
                        "error": true,
                    }));
                }
                emit(
                    on_event.as_ref(),
                    json!({
                        "type": "error",
                        "code": e.code.as_str(),
                        "message": e.message,
                        "hint": e.hint.clone().unwrap_or_default(),
                    }),
                );
                Err(e)
            }
        }
    }

    /// 工具调用循环（qck send 的 for 循环主体）。
    async fn run_loop(
        &self,
        cfg: &ChatConfig,
        started: Instant,
        tool_calls: &mut Vec<Value>,
        on_event: Option<&EventCallback>,
    ) -> Result<SendOutcome, AgentToolError> {
        let mut round: u32 = 0;
        loop {
            round += 1;
            if round > cfg.max_rounds {
                break;
            }
            emit(on_event, json!({ "type": "round", "round": round, "maxRounds": cfg.max_rounds }));
            let elapsed = started.elapsed().as_millis() as u64;
            // 剩余不足 1 秒就不再发起新请求：总时长上限是硬约束。
            if TOTAL_TIMEOUT_MS.saturating_sub(elapsed) <= 1000 {
                break;
            }
            let remaining = TOTAL_TIMEOUT_MS - elapsed;
            let message = self.call_model(cfg, remaining).await?;
            let calls = message
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if calls.is_empty() {
                // 模型收敛：返回最终文本。
                let reply = message
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "（模型没有返回内容）".to_string());
                let ms = started.elapsed().as_millis() as u64;
                {
                    let mut st = self.state.lock().unwrap();
                    st.messages.push(json!({ "role": "assistant", "content": reply }));
                    trim_history(&mut st.messages);
                    st.transcript.push(json!({
                        "role": "assistant",
                        "text": reply,
                        "at": crate::journal::now_ms(),
                        "toolCalls": tool_calls.clone(),
                        "rounds": round,
                        "ms": ms,
                    }));
                }
                emit(
                    on_event,
                    json!({
                        "type": "done",
                        "reply": reply,
                        "rounds": round,
                        "toolCalls": tool_calls,
                        "ms": ms,
                    }),
                );
                return Ok(SendOutcome {
                    reply,
                    rounds: round,
                    tool_calls: tool_calls.clone(),
                    stopped: None,
                    ms,
                });
            }

            // 模型这一轮可能同时给出说明文本与工具调用，先把说明文本推给界面。
            if let Some(note) = message
                .get("content")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                emit(on_event, json!({ "type": "assistant_note", "text": note }));
            }

            // 回填 assistant 消息：tool_calls 的 id 必须与后续 tool 响应一一对应。
            // 无 function.name 的调用直接丢弃：回填 name:null 会被严格 OpenAI 兼容服务
            // 整轮 400，之后每轮都 400 直到上限、对话无法自愈。
            let normalized_calls: Vec<Value> = calls
                .iter()
                .filter_map(|c| {
                    let name = c
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                        .filter(|n| !n.trim().is_empty())?;
                    let function = c.get("function");
                    let arguments = function
                        .and_then(|f| f.get("arguments"))
                        .cloned()
                        .filter(|v| !is_falsy(v))
                        .unwrap_or_else(|| json!("{}"));
                    Some(json!({
                        "id": c.get("id").cloned().unwrap_or(Value::Null),
                        "type": "function",
                        "function": { "name": name, "arguments": arguments },
                    }))
                })
                .collect();
            {
                let mut assistant = serde_json::Map::new();
                assistant.insert("role".into(), json!("assistant"));
                // qck：`content: message.content || ''` —— null/false/空串/0 都归一为空串，
                // 否则 OpenAI 兼容接口会因 content 为 null 而 400。
                assistant.insert(
                    "content".into(),
                    message
                        .get("content")
                        .cloned()
                        .filter(|v| !is_falsy(v))
                        .unwrap_or_else(|| json!("")),
                );
                // 全部调用因缺 name 被丢弃时不写 tool_calls 键：空数组同样会被严格服务拒绝。
                if !normalized_calls.is_empty() {
                    assistant.insert("tool_calls".into(), json!(normalized_calls));
                }
                self.state
                    .lock()
                    .unwrap()
                    .messages
                    .push(Value::Object(assistant));
            }

            // 单轮工具数量上限：防止一次返回几十个调用把上游打爆。
            let mut records: Vec<Value> = Vec::new();
            // 与 normalized_calls 同一 filter：无 function.name 的调用既不回填也不执行/补
            // tool 响应——否则会产生引用不存在 tool_call_id 的"孤儿 tool 消息"，严格
            // OpenAI 兼容服务下一轮整条 400 无法自愈。
            let executable_calls: Vec<&Value> = calls
                .iter()
                .filter(|c| {
                    c.get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                        .map(|n| !n.trim().is_empty())
                        .unwrap_or(false)
                })
                .collect();
            for call in executable_calls.iter().take(MAX_TOOL_CALLS_PER_ROUND) {
                let name = tool_call_name(call);
                let args_raw = call
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .cloned()
                    .unwrap_or_else(|| json!("{}"));
                let args_preview = preview_args(&args_raw);
                emit(
                    on_event,
                    json!({
                        "type": "tool_start",
                        "name": name,
                        "title": "",
                        "args": args_preview,
                        "callId": call.get("id").cloned().unwrap_or(Value::Null),
                    }),
                );
                let t0 = Instant::now();
                let outcome = self.run_tool(&name, &args_raw).await;
                let ms = t0.elapsed().as_millis() as u64;
                let (ok, packed, summary) = match outcome {
                    Ok(payload) => {
                        let packed = pack_tool_result(&payload);
                        let summary = summarize_payload(&payload);
                        (true, packed, summary)
                    }
                    Err(err) => {
                        let message = if err.message.is_empty() {
                            "调用失败".to_string()
                        } else {
                            err.message.clone()
                        };
                        (false, pack_tool_error(&err), message)
                    }
                };
                let record = json!({
                    "name": name,
                    "title": "",
                    "ok": ok,
                    "ms": ms,
                    "summary": summary,
                    "args": args_preview,
                });
                records.push(record.clone());
                let mut end_event = record;
                end_event["type"] = json!("tool_end");
                emit(on_event, end_event);
                let call_id = call.get("id").and_then(|v| v.as_str()).map(|x| x.to_string());
                self.state
                    .lock()
                    .unwrap()
                    .messages
                    .push(tool_message(call_id.as_deref(), &name, packed));
            }
            // ⚠️ 被丢弃的调用**必须**补一条 tool 响应：OpenAI 兼容接口要求
            // assistant.tool_calls 里每一条都有对应的 role:'tool' 消息，缺一条下一轮请求直接 400
            // （qck 测试实测抓出：保留 20 条 tool_calls 只回 8 条 tool 消息）。
            for call in executable_calls.iter().skip(MAX_TOOL_CALLS_PER_ROUND) {
                let call_id = call.get("id").and_then(|v| v.as_str()).map(|x| x.to_string());
                self.state.lock().unwrap().messages.push(tool_message(
                    call_id.as_deref(),
                    &tool_call_name(call),
                    json!({
                        "ok": false,
                        "error": { "code": AgentError::Limit.as_str(), "message": OVERFLOW_NOTE },
                    })
                    .to_string(),
                ));
            }
            tool_calls.extend(records);
            {
                let mut st = self.state.lock().unwrap();
                trim_history(&mut st.messages);
            }
        }

        // 达到轮次上限仍未收敛。
        let reply = format!(
            "已达到本轮工具调用上限（{} 次），先停在这里。你可以让我继续，或缩小任务范围重试。",
            cfg.max_rounds
        );
        let ms = started.elapsed().as_millis() as u64;
        {
            let mut st = self.state.lock().unwrap();
            st.messages.push(json!({ "role": "assistant", "content": reply }));
            st.transcript.push(json!({
                "role": "assistant",
                "text": reply,
                "at": crate::journal::now_ms(),
                "toolCalls": tool_calls.clone(),
                "stopped": "max_rounds",
                "ms": ms,
            }));
        }
        emit(
            on_event,
            json!({
                "type": "done",
                "reply": reply,
                "rounds": cfg.max_rounds,
                "toolCalls": tool_calls,
                "stopped": "max_rounds",
                "ms": ms,
            }),
        );
        Ok(SendOutcome {
            reply,
            rounds: cfg.max_rounds,
            tool_calls: tool_calls.clone(),
            stopped: Some("max_rounds".to_string()),
            ms,
        })
    }

    /// 发起一次模型请求，返回 `choices[0].message`。
    async fn call_model(
        &self,
        cfg: &ChatConfig,
        remaining_ms: u64,
    ) -> Result<Value, AgentToolError> {
        let messages = self.state.lock().unwrap().messages.clone();
        self.call_model_with(cfg, &messages, remaining_ms).await
    }

    /// 用指定消息序列发起一次模型请求（探测/测试连接与正式对话共用同一条请求路径）。
    async fn call_model_with(
        &self,
        cfg: &ChatConfig,
        messages: &[Value],
        remaining_ms: u64,
    ) -> Result<Value, AgentToolError> {
        if cfg.base_url.is_empty() || cfg.api_key.is_empty() || cfg.model.is_empty() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "尚未配置大模型")
                .with_hint("请在「对话」页面填写 Base URL、API Key 与模型名"));
        }
        let timeout_ms = remaining_ms.min(cfg.timeout_ms).max(1000);
        let body = json!({
            "model": cfg.model,
            "messages": messages,
            "tools": self.openai_tools(),
            "tool_choice": "auto",
            "temperature": cfg.temperature,
            // 非流式：比解析 SSE 可靠，失败时错误位置清晰；进度靠事件推送。
            "stream": false,
        });
        let response = self
            .client
            .post(endpoint_for(&cfg.base_url))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", cfg.api_key))
            .timeout(Duration::from_millis(timeout_ms))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                let hint = "请检查 Base URL、网络和代理设置";
                if e.is_timeout() {
                    let secs = ((timeout_ms as f64) / 1000.0).round() as u64;
                    AgentToolError::new(
                        AgentError::Upstream,
                        format!("大模型请求超时（{secs} 秒）"),
                    )
                    .with_hint(hint)
                } else {
                    AgentToolError::new(AgentError::Upstream, format!("无法连接大模型：{e}"))
                        .with_hint(hint)
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            // 错误响应里通常含服务端说明（例如 key 无效、模型名不存在），带给用户便于排查。
            let detail = response.text().await.unwrap_or_default();
            let detail: String = detail.chars().take(500).collect();
            let code = if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                AgentError::Unauthorized
            } else {
                AgentError::Upstream
            };
            let hint = if detail.trim().is_empty() {
                "请检查 API Key、模型名与账户额度".to_string()
            } else {
                sanitize_text(&detail)
            };
            return Err(
                AgentToolError::new(code, format!("大模型返回 HTTP {}", status.as_u16()))
                    .with_hint(hint),
            );
        }
        let json: Value = response.json().await.map_err(|_| {
            AgentToolError::new(AgentError::Upstream, "大模型返回的内容不是合法 JSON")
        })?;
        let message = json
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|c| c.get("message"));
        let Some(message) = message else {
            return Err(AgentToolError::new(
                AgentError::Upstream,
                "大模型返回结构不符合预期（缺少 choices[0].message）",
            )
            .with_hint("确认 Base URL 指向兼容 OpenAI 的接口"));
        };
        let has_content = message.get("content").map(|v| v.is_string()).unwrap_or(false);
        let has_calls = message.get("tool_calls").map(|v| v.is_array()).unwrap_or(false);
        if !has_content && !has_calls {
            return Err(AgentToolError::new(
                AgentError::Upstream,
                "大模型返回结构不符合预期（缺少 choices[0].message）",
            )
            .with_hint("确认 Base URL 指向兼容 OpenAI 的接口"));
        }
        Ok(message.clone())
    }

    /// 执行一次工具调用（与外部 Agent 走**完全相同**的路径：同一 registry、同一范围校验）。
    ///
    /// 早退分支返回 `Err(AgentToolError)`（而不是把错误塞进 payload）：
    /// 上层统一用 [`pack_tool_error`] 打包，这样 code/hint 才不会丢。
    async fn run_tool(&self, name: &str, raw_args: &Value) -> Result<Value, AgentToolError> {
        let tools = self.registry.tools();
        let tool_name = match tools.iter().find(|t| t.name == name) {
            Some(t) => t.name,
            None => {
                return Err(AgentToolError::new(
                    AgentError::NotFound,
                    format!("没有名为 {name} 的工具"),
                ))
            }
        };
        let mut args = raw_args.clone();
        if let Some(s) = args.as_str() {
            let text = if s.trim().is_empty() { "{}" } else { s };
            match serde_json::from_str::<Value>(text) {
                Ok(v) => args = v,
                Err(_) => {
                    return Err(AgentToolError::new(
                        AgentError::InvalidArg,
                        "工具参数不是合法 JSON",
                    ))
                }
            }
        }
        if !args.is_object() {
            return Err(AgentToolError::new(AgentError::InvalidArg, "工具参数必须是对象"));
        }
        let started = Instant::now();
        let ctx = ToolContext {
            // 对话路径的 actor 固定 'chat'（qck `tool.handler(args, {signal, source:'chat'})` + 审计 actor:'chat'）。
            actor: "chat".to_string(),
            generation: self.source.generation(),
            scope: self.source.scope(),
        };
        let result = self.registry.call_tool(&ctx, tool_name, &args).await;
        let ms = started.elapsed().as_millis() as u64;
        let args_summary = summarize_args_chat(&args);
        match result {
            Ok(v) => {
                self.audit(
                    "tool_call",
                    tool_name,
                    "chat",
                    "ok",
                    &json!({ "ms": ms, "args": args_summary }),
                );
                // qck：result === undefined ? {ok:true} : result。
                if v.is_null() {
                    Ok(json!({ "ok": true }))
                } else {
                    Ok(v)
                }
            }
            Err(e) => {
                // 工具失败不让整条消息失败：错误会被打包成 tool 消息让模型自我纠正。
                self.audit(
                    "tool_call",
                    tool_name,
                    "chat",
                    "error",
                    &json!({
                        "ms": ms,
                        "code": e.code.as_str(),
                        "message": e.message,
                        "args": args_summary,
                    }),
                );
                Err(e)
            }
        }
    }

    fn audit(&self, kind: &str, tool: &str, actor: &str, result: &str, detail: &Value) {
        if let Some(journal) = &self.journal {
            // 审计失败不能影响对话本身（Journal::append 本身静默，但保持与 qck 一致的边界）。
            journal.append(kind, tool, actor, result, &Value::Null, detail);
        }
    }

    /// 工具清单 → OpenAI `tools` 格式（19+1 个工具全量交给模型）。
    ///
    /// qck 的 description 是 `[title, description].filter(Boolean).join('：')`；
    /// Rust 的 [`crate::registry::ToolDef`] 没有 title 字段，直接使用 description
    /// （宿主接线时把中文标题写进 description 即可保持模型可读性）。
    fn openai_tools(&self) -> Vec<Value> {
        self.registry
            .tools()
            .iter()
            .map(|t| {
                let mut description = t.description.to_string();
                if description.chars().count() > MAX_TOOL_DESC_CHARS {
                    description = format!(
                        "{}…",
                        description.chars().take(MAX_TOOL_DESC_CHARS).collect::<String>()
                    );
                }
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": description,
                        "parameters": t.parameters,
                    },
                })
            })
            .collect()
    }

    /// 配置自检：发一条最小请求，确认 URL / Key / 模型名都能用。
    ///
    /// 探测只用**自己的局部消息数组**，不写对话历史、不污染内部 messages
    /// （qck 早期临时替换模块级 messages，结果把探测消息插进真实对话 —— 规格 §12.5 第 34 条）。
    pub async fn test_connection(&self) -> Result<Value, AgentToolError> {
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(AgentToolError::new(
                AgentError::Conflict,
                "对话进行中，请等这条回复结束后再测试连接",
            ));
        }
        let _guard = BusyGuard(&self.busy);
        let cfg = self.config.internal();
        let probe = vec![
            system_message(&cfg),
            json!({ "role": "user", "content": "回复两个字：可用" }),
        ];
        let message = self.call_model_with(&cfg, &probe, cfg.timeout_ms.min(30_000)).await?;
        let text = message
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let reply = if text.is_empty() {
            "（无文本内容，但接口可用）".to_string()
        } else {
            text.chars().take(80).collect()
        };
        Ok(json!({ "ok": true, "model": cfg.model, "reply": reply }))
    }

    /// 拉取模型列表（OpenAI 兼容的 `GET <base>/models`）。
    ///
    /// **必须先保存配置**（至少 baseUrl + apiKey）才能拉取 —— Key 只存在加密存储里，
    /// 界面传不进来，也传不出去。宽容解析 `data[].id`（缺 data 时按顶层数组处理）并去重排序。
    pub async fn list_models(&self) -> Result<Value, AgentToolError> {
        let cfg = self.config.internal();
        if cfg.base_url.is_empty() || cfg.api_key.is_empty() {
            return Err(AgentToolError::new(
                AgentError::InvalidArg,
                "请先填写并保存 Base URL 与 API Key，再获取模型列表",
            ));
        }
        let base = cfg.base_url.trim_end_matches('/');
        let url = if base.ends_with("/models") {
            base.to_string()
        } else {
            format!("{base}/models")
        };
        let response = self
            .client
            .get(&url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", cfg.api_key))
            .timeout(Duration::from_millis(20_000))
            .send()
            .await
            .map_err(|e| {
                let hint = "请检查 Base URL 与网络";
                if e.is_timeout() {
                    AgentToolError::new(AgentError::Upstream, "获取模型列表超时").with_hint(hint)
                } else {
                    AgentToolError::new(AgentError::Upstream, format!("无法连接模型服务：{e}"))
                        .with_hint(hint)
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();
            let detail: String = detail.chars().take(300).collect();
            let code = if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                AgentError::Unauthorized
            } else {
                AgentError::Upstream
            };
            let hint = if detail.trim().is_empty() {
                "请检查 API Key 是否正确".to_string()
            } else {
                sanitize_text(&detail)
            };
            return Err(
                AgentToolError::new(code, format!("获取模型列表失败（HTTP {}）", status.as_u16()))
                    .with_hint(hint),
            );
        }
        let json: Value = response.json().await.map_err(|_| {
            AgentToolError::new(AgentError::Upstream, "模型列表响应不是合法 JSON")
        })?;
        let arr = if let Some(a) = json.as_array() {
            a.clone()
        } else {
            json.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default()
        };
        let mut seen: HashSet<String> = HashSet::new();
        let mut models: Vec<String> = Vec::new();
        for item in arr {
            let id = match &item {
                Value::String(s) => s.clone(),
                Value::Object(o) => {
                    o.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
                }
                _ => String::new(),
            };
            let trimmed = id.trim().to_string();
            if trimmed.is_empty() || !seen.insert(trimmed.clone()) {
                continue;
            }
            models.push(trimmed);
        }
        models.sort();
        Ok(json!({ "models": models, "count": models.len() }))
    }

    /// 状态：配置快照 + 运行态 + 授权范围摘要（只回数量，不回具体路径）。
    pub fn status(&self) -> Value {
        let (last_error, history_count) = {
            let st = self.state.lock().unwrap();
            (st.last_error.clone(), st.transcript.len())
        };
        let scope = self.source.scope();
        let mut out = self.config.snapshot();
        out["running"] = json!(self.busy.load(Ordering::SeqCst));
        out["lastError"] = json!(last_error);
        out["historyCount"] = json!(history_count);
        out["toolCount"] = json!(self.registry.tools().len());
        out["scope"] = json!({
            "writeMode": scope.write_mode,
            "remoteRootCount": scope.remote_roots.len(),
            "localWriteRootCount": scope.local_write_roots.len(),
        });
        out
    }

    /// 界面历史（最近 `limit` 条，默认 100，clamp 1..500）。
    pub fn history(&self, limit: Option<usize>) -> Vec<Value> {
        // qck: `Math.max(1, Math.min(500, Number(limit) || 100))` —— 0/缺失都回落到 100。
        let n = match limit {
            None | Some(0) => 100,
            Some(n) => n.clamp(1, 500),
        };
        let st = self.state.lock().unwrap();
        let start = st.transcript.len().saturating_sub(n);
        st.transcript[start..].to_vec()
    }

    /// 清空对话（内部消息 + 界面历史 + 最近错误）。
    pub fn clear(&self) -> Value {
        let mut st = self.state.lock().unwrap();
        st.messages.clear();
        st.transcript.clear();
        st.last_error.clear();
        json!({ "ok": true })
    }
}

// ---------------------------------------------------------------------------
// 纯函数（可独立单测）
// ---------------------------------------------------------------------------

/// OpenAI 兼容端点拼接：兼容用户直接填到 `/chat/completions` 的情况（不重复拼接）。
pub fn endpoint_for(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn system_message(cfg: &ChatConfig) -> Value {
    json!({
        "role": "system",
        "content": format!(
            "{}\n（授权范围由客户端在每次工具调用时强制校验，你无法绕过。）",
            cfg.system_prompt
        ),
    })
}

/// 历史裁剪：总是保留 system，且从"用户消息"处切开，保证 tool 消息与其 tool_calls 配对完整。
///
/// 为什么必须从 user 边界切：assistant(tool_calls) 与紧随其后的 tool 响应是一组；
/// 若按条数硬切，可能切出"有 tool 响应、没有调用声明"的残段，下一轮请求会被真实
/// OpenAI 兼容接口以 400 拒收（规格 §12.5 第 33 条）。
fn trim_history(messages: &mut Vec<Value>) {
    if messages.len() <= MAX_HISTORY_MESSAGES {
        return;
    }
    let head_len = if messages
        .first()
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        == Some("system")
    {
        1
    } else {
        0
    };
    let mut rest: Vec<Value> = messages.split_off(head_len);
    while rest.len() > MAX_HISTORY_MESSAGES - head_len - 1 {
        // 找到下一个 user 消息作为新的起点（i > 0 保证至少保留一条）。
        let idx = rest
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, m)| m.get("role").and_then(|r| r.as_str()) == Some("user"))
            .map(|(i, _)| i);
        match idx {
            Some(i) if i > 0 => {
                rest.drain(0..i);
            }
            _ => break,
        }
    }
    // messages 此时只剩 head（可能为空），拼回裁剪后的 rest。
    messages.extend(rest);
}

fn is_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !*b,
        Value::String(s) => s.is_empty(),
        Value::Number(n) => n.as_f64().map(|f| f == 0.0).unwrap_or(false),
        _ => false,
    }
}

fn tool_call_name(call: &Value) -> String {
    call.get("function")
        .and_then(|f| f.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 事件里的参数预览：字符串截 400 加省略号，对象原样（qck `argsPreview` 语义）。
fn preview_args(raw: &Value) -> Value {
    match raw {
        Value::String(s) if s.chars().count() > 400 => {
            json!(format!("{}…", s.chars().take(400).collect::<String>()))
        }
        other => other.clone(),
    }
}

/// 工具结果打包成模型可读文本：**先脱敏（journal::redact）再截断**。
///
/// 这一步是必须的：工具结果里可能带夸克的签名下载直链或会话参数，
/// 它们不应该被发送到第三方大模型服务，也不该留在对话上下文里。
/// 体积截断统一由 [`MAX_TOOL_RESULT_CHARS`] 负责（journal 的 sanitize 是给日志用的 600 字符版，
/// 会把 JSON 切成非法文本，模型永远拿不到完整列表）。
/// role:'tool' 消息。id 缺失时省略 tool_call_id 字段（qck 语义：undefined 被
/// JSON.stringify 丢弃；显式 null 会被严格 OpenAI 兼容服务拒绝为 400）。
fn tool_message(tool_call_id: Option<&str>, name: &str, content: String) -> Value {
    #![allow(clippy::needless_pass_by_value)]
    let mut obj = serde_json::Map::new();
    obj.insert("role".into(), json!("tool"));
    if let Some(id) = tool_call_id {
        obj.insert("tool_call_id".into(), json!(id));
    }
    obj.insert("name".into(), json!(name));
    obj.insert("content".into(), json!(content));
    Value::Object(obj)
}

pub fn pack_tool_result(payload: &Value) -> String {
    let redacted = crate::journal::redact(payload);
    let mut text = match &redacted {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| other.to_string()),
    };
    if text.chars().count() > MAX_TOOL_RESULT_CHARS {
        let head: String = text.chars().take(MAX_TOOL_RESULT_CHARS).collect();
        text = format!("{head}\n{TRUNCATED_NOTE}");
    }
    text
}

/// 工具失败时送给模型的结构化说明（保留 code/hint，让模型能解释原因）。
pub fn pack_tool_error(err: &AgentToolError) -> String {
    // raw_code（白名单上游语义）优先：模型据此判断是否该提示重新登录。
    let code_out = err
        .raw_code
        .clone()
        .unwrap_or_else(|| err.code.as_str().to_string());
    let mut error = json!({ "code": code_out, "message": err.message });
    if let Some(hint) = &err.hint {
        error["hint"] = json!(hint);
    }
    if let Some(detail) = &err.upstream_message {
        error["detail"] = json!(detail);
    }
    pack_tool_result(&json!({ "ok": false, "error": error }))
}

/// `tool_end` 事件的摘要：压平空白后截 160 字符。
fn summarize_payload(payload: &Value) -> String {
    let packed = pack_tool_result(payload);
    let collapsed: String = packed.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 160 {
        format!("{}…", collapsed.chars().take(160).collect::<String>())
    } else {
        collapsed
    }
}

/// 对话审计的 args 摘要：JSON 串截 300 字符（qck chat 版 summarizeArgs）。
fn summarize_args_chat(args: &Value) -> Value {
    let text = serde_json::to_string(args).unwrap_or_else(|_| "(无法序列化)".to_string());
    if text.chars().count() > 300 {
        json!(format!("{}…", text.chars().take(300).collect::<String>()))
    } else {
        json!(text)
    }
}

/// 面向提示文本的脱敏：复用 journal 的字符串脱敏规则（截断 600），返回纯文本。
fn sanitize_text(text: &str) -> String {
    match crate::journal::sanitize(&Value::String(text.to_string())) {
        Value::String(s) => s,
        other => other.to_string(),
    }
}

fn emit(cb: Option<&EventCallback>, event: Value) {
    if let Some(cb) = cb {
        // 回调（宿主 emit_to 包装）panic 不应炸掉整次对话/调用：
        // 隔离在 catch_unwind 内，事件丢失优于整个 qk_call 失败。
        let prev = std::panic::take_hook();
        std::panic::set_hook(std::boxed::Box::new(|_| {}));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(event)));
        std::panic::set_hook(prev);
        if result.is_err() {
            eprintln!("[agent] 对话事件回调 panic（已隔离）");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_config::ChatConfigManager;
    use crate::config::ScopeSnapshot;
    use crate::registry::{ToolDef, ToolResult};
    use serde_json::json;
    use std::collections::HashMap;
    use std::collections::VecDeque;
    use std::future::Future;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::pin::Pin;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    // -----------------------------------------------------------------------
    // 假 OpenAI 兼容端点（本地 std TcpListener，绝不访问外网）
    // -----------------------------------------------------------------------

    #[derive(Debug, Clone)]
    struct Recorded {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body: Value,
    }

    enum Scripted {
        Json(Value),
        Http { status: u16, body: String },
        Raw(String),
    }

    struct FakeLlm {
        base_url: String,
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<Recorded>>>,
        script: Arc<Mutex<VecDeque<Scripted>>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    fn read_http_request(stream: &mut TcpStream) -> Option<Recorded> {
        let mut data: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => return None,
                Ok(n) => {
                    data.extend_from_slice(&buf[..n]);
                    if data.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(_) => return None,
            }
            if data.len() > 1 << 20 {
                return None;
            }
        }
        let header_end = data.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
        let head = String::from_utf8_lossy(&data[..header_end]).to_string();
        let mut lines = head.split("\r\n");
        let mut request_line = lines.next()?.split_whitespace();
        let method = request_line.next()?.to_string();
        let path = request_line.next()?.to_string();
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }
        let content_length: usize = headers
            .get("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        while data.len() < header_end + content_length {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => data.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
        let body_bytes = &data[header_end..(header_end + content_length).min(data.len())];
        let body = if body_bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(body_bytes).unwrap_or(Value::Null)
        };
        Some(Recorded { method, path, headers, body })
    }

    fn write_http_response(stream: &mut TcpStream, status: u16, body: &str) {
        let reason = match status {
            200 => "OK",
            401 => "Unauthorized",
            403 => "Forbidden",
            500 => "Internal Server Error",
            _ => "Status",
        };
        let head = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body.as_bytes());
        let _ = stream.flush();
    }

    impl FakeLlm {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("绑定本地端口");
            listener.set_nonblocking(true).expect("nonblocking");
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let script = Arc::new(Mutex::new(VecDeque::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let thread = {
                let requests = requests.clone();
                let script = script.clone();
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(Ordering::SeqCst) {
                        match listener.accept() {
                            Ok((mut stream, _)) => {
                                let _ = stream.set_nonblocking(false);
                                if let Some(recorded) = read_http_request(&mut stream) {
                                    requests.lock().unwrap().push(recorded);
                                }
                                let scripted = script
                                    .lock()
                                    .unwrap()
                                    .pop_front()
                                    .unwrap_or(Scripted::Http {
                                        status: 500,
                                        body: "{\"error\":\"no scripted response\"}".to_string(),
                                    });
                                match scripted {
                                    Scripted::Json(v) => {
                                        write_http_response(&mut stream, 200, &v.to_string())
                                    }
                                    Scripted::Http { status, body } => {
                                        write_http_response(&mut stream, status, &body)
                                    }
                                    Scripted::Raw(raw) => write_http_response(&mut stream, 200, &raw),
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(5));
                            }
                            Err(_) => break,
                        }
                    }
                })
            };
            Self {
                base_url: format!("http://127.0.0.1:{}/v1", addr.port()),
                addr,
                requests,
                script,
                stop,
                thread: Some(thread),
            }
        }

        fn push(&self, response: Scripted) {
            self.script.lock().unwrap().push_back(response);
        }

        fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for FakeLlm {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // 唤醒阻塞在 accept 的线程（nonblocking + sleep 轮询，这里只是尽快退出）。
            let _ = TcpStream::connect(self.addr);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    // -----------------------------------------------------------------------
    // 假工具注册表与配置源
    // -----------------------------------------------------------------------

    #[derive(Clone)]
    struct MockSource {
        scope: ScopeSnapshot,
    }

    impl ConfigSource for MockSource {
        fn access(&self) -> crate::gateway::AccessSnapshot {
            crate::gateway::AccessSnapshot { enabled: true, token: "tok".into() }
        }
        fn scope(&self) -> ScopeSnapshot {
            self.scope.clone()
        }
        fn generation(&self) -> u64 {
            3
        }
    }

    struct ChatRegistry {
        directive: Mutex<Value>,
    }

    impl ToolRegistry for ChatRegistry {
        fn tools(&self) -> Vec<ToolDef> {
            vec![
                ToolDef {
                    name: "list_dir",
                    description: "列出目录内容",
                    parameters: json!({
                        "type": "object",
                        "properties": { "pdir_fid": { "type": "string" } },
                    }),
                    requires_write: false,
                },
                ToolDef {
                    name: "fail_tool",
                    description: "总是失败的工具",
                    parameters: json!({ "type": "object", "properties": {} }),
                    requires_write: false,
                },
            ]
        }

        fn call_tool<'a>(
            &'a self,
            ctx: &'a ToolContext,
            name: &'a str,
            _args: &'a Value,
        ) -> Pin<Box<dyn Future<Output = ToolResult> + Send + 'a>> {
            Box::pin(async move {
                match name {
                    "list_dir" => {
                        let mut v = self.directive.lock().unwrap().clone();
                        if let Some(obj) = v.as_object_mut() {
                            obj.insert("actor".into(), json!(ctx.actor));
                            obj.insert("generation".into(), json!(ctx.generation));
                        }
                        Ok(v)
                    }
                    "fail_tool" => Err(AgentToolError::new(
                        AgentError::ReadOnly,
                        "目录只读，不能写入",
                    )
                    .with_hint("请在客户端把该目录改为「可读写」")),
                    _ => Err(AgentToolError::new(
                        AgentError::InvalidArg,
                        format!("未知工具：{name}"),
                    )),
                }
            })
        }
    }

    struct ChatFixture {
        _tmp: TempDir,
        chat: AgentChat,
        llm: FakeLlm,
        config: Arc<ChatConfigManager>,
        journal: Arc<Journal>,
        events: Arc<Mutex<Vec<Value>>>,
    }

    fn event_cb(events: &Arc<Mutex<Vec<Value>>>) -> EventCallback {
        let events = events.clone();
        Arc::new(move |v: Value| events.lock().unwrap().push(v))
    }

    fn new_fixture(tag: &str) -> ChatFixture {
        let tmp = TempDir::new().unwrap();
        let profile = tmp.path().join(tag);
        std::fs::create_dir_all(&profile).unwrap();
        let config = Arc::new(ChatConfigManager::open(&profile).unwrap());
        let journal = Arc::new(Journal::open(&tmp.path().join("journal")).unwrap());
        let source = Arc::new(MockSource {
            scope: ScopeSnapshot {
                remote_roots: vec!["root1".into()],
                write_mode: "read-only".into(),
                local_read_roots: vec![],
                local_write_roots: vec![],
            },
        });
        let registry = Arc::new(ChatRegistry {
            directive: Mutex::new(json!({ "list": [{ "name": "a.txt" }], "hasMore": false })),
        });
        let llm = FakeLlm::start();
        let chat = AgentChat::new(source, registry, config.clone(), Some(journal.clone()));
        let events = Arc::new(Mutex::new(Vec::new()));
        ChatFixture { _tmp: tmp, chat, llm, config, journal, events }
    }

    impl ChatFixture {
        fn configure(&self, max_rounds: u32) {
            self.config
                .update(&json!({
                    "baseUrl": self.llm.base_url,
                    "model": "fake-model",
                    "apiKey": "sk-fake-for-test",
                    "maxRounds": max_rounds,
                }))
                .unwrap();
        }

        fn types(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .map(|e| e["type"].as_str().unwrap_or("").to_string())
                .collect()
        }

        fn events_of(&self, kind: &str) -> Vec<Value> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e["type"] == kind)
                .cloned()
                .collect()
        }
    }

    fn tool_calls_round(calls: Value) -> Scripted {
        Scripted::Json(json!({
            "choices": [{ "message": { "role": "assistant", "content": "", "tool_calls": calls } }],
        }))
    }

    fn final_round(content: &str) -> Scripted {
        Scripted::Json(json!({
            "choices": [{ "message": { "role": "assistant", "content": content } }],
        }))
    }

    fn one_call(id: &str, name: &str, args: &str) -> Value {
        json!({ "id": id, "type": "function", "function": { "name": name, "arguments": args } })
    }

    // -----------------------------------------------------------------------
    // 1. 正常两轮：请求格式 + 工具执行 + 事件序列
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn tool_calls_without_name_are_dropped_everywhere() {
        // 复核 P1：无 function.name 的调用不回填/不执行/不补 tool 响应——
        // 否则产生孤儿 tool 消息，严格 OpenAI 兼容服务下一轮 400 无法自愈。
        let f = new_fixture("no-name-drop");
        f.configure(4);
        f.llm.push(tool_calls_round(json!([
            one_call("c1", "list_dir", "{\"pdir_fid\":\"root1\"}"),
            {"id": "c2", "type": "function", "function": {"name": "", "arguments": "{}"}},
            {"id": "c3", "type": "function", "function": {"arguments": "{}"}},
        ])));
        f.llm.push(final_round("完成"));
        let out = f.chat.send("触发畸形调用", None).await.unwrap();
        // 只执行了 1 个有效调用
        assert_eq!(out.tool_calls.len(), 1, "无 name 调用应被丢弃: {}", serde_json::to_string(&out.tool_calls).unwrap());
        // history 中不应有指向已丢弃 id 的孤儿 tool 消息，assistant.tool_calls 不含空 name
        let st = f.chat.state.lock().unwrap();
        for m in &st.messages {
            if m["role"] == json!("tool") {
                let id = m.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("");
                assert_ne!(id, "c2", "孤儿 tool 消息（c2 无 name 却补了响应）");
                assert_ne!(id, "c3", "孤儿 tool 消息（c3 无 name 却补了响应）");
            }
            if m["role"] == json!("assistant") {
                if let Some(tc) = m.get("tool_calls").and_then(|v| v.as_array()) {
                    for c in tc {
                        let n = c["function"]["name"].as_str().unwrap_or("");
                        assert!(!n.trim().is_empty(), "assistant.tool_calls 不应含空 name: {c}");
                    }
                }
            }
        }
    }

#[tokio::test]
    async fn two_round_flow_asserts_openai_request_shape_and_events() {
        let f = new_fixture("two-round");
        f.configure(4);
        f.llm.push(tool_calls_round(json!([
            one_call("call_1", "list_dir", "{\"pdir_fid\":\"root1\"}"),
        ])));
        f.llm.push(final_round("完成：根目录有 a.txt"));
        let events = event_cb(&f.events);
        let outcome = f
            .chat
            .send("列出根目录", Some(events))
            .await
            .expect("send 应成功");
        assert_eq!(outcome.reply, "完成：根目录有 a.txt");
        assert_eq!(outcome.rounds, 2);
        assert_eq!(outcome.stopped, None);
        assert_eq!(outcome.tool_calls.len(), 1);
        assert_eq!(outcome.tool_calls[0]["name"], "list_dir");
        assert_eq!(outcome.tool_calls[0]["ok"], true);
        assert_eq!(outcome.tool_calls[0]["title"], "");

        let reqs = f.llm.requests();
        assert_eq!(reqs.len(), 2);
        // 请求头：Bearer Key + JSON
        assert_eq!(reqs[0].headers["authorization"], "Bearer sk-fake-for-test");
        assert_eq!(reqs[0].headers["content-type"], "application/json");
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].path, "/v1/chat/completions");
        // 请求体：非流式 + tool_choice auto + 全量工具
        let body = &reqs[0].body;
        assert_eq!(body["model"], "fake-model");
        assert_eq!(body["stream"], false);
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["temperature"], 0.3);
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["function"]["name"], "list_dir");
        assert_eq!(tools[0]["function"]["description"], "列出目录内容");
        assert!(tools[0]["function"]["parameters"].is_object());
        // system 消息带授权提示；用户消息原文
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert!(msgs[0]["content"]
            .as_str()
            .unwrap()
            .contains("授权范围由客户端在每次工具调用时强制校验"));
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "列出根目录");
        // 第二轮：工具响应与 tool_calls 配对；工具上下文 actor=chat / generation 实时
        let msgs2 = reqs[1].body["messages"].as_array().unwrap();
        let last = msgs2.last().unwrap();
        assert_eq!(last["role"], "tool");
        assert_eq!(last["tool_call_id"], "call_1");
        assert_eq!(last["name"], "list_dir");
        assert!(last["content"].as_str().unwrap().contains("\"actor\":\"chat\""));
        assert!(last["content"].as_str().unwrap().contains("\"generation\":3"));
        // 事件序列：round → tool_start → tool_end → round → done
        assert_eq!(
            f.types(),
            vec!["round", "tool_start", "tool_end", "round", "done"]
        );
        let rounds = f.events_of("round");
        assert_eq!(rounds[0]["round"], 1);
        assert_eq!(rounds[0]["maxRounds"], 4);
        assert_eq!(rounds[1]["round"], 2);
        let starts = f.events_of("tool_start");
        assert_eq!(starts[0]["callId"], "call_1");
        assert_eq!(starts[0]["args"], "{\"pdir_fid\":\"root1\"}");
        let ends = f.events_of("tool_end");
        assert_eq!(ends[0]["ok"], true);
        assert!(ends[0]["ms"].is_number());
        assert!(ends[0]["summary"].as_str().unwrap().contains("a.txt"));
        let done = f.events_of("done");
        assert_eq!(done[0]["reply"], "完成：根目录有 a.txt");
        assert_eq!(done[0]["rounds"], 2);
        // transcript 结构：user + assistant（含 rounds/ms）
        let history = f.chat.history(None);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["role"], "user");
        assert_eq!(history[0]["text"], "列出根目录");
        assert_eq!(history[1]["role"], "assistant");
        assert_eq!(history[1]["rounds"], 2);
        // 审计 actor=chat，且不含 API Key
        let rows = f.journal.list(50, None);
        assert!(rows
            .iter()
            .any(|r| r["kind"] == "tool_call" && r["actor"] == "chat" && r["tool"] == "list_dir"));
        assert!(!serde_json::to_string(&rows).unwrap().contains("sk-fake-for-test"));
        // 历史/状态绝不泄漏 Key
        let status_text = serde_json::to_string(&f.chat.status()).unwrap();
        assert!(!status_text.contains("sk-fake-for-test"));
        assert!(!status_text.contains("\"apiKey\""));
    }

    // -----------------------------------------------------------------------
    // 2. 工具结果：先脱敏再截断
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn tool_result_is_redacted_before_truncation() {
        let f = new_fixture("redact-truncate");
        f.configure(4);
        let long_text = "a".repeat(30_000);
        {
            // 直接替换工具返回：含敏感键、签名直链与超长正文
            // 注意 serde_json 默认按字母序序列化对象键：cookie < note < text < url，
            // 因此截断发生在 url 之前是预期行为（正常数据里 URL 也总是被正文挤到后面）；
            // "脱敏标记可见"只在不截断的短结果上断言。
            let registry = Arc::new(ChatRegistry {
                directive: Mutex::new(json!({
                    "cookie": "SID=super-secret",
                    "url": "https://cdn.example.com/f/1?sign=abc&st=9",
                    "note": "保留",
                    "text": long_text,
                })),
            });
            let chat = AgentChat::new(
                Arc::new(MockSource {
                    scope: ScopeSnapshot {
                        remote_roots: vec!["root1".into()],
                        write_mode: "read-only".into(),
                        local_read_roots: vec![],
                        local_write_roots: vec![],
                    },
                }),
                registry,
                f.config.clone(),
                Some(f.journal.clone()),
            );
            f.llm.push(tool_calls_round(json!([
                one_call("c1", "list_dir", "{}"),
            ])));
            f.llm.push(final_round("好"));
            let outcome = chat.send("看看", None).await.unwrap();
            assert_eq!(outcome.reply, "好");
        }
        let reqs = f.llm.requests();
        let tool_msg = reqs[1]
            .body
            .get("messages")
            .and_then(|m| m.as_array())
            .and_then(|a| a.last())
            .cloned()
            .unwrap();
        let content = tool_msg["content"].as_str().unwrap();
        // 敏感键整枝丢弃
        assert!(!content.contains("SID=super-secret"), "cookie 必须被脱敏");
        assert!(!content.contains("sign=abc"), "签名直链必须被脱敏");
        assert!(content.contains("保留"));
        // 截断：前 20000 字 + 说明；正文总长受控
        assert!(content.ends_with(TRUNCATED_NOTE), "应以截断说明结尾");
        assert_eq!(
            content.chars().count(),
            MAX_TOOL_RESULT_CHARS + 1 + TRUNCATED_NOTE.chars().count()
        );
        // 不截断的短结果：签名直链替换标记必须可见（先脱敏再截断的"先"这一步）
        let short_pack = pack_tool_result(&json!({
            "url": "https://cdn.example.com/f/1?sign=abc&st=9",
            "note": "保留",
        }));
        assert!(short_pack.contains("已脱敏:签名直链"), "{short_pack}");
        assert!(!short_pack.contains("sign=abc"));
    }

    // -----------------------------------------------------------------------
    // 3. 轮次上限
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn max_rounds_stops_the_loop_with_explicit_marker() {
        let f = new_fixture("max-rounds");
        f.configure(2);
        for i in 0..3 {
            f.llm.push(tool_calls_round(json!([
                one_call(&format!("c{i}"), "list_dir", "{}"),
            ])));
        }
        let events = event_cb(&f.events);
        let outcome = f.chat.send("一直查", Some(events)).await.unwrap();
        assert_eq!(outcome.stopped.as_deref(), Some("max_rounds"));
        assert_eq!(outcome.rounds, 2);
        assert!(outcome.reply.contains("已达到本轮工具调用上限（2 次）"));
        assert_eq!(f.llm.requests().len(), 2, "超过 maxRounds 后不得再请求模型");
        let done = f.events_of("done");
        assert_eq!(done[0]["stopped"], "max_rounds");
        assert_eq!(done[0]["rounds"], 2);
        let history = f.chat.history(None);
        let last = history.last().unwrap();
        assert_eq!(last["stopped"], "max_rounds");
        assert_eq!(last["role"], "assistant");
    }

    // -----------------------------------------------------------------------
    // 4. 单轮工具上限：被丢弃的调用必须补 tool 响应
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn overflow_tool_calls_still_get_tool_responses() {
        let f = new_fixture("overflow");
        f.configure(4);
        let calls: Vec<Value> = (0..10)
            .map(|i| one_call(&format!("c{i}"), "list_dir", "{}"))
            .collect();
        f.llm.push(tool_calls_round(json!(calls)));
        f.llm.push(final_round("完"));
        let events = event_cb(&f.events);
        let outcome = f.chat.send("批量", Some(events)).await.unwrap();
        assert_eq!(outcome.reply, "完");
        assert_eq!(outcome.tool_calls.len(), MAX_TOOL_CALLS_PER_ROUND);
        assert_eq!(f.events_of("tool_start").len(), MAX_TOOL_CALLS_PER_ROUND);
        let msgs = f.llm.requests()[1].body["messages"].as_array().unwrap().clone();
        let tool_msgs: Vec<&Value> = msgs.iter().filter(|m| m["role"] == "tool").collect();
        assert_eq!(tool_msgs.len(), 10, "10 个 tool_calls 必须有 10 条 tool 响应");
        let overflow: Vec<&&Value> = tool_msgs
            .iter()
            .filter(|m| m["content"].as_str().unwrap().contains("单轮工具调用数已达上限"))
            .collect();
        assert_eq!(overflow.len(), 2);
        // assistant.tool_calls 的每个 id 都有对应 tool 响应
        let assistant = msgs
            .iter()
            .find(|m| m["role"] == "assistant" && m.get("tool_calls").is_some())
            .unwrap();
        let declared: Vec<&str> = assistant["tool_calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        for id in declared {
            assert!(
                tool_msgs.iter().any(|m| m["tool_call_id"] == id),
                "缺少 {id} 的 tool 响应"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 5. 错误路径
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn http_401_maps_to_unauthorized_and_emits_error_event() {
        let f = new_fixture("http-401");
        f.configure(4);
        f.llm.push(Scripted::Http {
            status: 401,
            body: "{\"error\":\"invalid api key\"}".to_string(),
        });
        let events = event_cb(&f.events);
        let err = f.chat.send("你好", Some(events)).await.unwrap_err();
        assert_eq!(err.code, AgentError::Unauthorized);
        assert!(err.message.contains("HTTP 401"));
        assert!(err.hint.as_deref().unwrap_or("").contains("invalid api key"));
        let err_events = f.events_of("error");
        assert_eq!(err_events.len(), 1);
        assert_eq!(err_events[0]["code"], "AGENT_UNAUTHORIZED");
        // transcript 记录失败说明
        let history = f.chat.history(None);
        assert!(history
            .last()
            .unwrap()["text"]
            .as_str()
            .unwrap()
            .starts_with('❌'));
        assert!(f.chat.status()["lastError"]
            .as_str()
            .unwrap()
            .contains("HTTP 401"));
        // busy 已复位：可以再次发送
        f.llm.push(final_round("恢复"));
        assert_eq!(f.chat.send("再试", None).await.unwrap().reply, "恢复");
    }

    #[tokio::test]
    async fn network_error_maps_to_upstream() {
        let f = new_fixture("net-error");
        // 先拿一个端口再关掉，确保连接被拒
        let dead_port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        f.config
            .update(&json!({
                "baseUrl": format!("http://127.0.0.1:{dead_port}/v1"),
                "model": "m",
                "apiKey": "sk-x",
            }))
            .unwrap();
        let err = f.chat.send("hi", None).await.unwrap_err();
        assert_eq!(err.code, AgentError::Upstream);
        assert!(err.message.contains("无法连接大模型"), "{}", err.message);
    }

    #[tokio::test]
    async fn invalid_json_and_missing_choices_are_upstream_errors() {
        let f = new_fixture("bad-shape");
        f.configure(4);
        f.llm.push(Scripted::Raw("not json at all".to_string()));
        let err = f.chat.send("a", None).await.unwrap_err();
        assert_eq!(err.code, AgentError::Upstream);
        assert_eq!(err.message, "大模型返回的内容不是合法 JSON");
        // 缺 choices[0].message
        f.llm.push(Scripted::Json(json!({ "choices": [] })));
        let err = f.chat.send("b", None).await.unwrap_err();
        assert_eq!(err.code, AgentError::Upstream);
        assert!(err.message.contains("缺少 choices[0].message"));
        // content 非字符串且没有 tool_calls
        f.llm.push(Scripted::Json(json!({
            "choices": [{ "message": { "content": 42 } }],
        })));
        let err = f.chat.send("c", None).await.unwrap_err();
        assert_eq!(err.code, AgentError::Upstream);
        // busy 已复位
        f.llm.push(final_round("ok"));
        assert_eq!(f.chat.send("d", None).await.unwrap().reply, "ok");
    }

    // -----------------------------------------------------------------------
    // 6. 工具失败不中断整条消息
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn tool_failure_is_reported_to_model_without_aborting() {
        let f = new_fixture("tool-fail");
        f.configure(4);
        f.llm.push(tool_calls_round(json!([
            one_call("c1", "fail_tool", "{}"),
            one_call("c2", "nope_tool", "{}"),
        ])));
        f.llm.push(final_round("抱歉，操作失败了"));
        let outcome = f.chat.send("写文件", None).await.unwrap();
        assert_eq!(outcome.reply, "抱歉，操作失败了");
        assert_eq!(outcome.tool_calls.len(), 2);
        assert_eq!(outcome.tool_calls[0]["ok"], false);
        assert!(outcome.tool_calls[0]["summary"]
            .as_str()
            .unwrap()
            .contains("目录只读"));
        assert_eq!(outcome.tool_calls[1]["ok"], false);
        let msgs = f.llm.requests()[1].body["messages"].as_array().unwrap().clone();
        let tool_msgs: Vec<&Value> = msgs.iter().filter(|m| m["role"] == "tool").collect();
        // packToolError 保留 code/hint，模型才能解释原因
        assert!(tool_msgs[0]["content"]
            .as_str()
            .unwrap()
            .contains("AGENT_READ_ONLY"));
        assert!(tool_msgs[0]["content"]
            .as_str()
            .unwrap()
            .contains("请在客户端把该目录改为"));
        assert!(tool_msgs[1]["content"]
            .as_str()
            .unwrap()
            .contains("没有名为 nope_tool 的工具"));
    }

    // -----------------------------------------------------------------------
    // 7. 历史裁剪
    // -----------------------------------------------------------------------

    #[test]
    fn trim_history_cuts_at_user_boundary_and_keeps_tool_pairing() {
        let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": "sys" })];
        for i in 0..20 {
            messages.push(json!({ "role": "user", "content": format!("u{i}") }));
            messages.push(json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{ "id": format!("c{i}"), "type": "function",
                                 "function": { "name": "list_dir", "arguments": "{}" } }],
            }));
            messages.push(json!({ "role": "tool", "tool_call_id": format!("c{i}"),
                                  "name": "list_dir", "content": "{}" }));
            messages.push(json!({ "role": "assistant", "content": format!("a{i}") }));
        }
        assert!(messages.len() > MAX_HISTORY_MESSAGES);
        trim_history(&mut messages);
        assert!(messages.len() <= MAX_HISTORY_MESSAGES);
        assert_eq!(messages[0]["role"], "system");
        // 裁剪后第一条非 system 消息必须是 user（从 user 边界切）
        assert_eq!(messages[1]["role"], "user");
        // tool 消息必须仍有对应的 tool_calls 声明
        let mut pending: HashSet<String> = HashSet::new();
        for m in &messages {
            match m["role"].as_str().unwrap() {
                "assistant" => {
                    if let Some(calls) = m.get("tool_calls").and_then(|c| c.as_array()) {
                        pending.clear();
                        for c in calls {
                            pending.insert(c["id"].as_str().unwrap().to_string());
                        }
                    } else {
                        pending.clear();
                    }
                }
                "tool" => {
                    let id = m["tool_call_id"].as_str().unwrap();
                    assert!(pending.contains(id), "tool 响应 {id} 缺少对应的 tool_calls");
                }
                _ => {}
            }
        }
        // 末条保留
        assert_eq!(messages.last().unwrap()["content"], "a19");
    }

    // -----------------------------------------------------------------------
    // 8. 输入校验 / busy / 未配置
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn input_validation_busy_conflict_and_unconfigured_are_rejected() {
        let f = new_fixture("validation");
        // 未配置
        let err = f.chat.send("hi", None).await.unwrap_err();
        assert_eq!(err.code, AgentError::InvalidArg);
        assert_eq!(err.message, "尚未配置大模型");
        assert!(!f.chat.status()["running"].as_bool().unwrap());
        // 空消息 / 超长消息
        f.configure(4);
        let err = f.chat.send("   ", None).await.unwrap_err();
        assert_eq!(err.message, "消息不能为空");
        let huge = "字".repeat(MAX_INPUT_CHARS + 1);
        let err = f.chat.send(&huge, None).await.unwrap_err();
        assert_eq!(err.message, "单条消息过长（上限 8000 字）");
        // busy：直接占位模拟"上一条还在处理中"
        f.chat.busy.store(true, Ordering::SeqCst);
        let err = f.chat.send("hi", None).await.unwrap_err();
        assert_eq!(err.code, AgentError::Conflict);
        assert_eq!(err.hint.as_deref(), Some("请等待当前回复结束"));
        f.chat.busy.store(false, Ordering::SeqCst);
        // clear 回到空态
        f.llm.push(final_round("好的"));
        f.chat.send("hi", None).await.unwrap();
        assert!(!f.chat.history(None).is_empty());
        assert_eq!(f.chat.clear()["ok"], true);
        assert!(f.chat.history(None).is_empty());
        assert_eq!(f.chat.status()["historyCount"], 0);
    }

    // -----------------------------------------------------------------------
    // 9. testConnection / listModels
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_connection_uses_local_probe_without_polluting_history() {
        let f = new_fixture("probe");
        f.configure(4);
        f.llm.push(final_round("可用"));
        let res = f.chat.test_connection().await.unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(res["model"], "fake-model");
        assert_eq!(res["reply"], "可用");
        // 探测用自己的消息数组：只有 system + user 两条，且不写历史
        let reqs = f.llm.requests();
        let msgs = reqs[0].body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["content"], "回复两个字：可用");
        assert!(f.chat.history(None).is_empty());
        // 错误路径：HTTP 500
        f.llm.push(Scripted::Http { status: 500, body: "boom".to_string() });
        let err = f.chat.test_connection().await.unwrap_err();
        assert_eq!(err.code, AgentError::Upstream);
        assert!(err.message.contains("HTTP 500"));
        // busy 已复位
        f.chat.busy.store(false, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn list_models_parses_defensively_and_dedups() {
        let f = new_fixture("models");
        f.configure(4);
        f.llm.push(Scripted::Json(json!({
            "data": [{ "id": "b" }, { "id": "a" }, { "id": "a" }, "c", { "nope": 1 }],
        })));
        let res = f.chat.list_models().await.unwrap();
        assert_eq!(res["models"], json!(["a", "b", "c"]));
        assert_eq!(res["count"], 3);
        let reqs = f.llm.requests();
        assert_eq!(reqs[0].method, "GET");
        assert_eq!(reqs[0].path, "/v1/models");
        assert_eq!(reqs[0].headers["authorization"], "Bearer sk-fake-for-test");
    }

    #[test]
    fn endpoint_for_tolerates_full_completion_url() {
        assert_eq!(endpoint_for("https://x/v1"), "https://x/v1/chat/completions");
        assert_eq!(endpoint_for("https://x/v1/"), "https://x/v1/chat/completions");
        assert_eq!(
            endpoint_for("https://x/v1/chat/completions"),
            "https://x/v1/chat/completions"
        );
    }

    // -----------------------------------------------------------------------
    // 10. 工具响应/错误打包的单元断言
    // -----------------------------------------------------------------------

    #[test]
    fn pack_tool_result_redacts_then_truncates() {
        let payload = json!({ "cookie": "SID=x", "text": "b".repeat(MAX_TOOL_RESULT_CHARS + 10) });
        let packed = pack_tool_result(&payload);
        assert!(!packed.contains("SID=x"));
        assert!(packed.ends_with(TRUNCATED_NOTE));
        // 短结果原样（脱敏后）返回，不加截断标记
        let short = pack_tool_result(&json!({ "ok": true }));
        assert_eq!(short, "{\"ok\":true}");
        // 字符串 payload 原样（qck typeof string 分支）
        assert_eq!(pack_tool_result(&json!("纯文本")), "纯文本");
    }

    #[test]
    fn pack_tool_error_keeps_code_and_hint() {
        let err = AgentToolError::new(AgentError::OutOfScope, "不在授权目录内")
            .with_hint("请在设置中添加该目录");
        let text = pack_tool_error(&err);
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["error"]["code"], "AGENT_OUT_OF_SCOPE");
        assert_eq!(parsed["error"]["message"], "不在授权目录内");
        assert_eq!(parsed["error"]["hint"], "请在设置中添加该目录");
    }
}
