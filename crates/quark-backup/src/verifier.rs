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
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = anyhow_lite::Result<Vec<RemoteEntry>, String>>
                + Send
                + 'a,
        >,
    >;
    fn list_page<'a>(
        &'a self,
        fid: &'a str,
        page: u64,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(Vec<RemoteEntry>, bool), String>> + Send + 'a>,
    > {
        Box::pin(async move {
            if page > 1 {
                Ok((Vec::new(), false))
            } else {
                self.list_dir(fid).await.map(|v| (v, false))
            }
        })
    }
    fn download_hash<'a>(
        &'a self,
        fid: &'a str,
        max_bytes: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send + 'a>>
    {
        Box::pin(async move {
            let bytes = self.download_bytes(fid, max_bytes).await?;
            Ok(Sha256::digest(bytes).to_vec())
        })
    }
    /// 下载文件到内存（小文件抽样用；大文件由调用方限制）。
    fn download_bytes<'a>(
        &'a self,
        fid: &'a str,
        max_bytes: u64,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow_lite::Result<Vec<u8>, String>> + Send + 'a>,
    >;
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
    pub incomplete: usize,
    pub warning_count: usize,
    pub directories_checked: usize,
    pub issue_total: usize,
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

/// Default is 1%, 5..20; explicitly selecting 100% checks every file without a 20-file cap.
pub fn sample_plan(total: usize, rate_ppm: u32) -> usize {
    if rate_ppm >= 1_000_000 {
        return total;
    }
    let rate = if rate_ppm == 0 { 10_000 } else { rate_ppm };
    ((total as u64 * rate as u64 / 1_000_000) as usize).clamp(5.min(total), 20.min(total))
}
fn issue(store: &Store, report: &mut VerifyReport, value: serde_json::Value) {
    report.issue_total += 1;
    if store.add_verification_issue(&value).is_err() {
        report.status = "failed".into();
    }
    if report.issues.len() < 200 {
        report.issues.push(value);
    }
    if report.status != "failed" {
        report.status = "partial".into();
    }
}

/// Verify bounded pages of local tasks against paginated remote directory listings.
/// Memory is bounded by 500 expected tasks, one remote page and 200 issue summaries.
pub async fn verify_manifest(
    store: Arc<Store>,
    ops: Arc<dyn VerifyOps>,
    account: &str,
    target_fid: &str,
) -> VerifyReport {
    let mut report = VerifyReport {
        status: "verified".into(),
        ..Default::default()
    };
    if store.clear_verification_issues().is_err() {
        report.status = "failed".into();
        return report;
    }
    if let Err(e) = ops.list_page(target_fid, 1).await {
        issue(
            &store,
            &mut report,
            json!({"kind":"target_unavailable","detail":e}),
        );
        report.status = "failed".into();
        return report;
    }
    match store.counts(account) {
        Ok(counts) => {
            report.total_success = counts.get("success").copied().unwrap_or(0) as usize;
            report.incomplete = counts
                .iter()
                .filter(|(k, _)| k.as_str() != "success")
                .map(|(_, n)| *n as usize)
                .sum();
            if report.incomplete > 0 {
                issue(
                    &store,
                    &mut report,
                    json!({"kind":"incomplete_tasks","detail":counts}),
                );
            }
        }
        Err(e) => {
            report.status = "failed".into();
            issue(
                &store,
                &mut report,
                json!({"kind":"store_error","detail":e.to_string()}),
            );
            return report;
        }
    }
    report.warning_count = store.issue_count().unwrap_or(1) as usize;
    let warning_count = report.warning_count;
    if warning_count > 0 {
        issue(
            &store,
            &mut report,
            json!({"kind":"scan_exclusions","count":warning_count,"detail":store.issue_page(0,20).unwrap_or_default()}),
        );
    }
    let mut offset = 0;
    loop {
        let tasks = match store.task_page(account, Some(TaskState::Success), offset, 500) {
            Ok(v) => v,
            Err(e) => {
                issue(
                    &store,
                    &mut report,
                    json!({"kind":"store_error","detail":e.to_string()}),
                );
                report.status = "failed".into();
                return report;
            }
        };
        if tasks.is_empty() {
            break;
        }
        offset += tasks.len();
        let mut groups = std::collections::BTreeMap::<String, Vec<crate::Task>>::new();
        for t in tasks {
            let parent = t
                .rel_path
                .rsplit_once('/')
                .map(|(p, _)| p.to_string())
                .unwrap_or_default();
            groups.entry(parent).or_default().push(t);
        }
        for (parent, tasks) in groups {
            let fid = if parent.is_empty() {
                Some(target_fid.to_string())
            } else {
                store.get_dir(account, target_fid, &parent).ok().flatten()
            };
            let Some(fid) = fid else {
                report.listed_missing += tasks.len();
                issue(
                    &store,
                    &mut report,
                    json!({"kind":"dir_missing","dir":parent}),
                );
                continue;
            };
            let mut expected: std::collections::HashMap<_, _> = tasks
                .into_iter()
                .map(|t| (t.rel_path.rsplit('/').next().unwrap_or("").to_string(), t))
                .collect();
            let mut page = 1;
            loop {
                match ops.list_page(&fid, page).await {
                    Err(e) => {
                        issue(
                            &store,
                            &mut report,
                            json!({"kind":"list_error","dir":parent,"detail":e}),
                        );
                        break;
                    }
                    Ok((entries, more)) => {
                        if entries.is_empty() && more {
                            issue(
                                &store,
                                &mut report,
                                json!({"kind":"invalid_pagination","dir":parent}),
                            );
                            break;
                        }
                        for entry in entries {
                            if let Some(t) = expected.remove(&entry.name) {
                                if !entry.is_dir
                                    && entry.size == t.size
                                    && t.remote_fid.as_deref() == Some(entry.fid.as_str())
                                {
                                    report.listed_ok += 1;
                                } else {
                                    report.size_mismatch += 1;
                                    issue(
                                        &store,
                                        &mut report,
                                        json!({"kind":"identity_or_size_mismatch","rel_path":t.rel_path,"expected_size":t.size,"remote_size":entry.size,"expected_fid":t.remote_fid,"remote_fid":entry.fid}),
                                    );
                                }
                            }
                        }
                        if !more || expected.is_empty() {
                            break;
                        }
                        page += 1;
                    }
                }
            }
            for (_, t) in expected {
                report.listed_missing += 1;
                issue(
                    &store,
                    &mut report,
                    json!({"kind":"missing","rel_path":t.rel_path}),
                );
            }
        }
    }
    // Empty directories also matter: check each directory mapping in its parent's listing.
    let mut offset = 0;
    loop {
        let dirs = match store.dir_page(account, target_fid, offset, 500) {
            Ok(v) => v,
            Err(e) => {
                issue(
                    &store,
                    &mut report,
                    json!({"kind":"store_error","detail":e.to_string()}),
                );
                break;
            }
        };
        if dirs.is_empty() {
            break;
        }
        offset += dirs.len();
        for (rel, want_fid) in dirs {
            let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel.as_str()));
            let parent_fid = if parent.is_empty() {
                Some(target_fid.to_string())
            } else {
                store.get_dir(account, target_fid, parent).ok().flatten()
            };
            let mut found = false;
            if let Some(fid) = parent_fid {
                let mut page = 1;
                loop {
                    match ops.list_page(&fid, page).await {
                        Ok((entries, more)) => {
                            if entries
                                .iter()
                                .any(|e| e.is_dir && e.name == name && e.fid == want_fid)
                            {
                                found = true;
                                break;
                            }
                            if !more || entries.is_empty() {
                                break;
                            }
                            page += 1;
                        }
                        Err(_) => break,
                    }
                }
            }
            if found {
                report.directories_checked += 1;
            } else {
                issue(
                    &store,
                    &mut report,
                    json!({"kind":"directory_missing","rel_path":rel,"fid":want_fid}),
                );
            }
        }
    }
    if report.total_success > 0 && report.listed_ok == 0 {
        report.status = "failed".into();
    }
    report
}

/// Streaming local hashing and a bounded number of selected tasks (one task at a time for full mode).
pub async fn verify_sample(
    store: Arc<Store>,
    ops: Arc<dyn VerifyOps>,
    report: &mut VerifyReport,
    account: &str,
    sample_rate_ppm: u32,
    max_sample_bytes: u64,
) {
    let total = report.total_success;
    let n = sample_plan(total, sample_rate_ppm);
    report.sample_requested = n;
    if n == 0 {
        return;
    }
    for i in 0..n {
        let offset = (i as u128 * total as u128 / n as u128) as usize;
        let task = match store.task_page(account, Some(TaskState::Success), offset, 1) {
            Ok(mut v) if !v.is_empty() => v.remove(0),
            _ => {
                issue(&store, report, json!({"kind":"sample_store_error"}));
                continue;
            }
        };
        let Some(fid) = task.remote_fid.as_ref() else {
            issue(
                &store,
                report,
                json!({"kind":"sample_no_fid","rel_path":task.rel_path}),
            );
            continue;
        };
        let path = task.local_path.clone();
        let local =
            tokio::task::spawn_blocking(move || hash_file(std::path::Path::new(&path))).await;
        let local = match local {
            Ok(Ok(hash)) => hash,
            other => {
                issue(
                    &store,
                    report,
                    json!({"kind":"sample_local_error","rel_path":task.rel_path,"detail":format!("{other:?}")}),
                );
                continue;
            }
        };
        match ops.download_hash(fid, max_sample_bytes).await {
            Ok(hash) => {
                report.sample_checked += 1;
                if hash == local {
                    report.sample_ok += 1;
                } else {
                    report.sample_mismatch += 1;
                    issue(
                        &store,
                        report,
                        json!({"kind":"sample_hash_mismatch","rel_path":task.rel_path}),
                    );
                }
            }
            Err(e) => issue(
                &store,
                report,
                json!({"kind":"sample_download_error","rel_path":task.rel_path,"detail":e}),
            ),
        }
    }
    if report.sample_ok < n && report.status == "verified" {
        report.status = "partial".into();
    }
}

pub(crate) fn hash_file(path: &std::path::Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || crate::scanner::is_reparse(&meta) {
        return Err("哈希源不是普通文件".into());
    }
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buffer[..n]);
    }
    let after = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if after.len() != meta.len()
        || after.modified().ok() != meta.modified().ok()
        || crate::scanner::is_reparse(&after)
    {
        return Err("哈希期间源发生变化".into());
    }
    Ok(h.finalize().to_vec())
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
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = anyhow_lite::Result<Vec<RemoteEntry>, String>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                Ok(self
                    .tree
                    .lock()
                    .unwrap()
                    .get(fid)
                    .cloned()
                    .unwrap_or_default())
            })
        }
        fn download_bytes<'a>(
            &'a self,
            fid: &'a str,
            _max: u64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = anyhow_lite::Result<Vec<u8>, String>> + Send + 'a>,
        > {
            Box::pin(async move {
                self.blobs
                    .lock()
                    .unwrap()
                    .get(fid)
                    .cloned()
                    .ok_or_else(|| format!("no blob {fid}"))
            })
        }
    }

    fn entry(name: &str, fid: &str, size: u64) -> RemoteEntry {
        RemoteEntry {
            name: name.into(),
            fid: fid.into(),
            size,
            is_dir: false,
        }
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
                (
                    "t1".to_string(),
                    vec![
                        entry("a.txt", "rf-a.txt", 5),
                        RemoteEntry {
                            name: "sub".into(),
                            fid: "dir-sub".into(),
                            size: 0,
                            is_dir: true,
                        },
                    ],
                ),
                (
                    "dir-sub".to_string(),
                    vec![entry("b.txt", "rf-sub/b.txt", 6)],
                ),
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
            tree: Mutex::new(HashMap::from([(
                "t1".to_string(),
                vec![entry("a.txt", "rf", 99)],
            )])),
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
    #[tokio::test]
    async fn full_hash_really_checks_more_than_twenty_and_missing_download_cannot_pass() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("source");
        std::fs::create_dir(&root).unwrap();
        let store = Arc::new(Store::open(&dir.path().join("tasks.db")).unwrap());
        let mut entries = Vec::new();
        let mut blobs = HashMap::new();
        for i in 0..32 {
            let name = format!("f{i:02}.txt");
            let path = root.join(&name);
            std::fs::write(&path, b"body").unwrap();
            let fid = format!("fid-{i}");
            let task = crate::Task {
                account: "acc".into(),
                root_dir: root.to_string_lossy().into(),
                target_fid: "target".into(),
                rel_path: name.clone(),
                local_path: path.to_string_lossy().into(),
                size: 4,
                mtime_ms: 0,
                state: TaskState::Discovered,
                remote_fid: Some(fid.clone()),
                attempts: 0,
                last_error: None,
                chunk_progress: None,
                updated_at_ms: 0,
            };
            store.upsert_discovered(&[task.clone()]).unwrap();
            store.claim_batch("acc", 1).unwrap();
            store.transition(&task, TaskState::Uploading, None).unwrap();
            store.transition(&task, TaskState::Verifying, None).unwrap();
            store.transition(&task, TaskState::Success, None).unwrap();
            entries.push(entry(&name, &fid, 4));
            if i != 31 {
                blobs.insert(fid, b"body".to_vec());
            }
        }
        let ops = Arc::new(FakeVerify {
            tree: Mutex::new(HashMap::from([("target".into(), entries)])),
            blobs: Mutex::new(blobs),
        });
        let mut report = verify_manifest(store.clone(), ops.clone(), "acc", "target").await;
        assert_eq!(report.status, "verified");
        verify_sample(
            store.clone(),
            ops.clone(),
            &mut report,
            "acc",
            1_000_000,
            1024,
        )
        .await;
        assert_eq!(report.sample_requested, 32);
        assert_eq!(report.sample_ok, 31);
        assert_eq!(report.status, "partial");
        assert!(report
            .issues
            .iter()
            .any(|i| i["kind"] == "sample_download_error"));
        ops.blobs
            .lock()
            .unwrap()
            .insert("fid-31".into(), b"body".to_vec());
        let mut report = verify_manifest(store.clone(), ops.clone(), "acc", "target").await;
        verify_sample(store.clone(), ops, &mut report, "acc", 1_000_000, 1024).await;
        assert_eq!(report.sample_ok, 32);
        assert_eq!(report.status, "verified");
        store.add_issue("unreadable", "access denied").unwrap();
        let report = verify_manifest(
            store,
            Arc::new(FakeVerify {
                tree: Mutex::new(HashMap::new()),
                blobs: Mutex::new(HashMap::new()),
            }),
            "acc",
            "target",
        )
        .await;
        assert_ne!(report.status, "verified");
        assert_eq!(report.warning_count, 1);
    }
    #[tokio::test]
    async fn empty_success_set_with_unfinished_tasks_is_not_a_verified_backup() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("tasks.db")).unwrap());
        let task = crate::Task {
            account: "acc".into(),
            root_dir: "/source".into(),
            target_fid: "t".into(),
            rel_path: "pending".into(),
            local_path: "/source/pending".into(),
            size: 4,
            mtime_ms: 0,
            state: TaskState::Discovered,
            remote_fid: None,
            attempts: 0,
            last_error: None,
            chunk_progress: None,
            updated_at_ms: 0,
        };
        store.upsert_discovered(&[task]).unwrap();
        let ops = Arc::new(FakeVerify {
            tree: Mutex::new(HashMap::new()),
            blobs: Mutex::new(HashMap::new()),
        });
        let report = verify_manifest(store, ops, "acc", "t").await;
        assert_ne!(report.status, "verified");
        assert_eq!(report.incomplete, 1);
    }
}
