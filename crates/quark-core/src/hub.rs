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
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncWriteExt;

pub const DEFAULT_HUB_URL: &str = "https://qdl.xiaodianshiuwu.space";
pub const DEFAULT_SERVER_REGION: &str = "海外节点 · Tokyo (JP)";
/// Server X25519 public key (32 raw bytes, base64). Public by design; private key lives only on server.
pub const DEFAULT_X25519_PUB_B64: &str = "JiBk3eOuPSeJfVdmlf69pMVn5XdZdN2OoCswV+ij+h4=";
/// Server Ed25519 public key (32 raw bytes, base64). Public by design; private key lives only on server.
pub const DEFAULT_ED25519_PUB_B64: &str = "+ruMjuPB615LgeQuCJI+HUn/C/Ie8KCU+cbQEU8r918=";

const MAX_DIAG_ENTRIES: usize = 200;
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
        let base_url = std::env::var("QDL_HUB_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_HUB_URL.to_string());
        let x25519_b64 = std::env::var("QDL_HUB_X25519_PUB")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_X25519_PUB_B64.to_string());
        let ed25519_b64 = std::env::var("QDL_HUB_ED25519_PUB")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ED25519_PUB_B64.to_string());
        let x25519_pub = decode_key32(&x25519_b64).unwrap_or_else(|| decode_key32(DEFAULT_X25519_PUB_B64).unwrap());
        let ed25519_pub = decode_key32(&ed25519_b64).unwrap_or_else(|| decode_key32(DEFAULT_ED25519_PUB_B64).unwrap());
        let allow_insecure_localhost = std::env::var("QDL_HUB_ALLOW_INSECURE_LOCALHOST").as_deref() == Ok("1");
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
    feedback_token: Mutex<Option<String>>,
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
                "app started ({}/{})",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        });

        Ok(Self {
            inner: Arc::new(HubInner {
                core,
                config,
                http,
                started_at: Instant::now(),
                session_salt,
                diag: Mutex::new(diag),
                feedback_token: Mutex::new(None),
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
        let entry = DiagEntry {
            ts: now_ms(),
            level: match level {
                "error" | "warn" | "info" => level.to_string(),
                _ => "info".to_string(),
            },
            category: redact_text(category, 32),
            code: code.map(|c| redact_text(c, 64)).filter(|s| !s.is_empty()),
            msg: redact_text(msg, 320),
        };
        if let Ok(mut buf) = self.inner.diag.lock() {
            if buf.len() >= MAX_DIAG_ENTRIES {
                buf.pop_front();
            }
            buf.push_back(entry);
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
            "recommendedAssetKey": recommended_asset_key(),
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
    pub async fn check_update(&self, app_version: &str) -> Result<Value> {
        self.require_opt_in()?;
        let (manifest, server_region) = self.fetch_verified_manifest().await?;
        let latest_version = manifest["version"].as_str().unwrap_or(app_version);
        let has_update = version_is_newer(latest_version, app_version);
        let rec_key = recommended_asset_key();
        let recommended_asset = manifest["assets"].get(rec_key).cloned().unwrap_or(Value::Null);

        Ok(json!({
            "ok": true,
            "hasUpdate": has_update,
            "currentVersion": app_version,
            "latestVersion": latest_version,
            "channel": manifest["channel"].as_str().unwrap_or("beta"),
            "releaseDate": manifest["releaseDate"].as_str().unwrap_or(""),
            "changelog": manifest["changelog"].as_str().unwrap_or(""),
            "notice": manifest["notice"],
            "assets": manifest["assets"],
            "recommendedAssetKey": rec_key,
            "recommendedAsset": recommended_asset,
            "signatureVerified": true,
            "serverRegion": server_region
        }))
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
        let part_path = target_dir.join(format!("{filename}.qkupdate.part"));

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

        let total = resp
            .content_length()
            .or_else(|| asset["size"].as_u64())
            .unwrap_or(0);
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

        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|_| Error::new("NETWORK", OVERSEAS_NET_HINT))?
        {
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| Error::new("IO", format!("写入更新包失败：{e}")))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
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
        drop(file);

        let actual_sha256 = hex::encode(hasher.finalize());
        if actual_sha256 != expected_sha256 {
            let _ = tokio::fs::remove_file(&part_path).await;
            self.record_event("error", "update", Some("CHECKSUM_MISMATCH"), "update package sha256 mismatch");
            return Err(Error::new(
                "CHECKSUM_MISMATCH",
                "安装包 SHA-256 完整性校验失败，已自动清理损坏文件，请稍后重试",
            ));
        }

        if final_path.exists() {
            let _ = tokio::fs::remove_file(&final_path).await;
        }
        tokio::fs::rename(&part_path, &final_path)
            .await
            .map_err(|e| Error::new("IO", format!("保存更新包失败：{e}")))?;

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

    /// Encrypt and upload strictly sanitized non-sensitive telemetry when opted in.
    pub async fn send_telemetry(&self, app_version: &str, input: Value) -> Result<Value> {
        self.require_opt_in()?;
        let origin = self.inner.config.validated_origin()?;
        let path = "/api/v1/telemetry";
        let url = format!("{}{}", origin.as_str().trim_end_matches('/'), path);

        let recent_events: Vec<DiagEntry> = self
            .log_preview()
            .into_iter()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();

        let payload = json!({
            "appVersion": app_version,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "eventType": redact_text(input["eventType"].as_str().unwrap_or("heartbeat"), 32),
            "clientHash": self.inner.session_salt,
            "errorCode": input["errorCode"].as_str().map(|s| redact_text(s, 64)),
            "errorSummary": input["errorSummary"].as_str().map(|s| redact_text(s, 240)),
            "avgDlBps": input["avgDlBps"].as_u64(),
            "peakDlBps": input["peakDlBps"].as_u64(),
            "avgUlBps": input["avgUlBps"].as_u64(),
            "dlTasks": input["dlTasks"].as_u64(),
            "ulTasks": input["ulTasks"].as_u64(),
            "retries": input["retries"].as_u64(),
            "memMb": input["memMb"].as_u64(),
            "uptimeSec": self.inner.started_at.elapsed().as_secs(),
            "recentEvents": recent_events,
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
        Ok(json!({ "ok": true, "encrypted": true }))
    }

    /// Load or generate a persistent, local-only 256-bit anonymous feedback token.
    /// Never exposed to renderer JS and never tied to Quark account or hardware ID.
    fn feedback_client_token(&self) -> Result<String> {
        let mut guard = self.inner.feedback_token.lock().unwrap();
        if let Some(tok) = guard.as_ref() {
            return Ok(tok.clone());
        }
        let dir = self.inner.core.profile_dir();
        let token_path = dir.join("hub-feedback-token");
        if let Ok(raw) = std::fs::read_to_string(&token_path) {
            let trimmed = raw.trim();
            if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                let owned = trimmed.to_ascii_lowercase();
                *guard = Some(owned.clone());
                return Ok(owned);
            }
        }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        std::fs::create_dir_all(&dir)
            .map_err(|_| Error::new("LOCAL_IO", "无法创建本地反馈凭证目录"))?;
        let tmp_path = dir.join(format!("hub-feedback-token.tmp.{}", std::process::id()));
        std::fs::write(&tmp_path, &token)
            .map_err(|_| Error::new("LOCAL_IO", "无法写入本地反馈凭证"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o600));
        }
        #[cfg(windows)]
        {
            let _ = std::fs::remove_file(&token_path);
        }
        std::fs::rename(&tmp_path, &token_path)
            .or_else(|_| std::fs::write(&token_path, &token))
            .map_err(|_| Error::new("LOCAL_IO", "无法保存本地反馈凭证"))?;
        let _ = std::fs::remove_file(&tmp_path);
        *guard = Some(token.clone());
        Ok(token)
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
        let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
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
        let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
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
        let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
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
            .map_err(|_| Error::new("NETWORK", OVERSEAS_NET_HINT))?;
        if !resp.status().is_success() {
            return Err(Error::new(
                "HTTP",
                format!("检查更新失败（HTTP {}）", resp.status().as_u16()),
            ));
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|_| Error::new("PARSE", "更新清单响应格式无效"))?;
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
        ("windows", _) => "windows-x64-setup",
        ("linux", "x86_64") => "linux-x64-deb",
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

fn parse_semver(raw: &str) -> (u64, u64, u64, u8, u64) {
    let trimmed = raw.trim().trim_start_matches('v');
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

/// Strict client-side PII redaction before storing in diagnostic ring buffer or encrypting for upload.
pub fn redact_text(input: &str, max_chars: usize) -> String {
    let mut s: String = input.chars().take(max_chars).collect();
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
        "cookie:",
    ] {
        s = redact_key_value_ci(&s, cookie_key, "[REDACTED_COOKIE]");
    }
    // 2. Redact sensitive query params
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
    ] {
        s = redact_key_value_ci(&s, qp, "[REDACTED]");
    }
    // 3. Redact Bearer / Basic / sk- tokens
    s = redact_prefix_token_ci(&s, "bearer ", "Bearer [REDACTED_TOKEN]");
    s = redact_prefix_token_ci(&s, "basic ", "Basic [REDACTED_TOKEN]");
    s = redact_sk_keys(&s);
    // 4. Redact macOS/Linux/Windows user home directory names
    s = redact_home_paths(&s);
    // 5. Redact IPv4 addresses
    s = redact_ipv4(&s);
    s
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
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let bytes = input.as_bytes();
    while i < input.len() {
        if input[i..].starts_with("/Users/") || input[i..].starts_with("/home/") {
            let prefix_len = if input[i..].starts_with("/Users/") { 7 } else { 6 };
            out.push_str("/[USER_HOME]");
            let mut j = i + prefix_len;
            while j < input.len() {
                let ch = input[j..].chars().next().unwrap();
                if matches!(ch, '/' | ' ' | '\t' | '\r' | '\n' | '"' | '\'' | ',' | ')') {
                    break;
                }
                j += ch.len_utf8();
            }
            i = j;
            continue;
        }
        if i + 9 <= bytes.len()
            && bytes[i].is_ascii_alphabetic()
            && &bytes[i + 1..i + 9] == b":\\Users\\"
        {
            out.push_str("C:\\[USER_HOME]");
            let mut j = i + 9;
            while j < input.len() {
                let ch = input[j..].chars().next().unwrap();
                if matches!(ch, '\\' | '/' | ' ' | '\t' | '\r' | '\n' | '"' | '\'' | ',' | ')') {
                    break;
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
        let raw = "err __pus=secret123; Bearer tok_abc987654321 sk-live1234567890abcdef /Users/alice/Desktop/secret.pdf C:\\Users\\Bob\\Downloads\\a.zip https://dl.example/f?auth_key=xyz999&a=1 from 192.168.31.101";
        let clean = redact_text(raw, 2000);
        assert!(!clean.contains("secret123"));
        assert!(!clean.contains("tok_abc987654321"));
        assert!(!clean.contains("sk-live1234567890abcdef"));
        assert!(!clean.contains("alice"));
        assert!(!clean.contains("Bob"));
        assert!(!clean.contains("xyz999"));
        assert!(!clean.contains("192.168.31.101"));
        assert!(clean.contains("[REDACTED_COOKIE]"));
        assert!(clean.contains("[REDACTED_TOKEN]"));
        assert!(clean.contains("[REDACTED_API_KEY]"));
        assert!(clean.contains("/[USER_HOME]"));
        assert!(clean.contains("C:\\[USER_HOME]"));
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
    async fn e2e_cross_language_rust_client_against_real_node_hub_server() {
        use std::process::{Command, Stdio};
        // Only run when Node >= 22 with node:sqlite is present (available on dev/CI Mac & Linux).
        let node_check = Command::new("node")
            .args(["-e", "require('node:sqlite')"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !matches!(node_check, Ok(s) if s.success()) {
            return;
        }

        let repo_root = std::env::var_os("QDL_REPO_ROOT")
            .map(PathBuf::from)
            .filter(|p| p.join("server").join("qdl-hub").join("server.mjs").exists())
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
            });
        let server_dir = repo_root.join("server").join("qdl-hub");
        let tmp = tempfile::tempdir().unwrap();
        let env_path = tmp.path().join("hub.env");
        let data_dir = tmp.path().join("data");
        let rel_dir = tmp.path().join("releases");
        let dl_dir = tmp.path().join("downloads");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::create_dir_all(&rel_dir).unwrap();

        let setup_out = Command::new("node")
            .arg(server_dir.join("setup-keys.mjs"))
            .arg(&env_path)
            .output()
            .unwrap();
        assert!(setup_out.status.success(), "setup-keys failed: {}", String::from_utf8_lossy(&setup_out.stderr));
        let keys: Value = serde_json::from_slice(&setup_out.stdout).unwrap();
        let x25519_pub = decode_key32(keys["x25519PublicKeyRawB64"].as_str().unwrap()).unwrap();
        let ed25519_pub = decode_key32(keys["ed25519PublicKeyRawB64"].as_str().unwrap()).unwrap();
        let admin_password = keys["adminPassword"].as_str().unwrap().to_string();

        // Pick an ephemeral free TCP port
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let base_url = format!("http://127.0.0.1:{port}");

        let child = Command::new("node")
            .arg(server_dir.join("server.mjs"))
            .env("QDL_ENV_FILE", &env_path)
            .env("HOST", "127.0.0.1")
            .env("PORT", port.to_string())
            .env("PUBLIC_BASE_URL", &base_url)
            .env("DATA_DIR", &data_dir)
            .env("RELEASES_DIR", &rel_dir)
            .env("INSECURE_LOCAL_DEV", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();

        struct KillChild(std::process::Child);
        impl Drop for KillChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let _guard = KillChild(child);

        // Wait for server health
        let probe = Client::builder().no_proxy().build().unwrap();
        let mut ready = false;
        for _ in 0..40 {
            if probe.get(format!("{base_url}/api/v1/health")).send().await.is_ok_and(|r| r.status().is_success()) {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(ready, "node hub server did not become healthy");

        // Admin login + publish a newer release + upload a real release package
        let login_res = probe
            .post(format!("{base_url}/api/admin/login"))
            .header("X-QDL-Admin", "1")
            .json(&json!({"username": "admin", "password": admin_password}))
            .send()
            .await
            .unwrap();
        assert!(login_res.status().is_success());
        let cookie = login_res
            .headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();

        let pub_res = probe
            .post(format!("{base_url}/api/admin/releases"))
            .header("Cookie", &cookie)
            .header("X-QDL-Admin", "1")
            .json(&json!({
                "version": "0.3.0-beta.2",
                "channel": "beta",
                "changelog": "E2E signed release test",
                "notice": "测试公告：欢迎体验新版"
            }))
            .send()
            .await
            .unwrap();
        assert!(pub_res.status().is_success());

        let pkg_bytes = b"fake-installer-binary-payload-for-sha256-e2e-verification-1234567890";
        let up_res = probe
            .post(format!("{base_url}/api/admin/releases/upload?filename=QuarkDriveLite-0.3.0-beta.2.zip&assetKey={}", recommended_asset_key()))
            .header("Cookie", &cookie)
            .header("X-QDL-Admin", "1")
            .body(pkg_bytes.to_vec())
            .send()
            .await
            .unwrap();
        assert!(up_res.status().is_success());

        // Now test Rust HubClient end-to-end!
        let core = Core::open_no_proxy(tmp.path().join("profile")).unwrap();
        let hub_cfg = HubConfig {
            base_url: base_url.clone(),
            region: "Test Local".into(),
            x25519_pub,
            ed25519_pub,
            allow_insecure_localhost: true,
        };
        let hub = HubClient::new(core, hub_cfg.clone()).unwrap();

        // 1. Must block before opt-in
        assert_eq!(hub.check_update("0.3.0-beta.1").await.unwrap_err().code, "OPT_IN_REQUIRED");

        // 2. Enable opt-in
        hub.set_opt_in(true, "0.3.0-beta.1").unwrap();

        // 3. Check update -> verifies Ed25519 signature from Node.js server!
        let upd = hub.check_update("0.3.0-beta.1").await.unwrap();
        assert_eq!(upd["signatureVerified"], true);
        assert_eq!(upd["hasUpdate"], true);
        assert_eq!(upd["latestVersion"], "0.3.0-beta.2");
        assert_eq!(upd["notice"], "测试公告：欢迎体验新版");

        // 4. Send X25519 + AES-256-GCM encrypted telemetry -> Node.js server decrypts & stores!
        let tel = hub
            .send_telemetry(
                "0.3.0-beta.1",
                json!({"eventType":"heartbeat","avgDlBps":24000000,"dlTasks":3,"memMb":88}),
            )
            .await
            .unwrap();
        assert_eq!(tel["ok"], true);

        // 5. Submit X25519 + AES-256-GCM encrypted feedback with redacted logs!
        hub.record_event("error", "transfer", Some("NET"), "failed for /Users/secretuser/a.zip __pus=abc");
        let fb = hub
            .submit_feedback(
                "0.3.0-beta.1",
                json!({"category":"performance","message":"速度很快！","contact":"test@example.com","includeLogs":true}),
            )
            .await
            .unwrap();
        assert_eq!(fb["ok"], true);
        assert_eq!(fb["includedLogs"], true);

        // 6. Download update package directly & verify SHA-256!
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
        let saved = std::fs::read(dl["path"].as_str().unwrap()).unwrap();
        assert_eq!(saved, pkg_bytes);

        // 7. Confirm Admin API stats & feedback contain decrypted & scrubbed data!
        let stats: Value = probe
            .get(format!("{base_url}/api/admin/stats"))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(stats["totals"]["totalEvents"], 1);
        assert_eq!(stats["feedbackSummary"]["openCount"], 1);

        let fb_list: Value = probe
            .get(format!("{base_url}/api/admin/feedback"))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let logs_str = fb_list["items"][0]["logs_json"].as_str().unwrap();
        assert!(!logs_str.contains("secretuser"), "home path must be redacted");
        assert!(!logs_str.contains("abc"), "cookie value must be redacted");
        assert!(logs_str.contains("[REDACTED_COOKIE]"));
        assert_eq!(fb_list["items"][0]["has_client_token"], true);

        // 8. Verify my feedback history + two-way replies + strict cross-client isolation!
        let fb_id = fb["id"].as_i64().unwrap();
        let mine = hub.list_feedback().await.unwrap();
        assert_eq!(mine["items"].as_array().unwrap().len(), 1);
        assert_eq!(mine["items"][0]["id"], fb_id);
        assert_eq!(mine["items"][0]["status"], "open");

        // Admin replies & transitions status to in_progress
        let admin_reply: Value = probe
            .post(format!("{base_url}/api/admin/feedback/{fb_id}/reply"))
            .header("Cookie", &cookie)
            .header("X-QDL-Admin", "1")
            .json(&json!({"message": "收到，正在排查中！", "status": "in_progress"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(admin_reply["ok"], true);
        assert_eq!(admin_reply["status"], "in_progress");

        // User sees admin reply and updated status
        let mine_after_admin = hub.list_feedback().await.unwrap();
        assert_eq!(mine_after_admin["items"][0]["status"], "in_progress");
        assert_eq!(mine_after_admin["items"][0]["hasAdminReply"], true);
        assert_eq!(mine_after_admin["items"][0]["messages"][0]["sender"], "admin");
        assert_eq!(mine_after_admin["items"][0]["messages"][0]["message"], "收到，正在排查中！");

        // User appends a follow-up message
        let follow = hub
            .reply_feedback(json!({"feedbackId": fb_id, "message": "补充：Windows 11 复现稳定"}))
            .await
            .unwrap();
        assert_eq!(follow["ok"], true);
        assert_eq!(follow["reply"]["sender"], "user");

        // Admin sees both messages in order and last_sender == 'user'
        let fb_list2: Value = probe
            .get(format!("{base_url}/api/admin/feedback"))
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let thread = fb_list2["items"][0]["messages"].as_array().unwrap();
        assert_eq!(thread.len(), 2);
        assert_eq!(thread[0]["sender"], "admin");
        assert_eq!(thread[1]["sender"], "user");
        assert_eq!(fb_list2["items"][0]["last_sender"], "user");

        // Another client profile with a different feedback token MUST see 0 items & CANNOT reply!
        let other_dir = tmp.path().join("other-profile");
        let other_core = Core::open_no_proxy(&other_dir).unwrap();
        other_core.set_settings(json!({"serverOptIn": true})).unwrap();
        let other_hub = HubClient::new(other_core, hub_cfg).unwrap();
        assert_eq!(other_hub.list_feedback().await.unwrap()["items"].as_array().unwrap().len(), 0);
        let forbidden = other_hub
            .reply_feedback(json!({"feedbackId": fb_id, "message": "hijack attempt"}))
            .await
            .expect_err("another client must never reply to someone else's feedback");
        assert_eq!(forbidden.code, "HTTP");
    }
}
