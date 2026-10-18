//! Agent 子系统装配（宿主无关）。
//!
//! 把配置、操作记录、计划仓库、工具集与网关组装成一个对象交给 src-tauri，
//! 让主进程入口只负责"装配 + 分发"，不承担 Agent 的具体逻辑（qck index.js 同构）。
//!
//! 生命周期约定（与 qck 一致）：
//! - 网关只在客户端运行时存在；退出即消失，外部适配器连接失败并给出明确提示。
//! - 启用/停用由用户在 GUI 中显式操作；停用立即删除桥接凭据文件。
//! - 修改授权范围不需要重启网关：网关每次调用都从配置读取最新范围。

use crate::chat::{AgentChat, EventCallback};
use crate::chat_config::ChatConfigManager;
use crate::config::{
    read_bridge_credentials, AgentConfigManager, ScopeSnapshot,
};
use crate::gateway::{AccessSnapshot, AgentGateway, ConfigSource};
use crate::journal::Journal;
use crate::plans::PlanStore;
use crate::policy::{AgentError, AgentToolError};
use crate::registry::ToolRegistry;
use crate::tools::{HostDeps, QuarkTools};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 本机桥接端点（Unix socket；超长回退 tmpdir）。
///
/// 端点本身不是秘密（真正授权凭据是 token），但仍不适合出现在普通日志里。
pub fn resolve_bridge_endpoint(profile_dir: &Path, token: &str) -> String {
    #[cfg(windows)]
    {
        format!("\\\\.\\pipe\\quark-mini-agent-{}", &token[..token.len().min(12)])
    }
    #[cfg(not(windows))]
    {
        let candidate = profile_dir.join("agent").join("bridge.sock");
        if candidate.to_string_lossy().chars().count() <= 100 {
            return candidate.to_string_lossy().to_string();
        }
        let tmp = std::env::temp_dir().join(format!("qk-agent-{}.sock", &token[..token.len().min(12)]));
        tmp.to_string_lossy().to_string()
    }
}

/// 配置源适配：网关每次都从这里实时读取开关/凭据/范围（不缓存）。
pub struct ConfigSourceAdapter {
    pub config: Arc<Mutex<AgentConfigManager>>,
    /// 真实会话 generation（由宿主注入；工具层的会话绑定调用需要）。
    pub generation: Arc<dyn Fn() -> u64 + Send + Sync>,
}


impl ConfigSource for ConfigSourceAdapter {
    fn access(&self) -> AccessSnapshot {
        let mut mgr = self.config.lock().unwrap();
        let cfg = mgr.get();
        AccessSnapshot { enabled: cfg.enabled && !cfg.token.is_empty(), token: cfg.token }
    }

    fn scope(&self) -> ScopeSnapshot {
        let mut mgr = self.config.lock().unwrap();
        mgr.get().scope()
    }

    fn generation(&self) -> u64 {
        (self.generation)()
    }
}

/// Agent 子系统。
pub struct AgentRuntime {
    pub profile_dir: PathBuf,
    pub config: Arc<Mutex<AgentConfigManager>>,
    pub journal: Arc<Journal>,
    pub plans: Arc<PlanStore>,
    pub tools: Arc<QuarkTools>,
    pub gateway: Arc<AgentGateway>,
    /// 内置对话引擎（与外部 Agent 共用同一份工具集与授权范围）。
    pub chat: Arc<AgentChat>,
    pub chat_config: Arc<ChatConfigManager>,
    /// 工具层宿主的会话 generation 提供者（真实 Core 的 generation）。
    pub generation: Arc<dyn Fn() -> u64 + Send + Sync>,
}


impl AgentRuntime {
    pub fn new(
        profile_dir: PathBuf,
        deps: Arc<dyn HostDeps>,
        generation: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Result<Arc<Self>, AgentToolError> {
        let mut mgr = AgentConfigManager::open(&profile_dir)
            .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法初始化 Agent 配置：{e}")))?;
        let _ = mgr.get();
        let config = Arc::new(Mutex::new(mgr));
        let journal = Arc::new(
            Journal::open(&profile_dir.join("agent"))
                .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法初始化操作记录：{e}")))?,
        );
        let plans = Arc::new(PlanStore::new());
        let tools = Arc::new(QuarkTools::new(
            deps,
            journal.clone(),
            plans.clone(),
        ));
        let source = Arc::new(ConfigSourceAdapter {
            config: config.clone(),
            generation: generation.clone(),
        });
        let gateway = Arc::new(AgentGateway::new(
            source.clone(),
            tools.clone() as Arc<dyn ToolRegistry>,
            journal.clone(),
        ));
        let chat_config = Arc::new(
            ChatConfigManager::open(&profile_dir)
                .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法初始化对话配置：{e}")))?,
        );
        let chat = Arc::new(AgentChat::new(
            source,
            tools.clone() as Arc<dyn ToolRegistry>,
            chat_config.clone(),
            Some(journal.clone()),
        ));
        Ok(Arc::new(Self {
            profile_dir,
            config,
            journal,
            plans,
            tools,
            gateway,
            chat,
            chat_config,
            generation,
        }))
    }

    /// 启动时调用：若已启用则启动网关；失败不阻断客户端启动（只记状态）。
    pub async fn boot(&self) {
        let active = {
            let mut mgr = self.config.lock().unwrap();
            let cfg = mgr.get();
            cfg.enabled && !cfg.token.is_empty()
        };
        if !active {
            return;
        }
        if let Err(e) = self.start_gateway().await {
            eprintln!("[agent] 网关启动失败：{}", e.message);
        }
    }

    async fn start_gateway(&self) -> Result<(), AgentToolError> {
        let endpoint = {
            let mut mgr = self.config.lock().unwrap();
            let (cfg, endpoint) = mgr.activate(
                |token| resolve_bridge_endpoint(&self.profile_dir, token),
                crate::journal::now_ms(),
            )?;
            debug_assert!(cfg.enabled);
            endpoint
        };
        self.gateway.clone().start(&endpoint).await?;
        Ok(())
    }

    /// 启用：写凭据文件并启动监听。
    pub async fn enable(&self, patch: &Value) -> Result<Value, AgentToolError> {
        if patch.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            let mut mgr = self.config.lock().unwrap();
            mgr.update(patch, crate::journal::now_ms())?;
        }
        let started = self.start_gateway().await;
        if let Err(e) = started {
            let mut mgr = self.config.lock().unwrap();
            let _ = mgr.deactivate(crate::journal::now_ms());
            return Err(e);
        }
        self.journal.append("config", "", "user", "enabled", &Value::Null, &json!({}));
        Ok(self.status())
    }

    pub async fn disable(&self) -> Result<Value, AgentToolError> {
        self.gateway.stop().await;
        {
            let mut mgr = self.config.lock().unwrap();
            mgr.deactivate(crate::journal::now_ms())?;
        }
        self.journal.append("config", "", "user", "disabled", &Value::Null, &json!({}));
        Ok(self.status())
    }

    /// 修改授权范围/写入模式（运行中无需重启）。
    pub fn update_scope(&self, patch: &Value) -> Result<Value, AgentToolError> {
        let before = {
            let mut mgr = self.config.lock().unwrap();
            mgr.get()
        };
        let after = {
            let mut mgr = self.config.lock().unwrap();
            mgr.update(patch, crate::journal::now_ms())?
        };
        let changed = json!({
            "write_mode": before.write_mode != after.write_mode,
            "remote_roots": before.remote_roots.len() != after.remote_roots.len(),
            "local_read_roots": before.local_read_roots.len() != after.local_read_roots.len(),
            "local_write_roots": before.local_write_roots.len() != after.local_write_roots.len(),
        });
        self.journal.append(
            "config",
            "",
            "user",
            "updated",
            &Value::Null,
            &json!({
                "write_mode": after.write_mode,
                "remote_roots": after.remote_roots.iter().map(|(f, _)| f.clone()).collect::<Vec<_>>(),
                "local_read_roots": after.local_read_roots.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
                "local_write_roots": after.local_write_roots.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
                "changed": changed,
            }),
        );
        Ok(self.status())
    }

    /// 重新生成凭据（旧凭据立即失效；运行中的网关重启以应用新端点）。
    pub async fn rotate(&self) -> Result<Value, AgentToolError> {
        let was_running = self
            .gateway
            .status()
            .get("running")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if was_running {
            self.gateway.stop().await;
        }
        {
            let mut mgr = self.config.lock().unwrap();
            mgr.rotate_token(crate::journal::now_ms())?;
        }
        if was_running {
            self.start_gateway().await?;
        }
        self.journal.append("config", "", "user", "token_rotated", &Value::Null, &json!({}));
        Ok(self.status())
    }

    /// GUI 展示的完整状态（不含 token）。
    pub fn status(&self) -> Value {
        let cfg = {
            let mut mgr = self.config.lock().unwrap();
            mgr.get()
        };
        let gw = self.gateway.status();
        let scope = cfg.scope();
        json!({
            "enabled": cfg.enabled && !cfg.token.is_empty(),
            "running": gw.get("running").cloned().unwrap_or(json!(false)),
            "endpoint": gw.get("endpoint").cloned().unwrap_or(json!("")),
            "transport": if cfg.endpoint.starts_with("\\\\") { "named-pipe" } else { "unix-socket" },
            "bridgeFile": self.profile_dir.join("agent").join("bridge.json").to_string_lossy(),
            "journalFile": self.journal.file().file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            "writeMode": cfg.write_mode,
            "remoteRoots": cfg.remote_roots.iter().map(|(fid, name)| json!({"fid": fid, "name": name})).collect::<Vec<_>>(),
            "localReadRoots": scope.local_read_roots.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
            "localWriteRoots": scope.local_write_roots.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
            "connections": gw.get("connections").cloned().unwrap_or(json!(0)),
            "callsServed": gw.get("callsServed").cloned().unwrap_or(json!(0)),
            "authFailures": gw.get("authFailures").cloned().unwrap_or(json!(0)),
            "startedAt": gw.get("startedAt").cloned().unwrap_or(json!(0)),
            "lastError": gw.get("lastError").cloned().unwrap_or(json!("")),
            "toolCount": gw.get("toolCount").cloned().unwrap_or(json!(0)),
        })
    }

    pub fn recent_journal(&self, limit: usize) -> Value {
        json!({ "records": self.journal.list(limit.clamp(1, 100), None) })
    }

    /// 可复制的 MCP 客户端配置片段。
    /// 与 qck 不同：Tauri 版本没有 Node 依赖，适配器用同仓库的 Node 脚本（tools/agent-mcp.js）
    /// 或已构建的二进制定位；这里给出"当前进程可执行文件 + 资料目录"的通用形态。
    pub fn mcp_config(&self) -> Value {
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        json!({
            "mcpServers": {
                "quark-mini": {
                    "command": "node",
                    "args": [standalone_mcp_script_path()],
                    "env": {
                        "QCK_PROFILE_DIR": self.profile_dir.to_string_lossy()
                    }
                }
            },
            "note": format!("当前客户端可执行文件：{exe}；适配器脚本读取 bridge.json 即可，无需其他凭据。")
        })
    }

    /// 网关当前可执行任务的工具清单（MCP `tools/list` 复用）。
    pub fn list_tools(&self) -> Vec<Value> {
        self.gateway.list_tools()
    }

    /// 供外部（CLI/脚本）读取凭据。
    pub fn bridge_credentials(&self) -> Result<(String, String), AgentToolError> {
        read_bridge_credentials(&self.profile_dir)
    }

    /// 统一分发 `agent.*` / `chat.*` 方法（qk_call 的 Agent 分支）。
    ///
    /// `event` 仅用于 chat.send 的事件推送（宿主注入 emit_to）。
    pub async fn handle(
        &self,
        method: &str,
        params: Value,
        event: Option<EventCallback>,
    ) -> Result<Value, AgentToolError> {
        match method {
            "agent.status" => Ok(self.status()),
            "agent.enable" => self.enable(&params).await,
            "agent.disable" => self.disable().await,
            "agent.updateScope" | "agent.scope" => self.update_scope(&params),
            "agent.rotate" => self.rotate().await,
            "agent.recentJournal" | "agent.journal" => {
                let limit = params
                    .get("limit")
                    .or_else(|| params.as_u64().map(|_| &Value::Null))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(30) as usize;
                let rows = self.recent_journal(limit);
                Ok(rows)
            }
            "agent.mcpConfig" | "agent.mcp-config" | "agent.copyMcpConfig" => Ok(self.mcp_config()),
            "agent.tools" => Ok(json!(self.list_tools())),
            "chat.status" => Ok(self.chat.status()),
            "chat.saveConfig" => self.chat_config.update(&params),
            "chat.clearConfig" => Ok(self.chat_config.clear()),
            "chat.test" => self.chat.test_connection().await,
            "chat.models" => self.chat.list_models().await,
            "chat.history" => {
                let limit = params.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
                Ok(json!(self.chat.history(limit)))
            }
            "chat.clear" => Ok(self.chat.clear()),
            "chat.send" => {
                let text = params
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AgentToolError::new(AgentError::InvalidArg, "消息不能为空"))?;
                let outcome = self.chat.send(text, event).await?;
                Ok(outcome.to_json())
            }
            _ => Err(AgentToolError::new(AgentError::InvalidArg, format!("未知 Agent 方法：{method}"))),
        }
    }
}

/// 适配器脚本路径（随源码分发的 Node 脚本）。
fn standalone_mcp_script_path() -> String {
    // 与源码树相对定位：优先仓库 tools/agent-mcp.js；打包后由宿主替换为资源路径。
    let candidates = [
        PathBuf::from("tools/agent-mcp.js"),
        PathBuf::from("../tools/agent-mcp.js"),
    ];
    for c in candidates {
        if c.exists() {
            if let Ok(abs) = std::fs::canonicalize(&c) {
                return abs.to_string_lossy().to_string();
            }
        }
    }
    "tools/agent-mcp.js".to_string()
}
