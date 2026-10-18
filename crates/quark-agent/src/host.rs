//! Agent 工具层的宿主适配：把 quark-core / quark-transfer 的业务分发包成
//! `quark_agent::tools::HostDeps`，并统一上游错误语义。

use crate::policy::AgentToolError;
use crate::tools::HostDeps;
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
        // upstream_code 必须是字符串 code（如 "NOT_FOUND"）：工具层据此判断终态错误；
        // 数字 biz_code 只进提示文本，不参与判断（探针实测：删除后 fs.info 返回
        // code=NOT_FOUND / biz=21001 / http=404，判定依据是 code 而非 biz）。
        let mut out = AgentToolError::from_upstream(&e.code, e.message.clone(), None);
        if let Some(biz) = e.biz_code {
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
        // 会话绑定：调用前后各核对一次 generation。账号在长跑工具执行中途被切换时
        // 返回 ABORTED，而不是静默在新账号上继续（quark-core 的 ensure_session 语义）。
        // generation==0 表示"不绑定"（MCP 源未提供真实 generation 的测试场景）。
        Box::pin(async move {
            if generation != 0 {
                self.core
                    .ensure_session(generation)
                    .map_err(Self::map_core_error)?;
            }
            let result = self.core.call(method, params.clone()).await;
            if generation != 0 {
                self.core
                    .ensure_session(generation)
                    .map_err(Self::map_core_error)?;
            }
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
