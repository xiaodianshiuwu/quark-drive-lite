use crate::scheduler::{ensure_dir_chain, worker_loop_controlled, BackupConfig, RemoteOps};
use crate::state::TaskState;
use crate::verifier::{verify_manifest, verify_sample, RemoteEntry, VerifyOps};
use quark_core::Core;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, watch, Mutex as AsyncMutex};

// 备份会话管理器（宿主无关）：plan/start/status/retry/cancel/verify。
//
// 宿主（src-tauri）只做 qk_call 参数适配；本模块持有会话状态、扫描协程、
// worker 池与真实远端操作（Core fs.* + TransferManager 上传）。

/// 真实远端操作（首版）：全部经 Core 的 fs.*（mkdir/list/info），
/// 上传经 TransferManager 单文件入队 → 轮询终态 → clear。
/// 权衡如实记录：任务短暂出现在 GUI 传输列表（每文件一条，完成即清理）；
/// Scheduler 控制并发（backup worker 数限制实际并发度）。
/// 后续优化：把 quark-transfer/src/upload.rs 核心提为独立入口，绕开任务队列。
pub struct CoreRemote {
    core: Core,
    transfers: quark_transfer::TransferManager,
    generation: u64,
    rate_limit_bps: u64,
    active: std::sync::Mutex<std::collections::BTreeSet<String>>,
}

impl CoreRemote {
    pub fn new(core: Core, transfers: quark_transfer::TransferManager) -> Self {
        Self {
            rate_limit_bps: 0,
            generation: core.session_generation(),
            core,
            transfers,
            active: Default::default(),
        }
    }

    fn with_rate_limit(mut self, rate: u64) -> Self {
        self.rate_limit_bps = rate;
        self
    }

    fn check_session(&self) -> Result<(), String> {
        self.core
            .ensure_session(self.generation)
            .map_err(|e| format!("{}：{}", e.code, e.message))
    }

    /// 等待单个传输任务到终态；返回 (status, error)。
    async fn wait_task(
        &self,
        id: &str,
        timeout_ms: u64,
    ) -> Result<(String, Option<String>), String> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            self.check_session()?;
            let task = self.transfers.task_status(id).map_err(|e| e.message)?;
            let st = task["status"].as_str().unwrap_or("").to_string();
            if ["done", "error", "canceled", "paused"].contains(&st.as_str()) {
                let error = task["error"].as_str().map(str::to_owned);
                if st == "canceled" {
                    let _ = self
                        .transfers
                        .call("transfer.clear", json!({"ids":[id]}))
                        .await;
                    self.active.lock().unwrap().remove(id);
                }
                return Ok((st, error));
            }
            if tokio::time::Instant::now() >= deadline {
                self.transfers
                    .call("transfer.pause", json!(id))
                    .await
                    .map_err(|e| e.message)?;
                self.active.lock().unwrap().remove(id);
                return Err("上传等待超时，分片进度已保留，可继续".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }

    /// 跨页查找：在 parent 的全部子项中找 name（dir=目录/文件）。
    /// 单页 200 的子目录 >200 项时会漏查——上传完成确认与冲突预检都必须跨页。
    async fn find_child(
        &self,
        parent_fid: &str,
        name: &str,
        want_dir: bool,
    ) -> Result<Option<String>, String> {
        let mut page = 1i64;
        loop {
            self.check_session()?;
            let listed = self
                .core
                .call(
                    "fs.list",
                    json!({"pdirFid": parent_fid, "page": page, "size": 200}),
                )
                .await
                .map_err(|e| e.message)?;
            if let Some(items) = listed["list"].as_array() {
                for x in items {
                    if x["dir"] == json!(want_dir) && x["name"] == json!(name) {
                        return Ok(x["fid"].as_str().map(|s| s.to_string()));
                    }
                }
                if items.is_empty() || listed["hasMore"].as_bool().unwrap_or(false) == false {
                    return Ok(None);
                }
            } else {
                return Ok(None);
            }
            page += 1;
        }
    }
}

impl RemoteOps for CoreRemote {
    fn recover_uploaded<'a>(
        &'a self,
        task: &'a crate::Task,
        parent: &'a str,
        fid: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, String>> + Send + 'a>>
    {
        Box::pin(async move {
            self.check_session()?;
            let Some(id) = self
                .transfers
                .attributable_upload(&task.local_path, parent, fid)
            else {
                return Ok(false);
            };
            self.active.lock().unwrap().insert(id.clone());
            self.transfers.call("transfer.resume",json!({"id":id,"rateLimitBps":self.rate_limit_bps,"_expectedSessionGeneration":self.generation})).await.map_err(|e|e.message)?;
            let (status, _) = self.wait_task(&id, 86_400_000).await?;
            Ok(status == "done"
                && self.transfers.task_status(&id).map_err(|e| e.message)?["fid"] == fid)
        })
    }
    fn acknowledge<'a>(
        &'a self,
        path: &'a str,
        parent: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let ids: Vec<_> = self.active.lock().unwrap().iter().cloned().collect();
            for id in ids {
                if let Ok(t) = self.transfers.task_status(&id) {
                    if t["localPath"] == path && t["pdirFid"] == parent && t["status"] == "done" {
                        self.transfers
                            .call("transfer.clear", json!({"ids":[id]}))
                            .await
                            .map_err(|e| e.message)?;
                        self.active.lock().unwrap().remove(&id);
                    }
                }
            }
            Ok(())
        })
    }
    fn pause_active(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let ids: Vec<_> = self.active.lock().unwrap().iter().cloned().collect();
            for id in ids {
                self.transfers
                    .call("transfer.pause", json!({"id":id}))
                    .await
                    .map_err(|e| e.message)?;
            }
            Ok(())
        })
    }
    fn ensure_dir<'a>(
        &'a self,
        target_fid: &'a str,
        rel_path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>>
    {
        Box::pin(async move {
            self.check_session()?;
            // 全链创建：逐段 list 确认（幂等）→ mkdir → 轮询拿 fid
            let mut cur = target_fid.to_string();
            let mut acc = String::new();
            for seg in rel_path.split('/') {
                acc = if acc.is_empty() {
                    seg.to_string()
                } else {
                    format!("{acc}/{seg}")
                };
                if let Some(fid) = self.find_child(&cur, seg, true).await? {
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
                    new_fid = self.find_child(&cur, seg, true).await?;
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
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>>
    {
        Box::pin(async move {
            self.check_session()?;
            // Reuse an interrupted matching transfer so its persisted multipart checkpoint survives.
            let existing = self.transfers.resumable_upload(local_path, parent_fid);
            let ids = if let Some(id) = existing {
                self.active.lock().unwrap().insert(id.clone());
                self.transfers.call("transfer.resume",json!({"id":id,"rateLimitBps":self.rate_limit_bps,"_expectedSessionGeneration":self.generation})).await.map_err(|e|e.message)?;
                json!([id])
            } else {
                self.transfers.call("transfer.upload", json!({"localPaths":[local_path],"pdirFid":parent_fid,"rateLimitBps":self.rate_limit_bps,"_expectedSessionGeneration":self.generation})).await.map_err(|e|e.message)?
            };
            let id = ids
                .as_array()
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .ok_or_else(|| "上传入队失败".to_string())?
                .to_string();
            self.active.lock().unwrap().insert(id.clone());
            let (st, err) = self.wait_task(&id, 86_400_000).await?;
            if st == "paused" {
                return Err("BACKUP_PAUSED".into());
            }
            if st != "done" {
                return Err(err.unwrap_or_else(|| format!("上传失败（{st}）")));
            }
            let name = std::path::Path::new(local_path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let visible = self
                .find_child(parent_fid, &name, false)
                .await?
                .ok_or("上传完成后未在目录中确认文件")?;
            let confirmed = self.transfers.task_status(&id).map_err(|e| e.message)?;
            if confirmed["fid"] != visible {
                return Err("上传结果fid与已确认传输记录不一致".into());
            }
            Ok(visible)
        })
    }

    fn file_visible<'a>(
        &'a self,
        parent_fid: &'a str,
        name: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<String>, String>> + Send + 'a>,
    > {
        Box::pin(async move { self.find_child(parent_fid, name, false).await })
    }
}

/// A session owns every scanner/consumer/worker. Stop joins them before releasing its store.
pub struct BackupSession {
    pub account: String,
    pub root_dir: PathBuf,
    pub target_fid: String,
    pub store: Arc<crate::Store>,
    pub cfg: BackupConfig,
    pub ops: Arc<dyn RemoteOps>,
    pub core_handle: Option<Core>,
    pub transfers_handle: Option<quark_transfer::TransferManager>,
    pub scan_stop: Arc<AtomicBool>,
    pub scan_joined: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    pub stop_tx: watch::Sender<bool>,
    pub uploaded_bytes: Arc<AtomicU64>,
    pub started_at: u64,
    handles: AsyncMutex<Vec<tokio::task::JoinHandle<()>>>,
    scanner:
        AsyncMutex<Option<tokio::task::JoinHandle<std::io::Result<crate::scanner::ScanStats>>>>,
    scan_error: Arc<std::sync::Mutex<Option<String>>>,
    last_verify: std::sync::Mutex<Option<Value>>,
    verify_lock: AsyncMutex<()>,
    generation: Option<u64>,
}

#[derive(Clone, Default)]
pub struct BackupManager {
    pub session: Arc<AsyncMutex<Option<Arc<BackupSession>>>>,
}

impl BackupManager {
    pub async fn plan(
        _core: Core,
        root_dir: String,
        target_fid: String,
    ) -> Result<Value, BackupError> {
        let cfg = crate::scanner::ScanConfig {
            account: String::new(),
            root_dir: validate_root(&root_dir)?,
            target_fid,
            batch_size: 500,
        };
        let (tx, mut rx) = mpsc::channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let scan_stop = stop.clone();
        let h = tokio::task::spawn_blocking(move || {
            crate::scanner::scan_controlled(&cfg, tx, &scan_stop)
        });
        let mut truncated = false;
        let (mut files, mut dirs, mut warnings, mut total_bytes) = (0u64, 0u64, 0u64, 0u64);
        let mut samples = Vec::new();
        'preview: while let Some(batch) = rx.recv().await {
            for it in batch {
                match it {
                    crate::scanner::ScanItem::File(t) => {
                        files += 1;
                        total_bytes += t.size;
                        if samples.len() < 5 {
                            samples.push(json!({"relPath":t.rel_path,"size":t.size}));
                        }
                    }
                    crate::scanner::ScanItem::Dir(_) => dirs += 1,
                    crate::scanner::ScanItem::Warning { rel_path, message } => {
                        warnings += 1;
                        if samples.len() < 10 {
                            samples.push(json!({"warning":rel_path,"detail":message}));
                        }
                    }
                }
                if files + dirs + warnings >= 5000 {
                    truncated = true;
                    stop.store(true, Ordering::Release);
                    break 'preview;
                }
            }
        }
        drop(rx);
        match h.await.map_err(system)? {
            Ok(_) => {}
            Err(e) if truncated && e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(system(e)),
        }
        Ok(
            json!({"files":files,"dirs":dirs,"warnings":warnings,"totalBytes":total_bytes,"samples":samples,"truncated":truncated}),
        )
    }

    pub async fn start(
        &self,
        core: Core,
        transfers: quark_transfer::TransferManager,
        _account: String,
        root_dir: String,
        target_fid: String,
        _profile_dir: PathBuf,
        cfg_patch: Value,
    ) -> Result<Value, BackupError> {
        let generation = core.session_generation();
        let auth = core
            .call("auth.status", Value::Null)
            .await
            .map_err(|e| BackupError::new(e.code, e.message))?;
        if auth["loggedIn"] != true {
            return Err(BackupError::new("NEED_LOGIN", "请先登录再开始备份"));
        }
        // The durable Core login binding is authoritative even when the upstream
        // profile endpoint does not disclose a userId. Never trust a renderer account.
        let account = core
            .account_key()
            .ok_or_else(|| BackupError::new("NEED_LOGIN", "无法确认登录会话，请重新登录"))?;
        core.ensure_session(generation)
            .map_err(|e| BackupError::new(e.code, e.message))?;
        let profile = core.profile_dir().to_path_buf();
        let cfg: BackupConfig = if cfg_patch.is_null() {
            BackupConfig::default()
        } else {
            serde_json::from_value(cfg_patch.clone()).map_err(system)?
        };
        cfg.validate()
            .map_err(|e| BackupError::new("INVALID_ARG", e))?;
        let rate = if cfg.bandwidth_limit_bps == 0 {
            0
        } else {
            cfg.bandwidth_limit_bps
        };
        let ops: Arc<dyn RemoteOps> =
            Arc::new(CoreRemote::new(core.clone(), transfers.clone()).with_rate_limit(rate));
        self.start_session(
            account,
            root_dir,
            target_fid,
            profile,
            cfg_patch,
            ops,
            Some(core),
            Some(transfers),
            Some(generation),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_session(
        &self,
        account: String,
        root_dir: String,
        target_fid: String,
        profile_dir: PathBuf,
        cfg_patch: Value,
        ops: Arc<dyn RemoteOps>,
        core: Option<Core>,
        transfers: Option<quark_transfer::TransferManager>,
        generation: Option<u64>,
    ) -> Result<Value, BackupError> {
        let root = validate_root(&root_dir)?;
        if account.is_empty() || target_fid.is_empty() {
            return Err(BackupError::new("INVALID_ARG", "账号或目标目录不能为空"));
        }
        let cfg: BackupConfig = if cfg_patch.is_null() {
            BackupConfig::default()
        } else {
            serde_json::from_value(cfg_patch).map_err(system)?
        };
        cfg.validate()
            .map_err(|e| BackupError::new("INVALID_ARG", e))?;
        let mut guard = self.session.lock().await;
        if guard.is_some() {
            return Err(BackupError::new(
                "CONFLICT",
                "已有备份会话，请先取消或导出清单",
            ));
        }
        std::fs::create_dir_all(profile_dir.join("backup")).map_err(system)?;
        let root_str = root
            .to_str()
            .ok_or_else(|| BackupError::new("INVALID_ARG", "目录路径无法无损编码"))?
            .to_string();
        // Full tuple key prevents a new target or account from consuming an old session's rows.
        let identity = serde_json::to_vec(&(&account, &root_str, &target_fid)).map_err(system)?;
        let db = profile_dir
            .join("backup")
            .join(format!("bk-{:x}.db", Sha256::digest(identity)));
        let store = Arc::new(crate::Store::open(&db).map_err(system)?);
        // Legacy files are retained untouched; import only rows whose complete identity is verified.
        let mut legacy_hash = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&root_dir, &mut legacy_hash);
        let legacy = profile_dir.join("backup").join(format!(
            "bk{:016x}.db",
            std::hash::Hasher::finish(&legacy_hash)
        ));
        if legacy.exists() {
            store
                .import_legacy(&legacy, &account, &root_dir, &target_fid)
                .map_err(system)?;
        }
        store.recover_interrupted(&account).map_err(system)?;
        store.clear_issues().map_err(system)?;
        let (stop_tx, stop_rx) = watch::channel(false);
        let session = Arc::new(BackupSession {
            account: account.clone(),
            root_dir: root.clone(),
            target_fid: target_fid.clone(),
            store: store.clone(),
            cfg: cfg.clone(),
            ops: ops.clone(),
            core_handle: core,
            transfers_handle: transfers,
            scan_stop: Arc::new(AtomicBool::new(false)),
            scan_joined: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            stop_tx,
            uploaded_bytes: Arc::new(AtomicU64::new(0)),
            started_at: store.now_ms() as u64,
            last_verify: std::sync::Mutex::new(None),
            verify_lock: AsyncMutex::new(()),
            handles: AsyncMutex::new(Vec::new()),
            scanner: AsyncMutex::new(None),
            scan_error: Arc::new(std::sync::Mutex::new(None)),
            generation,
        });
        let scan_cfg = crate::scanner::ScanConfig {
            account: account.clone(),
            root_dir: root,
            target_fid: target_fid.clone(),
            batch_size: cfg.discovery_batch_size,
        };
        let (tx, mut rx) = mpsc::channel::<Vec<crate::scanner::ScanItem>>(1);
        let stop = session.scan_stop.clone();
        *session.scanner.lock().await = Some(tokio::task::spawn_blocking(move || {
            crate::scanner::scan_controlled(&scan_cfg, tx, &stop)
        }));
        let s = session.clone();
        let consumer = tokio::spawn(async move {
            let consume=async {
                let mut stop=stop_rx;
                while let Some(batch)=tokio::select! {b=rx.recv()=>b,_=stop.changed()=>None} {
                    // Database backlog, not merely channel capacity, controls the producer.
                    let incoming=batch.iter().filter(|it|matches!(it,crate::scanner::ScanItem::File(_))).count() as i64;
                    let mut throttled=s.store.queue_depth(&s.account).map_err(system)?+incoming>s.cfg.high_watermark as i64;
                    loop {
                        if *stop.borrow(){return Ok::<(),BackupError>(());}
                        let depth=s.store.queue_depth(&s.account).map_err(system)?;
                        if throttled && depth<=s.cfg.low_watermark as i64 && depth+incoming<=s.cfg.high_watermark as i64 {throttled=false;}
                        if !s.paused.load(Ordering::Acquire) && !throttled {break;}
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    let mut files=Vec::new();
                    for it in batch {match it {
                        crate::scanner::ScanItem::File(t)=>files.push(t),
                        crate::scanner::ScanItem::Warning{rel_path,message}=>s.store.add_issue(&rel_path,&message).map_err(system)?,
                        crate::scanner::ScanItem::Dir(rel)=>{
                            let result=tokio::select! {
                                r=ensure_dir_chain(&s.store,&*s.ops,&s.account,&s.target_fid,&rel)=>Some(r),
                                _=stop.changed()=>None,
                            };
                            match result {Some(Ok(_))=>{},Some(Err(_))=>s.store.add_issue(&rel,"云端目录创建失败，目录未完整备份；再次开始可重试").map_err(system)?,None=>return Ok(())}
                        }
                    }}
                    s.store.upsert_discovered(&files).map_err(system)?;
                }
                Ok(())
            }.await;
            drop(rx); // Unblock a scanner stopped while its one-batch buffer was full.
            if let Err(e) = consume {
                *s.scan_error.lock().unwrap() = Some(e.to_string());
            }
            if let Some(scanner) = s.scanner.lock().await.take() {
                match scanner.await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e))
                        if s.scan_stop.load(Ordering::Acquire)
                            && e.kind() == std::io::ErrorKind::Interrupted => {}
                    other => {
                        *s.scan_error.lock().unwrap() = Some(format!("扫描未完整结束：{other:?}"));
                    }
                }
            }
            s.scan_joined.store(true, Ordering::Release);
        });
        session.handles.lock().await.push(consumer);
        for _ in 0..cfg.upload_concurrency {
            let s = session.clone();
            let stop = s.stop_tx.subscribe();
            session.handles.lock().await.push(tokio::spawn(async move {
                let stats = worker_loop_controlled(
                    s.store.clone(),
                    s.ops.clone(),
                    s.cfg.clone(),
                    s.account.clone(),
                    s.uploaded_bytes.clone(),
                    stop,
                    s.scan_joined.clone(),
                    s.paused.clone(),
                    true,
                )
                .await;
                if let Some(error) = stats.error {
                    *s.scan_error.lock().unwrap() = Some(format!("任务库异常：{error}"));
                    s.scan_stop.store(true, Ordering::Release);
                    let _ = s.stop_tx.send(true);
                }
            }));
        }
        *guard = Some(session.clone());
        Ok(Self::snapshot(&session))
    }

    fn snapshot(s: &BackupSession) -> Value {
        let counts = match s.store.counts(&s.account) {
            Ok(c) => c,
            Err(e) => {
                return json!({"hasSession":true,"running":false,"status":"failed","error":e.to_string()})
            }
        };
        let get = |k: &str| counts.get(k).copied().unwrap_or(0);
        let pending = get("discovered") + get("pending") + get("uploading") + get("verifying");
        let total: i64 = counts.values().sum();
        let scan_done = s.scan_joined.load(Ordering::Acquire);
        let paused = s.paused.load(Ordering::Acquire);
        let error = s.scan_error.lock().unwrap().clone();
        let warnings = s.store.issue_count().unwrap_or(1);
        let complete = scan_done
            && pending == 0
            && get("failed") == 0
            && get("skipped") == 0
            && get("canceled") == 0
            && warnings == 0
            && error.is_none();
        let verified = complete
            && s.last_verify
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|r| r["status"] == "verified");
        let verification_running = s.verify_lock.try_lock().is_err();
        let status = if verification_running {
            "verifying_backup"
        } else if error.is_some() {
            "incomplete"
        } else if verified {
            "verified"
        } else if paused {
            "paused"
        } else if !scan_done {
            "scanning"
        } else if pending > 0 {
            "uploading"
        } else if complete {
            "awaiting_verification"
        } else {
            "incomplete"
        };
        let active_tasks = s
            .store
            .task_page(&s.account, Some(TaskState::Uploading), 0, 8)
            .unwrap_or_default();
        let paths: Vec<_> = active_tasks.iter().map(|t| t.local_path.clone()).collect();
        let active = s
            .transfers_handle
            .as_ref()
            .map(|m| m.active_uploads(&paths))
            .unwrap_or_default();
        let speed: u64 = active.iter().filter_map(|t| t["speed"].as_u64()).sum();
        let mut v = json!({"hasSession":true,"running":!paused && (!scan_done || pending>0),"paused":paused,"scanComplete":scan_done,"status":status,
            "readyToVerify":scan_done && pending==0 && !verification_running,"verificationRunning":verification_running,"complete":verified,"verification":s.last_verify.lock().unwrap().clone(),"accountFingerprint":format!("{:x}",Sha256::digest(s.account.as_bytes()))[..12],"rootDir":s.root_dir,"targetFid":s.target_fid,"startedAt":s.started_at,
            "queueDepth":pending,"totalDiscovered":total,"warnings":warnings,"scanError":error,"config":s.cfg,
            "uploadedBytes":s.store.success_bytes(&s.account).unwrap_or(0),"speed":speed,"currentFiles":active,"recentErrors":s.store.recent_errors(&s.account,8).unwrap_or_default(),"issues":s.store.issue_page(0,20).unwrap_or_default()});
        for k in [
            "discovered",
            "pending",
            "uploading",
            "verifying",
            "success",
            "failed",
            "skipped",
            "canceled",
        ] {
            v[k] = json!(get(k));
        }
        v
    }
    pub async fn status(&self) -> Value {
        let guard = self.session.lock().await;
        guard
            .as_ref()
            .map(|s| Self::snapshot(s))
            .unwrap_or(json!({"hasSession":false,"running":false}))
    }
    pub async fn pause(&self) -> Result<Value, BackupError> {
        let guard = self.session.lock().await;
        let s = guard.as_ref().ok_or_else(no_session)?;
        s.paused.store(true, Ordering::Release);
        s.ops.pause_active().await.map_err(system)?;
        Ok(Self::snapshot(s))
    }
    pub async fn resume(&self) -> Result<Value, BackupError> {
        let guard = self.session.lock().await;
        let s = guard.as_ref().ok_or_else(no_session)?;
        if let (Some(core), Some(g)) = (&s.core_handle, s.generation) {
            core.ensure_session(g)
                .map_err(|e| BackupError::new(e.code, e.message))?;
        }
        s.paused.store(false, Ordering::Release);
        Ok(Self::snapshot(s))
    }
    pub async fn retry_failed(&self) -> Result<Value, BackupError> {
        let guard = self.session.lock().await;
        let s = guard.as_ref().ok_or_else(no_session)?;
        let _verification = s
            .verify_lock
            .try_lock()
            .map_err(|_| BackupError::new("CONFLICT", "验证正在进行，暂不能重试"))?;
        *s.last_verify.lock().unwrap() = None;
        let mut offset = 0;
        let mut n = 0;
        loop {
            let batch = s
                .store
                .task_page(&s.account, Some(TaskState::Failed), offset, 500)
                .map_err(system)?;
            if batch.is_empty() {
                break;
            }
            for mut t in batch {
                t.attempts = 0;
                s.store
                    .transition(&t, TaskState::Pending, None)
                    .map_err(system)?;
                n += 1;
            }
            // transitioned rows disappear from this state; always consume its first page.
            offset = 0;
        }
        if n > 0 {
            s.paused.store(false, Ordering::Release);
        }
        Ok(json!({"requeued":n}))
    }
    pub async fn cancel(&self) -> Result<Value, BackupError> {
        let mut guard = self.session.lock().await;
        let s = guard.as_ref().ok_or_else(no_session)?;
        s.scan_stop.store(true, Ordering::Release);
        let _ = s.stop_tx.send(true);
        s.ops.pause_active().await.map_err(system)?;
        for handle in s.handles.lock().await.drain(..) {
            handle.await.map_err(system)?;
        }
        s.store.recover_interrupted(&s.account).map_err(system)?;
        *guard = None;
        Ok(json!({"canceled":true}))
    }
    pub async fn tasks(&self, offset: usize, limit: usize) -> Result<Value, BackupError> {
        let guard = self.session.lock().await;
        let s = guard.as_ref().ok_or_else(no_session)?;
        let tasks = s
            .store
            .task_page(&s.account, None, offset, limit)
            .map_err(system)?;
        let tasks: Vec<_> = tasks.iter().map(public_task).collect();
        Ok(
            json!({"offset":offset,"tasks":tasks,"issues":s.store.issue_page(offset,limit).map_err(system)?}),
        )
    }
    pub async fn export(&self, path: PathBuf) -> Result<Value, BackupError> {
        use std::io::Write;
        let guard = self.session.lock().await;
        let s = guard.as_ref().ok_or_else(no_session)?;
        let store = s.store.clone();
        let account = s.account.clone();
        let status = Self::snapshot(s);
        let count = tokio::task::spawn_blocking(move || -> Result<usize, BackupError> {
            let mut f = std::io::BufWriter::new(
                std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)
                    .map_err(system)?,
            );
            writeln!(f, "{}", json!({"type":"summary","status":status})).map_err(system)?;
            let mut offset = 0;
            loop {
                let batch = store
                    .task_page(&account, None, offset, 500)
                    .map_err(system)?;
                if batch.is_empty() {
                    break;
                }
                for t in &batch {
                    writeln!(f, "{}", json!({"type":"file","task":public_task(t)}))
                        .map_err(system)?;
                }
                offset += batch.len();
            }
            let mut issue_offset = 0;
            loop {
                let batch = store.issue_page(issue_offset, 500).map_err(system)?;
                if batch.is_empty() {
                    break;
                }
                for issue in &batch {
                    writeln!(f, "{}", json!({"type":"issue","issue":issue})).map_err(system)?;
                }
                issue_offset += batch.len();
            }
            let mut verify_offset = 0;
            loop {
                let batch = store
                    .verification_issue_page(verify_offset, 500)
                    .map_err(system)?;
                if batch.is_empty() {
                    break;
                }
                for issue in &batch {
                    writeln!(f, "{}", json!({"type":"verification_issue","issue":issue}))
                        .map_err(system)?;
                }
                verify_offset += batch.len();
            }
            f.flush().map_err(system)?;
            f.get_ref().sync_all().map_err(system)?;
            Ok(offset)
        })
        .await
        .map_err(system)??;
        Ok(json!({"exported":count}))
    }
    pub async fn verify(&self, sample_rate_ppm: u32) -> Result<Value, BackupError> {
        let s = {
            let guard = self.session.lock().await;
            guard.as_ref().cloned().ok_or_else(no_session)?
        };
        if !s.scan_joined.load(Ordering::Acquire)
            || s.store.queue_depth(&s.account).map_err(system)? > 0
        {
            return Err(BackupError::new(
                "CONFLICT",
                "扫描或上传仍未结束，请先等待处理完成",
            ));
        }
        let core = s.core_handle.clone().ok_or_else(no_session)?;
        if let Some(g) = s.generation {
            core.ensure_session(g)
                .map_err(|e| BackupError::new(e.code, e.message))?;
        }
        let _verification = s
            .verify_lock
            .try_lock()
            .map_err(|_| BackupError::new("CONFLICT", "验证正在进行"))?;
        let ops = Arc::new(CoreVerify {
            generation: core.session_generation(),
            core,
            transfers: s.transfers_handle.clone().ok_or_else(no_session)?,
        });
        let mut stop = s.stop_tx.subscribe();
        let value = tokio::select! {
            result=async {
                let mut report=verify_manifest(s.store.clone(),ops.clone(),&s.account,&s.target_fid).await;
                verify_sample(s.store.clone(),ops,&mut report,&s.account,sample_rate_ppm,8*1024*1024).await;
                let error=s.scan_error.lock().unwrap().clone();
                if error.is_some(){report.status="failed".into();report.issues.push(json!({"kind":"scan_error","detail":error}));}
                serde_json::to_value(report).map_err(system)
            }=>result?,
            _=stop.changed()=>return Err(BackupError::new("ABORTED","备份验证已取消")),
        };
        *s.last_verify.lock().unwrap() = Some(value.clone());
        Ok(value)
    }
}
fn public_task(task: &crate::Task) -> Value {
    let mut value = serde_json::to_value(task).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.remove("account");
        object.remove("chunk_progress");
    }
    value
}
fn system(e: impl std::fmt::Display) -> BackupError {
    BackupError::new("BACKUP_ERROR", e.to_string())
}
fn no_session() -> BackupError {
    BackupError::new("CONFLICT", "没有备份会话，请选择原目录和目标后开始以恢复")
}
fn validate_root(root: &str) -> Result<PathBuf, BackupError> {
    let path = PathBuf::from(root);
    if !path.is_absolute() {
        return Err(BackupError::new("INVALID_ARG", "请选择本地绝对目录路径"));
    }
    let meta = std::fs::symlink_metadata(&path).map_err(system)?;
    if !meta.is_dir() || crate::scanner::is_reparse(&meta) {
        return Err(BackupError::new(
            "INVALID_ARG",
            "源必须是普通目录，不能为链接或重解析点",
        ));
    }
    std::fs::canonicalize(path).map_err(system)
}

/// 真实验证远端：fs.list 聚合多页 + 经 TransferManager 下载读回字节。
struct CoreVerify {
    core: Core,
    transfers: quark_transfer::TransferManager,
    generation: u64,
}

/// Owns the temporary download even if its future is canceled. Only this task is stopped.
struct VerifyDownload {
    dir: PathBuf,
    transfers: quark_transfer::TransferManager,
    id: Option<String>,
}
impl Drop for VerifyDownload {
    fn drop(&mut self) {
        let dir = self.dir.clone();
        let transfers = self.transfers.clone();
        let id = self.id.take();
        if let Some(id) = id {
            tokio::spawn(async move {
                let _ = transfers.call("transfer.cancel", json!({"id":id})).await;
                let _ = transfers.call("transfer.clear", json!({"ids":[id]})).await;
                let _ = tokio::fs::remove_dir_all(dir).await;
            });
        } else {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
impl CoreVerify {
    async fn download_file(&self, fid: &str) -> Result<(VerifyDownload, PathBuf), String> {
        self.core
            .ensure_session(self.generation)
            .map_err(|e| e.message)?;
        let dir = std::env::temp_dir().join(format!("qk-verify-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let mut guard = VerifyDownload {
            dir: dir.clone(),
            transfers: self.transfers.clone(),
            id: None,
        };
        let ids = self
            .transfers
            .call("transfer.download", json!({"fids":[fid],"localDir":dir}))
            .await
            .map_err(|e| e.message)?;
        let id = ids[0].as_str().ok_or("下载入队失败")?.to_string();
        guard.id = Some(id.clone());
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(86_400);
        loop {
            self.core
                .ensure_session(self.generation)
                .map_err(|e| e.message)?;
            let task = self.transfers.task_status(&id).map_err(|e| e.message)?;
            match task["status"].as_str().unwrap_or("") {
                "done" => {
                    let path =
                        PathBuf::from(task["localPath"].as_str().ok_or("下载未返回本地路径")?);
                    if !path.starts_with(&dir) {
                        return Err("验证下载路径越界".into());
                    }
                    self.transfers
                        .call("transfer.clear", json!({"ids":[id]}))
                        .await
                        .map_err(|e| e.message)?;
                    guard.id = None;
                    return Ok((guard, path));
                }
                "error" | "canceled" | "paused" => {
                    return Err(task["error"].as_str().unwrap_or("验证下载未完成").into())
                }
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("验证下载超时".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }
}
impl VerifyOps for CoreVerify {
    fn list_dir<'a>(
        &'a self,
        fid: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<RemoteEntry>, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            let (entries, more) = self.list_page(fid, 1).await?;
            if more {
                Err("请使用分页列举".into())
            } else {
                Ok(entries)
            }
        })
    }
    fn list_page<'a>(
        &'a self,
        fid: &'a str,
        page: u64,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(Vec<RemoteEntry>, bool), String>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.core
                .ensure_session(self.generation)
                .map_err(|e| e.message)?;
            let listed = self
                .core
                .call("fs.list", json!({"pdirFid":fid,"page":page,"size":200}))
                .await
                .map_err(|e| e.message)?;
            let entries = listed["list"]
                .as_array()
                .ok_or("目录响应缺少列表")?
                .iter()
                .map(|x| RemoteEntry {
                    name: x["name"].as_str().unwrap_or("").into(),
                    fid: x["fid"].as_str().unwrap_or("").into(),
                    size: x["size"].as_u64().unwrap_or(0),
                    is_dir: x["dir"].as_bool().unwrap_or(false),
                })
                .collect();
            Ok((entries, listed["hasMore"].as_bool().unwrap_or(false)))
        })
    }
    fn download_bytes<'a>(
        &'a self,
        fid: &'a str,
        max_bytes: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send + 'a>>
    {
        Box::pin(async move {
            let (_guard, path) = self.download_file(fid).await?;
            tokio::task::spawn_blocking(move || {
                use std::io::Read;
                let mut bytes = Vec::new();
                std::fs::File::open(path)
                    .map_err(|e| e.to_string())?
                    .take(max_bytes + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() as u64 > max_bytes {
                    Err("验证文件超过内存读取限制".into())
                } else {
                    Ok(bytes)
                }
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }
    fn download_hash<'a>(
        &'a self,
        fid: &'a str,
        _max_bytes: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send + 'a>>
    {
        Box::pin(async move {
            let (_guard, path) = self.download_file(fid).await?;
            tokio::task::spawn_blocking(move || crate::verifier::hash_file(&path))
                .await
                .map_err(|e| e.to_string())?
        })
    }
}
/// 轻量错误（避免 quark-backup 反向依赖宿主错误类型）。
#[derive(Debug)]
pub struct BackupError {
    pub code: String,
    pub message: String,
}

impl BackupError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod audit_tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;
    struct Remote {
        gate: tokio::sync::Semaphore,
        uploads: AtomicU64,
        files: Mutex<std::collections::HashMap<String, String>>,
        dirs: Mutex<Vec<String>>,
    }
    impl Remote {
        fn new(permits: usize) -> Self {
            Self {
                gate: tokio::sync::Semaphore::new(permits),
                uploads: AtomicU64::new(0),
                files: Mutex::new(Default::default()),
                dirs: Mutex::new(Vec::new()),
            }
        }
    }
    impl RemoteOps for Remote {
        fn ensure_dir<'a>(
            &'a self,
            target: &'a str,
            rel: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>>
        {
            Box::pin(async move {
                let fid = format!("{target}/{rel}");
                self.dirs.lock().unwrap().push(fid.clone());
                Ok(fid)
            })
        }
        fn upload_file<'a>(
            &'a self,
            path: &'a str,
            parent: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>>
        {
            Box::pin(async move {
                self.uploads.fetch_add(1, Ordering::SeqCst);
                self.gate
                    .acquire()
                    .await
                    .map_err(|e| e.to_string())?
                    .forget();
                let name = std::path::Path::new(path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy();
                let key = format!("{parent}/{name}");
                self.files.lock().unwrap().insert(key.clone(), key.clone());
                Ok(key)
            })
        }
        fn file_visible<'a>(
            &'a self,
            parent: &'a str,
            name: &'a str,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Option<String>, String>> + Send + 'a>,
        > {
            Box::pin(async move {
                Ok(self
                    .files
                    .lock()
                    .unwrap()
                    .get(&format!("{parent}/{name}"))
                    .cloned())
            })
        }
    }
    async fn until(m: &BackupManager, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let s = m.status().await;
            if predicate(&s) {
                return s;
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out: {s}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    async fn start(
        m: &BackupManager,
        base: &std::path::Path,
        target: &str,
        remote: Arc<Remote>,
    ) -> Value {
        m.start_session("verified-account".into(),base.join("data").to_string_lossy().into(),target.into(),base.join("profile"),json!({"discoveryBatchSize":5,"highWatermark":10,"lowWatermark":5,"uploadConcurrency":2,"retryBaseMs":1}),remote,None,None,None).await.unwrap()
    }
    #[tokio::test]
    async fn full_session_backpressure_pause_cancel_join_resume_and_empty_dirs() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("data");
        std::fs::create_dir_all(root.join("empty/deep")).unwrap();
        for n in 0..200 {
            std::fs::write(root.join(format!("f{n:03}")), b"abc").unwrap();
        }
        let m = BackupManager::default();
        let remote = Arc::new(Remote::new(0));
        start(&m, base.path(), "target", remote.clone()).await;
        let s = until(&m, |s| {
            s["queueDepth"].as_i64().unwrap_or(0) >= 8 && remote.uploads.load(Ordering::SeqCst) >= 1
        })
        .await;
        assert_ne!(
            s["scanComplete"], true,
            "first upload starts before scanning ends"
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
        let s = m.status().await;
        assert!(
            s["totalDiscovered"].as_i64().unwrap() <= 10,
            "DB backlog actually bounded: {s}"
        );
        assert_eq!(m.pause().await.unwrap()["paused"], true);
        let calls = remote.uploads.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(remote.uploads.load(Ordering::SeqCst), calls);
        m.resume().await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), m.cancel())
            .await
            .unwrap()
            .unwrap();
        let uploads = remote.uploads.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            remote.uploads.load(Ordering::SeqCst),
            uploads,
            "no orphan workers after cancel"
        );
        assert_eq!(m.status().await["hasSession"], false);
        remote.gate.add_permits(1000);
        start(&m, base.path(), "target", remote.clone()).await;
        let done = until(&m, |s| s["readyToVerify"] == true).await;
        assert_eq!(done["success"], 200, "reopened queue resumes all files");
        assert_eq!(done["failed"], 0);
        assert_eq!(done["status"], "awaiting_verification");
        assert_eq!(
            done["complete"], false,
            "upload completion alone is never backup acceptance"
        );
        assert!(
            remote
                .dirs
                .lock()
                .unwrap()
                .iter()
                .any(|d| d == "target/empty/deep"),
            "empty directories retained"
        );
        let export = base.path().join("manifest.jsonl");
        assert_eq!(m.export(export.clone()).await.unwrap()["exported"], 200);
        assert_eq!(
            std::fs::read_to_string(export).unwrap().lines().count(),
            201
        );
        m.cancel().await.unwrap();
        // Different target must never claim or count files from the first target's queue.
        let remote2 = Arc::new(Remote::new(1000));
        start(&m, base.path(), "other", remote2.clone()).await;
        let done = until(&m, |s| s["readyToVerify"] == true).await;
        assert_eq!(done["success"], 200);
        assert_eq!(remote2.uploads.load(Ordering::SeqCst), 200);
        m.cancel().await.unwrap();
    }
    #[tokio::test]
    async fn linked_files_are_reported_and_do_not_escape_source() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("data");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("safe"), b"a").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(base.path(), root.join("loop")).unwrap();
        let m = BackupManager::default();
        start(&m, base.path(), "target", Arc::new(Remote::new(10))).await;
        let done = until(&m, |s| s["readyToVerify"] == true).await;
        assert_eq!(done["success"], 1);
        #[cfg(unix)]
        {
            assert_eq!(done["warnings"], 1);
            assert_eq!(done["status"], "incomplete");
        }
        m.cancel().await.unwrap();
    }
    #[test]
    fn camel_case_config_is_applied_and_zero_or_unknown_config_is_rejected() {
        let cfg:BackupConfig=serde_json::from_value(json!({"discoveryBatchSize":3,"highWatermark":9,"lowWatermark":2,"uploadConcurrency":1})).unwrap();
        cfg.validate().unwrap();
        assert_eq!(cfg.discovery_batch_size, 3);
        assert_eq!(cfg.upload_concurrency, 1);
        let cfg: BackupConfig = serde_json::from_value(json!({"highWatermark":0})).unwrap();
        assert!(cfg.validate().is_err());
        assert!(serde_json::from_value::<BackupConfig>(json!({"unknown":1})).is_err());
    }
}
