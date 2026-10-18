//! 操作记录（journal）：JSONL 审计、脱敏、滚动轮转。
//!
//! 与 qck journal.js 对应：每条记录 `{seq, ts, kind, tool, actor, result, target, detail}`；
//! `sanitize`（面向日志，600 字符截断）与 `redact`（面向模型结果回传，不限长度）分工；
//! 单文件 4MiB 滚动保留一代；损坏行跳过。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// 需要整枝裁剪的键（出现即丢弃该子树）。
const SECRET_KEYS: [&str; 10] = [
    "cookie", "cookies", "authorization", "token", "secret", "password", "api_key", "apikey",
    "sign", "signature",
];

/// URL 查询中常见的签名参数：出现即整段剔除（值再短也视为敏感）。
/// 补齐夸克下载直链实际使用的签名参数（st/__puus/__pus/ctoken，qck 同款）。
const URL_SECRET_PARAMS: [&str; 10] = [
    "sign", "signature", "token", "auth", "key", "credential", "st", "__puus", "__pus", "ctoken",
];

fn is_secret_key(k: &str) -> bool {
    let lower = k.to_ascii_lowercase();
    SECRET_KEYS.iter().any(|s| lower == *s || lower.ends_with(s) || lower.contains(s))
}

fn looks_like_signed_url(v: &str) -> bool {
    // 对应 qck URL_WITH_SIGN_RE：携带签名参数的直链。覆盖三种形态：
    // http(s)://…、协议相对 //cdn…（夸克直链实际形态）、";st=" 分号分隔（qck 同款）。
    let lower = v.to_ascii_lowercase();
    let is_urlish = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("//")
        || lower.contains(";http")
        || lower.contains(";//");
    is_urlish
        && URL_SECRET_PARAMS.iter().any(|p| {
            lower.contains(&format!("{p}="))
                || lower.contains(&format!("{p}%3d"))
                || lower.contains(&format!(";{p}="))
        })
}

fn redact_value(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, val) in o {
                if is_secret_key(k) {
                    continue;
                }
                out.insert(k.clone(), redact_value(val));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(redact_value).collect()),
        Value::String(s) => {
            if looks_like_signed_url(s) {
                Value::String("[已脱敏:签名直链]".into())
            } else {
                Value::String(s.clone())
            }
        }
        other => other.clone(),
    }
}

/// 面向模型结果回传的脱敏：不限长度，只去敏感键与签名直链。
pub fn redact(v: &Value) -> Value {
    redact_value(v)
}

/// 面向日志的脱敏 + 截断（600 字符）。
pub fn sanitize(v: &Value) -> Value {
    let r = redact(v);
    let text = serde_json::to_string(&r).unwrap_or_default();
    if text.chars().count() <= 600 {
        return r;
    }
    Value::String(format!("{}…[截断]", text.chars().take(600).collect::<String>()))
}

pub struct JournalEntry {
    pub seq: u64,
    pub ts: i64,
    pub kind: String,
    pub tool: String,
    pub actor: String,
    pub result: String,
    pub target: Value,
    pub detail: Value,
}

impl JournalEntry {
    pub fn to_json(&self) -> Value {
        json!({
            "seq": self.seq,
            "ts": self.ts,
            "kind": self.kind,
            "tool": self.tool,
            "actor": self.actor,
            "result": self.result,
            "target": self.target,
            "detail": self.detail,
        })
    }
}

struct JournalInner {
    path: PathBuf,
    seq: u64,
}

/// 追加型 JSONL 审计库（进程内单例；多实例需由调用方保证唯一）。
pub struct Journal {
    inner: Mutex<JournalInner>,
}

impl Journal {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("journal.jsonl");
        // 恢复 seq：读最后一行
        let mut seq = 0u64;
        if let Ok(f) = std::fs::File::open(&path) {
            for line in BufReader::new(f).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(s) = v.get("seq").and_then(|x| x.as_u64()) {
                        seq = seq.max(s);
                    }
                }
            }
        }
        Ok(Self { inner: Mutex::new(JournalInner { path, seq }) })
    }

    pub fn file(&self) -> PathBuf {
        self.inner.lock().unwrap().path.clone()
    }

    fn rotate_if_needed(path: &Path) {
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() >= MAX_FILE_BYTES {
                let older = path.with_extension("jsonl.1");
                let _ = std::fs::remove_file(&older);
                let _ = std::fs::rename(path, &older);
            }
        }
    }

    /// 追加一条记录；写入失败静默（审计不能阻断业务）但 seq 仍前进。
    pub fn append(&self, kind: &str, tool: &str, actor: &str, result: &str, target: &Value, detail: &Value) -> JournalEntry {
        let mut inner = self.inner.lock().unwrap();
        inner.seq += 1;
        let entry = JournalEntry {
            seq: inner.seq,
            ts: now_ms(),
            kind: kind.into(),
            tool: tool.into(),
            actor: actor.into(),
            result: result.into(),
            target: sanitize(target),
            detail: sanitize(detail),
        };
        Self::rotate_if_needed(&inner.path);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&inner.path) {
            let line = entry.to_json().to_string();
            let _ = writeln!(f, "{line}");
        }
        entry
    }

    /// 读取最近 limit 条（按 seq 升序返回）。
    pub fn list(&self, limit: usize, tool_filter: Option<&str>) -> Vec<Value> {
        let inner = self.inner.lock().unwrap();
        let mut out: Vec<Value> = Vec::new();
        for older in [inner.path.with_extension("jsonl.1"), inner.path.clone()] {
            if let Ok(f) = std::fs::File::open(&older) {
                for line in BufReader::new(f).lines().map_while(Result::ok) {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if let Some(tf) = tool_filter {
                            if v.get("tool").and_then(|x| x.as_str()) != Some(tf) {
                                continue;
                            }
                        }
                        out.push(v);
                    }
                }
            }
        }
        if out.len() > limit {
            out = out.split_off(out.len() - limit);
        }
        out
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qk-agent-journal-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn append_list_roundtrip_and_secret_redaction() {
        let dir = tmp_dir("roundtrip");
        let j = Journal::open(&dir).unwrap();
        j.append("tool", "list_dir", "agent", "ok",
            &serde_json::json!({"fid": "f1"}),
            &serde_json::json!({"url": "https://oss.example.com/file?sign=abc&x=1", "cookie": "SID=1", "note": "保留"}));
        let rows = j.list(10, None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["seq"], 1);
        assert_eq!(rows[0]["tool"], "list_dir");
        let detail = rows[0]["detail"].clone();
        assert!(detail["cookie"].is_null());
        assert_eq!(detail["url"], "[已脱敏:签名直链]");
        assert_eq!(detail["note"], "保留");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seq_survives_reopen_and_filter_and_limit() {
        let dir = tmp_dir("seq");
        {
            let j = Journal::open(&dir).unwrap();
            for i in 0..5 {
                j.append("tool", if i % 2 == 0 { "list_dir" } else { "file_info" }, "agent", "ok",
                    &serde_json::json!({"i": i}), &Value::Null);
            }
        }
        let j2 = Journal::open(&dir).unwrap();
        j2.append("tool", "list_dir", "user", "ok", &Value::Null, &Value::Null);
        let all = j2.list(100, None);
        assert_eq!(all.len(), 6);
        assert_eq!(all[5]["seq"], 6);
        let filtered = j2.list(100, Some("file_info"));
        assert_eq!(filtered.len(), 2);
        let limited = j2.list(2, None);
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[1]["seq"], 6);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
