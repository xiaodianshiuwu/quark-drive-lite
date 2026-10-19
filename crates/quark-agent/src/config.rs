//! Agent 接入配置：启用状态、写入模式、授权范围、桥接凭据。
//!
//! 与 qck config.js 的存储分野一致：
//! - 配置主体（授权目录清单等用户隐私）**加密存储**：本实现用独立 QCK2 兼容加密文件
//!   `<profile>/agent/access.bin`（AES-256-GCM，密钥 `<profile>/agent/access.key`），
//!   与登录态 session.bin 机制同构但相互独立。
//! - 桥接凭据另存明文文件 `<profile>/agent/bridge.json`（0600）：外部 MCP 适配器是
//!   独立进程，必须以文件形态读到端点与 token；禁用接入时立即删除。

use crate::policy::{
    generate_token, AgentError, AgentToolError,
};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const CONFIG_KEY: &str = "agentAccess";
pub const BRIDGE_FILE: &str = "bridge.json";
pub const BRIDGE_VERSION: u32 = 1;
pub const WRITE_MODES: [&str; 2] = ["read-only", "scoped-write"];

/// 配置主体（对应 qck DEFAULT_CONFIG）。
#[derive(Debug, Clone, PartialEq)]
pub struct AgentConfig {
    pub enabled: bool,
    pub write_mode: String,
    /// 授权网盘目录：[{fid, name}]（name 仅展示用）。
    pub remote_roots: Vec<(String, String)>,
    pub local_read_roots: Vec<PathBuf>,
    pub local_write_roots: Vec<PathBuf>,
    pub token: String,
    pub endpoint: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            write_mode: "read-only".into(),
            remote_roots: Vec::new(),
            local_read_roots: Vec::new(),
            local_write_roots: Vec::new(),
            token: String::new(),
            endpoint: String::new(),
            created_at: 0,
            updated_at: 0,
        }
    }
}

/// 供策略层使用的只读范围视图。
#[derive(Debug, Clone, Default)]
pub struct ScopeSnapshot {
    pub remote_roots: Vec<String>,
    pub write_mode: String,
    pub local_read_roots: Vec<PathBuf>,
    pub local_write_roots: Vec<PathBuf>,
}

impl AgentConfig {
    fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "writeMode": self.write_mode,
            "remoteRoots": self.remote_roots.iter().map(|(fid, name)| json!({"fid": fid, "name": name})).collect::<Vec<_>>(),
            "localReadRoots": self.local_read_roots.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
            "localWriteRoots": self.local_write_roots.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
            "token": self.token,
            "endpoint": self.endpoint,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }

    fn from_json(v: &Value) -> Self {
        let mut c = Self::default();
        c.enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
        let wm = v.get("writeMode").and_then(|x| x.as_str()).unwrap_or("");
        if WRITE_MODES.contains(&wm) {
            c.write_mode = wm.to_string();
        }
        if let Some(arr) = v.get("remoteRoots").and_then(|x| x.as_array()) {
            for item in arr {
                let fid = item.get("fid").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                if fid.is_empty() {
                    continue;
                }
                let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if !c.remote_roots.iter().any(|(f, _)| *f == fid) {
                    c.remote_roots.push((fid, name));
                }
            }
        }
        for key in ["localReadRoots", "localWriteRoots"] {
            if let Some(arr) = v.get(key).and_then(|x| x.as_array()) {
                let target = if key == "localReadRoots" { &mut c.local_read_roots } else { &mut c.local_write_roots };
                for item in arr {
                    if let Some(s) = item.as_str() {
                        let p = PathBuf::from(s.trim());
                        if !p.as_os_str().is_empty() && p.is_absolute() && !target.contains(&p) {
                            target.push(p);
                        }
                    }
                }
            }
        }
        if let Some(t) = v.get("token").and_then(|x| x.as_str()) {
            if t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
                c.token = t.to_string();
            }
        }
        if let Some(e) = v.get("endpoint").and_then(|x| x.as_str()) {
            c.endpoint = e.to_string();
        }
        c.created_at = v.get("createdAt").and_then(|x| x.as_i64()).unwrap_or(0);
        c.updated_at = v.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(0);
        c
    }

    /// 供策略层使用的范围视图：可写根优先；同一路径只保留可写语义；网盘根去重。
    pub fn scope(&self) -> ScopeSnapshot {
        let mut remote: Vec<String> = Vec::new();
        for (f, _) in &self.remote_roots {
            if !remote.contains(f) {
                remote.push(f.clone());
            }
        }
        ScopeSnapshot {
            remote_roots: remote,
            write_mode: self.write_mode.clone(),
            local_read_roots: self
                .local_read_roots
                .iter()
                .filter(|p| !self.local_write_roots.contains(p))
                .cloned()
                .collect(),
            local_write_roots: self.local_write_roots.clone(),
        }
    }

    pub fn is_active(&self) -> bool {
        self.enabled && !self.token.is_empty()
    }
}

// ---------------------------------------------------------------------------
// QCK2 兼容加密存储（access.bin / access.key）
// ---------------------------------------------------------------------------

pub(crate) fn encrypt_to_file(key: &[u8; 32], path: &Path, plaintext: &Value) -> std::io::Result<()> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce_bytes);
    let aad = b"QCK2";
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload { msg: plaintext.to_string().as_bytes(), aad },
        )
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "encrypt failed"))?;
    let mut buf = Vec::with_capacity(4 + 4 + 12 + 16 + ct.len());
    buf.extend_from_slice(b"QCK2");
    buf.extend_from_slice(&1u32.to_be_bytes());
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ct);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp=path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4()));
    let result=(||{
        let mut options=std::fs::OpenOptions::new();options.write(true).create_new(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        let mut file=options.open(&tmp)?;file.write_all(&buf)?;file.sync_all()?;
        std::fs::rename(&tmp,path)?;
        #[cfg(unix)] if let Some(parent)=path.parent(){std::fs::File::open(parent)?.sync_all()?;}
        Ok(())
    })();
    let _=std::fs::remove_file(tmp);result
}

pub(crate) fn decrypt_from_file(key: &[u8; 32], path: &Path) -> std::io::Result<Value> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};
    let meta=std::fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len()>1024*1024{return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"invalid encrypted config file"));}
    let buf = std::fs::read(path)?;
    if buf.len() < 4 + 4 + 12 + 16 || &buf[0..4] != b"QCK2" || buf[4..8]!=1u32.to_be_bytes() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad magic"));
    }
    let nonce = Nonce::from_slice(&buf[8..20]);
    let cipher = Aes256Gcm::new(key.into());
    let pt = cipher
        .decrypt(nonce, Payload { msg: &buf[20..], aad: b"QCK2" })
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "decrypt failed"))?;
    serde_json::from_slice(&pt).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad json"))
}

pub(crate) fn read_key(path:&Path)->std::io::Result<[u8;32]> {
        let meta=std::fs::symlink_metadata(path)?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len()!=32{return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"invalid existing config key; original retained"));}
        std::fs::read(path)?.try_into().map_err(|_|std::io::Error::new(std::io::ErrorKind::InvalidData,"invalid key length"))
    }

pub(crate) fn load_or_create_key(path:&Path)->std::io::Result<[u8;32]> {
    match read_key(path){Ok(k)=>return Ok(k),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(e)}
    let mut key=[0u8;32];rand::RngCore::fill_bytes(&mut rand::rngs::OsRng,&mut key);
    if let Some(parent)=path.parent(){std::fs::create_dir_all(parent)?;}
    let tmp=path.with_extension(format!("{}.tmp",uuid::Uuid::new_v4()));
    let result=(||{
        let mut options=std::fs::OpenOptions::new();options.write(true).create_new(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        let mut file=options.open(&tmp)?;file.write_all(&key)?;file.sync_all()?;
        match std::fs::hard_link(&tmp,path){Ok(())=>{},Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(e)=>return Err(e)}
        #[cfg(unix)] if let Some(parent)=path.parent(){std::fs::File::open(parent)?.sync_all()?;}
        // Another concurrent creator may have won: always return the persisted key.
        read_key(path)
    })();
    let _=std::fs::remove_file(tmp);result
}

// ---------------------------------------------------------------------------
// 配置管理器
// ---------------------------------------------------------------------------

/// Agent 配置管理器：加密配置 + 0600 bridge.json 的状态机。
pub struct AgentConfigManager {
    dir: PathBuf,
    access_path: PathBuf,
    key_path: PathBuf,
    bridge_path: PathBuf,
    cache: Option<AgentConfig>,
}

impl AgentConfigManager {
    pub fn open(profile_dir: &Path) -> std::io::Result<Self> {
        let dir = profile_dir.join("agent");
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            access_path: dir.join("access.bin"),
            key_path: dir.join("access.key"),
            bridge_path: dir.join(BRIDGE_FILE),
            cache: None,
            dir,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn bridge_file_path(&self) -> PathBuf {
        self.bridge_path.clone()
    }

    fn load(&mut self) -> AgentConfig {
        if let Some(c) = &self.cache {
            return c.clone();
        }
        let cfg = (|| -> std::io::Result<AgentConfig> {
            let key = read_key(&self.key_path)?;
            let v = decrypt_from_file(&key, &self.access_path)?;
            Ok(AgentConfig::from_json(&v.get("data").unwrap_or(&Value::Null)))
        })()
        .unwrap_or_default();
        self.cache = Some(cfg.clone());
        cfg
    }

    fn save(&mut self, cfg: &AgentConfig) -> Result<(), AgentToolError> {
        let key = if self.access_path.exists(){
            let key=read_key(&self.key_path).map_err(|_|AgentToolError::new(AgentError::Internal,"Agent密钥不可读或损坏，原文件已保留"))?;
            decrypt_from_file(&key,&self.access_path).map_err(|_|AgentToolError::new(AgentError::Internal,"Agent配置损坏，拒绝覆盖原文件"))?;key
        }else{load_or_create_key(&self.key_path).map_err(|e|AgentToolError::new(AgentError::Internal,format!("无法写入Agent配置：{e}")))?};
        encrypt_to_file(&key, &self.access_path, &json!({ "v": 2, "data": cfg.to_json() }))
            .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法写入 Agent 配置：{e}")))?;
        self.cache = Some(cfg.clone());
        Ok(())
    }

    pub fn get(&mut self) -> AgentConfig {
        self.load()
    }

    /// 局部更新；write_mode 非法时拒绝；启用时无凭据则自动生成。
    pub fn update(&mut self, patch: &Value, now_ms: i64) -> Result<AgentConfig, AgentToolError> {
        let mut cur = self.load();
        if let Some(v) = patch.get("enabled") {
            if let Some(b) = v.as_bool() {
                cur.enabled = b;
            }
        }
        if let Some(wm) = patch.get("writeMode").and_then(|v| v.as_str()) {
            if !WRITE_MODES.contains(&wm) {
                return Err(AgentToolError::new(AgentError::InvalidArg, "写入模式只能是 read-only 或 scoped-write"));
            }
            cur.write_mode = wm.to_string();
        }
        if let Some(v) = patch.get("remoteRoots") {
            let roots = normalize_remote_root_entries(v);
            // 与 qck UI 语义一致：不允许把根目录（fid="0"）授权为 Agent 根——
            // 那等价于对 Agent 开放整个网盘，范围校验将失去意义。
            if roots.iter().any(|(fid, _)| fid == crate::policy::ROOT_FID) {
                return Err(AgentToolError::new(
                    AgentError::InvalidArg,
                    "不能把根目录设为授权目录，请选择具体的子目录",
                ));
            }
            cur.remote_roots = roots;
        }
        for (key, target) in [
            ("localReadRoots", &mut cur.local_read_roots),
            ("localWriteRoots", &mut cur.local_write_roots),
        ] {
            if let Some(v) = patch.get(key) {
                target.clear();
                if let Some(arr) = v.as_array() {
                    for item in arr {
                        if let Some(s) = item.as_str() {
                            let p = PathBuf::from(s.trim());
                            if !p.as_os_str().is_empty() && p.is_absolute() && !target.contains(&p) {
                                target.push(p);
                            }
                        }
                    }
                }
            }
        }
        if cur.enabled && cur.token.is_empty() {
            cur.token = generate_token();
        }
        cur.updated_at = now_ms;
        if cur.created_at == 0 {
            cur.created_at = cur.updated_at;
        }
        self.save(&cur)?;
        if !cur.enabled {
            self.remove_bridge_file();
        }
        Ok(cur)
    }

    /// 重新生成凭据（端点由调用方随 activate 重算）。
    pub fn rotate_token(&mut self, now_ms: i64) -> Result<AgentConfig, AgentToolError> {
        let mut cur = self.load();
        cur.token = generate_token();
        cur.endpoint = String::new();
        cur.updated_at = now_ms;
        self.save(&cur)?;
        self.remove_bridge_file();
        Ok(cur)
    }

    /// 启用并落地 bridge.json（0600 原子写），返回端点。
    pub fn activate(&mut self, endpoint_factory: impl FnOnce(&str) -> String, now_ms: i64) -> Result<(AgentConfig, String), AgentToolError> {
        let mut cur = self.load();
        if cur.token.is_empty() {
            cur.token = generate_token();
        }
        if cur.endpoint.is_empty() {
            cur.endpoint = endpoint_factory(&cur.token);
        }
        cur.enabled = true;
        cur.updated_at = now_ms;
        if cur.created_at == 0 {
            cur.created_at = cur.updated_at;
        }
        self.write_bridge_file(&cur)?;
        self.save(&cur)?;
        let endpoint = cur.endpoint.clone();
        Ok((cur, endpoint))
    }

    /// 停用：删凭据文件，保留授权范围（再次启用无需重新配置）。
    pub fn deactivate(&mut self, now_ms: i64) -> Result<AgentConfig, AgentToolError> {
        let mut cur = self.load();
        cur.enabled = false;
        cur.updated_at = now_ms;
        self.save(&cur)?;
        self.remove_bridge_file();
        Ok(cur)
    }

    fn write_bridge_file(&self, cfg: &AgentConfig) -> Result<(), AgentToolError> {
        let payload = json!({
            "version": BRIDGE_VERSION,
            "app": "quark-mini",
            "endpoint": cfg.endpoint,
            "token": cfg.token,
            "transport": if cfg.endpoint.starts_with("\\\\") { "named-pipe" } else { "unix-socket" },
            "updatedAt": cfg.updated_at,
        });
        let tmp = self.bridge_path.with_extension(format!("tmp.{}", std::process::id()));
        {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法写入凭据文件：{e}")))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| AgentToolError::new(AgentError::Internal, format!("{e}")))?;
            }
            serde_json::to_writer_pretty(&mut f, &payload)
                .map_err(|e| AgentToolError::new(AgentError::Internal, format!("{e}")))?;
            f.write_all(b"\n").ok();
            f.flush().ok();
        }
        std::fs::rename(&tmp, &self.bridge_path)
            .map_err(|e| AgentToolError::new(AgentError::Internal, format!("无法落地凭据文件：{e}")))?;
        Ok(())
    }

    pub fn remove_bridge_file(&self) {
        let _ = std::fs::remove_file(&self.bridge_path);
    }
}

/// 归一化网盘授权根：去空、去重，保留展示名。
pub fn normalize_remote_root_entries(value: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let arr = match value {
        Value::Array(a) => a.clone(),
        _ => return out,
    };
    for item in arr {
        let fid = match &item {
            Value::String(s) => s.trim().to_string(),
            Value::Object(o) => o.get("fid").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
            _ => continue,
        };
        if fid.is_empty() {
            continue;
        }
        let name = match &item {
            Value::Object(o) => o.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            _ => String::new(),
        };
        if !out.iter().any(|(f, _)| *f == fid) {
            out.push((fid, name));
        }
    }
    out
}

/// 供外部工具读取桥接凭据（MCP 适配器 / CLI 与网关共用同一文件）。
pub fn read_bridge_credentials(profile_dir: &Path) -> Result<(String, String), AgentToolError> {
    let file = profile_dir.join("agent").join(BRIDGE_FILE);
    let raw = std::fs::read_to_string(&file).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AgentToolError::new(
                AgentError::Disabled,
                "客户端未启用 Agent 接入，或客户端尚未启动",
            )
            .with_hint("请在客户端「设置 → Agent 接入」中启用，并保持客户端运行")
        } else {
            AgentToolError::new(AgentError::Internal, format!("无法读取凭据文件：{e}"))
        }
    })?;
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|_| AgentToolError::new(AgentError::Internal, "Agent 桥接凭据文件已损坏，请在客户端重新生成"))?;
    let endpoint = parsed.get("endpoint").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let token = parsed.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if endpoint.is_empty() || token.is_empty() {
        return Err(AgentToolError::new(AgentError::Internal, "Agent 桥接凭据不完整，请在客户端重新生成"));
    }
    Ok((endpoint, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_profile(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qk-agent-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_roundtrips_through_encryption_and_survives_reload() {
        let dir = tmp_profile("roundtrip");
        let path = dir.clone();
        let mut mgr = AgentConfigManager::open(&path).unwrap();
        let cfg = mgr
            .update(
                &serde_json::json!({
                    "enabled": true,
                    "writeMode": "scoped-write",
                    "remoteRoots": [{"fid": "f1", "name": "工作目录"}],
                    "localWriteRoots": [dir.to_string_lossy()],
                }),
                1000,
            )
            .unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.write_mode, "scoped-write");
        assert_eq!(cfg.remote_roots.len(), 1);
        assert_eq!(cfg.token.len(), 64);
        // 落盘再开：加密往返
        let mut mgr2 = AgentConfigManager::open(&dir).unwrap();
        let again = mgr2.get();
        assert_eq!(again, cfg);
        // 非法 writeMode 拒绝
        let err = mgr2.update(&serde_json::json!({"writeMode": "yolo"}), 1100).unwrap_err();
        assert_eq!(err.code, AgentError::InvalidArg);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activate_deactivate_manage_bridge_file_and_rotate_invalidates() {
        let dir = tmp_profile("bridge");
        let mut mgr = AgentConfigManager::open(&dir).unwrap();
        let (cfg, endpoint) = mgr
            .activate(|token| format!("/tmp/qk-agent-test-{token}.sock"), 2000)
            .unwrap();
        assert!(cfg.enabled);
        assert!(endpoint.starts_with("/tmp/qk-agent-test-"));
        let (ep2, tok2) = read_bridge_credentials(&dir).unwrap();
        assert_eq!(ep2, endpoint);
        assert_eq!(tok2, cfg.token);
        // rotate：旧凭据失效（凭据文件删除，直到下次 activate 重写）
        let rotated = mgr.rotate_token(2100).unwrap();
        assert_ne!(rotated.token, cfg.token);
        let err = read_bridge_credentials(&dir).unwrap_err();
        assert_eq!(err.code, AgentError::Disabled);
        let (_, _ep2) = mgr.activate(|t| format!("/tmp/qk-agent-test2-{t}.sock"), 2150).unwrap();
        let (_, tok4) = read_bridge_credentials(&dir).unwrap();
        assert_ne!(tok4, cfg.token);
        // deactivate：凭据文件删除
        mgr.deactivate(2300).unwrap();
        let err = read_bridge_credentials(&dir).unwrap_err();
        assert_eq!(err.code, AgentError::Disabled);
        // 授权范围保留
        let kept = mgr.get();
        assert!(!kept.enabled);
        assert!(!kept.remote_roots.is_empty() || kept.local_write_roots.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scope_snapshot_prefers_write_roots_and_dedups() {
        let mut cfg = AgentConfig::default();
        let p = PathBuf::from("/tmp/shared");
        cfg.local_read_roots.push(p.clone());
        cfg.local_write_roots.push(p.clone());
        cfg.remote_roots.push(("a".into(), "".into()));
        cfg.remote_roots.push(("a".into(), "dup".into()));
        let s = cfg.scope();
        assert_eq!(s.local_read_roots.len(), 0);
        assert_eq!(s.local_write_roots.len(), 1);
        assert_eq!(s.remote_roots, vec!["a".to_string()]);
    }
    #[test]
    fn key_creation_is_atomic_and_corruption_does_not_replace_existing_material() {
        let temp=tempfile::tempdir().unwrap();let path=std::sync::Arc::new(temp.path().join("key"));
        let handles:Vec<_>=(0..16).map(|_|{let path=path.clone();std::thread::spawn(move||load_or_create_key(&path).unwrap())}).collect();
        let keys:Vec<_>=handles.into_iter().map(|h|h.join().unwrap()).collect();assert!(keys.iter().all(|k|k==&keys[0]));
        std::fs::write(&*path,b"damaged").unwrap();assert!(load_or_create_key(&path).is_err());assert_eq!(std::fs::read(&*path).unwrap(),b"damaged");
    }

    #[test]
    fn corrupt_existing_access_config_is_never_overwritten_by_a_partial_patch() {
        let temp=tempfile::tempdir().unwrap();let mut manager=AgentConfigManager::open(temp.path()).unwrap();
        manager.update(&json!({"writeMode":"read-only"}),1).unwrap();
        std::fs::write(manager.dir().join("access.bin"),b"damaged").unwrap();
        assert!(manager.update(&json!({"enabled":true}),2).is_err());
        assert_eq!(std::fs::read(manager.dir().join("access.bin")).unwrap(),b"damaged");
    }

}
