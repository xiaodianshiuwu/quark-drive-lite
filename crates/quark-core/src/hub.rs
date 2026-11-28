//! Local diagnostics stub for the MIT open-source build.
//!
//! The public MIT repository contains zero remote hub endpoints, keys, or server telemetry code.
//! All network methods stay strictly offline unless built with an external private distribution overlay.

use crate::{Core, Error, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub const GITHUB_RELEASES_URL: &str =
    "https://github.com/xiaodianshiuwu/quark-drive-lite/releases/latest";

const MAX_DIAG_ENTRIES: usize = 200;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagEntry {
    pub ts: i64,
    pub level: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub biz_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct HubConfig;

impl HubConfig {
    pub fn from_env_or_default() -> Self {
        Self
    }
}

#[derive(Clone)]
pub struct VerifiedUpdate {
    path: PathBuf,
}

impl VerifiedUpdate {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub async fn verify(&self) -> Result<()> {
        Err(Error::new("UNAVAILABLE", "当前纯开源构建未内置在线更新通道"))
    }
    pub async fn copy_verified_to(&self, _output: std::fs::File) -> Result<()> {
        Err(Error::new("UNAVAILABLE", "当前纯开源构建未内置在线更新通道"))
    }
}

#[derive(Clone)]
pub struct HubClient {
    inner: Arc<HubInner>,
}

struct HubInner {
    core: Core,
    diag: Mutex<VecDeque<DiagEntry>>,
}

impl HubClient {
    pub fn new(core: Core, _config: HubConfig) -> Result<Self> {
        let mut diag = VecDeque::with_capacity(MAX_DIAG_ENTRIES);
        diag.push_back(DiagEntry {
            ts: now_ms(),
            level: "info".into(),
            category: "lifecycle".into(),
            code: Some("APP_START".into()),
            msg: format!(
                "app started v{} ({}/{})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
            http_status: None,
            biz_code: None,
            duration_ms: None,
            meta: None,
            count: None,
        });
        Ok(Self {
            inner: Arc::new(HubInner {
                core,
                diag: Mutex::new(diag),
            }),
        })
    }

    pub fn is_opted_in(&self) -> bool {
        false
    }

    pub fn pending_sample_count(&self) -> usize {
        0
    }

    pub fn record_event(&self, level: &str, category: &str, code: Option<&str>, msg: &str) {
        self.record_event_rich(level, category, code, msg, None, None, None, None);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_event_rich(
        &self,
        level: &str,
        category: &str,
        code: Option<&str>,
        msg: &str,
        http_status: Option<u16>,
        biz_code: Option<i64>,
        duration_ms: Option<u64>,
        meta: Option<Value>,
    ) {
        let entry = DiagEntry {
            ts: now_ms(),
            level: match level {
                "error" | "warn" | "info" => level.to_string(),
                _ => "info".to_string(),
            },
            category: redact_text(category, 32),
            code: code.map(|c| redact_text(c, 64)).filter(|s| !s.is_empty()),
            msg: redact_text(msg, 320),
            http_status,
            biz_code,
            duration_ms,
            meta,
            count: None,
        };
        if let Ok(mut buf) = self.inner.diag.lock() {
            if buf.len() >= MAX_DIAG_ENTRIES {
                buf.pop_front();
            }
            buf.push_back(entry);
        }
    }

    pub fn record_transfer_sample(&self, raw: Value) {
        let kind = raw["kind"].as_str().unwrap_or("download");
        let outcome = raw["outcome"].as_str().unwrap_or("done");
        let avg_bps = raw["avgBps"].as_u64().unwrap_or(0);
        let dur_ms = raw["durationMs"].as_u64().unwrap_or(0);
        self.record_event(
            if outcome == "error" { "error" } else { "info" },
            "transfer",
            raw["errorCode"].as_str(),
            &format!("{kind} {outcome} avg={}KB/s dur={dur_ms}ms", avg_bps / 1024),
        );
    }

    pub async fn run_telemetry_flusher_loop(self, _app_version: &'static str) {
        std::future::pending::<()>().await;
    }

    pub async fn flush_transfer_telemetry(&self, _app_version: &str) -> Result<Value> {
        Ok(json!({ "ok": true, "flushed": 0 }))
    }

    pub fn log_preview(&self) -> Vec<DiagEntry> {
        self.inner
            .diag
            .lock()
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn config_info(&self, app_version: &str) -> Value {
        json!({
            "available": false,
            "optIn": false,
            "prompted": true,
            "currentVersion": app_version,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "releasePageUrl": GITHUB_RELEASES_URL
        })
    }

    pub fn set_opt_in(&self, _opt_in: bool, app_version: &str) -> Result<Value> {
        Ok(self.config_info(app_version))
    }

    pub async fn check_update(&self, _app_version: &str) -> Result<Value> {
        Err(Error::new("UNAVAILABLE", "当前为纯本地 MIT 开源版本，请前往 GitHub Releases 获取更新"))
    }

    pub async fn apply_ui_hotfix(&self, _app_version: &str) -> Result<Value> {
        Err(Error::new("UNAVAILABLE", "当前为纯本地 MIT 开源版本"))
    }

    pub fn runtime_status(&self, app_version: &str) -> Value {
        json!({
            "ok": true,
            "tuning": self.inner.core.tuning().to_value(),
            "hotUi": crate::hot_ui::status_json(&self.inner.core.profile_dir(), app_version)
        })
    }

    pub async fn download_update<F>(
        &self,
        _app_version: &str,
        _asset_key: Option<&str>,
        _local_dir: Option<&str>,
        _on_progress: F,
    ) -> Result<Value>
    where
        F: FnMut(Value) + Send,
    {
        Err(Error::new("UNAVAILABLE", "当前为纯本地 MIT 开源版本，请前往 GitHub Releases 下载安装包"))
    }

    pub fn verified_update_for_install(&self, _requested_path: Option<&str>) -> Result<VerifiedUpdate> {
        Err(Error::new("UNAVAILABLE", "当前为纯本地 MIT 开源版本"))
    }

    pub async fn send_telemetry(&self, _app_version: &str, _input: Value) -> Result<Value> {
        Ok(json!({ "ok": true, "disabled": true }))
    }

    pub async fn submit_feedback(&self, _app_version: &str, _input: Value) -> Result<Value> {
        Err(Error::new("UNAVAILABLE", "当前为纯本地 MIT 开源版本，请前往 GitHub Issues 反馈"))
    }

    pub async fn list_feedback(&self) -> Result<Value> {
        Ok(json!({ "ok": true, "items": [] }))
    }

    pub async fn reply_feedback(&self, _input: Value) -> Result<Value> {
        Err(Error::new("UNAVAILABLE", "当前为纯本地 MIT 开源版本"))
    }
}

pub fn record_panic_breadcrumb(_profile_dir: &Path, _location: &str, _message: &str) {}

pub fn version_is_newer(candidate: &str, current: &str) -> bool {
    parse_semver(candidate) > parse_semver(current)
}

pub fn version_in_range(
    current: &str,
    min_version: Option<&str>,
    max_version: Option<&str>,
) -> bool {
    let cur = parse_semver(current);
    if let Some(min_v) = min_version.filter(|s| !s.trim().is_empty()) {
        if cur < parse_semver(min_v) {
            return false;
        }
    }
    if let Some(max_v) = max_version.filter(|s| !s.trim().is_empty()) {
        if cur > parse_semver(max_v) {
            return false;
        }
    }
    true
}

fn parse_semver(raw: &str) -> (u64, u64, u64, u8, u64) {
    let trimmed = raw
        .trim()
        .trim_start_matches('v')
        .split('+')
        .next()
        .unwrap_or("");
    let (core, pre) = match trimmed.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (trimmed, None),
    };
    let mut parts = core.split('.').map(|s| s.parse::<u64>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    let (pre_rank, pre_num) = match pre {
        None => (3u8, 0u64),
        Some(p) => {
            let low = p.to_ascii_lowercase();
            let rank = if low.starts_with("rc") {
                2
            } else if low.starts_with("beta") {
                1
            } else {
                0
            };
            let num = low
                .rsplit(|c: char| !c.is_ascii_digit())
                .find(|s| !s.is_empty())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            (rank, num)
        }
    };
    (major, minor, patch, pre_rank, pre_num)
}

pub fn redact_text(input: &str, max_chars: usize) -> String {
    input
        .chars()
        .take(max_chars)
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mit_stub_reports_unavailable_and_compares_semver() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open_no_proxy(dir.path()).unwrap();
        let hub = HubClient::new(core, HubConfig::from_env_or_default()).unwrap();
        assert!(!hub.is_opted_in());
        assert_eq!(hub.config_info("1.3.6")["available"], Value::Bool(false));
        assert!(version_is_newer("1.3.6", "1.3.1"));
        assert!(!version_is_newer("1.3.1", "1.3.6"));
        assert!(version_in_range("1.3.6", Some("1.3.0"), Some("1.4.0")));
    }
}
