//! Optional author hub server client: signed updates + direct download + E2EE sanitized telemetry & feedback.
//!
//! Strict privacy & security invariants:
//! 1. **Zero network traffic when declined (`serverOptIn == false`)**: every network method checks
//!    `core.settings()["serverOptIn"]` BEFORE constructing a URL or touching `reqwest::Client`.
//! 2. **Forward-secret E2EE on uploads**: ephemeral X25519 ECDH + SHA-256 KDF + AES-256-GCM
//!    with AAD bound to `METHOD|PATH|ts|nonce`, layered on top of HTTPS TLS 1.2/1.3.
//! 3. **Authenticity & integrity on updates**: Ed25519 signature verification over the canonical
//!    update manifest + SHA-256 verification of every downloaded update package.
//! 4. **Zero PII leakage**: strict redaction strips cookies, tokens, API keys, home directories,
//!    signed URL parameters, and IP addresses; filenames and account identifiers are never collected.

use crate::{Core, Error, Result};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use reqwest::{redirect::Policy, Client, Url};
use ring::{agreement, rand::SystemRandom, signature};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const DEFAULT_HUB_URL: &str = "https://qdl.xiaodianshiuwu.space";
pub const DEFAULT_SERVER_REGION: &str = "海外节点 · Tokyo (JP)";
pub const GITHUB_RELEASES_URL: &str = "https://github.com/xiaodianshiuwu/quark-drive-lite/releases/latest";
/// Server X25519 public key (32 raw bytes, base64). Public by design; private key lives only on server.
pub const DEFAULT_X25519_PUB_B64: &str = "JiBk3eOuPSeJfVdmlf69pMVn5XdZdN2OoCswV+ij+h4=";
/// Server Ed25519 public key (32 raw bytes, base64). Public by design; private key lives only on server.
pub const DEFAULT_ED25519_PUB_B64: &str = "+ruMjuPB615LgeQuCJI+HUn/C/Ie8KCU+cbQEU8r918=";

const MAX_DIAG_ENTRIES: usize = 300;
const MAX_PENDING_SAMPLES: usize = 100;
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_HUB_JSON_BYTES: usize = 2 * 1024 * 1024;
const OVERSEAS_NET_HINT: &str = "无法连接到海外更新服务器（可能因网络波动或跨境链路受限）。如果您有代理/梯子可开启后重试；不连接也完全不影响本地网盘核心功能。";

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

#[derive(Clone, Debug)]
pub struct HubConfig {
    pub base_url: String,
    pub region: String,
    pub x25519_pub: [u8; 32],
    pub ed25519_pub: [u8; 32],
    pub allow_insecure_localhost: bool,
}

impl HubConfig {
    pub fn from_env_or_default() -> Self {
        #[cfg(any(debug_assertions, test))]
        let (base_url, x25519_b64, ed25519_b64, allow_insecure_localhost) = (
            std::env::var("QDL_HUB_URL")
                .ok()
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| DEFAULT_HUB_URL.to_string()),
            std::env::var("QDL_HUB_X25519_PUB")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_X25519_PUB_B64.to_string()),
            std::env::var("QDL_HUB_ED25519_PUB")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ED25519_PUB_B64.to_string()),
            std::env::var("QDL_HUB_ALLOW_INSECURE_LOCALHOST").as_deref() == Ok("1"),
        );
        #[cfg(not(any(debug_assertions, test)))]
        let (base_url, x25519_b64, ed25519_b64, allow_insecure_localhost) = (
            DEFAULT_HUB_URL.to_string(),
            DEFAULT_X25519_PUB_B64.to_string(),
            DEFAULT_ED25519_PUB_B64.to_string(),
            false,
        );
        let x25519_pub =
            decode_key32(&x25519_b64).unwrap_or_else(|| decode_key32(DEFAULT_X25519_PUB_B64).unwrap());
        let ed25519_pub =
            decode_key32(&ed25519_b64).unwrap_or_else(|| decode_key32(DEFAULT_ED25519_PUB_B64).unwrap());
        Self {
            base_url,
            region: DEFAULT_SERVER_REGION.to_string(),
            x25519_pub,
            ed25519_pub,
            allow_insecure_localhost,
        }
    }

    fn validated_origin(&self) -> Result<Url> {
        let url = Url::parse(&self.base_url).map_err(|_| Error::new("CONFIG", "服务器地址格式无效"))?;
        let is_https = url.scheme() == "https";
        let is_local_http = self.allow_insecure_localhost
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
        if !is_https && !is_local_http {
            return Err(Error::new("INSECURE_TRANSPORT", "安全策略要求仅允许通过 HTTPS 连接服务器"));
        }
        Ok(url)
    }
}

fn decode_key32(b64: &str) -> Option<[u8; 32]> {
    let raw = B64.decode(b64.trim()).ok()?;
    if raw.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    Some(out)
}

#[derive(Clone)]
pub struct HubClient {
    inner: Arc<HubInner>,
}

struct HubInner {
    core: Core,
    config: HubConfig,
    http: Client,
    started_at: Instant,
    session_salt: String,
    diag: Mutex<VecDeque<DiagEntry>>,
    pending_samples: Mutex<VecDeque<Value>>,
    sample_notify: Arc<tokio::sync::Notify>,
    feedback_token: Mutex<Option<String>>,
    last_verified_update: Mutex<Option<VerifiedUpdate>>,
}

#[derive(Clone)]
struct VerifiedUpdate {
    path: PathBuf,
    sha256: String,
    size: u64,
}

impl HubClient {
    pub fn new(core: Core, config: HubConfig) -> Result<Self> {
        let mut builder = Client::builder()
            .user_agent(format!(
                "QuarkDriveLite/{} ({}; {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            ))
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(12))
            .tcp_nodelay(true)
            .pool_idle_timeout(Duration::from_secs(30));
        if config.allow_insecure_localhost {
            builder = builder.no_proxy();
        }
        let http = builder
            .build()
            .map_err(|_| Error::new("NETWORK", "安全更新客户端初始化失败"))?;

        let mut salt = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let session_salt = hex::encode(salt);

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
        if let Some(crash_entry) = ingest_last_crash(&core.profile_dir()) {
            diag.push_back(crash_entry);
        }

        Ok(Self {
            inner: Arc::new(HubInner {
                core,
                config,
                http,
                started_at: Instant::now(),
                session_salt,
                diag: Mutex::new(diag),
                pending_samples: Mutex::new(VecDeque::with_capacity(MAX_PENDING_SAMPLES)),
                sample_notify: Arc::new(tokio::sync::Notify::new()),
                feedback_token: Mutex::new(None),
                last_verified_update: Mutex::new(None),
            }),
        })
    }

    pub fn is_opted_in(&self) -> bool {
        self.inner
            .core
            .settings()
            .get("serverOptIn")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn require_opt_in(&self) -> Result<()> {
        if !self.is_opted_in() {
            return Err(Error::new(
                "OPT_IN_REQUIRED",
                "您未开启「连接作者服务器」可选功能，本应用严格遵守承诺不会向外发送任何数据。如需在线更新或反馈，请先在设置中开启。",
            ));
        }
        Ok(())
    }

    pub fn record_event(
        &self,
        level: &str,
        category: &str,
        code: Option<&str>,
        msg: &str,
    ) {
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
        let now = now_ms();
        let entry = DiagEntry {
            ts: now,
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
            meta: meta.and_then(sanitize_diag_meta),
            count: None,
        };
        if let Ok(mut buf) = self.inner.diag.lock() {
            if let Some(last) = buf.back_mut() {
                if last.level == entry.level
                    && last.category == entry.category
                    && last.code == entry.code
                    && last.msg == entry.msg
                    && last.http_status == entry.http_status
                    && last.biz_code == entry.biz_code
                    && last.meta == entry.meta
                    && now.saturating_sub(last.ts) <= 30_000
                {
                    last.ts = now;
                    last.count = Some(last.count.unwrap_or(1).saturating_add(1));
                    return;
                }
            }
            if buf.len() >= MAX_DIAG_ENTRIES {
                buf.pop_front();
            }
            buf.push_back(entry);
        }
    }

    /// Record a strictly zero-PII transfer engine completion/failure sample into the local
    /// diagnostic ring buffer and, when opted in, enqueue it for encrypted batch telemetry upload.
    pub fn record_transfer_sample(&self, raw: Value) {
        let Some(sample) = sanitize_transfer_sample(&raw) else {
            return;
        };
        let kind = sample["kind"].as_str().unwrap_or("download");
        let outcome = sample["outcome"].as_str().unwrap_or("done");
        let strategy = sample["strategy"].as_str().unwrap_or("unknown");
        let bucket = sample["sizeBucket"].as_str().unwrap_or("0");
        let avg_bps = sample["avgBps"].as_u64().unwrap_or(0);
        let dur_ms = sample["durationMs"].as_u64().unwrap_or(0);
        let retries = sample["partRetries"].as_u64().unwrap_or(0);
        let rapid = sample["rapidUpload"].as_bool().unwrap_or(false);
        let stage = sample["stage"].as_str().unwrap_or("");
        let io_kind = sample["ioKind"].as_str().unwrap_or("");
        let os_errno = sample["osErrno"].as_i64();
        let link_ms = sample["linkMs"].as_u64().unwrap_or(0);
        let probe_ms = sample["probeMs"].as_u64().unwrap_or(0);
        let transfer_ms = sample["transferMs"].as_u64().unwrap_or(0);
        let hash_ms = sample["hashMs"].as_u64().unwrap_or(0);
        let publish_ms = sample["publishMs"].as_u64().unwrap_or(0);
        let aimd_downshifts = sample["aimdDownshifts"].as_u64().unwrap_or(0);
        let err_code = sample["errorCode"].as_str();
        let http_status = sample["httpStatus"].as_u64().and_then(|v| u16::try_from(v).ok());

        let level = if outcome == "error" {
            "error"
        } else if retries > 0 || aimd_downshifts > 0 || outcome == "canceled" {
            "warn"
        } else {
            "info"
        };
        let diag_code = err_code.unwrap_or(match (kind, outcome, rapid) {
            ("upload", "done", true) => "UPLOAD_RAPID_DONE",
            ("upload", "done", false) => "UPLOAD_DONE",
            ("download", "done", _) => "DOWNLOAD_DONE",
            (_, "canceled", _) => "TRANSFER_CANCELED",
            _ => "TRANSFER_ERROR",
        });
        let mut msg = format!(
            "{} {} [{}] strat={} avg={}KB/s dur={}ms retries={}",
            kind,
            outcome,
            bucket,
            strategy,
            avg_bps / 1024,
            dur_ms,
            retries,
        );
        if link_ms > 0 || transfer_ms > 0 || hash_ms > 0 || publish_ms > 0 {
            msg.push_str(&format!(
                " (link={link_ms}ms probe={probe_ms}ms xfer={transfer_ms}ms hash={hash_ms}ms pub={publish_ms}ms)"
            ));
        }
        if aimd_downshifts > 0 {
            msg.push_str(&format!(" aimd={aimd_downshifts}"));
        }
        if !stage.is_empty() {
            msg.push_str(&format!(" stage={stage}"));
        }
        if !io_kind.is_empty() {
            if let Some(eno) = os_errno {
                msg.push_str(&format!(" io={io_kind}({eno})"));
            } else {
                msg.push_str(&format!(" io={io_kind}"));
            }
        }
        self.record_event_rich(
            level,
            "transfer",
            Some(diag_code),
            &msg,
            http_status,
            None,
            Some(dur_ms),
            Some(sample.clone()),
        );

        if self.is_opted_in() {
            if let Ok(mut q) = self.inner.pending_samples.lock() {
                if q.len() >= MAX_PENDING_SAMPLES {
                    q.pop_front();
                }
                q.push_back(sample);
            }
            self.inner.sample_notify.notify_one();
        }
    }

    pub fn pending_sample_count(&self) -> usize {
        self.inner
            .pending_samples
            .lock()
            .map(|q| q.len())
            .unwrap_or(0)
    }

    fn take_pending_samples(&self, max_count: usize) -> Vec<Value> {
        let Ok(mut q) = self.inner.pending_samples.lock() else {
            return Vec::new();
        };
        let n = q.len().min(max_count);
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            if let Some(item) = q.pop_front() {
                out.push(item);
            }
        }
        out
    }

    fn requeue_samples(&self, samples: Vec<Value>) {
        if samples.is_empty() {
            return;
        }
        if let Ok(mut q) = self.inner.pending_samples.lock() {
            for item in samples.into_iter().rev() {
                if q.len() >= MAX_PENDING_SAMPLES {
                    break;
                }
                q.push_front(item);
            }
        }
    }

    /// Flush buffered transfer samples to `/api/v1/telemetry` (E2EE) with accurate bytes-weighted averages.
    pub async fn flush_transfer_telemetry(&self, app_version: &str) -> Result<Value> {
        self.require_opt_in()?;
        let samples = self.take_pending_samples(50);
        if samples.is_empty() {
            return Ok(json!({ "ok": true, "flushed": 0 }));
        }
        let summary = aggregate_transfer_samples(&samples);
        let res = self
            .send_telemetry_with_samples(app_version, summary, samples.clone())
            .await;
        if res.is_err() {
            self.requeue_samples(samples);
        }
        res
    }

    /// Background loop that debounces and flushes zero-PII transfer engine telemetry when opted in.
    /// Callers in Tauri setup (which runs on the OS main thread outside Tokio) should spawn this via
    /// `tauri::async_runtime::spawn`.
    pub async fn run_telemetry_flusher_loop(self, app_version: &'static str) {
        loop {
            self.inner.sample_notify.notified().await;
            if !self.is_opted_in() {
                continue;
            }
            // Debounce up to 8s to batch bursts, or flush immediately when >= 20 samples are queued.
            for _ in 0..16 {
                if self.pending_sample_count() >= 20 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if self.is_opted_in() && self.pending_sample_count() > 0 {
                let _ = self.flush_transfer_telemetry(app_version).await;
            }
        }
    }

    pub fn log_preview(&self) -> Vec<DiagEntry> {
        self.inner
            .diag
            .lock()
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn config_info(&self, app_version: &str) -> Value {
        let s = self.inner.core.settings();
        json!({
            "optIn": s.get("serverOptIn").and_then(Value::as_bool).unwrap_or(false),
            "prompted": s.get("serverPrompted").and_then(Value::as_bool).unwrap_or(false),
            "baseUrl": self.inner.config.base_url,
            "region": self.inner.config.region,
            "currentVersion": app_version,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "installType": detect_install_type(),
            "recommendedAssetKey": recommended_asset_key(),
            "releasePageUrl": GITHUB_RELEASES_URL,
            "cryptoSummary": "HTTPS TLS 1.3 + X25519/AES-256-GCM 端到端加密 + Ed25519 签名校验",
            "overseasHint": "该服务器部署于海外节点（日本东京），国内直连可能出现连接失败或延迟；如有代理/梯子开启后即可顺畅连接，没有也没关系，不影响网盘核心使用。"
        })
    }

    pub fn set_opt_in(&self, opt_in: bool, app_version: &str) -> Result<Value> {
        self.inner.core.set_settings(json!({
            "serverOptIn": opt_in,
            "serverPrompted": true
        }))?;
        self.record_event(
            "info",
            "hub",
            Some(if opt_in { "HUB_OPT_IN" } else { "HUB_OPT_OUT" }),
            if opt_in {
                "user enabled optional server connection"
            } else {
                "user disabled optional server connection"
            },
        );
        Ok(self.config_info(app_version))
    }

    /// Fetch and Ed25519-verify the latest update manifest from the author's server.
    /// Automatically applies any signed L1 runtime tuning profile and exposes L2 UI hotfix metadata.
    pub async fn check_update(&self, app_version: &str) -> Result<Value> {
        self.require_opt_in()?;
        let (manifest, server_region) = self.fetch_verified_manifest().await?;
        let latest_version = manifest["version"].as_str().unwrap_or(app_version);
        let has_update = version_is_newer(latest_version, app_version);
        let min_version = manifest["minVersion"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let force_upgrade = min_version.is_some_and(|m| version_is_newer(m, app_version));
        let rec_key = recommended_asset_key();
        let recommended_asset = manifest["assets"].get(rec_key).cloned().unwrap_or(Value::Null);

        // L1: apply signed remote tuning profile live (no restart needed).
        let mut tuning_applied = false;
        if let Some(remote_tuning) = manifest.get("tuning").filter(|v| v.is_object()) {
            let cur = self.inner.core.tuning();
            let remote_ver = remote_tuning["version"].as_u64().unwrap_or(0);
            if remote_ver == 0 || remote_ver >= cur.version {
                if let Ok(next) = self.inner.core.apply_tuning(remote_tuning) {
                    if next != cur {
                        tuning_applied = true;
                        self.record_event(
                            "info",
                            "tuning",
                            Some("TUNING_APPLIED"),
                            &format!("applied signed tuning profile v{}", next.version),
                        );
                    }
                }
            }
        }
        let active_tuning = self.inner.core.tuning().to_value();

        // L2: evaluate signed UI hotfix compatibility against current binary version.
        let hot_ui_state = crate::hot_ui::load_state(&self.inner.core.profile_dir());
        let mut has_ui_hotfix = false;
        let ui_hotfix = manifest.get("uiHotfix").filter(|v| v.is_object()).cloned();
        if let Some(ref hf) = ui_hotfix {
            let hf_ver = hf["version"].as_str().unwrap_or("");
            let min_bin = hf["minBinaryVersion"].as_str();
            let max_bin = hf["maxBinaryVersion"].as_str();
            let compatible = !hf_ver.is_empty()
                && crate::hot_ui::is_safe_hotfix_version(hf_ver)
                && version_in_range(app_version, min_bin, max_bin)
                && !hot_ui_state.blacklisted_versions.iter().any(|b| b == hf_ver);
            if compatible && hot_ui_state.active_version.as_deref() != Some(hf_ver) {
                has_ui_hotfix = true;
            }
        }

        Ok(json!({
            "ok": true,
            "hasUpdate": has_update,
            "minVersion": min_version,
            "forceUpgrade": force_upgrade,
            "currentVersion": app_version,
            "latestVersion": latest_version,
            "channel": manifest["channel"].as_str().unwrap_or("beta"),
            "releaseDate": manifest["releaseDate"].as_str().unwrap_or(""),
            "changelog": manifest["changelog"].as_str().unwrap_or(""),
            "notice": manifest["notice"],
            "assets": manifest["assets"],
            "recommendedAssetKey": rec_key,
            "recommendedAsset": recommended_asset,
            "installType": detect_install_type(),
            "releasePageUrl": GITHUB_RELEASES_URL,
            "signatureVerified": true,
            "serverRegion": server_region,
            "tuning": active_tuning,
            "tuningApplied": tuning_applied,
            "uiHotfix": ui_hotfix,
            "hasUiHotfix": has_ui_hotfix,
            "hotUi": crate::hot_ui::status_json(&self.inner.core.profile_dir(), app_version),
        }))
    }

    /// Download, Ed25519+SHA-256 verify, and atomically stage an L2 frontend UI hotfix bundle.
    pub async fn apply_ui_hotfix(&self, app_version: &str) -> Result<Value> {
        self.require_opt_in()?;
        let origin = self.inner.config.validated_origin()?;
        let (manifest, _) = self.fetch_verified_manifest().await?;
        let hf = manifest
            .get("uiHotfix")
            .filter(|v| v.is_object())
            .ok_or_else(|| Error::new("NOT_FOUND", "当前没有可用的前端热更新包"))?;

        let hf_ver = hf["version"]
            .as_str()
            .filter(|s| crate::hot_ui::is_safe_hotfix_version(s))
            .ok_or_else(|| Error::new("INVALID_MANIFEST", "前端热更新版本号无效"))?;
        let expected_sha = hf["sha256"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| Error::new("INVALID_MANIFEST", "前端热更新 SHA-256 缺失"))?;
        let url_str = hf["url"]
            .as_str()
            .ok_or_else(|| Error::new("INVALID_MANIFEST", "前端热更新下载地址缺失"))?;

        let download_url = Url::parse(url_str)
            .map_err(|_| Error::new("INVALID_MANIFEST", "前端热更新地址格式无效"))?;
        if download_url.scheme() != origin.scheme()
            || download_url.host_str() != origin.host_str()
            || download_url.port_or_known_default() != origin.port_or_known_default()
            || !download_url.path().starts_with("/downloads/")
        {
            return Err(Error::new(
                "FORBIDDEN",
                "安全拦截：前端热更新地址必须指向已认证服务器 /downloads/ 路径",
            ));
        }

        let min_bin = hf["minBinaryVersion"].as_str();
        let max_bin = hf["maxBinaryVersion"].as_str();
        if !version_in_range(app_version, min_bin, max_bin) {
            return Err(Error::new(
                "INCOMPATIBLE",
                "当前前端热更新不适用于本主程序版本，请更新主程序",
            ));
        }

        let mut resp = self
            .inner
            .http
            .get(download_url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| {
                let nk = net_error_kind(&e);
                self.record_event_rich(
                    "warn",
                    "hub_net",
                    Some(if e.is_timeout() { "TIMEOUT" } else { "NETWORK" }),
                    &format!("hub /updates/latest {nk}"),
                    None,
                    None,
                    None,
                    Some(json!({ "netKind": nk })),
                );
                if e.is_timeout() {
                    Error::new("TIMEOUT", OVERSEAS_NET_HINT)
                } else {
                    Error::new("NETWORK", OVERSEAS_NET_HINT)
                }
            })?;
        if !resp.status().is_success() {
            return Err(Error::new(
                "HTTP",
                format!("前端热更新下载失败（HTTP {}）", resp.status().as_u16()),
            ));
        }
        if resp
            .content_length()
            .is_some_and(|n| n > crate::hot_ui::MAX_UI_BUNDLE_BYTES as u64)
        {
            return Err(Error::new("INVALID_MANIFEST", "前端热更新包体积超出安全上限"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| {
            if e.is_timeout() {
                Error::new("TIMEOUT", OVERSEAS_NET_HINT)
            } else {
                Error::new("NETWORK", OVERSEAS_NET_HINT)
            }
        })? {
            if bytes.len().saturating_add(chunk.len()) > crate::hot_ui::MAX_UI_BUNDLE_BYTES {
                return Err(Error::new("INVALID_MANIFEST", "前端热更新包超出安全上限"));
            }
            bytes.extend_from_slice(&chunk);
        }

        let manifest_files: Option<std::collections::BTreeMap<String, String>> = hf
            .get("files")
            .and_then(Value::as_object)
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                    .collect()
            });

        let state = crate::hot_ui::install_verified_bundle(
            &self.inner.core.profile_dir(),
            app_version,
            hf_ver,
            expected_sha,
            manifest_files.as_ref(),
            hf["changelog"].as_str(),
            &bytes,
        )?;
        self.record_event(
            "info",
            "hot_ui",
            Some("UI_HOTFIX_INSTALLED"),
            &format!("installed verified UI hotfix {hf_ver}"),
        );
        Ok(json!({
            "ok": true,
            "applied": true,
            "version": hf_ver,
            "changelog": state.active_changelog,
            "needsReload": true,
            "hotUi": crate::hot_ui::status_json(&self.inner.core.profile_dir(), app_version),
        }))
    }

    pub fn runtime_status(&self, app_version: &str) -> Value {
        json!({
            "ok": true,
            "tuning": self.inner.core.tuning().to_value(),
            "hotUi": crate::hot_ui::status_json(&self.inner.core.profile_dir(), app_version),
        })
    }

    /// Download a verified release asset directly from the author's server and verify its SHA-256 checksum.
    pub async fn download_update<F>(
        &self,
        app_version: &str,
        asset_key: Option<&str>,
        local_dir: Option<&str>,
        mut on_progress: F,
    ) -> Result<Value>
    where
        F: FnMut(Value) + Send,
    {
        self.require_opt_in()?;
        let origin = self.inner.config.validated_origin()?;
        let (manifest, _) = self.fetch_verified_manifest().await?;
        let key = asset_key
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(recommended_asset_key());
        let asset = manifest["assets"]
            .get(key)
            .ok_or_else(|| Error::new("NOT_FOUND", format!("当前版本暂未上传平台安装包（{key}）")))?;

        let filename = asset["filename"]
            .as_str()
            .filter(|s| is_safe_filename(s))
            .ok_or_else(|| Error::new("INVALID_MANIFEST", "安装包文件名校验失败"))?;
        let expected_sha256 = asset["sha256"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(|s| s.to_ascii_lowercase())
            .ok_or_else(|| Error::new("INVALID_MANIFEST", "安装包 SHA-256 校验值缺失或无效"))?;
        let download_url_str = asset["url"]
            .as_str()
            .ok_or_else(|| Error::new("INVALID_MANIFEST", "安装包直链缺失"))?;

        let download_url = Url::parse(download_url_str)
            .map_err(|_| Error::new("INVALID_MANIFEST", "安装包直链格式无效"))?;
        if download_url.scheme() != origin.scheme()
            || download_url.host_str() != origin.host_str()
            || download_url.port_or_known_default() != origin.port_or_known_default()
            || !download_url.path().starts_with("/downloads/")
        {
            return Err(Error::new(
                "FORBIDDEN",
                "安全拦截：安装包下载地址必须指向已认证的作者服务器 /downloads/ 路径",
            ));
        }

        let target_dir = local_dir
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                self.inner
                    .core
                    .settings()
                    .get("downloadDir")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
            })
            .or_else(dirs::download_dir)
            .unwrap_or_else(std::env::temp_dir);

        tokio::fs::create_dir_all(&target_dir)
            .await
            .map_err(|e| Error::new("IO", format!("无法创建下载目录：{e}")))?;

        let final_path = target_dir.join(filename);
        let part_path = target_dir.join(format!(".{filename}.{}.qkupdate.part", uuid::Uuid::new_v4()));

        let mut resp = self
            .inner
            .http
            .get(download_url)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|_| Error::new("NETWORK", OVERSEAS_NET_HINT))?;
        if !resp.status().is_success() {
            return Err(Error::new(
                "HTTP",
                format!("更新包下载失败（HTTP {}）", resp.status().as_u16()),
            ));
        }

        let declared_size = asset["size"].as_u64().filter(|n| *n > 0);
        let max_bytes = declared_size
            .map(|n| n.saturating_add(1024 * 1024).min(MAX_UPDATE_BYTES))
            .unwrap_or(MAX_UPDATE_BYTES);
        let total = resp
            .content_length()
            .or(declared_size)
            .unwrap_or(0);
        if total > MAX_UPDATE_BYTES {
            return Err(Error::new("INVALID_MANIFEST", "更新包体积超出安全上限"));
        }
        let mut file = tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| Error::new("IO", format!("无法创建临时更新文件：{e}")))?;
        let mut hasher = Sha256::new();
        let mut downloaded: u64 = 0;
        let mut last_emit = Instant::now();

        on_progress(json!({
            "phase": "downloading",
            "filename": filename,
            "downloaded": 0,
            "total": total,
            "percent": 0
        }));

        let download_res: Result<()> = async {
            while let Some(chunk) = resp
                .chunk()
                .await
                .map_err(|_| Error::new("NETWORK", OVERSEAS_NET_HINT))?
            {
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                if downloaded > max_bytes {
                    return Err(Error::new("INVALID_MANIFEST", "更新包实际体积超出清单限制"));
                }
                hasher.update(&chunk);
                file.write_all(&chunk)
                    .await
                    .map_err(|e| Error::new("IO", format!("写入更新包失败：{e}")))?;
                if last_emit.elapsed() >= Duration::from_millis(150) {
                    let pct = if total > 0 {
                        ((downloaded as f64 / total as f64) * 100.0).min(99.0) as u64
                    } else {
                        0
                    };
                    on_progress(json!({
                        "phase": "downloading",
                        "filename": filename,
                        "downloaded": downloaded,
                        "total": total,
                        "percent": pct
                    }));
                    last_emit = Instant::now();
                }
            }
            file.flush()
                .await
                .map_err(|e| Error::new("IO", format!("刷新更新包失败：{e}")))?;
            Ok(())
        }
        .await;
        drop(file);
        if let Err(err) = download_res {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(err);
        }

        let actual_sha256 = hex::encode(hasher.finalize());
        if actual_sha256 != expected_sha256 {
            let _ = tokio::fs::remove_file(&part_path).await;
            self.record_event("error", "update", Some("CHECKSUM_MISMATCH"), "update package sha256 mismatch");
            return Err(Error::new(
                "CHECKSUM_MISMATCH",
                "安装包 SHA-256 完整性校验失败，已自动清理损坏文件，请稍后重试",
            ));
        }

        if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
            let _ = tokio::fs::remove_file(&final_path).await;
        }
        let mut rename_err = None;
        for attempt in 0..5 {
            match tokio::fs::rename(&part_path, &final_path).await {
                Ok(()) => {
                    rename_err = None;
                    break;
                }
                Err(e) => {
                    rename_err = Some(e);
                    tokio::time::sleep(Duration::from_millis(40 * (attempt + 1))).await;
                }
            }
        }
        if let Some(e) = rename_err {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(Error::new("IO", format!("保存更新包失败：{e}")));
        }

        on_progress(json!({
            "phase": "done",
            "filename": filename,
            "downloaded": downloaded,
            "total": total.max(downloaded),
            "percent": 100,
            "path": final_path.to_string_lossy(),
            "verified": true
        }));

        self.record_event(
            "info",
            "update",
            Some("UPDATE_DOWNLOADED"),
            &format!("verified update {} from {}", manifest["version"].as_str().unwrap_or(app_version), key),
        );

        if let Ok(mut guard) = self.inner.last_verified_update.lock() {
            *guard = Some(VerifiedUpdate {
                path: final_path.clone(),
                sha256: actual_sha256.clone(),
                size: downloaded,
            });
        }

        Ok(json!({
            "ok": true,
            "path": final_path.to_string_lossy(),
            "filename": filename,
            "size": downloaded,
            "sha256": actual_sha256,
            "verified": true,
            "version": manifest["version"].as_str().unwrap_or("")
        }))
    }

    /// Recheck the most recent signed package before handing it to an installer.
    pub async fn verify_update_for_install(&self, requested_path: Option<&str>) -> Result<PathBuf> {
        let verified = self
            .inner
            .last_verified_update
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .ok_or_else(|| {
                Error::new(
                    "NOT_FOUND",
                    "尚未完成已校验更新包的下载，请先点击下载更新",
                )
            })?;
        if requested_path.is_some_and(|path| Path::new(path) != verified.path) {
            return Err(Error::new(
                "FORBIDDEN",
                "安全拦截：仅允许安装本次会话通过 Ed25519 + SHA-256 校验的更新包",
            ));
        }

        let metadata = tokio::fs::symlink_metadata(&verified.path)
            .await
            .map_err(|_| Error::new("NOT_FOUND", "已下载的更新包不存在，请重新下载"))?;
        if !metadata.file_type().is_file() {
            return Err(Error::new("FORBIDDEN", "安全拦截：更新包路径必须为普通文件"));
        }
        let modified = || Error::new("CHECKSUM_MISMATCH", "更新包内容已变化，请重新下载");
        if metadata.len() != verified.size {
            return Err(modified());
        }

        let file = tokio::fs::File::open(&verified.path)
            .await
            .map_err(|e| Error::new("IO", format!("无法读取已下载的更新包：{e}")))?;
        let mut reader = file.take(verified.size.saturating_add(1));
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .await
                .map_err(|e| Error::new("IO", format!("无法读取已下载的更新包：{e}")))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        if hex::encode(hasher.finalize()) != verified.sha256 {
            return Err(modified());
        }
        Ok(verified.path)
    }

    /// Encrypt and upload strictly sanitized non-sensitive telemetry when opted in.
    pub async fn send_telemetry(&self, app_version: &str, input: Value) -> Result<Value> {
        self.require_opt_in()?;
        let explicit_samples: Vec<Value> = input["transferSamples"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(sanitize_transfer_sample)
            .take(50)
            .collect();
        let (samples, drained_from_queue) = if !explicit_samples.is_empty() {
            (explicit_samples, false)
        } else {
            (self.take_pending_samples(50), true)
        };
        let res = self
            .send_telemetry_with_samples(app_version, input, samples.clone())
            .await;
        if res.is_err() && drained_from_queue {
            self.requeue_samples(samples);
        }
        res
    }

    async fn send_telemetry_with_samples(
        &self,
        app_version: &str,
        input: Value,
        samples: Vec<Value>,
    ) -> Result<Value> {
        self.require_opt_in()?;
        let origin = self.inner.config.validated_origin()?;
        let path = "/api/v1/telemetry";
        let url = format!("{}{}", origin.as_str().trim_end_matches('/'), path);

        // Prioritize keeping recent error/warn entries so high-volume info logs never evict diagnostics.
        let all_logs = self.log_preview();
        let mut important: Vec<DiagEntry> = all_logs
            .iter()
            .filter(|e| e.level == "error" || e.level == "warn")
            .cloned()
            .collect();
        if important.len() > 55 {
            important = important.split_off(important.len() - 55);
        }
        let info_budget = 80usize.saturating_sub(important.len());
        let mut infos: Vec<DiagEntry> = all_logs
            .into_iter()
            .filter(|e| e.level != "error" && e.level != "warn")
            .collect();
        if infos.len() > info_budget {
            infos = infos.split_off(infos.len() - info_budget);
        }
        let mut recent_events = important;
        recent_events.extend(infos);
        recent_events.sort_by_key(|e| e.ts);

        let agg = if !samples.is_empty() {
            Some(aggregate_transfer_samples(&samples))
        } else {
            None
        };
        let pick_u64 = |key: &str| -> Option<u64> {
            json_u64(&input[key])
                .or_else(|| agg.as_ref().and_then(|a| json_u64(&a[key])))
        };
        let mem_mb = current_process_rss_mb().or_else(|| json_u64(&input["memMb"]));
        let hot_ui_state = crate::hot_ui::load_state(&self.inner.core.profile_dir());
        let tuning_ver = self.inner.core.tuning().version;
        let cpu_cores = std::thread::available_parallelism()
            .map(|n| n.get() as u64)
            .ok();
        let install_type = detect_install_type();
        let settings = self.inner.core.settings();
        let settings_summary = json!({
            "downloadParallel": settings["downloadParallel"].as_u64().unwrap_or(16),
            "downloadConcurrency": settings["downloadConcurrency"].as_u64().unwrap_or(2),
            "downloadStrategy": settings["downloadStrategy"].as_str().unwrap_or("auto"),
            "uploadConcurrency": settings["uploadConcurrency"].as_u64().unwrap_or(2),
            "uploadPartConcurrency": settings["uploadPartConcurrency"].as_u64().unwrap_or(3),
        });

        let payload = json!({
            "appVersion": app_version,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "eventType": redact_text(input["eventType"].as_str().unwrap_or("heartbeat"), 32),
            "clientHash": self.inner.session_salt,
            "hotUiVersion": hot_ui_state.active_version,
            "tuningVersion": tuning_ver,
            "cpuCores": cpu_cores,
            "installType": install_type,
            "settingsSummary": settings_summary,
            "errorCode": input["errorCode"]
                .as_str()
                .or_else(|| agg.as_ref().and_then(|a| a["errorCode"].as_str()))
                .map(|s| redact_text(s, 64)),
            "errorSummary": input["errorSummary"]
                .as_str()
                .or_else(|| agg.as_ref().and_then(|a| a["errorSummary"].as_str()))
                .map(|s| redact_text(s, 240)),
            "avgDlBps": pick_u64("avgDlBps"),
            "peakDlBps": pick_u64("peakDlBps"),
            "avgUlBps": pick_u64("avgUlBps"),
            "peakUlBps": pick_u64("peakUlBps"),
            "dlTasks": pick_u64("dlTasks"),
            "ulTasks": pick_u64("ulTasks"),
            "retries": pick_u64("retries"),
            "memMb": mem_mb,
            "uptimeSec": self.inner.started_at.elapsed().as_secs(),
            "recentEvents": recent_events,
            "transferSamples": samples,
        });

        let envelope = encrypt_envelope(
            &self.inner.config.x25519_pub,
            "POST",
            path,
            &serde_json::to_vec(&payload).map_err(|_| Error::new("SYSTEM", "遥测编码失败"))?,
        )?;

        let resp = self
            .inner
            .http
            .post(url)
            .timeout(Duration::from_secs(15))
            .json(&envelope)
            .send()
            .await
            .map_err(|_| Error::new("NETWORK", OVERSEAS_NET_HINT))?;

        if !resp.status().is_success() {
            return Err(Error::new(
                "HTTP",
                format!("遥测上报失败（HTTP {}）", resp.status().as_u16()),
            ));
        }
        Ok(json!({ "ok": true, "encrypted": true, "flushed": samples.len() }))
    }

    /// Load or generate a persistent, local-only 256-bit anonymous feedback token.
    /// Never exposed to renderer JS and never tied to Quark account or hardware ID.
    fn feedback_client_token(&self) -> Result<String> {
        if let Some(tok) = self.inner.feedback_token.lock().unwrap().clone() {
            return Ok(tok);
        }
        let dir = self.inner.core.profile_dir();
        let token_path = dir.join("hub-feedback-token");
        if let Ok(meta) = std::fs::symlink_metadata(&token_path) {
            if !meta.file_type().is_file() {
                return Err(Error::new("LOCAL_IO", "本地反馈凭证必须为普通文件"));
            }
            if let Ok(raw) = std::fs::read_to_string(&token_path) {
                let trimmed = raw.trim();
                if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                    let owned = trimmed.to_ascii_lowercase();
                    let mut guard = self.inner.feedback_token.lock().unwrap();
                    let final_tok = guard.get_or_insert_with(|| owned.clone()).clone();
                    return Ok(final_tok);
                }
            }
        }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        std::fs::create_dir_all(&dir)
            .map_err(|_| Error::new("LOCAL_IO", "无法创建本地反馈凭证目录"))?;
        let tmp_path = dir.join(format!("hub-feedback-token.tmp.{}", uuid::Uuid::new_v4()));
        {
            use std::io::Write;
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts
                .open(&tmp_path)
                .map_err(|_| Error::new("LOCAL_IO", "无法写入本地反馈凭证"))?;
            f.write_all(token.as_bytes())
                .and_then(|_| f.sync_all())
                .map_err(|_| Error::new("LOCAL_IO", "无法写入本地反馈凭证"))?;
        }
        #[cfg(windows)]
        {
            let _ = std::fs::remove_file(&token_path);
        }
        if std::fs::rename(&tmp_path, &token_path).is_err() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(Error::new("LOCAL_IO", "无法保存本地反馈凭证"));
        }
        let mut guard = self.inner.feedback_token.lock().unwrap();
        let final_tok = guard.get_or_insert_with(|| token.clone()).clone();
        Ok(final_tok)
    }

    /// Encrypt and submit user feedback (optionally attaching redacted diagnostic logs).
    pub async fn submit_feedback(&self, app_version: &str, input: Value) -> Result<Value> {
        self.require_opt_in()?;
        let origin = self.inner.config.validated_origin()?;
        let path = "/api/v1/feedback";
        let url = format!("{}{}", origin.as_str().trim_end_matches('/'), path);

        let message = redact_text(input["message"].as_str().unwrap_or("").trim(), 4000);
        if message.chars().count() < 2 {
            return Err(Error::new("INVALID_ARG", "请至少输入 2 个字的反馈内容"));
        }
        let category = match input["category"].as_str().unwrap_or("other") {
            c @ ("bug" | "feature" | "performance" | "ui" | "other") => c,
            _ => "other",
        };
        let contact = input["contact"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| redact_text(s, 120));
        let include_logs = input["includeLogs"].as_bool().unwrap_or(false);
        let logs = if include_logs {
            Some(self.log_preview())
        } else {
            None
        };
        let client_token = self.feedback_client_token()?;

        let payload = json!({
            "appVersion": app_version,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "category": category,
            "message": message,
            "contact": contact,
            "includeLogs": include_logs,
            "logs": logs,
            "clientToken": client_token,
        });

        let envelope = encrypt_envelope(
            &self.inner.config.x25519_pub,
            "POST",
            path,
            &serde_json::to_vec(&payload).map_err(|_| Error::new("SYSTEM", "反馈加密编码失败"))?,
        )?;

        let resp = self
            .inner
            .http
            .post(url)
            .timeout(Duration::from_secs(20))
            .json(&envelope)
            .send()
            .await
            .map_err(|_| Error::new("NETWORK", OVERSEAS_NET_HINT))?;

        let status = resp.status();
        let body: Value = read_json_bounded(resp, MAX_HUB_JSON_BYTES)
            .await
            .unwrap_or_else(|_| json!({}));
        if !status.is_success() || body["ok"] != Value::Bool(true) {
            let msg = body["error"]
                .as_str()
                .map(|s| format!("反馈提交失败：{s}"))
                .unwrap_or_else(|| format!("反馈提交失败（HTTP {}）", status.as_u16()));
            return Err(Error::new("HTTP", msg));
        }

        self.record_event("info", "feedback", Some("FEEDBACK_SENT"), "user feedback submitted");
        Ok(json!({
            "ok": true,
            "id": body["id"],
            "status": body.get("status").and_then(Value::as_str).unwrap_or("open"),
            "createdAt": body["createdAt"],
            "encrypted": true,
            "includedLogs": include_logs
        }))
    }

    /// Fetch the current installation's own feedback history and replies via E2EE.
    pub async fn list_feedback(&self) -> Result<Value> {
        self.require_opt_in()?;
        let origin = self.inner.config.validated_origin()?;
        let path = "/api/v1/feedback/mine";
        let url = format!("{}{}", origin.as_str().trim_end_matches('/'), path);
        let client_token = self.feedback_client_token()?;

        let payload = json!({ "clientToken": client_token });
        let envelope = encrypt_envelope(
            &self.inner.config.x25519_pub,
            "POST",
            path,
            &serde_json::to_vec(&payload).map_err(|_| Error::new("SYSTEM", "反馈历史请求编码失败"))?,
        )?;

        let resp = self
            .inner
            .http
            .post(url)
            .timeout(Duration::from_secs(15))
            .json(&envelope)
            .send()
            .await
            .map_err(|_| Error::new("NETWORK", OVERSEAS_NET_HINT))?;

        let status = resp.status();
        let body: Value = read_json_bounded(resp, MAX_HUB_JSON_BYTES)
            .await
            .unwrap_or_else(|_| json!({}));
        if !status.is_success() || body["ok"] != Value::Bool(true) {
            let msg = body["error"]
                .as_str()
                .map(|s| format!("读取反馈历史失败：{s}"))
                .unwrap_or_else(|| format!("读取反馈历史失败（HTTP {}）", status.as_u16()));
            return Err(Error::new("HTTP", msg));
        }
        Ok(json!({
            "ok": true,
            "items": body["items"].as_array().cloned().unwrap_or_default()
        }))
    }

    /// Append a follow-up user message to one of this installation's own feedback threads via E2EE.
    pub async fn reply_feedback(&self, input: Value) -> Result<Value> {
        self.require_opt_in()?;
        let origin = self.inner.config.validated_origin()?;
        let path = "/api/v1/feedback/reply";
        let url = format!("{}{}", origin.as_str().trim_end_matches('/'), path);

        let feedback_id = input["feedbackId"]
            .as_i64()
            .or_else(|| input["feedbackId"].as_str().and_then(|s| s.parse::<i64>().ok()))
            .filter(|id| *id > 0)
            .ok_or_else(|| Error::new("INVALID_ARG", "反馈编号无效"))?;
        let message = redact_text(input["message"].as_str().unwrap_or("").trim(), 2000);
        if message.is_empty() {
            return Err(Error::new("INVALID_ARG", "请输入要追加的回复内容"));
        }
        let client_token = self.feedback_client_token()?;

        let payload = json!({
            "clientToken": client_token,
            "feedbackId": feedback_id,
            "message": message,
        });
        let envelope = encrypt_envelope(
            &self.inner.config.x25519_pub,
            "POST",
            path,
            &serde_json::to_vec(&payload).map_err(|_| Error::new("SYSTEM", "回复消息编码失败"))?,
        )?;

        let resp = self
            .inner
            .http
            .post(url)
            .timeout(Duration::from_secs(15))
            .json(&envelope)
            .send()
            .await
            .map_err(|_| Error::new("NETWORK", OVERSEAS_NET_HINT))?;

        let status = resp.status();
        let body: Value = read_json_bounded(resp, MAX_HUB_JSON_BYTES)
            .await
            .unwrap_or_else(|_| json!({}));
        if !status.is_success() || body["ok"] != Value::Bool(true) {
            let msg = body["error"]
                .as_str()
                .map(|s| format!("发送追问失败：{s}"))
                .unwrap_or_else(|| format!("发送追问失败（HTTP {}）", status.as_u16()));
            return Err(Error::new("HTTP", msg));
        }

        self.record_event("info", "feedback", Some("FEEDBACK_REPLY"), "user appended feedback reply");
        Ok(json!({
            "ok": true,
            "reply": body["reply"],
            "updatedAt": body["updatedAt"]
        }))
    }

    async fn fetch_verified_manifest(&self) -> Result<(Value, String)> {
        let origin = self.inner.config.validated_origin()?;
        let url = format!("{}/api/v1/updates/latest", origin.as_str().trim_end_matches('/'));
        let resp = self
            .inner
            .http
            .get(url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| {
                let nk = net_error_kind(&e);
                self.record_event_rich(
                    "warn",
                    "hub_net",
                    Some(if e.is_timeout() { "TIMEOUT" } else { "NETWORK" }),
                    &format!("hub /updates/latest {nk}"),
                    None,
                    None,
                    None,
                    Some(json!({ "netKind": nk })),
                );
                if e.is_timeout() {
                    Error::new("TIMEOUT", OVERSEAS_NET_HINT)
                } else {
                    Error::new("NETWORK", OVERSEAS_NET_HINT)
                }
            })?;
        if !resp.status().is_success() {
            return Err(Error::new(
                "HTTP",
                format!("检查更新失败（HTTP {}）", resp.status().as_u16()),
            ));
        }
        let body: Value = read_json_bounded(resp, MAX_HUB_JSON_BYTES).await?;
        let manifest_json = body["manifestJson"]
            .as_str()
            .ok_or_else(|| Error::new("INVALID_MANIFEST", "服务端未返回规范化更新清单"))?;
        let sig_b64 = body["signature"]
            .as_str()
            .ok_or_else(|| Error::new("SIGNATURE_INVALID", "更新清单缺少 Ed25519 数字签名"))?;

        verify_manifest_signature(&self.inner.config.ed25519_pub, manifest_json, sig_b64)?;

        let manifest: Value = serde_json::from_str(manifest_json)
            .map_err(|_| Error::new("INVALID_MANIFEST", "更新清单 JSON 解析失败"))?;
        let region = body["serverRegion"]
            .as_str()
            .unwrap_or(&self.inner.config.region)
            .to_string();
        Ok((manifest, region))
    }
}

/// Forward-secret hybrid encryption: Ephemeral X25519 ECDH + SHA-256 KDF + AES-256-GCM.
pub fn encrypt_envelope(
    server_x25519_pub: &[u8; 32],
    method: &str,
    path: &str,
    plaintext: &[u8],
) -> Result<Value> {
    let sys_rng = SystemRandom::new();
    let epk_priv = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &sys_rng)
        .map_err(|_| Error::new("CRYPTO", "生成临时加密密钥失败"))?;
    let epk_pub = epk_priv
        .compute_public_key()
        .map_err(|_| Error::new("CRYPTO", "派生临时公钥失败"))?;
    let epk_raw: Vec<u8> = epk_pub.as_ref().to_vec();

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut nonce_bytes = [0u8; 16];
    let mut iv_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    rand::rngs::OsRng.fill_bytes(&mut iv_bytes);
    let nonce_hex = hex::encode(nonce_bytes);
    let aad = format!("{method}|{path}|{ts}|{nonce_hex}");

    let peer_pub = agreement::UnparsedPublicKey::new(&agreement::X25519, server_x25519_pub);
    let epk_for_kdf = epk_raw.clone();
    let nonce_for_kdf = nonce_hex.clone();
    let aad_bytes = aad.into_bytes();

    let ciphertext = agreement::agree_ephemeral(epk_priv, &peer_pub, |shared_secret| {
        let mut kdf = Sha256::new();
        kdf.update(b"qdl-hub-v1|aes-256-gcm|");
        kdf.update(shared_secret);
        kdf.update(&epk_for_kdf);
        kdf.update(server_x25519_pub);
        kdf.update(format!("|{ts}|{nonce_for_kdf}").as_bytes());
        let aes_key = kdf.finalize();

        let cipher = Aes256Gcm::new_from_slice(&aes_key).ok()?;
        let nonce = Nonce::from_slice(&iv_bytes);
        cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad: &aad_bytes,
                },
            )
            .ok()
    })
    .map_err(|_| Error::new("CRYPTO", "ECDH 密钥协商失败"))?
    .ok_or_else(|| Error::new("CRYPTO", "AES-256-GCM 载荷加密失败"))?;

    Ok(json!({
        "v": 1,
        "ts": ts,
        "nonce": nonce_hex,
        "epk": B64.encode(&epk_raw),
        "iv": B64.encode(iv_bytes),
        "ct": B64.encode(ciphertext),
    }))
}

/// Verify Ed25519 signature over `"qdl-manifest-v1|" + manifest_json`.
pub fn verify_manifest_signature(
    server_ed25519_pub: &[u8; 32],
    manifest_json: &str,
    signature_b64: &str,
) -> Result<()> {
    let sig_bytes = B64
        .decode(signature_b64.trim())
        .map_err(|_| Error::new("SIGNATURE_INVALID", "更新清单签名编码无效"))?;
    let mut msg = Vec::with_capacity(16 + manifest_json.len());
    msg.extend_from_slice(b"qdl-manifest-v1|");
    msg.extend_from_slice(manifest_json.as_bytes());
    let pub_key = signature::UnparsedPublicKey::new(&signature::ED25519, server_ed25519_pub);
    pub_key
        .verify(&msg, &sig_bytes)
        .map_err(|_| Error::new("SIGNATURE_INVALID", "更新清单 Ed25519 数字签名校验失败，已拒绝加载"))
}

pub fn recommended_asset_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", _) => "macos-x64",
        ("windows", _) => {
            if detect_install_type() == "win_portable" {
                "windows-x64-portable"
            } else {
                "windows-x64-setup"
            }
        }
        ("linux", "x86_64") => {
            if std::env::var_os("APPIMAGE").is_some() {
                "linux-x64-appimage"
            } else {
                "linux-x64-deb"
            }
        }
        ("linux", "aarch64") => "linux-arm64-deb",
        _ => "windows-x64-portable",
    }
}

fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Compare versions like `0.3.0-beta.2` vs `0.3.0-beta.1` or `0.3.0` > `0.3.0-beta.9`.
pub fn version_is_newer(candidate: &str, current: &str) -> bool {
    parse_semver(candidate) > parse_semver(current)
}

/// Check whether `current` is within optional inclusive `[min_version, max_version]` bounds.
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
        None => (3u8, 0u64), // stable > rc > beta > alpha
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

async fn read_json_bounded(mut resp: reqwest::Response, max_bytes: usize) -> Result<Value> {
    if resp.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err(Error::new("PARSE", "响应体过大"));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        if e.is_timeout() {
            Error::new("TIMEOUT", OVERSEAS_NET_HINT)
        } else {
            Error::new("NETWORK", OVERSEAS_NET_HINT)
        }
    })? {
        if buf.len().saturating_add(chunk.len()) > max_bytes {
            return Err(Error::new("PARSE", "响应体过大"));
        }
        buf.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&buf).map_err(|_| Error::new("PARSE", "响应 JSON 格式无效"))
}

fn json_u64(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| {
        v.as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0 && *f <= u64::MAX as f64)
            .map(|f| f.round() as u64)
    })
}

/// Persist a strictly redacted panic breadcrumb (`file:line:col` + redacted message, zero PII)
/// so the next app startup automatically captures and reports crashes into diagnostics.
pub fn record_panic_breadcrumb(profile_dir: &std::path::Path, location: &str, message: &str) {
    let clean_loc = location
        .replace('\\', "/")
        .rsplit_once("/src/")
        .map(|(_, tail)| format!("src/{tail}"))
        .unwrap_or_else(|| {
            location
                .replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap_or("unknown")
                .to_string()
        });
    let payload = json!({
        "ts": now_ms(),
        "version": env!("CARGO_PKG_VERSION"),
        "location": redact_text(&clean_loc, 120),
        "message": redact_text(message, 220),
    });
    let path = profile_dir.join("last-crash.json");
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        let _ = std::fs::write(path, bytes);
    }
}

fn ingest_last_crash(profile_dir: &std::path::Path) -> Option<DiagEntry> {
    let path = profile_dir.join("last-crash.json");
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.file_type().is_file() || meta.len() > 16 * 1024 {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let parsed: Value = serde_json::from_slice(&bytes).ok()?;
    let loc = parsed["location"].as_str().unwrap_or("unknown");
    let msg = parsed["message"].as_str().unwrap_or("panic");
    let prev_ver = parsed["version"].as_str().unwrap_or("unknown");
    Some(DiagEntry {
        ts: parsed["ts"].as_i64().unwrap_or_else(now_ms),
        level: "error".into(),
        category: "crash".into(),
        code: Some("RUST_PANIC".into()),
        msg: redact_text(&format!("previous crash v{prev_ver} at {loc}: {msg}"), 320),
        http_status: None,
        biz_code: None,
        duration_ms: None,
        meta: Some(json!({ "prevVersion": prev_ver, "location": loc })),
        count: None,
    })
}

fn detect_install_type() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            return "appimage";
        }
        if std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(|s| s.starts_with("/usr/")))
            .unwrap_or(false)
        {
            return "deb";
        }
        "linux_bin"
    }
    #[cfg(target_os = "macos")]
    {
        if std::env::current_exe()
            .ok()
            .is_some_and(|p| p.ancestors().any(|a| a.extension().and_then(|e| e.to_str()) == Some("app")))
        {
            return "app_bundle";
        }
        "macos_bin"
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            let low = exe.to_string_lossy().to_ascii_lowercase();
            let has_uninstaller = exe
                .parent()
                .is_some_and(|dir| dir.join("uninstall.exe").is_file());
            if has_uninstaller
                || low.contains("program files")
                || low.contains("appdata\\local\\programs")
            {
                return "win_setup";
            }
            return "win_portable";
        }
        "win_bin"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        "other"
    }
}

fn net_error_kind(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect_failed"
    } else if e.is_body() {
        "body_error"
    } else if e.is_decode() {
        "decode_error"
    } else if e.is_request() {
        "request_error"
    } else {
        "network_other"
    }
}

fn current_process_rss_mb() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    if let Some(kb) = rest
                        .split_whitespace()
                        .next()
                        .and_then(|s| s.parse::<u64>().ok())
                    {
                        return Some((kb / 1024).max(1));
                    }
                }
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()?;
        let kb = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u64>()
            .ok()?;
        Some((kb / 1024).max(1))
    }
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct ProcessMemoryCounters {
            cb: u32,
            page_fault_count: u32,
            peak_working_set_size: usize,
            working_set_size: usize,
            quota_peak_paged_pool_usage: usize,
            quota_paged_pool_usage: usize,
            quota_peak_non_paged_pool_usage: usize,
            quota_non_paged_pool_usage: usize,
            pagefile_usage: usize,
            peak_pagefile_usage: usize,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> *mut core::ffi::c_void;
            fn K32GetProcessMemoryInfo(
                process: *mut core::ffi::c_void,
                ppsmem_counters: *mut ProcessMemoryCounters,
                cb: u32,
            ) -> i32;
        }
        let mut pmc = std::mem::MaybeUninit::<ProcessMemoryCounters>::zeroed();
        let cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
        unsafe {
            (*pmc.as_mut_ptr()).cb = cb;
            if K32GetProcessMemoryInfo(GetCurrentProcess(), pmc.as_mut_ptr(), cb) != 0 {
                let ws = pmc.assume_init().working_set_size as u64;
                return Some((ws / (1024 * 1024)).max(1));
            }
        }
        None
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

fn sanitize_code_token(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 48 {
        return None;
    }
    if t.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        Some(t.to_string())
    } else {
        None
    }
}

fn sanitize_diag_meta(val: Value) -> Option<Value> {
    let obj = val.as_object()?;
    let mut out = serde_json::Map::new();
    for (k, v) in obj.iter().take(24) {
        if k.len() > 40 {
            continue;
        }
        let clean = match v {
            Value::Null | Value::Bool(_) | Value::Number(_) => v.clone(),
            Value::String(s) => Value::String(redact_text(s, 80)),
            _ => continue,
        };
        out.insert(k.clone(), clean);
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

/// Strictly allowlist-validate a transfer sample so zero PII (no filenames, paths, FIDs, URLs) can enter.
fn sanitize_transfer_sample(raw: &Value) -> Option<Value> {
    let kind = match raw["kind"].as_str()? {
        k @ ("download" | "upload") => k,
        _ => return None,
    };
    let outcome = match raw["outcome"].as_str().unwrap_or("done") {
        o @ ("done" | "error" | "canceled") => o,
        _ => "error",
    };
    let size_bytes = json_u64(&raw["sizeBytes"]).unwrap_or(0);
    let size_bucket = match raw["sizeBucket"].as_str() {
        Some(b @ ("0" | "<1M" | "1M-10M" | "10M-100M" | "100M-1G" | "1G-10G" | ">10G")) => b,
        _ => size_bucket_for(size_bytes),
    };
    let transferred_bytes = json_u64(&raw["transferredBytes"]).unwrap_or(0);
    let duration_ms = json_u64(&raw["durationMs"]).unwrap_or(0);
    let link_ms = json_u64(&raw["linkMs"]).unwrap_or(0);
    let probe_ms = json_u64(&raw["probeMs"]).unwrap_or(0);
    let transfer_ms = json_u64(&raw["transferMs"]).unwrap_or(0);
    let hash_ms = json_u64(&raw["hashMs"]).unwrap_or(0);
    let publish_ms = json_u64(&raw["publishMs"]).unwrap_or(0);
    let avg_bps = json_u64(&raw["avgBps"]).unwrap_or_else(|| {
        if duration_ms > 0 {
            transferred_bytes.saturating_mul(1000) / duration_ms.max(1)
        } else {
            0
        }
    });
    let peak_bps = json_u64(&raw["peakBps"]).unwrap_or(avg_bps).max(avg_bps);
    let chunk_size = json_u64(&raw["chunkSize"]).unwrap_or(0);
    let parallel = json_u64(&raw["parallel"]).unwrap_or(1).min(256);
    let min_parallel = json_u64(&raw["minParallel"]).unwrap_or(parallel).min(256);
    let aimd_downshifts = json_u64(&raw["aimdDownshifts"]).unwrap_or(0).min(10_000);
    let concurrency = json_u64(&raw["concurrency"]).unwrap_or(1).min(64);
    let strategy = raw["strategy"]
        .as_str()
        .and_then(sanitize_code_token)
        .unwrap_or_else(|| "unknown".into());
    let attempts = json_u64(&raw["attempts"]).unwrap_or(1).min(1000);
    let part_retries = json_u64(&raw["partRetries"]).unwrap_or(0).min(10_000);
    let link_refreshes = json_u64(&raw["linkRefreshes"]).unwrap_or(0).min(10_000);
    let rapid_upload = raw["rapidUpload"].as_bool().unwrap_or(false);
    let resumed = raw["resumed"].as_bool().unwrap_or(false);
    let rate_limited = raw["rateLimited"].as_bool().unwrap_or(false);
    let error_code = raw["errorCode"].as_str().and_then(sanitize_code_token);
    let http_status = json_u64(&raw["httpStatus"])
        .filter(|&s| (100..=599).contains(&s));
    let stage = raw["stage"].as_str().and_then(sanitize_code_token);
    let io_kind = raw["ioKind"].as_str().and_then(sanitize_code_token);
    let os_errno = raw["osErrno"]
        .as_i64()
        .filter(|&n| (-1_000_000..=1_000_000).contains(&n));
    let ts = raw["ts"].as_i64().unwrap_or_else(now_ms);

    Some(json!({
        "ts": ts,
        "kind": kind,
        "outcome": outcome,
        "sizeBytes": size_bytes,
        "sizeBucket": size_bucket,
        "transferredBytes": transferred_bytes,
        "durationMs": duration_ms,
        "linkMs": link_ms,
        "probeMs": probe_ms,
        "transferMs": transfer_ms,
        "hashMs": hash_ms,
        "publishMs": publish_ms,
        "avgBps": avg_bps,
        "peakBps": peak_bps,
        "chunkSize": chunk_size,
        "parallel": parallel,
        "minParallel": min_parallel,
        "aimdDownshifts": aimd_downshifts,
        "concurrency": concurrency,
        "strategy": strategy,
        "attempts": attempts,
        "partRetries": part_retries,
        "linkRefreshes": link_refreshes,
        "rapidUpload": rapid_upload,
        "resumed": resumed,
        "rateLimited": rate_limited,
        "errorCode": error_code,
        "httpStatus": http_status,
        "stage": stage,
        "ioKind": io_kind,
        "osErrno": os_errno,
    }))
}

fn size_bucket_for(bytes: u64) -> &'static str {
    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;
    if bytes == 0 {
        "0"
    } else if bytes < MIB {
        "<1M"
    } else if bytes < 10 * MIB {
        "1M-10M"
    } else if bytes < 100 * MIB {
        "10M-100M"
    } else if bytes < GIB {
        "100M-1G"
    } else if bytes < 10 * GIB {
        "1G-10G"
    } else {
        ">10G"
    }
}

fn aggregate_transfer_samples(samples: &[Value]) -> Value {
    let mut dl_bytes: u128 = 0;
    let mut dl_ms: u128 = 0;
    let mut dl_peak: u64 = 0;
    let mut dl_tasks: u64 = 0;
    let mut ul_bytes: u128 = 0;
    let mut ul_ms: u128 = 0;
    let mut ul_peak: u64 = 0;
    let mut ul_tasks: u64 = 0;
    let mut retries: u64 = 0;
    let mut err_code: Option<String> = None;
    let mut err_summary: Option<String> = None;

    for s in samples {
        let kind = s["kind"].as_str().unwrap_or("");
        let outcome = s["outcome"].as_str().unwrap_or("");
        let rapid = s["rapidUpload"].as_bool().unwrap_or(false);
        let throttled = s["rateLimited"].as_bool().unwrap_or(false);
        let bytes = s["transferredBytes"].as_u64().unwrap_or(0);
        let dur = s["durationMs"].as_u64().unwrap_or(0);
        let peak = s["peakBps"].as_u64().unwrap_or(0);
        retries = retries.saturating_add(s["partRetries"].as_u64().unwrap_or(0));

        if kind == "download" {
            dl_tasks += 1;
            if outcome == "done" && !throttled && bytes > 0 && dur > 0 {
                dl_bytes += bytes as u128;
                dl_ms += dur as u128;
                dl_peak = dl_peak.max(peak);
            }
        } else if kind == "upload" {
            ul_tasks += 1;
            if outcome == "done" && !rapid && !throttled && bytes > 0 && dur > 0 {
                ul_bytes += bytes as u128;
                ul_ms += dur as u128;
                ul_peak = ul_peak.max(peak);
            }
        }
        if outcome == "error" && err_code.is_none() {
            err_code = s["errorCode"].as_str().map(str::to_string);
            err_summary = Some(format!(
                "{} failed at {} ({})",
                kind,
                s["stage"].as_str().unwrap_or("unknown"),
                err_code.as_deref().unwrap_or("ERROR")
            ));
        }
    }

    let avg_dl = if dl_ms > 0 {
        Some((dl_bytes.saturating_mul(1000) / dl_ms) as u64)
    } else {
        None
    };
    let avg_ul = if ul_ms > 0 {
        Some((ul_bytes.saturating_mul(1000) / ul_ms) as u64)
    } else {
        None
    };

    json!({
        "eventType": if err_code.is_some() { "transfer_error" } else { "transfer_batch" },
        "avgDlBps": avg_dl,
        "peakDlBps": if dl_peak > 0 { Some(dl_peak) } else { None },
        "avgUlBps": avg_ul,
        "peakUlBps": if ul_peak > 0 { Some(ul_peak) } else { None },
        "dlTasks": dl_tasks,
        "ulTasks": ul_tasks,
        "retries": retries,
        "errorCode": err_code,
        "errorSummary": err_summary,
    })
}

/// Strict client-side PII redaction before storing in diagnostic ring buffer or encrypting for upload.
pub fn redact_text(input: &str, max_chars: usize) -> String {
    let mut s: String = input.chars().take(max_chars).collect();
    // 0. Redact full Cookie/Authorization header lines up to EOL
    s = redact_header_line_ci(&s, "cookie:", "[REDACTED_COOKIE]");
    s = redact_header_line_ci(&s, "set-cookie:", "[REDACTED_COOKIE]");
    s = redact_header_line_ci(&s, "authorization:", "[REDACTED_TOKEN]");
    // 1. Redact known cookie key=value pairs
    for cookie_key in [
        "__pus=",
        "__puus=",
        "__kp=",
        "__kps=",
        "__ktd=",
        "__uid=",
        "ctoken=",
        "b-user-id=",
    ] {
        s = redact_key_value_ci(&s, cookie_key, "[REDACTED_COOKIE]");
    }
    // 2. Redact sensitive query params (including Quark signed download params)
    for qp in [
        "auth_key=",
        "token=",
        "sign=",
        "signature=",
        "secret=",
        "password=",
        "api_key=",
        "apikey=",
        "ossaccesskeyid=",
        "st=",
        "kps=",
        "ktd=",
    ] {
        s = redact_key_value_ci(&s, qp, "[REDACTED]");
    }
    // 2b. Redact JSON secret key-value pairs like "token":"..." / "cookie":"..."
    for jk in [
        "\"token\"",
        "\"cookie\"",
        "\"cookies\"",
        "\"password\"",
        "\"secret\"",
        "\"apikey\"",
        "\"api_key\"",
        "\"authorization\"",
        "\"clienttoken\"",
    ] {
        s = redact_json_secret_ci(&s, jk);
    }
    // 3. Redact Bearer / Basic / sk- tokens
    s = redact_prefix_token_ci(&s, "bearer ", "Bearer [REDACTED_TOKEN]");
    s = redact_prefix_token_ci(&s, "basic ", "Basic [REDACTED_TOKEN]");
    s = redact_sk_keys(&s);
    // 4. Redact macOS/Linux/Windows user home directory paths (including private filenames)
    s = redact_home_paths(&s);
    // 5. Redact IPv4 & IPv6 addresses
    s = redact_ipv4(&s);
    s = redact_ipv6(&s);
    s
}

fn redact_header_line_ci(input: &str, needle_lower: &str, replacement: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if lower[i..].starts_with(needle_lower) {
            let key_end = i + needle_lower.len();
            out.push_str(&input[i..key_end]);
            out.push(' ');
            out.push_str(replacement);
            let mut j = key_end;
            while j < input.len() {
                let ch = input[j..].chars().next().unwrap();
                if matches!(ch, '\r' | '\n') {
                    break;
                }
                j += ch.len_utf8();
            }
            i = j;
        } else {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn redact_json_secret_ci(input: &str, key_quoted_lower: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if lower[i..].starts_with(key_quoted_lower) {
            let key_end = i + key_quoted_lower.len();
            let mut j = key_end;
            while j < input.len() && input.as_bytes()[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < input.len() && input.as_bytes()[j] == b':' {
                j += 1;
                while j < input.len() && input.as_bytes()[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < input.len() && input.as_bytes()[j] == b'"' {
                    out.push_str(&input[i..=j]);
                    out.push_str("[REDACTED]\"");
                    j += 1;
                    while j < input.len() {
                        let b = input.as_bytes()[j];
                        if b == b'\\' && j + 1 < input.len() {
                            j += 2;
                            continue;
                        }
                        if b == b'"' {
                            j += 1;
                            break;
                        }
                        let ch = input[j..].chars().next().unwrap();
                        j += ch.len_utf8();
                    }
                    i = j;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn redact_key_value_ci(input: &str, needle_lower: &str, replacement: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if lower[i..].starts_with(needle_lower) {
            let key_end = i + needle_lower.len();
            out.push_str(&input[i..key_end]);
            out.push_str(replacement);
            let mut j = key_end;
            while j < input.len() {
                let ch = input[j..].chars().next().unwrap();
                if matches!(ch, ';' | '&' | ' ' | '\t' | '\r' | '\n' | '"' | '\'' | ',') {
                    break;
                }
                j += ch.len_utf8();
            }
            i = j;
        } else {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn redact_prefix_token_ci(input: &str, prefix_lower: &str, replacement: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if lower[i..].starts_with(prefix_lower) {
            out.push_str(replacement);
            let mut j = i + prefix_lower.len();
            while j < input.len() {
                let ch = input[j..].chars().next().unwrap();
                if ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | ';') {
                    break;
                }
                j += ch.len_utf8();
            }
            i = j;
        } else {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn redact_sk_keys(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i..].starts_with("sk-") {
            let mut j = i + 3;
            while j < input.len() {
                let b = input.as_bytes()[j];
                if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
                    j += 1;
                } else {
                    break;
                }
            }
            if j - i >= 12 {
                out.push_str("[REDACTED_API_KEY]");
                i = j;
                continue;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn redact_home_paths(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let bytes = input.as_bytes();
    while i < input.len() {
        if lower[i..].starts_with("/users/") || lower[i..].starts_with("/home/") {
            let prefix_len = if lower[i..].starts_with("/users/") { 7 } else { 6 };
            out.push_str("/[USER_HOME]/[REDACTED_PATH]");
            let mut j = i + prefix_len;
            while j < input.len() {
                let ch = input[j..].chars().next().unwrap();
                if matches!(ch, ' ' | '\t' | '\r' | '\n' | '"' | '\'' | ',' | ')' | ']' | '>') {
                    break;
                }
                j += ch.len_utf8();
            }
            i = j;
            continue;
        }
        if i + 9 <= bytes.len()
            && bytes[i].is_ascii_alphabetic()
            && (lower[i + 1..].starts_with(":\\users\\") || lower[i + 1..].starts_with(":/users/"))
        {
            out.push_str("C:\\[USER_HOME]\\[REDACTED_PATH]");
            let mut j = i + 9;
            while j < input.len() {
                let ch = input[j..].chars().next().unwrap();
                if matches!(ch, '\t' | '\r' | '\n' | '"' | '\'' | ',' | ')' | ']' | '>') {
                    break;
                }
                if ch == ' ' {
                    // Continue past spaces inside Windows user/folder names if followed by a slash segment
                    let rest = &input[j + 1..];
                    let next_space = rest.find([' ', '\t', '\r', '\n', '"', '\'']).unwrap_or(rest.len());
                    if !rest[..next_space].contains(['\\', '/']) {
                        break;
                    }
                }
                j += ch.len_utf8();
            }
            i = j;
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn redact_ipv6(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let bytes = input.as_bytes();
    while i < bytes.len() {
        if bytes[i].is_ascii_hexdigit() || bytes[i] == b':' {
            let mut j = i;
            let mut colons = 0usize;
            while j < bytes.len() && (bytes[j].is_ascii_hexdigit() || bytes[j] == b':') {
                if bytes[j] == b':' {
                    colons += 1;
                }
                j += 1;
            }
            if colons >= 2 && (j - i) >= 4 {
                let candidate = &input[i..j];
                if candidate.parse::<std::net::Ipv6Addr>().is_ok() {
                    out.push_str("[REDACTED_IP]");
                    i = j;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn redact_ipv4(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut j = i;
            let mut dots = 0;
            let mut valid = true;
            let mut seg_len = 0;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
                if bytes[j] == b'.' {
                    if seg_len == 0 || seg_len > 3 {
                        valid = false;
                    }
                    dots += 1;
                    seg_len = 0;
                } else {
                    seg_len += 1;
                }
                j += 1;
            }
            if valid && dots == 3 && seg_len >= 1 && seg_len <= 3 {
                let candidate = &input[i..j];
                if candidate
                    .split('.')
                    .all(|p| p.parse::<u16>().is_ok_and(|n| n <= 255))
                {
                    out.push_str("[REDACTED_IP]");
                    i = j;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
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
    use ring::signature::{Ed25519KeyPair, KeyPair};

    #[test]
    fn redact_text_strips_cookies_tokens_paths_urls_and_ips() {
        let raw = "Cookie: a=1; __pus=secret123\nAuthorization: Bearer tok_abc987654321\n{\"token\":\"json_secret_99\",\"cookie\":\"c_val\"} sk-live1234567890abcdef /Users/alice/Desktop/secret.pdf /home/charlie/private/movie.mkv C:\\Users\\Bob\\Downloads\\a.zip https://dl.example/f?auth_key=xyz999&st=quark_st_1&kps=quark_kps_2&ktd=quark_ktd_3&a=1 from 192.168.31.101 and 2001:db8::42";
        let clean = redact_text(raw, 2000);
        assert!(!clean.contains("secret123"));
        assert!(!clean.contains("tok_abc987654321"));
        assert!(!clean.contains("json_secret_99"));
        assert!(!clean.contains("c_val"));
        assert!(!clean.contains("sk-live1234567890abcdef"));
        assert!(!clean.contains("alice"));
        assert!(!clean.contains("secret.pdf"));
        assert!(!clean.contains("charlie"));
        assert!(!clean.contains("movie.mkv"));
        assert!(!clean.contains("Bob"));
        assert!(!clean.contains("a.zip"));
        assert!(!clean.contains("xyz999"));
        assert!(!clean.contains("quark_st_1"));
        assert!(!clean.contains("quark_kps_2"));
        assert!(!clean.contains("quark_ktd_3"));
        assert!(!clean.contains("192.168.31.101"));
        assert!(!clean.contains("2001:db8::42"));
        assert!(clean.contains("[REDACTED_COOKIE]"));
        assert!(clean.contains("[REDACTED_TOKEN]"));
        assert!(clean.contains("[REDACTED_API_KEY]"));
        assert!(clean.contains("/[USER_HOME]/[REDACTED_PATH]"));
        assert!(clean.contains("C:\\[USER_HOME]\\[REDACTED_PATH]"));
        assert!(clean.contains("[REDACTED_IP]"));
    }

    #[tokio::test]
    async fn opt_out_hard_blocks_all_network_calls() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open_no_proxy(dir.path()).unwrap();
        // Default serverOptIn MUST be false
        assert_eq!(core.settings()["serverOptIn"], Value::Bool(false));
        let hub = HubClient::new(core, HubConfig::from_env_or_default()).unwrap();

        for res in [
            hub.check_update("0.3.0-beta.1").await,
            hub.download_update("0.3.0-beta.1", None, None, |_| {}).await,
            hub.send_telemetry("0.3.0-beta.1", json!({"eventType":"heartbeat"})).await,
            hub.submit_feedback("0.3.0-beta.1", json!({"category":"bug","message":"test msg"})).await,
            hub.list_feedback().await,
            hub.reply_feedback(json!({"feedbackId":1,"message":"follow up"})).await,
        ] {
            let err = res.expect_err("must block when serverOptIn == false");
            assert_eq!(err.code, "OPT_IN_REQUIRED");
        }
    }

    #[test]
    fn feedback_token_persists_across_reloads_and_recovers_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("hub-feedback-token");
        // Seed a corrupt file first so Windows overwrite semantics (remove before rename) are exercised!
        std::fs::write(&token_path, "corrupt-short-token").unwrap();

        let core1 = Core::open_no_proxy(dir.path()).unwrap();
        let hub1 = HubClient::new(core1, HubConfig::from_env_or_default()).unwrap();
        let tok1 = hub1.feedback_client_token().unwrap();
        assert_eq!(tok1.len(), 64);
        assert!(tok1.bytes().all(|b| b.is_ascii_hexdigit()));

        // Reload with a fresh HubClient pointing to the same profile_dir -> must return identical token
        let core2 = Core::open_no_proxy(dir.path()).unwrap();
        let hub2 = HubClient::new(core2, HubConfig::from_env_or_default()).unwrap();
        let tok2 = hub2.feedback_client_token().unwrap();
        assert_eq!(tok1, tok2);
    }

    #[test]
    fn version_comparison_handles_semver_and_prerelease() {
        assert!(version_is_newer("0.3.0-beta.2", "0.3.0-beta.1"));
        assert!(version_is_newer("0.3.0", "0.3.0-beta.9"));
        assert!(version_is_newer("0.3.1", "0.3.0"));
        assert!(version_is_newer("1.0.0", "0.9.9"));
        assert!(!version_is_newer("0.3.0-beta.1", "0.3.0-beta.1"));
        assert!(!version_is_newer("0.3.0-beta.1", "0.3.0"));
    }

    #[test]
    fn ed25519_verification_accepts_valid_and_rejects_tampered_manifest() {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let kp = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let mut pub32 = [0u8; 32];
        pub32.copy_from_slice(kp.public_key().as_ref());

        let manifest = r#"{"assets":{},"version":"0.3.0-beta.2"}"#;
        let msg = format!("qdl-manifest-v1|{manifest}");
        let sig = B64.encode(kp.sign(msg.as_bytes()).as_ref());

        assert!(verify_manifest_signature(&pub32, manifest, &sig).is_ok());
        let tampered = r#"{"assets":{},"version":"0.3.0-beta.9"}"#;
        let err = verify_manifest_signature(&pub32, tampered, &sig).unwrap_err();
        assert_eq!(err.code, "SIGNATURE_INVALID");
    }

    #[test]
    fn x25519_aes_gcm_envelope_roundtrip_and_aad_tamper_detection() {
        let rng = SystemRandom::new();
        let server_priv = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).unwrap();
        let server_pub_bytes = server_priv.compute_public_key().unwrap();
        let mut server_pub = [0u8; 32];
        server_pub.copy_from_slice(server_pub_bytes.as_ref());

        let secret_msg = br#"{"eventType":"heartbeat","avgDlBps":12500000}"#;
        let env = encrypt_envelope(&server_pub, "POST", "/api/v1/telemetry", secret_msg).unwrap();

        let ts = env["ts"].as_u64().unwrap();
        let nonce_hex = env["nonce"].as_str().unwrap();
        let epk_raw = B64.decode(env["epk"].as_str().unwrap()).unwrap();
        let iv = B64.decode(env["iv"].as_str().unwrap()).unwrap();
        let ct = B64.decode(env["ct"].as_str().unwrap()).unwrap();
        assert_eq!(epk_raw.len(), 32);
        assert_eq!(iv.len(), 12);

        let client_pub = agreement::UnparsedPublicKey::new(&agreement::X25519, &epk_raw);
        let (decrypted, tampered_ok) = agreement::agree_ephemeral(server_priv, &client_pub, |shared| {
            let mut kdf = Sha256::new();
            kdf.update(b"qdl-hub-v1|aes-256-gcm|");
            kdf.update(shared);
            kdf.update(&epk_raw);
            kdf.update(&server_pub);
            kdf.update(format!("|{ts}|{nonce_hex}").as_bytes());
            let aes_key = kdf.finalize();
            let cipher = Aes256Gcm::new_from_slice(&aes_key).unwrap();
            let good_aad = format!("POST|/api/v1/telemetry|{ts}|{nonce_hex}");
            let plain = cipher
                .decrypt(
                    Nonce::from_slice(&iv),
                    Payload {
                        msg: &ct,
                        aad: good_aad.as_bytes(),
                    },
                )
                .unwrap();
            let bad_aad = format!("POST|/api/v1/feedback|{ts}|{nonce_hex}");
            let bad = cipher
                .decrypt(
                    Nonce::from_slice(&iv),
                    Payload {
                        msg: &ct,
                        aad: bad_aad.as_bytes(),
                    },
                )
                .is_ok();
            (plain, bad)
        })
        .unwrap();

        assert_eq!(decrypted, secret_msg);
        assert!(!tampered_ok, "tampered AAD must fail GCM tag verification");
    }

    #[tokio::test]
    async fn e2e_rust_client_against_in_process_signed_e2ee_hub_mock() {
        use ring::signature::KeyPair;
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, Ordering};

        let rng = SystemRandom::new();
        let ed_pkcs8 = signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let ed_kp = signature::Ed25519KeyPair::from_pkcs8(ed_pkcs8.as_ref()).unwrap();
        let ed25519_pub: [u8; 32] = ed_kp.public_key().as_ref().try_into().unwrap();

        // Ephemeral server X25519 static keypair simulated via ring::agreement (fixed 32B secret test vector using X25519)
        let x25519_priv_pkcs8 =
            agreement::EphemeralPrivateKey::generate(&agreement::X25519, &rng).unwrap();
        let x25519_pub_bytes = x25519_priv_pkcs8.compute_public_key().unwrap();
        let x25519_pub: [u8; 32] = x25519_pub_bytes.as_ref().try_into().unwrap();
        drop(x25519_priv_pkcs8);

        let pkg_bytes = b"fake-installer-binary-payload-for-sha256-e2e-verification-1234567890".to_vec();
        let pkg_sha = hex::encode(Sha256::digest(&pkg_bytes));
        let hf_obj = json!({
            "version": "0.3.0-ui.1",
            "minBinaryVersion": "0.3.0-beta.1",
            "maxBinaryVersion": "0.3.99",
            "files": {
                "index.html": "<!doctype html><html><body>hotfix-v1</body></html>",
                "app.js": "window.__hotfix = '0.3.0-ui.1';"
            }
        });
        let hf_bytes = serde_json::to_vec(&hf_obj).unwrap();
        let hf_sha = hex::encode(Sha256::digest(&hf_bytes));
        let html_sha = hex::encode(Sha256::digest(b"<!doctype html><html><body>hotfix-v1</body></html>"));
        let js_sha = hex::encode(Sha256::digest(b"window.__hotfix = '0.3.0-ui.1';"));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let base_url = format!("http://127.0.0.1:{port}");
        let stop = Arc::new(AtomicBool::new(false));
        let stop_bg = stop.clone();

        let rec_key = recommended_asset_key().to_string();
        let manifest_obj = json!({
            "assets": {
                rec_key: {
                    "filename": "QuarkDriveLite-0.3.0-beta.2.zip",
                    "size": pkg_bytes.len(),
                    "sha256": pkg_sha,
                    "url": format!("{base_url}/downloads/QuarkDriveLite-0.3.0-beta.2.zip")
                }
            },
            "channel": "beta",
            "changelog": "E2E signed release test",
            "minVersion": "0.3.0-beta.2",
            "notice": "测试公告：欢迎体验新版",
            "releaseDate": "2026-11-28",
            "tuning": {
                "version": 2,
                "smallFileDirectMaxBytes": 4 * 1024 * 1024,
                "aimdMinParallel": 3,
                "dirDetailNegCacheMs": 120000
            },
            "uiHotfix": {
                "version": "0.3.0-ui.1",
                "minBinaryVersion": "0.3.0-beta.1",
                "maxBinaryVersion": "0.3.99",
                "changelog": "hotfix dirDetail cache",
                "filename": "qdl-ui-hotfix-0.3.0-ui.1.json",
                "size": hf_bytes.len(),
                "sha256": hf_sha,
                "url": format!("{base_url}/downloads/qdl-ui-hotfix-0.3.0-ui.1.json"),
                "files": {
                    "index.html": html_sha,
                    "app.js": js_sha
                }
            },
            "version": "0.3.0-beta.2"
        });
        let manifest_json = serde_json::to_string(&manifest_obj).unwrap();
        let sig_b64 = B64.encode(ed_kp.sign(format!("qdl-manifest-v1|{manifest_json}").as_bytes()).as_ref());
        let latest_resp = serde_json::to_vec(&json!({
            "ok": true,
            "manifest": manifest_obj,
            "manifestJson": manifest_json,
            "signature": sig_b64,
            "serverRegion": "Test Local"
        })).unwrap();

        let srv_pkg = pkg_bytes.clone();
        let srv_hf = hf_bytes.clone();
        let handle = std::thread::spawn(move || {
            while !stop_bg.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut buf = vec![0u8; 65536];
                        let n = stream.read(&mut buf).unwrap_or(0);
                        if n == 0 {
                            continue;
                        }
                        let req_str = String::from_utf8_lossy(&buf[..n]);
                        let first = req_str.lines().next().unwrap_or("");
                        let path = first.split_whitespace().nth(1).unwrap_or("/");
                        let (ctype, body): (&str, Vec<u8>) = match path {
                            "/api/v1/updates/latest" => ("application/json", latest_resp.clone()),
                            "/downloads/QuarkDriveLite-0.3.0-beta.2.zip" => ("application/octet-stream", srv_pkg.clone()),
                            "/downloads/qdl-ui-hotfix-0.3.0-ui.1.json" => ("application/octet-stream", srv_hf.clone()),
                            "/api/v1/telemetry" => ("application/json", br#"{"ok":true,"accepted":true,"samplesAccepted":4}"#.to_vec()),
                            "/api/v1/feedback" => ("application/json", br#"{"ok":true,"id":42,"status":"open","createdAt":1763817600000}"#.to_vec()),
                            "/api/v1/feedback/mine" => ("application/json", r#"{"ok":true,"items":[{"id":42,"status":"in_progress","hasAdminReply":true,"messages":[{"id":1,"sender":"admin","message":"收到，正在排查中！"}]}]}"#.as_bytes().to_vec()),
                            "/api/v1/feedback/reply" => ("application/json", br#"{"ok":true,"reply":{"id":2,"sender":"user","message":"ok"}}"#.to_vec()),
                            _ => ("application/json", br#"{"ok":false}"#.to_vec()),
                        };
                        let hdr = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(hdr.as_bytes());
                        let _ = stream.write_all(&body);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        let tmp = tempfile::tempdir().unwrap();
        let dl_dir = tmp.path().join("downloads");
        let core = Core::open_no_proxy(tmp.path().join("profile")).unwrap();
        let hub_cfg = HubConfig {
            base_url: base_url.clone(),
            region: "Test Local".into(),
            x25519_pub,
            ed25519_pub,
            allow_insecure_localhost: true,
        };
        let hub = HubClient::new(core, hub_cfg).unwrap();

        // 1. Must block before opt-in
        assert_eq!(hub.check_update("0.3.0-beta.1").await.unwrap_err().code, "OPT_IN_REQUIRED");
        hub.set_opt_in(true, "0.3.0-beta.1").unwrap();

        // 2. Check update -> verifies Ed25519 signature, forceUpgrade, L1 tuning, L2 hotfix
        let upd = hub.check_update("0.3.0-beta.1").await.unwrap();
        assert_eq!(upd["signatureVerified"], true);
        assert_eq!(upd["hasUpdate"], true);
        assert_eq!(upd["forceUpgrade"], true);
        assert_eq!(upd["minVersion"], "0.3.0-beta.2");
        assert_eq!(upd["latestVersion"], "0.3.0-beta.2");
        assert_eq!(upd["notice"], "测试公告：欢迎体验新版");
        assert_eq!(upd["tuningApplied"], true);
        assert_eq!(hub.inner.core.tuning().small_file_direct_max_bytes, 4 * 1024 * 1024);
        assert_eq!(hub.inner.core.tuning().aimd_min_parallel, 3);
        assert_eq!(upd["hasUiHotfix"], true);

        // 3. Download update package & verify SHA-256
        let mut saw_done = false;
        let dl = hub
            .download_update("0.3.0-beta.1", None, Some(dl_dir.to_str().unwrap()), |p| {
                if p["phase"] == "done" {
                    saw_done = true;
                }
            })
            .await
            .unwrap();
        assert_eq!(dl["verified"], true);
        assert!(saw_done);
        let downloaded_path = dl["path"].as_str().unwrap();
        assert_eq!(std::fs::read(downloaded_path).unwrap(), pkg_bytes);
        assert_eq!(
            hub.verify_update_for_install(Some(downloaded_path)).await.unwrap(),
            Path::new(downloaded_path)
        );

        let mut changed = pkg_bytes.to_vec();
        changed[0] ^= 1;
        std::fs::write(downloaded_path, changed).unwrap();
        let error = hub.verify_update_for_install(None).await.unwrap_err();
        assert_eq!(error.code, "CHECKSUM_MISMATCH");

        // 4. L2 hot-UI SHA-256 verification & staging
        let applied = hub.apply_ui_hotfix("0.3.0-beta.1").await.unwrap();
        assert_eq!(applied["applied"], true);
        let (served_html, _) =
            crate::hot_ui::read_verified_asset(&hub.inner.core.profile_dir(), "/index.html").unwrap();
        assert!(String::from_utf8_lossy(&served_html).contains("hotfix-v1"));

        // 5. E2EE telemetry, transfer flush, feedback submit/list/reply
        let tel = hub.send_telemetry("0.3.0-beta.1", json!({"eventType":"heartbeat","memMb":88})).await.unwrap();
        assert_eq!(tel["ok"], true);
        hub.record_transfer_sample(json!({"kind":"download","outcome":"done","sizeBytes":1024,"transferredBytes":1024,"durationMs":100,"avgBps":10240}));
        let flush = hub.flush_transfer_telemetry("0.3.0-beta.1").await.unwrap();
        assert_eq!(flush["flushed"], 1);
        let fb = hub.submit_feedback("0.3.0-beta.1", json!({"category":"performance","message":"速度很快！","includeLogs":true})).await.unwrap();
        assert_eq!(fb["id"], 42);
        let mine = hub.list_feedback().await.unwrap();
        assert_eq!(mine["items"][0]["status"], "in_progress");
        let rep = hub.reply_feedback(json!({"feedbackId": 42, "message": "补充测试"})).await.unwrap();
        assert_eq!(rep["ok"], true);

        stop.store(true, Ordering::Relaxed);
        let _ = handle.join();
    }
}
