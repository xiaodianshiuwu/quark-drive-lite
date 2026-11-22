//! 调度器：水位背压 + 并发上传 + 退避重试。
//!
//! 背压语义（执行提示词 §5 要求"水位必须传达给扫描端"）：
//! - channel 容量 = 高水位（highWatermark，默认 1000）：扫描端 send 满即阻塞——
//!   这是 OS 级背压，扫描协程自动暂停，无需额外信号；
//! - 调度器消费后队列深度 < 低水位（lowWatermark，默认 500）时扫描端自然恢复；
//! - 水位与批次大小暴露给 UI（进度事件）。
//!
//! 上传并发默认 2（backupUploadConcurrency）。每个槽从 store claim 一批（1 条），
//! 全程：源变更检测 → 幂等建目录 → 上传 → 远端可见性核对 → 状态迁移。
//! 失败：指数退避（state::next_retry_delay_ms），超限 → failed 终态。

use crate::state::{next_retry_delay_ms, TaskState};
use crate::store::{Store, Task};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 可调配置（settings 新键，默认值对齐执行提示词）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupConfig {
    /// 每批发现条数
    #[serde(default = "d_batch")]
    #[serde(alias = "discovery_batch_size")]
    pub discovery_batch_size: usize,
    /// 队列高水位（channel 容量，扫描端阻塞点）
    #[serde(default = "d_high")]
    #[serde(alias = "high_watermark")]
    pub high_watermark: usize,
    /// 队列低水位（恢复点，仅用于展示/日志）
    #[serde(default = "d_low")]
    #[serde(alias = "low_watermark")]
    pub low_watermark: usize,
    /// 上传并发
    #[serde(default = "d_conc")]
    #[serde(alias = "upload_concurrency")]
    pub upload_concurrency: usize,
    /// 重试基础延迟 ms
    #[serde(default = "d_retry_base")]
    #[serde(alias = "retry_base_ms")]
    pub retry_base_ms: u64,
    /// Shared backup upload bandwidth budget, 0 means unlimited (bytes/second).
    #[serde(default, alias = "bandwidth_limit_bps")]
    pub bandwidth_limit_bps: u64,
    /// 最大重试次数
    #[serde(default = "d_retry_max")]
    #[serde(alias = "max_attempts")]
    pub max_attempts: u32,
}

fn d_batch() -> usize {
    500
}
fn d_high() -> usize {
    1000
}
fn d_low() -> usize {
    500
}
fn d_conc() -> usize {
    2
}
fn d_retry_base() -> u64 {
    30_000
}
fn d_retry_max() -> u32 {
    6
}

impl Default for BackupConfig {
    fn default() -> Self {
        serde_json::from_value(json!({})).unwrap()
    }
}

impl BackupConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=5000).contains(&self.discovery_batch_size)
            || self.high_watermark < self.discovery_batch_size
            || self.high_watermark > 100_000
            || self.low_watermark >= self.high_watermark
            || !(1..=8).contains(&self.upload_concurrency)
            || (self.bandwidth_limit_bps != 0
                && !(1024..=1_099_511_627_776).contains(&self.bandwidth_limit_bps))
            || !(1..=3_600_000).contains(&self.retry_base_ms)
            || !(1..=20).contains(&self.max_attempts)
        {
            return Err("备份配置越界：批次1..5000、高水位不小于批次且最多100000、低水位小于高水位、并发1..8、重试1..20".into());
        }
        Ok(())
    }
}

/// 远端能力桥（由宿主注入；测试用假实现）。
pub trait RemoteOps: Send + Sync {
    fn recover_uploaded<'a>(
        &'a self,
        _task: &'a Task,
        _parent: &'a str,
        _fid: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, String>> + Send + 'a>>
    {
        Box::pin(async { Ok(false) })
    }
    fn acknowledge<'a>(
        &'a self,
        _path: &'a str,
        _parent: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }
    /// Stop only transfers owned by this backup; preserve their checkpoints.
    fn pause_active(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async { Ok(()) })
    }

    /// 幂等建立目录（rel_path 相对 target_fid），返回 fid。已存在直接返回。
    fn ensure_dir<'a>(
        &'a self,
        target_fid: &'a str,
        rel_path: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow_lite::Result<String, String>> + Send + 'a>,
    >;
    /// 上传单文件到目录 fid（名字取 basename），返回远端 fid。
    fn upload_file<'a>(
        &'a self,
        local_path: &'a str,
        parent_fid: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow_lite::Result<String, String>> + Send + 'a>,
    >;
    /// 远端目录中是否存在同名文件（可见性核对）。
    fn file_visible<'a>(
        &'a self,
        parent_fid: &'a str,
        name: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = anyhow_lite::Result<Option<String>, String>>
                + Send
                + 'a,
        >,
    >;
}

/// 简化 Result 别名（不引入 anyhow，保持零额外依赖）。
pub mod anyhow_lite {
    pub type Result<T, E> = std::result::Result<T, E>;
}

/// 调度器统计快照。
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct SchedulerStats {
    pub queue_depth: i64,
    pub success: i64,
    pub failed: i64,
    pub skipped: i64,
    pub uploaded_bytes: u64,
    pub active_workers: i64,
    pub error: Option<String>,
}

/// 运行一次"取任务→上传→核对"的单槽循环，直到 store 无 pending。
/// 由宿主按 upload_concurrency spawn 多个；扫描端独立协程持续发现。
pub async fn worker_loop(
    store: Arc<Store>,
    remote: Arc<dyn RemoteOps>,
    cfg: BackupConfig,
    account: String,
    stats_bytes: Arc<AtomicU64>,
    stop: tokio::sync::watch::Receiver<bool>,
) -> SchedulerStats {
    worker_loop_controlled(
        store,
        remote,
        cfg,
        account,
        stats_bytes,
        stop,
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        false,
    )
    .await
}

pub(crate) async fn worker_loop_controlled(
    store: Arc<Store>,
    remote: Arc<dyn RemoteOps>,
    cfg: BackupConfig,
    account: String,
    stats_bytes: Arc<AtomicU64>,
    mut stop: tokio::sync::watch::Receiver<bool>,
    scan_done: Arc<std::sync::atomic::AtomicBool>,
    paused: Arc<std::sync::atomic::AtomicBool>,
    keep_alive: bool,
) -> SchedulerStats {
    let mut stats = SchedulerStats::default();
    loop {
        if *stop.borrow() {
            break;
        }
        if paused.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let claimed = match store.claim_batch(&account, 1) {
            Ok(v) => v,
            Err(e) => {
                stats.error = Some(e.to_string());
                break;
            }
        };
        let Some(task) = claimed.into_iter().next() else {
            // 无 pending：如果 discovered 也为 0 且扫描结束，退出；否则等一下再试
            tokio::time::sleep(Duration::from_millis(200)).await;
            let c = store.counts(&account).unwrap_or_default();
            let remaining =
                c.get("pending").copied().unwrap_or(0) + c.get("discovered").copied().unwrap_or(0);
            if remaining == 0 && scan_done.load(Ordering::Acquire) && !keep_alive {
                break;
            }
            continue;
        };
        stats.active_workers += 1;
        let result = tokio::select! {
            result=process_one(&store,&*remote,&cfg,&task)=>result,
            _=stop.changed()=>{
                let current=store.get_task(&task).unwrap_or_else(|_|task.clone());
                let _=store.transition(&current,TaskState::Pending,Some("备份已停止，可恢复"));
                break;
            }
        };
        // process_one may have persisted the remote fid before a verification failure.
        let task = store.get_task(&task).unwrap_or(task);
        stats.active_workers -= 1;
        match result {
            Ok(()) => {
                stats.success += 1;
                stats.uploaded_bytes += task.size;
                stats_bytes.fetch_add(task.size, Ordering::Relaxed);
            }
            Err(Fail::Skipped(reason)) => {
                stats.skipped += 1;
                let _ = store.transition(&task, TaskState::Skipped, Some(&reason));
            }
            Err(Fail::Retryable(err)) => {
                let attempts = task.attempts + 1;
                let mut t2 = task.clone();
                t2.attempts = attempts;
                if let Some(delay_ms) =
                    next_retry_delay_ms(attempts, cfg.retry_base_ms, cfg.max_attempts)
                {
                    // 回到 pending：退避窗写入库（next_retry_at_ms），其他 worker 的 claim
                    // 在窗口到期前不会认领——避免多 worker 全速重试耗尽 attempts（重试风暴）。
                    let retry_at = (std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64)
                        + delay_ms as i64;
                    let _ = store.transition_with_retry_at(
                        &t2,
                        TaskState::Pending,
                        Some(&err),
                        retry_at,
                    );
                } else {
                    let _ = store.transition(&t2, TaskState::Failed, Some(&err));
                    stats.failed += 1;
                    if keep_alive {
                        paused.store(true, Ordering::Release);
                        let _ = remote.pause_active().await;
                    }
                }
            }
            Err(Fail::Paused) => {
                let _ = store.transition(&task, TaskState::Pending, None);
            }
            Err(Fail::Fatal(err)) => {
                stats.failed += 1;
                let _ = store.transition(&task, TaskState::Failed, Some(&err));
                if keep_alive {
                    paused.store(true, Ordering::Release);
                    let _ = remote.pause_active().await;
                }
            }
        }
    }
    stats.queue_depth = store.queue_depth(&account).unwrap_or(0);
    let c = store.counts(&account).unwrap_or_default();
    stats.success = c.get("success").copied().unwrap_or(0);
    stats.failed = c.get("failed").copied().unwrap_or(0);
    stats.skipped = c.get("skipped").copied().unwrap_or(0);
    stats
}

/// 单任务处理结果。
pub(crate) enum Fail {
    Skipped(String),
    Retryable(String),
    Fatal(String),
    Paused,
}

/// 文件名（本地路径 → basename）。
fn base_name(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

async fn process_one(
    store: &Store,
    remote: &dyn RemoteOps,
    _cfg: &BackupConfig,
    task: &Task,
) -> std::result::Result<(), Fail> {
    // 1) 源变更检测：上传前重 stat，与发现时不一致 → 重新发现（mtime/size 变了）
    let meta = match tokio::fs::symlink_metadata(&task.local_path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Fail::Skipped(format!("源文件已消失：{}", task.local_path)));
        }
        Err(e) => return Err(Fail::Retryable(format!("源文件不可读：{e}"))),
    };
    let resolved = tokio::fs::canonicalize(&task.local_path)
        .await
        .map_err(|e| Fail::Fatal(e.to_string()))?;
    let root = tokio::fs::canonicalize(&task.root_dir)
        .await
        .map_err(|e| Fail::Fatal(e.to_string()))?;
    if !meta.is_file() || crate::scanner::is_reparse(&meta) || !resolved.starts_with(&root) {
        return Err(Fail::Fatal(
            "源路径已变为链接、重解析点或越出所选目录".into(),
        ));
    }
    let now_mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if meta.len() != task.size || now_mtime != task.mtime_ms {
        store
            .refresh_source(task, meta.len(), now_mtime)
            .map_err(|e| Fail::Fatal(e.to_string()))?;
        return Err(Fail::Retryable(format!(
            "源文件自发现后已变化（size {}/{}，mtime {}/{}），重新入队",
            task.size,
            meta.len(),
            task.mtime_ms,
            now_mtime
        )));
    }

    // 2) 幂等建目录（relPath 的父链；缓存命中直接用）
    let parent_rel = match task.rel_path.rsplit_once('/') {
        Some((p, _)) => p.to_string(),
        None => String::new(),
    };
    let parent_fid =
        ensure_dir_chain(store, remote, &task.account, &task.target_fid, &parent_rel).await?;

    // 3) 冲突预检：远端同名可见且核对策略为 skip → skipped:conflict（默认不覆盖）
    let name = base_name(&task.local_path);
    if name.is_empty() {
        return Err(Fail::Fatal("本地路径无文件名".into()));
    }
    if let Some(existing) = remote
        .file_visible(&parent_fid, &name)
        .await
        .map_err(Fail::Retryable)?
    {
        if Some(existing.as_str()) != task.remote_fid.as_deref()
            && !remote
                .recover_uploaded(task, &parent_fid, &existing)
                .await
                .map_err(Fail::Retryable)?
        {
            return Err(Fail::Skipped(format!(
                "远端已存在同名文件（fid {existing}），按默认策略不覆盖；未证明其内容与本地一致"
            )));
        }
        // An acknowledged upload was persisted before verification/restart. Reconcile it;
        // never upload the same path again just because the last visibility check failed.
        let mut recovered = task.clone();
        recovered.remote_fid = Some(existing);
        store
            .transition(&recovered, TaskState::Uploading, None)
            .map_err(|e| Fail::Fatal(e.to_string()))?;
        store
            .transition(&recovered, TaskState::Verifying, None)
            .map_err(|e| Fail::Fatal(e.to_string()))?;
        store
            .transition(&recovered, TaskState::Success, None)
            .map_err(|e| Fail::Fatal(e.to_string()))?;
        let _ = remote.acknowledge(&task.local_path, &parent_fid).await;
        return Ok(());
    }

    // 4) pending → uploading
    let mut t2 = task.clone();
    store
        .transition(task, TaskState::Uploading, None)
        .map_err(|e| Fail::Fatal(e.to_string()))?;

    // 5) 上传
    let remote_fid = remote
        .upload_file(&task.local_path, &parent_fid)
        .await
        .map_err(|e| {
            if e == "BACKUP_PAUSED" {
                Fail::Paused
            } else {
                Fail::Retryable(e)
            }
        })?;

    // 6) verifying：远端可见性核对
    t2.remote_fid = Some(remote_fid.clone());
    store
        .transition(&t2, TaskState::Verifying, None)
        .map_err(|e| Fail::Fatal(e.to_string()))?;
    let after = tokio::fs::symlink_metadata(&task.local_path)
        .await
        .map_err(|e| Fail::Fatal(format!("上传后源不可读：{e}")))?;
    if crate::scanner::is_reparse(&after)
        || !after.is_file()
        || after.len() != task.size
        || crate::scanner::mtime_ms(&after) != task.mtime_ms
    {
        return Err(Fail::Fatal(
            "上传期间源文件发生变化：保留云端成果并停止此项，请重新核对".into(),
        ));
    }
    match remote.file_visible(&parent_fid, &name).await {
        Ok(Some(fid)) if fid == remote_fid => {
            t2.remote_fid = Some(fid);
            store
                .transition(&t2, TaskState::Success, None)
                .map_err(|e| Fail::Fatal(e.to_string()))?;
            let _ = remote.acknowledge(&task.local_path, &parent_fid).await;
            Ok(())
        }
        Ok(_) => Err(Fail::Retryable(format!(
            "上传后远端核对未通过（期望 fid {remote_fid}），稍后重试"
        ))),
        Err(e) => Err(Fail::Retryable(format!("远端核对失败：{e}"))),
    }
}

/// 确保父目录链存在（空 rel = target 本身）。逐级 ensure_dir 并缓存。
pub(crate) async fn ensure_dir_chain(
    store: &Store,
    remote: &dyn RemoteOps,
    account: &str,
    target_fid: &str,
    rel: &str,
) -> std::result::Result<String, Fail> {
    if rel.is_empty() {
        return Ok(target_fid.to_string());
    }
    let _directory_guard = store.directory_lock.lock().await;
    // 缓存命中（按任务真实 account 记账，verify 同键可查）
    if let Some(fid) = store
        .get_dir(account, target_fid, rel)
        .map_err(|e| Fail::Fatal(e.to_string()))?
    {
        return Ok(fid);
    }
    // 逐级
    let parts: Vec<&str> = rel.split('/').collect();
    let mut cur = target_fid.to_string();
    let mut acc = String::new();
    for part in parts {
        acc = if acc.is_empty() {
            part.to_string()
        } else {
            format!("{acc}/{part}")
        };
        if let Some(fid) = store
            .get_dir(account, target_fid, &acc)
            .map_err(|e| Fail::Fatal(e.to_string()))?
        {
            cur = fid;
            continue;
        }
        let fid = remote
            .ensure_dir(&cur, part)
            .await
            .map_err(|e| Fail::Retryable(format!("建立目录 {acc} 失败：{e}")))?;
        store
            .put_dir(account, target_fid, &acc, &fid)
            .map_err(|e| Fail::Fatal(e.to_string()))?;
        cur = fid;
    }
    Ok(cur)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// 假远端：内存目录树 + 上传成功/失败注入。
    struct FakeRemote {
        dirs: Mutex<HashMap<String, String>>,  // (target|rel) -> fid
        files: Mutex<HashMap<String, String>>, // (parent|name) -> fid
        fail_uploads: AtomicU64,               // 前 N 次上传失败（测退避）
        uploads: AtomicU64,
    }

    impl FakeRemote {
        fn new() -> Self {
            Self {
                dirs: Mutex::new(HashMap::new()),
                files: Mutex::new(HashMap::new()),
                fail_uploads: AtomicU64::new(0),
                uploads: AtomicU64::new(0),
            }
        }
    }

    impl RemoteOps for FakeRemote {
        fn ensure_dir<'a>(
            &'a self,
            target_fid: &'a str,
            rel_path: &'a str,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = anyhow_lite::Result<String, String>> + Send + 'a>,
        > {
            Box::pin(async move {
                let key = format!("{target_fid}|{rel_path}");
                let mut d = self.dirs.lock().unwrap();
                Ok(d.entry(key)
                    .or_insert_with(|| format!("dir-{}", rel_path.replace('/', "_")))
                    .clone())
            })
        }

        fn upload_file<'a>(
            &'a self,
            local_path: &'a str,
            parent_fid: &'a str,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = anyhow_lite::Result<String, String>> + Send + 'a>,
        > {
            Box::pin(async move {
                // 计数在入口：失败尝试也算"上传尝试"（退避验证依赖）
                let n = self.uploads.fetch_add(1, Ordering::SeqCst);
                if self.fail_uploads.load(Ordering::SeqCst) > 0 {
                    self.fail_uploads.fetch_sub(1, Ordering::SeqCst);
                    return Err("模拟网络错误".into());
                }
                let name = std::path::Path::new(local_path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let key = format!("{parent_fid}|{name}");
                self.files.lock().unwrap().insert(key, format!("fid-{n}"));
                Ok(format!("fid-{n}"))
            })
        }

        fn file_visible<'a>(
            &'a self,
            parent_fid: &'a str,
            name: &'a str,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = anyhow_lite::Result<Option<String>, String>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                let key = format!("{parent_fid}|{name}");
                Ok(self.files.lock().unwrap().get(&key).cloned())
            })
        }
    }

    fn mk_task(rel: &str, content: &[u8], root: &std::path::Path) -> Task {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        let meta = std::fs::metadata(&p).unwrap();
        Task {
            account: "acc1".into(),
            root_dir: root.to_string_lossy().to_string(),
            target_fid: "root1".into(),
            rel_path: rel.into(),
            local_path: p.to_string_lossy().to_string(),
            size: meta.len(),
            mtime_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            state: TaskState::Discovered,
            remote_fid: None,
            attempts: 0,
            last_error: None,
            chunk_progress: None,
            updated_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn full_pipeline_success_with_dirs_and_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("t.db")).unwrap());
        let remote = Arc::new(FakeRemote::new());
        let root = dir.path().join("data");
        // 预置远端同名冲突（对 b.txt）
        // 预置远端同名（sub 目录已由 store 缓存映射到 dir-sub，上传前用 dir-sub 查可见性）
        remote
            .files
            .lock()
            .unwrap()
            .insert("dir-sub|b.txt".into(), "fid-existing".into());

        let tasks = vec![
            mk_task("a.txt", b"alpha", &root),
            mk_task("sub/b.txt", b"beta", &root),
            mk_task("中文/图 片.png", b"img", &root),
        ];
        store.upsert_discovered(&tasks).unwrap();
        store.put_dir("acc1", "root1", "sub", "dir-sub").unwrap();

        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let cfg = BackupConfig {
            retry_base_ms: 1,
            max_attempts: 1,
            ..Default::default()
        };
        let bytes = Arc::new(AtomicU64::new(0));
        let st = worker_loop(
            store.clone(),
            remote.clone(),
            cfg,
            "acc1".into(),
            bytes.clone(),
            stop_rx,
        )
        .await;
        let _ = stop_tx.send(true);

        // a.txt 成功；b.txt 冲突跳过（远端 dir-sub 已有同名）；中文目录自动建立
        assert_eq!(st.success, 2, "a.txt + 中文/图 片.png: got {st:?}");
        assert_eq!(st.skipped, 1, "b.txt 冲突");
        assert_eq!(st.failed, 0);
        assert!(bytes.load(Ordering::Relaxed) >= 8);
        // 目录映射已建：sub 命中缓存；中文 由 ensure_dir 建立
        assert_eq!(
            store.get_dir("acc1", "root1", "中文").unwrap().as_deref(),
            Some("dir-中文")
        );
    }

    #[tokio::test]
    async fn source_mutation_requeues_and_retry_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("t.db")).unwrap());
        let remote = Arc::new(FakeRemote::new());
        let root = dir.path().join("data");
        let t = mk_task("m.txt", b"v1", &root);
        store.upsert_discovered(&[t.clone()]).unwrap();

        // 注入 1 次失败（退避 1ms 重试后成功）
        remote.fail_uploads.store(1, Ordering::SeqCst);
        let cfg = BackupConfig {
            retry_base_ms: 1,
            max_attempts: 3,
            ..Default::default()
        };
        let (_stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let bytes = Arc::new(AtomicU64::new(0));
        let st = worker_loop(
            store.clone(),
            remote.clone(),
            cfg,
            "acc1".into(),
            bytes,
            stop_rx,
        )
        .await;
        assert_eq!(st.success, 1, "失败后退避重试成功");
        assert_eq!(st.failed, 0);
        let ups = remote.uploads.load(Ordering::SeqCst);
        assert!(ups >= 2, "至少 2 次上传尝试，实际 {ups}; st={st:?}");

        // 源变更：上传前 stat 与发现不一致 → skipped（源已变，重新发现而非盲传）
        let t2 = mk_task("changed.txt", b"v1", &root);
        store.upsert_discovered(&[t2.clone()]).unwrap();
        std::fs::write(&t2.local_path, b"v2-longer").unwrap();
        let cfg2 = BackupConfig {
            retry_base_ms: 1,
            max_attempts: 1,
            ..Default::default()
        };
        let (_s2, rx2) = tokio::sync::watch::channel(false);
        let st2 = worker_loop(
            store.clone(),
            remote.clone(),
            cfg2,
            "acc1".into(),
            Arc::new(AtomicU64::new(0)),
            rx2,
        )
        .await;
        assert_eq!(
            st2.failed, 1,
            "源变更重试耗尽后如实 failed（内容以最后一次发现为准）"
        );
        let c = store.counts("acc1").unwrap();
        // 源变更走 Retryable → attempts=1 >= max=1 → failed 终态（错误信息里可读出"已变化"）
        assert_eq!(
            c.get("failed").copied().unwrap_or(0),
            1,
            "源变更重试耗尽后 failed"
        );
    }

    #[tokio::test]
    async fn vanished_source_is_skipped_not_failed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("t.db")).unwrap());
        let remote = Arc::new(FakeRemote::new());
        let root = dir.path().join("data");
        let t = mk_task("gone.txt", b"x", &root);
        std::fs::remove_file(&t.local_path).unwrap(); // 发现后消失
        store.upsert_discovered(&[t]).unwrap();
        let cfg = BackupConfig::default();
        let (_s, rx) = tokio::sync::watch::channel(false);
        let st = worker_loop(
            store.clone(),
            remote,
            cfg,
            "acc1".into(),
            Arc::new(AtomicU64::new(0)),
            rx,
        )
        .await;
        assert_eq!(st.skipped, 1, "源消失是 skipped 而非 failed");
        assert_eq!(st.failed, 0);
    }
}
