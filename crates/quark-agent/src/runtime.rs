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
        let _ = profile_dir;
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
    lifecycle:tokio::sync::Mutex<()>,

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
            lifecycle:tokio::sync::Mutex::new(()),
        }))
    }

    /// 启动时调用：若已启用则启动网关；失败不阻断客户端启动（只记状态）。
    pub async fn boot(&self) {
        let _lifecycle=self.lifecycle.lock().await;
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
        let _lifecycle=self.lifecycle.lock().await;
        if patch.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            let mut mgr = self.config.lock().unwrap();
            mgr.update(patch, crate::journal::now_ms())?;
        }
        let started = self.start_gateway().await;
        if let Err(e) = started {
            let mut mgr = self.config.lock().unwrap();
            // 回滚必须完整：deactivate 只删 bridge.json，新写入的 token 仍在 store 里；
            // rotate_token 回收凭据并回到 Disabled，避免"enabled 但网关未运行"的残留态。
            let _ = mgr.rotate_token(crate::journal::now_ms());
            let _ = mgr.deactivate(crate::journal::now_ms());
            self.journal.append(
                "config",
                "",
                "user",
                "enable_failed",
                &Value::Null,
                &json!({ "error": crate::journal::sanitize(&json!(e.message)) }),
            );
            return Err(e);
        }
        self.journal.append("config", "", "user", "enabled", &Value::Null, &json!({}));
        Ok(self.status())
    }

    pub async fn disable(&self) -> Result<Value, AgentToolError> {
        let _lifecycle=self.lifecycle.lock().await;
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
        let _lifecycle=self.lifecycle.lock().await;
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
            if let Err(e) = self.start_gateway().await {
                // 中间态已由 status.lastError 暴露；审计补一手证据便于排查。
                self.journal.append(
                    "config",
                    "",
                    "user",
                    "rotate_failed",
                    &Value::Null,
                    &json!({ "error": crate::journal::sanitize(&json!(e.message)) }),
                );
                return Err(e);
            }
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
    /// 桌面客户端不依赖 Node；外部 MCP 客户端使用 Node 运行随应用内置、
    /// 安装到当前资料目录的适配脚本。
    pub fn mcp_config(&self) -> Result<Value,AgentToolError> {
        let script=standalone_mcp_script_path(&self.profile_dir).map_err(|e|AgentToolError::new(AgentError::Internal,format!("无法安装MCP适配脚本：{e}")))?;
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        Ok(json!({
            "mcpServers": {
                "quark-mini": {
                    "command": "node",
                    "args": [script],
                    "env": {
                        "QCK_PROFILE_DIR": self.profile_dir.to_string_lossy()
                    }
                }
            },
            "note": format!("外部MCP客户端需要可用的Node.js。当前客户端可执行文件：{exe}；适配器已随应用内置并安装到本资料目录，不依赖源码工作区。")
        }))
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
                let limit = match &params {
                    Value::Number(n) => n.as_u64(),
                    Value::Object(o) => o.get("limit").and_then(|v| v.as_u64()),
                    _ => None,
                }
                .unwrap_or(30) as usize;
                Ok(self.recent_journal(limit))
            }
            "agent.mcpConfig" | "agent.mcp-config" | "agent.copyMcpConfig" => self.mcp_config(),
            "agent.tools" => Ok(json!(self.list_tools())),
            "chat.status" => Ok(self.chat.status()),
            "chat.saveConfig" => self.chat.with_idle(||self.chat_config.update(&params)),
            "chat.clearConfig" => self.chat.with_idle(||self.chat_config.clear()),
            "chat.test" => self.chat.test_connection().await,
            "chat.models" => self.chat.list_models().await,
            "chat.history" => {
                let limit = params.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
                Ok(json!(self.chat.history(limit)))
            }
            "chat.clear" => self.chat.clear(),
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

/// Embed source at build time and install a content-addressed adapter alongside the profile.
/// Packaged clients therefore work from any current directory without the source checkout.
fn standalone_mcp_script_path(profile:&Path)->std::io::Result<PathBuf> {
    use sha2::{Digest,Sha256};use std::io::Write;
    let scripts=[("agent-mcp.js",include_str!("../../../tools/agent-mcp.js")),("agent-bridge-client.js",include_str!("../../../tools/agent-bridge-client.js"))];
    let content=scripts.iter().map(|(_,s)|*s).collect::<String>();
    let dir=profile.join("agent/adapters").join(format!("{:x}",Sha256::digest(content.as_bytes())));
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&dir,std::fs::Permissions::from_mode(0o700))?;}
    for (name,source) in scripts {
        let path=dir.join(name);
        if let Ok(meta)=std::fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() || std::fs::read(&path)?!=source.as_bytes() {return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"已安装适配脚本被替换"));}
            continue;
        }
        let mut options=std::fs::OpenOptions::new();options.write(true).create_new(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        let mut file=options.open(path)?;file.write_all(source.as_bytes())?;file.sync_all()?;
    }
    Ok(dir.join("agent-mcp.js"))
}

#[cfg(test)]
mod adapter_tests {
    use super::*;
    #[test]
    fn packaged_mcp_adapter_is_self_contained_and_detects_replacement() {
        let temp=tempfile::tempdir().unwrap();
        let script=standalone_mcp_script_path(temp.path()).unwrap();
        assert!(script.is_absolute());assert!(script.parent().unwrap().join("agent-bridge-client.js").is_file());
        assert_eq!(standalone_mcp_script_path(temp.path()).unwrap(),script);
        std::fs::write(&script,"modified").unwrap();assert!(standalone_mcp_script_path(temp.path()).is_err());
    }
}
