//! Signed frontend UI hot-update manager (L2).
//!
//! Security & anti-brick invariants:
//! 1. Only bundles authorized by an Ed25519-signed Hub manifest with verified SHA-256
//!    may be installed.
//! 2. Strict filename allowlist (7 static renderer assets only; zero path traversal,
//!    zero executables, zero symlinks).
//! 3. Every served asset is verified against its pinned SHA-256 before being returned.
//! 4. Boot watchdog: before navigating to hot-UI, `pendingBootVersion` is persisted.
//!    If the renderer fails to confirm `hub.uiReady` (crash or white screen), the next
//!    launch (or in-process timer) automatically blacklists that version and rolls back
//!    to the built-in `frontendDist`.
//! 5. Binary upgrade cleanup: when `CARGO_PKG_VERSION` advances beyond `binaryVersion`,
//!    stale hot-UI bundles from older binaries are automatically purged.

use crate::{hub::version_in_range, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub const MAX_UI_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES: usize = 2 * 1024 * 1024;
const HOT_UI_DIR: &str = "hot-ui";
const STATE_FILE: &str = "state.json";

pub const ALLOWED_UI_FILES: &[&str] = &[
    "index.html",
    "app.js",
    "api.js",
    "styles.css",
    "virtual-list.js",
    "tauri-bridge.js",
    "startup.html",
    "float-ball.html",
    "float-ball.js",
    "float-unarchive.html",
    "float-unarchive.js",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HotUiState {
    pub binary_version: String,
    pub active_version: Option<String>,
    pub pending_boot_version: Option<String>,
    pub active_changelog: Option<String>,
    pub blacklisted_versions: Vec<String>,
    pub active_files: BTreeMap<String, String>,
}

pub fn is_safe_hotfix_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && !v.starts_with('.')
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

pub fn mime_for_asset(name: &str) -> &'static str {
    if name.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if name.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

pub fn normalize_asset_path(raw: &str) -> Option<&'static str> {
    let trimmed = raw
        .split('?')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .trim_start_matches('/');
    let target = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };
    ALLOWED_UI_FILES.iter().copied().find(|&f| f == target)
}

fn root_dir(profile_dir: &Path) -> PathBuf {
    profile_dir.join(HOT_UI_DIR)
}

fn state_path(profile_dir: &Path) -> PathBuf {
    root_dir(profile_dir).join(STATE_FILE)
}

pub fn load_state(profile_dir: &Path) -> HotUiState {
    let path = state_path(profile_dir);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return HotUiState::default();
    };
    if !meta.file_type().is_file() || meta.len() > 256 * 1024 {
        return HotUiState::default();
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return HotUiState::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save_state(profile_dir: &Path, state: &HotUiState) -> Result<()> {
    use std::io::Write;
    let dir = root_dir(profile_dir);
    std::fs::create_dir_all(&dir).map_err(|_| Error::new("LOCAL_IO", "无法创建前端热更新目录"))?;
    let path = state_path(profile_dir);
    let tmp = dir.join(format!(".{STATE_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let bytes =
        serde_json::to_vec_pretty(state).map_err(|_| Error::new("SYSTEM", "热更新状态编码失败"))?;
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts
            .open(&tmp)
            .map_err(|_| Error::new("LOCAL_IO", "无法写入热更新状态临时文件"))?;
        f.write_all(&bytes)
            .and_then(|_| f.sync_all())
            .map_err(|_| Error::new("LOCAL_IO", "写入热更新状态失败"))?;
    }
    #[cfg(windows)]
    {
        let _ = std::fs::remove_file(&path);
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::new("LOCAL_IO", "保存热更新状态失败"));
    }
    Ok(())
}

/// Inspect hot-UI state on startup:
/// - Purges stale bundles if the binary version changed.
/// - Auto-blacklists and rolls back if a previous boot never confirmed `uiReady`.
/// - Verifies every required file's SHA-256 on disk before approving activation.
/// Returns `Some(version)` if hot-UI should be activated for this boot.
pub fn prepare_boot(profile_dir: &Path, binary_version: &str) -> Option<String> {
    let mut state = load_state(profile_dir);

    if !state.binary_version.is_empty() && state.binary_version != binary_version {
        // Binary upgraded/changed: purge old hot-UI bundles cleanly.
        if let Some(old) = state.active_version.take() {
            let _ = std::fs::remove_dir_all(root_dir(profile_dir).join(&old));
        }
        state.pending_boot_version = None;
        state.active_changelog = None;
        state.active_files.clear();
        state.blacklisted_versions.clear();
        state.binary_version = binary_version.to_string();
        let _ = save_state(profile_dir, &state);
        return None;
    }

    if let Some(crashed_ver) = state.pending_boot_version.take() {
        // Previous launch entered hot-UI and never confirmed `uiReady` -> rollback & blacklist!
        if !state.blacklisted_versions.contains(&crashed_ver) {
            state.blacklisted_versions.push(crashed_ver.clone());
            if state.blacklisted_versions.len() > 20 {
                let excess = state.blacklisted_versions.len() - 20;
                state.blacklisted_versions.drain(0..excess);
            }
        }
        if state.active_version.as_deref() == Some(crashed_ver.as_str()) {
            state.active_version = None;
            state.active_changelog = None;
            state.active_files.clear();
        }
        let _ = std::fs::remove_dir_all(root_dir(profile_dir).join(&crashed_ver));
        let _ = save_state(profile_dir, &state);
        return None;
    }

    let active = state.active_version.clone()?;
    if !is_safe_hotfix_version(&active) || state.blacklisted_versions.contains(&active) {
        state.active_version = None;
        state.active_files.clear();
        let _ = save_state(profile_dir, &state);
        return None;
    }

    if !verify_installed_bundle(profile_dir, &active, &state.active_files) {
        state.active_version = None;
        state.active_changelog = None;
        state.active_files.clear();
        let _ = std::fs::remove_dir_all(root_dir(profile_dir).join(&active));
        let _ = save_state(profile_dir, &state);
        return None;
    }

    state.binary_version = binary_version.to_string();
    state.pending_boot_version = Some(active.clone());
    let _ = save_state(profile_dir, &state);
    Some(active)
}

pub fn verify_installed_bundle(
    profile_dir: &Path,
    version: &str,
    expected_files: &BTreeMap<String, String>,
) -> bool {
    if expected_files.is_empty()
        || !expected_files.contains_key("index.html")
        || !expected_files.contains_key("app.js")
    {
        return false;
    }
    let dir = root_dir(profile_dir).join(version);
    for (name, expected_sha) in expected_files {
        if !ALLOWED_UI_FILES.contains(&name.as_str()) {
            return false;
        }
        let path = dir.join(name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            return false;
        };
        if !meta.file_type().is_file() || meta.len() as usize > MAX_SINGLE_FILE_BYTES {
            return false;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            return false;
        };
        let actual = hex::encode(Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(expected_sha) {
            return false;
        }
    }
    true
}

/// Confirm the active hot-UI booted cleanly and clear `pendingBootVersion`.
pub fn mark_boot_ready(profile_dir: &Path, binary_version: &str) -> HotUiState {
    let mut state = load_state(profile_dir);
    state.binary_version = binary_version.to_string();
    if state.pending_boot_version.is_some() {
        state.pending_boot_version = None;
        let _ = save_state(profile_dir, &state);
    }
    state
}

/// Explicitly roll back active hot-UI (e.g., watchdog timeout or user request) and blacklist it.
pub fn rollback(profile_dir: &Path, binary_version: &str, blacklist_current: bool) -> HotUiState {
    let mut state = load_state(profile_dir);
    state.binary_version = binary_version.to_string();
    let victim = state
        .active_version
        .take()
        .or_else(|| state.pending_boot_version.take());
    state.pending_boot_version = None;
    state.active_changelog = None;
    state.active_files.clear();
    if let Some(ver) = victim {
        if blacklist_current && !state.blacklisted_versions.contains(&ver) {
            state.blacklisted_versions.push(ver.clone());
        }
        let _ = std::fs::remove_dir_all(root_dir(profile_dir).join(&ver));
    }
    let _ = save_state(profile_dir, &state);
    state
}

/// Read and SHA-256-verify a single asset from the active hot-UI directory.
pub fn read_verified_asset(
    profile_dir: &Path,
    rel_path: &str,
) -> Option<(Vec<u8>, &'static str)> {
    let safe_name = normalize_asset_path(rel_path)?;
    let state = load_state(profile_dir);
    let active = state.active_version.as_deref()?;
    if !is_safe_hotfix_version(active) {
        return None;
    }
    let expected_sha = state.active_files.get(safe_name)?;
    let path = root_dir(profile_dir).join(active).join(safe_name);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.file_type().is_file() || meta.len() as usize > MAX_SINGLE_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let actual = hex::encode(Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(expected_sha) {
        return None;
    }
    Some((bytes, mime_for_asset(safe_name)))
}

/// Validate and atomically install a verified UI hotfix JSON bundle.
pub fn install_verified_bundle(
    profile_dir: &Path,
    binary_version: &str,
    expected_version: &str,
    expected_bundle_sha256: &str,
    manifest_file_hashes: Option<&BTreeMap<String, String>>,
    changelog: Option<&str>,
    bundle_bytes: &[u8],
) -> Result<HotUiState> {
    if !is_safe_hotfix_version(expected_version) {
        return Err(Error::new("INVALID_MANIFEST", "前端热更新版本号格式无效"));
    }
    if bundle_bytes.len() > MAX_UI_BUNDLE_BYTES {
        return Err(Error::new("INVALID_MANIFEST", "前端热更新包超出安全体积限制"));
    }
    let actual_bundle_sha = hex::encode(Sha256::digest(bundle_bytes));
    if !actual_bundle_sha.eq_ignore_ascii_case(expected_bundle_sha256) {
        return Err(Error::new(
            "CHECKSUM_MISMATCH",
            "前端热更新包 SHA-256 校验失败，已拒绝安装",
        ));
    }
    let parsed: Value = serde_json::from_slice(bundle_bytes)
        .map_err(|_| Error::new("INVALID_MANIFEST", "前端热更新包 JSON 解析失败"))?;
    if parsed["version"].as_str() != Some(expected_version) {
        return Err(Error::new("INVALID_MANIFEST", "前端热更新包内版本号与清单不符"));
    }
    let min_bin = parsed["minBinaryVersion"].as_str();
    let max_bin = parsed["maxBinaryVersion"].as_str();
    if !version_in_range(binary_version, min_bin, max_bin) {
        return Err(Error::new(
            "INCOMPATIBLE",
            "该前端热更新包不兼容当前主程序版本，请先升级主程序",
        ));
    }

    let files_obj = parsed["files"]
        .as_object()
        .ok_or_else(|| Error::new("INVALID_MANIFEST", "前端热更新包缺少 files 内容"))?;
    if !files_obj.contains_key("index.html") || !files_obj.contains_key("app.js") {
        return Err(Error::new(
            "INVALID_MANIFEST",
            "前端热更新包缺少核心入口文件（index.html / app.js）",
        ));
    }

    let mut verified_files: BTreeMap<String, (Vec<u8>, String)> = BTreeMap::new();
    for (name, val) in files_obj {
        if !ALLOWED_UI_FILES.contains(&name.as_str()) {
            return Err(Error::new(
                "FORBIDDEN",
                format!("前端热更新包包含未授权文件：{name}"),
            ));
        }
        let text = val
            .as_str()
            .ok_or_else(|| Error::new("INVALID_MANIFEST", format!("热更新文件 {name} 内容无效")))?;
        let bytes = text.as_bytes().to_vec();
        if bytes.len() > MAX_SINGLE_FILE_BYTES {
            return Err(Error::new("INVALID_MANIFEST", format!("热更新文件 {name} 超出大小上限")));
        }
        let sha = hex::encode(Sha256::digest(&bytes));
        if let Some(expected_map) = manifest_file_hashes {
            if let Some(exp) = expected_map.get(name) {
                if !sha.eq_ignore_ascii_case(exp) {
                    return Err(Error::new(
                        "CHECKSUM_MISMATCH",
                        format!("热更新文件 {name} SHA-256 校验失败"),
                    ));
                }
            }
        }
        verified_files.insert(name.clone(), (bytes, sha));
    }

    let root = root_dir(profile_dir);
    std::fs::create_dir_all(&root).map_err(|_| Error::new("LOCAL_IO", "无法创建热更新根目录"))?;
    let stage_dir = root.join(format!(".stage-{}-{}", expected_version, uuid::Uuid::new_v4()));
    let final_dir = root.join(expected_version);
    std::fs::create_dir_all(&stage_dir)
        .map_err(|_| Error::new("LOCAL_IO", "无法创建热更新暂存目录"))?;

    let mut active_hashes = BTreeMap::new();
    let write_res: Result<()> = (|| {
        use std::io::Write;
        for (name, (bytes, sha)) in &verified_files {
            let p = stage_dir.join(name);
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts
                .open(&p)
                .map_err(|_| Error::new("LOCAL_IO", "写入热更新静态文件失败"))?;
            f.write_all(bytes)
                .and_then(|_| f.sync_all())
                .map_err(|_| Error::new("LOCAL_IO", "同步热更新静态文件失败"))?;
            active_hashes.insert(name.clone(), sha.clone());
        }
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_dir_all(&stage_dir);
        return Err(e);
    }

    if final_dir.exists() {
        let _ = std::fs::remove_dir_all(&final_dir);
    }
    if std::fs::rename(&stage_dir, &final_dir).is_err() {
        let _ = std::fs::remove_dir_all(&stage_dir);
        return Err(Error::new("LOCAL_IO", "切换前端热更新目录失败"));
    }

    let mut state = load_state(profile_dir);
    let previous = state.active_version.clone();
    state.binary_version = binary_version.to_string();
    state.active_version = Some(expected_version.to_string());
    state.pending_boot_version = None;
    state.active_changelog = changelog.map(|s| s.to_string());
    state.active_files = active_hashes;
    state
        .blacklisted_versions
        .retain(|v| v != expected_version);
    save_state(profile_dir, &state)?;

    if let Some(old) = previous {
        if old != expected_version {
            let _ = std::fs::remove_dir_all(root.join(old));
        }
    }

    Ok(state)
}

pub fn status_json(profile_dir: &Path, binary_version: &str) -> Value {
    let state = load_state(profile_dir);
    json!({
        "binaryVersion": binary_version,
        "activeVersion": state.active_version,
        "pendingBootVersion": state.pending_boot_version,
        "changelog": state.active_changelog,
        "fileCount": state.active_files.len(),
        "blacklistedCount": state.blacklisted_versions.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_verify_watchdog_rollback_and_binary_upgrade_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = serde_json::to_vec(&json!({
            "version": "1.3.0-ui.1",
            "minBinaryVersion": "1.3.0",
            "maxBinaryVersion": "1.3.99",
            "files": {
                "index.html": "<!doctype html><html><body>hot</body></html>",
                "app.js": "console.log('hot');"
            }
        }))
        .unwrap();
        let sha = hex::encode(Sha256::digest(&bundle));

        let st = install_verified_bundle(
            dir.path(),
            "1.3.0",
            "1.3.0-ui.1",
            &sha,
            None,
            Some("fix dirDetail cache"),
            &bundle,
        )
        .unwrap();
        assert_eq!(st.active_version.as_deref(), Some("1.3.0-ui.1"));

        // Boot 1: prepare_boot activates and marks pending_boot_version
        assert_eq!(prepare_boot(dir.path(), "1.3.0").as_deref(), Some("1.3.0-ui.1"));
        let (html, mime) = read_verified_asset(dir.path(), "/index.html").unwrap();
        assert!(String::from_utf8_lossy(&html).contains("hot"));
        assert!(mime.starts_with("text/html"));

        // Boot 1 confirms uiReady -> stays active on Boot 2
        mark_boot_ready(dir.path(), "1.3.0");
        assert_eq!(prepare_boot(dir.path(), "1.3.0").as_deref(), Some("1.3.0-ui.1"));

        // Boot 2 simulates crash (no mark_boot_ready) -> Boot 3 auto-rolls back & blacklists!
        assert_eq!(prepare_boot(dir.path(), "1.3.0"), None);
        let after = load_state(dir.path());
        assert_eq!(after.active_version, None);
        assert!(after.blacklisted_versions.contains(&"1.3.0-ui.1".to_string()));
        assert!(read_verified_asset(dir.path(), "/index.html").is_none());

        // Reinstall & verify binary upgrade auto-purges old hot-UI
        install_verified_bundle(dir.path(), "1.3.0", "1.3.0-ui.1", &sha, None, None, &bundle)
            .unwrap();
        assert_eq!(prepare_boot(dir.path(), "1.4.0"), None);
        assert_eq!(load_state(dir.path()).active_version, None);
    }

    #[test]
    fn rejects_unauthorized_files_and_bad_checksum() {
        let dir = tempfile::tempdir().unwrap();
        let evil = serde_json::to_vec(&json!({
            "version": "1.3.0-ui.2",
            "minBinaryVersion": "1.3.0",
            "maxBinaryVersion": "1.3.99",
            "files": {
                "index.html": "ok",
                "app.js": "ok",
                "../evil.sh": "rm -rf /"
            }
        }))
        .unwrap();
        let sha = hex::encode(Sha256::digest(&evil));
        let err = install_verified_bundle(dir.path(), "1.3.0", "1.3.0-ui.2", &sha, None, None, &evil)
            .unwrap_err();
        assert_eq!(err.code, "FORBIDDEN");

        let bad_sha = install_verified_bundle(
            dir.path(),
            "1.3.0",
            "1.3.0-ui.2",
            &"0".repeat(64),
            None,
            None,
            &evil,
        )
        .unwrap_err();
        assert_eq!(bad_sha.code, "CHECKSUM_MISMATCH");
    }
}
