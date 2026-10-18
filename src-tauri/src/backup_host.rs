//! Phase-2：Windows 重装前海量文件批量上传（夸克备份）宿主接线。
//!
//! backup.* 命令组（qk_call 分发）：
//! - backup.plan：预览扫描（dry-run，不建任务，返回统计与示例条目）
//! - backup.start：启动（扫描协程 + 上传 worker 池；幂等：同 account+rootDir 已在跑则拒绝）
//! - backup.status：进度/水位/各状态计数
//! - backup.retry：failed 全部重试
//! - backup.cancel：停止扫描与上传（任务保留现场）
//! - backup.verify：清单核对 + 抽样下载比对
//!
//! 实现约束（对齐 Phase-2 计划）：
//! - 备份运行期对象存于 AppState（进程内）；任务库 SQLite 在资料目录 backup/<hash>.db；
//! - 上传走 quark-transfer 的 Core（HTTP 层复用），不经 TransferManager 任务队列（10 万级
//!   任务不与 GUI 传输列表混合）；
//! - Windows named-pipe 网关缺失不影响备份（备份不走 Agent 网关）。

use quark_backup::{BackupConfig, RemoteOps, TaskState};
use quark_core::Core;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, watch, Mutex as AsyncMutex};

/// 真实远端操作（首版）：全部经 Core 的 fs.*（mkdir/list/info），
/// 上传经 TransferManager 单文件入队 → 轮询终态 → clear。
/// 权衡如实记录：任务短暂出现在 GUI 传输列表（每文件一条，完成即清理）；
/// Scheduler 控制并发（backup worker 数限制实际并发度）。
/// 后续优化：把 quark-transfer/src/upload.rs 核心提为独立入口，绕开任务队列。
pub struct CoreRemote {
    core: Core,
    transfers: quark_transfer::TransferManager,
}

impl CoreRemote {
    pub fn new(core: Core, transfers: quark_transfer::TransferManager) -> Self {
        Self { core, transfers }
    }

    /// 等待单个传输任务到终态；返回 (status, error)。
    async fn wait_task(&self, id: &str, timeout_ms: u64) -> Result<(String, Option<String>), String> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let tasks = self
                .transfers
                .call("transfer.list", Value::Null)
                .await
                .map_err(|e| e.message)?;
            if let Some(arr) = tasks.as_array() {
                if let Some(t) = arr.iter().find(|t| t["id"] == json!(id)) {
                    let st = t["status"].as_str().unwrap_or("").to_string();
                    if ["done", "error", "canceled"].contains(&st.as_str()) {
                        let err = t["error"].as_str().map(|s| s.to_string());
                        let _ = self.transfers.call("transfer.clear", json!([id])).await;
                        return Ok((st, err));
                    }
                }
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = self.transfers.call("transfer.cancel", json!(id)).await;
                let _ = self.transfers.call("transfer.clear", json!([id])).await;
                return Err("上传等待超时".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }

    async fn list_children(&self, parent_fid: &str) -> Result<Value, String> {
        self.core
            .call("fs.list", json!({"pdirFid": parent_fid, "page": 1, "size": 200}))
            .await
            .map_err(|e| e.message)
    }
}

impl RemoteOps for CoreRemote {
    fn ensure_dir<'a>(
        &'a self,
        target_fid: &'a str,
        rel_path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            // 全链创建：逐段 list 确认（幂等）→ mkdir → 轮询拿 fid
            let mut cur = target_fid.to_string();
            let mut acc = String::new();
            for seg in rel_path.split('/') {
                acc = if acc.is_empty() { seg.to_string() } else { format!("{acc}/{seg}") };
                let listed = self.list_children(&cur).await?;
                let mut found: Option<String> = None;
                if let Some(items) = listed["list"].as_array() {
                    for x in items {
                        if x["dir"] == json!(true) && x["name"] == json!(seg) {
                            found = x["fid"].as_str().map(|s| s.to_string());
                            break;
                        }
                    }
                }
                if let Some(fid) = found {
                    cur = fid;
                    continue;
                }
                let _ = self
                    .core
                    .call("fs.mkdir", json!({"pdirFid": cur, "name": seg}))
                    .await
                    .map_err(|e| e.message)?;
                let mut new_fid = None;
                for _ in 0..30 {
                    let listed = self.list_children(&cur).await?;
                    if let Some(items) = listed["list"].as_array() {
                        for x in items {
                            if x["dir"] == json!(true) && x["name"] == json!(seg) {
                                new_fid = x["fid"].as_str().map(|s| s.to_string());
                                break;
                            }
                        }
                    }
                    if new_fid.is_some() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
                cur = new_fid.ok_or_else(|| format!("目录 {seg} 创建后未确认 fid"))?;
            }
            Ok(cur)
        })
    }

    fn upload_file<'a>(
        &'a self,
        local_path: &'a str,
        parent_fid: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            let ids = self
                .transfers
                .call("transfer.upload", json!({"localPaths": [local_path], "pdirFid": parent_fid}))
                .await
                .map_err(|e| e.message)?;
            let id = ids
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .ok_or_else(|| "上传入队失败".to_string())?
                .to_string();
            let (st, err) = self.wait_task(&id, 600_000).await?;
            if st != "done" {
                return Err(err.unwrap_or_else(|| format!("上传失败（{st}）")));
            }
            let name = std::path::Path::new(local_path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let listed = self.list_children(parent_fid).await?;
            if let Some(items) = listed["list"].as_array() {
                for x in items {
                    if x["dir"] == json!(false) && x["name"] == json!(name) {
                        if let Some(f) = x["fid"].as_str() {
                            return Ok(f.to_string());
                        }
                    }
                }
            }
            Err("上传完成后未在目录中确认文件".into())
        })
    }

    fn file_visible<'a>(
        &'a self,
        parent_fid: &'a str,
        name: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>, String>> + Send + 'a>> {
        Box::pin(async move {
            let listed = self.list_children(parent_fid).await?;
            if let Some(items) = listed["list"].as_array() {
                for x in items {
                    if x["dir"] == json!(false) && x["name"] == json!(name) {
                        return Ok(x["fid"].as_str().map(|s| s.to_string()));
                    }
                }
            }
            Ok(None)
        })
    }
}

/// 运行中的备份会话。
pub struct BackupSession {
    pub account: String,
    pub root_dir: PathBuf,
    pub target_fid: String,
    pub store: Arc<quark_backup::Store>,
    pub stop_tx: watch::Sender<bool>,
    #[allow(dead_code)]
    pub scan_joined: Arc<AtomicBool>,
    pub started_at: u64,
    pub uploaded_bytes: Arc<AtomicU64>,
}

#[derive(Clone, Default)]
pub struct BackupManager {
    /// 单会话（同一时刻一个备份任务；多会话 UI 复杂度过高，后续按需扩展）
    pub session: Arc<AsyncMutex<Option<Arc<BackupSession>>>>,
}

impl BackupManager {
    /// backup.plan：只扫描不入库，返回统计与每类示例。
    pub async fn plan(_core: Core, root_dir: String, target_fid: String) -> Result<Value, quark_core::Error> {
        let cfg = quark_backup::scanner::ScanConfig {
            account: String::new(),
            root_dir: PathBuf::from(&root_dir),
            target_fid,
            batch_size: 500,
        };
        let (tx, mut rx) = mpsc::channel::<Vec<quark_backup::scanner::ScanItem>>(64);
        let handle = tokio::task::spawn_blocking(move || quark_backup::scanner::scan(&cfg, tx));
        let mut files = 0u64;
        let mut dirs = 0u64;
        let mut warnings = 0u64;
        let mut total_bytes = 0u64;
        let mut samples: Vec<Value> = Vec::new();
        while let Some(batch) = rx.recv().await {
            for it in batch {
                match it {
                    quark_backup::scanner::ScanItem::File(t) => {
                        files += 1;
                        total_bytes += t.size;
                        if samples.len() < 5 {
                            samples.push(json!({
                                "relPath": t.rel_path, "size": t.size, "mtimeMs": t.mtime_ms,
                            }));
                        }
                    }
                    quark_backup::scanner::ScanItem::Dir(_) => dirs += 1,
                    quark_backup::scanner::ScanItem::Warning { rel_path, message } => {
                        warnings += 1;
                        if samples.len() < 10 {
                            samples.push(json!({"warning": rel_path, "detail": message}));
                        }
                    }
                }
            }
        }
        let stats = handle
            .await
            .map_err(|e| quark_core::Error::new("SYSTEM", e.to_string()))?
            .map_err(|e| quark_core::Error::new("BACKUP_SCAN", e.to_string()))?;
        Ok(json!({
            "files": files,
            "dirs": dirs,
            "warnings": warnings,
            "totalBytes": total_bytes,
            "samples": samples,
            "scanStats": { "files": stats.files, "dirs": stats.dirs, "batches": stats.batches },
        }))
    }

    /// backup.start：开库 → spawn 扫描 → spawn worker 池。
    pub async fn start(
        &self,
        core: Core,
        transfers: quark_transfer::TransferManager,
        account: String,
        root_dir: String,
        target_fid: String,
        profile_dir: PathBuf,
        cfg_patch: Value,
    ) -> Result<Value, quark_core::Error> {
        let mut guard = self.session.lock().await;
        if guard.is_some() {
            return Err(quark_core::Error::new("CONFLICT", "已有备份任务在运行，请先取消"));
        }
        std::fs::create_dir_all(profile_dir.join("backup"))
            .map_err(|e| quark_core::Error::new("SYSTEM", e.to_string()))?;
        // 库文件名：rootDir 哈希前 12 位（同目录续扫复用同一任务库 = 增量）
        let mut h = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&root_dir, &mut h);
        let db = profile_dir
            .join("backup")
            .join(format!("bk{:016x}.db", std::hash::Hasher::finish(&h)));
        let store = Arc::new(
            quark_backup::Store::open(&db).map_err(|e| quark_core::Error::new("SYSTEM", e.to_string()))?,
        );
        let cfg: BackupConfig = if cfg_patch.is_null() {
            BackupConfig::default()
        } else {
            serde_json::from_value(cfg_patch)
                .map_err(|e| quark_core::Error::new("INVALID_ARG", format!("backup 配置无效：{e}")))?
        };
        let (stop_tx, stop_rx) = watch::channel(false);
        let uploaded = Arc::new(AtomicU64::new(0));

        // 扫描协程（spawn_blocking）+ worker 池
        let scan_cfg = quark_backup::scanner::ScanConfig {
            account: account.clone(),
            root_dir: PathBuf::from(&root_dir),
            target_fid: target_fid.clone(),
            batch_size: cfg.discovery_batch_size,
        };
        let (tx, mut rx) = mpsc::channel::<Vec<quark_backup::scanner::ScanItem>>(cfg.high_watermark);
        // 消费循环：批次入库（upsert 幂等）；channel 满时扫描端阻塞 = 背压
        {
            let store_up = store.clone();
            tokio::spawn(async move {
                while let Some(batch) = rx.recv().await {
                    let tasks: Vec<quark_backup::Task> = batch
                        .into_iter()
                        .filter_map(|it| match it {
                            quark_backup::scanner::ScanItem::File(t) => Some(t),
                            _ => None,
                        })
                        .collect();
                    if !tasks.is_empty() {
                        let _ = store_up.upsert_discovered(&tasks);
                    }
                }
            });
        }
        // 扫描协程（阻塞线程池）
        let scan_store = store.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(e) = quark_backup::scanner::scan(&scan_cfg, tx) {
                eprintln!("[backup] 扫描终止：{e}");
            }
            let _ = scan_store;
        });

        // worker 池：真实远端 = Core fs.*（首版：mkdir/list/上传均经 Core 直调——
        // 上传的文件字节走 Core 的 upload 原语；为控制 Phase-2 范围，首版 RemoteOps
        // 实现用 Core 的 fs.* + transfer 核心接口，见 build_core_ops）
        let ops = build_core_ops(core.clone(), transfers);
        let n_workers = cfg.upload_concurrency.clamp(1, 8);
        for _ in 0..n_workers {
            let store_w = store.clone();
            let ops_w = ops.clone();
            let cfg_w = cfg.clone();
            let acc_w = account.clone();
            let bytes_w = uploaded.clone();
            let stop_w = stop_rx.clone();
            tokio::spawn(async move {
                quark_backup::worker_loop(store_w, ops_w, cfg_w, acc_w, bytes_w, stop_w).await;
            });
        }
        let session = Arc::new(BackupSession {
            account: account.clone(),
            root_dir: PathBuf::from(&root_dir),
            target_fid,
            store,
            stop_tx,
            scan_joined: Arc::new(AtomicBool::new(false)),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            uploaded_bytes: uploaded,
        });
        *guard = Some(session);
        Ok(self.status_inner(&mut guard).await)
    }

    /// backup.status。
    pub async fn status(&self) -> Value {
        let mut guard = self.session.lock().await;
        self.status_inner(&mut guard).await
    }

    async fn status_inner(&self, guard: &mut Option<Arc<BackupSession>>) -> Value {
        let Some(s) = guard.as_ref() else {
            return json!({ "running": false });
        };
        let counts = s.store.counts(&s.account).unwrap_or_default();
        let get = |k: &str| counts.get(k).copied().unwrap_or(0);
        json!({
            "running": true,
            "account": s.account,
            "rootDir": s.root_dir.to_string_lossy(),
            "targetFid": s.target_fid,
            "startedAt": s.started_at,
            "queueDepth": s.store.queue_depth(&s.account).unwrap_or(0),
            "discovered": get("discovered"),
            "pending": get("pending"),
            "uploading": get("uploading"),
            "verifying": get("verifying"),
            "success": get("success"),
            "failed": get("failed"),
            "skipped": get("skipped"),
            "canceled": get("canceled"),
            "uploadedBytes": s.uploaded_bytes.load(Ordering::Relaxed),
        })
    }

    /// backup.retry：failed → pending（全部）。
    pub async fn retry_failed(&self) -> Result<Value, quark_core::Error> {
        let guard = self.session.lock().await;
        let Some(s) = guard.as_ref() else {
            return Err(quark_core::Error::new("CONFLICT", "没有运行中的备份任务"));
        };
        let failed = s
            .store
            .all_in_state(&s.account, TaskState::Failed)
            .map_err(|e| quark_core::Error::new("SYSTEM", e.to_string()))?;
        let mut n = 0usize;
        for t in &failed {
            let mut t2 = t.clone();
            t2.attempts = 0; // 手动重试重置退避
            if s.store.transition(&t2, TaskState::Pending, None).is_ok() {
                n += 1;
            }
        }
        Ok(json!({ "requeued": n }))
    }

    /// backup.cancel：停扫描与 worker（任务现场保留）。
    pub async fn cancel(&self) -> Result<Value, quark_core::Error> {
        let mut guard = self.session.lock().await;
        let Some(s) = guard.as_ref() else {
            return Err(quark_core::Error::new("CONFLICT", "没有运行中的备份任务"));
        };
        let _ = s.stop_tx.send(true);
        *guard = None;
        Ok(json!({ "canceled": true }))
    }

    /// backup.verify：清单 + 抽样（宿主提供 Core list/download）。
    pub async fn verify(&self, sample_rate_ppm: u32) -> Result<Value, quark_core::Error> {
        let guard = self.session.lock().await;
        let Some(s) = guard.as_ref() else {
            return Err(quark_core::Error::new("CONFLICT", "没有运行中的备份任务"));
        };
        // 验证用假实现占位（真实 list/download 由 Core 提供的接线在后补——Phase-2 剩余项）
        let ops = Arc::new(NullVerify);
        let mut report = quark_backup::verify_manifest(s.store.clone(), ops.clone(), &s.account, &s.target_fid)
            .await;
        quark_backup::verify_sample(s.store.clone(), ops, &mut report, &s.account, sample_rate_ppm, 8 * 1024 * 1024)
            .await;
        serde_json::to_value(report).map_err(|e| quark_core::Error::new("SYSTEM", e.to_string()))
    }
}

struct NullVerify;
impl quark_backup::verifier::VerifyOps for NullVerify {
    fn list_dir<'a>(
        &'a self,
        _fid: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<quark_backup::verifier::RemoteEntry>, String>> + Send + 'a>> {
        Box::pin(async move { Err("远端清单接线未完成（Phase-2 剩余项）".into()) })
    }
    fn download_bytes<'a>(
        &'a self,
        _fid: &'a str,
        _max: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send + 'a>> {
        Box::pin(async move { Err("远端下载接线未完成（Phase-2 剩余项）".into()) })
    }
}

/// 构造真实 Core 远端操作。
fn build_core_ops(core: Core, transfers: quark_transfer::TransferManager) -> Arc<dyn RemoteOps> {
    Arc::new(CoreRemote::new(core, transfers))
}
