//! 备份验证：清单核对 + 抽样下载比对。
//!
//! 分层（执行提示词 §5"如实标注验证强度"）：
//! - `verify_manifest`：全部 success 任务按 (relPath, size, remoteFid) 与远端清单核对——
//!   证据是"远端存在该 fid 且 size 一致"，不含内容哈希；
//! - `verify_sample`：抽样下载文件回读 SHA-256 与本地比对（真实内容一致性证据）；
//!   抽样率可配（默认 1% 且至少 5 个、至多 20 个）。
//! - ETag/分片校验是传输层内部证据，不当作内容哈希对外宣称。

use crate::state::TaskState;
use crate::store::Store;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// 远端清单与下载能力（宿主注入；测试假实现）。
pub trait VerifyOps: Send + Sync {
    /// 列出目录 fid 下的直接子项（name, fid, size, is_dir）。
    fn list_dir<'a>(
        &'a self,
        fid: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow_lite::Result<Vec<RemoteEntry>, String>> + Send + 'a>>;
    /// 下载文件到内存（小文件抽样用；大文件由调用方限制）。
    fn download_bytes<'a>(
        &'a self,
        fid: &'a str,
        max_bytes: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow_lite::Result<Vec<u8>, String>> + Send + 'a>>;
}

pub mod anyhow_lite {
    pub type Result<T, E> = std::result::Result<T, E>;
}

#[derive(Debug, Clone)]
pub struct RemoteEntry {
    pub name: String,
    pub fid: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct VerifyReport {
    pub total_success: usize,
    pub listed_ok: usize,
    pub listed_missing: usize,
    pub size_mismatch: usize,
    pub sample_requested: usize,
    pub sample_checked: usize,
    pub sample_ok: usize,
    pub sample_mismatch: usize,
    /// verified | partial | failed
    pub status: String,
    pub issues: Vec<serde_json::Value>,
}

/// 抽样策略：1% 且 [5, 20]。
pub fn sample_plan(total: usize, rate_ppm: u32) -> usize {
    let rate_ppm = if rate_ppm == 0 { 10_000 } else { rate_ppm }; // 默认 1%
    let n = (total as u64 * rate_ppm as u64 / 1_000_000) as usize;
    n.clamp(if total > 0 { 5.min(total) } else { 0 }, 20.min(total))
}

/// 清单核对：递归列出 target 树，与 store 中 success 任务逐条比对（relPath → 存在 + size 一致）。
/// 目录结构通过 store 的 dirs 表映射（relPath → fid）逐目录 list。
pub async fn verify_manifest(
    store: Arc<Store>,
    ops: Arc<dyn VerifyOps>,
    account: &str,
    target_fid: &str,
) -> VerifyReport {
    let mut report = VerifyReport { status: "verified".into(), ..Default::default() };
    // 拉取全部 success 任务
    let Ok(all) = store.all_in_state(account, TaskState::Success) else {
        report.status = "failed".into();
        report.issues.push(json!({"kind": "store_error", "detail": "读取任务库失败"}));
        return report;
    };
    report.total_success = all.len();
    if all.is_empty() {
        return report;
    }
    // 按 parent rel 分组（parent_rel → 文件列表）
    use std::collections::HashMap;
    let mut by_parent: HashMap<String, Vec<&crate::store::Task>> = HashMap::new();
    for t in &all {
        let parent = t.rel_path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
        by_parent.entry(parent).or_default().push(t);
    }
    for (parent_rel, tasks) in by_parent {
        // 该目录的远端 fid
        let dir_fid = if parent_rel.is_empty() {
            target_fid.to_string()
        } else {
            match store.get_dir(account, target_fid, &parent_rel) {
                Ok(Some(f)) => f,
                _ => {
                    report.listed_missing += tasks.len();
                    report.status = "partial".into();
                    report.issues.push(json!({
                        "kind": "dir_missing", "dir": parent_rel,
                        "detail": "目录映射缺失，无法核对该目录下的文件",
                    }));
                    continue;
                }
            }
        };
        // 远端列表（多页由宿主聚合；这里一次调用返回全部直接子项）
        let entries = match ops.list_dir(&dir_fid).await {
            Ok(v) => v,
            Err(e) => {
                report.listed_missing += tasks.len();
                report.status = "partial".into();
                report.issues.push(json!({"kind": "list_error", "dir": parent_rel, "detail": e}));
                continue;
            }
        };
        for t in tasks {
            let name = t.rel_path.rsplit('/').next().unwrap_or("");
            match entries.iter().find(|e| e.name == name) {
                Some(e) if e.size == t.size && !e.is_dir => {
                    report.listed_ok += 1;
                }
                Some(e) => {
                    report.size_mismatch += 1;
                    report.status = "partial".into();
                    report.issues.push(json!({
                        "kind": "size_mismatch", "rel_path": t.rel_path,
                        "local_size": t.size, "remote_size": e.size, "remote_fid": e.fid,
                    }));
                }
                None => {
                    report.listed_missing += 1;
                    report.status = "partial".into();
                    report.issues.push(json!({
                        "kind": "missing", "rel_path": t.rel_path,
                        "detail": format!("远端目录 {parent_rel} 中未见同名文件"),
                    }));
                }
            }
        }
    }
    if report.listed_missing + report.size_mismatch > 0 {
        report.status = if report.listed_ok == 0 { "failed".into() } else { "partial".into() };
    }
    report
}

/// 抽样下载比对：对报告中的 success 任务抽样，下载远端字节与本地 SHA-256 比对。
pub async fn verify_sample(
    store: Arc<Store>,
    ops: Arc<dyn VerifyOps>,
    report: &mut VerifyReport,
    account: &str,
    sample_rate_ppm: u32,
    max_sample_bytes: u64,
) {
    let Ok(all) = store.all_in_state(account, TaskState::Success) else { return };
    let n = sample_plan(all.len(), sample_rate_ppm);
    report.sample_requested = n;
    if n == 0 {
        return;
    }
    // 均匀抽样（步长取法，确定性；跳过超大文件）
    let step = all.len() / n.max(1);
    let mut checked = 0usize;
    for i in 0..n {
        let t = &all[(i * step).min(all.len() - 1)];
        if t.size > max_sample_bytes {
            continue;
        }
        let Some(fid) = &t.remote_fid else { continue };
        let local = match tokio::fs::read(&t.local_path).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        report.sample_checked += 1;
        match ops.download_bytes(fid, max_sample_bytes).await {
            Ok(remote_bytes) => {
                let mut h1 = Sha256::new();
                h1.update(&local);
                let mut h2 = Sha256::new();
                h2.update(&remote_bytes);
                if h1.finalize()[..] == h2.finalize()[..] {
                    report.sample_ok += 1;
                } else {
                    report.sample_mismatch += 1;
                    report.status = "partial".into();
                    report.issues.push(json!({
                        "kind": "sample_hash_mismatch", "rel_path": t.rel_path, "fid": fid,
                    }));
                }
                checked += 1;
            }
            Err(e) => {
                report.issues.push(json!({
                    "kind": "sample_download_error", "rel_path": t.rel_path, "detail": e,
                }));
            }
        }
    }
    let _ = checked;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct FakeVerify {
        tree: Mutex<HashMap<String, Vec<RemoteEntry>>>,
        blobs: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl VerifyOps for FakeVerify {
        fn list_dir<'a>(
            &'a self,
            fid: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow_lite::Result<Vec<RemoteEntry>, String>> + Send + 'a>> {
            Box::pin(async move {
                Ok(self.tree.lock().unwrap().get(fid).cloned().unwrap_or_default())
            })
        }
        fn download_bytes<'a>(
            &'a self,
            fid: &'a str,
            _max: u64,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow_lite::Result<Vec<u8>, String>> + Send + 'a>> {
            Box::pin(async move {
                self.blobs
                    .lock().unwrap()
                    .get(fid)
                    .cloned()
                    .ok_or_else(|| format!("no blob {fid}"))
            })
        }
    }

    fn entry(name: &str, fid: &str, size: u64) -> RemoteEntry {
        RemoteEntry { name: name.into(), fid: fid.into(), size, is_dir: false }
    }

    #[tokio::test]
    async fn manifest_verify_matches_and_flags_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("t.db")).unwrap());
        let root = dir.path().join("data");
        std::fs::create_dir_all(&root).unwrap();
        let mk = |rel: &str, body: &[u8]| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, body).unwrap();
            crate::store::Task {
                account: "acc".into(),
                root_dir: root.to_string_lossy().to_string(),
                target_fid: "t1".into(),
                rel_path: rel.into(),
                local_path: p.to_string_lossy().to_string(),
                size: body.len() as u64,
                mtime_ms: 0,
                state: TaskState::Success,
                remote_fid: Some(format!("rf-{rel}")),
                attempts: 0,
                last_error: None,
                chunk_progress: None,
                updated_at_ms: 0,
            }
        };
        let tasks = vec![mk("a.txt", b"hello"), mk("sub/b.txt", b"world!")];
        store.upsert_discovered(&tasks).unwrap();
        // 强制置 success
        store.put_dir("acc", "t1", "sub", "dir-sub").unwrap();
        for t in &tasks {
            let mut t2 = t.clone();
            t2.state = TaskState::Pending;
            store.upsert_discovered(&[t.clone()]).unwrap();
            store.claim_batch("acc", 10).unwrap();
            store.transition(t, TaskState::Uploading, None).unwrap();
            store.transition(t, TaskState::Verifying, None).unwrap();
            store.transition(t, TaskState::Success, None).unwrap();
        }

        let ops = Arc::new(FakeVerify {
            tree: Mutex::new(HashMap::from([
                ("t1".to_string(), vec![entry("a.txt", "rf-a.txt", 5)]),
                ("dir-sub".to_string(), vec![entry("b.txt", "rf-sub/b.txt", 6)]),
            ])),
            blobs: Mutex::new(HashMap::from([
                ("rf-a.txt".to_string(), b"hello".to_vec()),
                ("rf-sub/b.txt".to_string(), b"world!".to_vec()),
            ])),
        });
        let mut report = verify_manifest(store.clone(), ops.clone(), "acc", "t1").await;
        assert_eq!(report.total_success, 2);
        assert_eq!(report.listed_ok, 2);
        assert_eq!(report.status, "verified");

        // 抽样：2 个文件 → sample_plan 至少 5 但 clamp 到 total=2
        verify_sample(store.clone(), ops.clone(), &mut report, "acc", 10_000, 1024).await;
        assert_eq!(report.sample_requested, 2);
        assert_eq!(report.sample_checked, 2);
        assert_eq!(report.sample_ok, 2);
        assert_eq!(report.sample_mismatch, 0);
    }

    #[tokio::test]
    async fn manifest_flags_size_mismatch_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("t.db")).unwrap());
        let root = dir.path().join("data");
        std::fs::create_dir_all(&root).unwrap();
        let mk = |rel: &str, body: &[u8]| {
            let p = root.join(rel);
            std::fs::write(&p, body).unwrap();
            crate::store::Task {
                account: "acc".into(),
                root_dir: root.to_string_lossy().to_string(),
                target_fid: "t1".into(),
                rel_path: rel.into(),
                local_path: p.to_string_lossy().to_string(),
                size: body.len() as u64,
                mtime_ms: 0,
                state: TaskState::Success,
                remote_fid: Some("rf".into()),
                attempts: 0,
                last_error: None,
                chunk_progress: None,
                updated_at_ms: 0,
            }
        };
        let tasks = vec![mk("a.txt", b"hello"), mk("b.txt", b"x")];
        store.upsert_discovered(&tasks).unwrap();
        store.claim_batch("acc", 10).unwrap();
        for t in &tasks {
            store.transition(t, TaskState::Uploading, None).unwrap();
            store.transition(t, TaskState::Verifying, None).unwrap();
            store.transition(t, TaskState::Success, None).unwrap();
        }
        // 远端：a.txt 存在但 size 不同；b.txt 缺失
        let ops = Arc::new(FakeVerify {
            tree: Mutex::new(HashMap::from([
                ("t1".to_string(), vec![entry("a.txt", "rf", 99)]),
            ])),
            blobs: Mutex::new(HashMap::new()),
        });
        let report = verify_manifest(store, ops, "acc", "t1").await;
        assert_eq!(report.size_mismatch, 1);
        assert_eq!(report.listed_missing, 1);
        // 全部条目都有问题（listed_ok=0）→ failed；部分有问题 → partial
        assert_eq!(report.status, "failed");
        assert_eq!(report.issues.len(), 2);
    }

    #[test]
    fn sample_plan_bounds() {
        assert_eq!(sample_plan(0, 0), 0);
        assert_eq!(sample_plan(3, 0), 3, "不足 5 时 clamp 到总数");
        assert_eq!(sample_plan(100, 10_000), 5, "1% 不足下限取 5");
        assert_eq!(sample_plan(10_000, 10_000), 20, "上限 20");
        assert_eq!(sample_plan(2000, 10_000), 20, "2000×1%=20");
    }
}
