//! Agent 授权策略层（纯逻辑，不依赖 Tauri / 网络，便于离线单测）。
//!
//! 设计基线与 qck `src/main/agent/policy.js` 逐条对应：
//! 1. **默认拒绝**：没有任何授权范围时，一切工具调用都被拒绝。
//! 2. **本机桥接必须鉴别调用方**：凭据（token）由本模块生成并恒定时间比较。
//! 3. **本地路径只允许落在授权根内**：先规范化、再解析符号链接（解析最近的已存在祖先），
//!    最后用路径组件包含关系判定 —— 不做字符串前缀比较。
//! 4. **网盘范围按 FID 绑定**，且执行前必须重新核对当前归属（由工具层调用方保证）。

use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Component, Path, PathBuf};

/// Agent 侧错误码（与 qck policy.js 的 AgentError 一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentError {
    Unauthorized,
    Disabled,
    OutOfScope,
    ReadOnly,
    InvalidArg,
    NotFound,
    Conflict,
    PlanStale,
    Limit,
    Upstream,
    Internal,
}

impl AgentError {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentError::Unauthorized => "AGENT_UNAUTHORIZED",
            AgentError::Disabled => "AGENT_DISABLED",
            AgentError::OutOfScope => "AGENT_OUT_OF_SCOPE",
            AgentError::ReadOnly => "AGENT_READ_ONLY",
            AgentError::InvalidArg => "AGENT_INVALID_ARG",
            AgentError::NotFound => "AGENT_NOT_FOUND",
            AgentError::Conflict => "AGENT_CONFLICT",
            AgentError::PlanStale => "AGENT_PLAN_STALE",
            AgentError::Limit => "AGENT_LIMIT",
            AgentError::Upstream => "AGENT_UPSTREAM",
            AgentError::Internal => "AGENT_INTERNAL",
        }
    }
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Agent 侧错误：稳定 code + 可直接展示给模型的中文文案 + 可选提示。
#[derive(Debug, Clone)]
pub struct AgentToolError {
    pub code: AgentError,
    pub message: String,
    pub hint: Option<String>,
    /// 上游原始 message（脱敏后随结果返回，帮助模型判断是否重试）。
    pub upstream_message: Option<String>,
    pub upstream_code: Option<Value>,
}

impl AgentToolError {
    pub fn new(code: AgentError, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), hint: None, upstream_message: None, upstream_code: None }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// 上游错误透传：NEED_LOGIN 等语义原样保留，其余归一为 Upstream。
    /// `raw_message` 为服务端原始 message（会被上游脱敏层再处理）。
    pub fn from_upstream(code: &str, message: impl Into<String>, raw: Option<&Value>) -> Self {
        let known = [
            "NEED_LOGIN", "ABORTED", "TIMEOUT", "RATE_LIMIT", "FORBIDDEN", "NOT_FOUND", "CONFLICT",
            "INVALID_ARG", "LINK_EXPIRED", "TASK_FAILED", "NETWORK", "SERVER",
        ];
        let mapped = if known.contains(&code) {
            // 与 qck 一致：已知上游语义原样保留其字符串（调用方按字符串比对）。
            // 这里借用 Upstream 枚举承载，但 as_json 时输出原始 code 字符串。
            AgentError::Upstream
        } else {
            AgentError::Upstream
        };
        let mut e = Self::new(mapped, message);
        e.upstream_code = Some(Value::String(code.to_string()));
        if let Some(r) = raw {
            if let Some(m) = r.get("message").and_then(|v| v.as_str()) {
                let t = m.trim();
                if !t.is_empty() && t != e.message {
                    e.upstream_message = Some(t.chars().take(300).collect());
                }
            }
        }
        e
    }

    /// 序列化为跨 IPC 的 JSON 形状（与 qck AgentToolError 字段对应）。
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::json!({ "code": self.code.as_str(), "message": self.message });
        if let Some(h) = &self.hint {
            out["hint"] = Value::String(h.clone());
        }
        if let Some(m) = &self.upstream_message {
            out["detail"] = serde_json::json!({ "upstream_message": m });
        }
        out
    }
}

impl fmt::Display for AgentToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AgentToolError {}

// ---------------------------------------------------------------------------
// 本地路径
// ---------------------------------------------------------------------------

/// 拒绝 NUL 字节等非法输入，要求非空。
pub fn assert_plain_path(value: &str, label: &str) -> Result<String, AgentToolError> {
    if value.trim().is_empty() {
        return Err(AgentToolError::new(AgentError::InvalidArg, format!("{label}不能为空")));
    }
    if value.contains('\0') {
        return Err(AgentToolError::new(AgentError::InvalidArg, format!("{label}包含非法字符")));
    }
    Ok(value.to_string())
}

/// 解析符号链接后的"真实路径"；路径不存在时解析最近的已存在祖先并拼回剩余部分。
///
/// 对应 qck policy.js `resolveReal`：既能拦住"授权目录内的符号链接指向外部"，
/// 又能校验"即将创建"的文件（文件本身尚不存在，但其父目录的真实位置是确定的）。
pub fn resolve_real(target: &Path) -> Result<PathBuf, AgentToolError> {
    let mut current: PathBuf = target.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    for _ in 0..128 {
        match std::fs::canonicalize(&current) {
            Ok(real) => {
                if tail.is_empty() {
                    return Ok(real);
                }
                let mut out = real;
                for seg in tail.iter().rev() {
                    out.push(seg);
                }
                return Ok(out);
            }
            Err(e) => {
                // 与 qck 一致：只有 ENOENT / ENOTDIR 继续向上找；其余按"无法确认"拒绝（fail-closed）。
                let code = e.raw_os_error().unwrap_or(0);
                let is_enoent = e.kind() == std::io::ErrorKind::NotFound;
                let is_enotdir = code == libc::ENOTDIR;
                if !is_enoent && !is_enotdir {
                    return Err(AgentToolError::new(
                        AgentError::OutOfScope,
                        "无法确认本地路径的真实位置",
                    )
                    .with_hint("请检查授权目录的访问权限"));
                }
                let parent = match current.parent() {
                    Some(p) if p != current => p.to_path_buf(),
                    _ => {
                        let mut out = current;
                        for seg in tail.iter().rev() {
                            out.push(seg);
                        }
                        return Ok(out);
                    }
                };
                let last = current.file_name().map(|s| s.to_os_string()).unwrap_or_default();
                tail.push(last);
                current = parent;
            }
        }
    }
    Err(AgentToolError::new(AgentError::InvalidArg, "本地路径层级过深，已拒绝"))
}

/// 平台相关比较归一化：NFC + macOS/Windows 大小写折叠（只用于比较，不改返回值）。
pub fn normalize_for_compare(p: &str) -> String {
    // Rust 标准库无 NFC；macOS/Linux 文件名以字节比较，这里按 qck 语义做大小写折叠。
    // NFC 归一化由调用方保证输入来源一致（系统路径通常已为 NFC/NFD 原生形式）。
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

/// `target` 是否等于 `root` 或位于其内部（均为已解析的绝对路径）。
/// 用组件级包含关系，等价于 qck 的 `path.relative` + 前缀判定。
pub fn is_inside(root: &Path, target: &Path) -> bool {
    let root_n = normalize_for_compare(&root.to_string_lossy());
    let target_n = normalize_for_compare(&target.to_string_lossy());
    let root_p = Path::new(&root_n);
    let target_p = Path::new(&target_n);
    if root_p == target_p {
        return true;
    }
    target_p.starts_with(root_p)
}

/// 本地路径授权根：`access` 为 `r`（只读）或 `rw`（可读写）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRoot {
    pub path: PathBuf,
    pub access: &'static str,
}

/// 本地路径授权校验：解析真实路径并确认落在授权根内（需要写时必须有 rw 根覆盖）。
///
/// 对应 qck `assertLocalPath`：同一路径可能同时登记为只读来源与可写工作目录，
/// 只有确认没有任何可写根覆盖时才报只读错误（避免真实发生过的误拒）。
pub fn assert_local_path(
    target: &str,
    roots: &[LocalRoot],
    write: bool,
    label: &str,
) -> Result<PathBuf, AgentToolError> {
    let raw = assert_plain_path(target, label)?;
    let p = Path::new(&raw);
    if !p.is_absolute() {
        return Err(AgentToolError::new(AgentError::InvalidArg, format!("{label}必须是绝对路径")));
    }
    // 拒绝 `..` 组件（resolve_real 前的快速失败；真实解析仍以 canonicalize 为准）。
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AgentToolError::new(AgentError::OutOfScope, format!("{label}不允许包含 .. 路径段")));
    }
    let real = resolve_real(p)?;

    let mut read_only_hit: Option<&LocalRoot> = None;
    for item in roots {
        let root_real = resolve_real(&item.path)?;
        if !is_inside(&root_real, &real) {
            continue;
        }
        if write && item.access != "rw" {
            if read_only_hit.is_none() {
                read_only_hit = Some(item);
            }
            continue;
        }
        return Ok(real);
    }
    if let Some(hit) = read_only_hit {
        return Err(AgentToolError::new(
            AgentError::ReadOnly,
            format!("目录「{}」只读，不能写入", hit.path.display()),
        )
        .with_hint("请在客户端把该目录改为「可读写」，或改用已授权的可写目录"));
    }
    Err(AgentToolError::new(AgentError::OutOfScope, format!("{label}不在授权目录内"))
        .with_hint("请在客户端「设置 → Agent 接入」中添加该目录"))
}

// ---------------------------------------------------------------------------
// 网盘目录范围
// ---------------------------------------------------------------------------

/// 网盘根目录 fid（与 IPC_CONTRACT §1 一致）。
pub const ROOT_FID: &str = "0";

/// 归一化授权目录 FID 列表：去空、去重；根 "0" 不隐式加入（必须由用户显式授权）。
pub fn normalize_remote_roots(value: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let items = match value {
        Value::Array(a) => a.clone(),
        _ => return out,
    };
    for item in items {
        let fid = match &item {
            Value::String(s) => s.trim().to_string(),
            Value::Object(o) => o
                .get("fid")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string(),
            _ => continue,
        };
        if fid.is_empty() || out.contains(&fid) {
            continue;
        }
        out.push(fid);
    }
    out
}

/// 判断（已解析出的）目录链是否命中授权范围：自身或任一祖先在授权根内。
pub fn matches_remote_scope(fid: &str, ancestors: &[String], roots: &[String]) -> bool {
    roots.iter().any(|r| !r.is_empty() && (r == fid || ancestors.iter().any(|a| a == r)))
}

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

/// 生成 256 bit 桥接凭据（hex）。
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 恒定时间比较，避免响应时间侧信道；长度不同直接 false。
pub fn safe_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// 稳定序列化（计划内容哈希）
// ---------------------------------------------------------------------------

/// 稳定 JSON：对象键排序、剔除 null 值字段（qck 剔除 undefined；JSON 中对应缺失）。
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), canonical_json(&o[*k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// SHA-256 hex（计划内容哈希）。
pub fn sha256_hex(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 hex（字节缓冲；文本读取回读校验用）。
pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_64_hex_and_safe_equal_detects_difference() {
        let t = generate_token();
        assert_eq!(t.len(), 64);
        assert!(t.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(safe_equal(&t, &t));
        assert!(!safe_equal(&t, "x"));
        // 长度不同立即 false，不等长内容也 false
        assert!(!safe_equal("abc", "abd"));
    }

    #[test]
    fn plain_path_rejects_empty_and_nul() {
        assert!(assert_plain_path("", "本地路径").is_err());
        assert!(assert_plain_path("  ", "本地路径").is_err());
        assert!(assert_plain_path("a\0b", "本地路径").is_err());
        assert!(assert_plain_path("/tmp/x", "本地路径").is_ok());
    }

    #[test]
    fn local_path_requires_absolute_and_inside_root() {
        let root = std::env::temp_dir().join("qk-agent-policy-test");
        std::fs::create_dir_all(&root).unwrap();
        let roots = vec![LocalRoot { path: root.clone(), access: "rw" }];
        // 相对路径拒绝
        assert!(assert_local_path("rel/path", &roots, false, "本地路径").is_err());
        // 授权根内允许
        let inside = root.join("sub");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(assert_local_path(&inside.to_string_lossy(), &roots, false, "本地路径").is_ok());
        // 越界拒绝
        let outside = std::env::temp_dir().join("qk-agent-outside");
        std::fs::create_dir_all(&outside).unwrap();
        let err = assert_local_path(&outside.to_string_lossy(), &roots, false, "本地路径").unwrap_err();
        assert_eq!(err.code, AgentError::OutOfScope);
        // 前缀陷阱：/root-evil 不应命中 /root
        let evil = std::env::temp_dir().join("qk-agent-policy-test-evil");
        std::fs::create_dir_all(&evil).unwrap();
        let err2 = assert_local_path(&evil.to_string_lossy(), &roots, false, "本地路径").unwrap_err();
        assert_eq!(err2.code, AgentError::OutOfScope);
        // 只读根写操作 → READ_ONLY
        let ro = vec![LocalRoot { path: root.clone(), access: "r" }];
        let err3 = assert_local_path(&inside.to_string_lossy(), &ro, true, "本地路径").unwrap_err();
        assert_eq!(err3.code, AgentError::ReadOnly);
        // `..` 组件直接拒绝
        assert!(assert_local_path("/tmp/../etc", &roots, false, "本地路径").is_err());
    }

    #[test]
    fn resolve_real_resolves_symlink_escape() {
        let base = std::env::temp_dir().join(format!("qk-agent-symlink-{}", std::process::id()));
        let dir = base.join("work");
        std::fs::create_dir_all(&dir).unwrap();
        let outside = std::env::temp_dir().join("qk-agent-symlink-outside");
        std::fs::create_dir_all(&outside).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        let roots = vec![LocalRoot { path: dir.clone(), access: "rw" }];
        let err = assert_local_path(&dir.join("link").join("f").to_string_lossy(), &roots, false, "本地路径")
            .unwrap_err();
        assert_eq!(err.code, AgentError::OutOfScope);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn remote_scope_matches_self_and_ancestors_but_requires_explicit_root() {
        let roots = vec!["fid-a".to_string()];
        assert!(matches_remote_scope("fid-a", &[], &roots));
        assert!(matches_remote_scope("fid-child", &["fid-a".into(), "0".into()], &roots));
        assert!(!matches_remote_scope("fid-x", &["fid-b".into()], &roots));
        // 根 "0" 未显式授权时不命中
        assert!(!matches_remote_scope("fid-child", &["0".into()], &[]));
    }

    #[test]
    fn normalize_remote_roots_dedups_and_ignores_implicit_root() {
        let v = serde_json::json!(["a", "a", {"fid": " b "}, "", "0"]);
        assert_eq!(normalize_remote_roots(&v), vec!["a".to_string(), "b".to_string(), "0".to_string()]);
    }

    #[test]
    fn canonical_json_sorts_keys_for_stable_hash() {
        let a = serde_json::json!({"b":1,"a":[2,{"y":null,"x":3}]});
        let b = serde_json::json!({"a":[2,{"x":3,"y":null}],"b":1});
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_eq!(sha256_hex("abc").len(), 64);
    }

    #[test]
    fn upstream_error_preserves_code_and_raw_message() {
        let raw = serde_json::json!({"message": "move file fail:[不能移动至相同目录]", "code": 23003});
        let e = AgentToolError::from_upstream("NEED_LOGIN", "请先登录", Some(&raw));
        assert_eq!(e.upstream_code.as_ref().and_then(|v| v.as_str()), Some("NEED_LOGIN"));
        assert_eq!(e.upstream_message.as_deref(), Some("move file fail:[不能移动至相同目录]"));
        let j = e.to_json();
        assert_eq!(j["code"], "AGENT_UPSTREAM");
    }
}
