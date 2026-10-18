//! 客户端内的 Agent 网关：本机桥接服务。
//!
//! 位置（qck docs/AGENT_ACCESS.md §2）：
//!   外部 Agent ── MCP stdio 适配器 ──[Unix socket / 命名管道]── 本网关 ── 共享业务服务
//!
//! 为什么必须由**运行中的客户端**托管（交接说明 §5.2）：
//!   会话（Cookie jar）、HTTP 客户端与传输队列都是进程内状态。若让每次工具调用另起一个
//!   同时加载同一 profile 的进程，就会互相用旧快照覆盖会话，并且 GUI 与 Agent 会看到两个队列。
//!
//! 安全要点（与 qck gateway.js 逐条对应，规格 §7）：
//! 1. **凭据鉴别在前**：连接后必须先用 token 认证，未认证前只接受 auth/ping/hello；
//!    仅绑定本机 socket 不构成授权。
//! 2. 凭据恒定时间比较；失败立即断开，且不区分"token 错"与"格式错"的具体原因。
//! 3. 单条消息与并发都有上限：未认证连接另有更严的独立限额，避免"连上就挂着"占满全部连接位。
//! 4. 每个连接串行处理请求：工具会改动网盘状态，避免同一连接内的并发造成竞态。
//! 5. 所有调用（含失败）写操作记录，但不落盘任何凭据。
//! 6. 超限断开前尽力从当前这一行取出请求 id：让调用方能对上号，而不是只看到"连接断开"。
//!
//! 帧协议：**JSON lines（NDJSON）**——以 `\n` 分隔的 UTF-8 JSON 对象。
//! 这不是推测：qck gateway.js 的读侧 `buffer.indexOf('\n')` 切行、写侧
//! `JSON.stringify(payload) + '\n'`，qck 的两个真实客户端（agent-bridge-client.js /
//! agent-mcp.js）同样按行收发，所以 Rust 版照搬行帧而不是长度前缀帧。
//!
//! 平台：本阶段只实现 Unix domain socket；Windows 命名管道留 TODO（见 [`AgentGateway::start`]）。

use crate::config::ScopeSnapshot;
use crate::journal::Journal;
use crate::policy::{safe_equal, AgentError, AgentToolError};
use crate::registry::{ToolContext, ToolRegistry};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use std::time::Duration;

/// 私有桥协议版本。
pub const PROTOCOL_VERSION: u64 = 1;

/// 单条消息（整行 JSON）上限：4 MiB。
///
/// 必须**严格大于**工具参数上限：`tools.rs` 的 `MAX_TEXT_BYTES` 允许单次 256 KiB 的
/// UTF-8 文本（save_text_file 的 text 参数），而请求是整行 JSON —— 正文里的引号、反斜杠、
/// 换行都要转义，普通文本按约 2 倍膨胀、控制字符按 \uXXXX 可达 6 倍，再叠加 JSON 外壳与其他参数，
/// "上限内的合法文本"必然超过"同等大小的整行上限"。
/// qck 早期两者同为 1 MiB，导致完全合法的 save_text_file 被误判为"消息过大"并断连
/// （适配器侧只看到 BRIDGE_CLOSED，用户看到的是"连接断开"而不是真实原因）。
/// 这里取 4 MiB：既覆盖合法文本的常规转义膨胀，也仍然给内存占用留下明确上限（规格 §12.3 第 18 条）。
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// 未认证连接的存活时间。
pub const AUTH_TIMEOUT_MS: u64 = 5_000;

/// 同时保持的**已认证**连接数上限。
pub const MAX_CONNECTIONS: usize = 8;

/// **未认证**连接的并发上限。
///
/// 未认证连接最迟在 `AUTH_TIMEOUT_MS` 后被断开，但本机同用户的任意进程都可以
/// "连上就挂着、到点再重连"，用空闲连接占住 `MAX_CONNECTIONS` 的位置，让合法的 MCP
/// 适配器长时间拿不到连接（本地 DoS）。因此未认证连接单独限额：超出的新连接**立即断开**；
/// 认证成功后才转入总连接池并计入 `MAX_CONNECTIONS`（见 [`ConnControl::transition_to_authenticated`]）。
pub const MAX_UNAUTHENTICATED_CONNECTIONS: usize = 2;

/// 每秒允许的请求数上限（单连接）。
pub const MAX_REQUESTS_PER_SECOND: u32 = 50;

/// 单连接**排队中**的请求数上限。
/// 超过就断开：否则已认证的调用方可以一次性灌入大量消息，在客户端里堆出无界的工作量。
pub const MAX_QUEUED_REQUESTS: usize = 32;

/// 兜底 id 提取的扫描上限：id 一般在消息开头，没必要为它扫完整条超大消息。
pub const ID_SCAN_BYTES: usize = 4096;

/// 不需要认证即可调用的方法（qck `PRE_AUTH_METHODS`）。
pub const PRE_AUTH_METHODS: [&str; 3] = ["auth", "ping", "hello"];

const SERVER_NAME: &str = "quark-mini";

/// 宿主侧实时配置源：网关**不缓存**任何授权状态。
///
/// 对应 qck 每次 `config.isActive()` / `config.get().token` / `config.scope()` 都实时读 store：
/// 修改授权范围或停用接入不需要重启网关（规格 §12.3 第 25 条）。
pub trait ConfigSource: Send + Sync {
    /// Agent 接入开关与桥接凭据（实时）。
    fn access(&self) -> AccessSnapshot;
    /// 当前授权范围快照（每次工具调用前实时计算）。
    fn scope(&self) -> ScopeSnapshot;
    /// 会话 generation（`tools.rs` 的会话绑定调用需要）。宿主不区分时返回 0 即可。
    fn generation(&self) -> u64 {
        0
    }
}

/// Agent 接入开关 + 桥接凭据的快照。
#[derive(Debug, Clone, Default)]
pub struct AccessSnapshot {
    pub enabled: bool,
    pub token: String,
}

/// 单连接会话状态（qck `session`）。
#[derive(Debug, Clone, Default)]
pub struct Session {
    pub authenticated: bool,
    pub client: String,
}

/// `handleMessage` 的返回：`close` 是控制字段，**不会**出现在写回的 JSON 里
/// （qck `write()` 里 `const { close, ...rest } = payload`）。
#[derive(Debug, Clone)]
pub struct GatewayResponse {
    pub payload: Value,
    pub close: bool,
}

impl GatewayResponse {
    fn reply(payload: Value) -> Self {
        Self { payload, close: false }
    }
    fn reply_close(payload: Value) -> Self {
        Self { payload, close: true }
    }
}

/// 连接控制：`handle_message` 需要它完成"认证成功后迁池"与同步认证标志。
///
/// 单元测试可以直接用 [`AgentGateway::test_control`] 构造一个不绑定真实 socket 的实例
/// （qck 测试同样直接调 `gateway.handleMessage(session, ...)`）。
pub struct ConnControl {
    conn_id: u64,
    shared: StdArc<Shared>,
    authenticated: StdArc<AtomicBool>,
}

impl ConnControl {
    /// 认证成功时的连接池迁移：未认证池 → 总连接池。
    ///
    /// 返回 `false` 表示总连接位已被占满（并发认证的竞态），调用方应拒绝这次认证并断开；
    /// 已在总池内的连接重复 auth（适配器幂等重试）不改变归属，直接放行 —— 否则连接池满时，
    /// 一条正常连接只因重发 auth 就会被误杀（规格 §12.3 第 20 条）。
    fn transition_to_authenticated(&self, already_authenticated: bool) -> bool {
        if already_authenticated {
            return true;
        }
        self.shared.transition_authenticated(self.conn_id)
    }
}

/// 网关内部共享状态（跨连接计数与监听状态）。
struct Shared {
    next_conn: AtomicU64,
    /// 已认证连接：受 [`MAX_CONNECTIONS`] 限制（认证成功后才计入）。
    connections: StdMutex<HashSet<u64>>,
    /// 未认证连接：受 [`MAX_UNAUTHENTICATED_CONNECTIONS`] 限制，认证成功即转出。
    pending: StdMutex<HashSet<u64>>,
    /// 每个连接任务的 abort 句柄（stop 时统一断开）。
    conn_aborts: StdMutex<HashMap<u64, tokio::task::AbortHandle>>,
    calls_served: AtomicU64,
    auth_failures: AtomicU64,
    started_at: StdMutex<i64>,
    last_error: StdMutex<String>,
    endpoint: StdMutex<String>,
    running: AtomicBool,
    accept_abort: StdMutex<Option<tokio::task::AbortHandle>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            next_conn: AtomicU64::new(1),
            connections: StdMutex::new(HashSet::new()),
            pending: StdMutex::new(HashSet::new()),
            conn_aborts: StdMutex::new(HashMap::new()),
            calls_served: AtomicU64::new(0),
            auth_failures: AtomicU64::new(0),
            started_at: StdMutex::new(0),
            last_error: StdMutex::new(String::new()),
            endpoint: StdMutex::new(String::new()),
            running: AtomicBool::new(false),
            accept_abort: StdMutex::new(None),
        }
    }

    /// 迁池；总池满返回 false。锁顺序固定为 connections → pending，避免与 release 交叉死锁。
    fn transition_authenticated(&self, conn_id: u64) -> bool {
        let mut conns = self.connections.lock().unwrap();
        if conns.len() >= MAX_CONNECTIONS {
            return false;
        }
        conns.insert(conn_id);
        drop(conns);
        self.pending.lock().unwrap().remove(&conn_id);
        true
    }

    fn release(&self, conn_id: u64) {
        self.connections.lock().unwrap().remove(&conn_id);
        self.pending.lock().unwrap().remove(&conn_id);
        self.conn_aborts.lock().unwrap().remove(&conn_id);
    }
}

/// 可注入时钟（毫秒）。生产用 [`crate::journal::now_ms`]；测试注入固定时钟以确定性地
/// 触发单连接限速窗口（qck 测试同样用 `now: () => 1` 冻结时钟）。
pub type NowFn = StdArc<dyn Fn() -> i64 + Send + Sync>;

/// 本机桥接网关。
pub struct AgentGateway {
    source: StdArc<dyn ConfigSource>,
    registry: StdArc<dyn ToolRegistry>,
    journal: StdArc<Journal>,
    shared: StdArc<Shared>,
    auth_timeout_ms: u64,
    max_rps: u32,
    now_fn: NowFn,
}

impl AgentGateway {
    pub fn new(
        source: StdArc<dyn ConfigSource>,
        registry: StdArc<dyn ToolRegistry>,
        journal: StdArc<Journal>,
    ) -> Self {
        Self {
            source,
            registry,
            journal,
            shared: StdArc::new(Shared::new()),
            auth_timeout_ms: AUTH_TIMEOUT_MS,
            max_rps: MAX_REQUESTS_PER_SECOND,
            now_fn: StdArc::new(crate::journal::now_ms),
        }
    }

    /// 覆盖认证超时（仅测试用于缩短等待；生产默认 [`AUTH_TIMEOUT_MS`]）。
    pub fn with_auth_timeout_ms(mut self, ms: u64) -> Self {
        self.auth_timeout_ms = ms;
        self
    }

    /// 覆盖单连接 RPS 上限（仅测试用于缩短触发路径；生产默认 [`MAX_REQUESTS_PER_SECOND`]）。
    pub fn with_rate_limit(mut self, rps: u32) -> Self {
        self.max_rps = rps;
        self
    }

    /// 覆盖时钟（仅测试：冻结窗口以确定性触发限速，qck 测试同法）。
    pub fn with_now(mut self, now: NowFn) -> Self {
        self.now_fn = now;
        self
    }

    /// 供单元测试直接调用 `handle_message` 的连接控制（不迁移到真实连接池）。
    #[cfg(test)]
    pub fn test_control(&self) -> ConnControl {
        ConnControl {
            conn_id: 0,
            shared: self.shared.clone(),
            authenticated: StdArc::new(AtomicBool::new(false)),
        }
    }

    fn audit(&self, kind: &str, tool: &str, actor: &str, result: &str, detail: &Value) {
        self.journal.append(kind, tool, actor, result, &Value::Null, detail);
    }

    /// 启动监听。已运行时幂等。
    ///
    /// 注意：**不在此处检查/推导端点**——端点由宿主（config.activate 的 endpoint_factory）
    /// 生成并持久化，网关只接受 endpoint 字符串，避免两处各算一份。
    pub async fn start(self: StdArc<Self>, endpoint: &str) -> Result<(), AgentToolError> {
        if self.shared.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        let access = self.source.access();
        if !access.enabled || access.token.is_empty() {
            return Err(AgentToolError::new(AgentError::Disabled, "Agent 接入未启用"));
        }
        if endpoint.is_empty() {
            return Err(AgentToolError::new(
                AgentError::Disabled,
                "尚未生成桥接端点，请先在客户端启用 Agent 接入",
            ));
        }

        #[cfg(unix)]
        {
            let path = Path::new(endpoint);
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        let msg = format!("无法创建桥接端点目录：{e}");
                        *self.shared.last_error.lock().unwrap() = msg.clone();
                        return Err(AgentToolError::new(AgentError::Internal, msg));
                    }
                    // 目录仅本人可访问（socket 权限之外的第二道；失败不阻断，socket 本身还有 0600）。
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ =
                            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
                    }
                }
            }
            // 残留的 socket 文件会让 bind 直接 EADDRINUSE；不是 socket 则明确报错（不误删用户文件）。
            {
                use std::os::unix::fs::FileTypeExt;
                match std::fs::symlink_metadata(path) {
                    Ok(meta) if meta.file_type().is_socket() => {
                        if let Err(e) = std::fs::remove_file(path) {
                            let msg = format!("无法清理残留桥接端点：{e}");
                            *self.shared.last_error.lock().unwrap() = msg.clone();
                            return Err(AgentToolError::new(AgentError::Internal, msg));
                        }
                    }
                    Ok(_) => {
                        return Err(AgentToolError::new(
                            AgentError::Internal,
                            "桥接端点路径已被占用，且不是 socket 文件",
                        ))
                    }
                    Err(_) => {}
                }
            }
            let listener = match tokio::net::UnixListener::bind(path) {
                Ok(l) => l,
                Err(e) => {
                    let msg = format!("无法监听桥接端点：{e}");
                    *self.shared.last_error.lock().unwrap() = msg.clone();
                    return Err(AgentToolError::new(AgentError::Internal, msg));
                }
            };
            // socket 仅本人可读写；收紧失败不阻断（目录本身已是 0700）。
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
            *self.shared.endpoint.lock().unwrap() = endpoint.to_string();
            *self.shared.started_at.lock().unwrap() = (self.now_fn)();
            self.shared.last_error.lock().unwrap().clear();
            self.shared.running.store(true, Ordering::SeqCst);
            self.audit("gateway", "", "client", "started", &json!({ "endpoint": endpoint }));

            let this = self.clone();
            let accept = tokio::spawn(async move {
                loop {
                    match listener.accept().await {
                        Ok((stream, _addr)) => Self::attach(&this, stream),
                        Err(e) => {
                            if !this.shared.running.load(Ordering::SeqCst) {
                                break;
                            }
                            *this.shared.last_error.lock().unwrap() = format!("accept 失败：{e}");
                            // 短暂的 accept 错误（EMFILE 等）不应把监听循环打死。
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                    }
                }
            });
            *self.shared.accept_abort.lock().unwrap() = Some(accept.abort_handle());
            Ok(())
        }

        #[cfg(not(unix))]
        {
            // TODO(Windows)：命名管道（\\.\pipe\quark-mini-agent-<token12>）。
            // 需要 tokio::net::windows::named_pipe::ServerOptions + 每连接的 pipe 实例复用；
            // 本阶段按任务约定只保证 macOS/Linux（qck 开发机为 macOS arm64，规格 §12.9 同此边界）。
            let _ = endpoint;
            Err(AgentToolError::new(
                AgentError::Internal,
                "当前平台暂不支持 Agent 网关（Windows 命名管道尚未实现）",
            ))
        }
    }

    /// 停止监听并断开所有连接。幂等。
    pub async fn stop(&self) {
        if !self.shared.running.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(abort) = self.shared.accept_abort.lock().unwrap().take() {
            abort.abort();
        }
        // 两个连接池都要断开：未认证连接同样持有 socket 与定时器。
        let handles: Vec<tokio::task::AbortHandle> =
            self.shared.conn_aborts.lock().unwrap().drain().map(|(_, h)| h).collect();
        for h in handles {
            h.abort();
        }
        self.shared.connections.lock().unwrap().clear();
        self.shared.pending.lock().unwrap().clear();
        let endpoint = {
            let mut e = self.shared.endpoint.lock().unwrap();
            std::mem::take(&mut *e)
        };
        if !endpoint.is_empty() && !endpoint.starts_with("\\\\") {
            let _ = std::fs::remove_file(&endpoint);
        }
        if !endpoint.is_empty() {
            self.audit("gateway", "", "client", "stopped", &json!({ "endpoint": endpoint }));
        }
    }

    /// 遥测/审计用的安全快照。
    ///
    /// `connections` = 已认证 + 等待认证，与 GUI 上"当前连接"的含义保持一致。
    pub fn status(&self) -> Value {
        let connections = self.shared.connections.lock().unwrap().len()
            + self.shared.pending.lock().unwrap().len();
        let last_error = self.shared.last_error.lock().unwrap().clone();
        let endpoint = self.shared.endpoint.lock().unwrap().clone();
        let mut out = json!({
            "running": self.shared.running.load(Ordering::SeqCst),
            "endpoint": endpoint,
            "protocolVersion": PROTOCOL_VERSION,
            "connections": connections,
            "callsServed": self.shared.calls_served.load(Ordering::SeqCst),
            "authFailures": self.shared.auth_failures.load(Ordering::SeqCst),
            "startedAt": *self.shared.started_at.lock().unwrap(),
            "toolCount": self.registry.tools().len(),
        });
        if !last_error.is_empty() {
            out["lastError"] = json!(last_error);
        }
        out
    }

    /// 工具清单（供 `tools.list` / MCP 适配器 / 对话共用同一份定义）。
    ///
    /// 形状照 qck：`{name, title, description, inputSchema, annotations}`。
    /// Rust 的 [`crate::registry::ToolDef`] 没有 title 与 annotations 字段，
    /// 因此 title 固定空串、annotations 固定空对象（字段存在性对 MCP 客户端是契约）。
    pub fn list_tools(&self) -> Vec<Value> {
        self.registry
            .tools()
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "title": "",
                    "description": t.description,
                    "inputSchema": t.parameters,
                    "annotations": {},
                })
            })
            .collect()
    }

    /// 执行一次工具调用（GUI 内部也可复用，走同一条范围校验路径）。
    ///
    /// 每次调用都实时读取 `enabled/token/scope/generation`——修改授权范围无需重启网关。
    pub async fn call_tool(
        &self,
        name: &str,
        args: &Value,
        actor: &str,
    ) -> Result<Value, AgentToolError> {
        let access = self.source.access();
        if !access.enabled || access.token.is_empty() {
            return Err(AgentToolError::new(AgentError::Disabled, "Agent 接入未启用"));
        }
        let tools = self.registry.tools();
        let tool_name = match tools.iter().find(|t| t.name == name) {
            Some(t) => t.name,
            None => {
                return Err(AgentToolError::new(
                    AgentError::InvalidArg,
                    format!("未知工具：{name}"),
                ))
            }
        };
        let started = (self.now_fn)();
        let ctx = ToolContext {
            actor: actor.to_string(),
            generation: self.source.generation(),
            scope: self.source.scope(),
        };
        let result = self.registry.call_tool(&ctx, tool_name, args).await;
        self.shared.calls_served.fetch_add(1, Ordering::SeqCst);
        let ms = ((self.now_fn)() - started).max(0) as u64;
        match result {
            Ok(v) => {
                self.audit(
                    "tool_call",
                    tool_name,
                    actor,
                    "ok",
                    &json!({ "ms": ms, "args": summarize_args(args) }),
                );
                // qck：result === undefined ? {ok:true} : result。Rust 里工具"无返回值"用 Null 表示。
                if v.is_null() {
                    Ok(json!({ "ok": true }))
                } else {
                    Ok(v)
                }
            }
            Err(e) => {
                self.audit(
                    "tool_call",
                    tool_name,
                    actor,
                    "error",
                    &json!({
                        "ms": ms,
                        "code": e.code.as_str(),
                        "message": e.message,
                        "args": summarize_args(args),
                    }),
                );
                Err(e)
            }
        }
    }

    /// 处理一条已解析的请求，返回响应（qck `handleMessage`）。
    pub async fn handle_message(
        &self,
        conn: &ConnControl,
        session: &mut Session,
        msg: &Value,
    ) -> GatewayResponse {
        let obj = match msg {
            Value::Object(o) => o,
            _ => {
                return GatewayResponse::reply(json!({
                    "id": Value::Null,
                    "ok": false,
                    "error": { "code": AgentError::InvalidArg.as_str(), "message": "请求必须是 JSON 对象" },
                }))
            }
        };
        let id = obj.get("id").cloned().unwrap_or(Value::Null);
        // method 必须是字符串：早期 qck 用 String(msg.method || '') 强转，
        // `{"method":["ping"]}` 会被转成 "ping" 直接通过方法名校验（规格 §12.3 第 23 条）。
        let method = match obj.get("method") {
            None | Some(Value::Null) => {
                return GatewayResponse::reply(error_response(
                    id,
                    AgentError::InvalidArg,
                    "缺少 method 字段",
                    None,
                ))
            }
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                return GatewayResponse::reply(error_response(
                    id,
                    AgentError::InvalidArg,
                    "method 必须是字符串",
                    None,
                ))
            }
        };
        if method.is_empty() {
            return GatewayResponse::reply(error_response(
                id,
                AgentError::InvalidArg,
                "缺少 method 字段",
                None,
            ));
        }
        if !session.authenticated && !PRE_AUTH_METHODS.contains(&method.as_str()) {
            return GatewayResponse::reply(error_response(
                id,
                AgentError::Unauthorized,
                "请先完成认证（method: auth）",
                None,
            ));
        }

        match method.as_str() {
            "auth" => self.handle_auth(conn, session, id, obj.get("params")),
            "ping" => GatewayResponse::reply(
                json!({ "id": id, "ok": true, "result": { "pong": true, "ts": (self.now_fn)() } }),
            ),
            "hello" => GatewayResponse::reply(json!({
                "id": id,
                "ok": true,
                "result": {
                    "protocol_version": PROTOCOL_VERSION,
                    "server": SERVER_NAME,
                    "authenticated": session.authenticated,
                    "requires_auth": true,
                },
            })),
            "tools.list" => GatewayResponse::reply(json!({
                "id": id,
                "ok": true,
                "result": { "tools": self.list_tools() },
            })),
            "tools.call" => {
                let empty_params = Value::Null;
                let params: &Value = match obj.get("params") {
                    // qck：`msg.params && typeof === 'object' ? msg.params : {}`（数组也按 object 传下去，
                    // 由工具层拒绝；这里不做"静默当空对象"的降级）。
                    Some(v @ Value::Object(_)) | Some(v @ Value::Array(_)) => v,
                    _ => &empty_params,
                };
                let name = label_string(params.get("name"));
                let args = match params.get("arguments") {
                    Some(v @ Value::Object(_)) | Some(v @ Value::Array(_)) => v.clone(),
                    _ => json!({}),
                };
                let actor = if session.client.is_empty() {
                    "agent".to_string()
                } else {
                    session.client.clone()
                };
                match self.call_tool(&name, &args, &actor).await {
                    Ok(result) => GatewayResponse::reply(json!({ "id": id, "ok": true, "result": result })),
                    Err(e) => {
                        let mut payload = json!({
                            "code": e.code.as_str(),
                            "message": e.message,
                        });
                        if let Some(hint) = &e.hint {
                            payload["hint"] = json!(hint);
                        }
                        if let Some(detail) = &e.upstream_message {
                            // qck：detail 经 journal.sanitize 脱敏后再回给调用方。
                            payload["detail"] = crate::journal::sanitize(&json!(detail));
                        }
                        if let Some(biz) = &e.upstream_code {
                            payload["biz_code"] = biz.clone();
                        }
                        GatewayResponse::reply(json!({ "id": id, "ok": false, "error": payload }))
                    }
                }
            }
            "status" => GatewayResponse::reply(json!({
                "id": id,
                "ok": true,
                "result": self.status(),
            })),
            other => GatewayResponse::reply(error_response(
                id,
                AgentError::InvalidArg,
                &format!("不支持的方法：{other}"),
                None,
            )),
        }
    }

    fn handle_auth(
        &self,
        conn: &ConnControl,
        session: &mut Session,
        id: Value,
        params: Option<&Value>,
    ) -> GatewayResponse {
        let access = self.source.access();
        let provided = params
            .and_then(|p| p.get("token"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        // 失败与格式错误统一"认证失败"并立即断开：不区分具体原因，也不泄漏期望凭据。
        if !access.enabled || access.token.is_empty() || !safe_equal(provided, &access.token) {
            self.shared.auth_failures.fetch_add(1, Ordering::SeqCst);
            self.audit(
                "auth",
                "",
                "external",
                "rejected",
                &json!({ "client": client_label(params) }),
            );
            return GatewayResponse::reply_close(error_response(
                id,
                AgentError::Unauthorized,
                "认证失败",
                None,
            ));
        }
        // 认证成功才占用总连接位（未认证池 → 总连接池）。
        // 返回 false 说明总连接位刚被其他并发认证占满：拒绝本次认证并断开，
        // 否则多条未认证连接可以一起认证，绕过 MAX_CONNECTIONS。
        if !conn.transition_to_authenticated(session.authenticated) {
            return GatewayResponse::reply_close(error_response(
                id,
                AgentError::Limit,
                "连接数已达上限",
                None,
            ));
        }
        session.authenticated = true;
        session.client = client_label(params);
        conn.authenticated.store(true, Ordering::SeqCst);
        self.audit(
            "auth",
            "",
            &session.client,
            "ok",
            &json!({ "protocol": PROTOCOL_VERSION }),
        );
        GatewayResponse::reply(json!({
            "id": id,
            "ok": true,
            "result": {
                "protocol_version": PROTOCOL_VERSION,
                "server": SERVER_NAME,
                "tools": self.registry.tools().len(),
            },
        }))
    }

    /// 接受一条新连接（池检查 → 注册 → spawn 连接任务）。
    #[cfg(unix)]
    fn attach(me: &StdArc<Self>, stream: tokio::net::UnixStream) {
        let conn_id = me.shared.next_conn.fetch_add(1, Ordering::SeqCst);
        // 总连接位已满：新连接不可能再认证成功（认证还要再占一个位置），立即断开。
        {
            let conns = me.shared.connections.lock().unwrap();
            if conns.len() >= MAX_CONNECTIONS {
                return;
            }
        }
        // 未认证连接单独限额：超出的新连接立即断开（不等 5 秒认证超时）。
        {
            let mut pending = me.shared.pending.lock().unwrap();
            if pending.len() >= MAX_UNAUTHENTICATED_CONNECTIONS {
                return;
            }
            pending.insert(conn_id);
        }
        let this = me.clone();
        let task = tokio::spawn(async move { this.run_connection(stream, conn_id).await });
        me.shared.conn_aborts.lock().unwrap().insert(conn_id, task.abort_handle());
    }

    /// 一条连接的完整生命周期：reader（切帧/超限/认证超时）+ worker（串行派发）。
    #[cfg(unix)]
    async fn run_connection(
        self: StdArc<Self>,
        stream: tokio::net::UnixStream,
        conn_id: u64,
    ) {
        let (rd, wr) = stream.into_split();
        let wr = StdArc::new(tokio::sync::Mutex::new(wr));
        let authenticated = StdArc::new(AtomicBool::new(false));
        let inflight = StdArc::new(AtomicUsize::new(0));
        let (line_tx, line_rx) = tokio::sync::mpsc::channel::<String>(MAX_QUEUED_REQUESTS);
        let (close_tx, close_rx) = tokio::sync::watch::channel(false);
        let worker = {
            let this = self.clone();
            let wr = wr.clone();
            let control = ConnControl {
                conn_id,
                shared: self.shared.clone(),
                authenticated: authenticated.clone(),
            };
            let close_rx = close_rx.clone();
            let close_tx = close_tx.clone();
            let inflight = inflight.clone();
            tokio::spawn(async move {
                this.worker_loop(line_rx, wr, close_rx, close_tx, control, inflight).await
            })
        };
        self.reader_loop(rd, wr, line_tx, close_tx, close_rx, authenticated, inflight)
            .await;
        let _ = worker.await;
        self.shared.release(conn_id);
    }

    /// 读侧：按行切帧、消息上限、认证超时、排队上限。
    ///
    /// 连接断开（客户端退出/超限半关闭）后不再启动新的工具调用；
    /// 已经进入工具内部的调用无法中断（工具层没有贯穿取消信号），
    /// 这一层保证的是"断开后不再累积新工作"，配合排队上限形成有界队列（规格 §12.3 第 21 条）。
    #[cfg(unix)]
    #[allow(clippy::too_many_arguments)]
    async fn reader_loop(
        &self,
        mut rd: tokio::net::unix::OwnedReadHalf,
        wr: StdArc<tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>>,
        line_tx: tokio::sync::mpsc::Sender<String>,
        close_tx: tokio::sync::watch::Sender<bool>,
        mut close_rx: tokio::sync::watch::Receiver<bool>,
        authenticated: StdArc<AtomicBool>,
        inflight: StdArc<AtomicUsize>,
    ) {
        use tokio::io::AsyncReadExt;
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(self.auth_timeout_ms);
        let mut buf: Vec<u8> = Vec::new();
        let mut scratch = vec![0u8; 8192];
        loop {
            let authed = authenticated.load(Ordering::SeqCst);
            let read_fut = async {
                if authed {
                    Some(rd.read(&mut scratch).await)
                } else {
                    match tokio::time::timeout_at(deadline, rd.read(&mut scratch)).await {
                        Ok(r) => Some(r),
                        // 认证超时：qck 直接 destroy（不写响应），只记审计。
                        Err(_) => None,
                    }
                }
            };
            let read_result = tokio::select! {
                changed = close_rx.changed() => {
                    // worker 已要求关闭（认证失败/限流/排队超限的 close:true）。
                    let _ = changed;
                    break;
                }
                r = read_fut => r,
            };
            let Some(read_result) = read_result else {
                self.audit("auth", "", "external", "timeout", &Value::Null);
                break;
            };
            let n = match read_result {
                Ok(0) => break, // 对端关闭
                Ok(n) => n,
                Err(_) => break,
            };
            buf.extend_from_slice(&scratch[..n]);
            if buf.len() > MAX_MESSAGE_BYTES {
                // 只报一次并立即半关闭：否则后续 chunk 会反复触发同一条错误。
                // 尽力从"当前正在解析的那一行"取 id：调用方据此把错误关联到具体请求。
                let text = String::from_utf8_lossy(&buf);
                let id = extract_id_from_buffer(&text);
                self.write_payload(
                    &wr,
                    &limit_payload(id, "消息过大，已断开连接"),
                    true,
                )
                .await;
                let _ = close_tx.send(true);
                break;
            }
            let mut overflowed = false;
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1])
                    .trim()
                    .to_string();
                if line.is_empty() {
                    continue;
                }
                // inflight 含"排队中 + 正在处理"的请求数，与 qck 的 queued 计数语义一致：
                // 第 MAX_QUEUED_REQUESTS+1 条在入队时即被判定超限（qck 加固测试实测的边界）。
                let prev = inflight.fetch_add(1, Ordering::SeqCst);
                if prev >= MAX_QUEUED_REQUESTS {
                    inflight.fetch_sub(1, Ordering::SeqCst);
                    let id = extract_request_id(&line);
                    self.write_payload(
                        &wr,
                        &limit_payload(id, "请求排队过多，已断开连接"),
                        true,
                    )
                    .await;
                    let _ = close_tx.send(true);
                    overflowed = true;
                    break;
                }
                if line_tx.try_send(line.clone()).is_err() {
                    inflight.fetch_sub(1, Ordering::SeqCst);
                    let id = extract_request_id(&line);
                    self.write_payload(
                        &wr,
                        &limit_payload(id, "请求排队过多，已断开连接"),
                        true,
                    )
                    .await;
                    let _ = close_tx.send(true);
                    overflowed = true;
                    break;
                }
            }
            if overflowed {
                break;
            }
        }
        // 关闭 channel：worker 处理完已入队的请求后退出。
        drop(line_tx);
        drop(close_tx);
    }

    /// 写侧：一串行派发（含单连接限速与 JSON 解析错误兜底）。
    #[cfg(unix)]
    async fn worker_loop(
        self: StdArc<Self>,
        mut line_rx: tokio::sync::mpsc::Receiver<String>,
        wr: StdArc<tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>>,
        close_rx: tokio::sync::watch::Receiver<bool>,
        close_tx: tokio::sync::watch::Sender<bool>,
        control: ConnControl,
        inflight: StdArc<AtomicUsize>,
    ) {
        let mut session = Session::default();
        let mut window_start = (self.now_fn)();
        let mut window_count: u32 = 0;
        while let Some(line) = line_rx.recv().await {
            if *close_rx.borrow() {
                inflight.fetch_sub(1, Ordering::SeqCst);
                break;
            }
            let stop = self
                .dispatch_line(
                    &wr,
                    &close_tx,
                    &control,
                    &mut session,
                    &line,
                    &mut window_start,
                    &mut window_count,
                )
                .await;
            inflight.fetch_sub(1, Ordering::SeqCst);
            if stop {
                break;
            }
        }
    }

    /// 处理一行文本：JSON 解析 → 单连接限速 → handleMessage → 写回。
    /// 返回 true 表示这条连接应当停止（close:true / 限流）。
    #[cfg(unix)]
    #[allow(clippy::too_many_arguments)]
    async fn dispatch_line(
        &self,
        wr: &StdArc<tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>>,
        close_tx: &tokio::sync::watch::Sender<bool>,
        control: &ConnControl,
        session: &mut Session,
        line: &str,
        window_start: &mut i64,
        window_count: &mut u32,
    ) -> bool {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // 同样是"尽力提取 id"：适配器据此把"非法 JSON"直接判给对应请求，
                // 而不是等到超时（无 id 的响应会被适配器忽略）。
                self.write_payload(
                    wr,
                    &error_response(
                        extract_request_id(line),
                        AgentError::InvalidArg,
                        "请求不是合法 JSON",
                        None,
                    ),
                    false,
                )
                .await;
                return false;
            }
        };
        // 单连接限速：正常使用远达不到，异常情况（被错误地高频轮询）才触发。
        let t = (self.now_fn)();
        if t - *window_start >= 1000 {
            *window_start = t;
            *window_count = 0;
        }
        *window_count += 1;
        if *window_count > self.max_rps {
            let id = msg.get("id").cloned().unwrap_or(Value::Null);
            self.write_payload(
                wr,
                &limit_payload(id, "请求过于频繁，已断开连接"),
                true,
            )
            .await;
            let _ = close_tx.send(true);
            return true;
        }
        let response = self.handle_message(control, session, &msg).await;
        let close = response.close;
        self.write_payload(wr, &response.payload, close).await;
        if close {
            let _ = close_tx.send(true);
        }
        close
    }

    #[cfg(unix)]
    async fn write_payload(
        &self,
        wr: &StdArc<tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>>,
        payload: &Value,
        close: bool,
    ) {
        use tokio::io::AsyncWriteExt;
        let line = match serde_json::to_string(payload) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut guard = wr.lock().await;
        if guard.write_all(line.as_bytes()).await.is_err() {
            return;
        }
        if guard.write_all(b"\n").await.is_err() {
            return;
        }
        let _ = guard.flush().await;
        if close {
            // 半关闭写方向：对端先读完最后一行再看到 EOF（qck `socket.end()` 等价物；
            // qck 另有 200ms 后 destroy，Rust 在连接任务结束时 drop socket 即完整关闭）。
            let _ = guard.shutdown().await;
        }
    }
}

// ---------------------------------------------------------------------------
// 响应构造
// ---------------------------------------------------------------------------

fn error_response(
    id: Value,
    code: AgentError,
    message: &str,
    hint: Option<&str>,
) -> Value {
    let mut error = json!({ "code": code.as_str(), "message": message });
    if let Some(h) = hint {
        error["hint"] = json!(h);
    }
    json!({ "id": id, "ok": false, "error": error })
}

fn limit_payload(id: Value, message: &str) -> Value {
    error_response(id, AgentError::Limit, message, None)
}

/// 把任意 JSON 值按 qck `String(x || '')` 的语义转成标签字符串（只用于方法/工具名）。
fn label_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(_) => String::new(),
    }
}

/// 审计里只留定位问题所需的参数摘要（正文内容不落盘）。
///
/// 白名单与 qck `summarizeArgs` 一致；`text` 只记字节数（规格 §12.4 第 30 条）。
fn summarize_args(args: &Value) -> Value {
    const KEYS: [&str; 17] = [
        "fid",
        "fids",
        "pdir_fid",
        "parent_fid",
        "to_fid",
        "root_fid",
        "name",
        "keyword",
        "local_path",
        "local_dir",
        "path",
        "plan_id",
        "task_id",
        "action",
        "by",
        "limit",
        "max_bytes",
    ];
    let mut out = Map::new();
    for key in KEYS {
        if let Some(v) = args.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if let Some(text) = args.get("text").and_then(|v| v.as_str()) {
        out.insert("text_bytes".to_string(), json!(text.len()));
    }
    Value::Object(out)
}

/// `clientLabel(params)`：`[client, client_version].filter(Boolean).join('/') || 'unknown'`，
/// 截 64 字符并剔除 `[^\w.@/:+-]`（qck 的正则不含 u 标志，非 ASCII 字符同样被剔除）。
fn client_label(params: Option<&Value>) -> String {
    let name = params
        .and_then(|p| p.get("client"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let version = params
        .and_then(|p| p.get("client_version"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let raw = match (name.is_empty(), version.is_empty()) {
        (true, true) => "unknown".to_string(),
        (false, true) => name.to_string(),
        (true, false) => version.to_string(),
        (false, false) => format!("{name}/{version}"),
    };
    raw.chars()
        .take(64)
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | '/' | ':' | '+' | '-'))
        .collect()
}

// ---------------------------------------------------------------------------
// 请求 id 兜底提取
// ---------------------------------------------------------------------------

/// 从**一行（或一行被截断后的片段）**里尽力提取请求 id。
///
/// 为什么需要它：超限时服务端回 `{id, ok:false, error:{code:AGENT_LIMIT}}` 并断连；
/// 若 id 恒为 null，适配器无法把错误关联到具体请求，只能记日志并以 BRIDGE_CLOSED 收场，
/// 用户看到的是"连接断开"而不是"消息过大"（规格 §12.3 第 19 条）。
///
/// 步骤：
/// 1. 完整 JSON 且为对象、存在 `id` → 直接返回；
/// 2. 否则按字段名兜底：**锚定在对象开头**、只认标量字面量。锚定是刻意的：
///    两个真实客户端都是 `{ id, method, params }` 的顺序；若允许任意位置匹配，
///    `params` 里嵌套的同名字段会被当成请求 id —— 错配比返回 null 更糟。
pub fn extract_request_id(raw_segment: &str) -> Value {
    let text = raw_segment.trim();
    if text.is_empty() {
        return Value::Null;
    }
    // 1) 完整 JSON（队列超限时被丢弃的那一行就是完整的）
    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
        if let Value::Object(obj) = &parsed {
            if let Some(id) = obj.get("id") {
                return id.clone();
            }
        }
    }
    // 2) 被截断的 JSON：只扫头部，且只认标量字面量
    let scan: String = text.chars().take(ID_SCAN_BYTES).collect();
    extract_anchored_id(&scan).unwrap_or(Value::Null)
}

/// 手写 `^\s*\{\s*"id"\s*:\s*(标量)` 的锚定匹配（不引入正则依赖）。
///
/// 只接受字符串（可含转义、必须闭合）、数字、null、true、false；
/// 字符串在扫描上限处被截断（未闭合）时返回 None —— 与 qck 正则要求闭合引号一致。
fn extract_anchored_id(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let skip_ws = |i: &mut usize| {
        while *i < bytes.len() && bytes[*i].is_ascii_whitespace() {
            *i += 1;
        }
    };
    skip_ws(&mut i);
    if i >= bytes.len() || bytes[i] != b'{' {
        return None;
    }
    i += 1;
    skip_ws(&mut i);
    if i >= bytes.len() || bytes[i] != b'"' {
        return None;
    }
    i += 1;
    // 键名必须恰好是 id（"id" 后紧跟引号）
    if !text[i..].starts_with("id\"") {
        return None;
    }
    i += 3;
    skip_ws(&mut i);
    if i >= bytes.len() || bytes[i] != b':' {
        return None;
    }
    i += 1;
    skip_ws(&mut i);
    if i >= bytes.len() {
        return None;
    }
    match bytes[i] {
        b'"' => {
            let start = i;
            i += 1;
            let mut closed = false;
            while i < bytes.len() {
                match bytes[i] {
                    b'\\' => {
                        i += 2;
                    }
                    b'"' => {
                        i += 1;
                        closed = true;
                        break;
                    }
                    _ => i += 1,
                }
            }
            if !closed {
                return None;
            }
            let literal = &text[start..i];
            serde_json::from_str::<Value>(literal).ok()
        }
        b'n' => {
            if text[i..].starts_with("null") {
                Some(Value::Null)
            } else {
                None
            }
        }
        b't' => {
            if text[i..].starts_with("true") {
                Some(Value::Bool(true))
            } else {
                None
            }
        }
        b'f' => {
            if text[i..].starts_with("false") {
                Some(Value::Bool(false))
            } else {
                None
            }
        }
        b'-' | b'0'..=b'9' => {
            let start = i;
            if bytes[i] == b'-' {
                i += 1;
            }
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'.' {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
                i += 1;
                if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
                    i += 1;
                }
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            serde_json::from_str::<Value>(&text[start..i]).ok()
        }
        _ => None,
    }
}

/// 从接收缓冲区里取出"当前正在解析的那一行"并提取 id。
///
/// 缓冲区末尾若还没有换行，那一段就是正在累积的当前行；若正好以换行结束，
/// 则取最后一条非空行。**只取这一段**，不回退到更早的行：否则会把 A 请求的 id
/// 关联到 B 请求造成的超限错误上，比返回 null 更容易误导调用方。
pub fn extract_id_from_buffer(buffer: &str) -> Value {
    if buffer.is_empty() {
        return Value::Null;
    }
    for segment in buffer.split('\n').rev() {
        if segment.trim().is_empty() {
            continue;
        }
        return extract_request_id(segment);
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{ToolDef, ToolResult};
    use serde_json::json;
    use std::future::Future;
    use std::pin::Pin;
    use tempfile::TempDir;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
    use tokio::net::UnixStream;

    // -----------------------------------------------------------------------
    // 测试夹具
    // -----------------------------------------------------------------------

    struct MockSource {
        enabled: AtomicBool,
        token: String,
        scope: ScopeSnapshot,
    }

    impl MockSource {
        fn new(token: &str) -> Self {
            Self {
                enabled: AtomicBool::new(true),
                token: token.to_string(),
                scope: ScopeSnapshot {
                    remote_roots: vec!["root1".to_string()],
                    write_mode: "scoped-write".to_string(),
                    local_read_roots: Vec::new(),
                    local_write_roots: vec![std::path::PathBuf::from("/tmp/qk-gw-work")],
                },
            }
        }
    }

    impl ConfigSource for MockSource {
        fn access(&self) -> AccessSnapshot {
            AccessSnapshot {
                enabled: self.enabled.load(Ordering::SeqCst),
                token: self.token.clone(),
            }
        }
        fn scope(&self) -> ScopeSnapshot {
            self.scope.clone()
        }
        fn generation(&self) -> u64 {
            7
        }
    }

    #[derive(Default)]
    struct MockRegistry {
        gate: tokio::sync::Notify,
        slow_started: tokio::sync::Notify,
    }

    impl ToolRegistry for MockRegistry {
        fn tools(&self) -> Vec<ToolDef> {
            vec![
                ToolDef {
                    name: "list_dir",
                    description: "列出目录",
                    parameters: json!({ "type": "object", "properties": { "pdir_fid": { "type": "string" } } }),
                    requires_write: false,
                },
                ToolDef {
                    name: "fail_tool",
                    description: "总是失败",
                    parameters: json!({ "type": "object", "properties": {} }),
                    requires_write: false,
                },
                ToolDef {
                    name: "slow_tool",
                    description: "会挂起的工具",
                    parameters: json!({ "type": "object", "properties": {} }),
                    requires_write: false,
                },
            ]
        }

        fn call_tool<'a>(
            &'a self,
            ctx: &'a ToolContext,
            name: &'a str,
            args: &'a Value,
        ) -> Pin<Box<dyn Future<Output = ToolResult> + Send + 'a>> {
            Box::pin(async move {
                match name {
                    "list_dir" => Ok(json!({
                        "pdir_fid": args.get("pdir_fid").cloned().unwrap_or(json!("root1")),
                        "list": [],
                        "actor": ctx.actor,
                        "generation": ctx.generation,
                        "remote_roots": ctx.scope.remote_roots,
                    })),
                    "fail_tool" => Err(AgentToolError::new(AgentError::OutOfScope, "不在授权目录内")
                        .with_hint("请在设置中添加该目录")),
                    "slow_tool" => {
                        self.slow_started.notify_one();
                        self.gate.notified().await;
                        Ok(json!({ "ok": true }))
                    }
                    _ => Err(AgentToolError::new(AgentError::InvalidArg, format!("未知工具：{name}"))),
                }
            })
        }
    }

    struct Harness {
        _tmp: TempDir,
        gateway: StdArc<AgentGateway>,
        endpoint: String,
        source: StdArc<MockSource>,
        registry: StdArc<MockRegistry>,
        journal: StdArc<Journal>,
    }

    async fn harness_with(auth_timeout_ms: u64) -> Harness {
        harness_with_clock(auth_timeout_ms, None).await
    }

    async fn harness_with_clock(auth_timeout_ms: u64, now: Option<NowFn>) -> Harness {
        let tmp = TempDir::new().unwrap();
        let endpoint = tmp.path().join("g.sock").to_string_lossy().to_string();
        let source = StdArc::new(MockSource::new("tok-0123456789abcdef"));
        let registry = StdArc::new(MockRegistry::default());
        let journal = StdArc::new(Journal::open(&tmp.path().join("journal")).unwrap());
        let mut gateway = AgentGateway::new(source.clone(), registry.clone(), journal.clone())
            .with_auth_timeout_ms(auth_timeout_ms);
        if let Some(now) = now {
            gateway = gateway.with_now(now);
        }
        let gateway = StdArc::new(gateway);
        gateway.clone().start(&endpoint).await.unwrap();
        Harness { _tmp: tmp, gateway, endpoint, source, registry, journal }
    }

    struct Conn {
        wr: OwnedWriteHalf,
        rd: BufReader<OwnedReadHalf>,
    }

    async fn connect(endpoint: &str) -> Conn {
        let stream = UnixStream::connect(endpoint).await.unwrap();
        let (rd, wr) = stream.into_split();
        Conn { wr, rd: BufReader::new(rd) }
    }

    impl Conn {
        async fn send(&mut self, value: &Value) {
            let mut line = serde_json::to_string(value).unwrap();
            line.push('\n');
            self.wr.write_all(line.as_bytes()).await.unwrap();
        }

        async fn send_raw(&mut self, text: &str) {
            self.wr.write_all(text.as_bytes()).await.unwrap();
        }

        async fn next(&mut self) -> Value {
            self.next_opt().await.expect("连接在收到响应前已关闭")
        }

        async fn next_opt(&mut self) -> Option<Value> {
            loop {
                let mut line = String::new();
                let n = tokio::time::timeout(Duration::from_secs(5), self.rd.read_line(&mut line))
                    .await
                    .expect("等待响应超时")
                    .unwrap();
                if n == 0 {
                    return None;
                }
                if line.trim().is_empty() {
                    continue;
                }
                return Some(serde_json::from_str(&line).expect("响应必须是 JSON"));
            }
        }

        /// 断言连接在给定时间内被服务端关闭（读到 EOF）。
        async fn expect_closed(&mut self, ms: u64) {
            let mut buf = [0u8; 64];
            let r = tokio::time::timeout(Duration::from_millis(ms), self.rd.read(&mut buf)).await;
            match r {
                Ok(Ok(0)) => {}
                Ok(Ok(_)) => panic!("收到意外数据，连接未被关闭"),
                Ok(Err(_)) => {}
                Err(_) => panic!("连接在 {ms}ms 内未被关闭"),
            }
        }

        async fn authed(&mut self, token: &str) -> Value {
            self.send(&json!({ "id": "auth", "method": "auth", "params": { "token": token, "client": "test" } }))
                .await;
            let res = self.next().await;
            assert_eq!(res["ok"], true, "认证应当成功：{res}");
            res
        }
    }

    // -----------------------------------------------------------------------
    // 1. 请求 id 兜底提取（qck 加固测试 1 的单元断言）
    // -----------------------------------------------------------------------

    #[test]
    fn extract_request_id_anchors_at_object_and_only_takes_scalars() {
        assert_eq!(extract_request_id("{\"id\":\"a\",\"method\":\"ping\"}"), json!("a"));
        // 被截断的 JSON 走字段名兜底
        assert_eq!(extract_request_id("{\"id\":\"a\",\"method\":\"ping\""), json!("a"));
        assert_eq!(extract_request_id("{\"id\":7,\"method\":\"ping\""), json!(7));
        assert_eq!(extract_request_id("{\"id\": -1.5e2}"), json!(-150.0));
        assert_eq!(extract_request_id("{\"id\":true}"), json!(true));
        assert_eq!(extract_request_id("{\"method\":\"ping\""), Value::Null);
        assert_eq!(extract_request_id("{\"id\":null}"), Value::Null);
        assert_eq!(extract_request_id("不是 JSON"), Value::Null);
        assert_eq!(extract_request_id(""), Value::Null);
        assert_eq!(extract_request_id("   "), Value::Null);
        // 嵌套 params.id 不得被当作请求 id（锚定对象开头）
        assert_eq!(
            extract_request_id("{\"method\":\"tools.call\",\"params\":{\"id\":\"nested\",\"text\":\"aaa"),
            Value::Null
        );
        // 字符串未闭合（在扫描上限内被截断）→ null
        assert_eq!(extract_request_id("{\"id\":\"abc"), Value::Null);
        // 转义引号的字符串
        assert_eq!(extract_request_id("{\"id\":\"a\\\"b\",\"method\":\"ping\""), json!("a\"b"));
    }

    #[test]
    fn extract_id_from_buffer_takes_only_the_current_line() {
        assert_eq!(extract_id_from_buffer("{\"id\":\"old\"}\n{\"id\":\"cur\",\"text\":\"aaa"), json!("cur"));
        assert_eq!(extract_id_from_buffer("{\"id\":\"only\"}\n"), json!("only"));
        assert_eq!(extract_id_from_buffer("   \n  "), Value::Null);
        assert_eq!(extract_id_from_buffer(""), Value::Null);
    }

    #[test]
    fn message_limit_exceeds_tool_text_limit() {
        // 规格 §12.3 第 18 条：网关整行上限必须严格大于工具文本参数上限。
        assert!(
            MAX_MESSAGE_BYTES > crate::tools::MAX_TEXT_BYTES,
            "MAX_MESSAGE_BYTES 必须大于 tools::MAX_TEXT_BYTES"
        );
        assert!(MAX_UNAUTHENTICATED_CONNECTIONS < MAX_CONNECTIONS);
    }

    // -----------------------------------------------------------------------
    // 2. 认证
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn unauthenticated_connection_only_accepts_auth_ping_hello() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        c.send(&json!({ "id": "1", "method": "tools.list" })).await;
        let res = c.next().await;
        assert_eq!(res["ok"], false);
        assert_eq!(res["id"], json!("1"));
        assert_eq!(res["error"]["code"], "AGENT_UNAUTHORIZED");
        // ping / hello 未认证也可用
        c.send(&json!({ "id": "2", "method": "ping" })).await;
        assert_eq!(c.next().await["ok"], true);
        c.send(&json!({ "id": "3", "method": "hello" })).await;
        let hello = c.next().await;
        assert_eq!(hello["result"]["authenticated"], false);
        assert_eq!(hello["result"]["requires_auth"], true);
        assert_eq!(hello["result"]["protocol_version"], 1);
        assert_eq!(hello["result"]["server"], "quark-mini");
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn wrong_token_is_rejected_closed_and_audited_without_leaking() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        let submitted = "deadbeef".repeat(8);
        c.send(&json!({ "id": "1", "method": "auth", "params": { "token": submitted, "client": "evil" } }))
            .await;
        let res = c.next().await;
        assert_eq!(res["ok"], false);
        assert_eq!(res["error"]["code"], "AGENT_UNAUTHORIZED");
        assert!(!serde_json::to_string(&res).unwrap().contains(&submitted));
        c.expect_closed(2000).await;
        let rows = h.journal.list(20, None);
        assert!(
            rows.iter().any(|r| r["kind"] == "auth" && r["result"] == "rejected"),
            "应记录 auth/rejected"
        );
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn auth_success_lists_tools_and_returns_protocol_metadata() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        let auth = c.authed(&h.source.token).await;
        assert_eq!(auth["result"]["protocol_version"], 1);
        assert_eq!(auth["result"]["server"], "quark-mini");
        assert_eq!(auth["result"]["tools"], 3);
        c.send(&json!({ "id": "l", "method": "tools.list" })).await;
        let list = c.next().await;
        assert_eq!(list["ok"], true);
        let tools = list["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"list_dir"));
        assert!(names.contains(&"fail_tool"));
        // 字段契约与 qck 一致
        assert_eq!(tools[0]["title"], "");
        assert_eq!(tools[0]["annotations"], json!({}));
        assert!(tools[0]["inputSchema"].is_object());
        // 工具清单不得包含凭据
        assert!(!serde_json::to_string(&list).unwrap().contains(&h.source.token));
        // 审计里有 auth/ok
        let rows = h.journal.list(20, None);
        assert!(rows.iter().any(|r| r["kind"] == "auth" && r["result"] == "ok"));
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn repeated_auth_on_authenticated_connection_is_idempotent_even_when_pool_is_full() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut conns = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let mut c = connect(&h.endpoint).await;
            c.authed(&h.source.token).await;
            conns.push(c);
        }
        assert_eq!(h.gateway.status()["connections"], MAX_CONNECTIONS);
        // 池满时，已在池内的连接重复 auth 不得被误杀
        let first = &mut conns[0];
        first
            .send(&json!({ "id": "re", "method": "auth", "params": { "token": h.source.token, "client": "c0" } }))
            .await;
        let res = first.next().await;
        assert_eq!(res["ok"], true, "重复 auth 不应被连接上限拒绝：{res}");
        first.send(&json!({ "id": "p", "method": "ping" })).await;
        assert_eq!(first.next().await["ok"], true);
        drop(conns);
        h.gateway.stop().await;
    }

    // -----------------------------------------------------------------------
    // 3. 认证超时
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn auth_timeout_closes_connection_and_is_audited() {
        // 缩短超时（常量语义不变，只是测试不等待 5 秒）。
        let h = harness_with(200).await;
        let mut c = connect(&h.endpoint).await;
        c.send(&json!({ "id": "ping", "method": "ping" })).await;
        assert_eq!(c.next().await["ok"], true);
        c.expect_closed(2000).await;
        let rows = h.journal.list(20, None);
        assert!(
            rows.iter().any(|r| r["kind"] == "auth" && r["result"] == "timeout"),
            "认证超时应被审计"
        );
        h.gateway.stop().await;
    }

    // -----------------------------------------------------------------------
    // 4. 消息上限与 id 关联
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn oversized_message_returns_limit_with_request_id() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        c.authed(&h.source.token).await;
        // id 放在最前面；正文顶到超过上限，使整行既超限、又在被截断后无法整体解析
        let pad = "a".repeat(MAX_MESSAGE_BYTES + 4096);
        let line = format!("{{\"id\":\"big-req-1\",\"method\":\"tools.call\",\"params\":{{\"name\":\"list_dir\",\"arguments\":{{\"pad\":\"{pad}\"}}}}}}\n");
        c.send_raw(&line).await;
        let res = c.next().await;
        assert_eq!(res["ok"], false);
        assert_eq!(res["error"]["code"], "AGENT_LIMIT");
        assert_eq!(res["id"], json!("big-req-1"));
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn oversized_message_without_id_returns_null_id() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        c.authed(&h.source.token).await;
        let pad = "b".repeat(MAX_MESSAGE_BYTES + 4096);
        let line = format!("{{\"method\":\"tools.call\",\"params\":{{\"name\":\"list_dir\",\"arguments\":{{\"pad\":\"{pad}\"}}}}}}\n");
        c.send_raw(&line).await;
        let res = c.next().await;
        assert_eq!(res["error"]["code"], "AGENT_LIMIT");
        assert_eq!(res["id"], Value::Null);
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn queue_overflow_returns_the_dropped_line_id() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        c.authed(&h.source.token).await;
        // 一次性灌入 MAX_QUEUED_REQUESTS + 1 条慢请求：第 (MAX_QUEUED_REQUESTS+1) 条在入队时判定超限。
        let mut payload = String::new();
        for i in 0..=MAX_QUEUED_REQUESTS {
            payload.push_str(&format!(
                "{}\n",
                json!({ "id": format!("q{i}"), "method": "tools.call", "params": { "name": "slow_tool", "arguments": {} } })
            ));
        }
        c.send_raw(&payload).await;
        // 第一条被 worker 取走后开始执行（挂起），其余排队直到超限。
        let mut found = None;
        for _ in 0..=MAX_QUEUED_REQUESTS {
            let msg = c.next().await;
            if msg["error"]["code"] == "AGENT_LIMIT" {
                found = Some(msg);
                break;
            }
        }
        let res = found.expect("应收到排队超限响应");
        assert_eq!(res["id"], json!(format!("q{MAX_QUEUED_REQUESTS}")));
        // 放行挂起的工具，避免测试结束时有任务悬挂
        h.registry.gate.notify_one();
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn invalid_json_returns_id_and_connection_survives() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        c.authed(&h.source.token).await;
        c.send_raw("{\"id\":\"bad-1\",\"method\":\"ping\"\n").await;
        let bad = c.next().await;
        assert_eq!(bad["ok"], false);
        assert_eq!(bad["error"]["code"], "AGENT_INVALID_ARG");
        assert!(bad["error"]["message"].as_str().unwrap().contains("不是合法 JSON"));
        assert_eq!(bad["id"], json!("bad-1"));
        // 非法 JSON 不关闭连接
        c.send(&json!({ "id": "ok", "method": "ping" })).await;
        assert_eq!(c.next().await["ok"], true);
        h.gateway.stop().await;
    }

    // -----------------------------------------------------------------------
    // 5. 单连接限速
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn rate_limit_triggers_at_boundary_with_request_id() {
        // 冻结时钟：窗口（1 秒）不会中途重置，第 51 条必定触发（qck 加固测试同法）。
        let h = harness_with_clock(AUTH_TIMEOUT_MS, Some(StdArc::new(|| 1))).await;
        let mut c = connect(&h.endpoint).await;
        c.authed(&h.source.token).await;
        let mut limit = None;
        let mut seq = 0;
        // 分批发送并读回，避免排队上限先被触发。
        'outer: for _batch in 0..6 {
            let mut ids = Vec::new();
            for _ in 0..20 {
                seq += 1;
                ids.push(format!("r{seq}"));
            }
            for id in &ids {
                c.send(&json!({ "id": id, "method": "ping" })).await;
            }
            for id in &ids {
                let res = c.next().await;
                if res["error"]["code"] == "AGENT_LIMIT" {
                    limit = Some((id.clone(), res));
                    break 'outer;
                }
            }
        }
        let (id, res) = limit.expect("连续请求应触发单连接限速");
        assert_eq!(res["id"], json!(id), "限速错误必须带上该请求的 id");
        h.gateway.stop().await;
    }

    // -----------------------------------------------------------------------
    // 6. 连接池
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn unauthenticated_pool_limit_rejects_new_connections_immediately() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        // 合法适配器先认证：随后即使未认证池被灌满，它也必须继续可用
        let mut legit = connect(&h.endpoint).await;
        legit.authed(&h.source.token).await;
        let mut idle = Vec::new();
        for _ in 0..MAX_UNAUTHENTICATED_CONNECTIONS {
            idle.push(connect(&h.endpoint).await);
        }
        // 再来一条就超限：必须立即断开（远早于认证超时）
        let mut extra = connect(&h.endpoint).await;
        extra.expect_closed(200).await;
        // 已认证连接不受影响
        legit.send(&json!({ "id": "p", "method": "ping" })).await;
        assert_eq!(legit.next().await["ok"], true);
        // 释放未认证池后可以重新认证（不是永久锁死）
        drop(idle);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut fresh = connect(&h.endpoint).await;
        fresh.authed(&h.source.token).await;
        drop((fresh, legit));
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn authenticated_pool_limit_rejects_new_connection() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut conns = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let mut c = connect(&h.endpoint).await;
            c.authed(&h.source.token).await;
            conns.push(c);
        }
        let mut extra = connect(&h.endpoint).await;
        extra.expect_closed(500).await;
        drop(conns);
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn status_reports_connections_tools_and_calls() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        c.authed(&h.source.token).await;
        c.send(&json!({ "id": "call", "method": "tools.call", "params": { "name": "list_dir", "arguments": {} } }))
            .await;
        let call = c.next().await;
        assert_eq!(call["ok"], true);
        // 工具上下文：actor 来自认证的 client label（test），generation/scope 实时取自 ConfigSource
        assert_eq!(call["result"]["actor"], "test");
        assert_eq!(call["result"]["generation"], 7);
        assert_eq!(call["result"]["remote_roots"], json!(["root1"]));
        c.send(&json!({ "id": "st", "method": "status" })).await;
        let st = c.next().await;
        let result = &st["result"];
        assert_eq!(result["protocolVersion"], 1);
        assert_eq!(result["connections"], 1);
        assert_eq!(result["callsServed"], 1);
        assert_eq!(result["toolCount"], 3);
        assert_eq!(result["running"], true);
        assert_eq!(result["endpoint"], h.endpoint);
        drop(c);
        h.gateway.stop().await;
    }

    // -----------------------------------------------------------------------
    // 7. tools.call 错误形状与审计
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn tool_error_carries_code_hint_and_is_audited() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let mut c = connect(&h.endpoint).await;
        c.authed(&h.source.token).await;
        // 先来一条成功调用（审计必须同时覆盖 ok 与 error）
        c.send(&json!({ "id": "ok", "method": "tools.call", "params": { "name": "list_dir", "arguments": {} } }))
            .await;
        assert_eq!(c.next().await["ok"], true);
        c.send(&json!({ "id": "f", "method": "tools.call", "params": { "name": "fail_tool", "arguments": {} } }))
            .await;
        let res = c.next().await;
        assert_eq!(res["ok"], false);
        assert_eq!(res["error"]["code"], "AGENT_OUT_OF_SCOPE");
        assert_eq!(res["error"]["hint"], "请在设置中添加该目录");
        // 未知工具 → INVALID_ARG
        c.send(&json!({ "id": "u", "method": "tools.call", "params": { "name": "nope", "arguments": {} } }))
            .await;
        let unknown = c.next().await;
        assert_eq!(unknown["error"]["code"], "AGENT_INVALID_ARG");
        assert!(unknown["error"]["message"].as_str().unwrap().contains("未知工具"));
        // 审计：ok / error 都有，且不落盘凭据
        let rows = h.journal.list(50, None);
        assert!(rows.iter().any(|r| r["kind"] == "tool_call" && r["result"] == "error"));
        assert!(rows.iter().any(|r| r["kind"] == "tool_call" && r["result"] == "ok"));
        assert!(!serde_json::to_string(&rows).unwrap().contains(&h.source.token));
        h.gateway.stop().await;
    }

    #[tokio::test]
    async fn disabled_source_blocks_start_and_calls() {
        let tmp = TempDir::new().unwrap();
        let endpoint = tmp.path().join("g.sock").to_string_lossy().to_string();
        let source = StdArc::new(MockSource::new("tok-x"));
        source.enabled.store(false, Ordering::SeqCst);
        let registry = StdArc::new(MockRegistry::default());
        let journal = StdArc::new(Journal::open(&tmp.path().join("journal")).unwrap());
        let gateway = StdArc::new(AgentGateway::new(source.clone(), registry, journal));
        let err = gateway.clone().start(&endpoint).await.unwrap_err();
        assert_eq!(err.code, AgentError::Disabled);
        assert_eq!(gateway.status()["running"], false);

        // 已认证后再停用：凭据正确也拒绝工具调用
        source.enabled.store(true, Ordering::SeqCst);
        gateway.clone().start(&endpoint).await.unwrap();
        let mut c = connect(&endpoint).await;
        c.authed("tok-x").await;
        source.enabled.store(false, Ordering::SeqCst);
        c.send(&json!({ "id": "x", "method": "tools.call", "params": { "name": "list_dir", "arguments": {} } }))
            .await;
        let res = c.next().await;
        assert_eq!(res["error"]["code"], "AGENT_DISABLED");
        assert_eq!(gateway.status()["authFailures"], 0);
        drop(c);
        gateway.stop().await;
    }

    // -----------------------------------------------------------------------
    // 8. handle_message 输入校验（qck 加固测试 3）
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn handle_message_rejects_non_object_and_non_string_method() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        let control = h.gateway.test_control();
        let mut session = Session::default();
        // 非对象/数组 → "请求必须是 JSON 对象"，id=null
        for bad in [json!(123), json!("x"), json!([1, 2]), Value::Null] {
            let r = h.gateway.handle_message(&control, &mut session, &bad).await;
            assert_eq!(r.payload["ok"], false);
            assert_eq!(r.payload["error"]["code"], "AGENT_INVALID_ARG");
            assert_eq!(r.payload["error"]["message"], "请求必须是 JSON 对象");
            assert_eq!(r.payload["id"], Value::Null);
        }
        // 非字符串 method → 明确拒绝（早期 String() 强转会让 ["ping"] 通过）
        for bad in [json!(["ping"]), json!({}), json!(42), json!(true)] {
            let r = h
                .gateway
                .handle_message(&control, &mut session, &json!({ "id": "u1", "method": bad }))
                .await;
            assert_eq!(r.payload["error"]["code"], "AGENT_INVALID_ARG");
            assert_eq!(r.payload["error"]["message"], "method 必须是字符串");
            assert_eq!(r.payload["id"], json!("u1"));
        }
        // 缺失 method
        let r = h.gateway.handle_message(&control, &mut session, &json!({ "id": "u2" })).await;
        assert_eq!(r.payload["error"]["message"], "缺少 method 字段");
        // ping 放行
        let r = h
            .gateway
            .handle_message(&control, &mut session, &json!({ "id": "u3", "method": "ping" }))
            .await;
        assert_eq!(r.payload["ok"], true);
        // 未认证的 tools.call → UNAUTHORIZED
        let r = h
            .gateway
            .handle_message(&control, &mut session, &json!({ "id": "u4", "method": "tools.call" }))
            .await;
        assert_eq!(r.payload["error"]["code"], "AGENT_UNAUTHORIZED");
        // 认证成功：close 标志不进入响应体
        let r = h
            .gateway
            .handle_message(
                &control,
                &mut session,
                &json!({ "id": "a", "method": "auth", "params": { "token": h.source.token } }),
            )
            .await;
        assert_eq!(r.payload["ok"], true);
        assert!(!r.payload.as_object().unwrap().contains_key("close"));
        assert_eq!(r.close, false);
        h.gateway.stop().await;
    }

    // -----------------------------------------------------------------------
    // 9. start/stop 生命周期
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn start_is_idempotent_stop_removes_socket_and_is_safe_to_repeat() {
        let h = harness_with(AUTH_TIMEOUT_MS).await;
        assert!(Path::new(&h.endpoint).exists());
        // 幂等：再次 start 不报错也不换端点
        h.gateway.clone().start(&h.endpoint).await.unwrap();
        // 断连后 stop 删除 socket 文件
        let mut c = connect(&h.endpoint).await;
        c.authed(&h.source.token).await;
        h.gateway.stop().await;
        assert!(!Path::new(&h.endpoint).exists(), "stop 后 socket 文件应被删除");
        assert_eq!(h.gateway.status()["running"], false);
        // 重复 stop 安全
        h.gateway.stop().await;
        // 审计里有 started/stopped
        let rows = h.journal.list(50, None);
        assert!(rows.iter().any(|r| r["kind"] == "gateway" && r["result"] == "started"));
        assert!(rows.iter().any(|r| r["kind"] == "gateway" && r["result"] == "stopped"));
        drop(c);
    }

    #[tokio::test]
    async fn stale_socket_file_is_replaced_but_regular_file_is_refused() {
        let tmp = TempDir::new().unwrap();
        let source = StdArc::new(MockSource::new("tok-y"));
        let registry = StdArc::new(MockRegistry::default());
        let journal = StdArc::new(Journal::open(&tmp.path().join("journal")).unwrap());
        let gateway = StdArc::new(AgentGateway::new(source.clone(), registry, journal));
        // 普通文件占位 → 明确拒绝，且不得误删用户文件
        let occupied = tmp.path().join("occupied.sock");
        std::fs::write(&occupied, b"user data").unwrap();
        let err = gateway.clone().start(&occupied.to_string_lossy()).await.unwrap_err();
        assert_eq!(err.code, AgentError::Internal);
        assert!(err.message.contains("不是 socket 文件"));
        assert_eq!(std::fs::read(&occupied).unwrap(), b"user data");
        // 残留 socket（上一次进程遗留）→ 清理并成功监听
        let stale = tmp.path().join("stale.sock");
        {
            let _ = std::os::unix::net::UnixListener::bind(&stale).unwrap();
        }
        assert!(stale.exists());
        gateway.clone().start(&stale.to_string_lossy()).await.unwrap();
        assert_eq!(gateway.status()["running"], true);
        gateway.stop().await;
    }

    // -----------------------------------------------------------------------
    // 10. 工具上下文与审计参数摘要
    // -----------------------------------------------------------------------

    #[test]
    fn summarize_args_keeps_whitelist_and_text_bytes_only() {
        let args = json!({
            "fid": "f1",
            "pdir_fid": "p1",
            "text": "你好",
            "cookie": "SID=1",
            "nested": { "x": 1 },
            "limit": 10,
        });
        let out = summarize_args(&args);
        assert_eq!(out["fid"], "f1");
        assert_eq!(out["pdir_fid"], "p1");
        assert_eq!(out["limit"], 10);
        assert_eq!(out["text_bytes"], 6);
        assert!(out.get("text").is_none(), "正文内容不得落盘");
        assert!(out.get("cookie").is_none(), "非白名单键不得落盘");
        assert!(out.get("nested").is_none());
    }

    #[test]
    fn client_label_trims_sanitizes_and_falls_back_to_unknown() {
        assert_eq!(client_label(None), "unknown");
        assert_eq!(client_label(Some(&json!({}))), "unknown");
        assert_eq!(
            client_label(Some(&json!({ "client": "mcp client", "client_version": "1.0" }))),
            "mcpclient/1.0"
        );
        assert_eq!(client_label(Some(&json!({ "client": "只读客户端" }))), "");
        let long = "a".repeat(100);
        assert_eq!(
            client_label(Some(&json!({ "client": long }))).chars().count(),
            64
        );
    }
}
