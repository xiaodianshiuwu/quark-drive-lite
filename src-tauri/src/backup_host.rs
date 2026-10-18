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

/// 真实远端操作：直接用 Core 的 fs.* 调用（上传用 transfer.upload 会进 GUI 队列——
/// 海量任务不走那条路；这里用 Core 的直传能力。为保持零新增端点，上传复用
/// `transfer.upload` 的核心函数——quark-transfer 未导出，故 Phase-2 首版用
/// TransferManager 限流模式：一次最多 10000 条（每次分页提交），把任务分页入队）。
/// 权衡如实记录：首版上传仍走 TransferManager（GUI 可见任务）， Scheduler 控制并发与重试；
/// 后续若需完全绕开，把 quark-transfer/src/upload.rs 的 run_upload 提为 pub 再切换。
struct CoreRemote;

impl RemoteOps for CoreRemote {
    fn ensure_dir<'a>(
        &'a self,
        _target_fid: &'a str,
        _rel_path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            // 首版：调用 fs.mkdir（幂等由调用方 find 冲突保证）——但 scheduler 的 ensure_dir
            // 需要返回"整条 rel 链的末端 fid"，这里简化：由 rel 直接 mkdir 逐级（Core 不支持 mkdir -p）。
            // 真实实现放在接线层 build_remote（见下），CoreRemote 仅用于测试替换。
            Err("CoreRemote 未实现（使用 build_remote 构造的实现）".to_string())
        })
    }

    fn upload_file<'a>(
        &'a self,
        _local_path: &'a str,
        _parent_fid: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move { Err("CoreRemote 未实现".to_string()) })
    }

    fn file_visible<'a>(
        &'a self,
        _parent_fid: &'a str,
        _name: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>, String>> + Send + 'a>> {
        Box::pin(async move { Err("CoreRemote 未实现".to_string()) })
    }
}

/// 运行中的备份会话。
pub struct BackupSession {
    pub account: String,
    pub root_dir: PathBuf,
    pub target_fid: String,
    pub store: Arc<quark_backup::Store>,
    pub stop_tx: watch::Sender<bool>,
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
    pub async fn plan(core: Core, root_dir: String, target_fid: String) -> Result<Value, quark_core::Error> {
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
        let (tx, rx) = mpsc::channel::<Vec<quark_backup::scanner::ScanItem>>(cfg.high_watermark);
        let store_scan = store.clone();
        let account_scan = account.clone();
        tokio::task::spawn_blocking(move || {
            let _ = quark_backup::scanner::scan(&scan_cfg, tx);
            // 扫描结束后把 discovered 挂起不需要动作：worker 会 claim
            let _ = store_scan;
            let _ = account_scan;
        });

        // worker 池：真实远端 = Core fs.*（首版：mkdir/list/上传均经 Core 直调——
        // 上传的文件字节走 Core 的 upload 原语；为控制 Phase-2 范围，首版 RemoteOps
        // 实现用 Core 的 fs.* + transfer 核心接口，见 build_core_ops）
        let ops = build_core_ops(core.clone());
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

/// 构造真实 Core 远端操作（Phase-2 剩余项：上传核心需要 quark-transfer 导出）。
fn build_core_ops(_core: Core) -> Arc<dyn RemoteOps> {
    // Phase-2 剩余项：真实上传接线需要 quark-transfer 导出上传核心（run_upload）。
    // 首版占位：所有远端操作返回明确错误，backup.start 会产生 failed 任务而非假成功。
    Arc::new(CoreRemote)
}
