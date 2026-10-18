//! Agent 工具层的宿主适配：把 quark-core / quark-transfer 的业务分发包成
//! `quark_agent::tools::HostDeps`，并统一上游错误语义。

use quark_agent::policy::AgentToolError;
use quark_agent::tools::HostDeps;
use quark_core::Core;
use quark_transfer::TransferManager;
use serde_json::Value;
use std::pin::Pin;
use std::sync::Arc;

/// 真实宿主依赖（Core 与传输管理器均可 Clone，内部为 Arc）。
#[derive(Clone)]
pub struct ToolHost {
    pub core: Core,
    pub transfers: TransferManager,
}

impl ToolHost {
    pub fn new(core: Core, transfers: TransferManager) -> Arc<Self> {
        Arc::new(Self { core, transfers })
    }

    /// quark-core 错误 → AgentToolError：保留上游 code（NEED_LOGIN 等须原样透传）。
    fn map_core_error(e: quark_core::Error) -> AgentToolError {
        let mut out = AgentToolError::from_upstream(&e.code, e.message.clone(), None);
        if let Some(biz) = e.biz_code {
            out.upstream_code = Some(serde_json::json!(biz));
            out.upstream_message = out
                .upstream_message
                .or_else(|| Some(format!("biz_code={biz}")));
        }
        out
    }
}

impl HostDeps for ToolHost {
    fn core_call<'a>(
        &'a self,
        generation: u64,
        method: &'a str,
        params: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, AgentToolError>> + Send + 'a>> {
        // 会话绑定调用（fs.* 内部本来就按当前 generation 取，这里透传 generation 仅用于
        // 需要显式绑定的场景；Core::call 内部自行读取 session_generation）。
        let _ = generation;
        Box::pin(async move {
            let result = self.core.call(method, params.clone()).await;
            result.map_err(Self::map_core_error)
        })
    }

    fn transfer_call<'a>(
        &'a self,
        method: &'a str,
        params: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, AgentToolError>> + Send + 'a>> {
        Box::pin(async move {
            self.transfers
                .call(method, params.clone())
                .await
                .map_err(Self::map_core_error)
        })
    }

    fn download_dir(&self) -> String {
        self.core
            .settings()
            .get("downloadDir")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    fn session_generation(&self) -> u64 {
        self.core.session_generation()
    }
}
