use crate::{
    manager::{
        cancellable, check, err, io_err, net_err, now, Result, RunTelemetry, TransferManager,
    },
    protocol::{complete_meta, oss_url, put_meta_with_ctx, xml, OSS_USER_AGENT},
    sha1_state::Sha1State,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{stream::FuturesUnordered, StreamExt};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::fs;
use tokio_util::sync::CancellationToken;
const INSPECT_BUF_CAP: usize = 2 * 1024 * 1024;
const STREAM_CHUNK_BYTES: usize = 256 * 1024;
#[derive(Clone, Default, Serialize, Deserialize)]
struct Checkpoint {
    #[serde(default)]
    size: u64,
    #[serde(default)]
    modified: u128,
    #[serde(default)]
    md5: String,
    #[serde(default)]
    sha1: String,
    #[serde(default)]
    baseline: Option<Vec<Value>>,
    #[serde(default)]
    pre: Option<Value>,
    #[serde(default)]
    part_size: u64,
    #[serde(default)]
    parts: BTreeMap<u64, String>,
    #[serde(default)]
    phase: String,
    #[serde(default)]
    identity: Option<String>,
    #[serde(default)]
    parallel_requested: bool,
    #[serde(default)]
    parallel_disabled: bool,
    #[serde(default)]
    part_thread: u64,
    #[serde(default)]
    returned_fid: Option<String>,
}
fn store(m: &TransferManager, id: &str, cp: &Checkpoint) -> Result<()> {
    m.checkpoint(
        id,
        serde_json::to_value(cp).map_err(|_| err("LOCAL_IO", "上传进度序列化失败"))?,
    )
}
fn store_batched(m: &TransferManager, id: &str, cp: &Checkpoint, persist: bool) -> Result<()> {
    m.checkpoint_batched(
        id,
        serde_json::to_value(cp).map_err(|_| err("LOCAL_IO", "上传进度序列化失败"))?,
        persist,
    )
}
fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err("SERVER", format!("上传信息缺少 {key}")))
}
#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: u128,
    identity: Option<String>,
}
impl FileStamp {
    fn from(metadata: &std::fs::Metadata) -> Result<Self> {
        if !metadata.is_file() {
            return Err(err("INVALID_ARG", "暂不支持上传文件夹"));
        }
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            Some(format!("{}:{}", metadata.dev(), metadata.ino()))
        };
        #[cfg(not(unix))]
        let identity = None;
        Ok(Self {
            size: metadata.len(),
            modified: metadata
                .modified()
                .map_err(io_err)?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            identity,
        })
    }
}
struct Inspection {
    md5: String,
    sha1: String,
    contexts: BTreeMap<u64, String>,
    part_md5: BTreeMap<u64, String>,
}
async fn inspect(
    path: &Path,
    expected: &FileStamp,
    part_size: Option<u64>,
    token: &CancellationToken,
) -> Result<Inspection> {
    let path_buf = path.to_path_buf();
    let expected = expected.clone();
    let tok = token.clone();
    tokio::task::spawn_blocking(move || -> Result<Inspection> {
        use std::io::Read;
        let mut file = std::fs::File::open(&path_buf).map_err(io_err)?;
        if FileStamp::from(&file.metadata().map_err(io_err)?)? != expected {
            return Err(err("CONFLICT", "本地文件已被替换，已停止上传"));
        }
        let mut md5 = Md5::new();
        // When part_size is Some, compute SHA-1 ONCE via Sha1State (exports prefix + finalizes full digest).
        let mut sha1_only = if part_size.is_none() {
            Some(Sha1::new())
        } else {
            None
        };
        let mut prefix = if part_size.is_some() {
            Some(Sha1State::new())
        } else {
            None
        };
        let mut part_md5 = Md5::new();
        let mut result = Inspection {
            md5: String::new(),
            sha1: String::new(),
            contexts: BTreeMap::new(),
            part_md5: BTreeMap::new(),
        };
        let mut buffer = vec![0u8; INSPECT_BUF_CAP];
        let mut position = 0u64;
        loop {
            check(&tok)?;
            if let (Some(span), Some(pref)) = (part_size, prefix.as_ref()) {
                if position > 0 && position < expected.size && position % span == 0 {
                    result
                        .contexts
                        .insert(position / span + 1, pref.export_base64()?);
                }
            }
            let max = part_size
                .map(|span| (span - position % span).min(buffer.len() as u64) as usize)
                .unwrap_or(buffer.len());
            let count = file.read(&mut buffer[..max]).map_err(io_err)?;
            if count == 0 {
                break;
            }
            md5.update(&buffer[..count]);
            if let Some(ref mut s) = sha1_only {
                s.update(&buffer[..count]);
            }
            if let (Some(span), Some(ref mut pref)) = (part_size, prefix.as_mut()) {
                pref.update(&buffer[..count])?;
                part_md5.update(&buffer[..count]);
                position += count as u64;
                if position % span == 0 || position == expected.size {
                    result.part_md5.insert(
                        (position - 1) / span + 1,
                        format!("{:x}", part_md5.finalize_reset()),
                    );
                }
            } else {
                position += count as u64;
            }
            if position > expected.size {
                return Err(err("CONFLICT", "上传文件读取期间增长，已停止提交"));
            }
        }
        if position != expected.size {
            return Err(err("CONTENT_MISMATCH", "上传源文件读取长度不符"));
        }
        if FileStamp::from(&std::fs::metadata(&path_buf).map_err(io_err)?)? != expected {
            return Err(err("CONFLICT", "本地文件在上传期间发生变化，已停止提交"));
        }
        result.md5 = format!("{:x}", md5.finalize());
        result.sha1 = if let Some(pref) = prefix {
            pref.finalize_hex()?
        } else {
            format!("{:x}", sha1_only.unwrap().finalize())
        };
        Ok(result)
    })
    .await
    .map_err(|_| err("LOCAL_IO", "校验上传源文件失败"))?
}
async fn signature(
    m: &TransferManager,
    pre: &Value,
    meta: String,
    token: &CancellationToken,
    generation: u64,
) -> Result<String> {
    let env=cancellable(token,m.inner.core.post_in_session(generation,"/1/clouddrive/file/upload/auth",json!({"task_id":required(pre,"task_id")?,"auth_info":pre["auth_info"],"auth_meta":meta}))).await?;
    required(&env["data"], "auth_key").map(str::to_string)
}
fn is_definitive_rejection(e: &quark_core::Error) -> bool {
    e.http_status.is_some()
        || matches!(
            e.code.as_str(),
            "NEED_LOGIN"
                | "INVALID_ARG"
                | "FORBIDDEN"
                | "NO_SPACE"
                | "CONFLICT"
                | "RATE_LIMIT"
                | "NOT_FOUND"
        )
}

pub(crate) async fn run(
    m: &TransferManager,
    id: &str,
    token: &CancellationToken,
    tel: &RunTelemetry,
) -> Result<()> {
    tel.set_stage("init");
    let generation = m.bound_generation()?;
    let task = m.task(id)?;
    if task.account_key.is_none() || task.account_key != m.inner.core.account_key() {
        return Err(err("ACCOUNT_MISMATCH", "传输所属账号已改变"));
    }
    m.inner.core.ensure_session(generation)?;
    let local = PathBuf::from(
        task.local_path
            .as_deref()
            .ok_or_else(|| err("INVALID_ARG", "上传文件路径缺失"))?,
    );
    let parent = task.pdir_fid.as_deref().unwrap_or("0");
    let name = local
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| err("INVALID_ARG", "文件名不是有效 UTF-8"))?;
    let mut cp: Checkpoint = if task.checkpoint.as_object().is_some_and(|o| o.is_empty()) {
        Checkpoint::default()
    } else {
        serde_json::from_value(task.checkpoint.clone())
            .map_err(|_| err("LOCAL_IO", "上传进度格式无效，原记录已保留"))?
    };
    if !cp.phase.is_empty() || !cp.parts.is_empty() {
        tel.set_resumed(true);
    }
    if (!cp.md5.is_empty()
        && (cp.md5.len() != 32
            || !cp.md5.bytes().all(|b| b.is_ascii_hexdigit())
            || cp.sha1.len() != 40
            || !cp.sha1.bytes().all(|b| b.is_ascii_hexdigit())))
        || (cp.pre.is_some() && (cp.phase.is_empty() || cp.md5.is_empty() || cp.baseline.is_none()))
        || (cp.pre.is_none() && ["prepared", "parts", "completed"].contains(&cp.phase.as_str()))
    {
        return Err(err("LOCAL_IO", "上传进度缺少内容绑定信息，原记录已保留"));
    }
    if cp.phase == "result" {
        tel.set_strategy("confirm_only");
        tel.set_stage("confirm");
        tel.set_size(cp.size);
        return confirm(m, id, parent, name, &cp, false, token, generation).await;
    }
    if [
        "pre_started",
        "hash_started",
        "complete_started",
        "finish_started",
    ]
    .contains(&cp.phase.as_str())
    {
        tel.set_stage("confirm_uncertain");
        tel.set_size(cp.size);
        // A crash or lost HTTP response at a mutating endpoint cannot safely be replayed.
        // First recognize an attributable completed cloud file; otherwise preserve the checkpoint for explicit inspection.
        if confirm(m, id, parent, name, &cp, true, token, generation)
            .await
            .is_ok()
        {
            cp.phase = "result".into();
            store(m, id, &cp)?;
            return m.progress_with_telemetry(id, cp.size, cp.size, Some(tel));
        }
        check(token)?;
        m.inner.core.ensure_session(generation)?;
        return Err(err(
            "COMMIT_UNCERTAIN",
            "上次上传提交响应未确认，已保留进度；请核对目标目录后重新创建任务，避免重复上传",
        ));
    }
    if !["", "prepared", "parts", "completed"].contains(&cp.phase.as_str()) {
        return Err(err("LOCAL_IO", "上传进度阶段无效，原记录已保留"));
    }
    // Once OSS completion is acknowledged, finishing that same task does not
    // need the local file to remain available. Its digest is already pinned.
    if cp.phase == "completed" {
        tel.set_stage("finish_api");
        tel.set_size(cp.size);
        let pre = cp
            .pre
            .clone()
            .ok_or_else(|| err("LOCAL_IO", "上传进度缺少预登记信息"))?;
        let finish =
            json!({"obj_key":required(&pre,"obj_key")?,"task_id":required(&pre,"task_id")?});
        check(token)?;
        m.inner.core.ensure_session(generation)?;
        cp.phase = "finish_started".into();
        store(m, id, &cp)?;
        match m
            .inner
            .core
            .post_in_session(generation, "/1/clouddrive/file/upload/finish", finish)
            .await
        {
            Ok(env) => {
                if let Some(fid) = env["data"]["fid"].as_str().filter(|s| !s.is_empty()) {
                    cp.returned_fid = Some(fid.to_string());
                }
            }
            Err(e) => {
                if is_definitive_rejection(&e) {
                    cp.phase = "completed".into();
                    store(m, id, &cp)?;
                }
                return Err(e);
            }
        }
        cp.phase = "result".into();
        store(m, id, &cp)?;
        tel.set_stage("confirm");
        return confirm(m, id, parent, name, &cp, false, token, generation).await;
    }
    let stamp = FileStamp::from(&fs::metadata(&local).await.map_err(io_err)?)?;
    let size = stamp.size;
    tel.set_size(size);
    if (!cp.md5.is_empty() || cp.pre.is_some())
        && (cp.size != size
            || cp.modified != stamp.modified
            || cp
                .identity
                .as_ref()
                .is_some_and(|old| stamp.identity.as_ref() != Some(old)))
    {
        return Err(err(
            "CONFLICT",
            "本地文件在上传期间发生变化，请核对旧上传结果并重新创建任务",
        ));
    }
    cp.size = size;
    cp.modified = stamp.modified;
    cp.identity = stamp.identity.clone();
    m.progress_with_telemetry(id, 0, size, Some(tel))?;
    if cp.baseline.is_none() {
        tel.set_stage("baseline");
        cp.baseline = Some(matching(m, parent, name, token, generation).await?);
        store(m, id, &cp)?;
    }
    // Rehash on resume, including when a process changed bytes and restored the
    // mtime. Never mix saved multipart ETags with a different local source.
    tel.set_stage("inspect_initial");
    let hash_start = Instant::now();
    let inspected = inspect(&local, &stamp, None, token).await?;
    tel.add_hash_ms(hash_start.elapsed().as_millis() as u64);
    if cp.md5.is_empty() {
        cp.md5 = inspected.md5;
        cp.sha1 = inspected.sha1;
        store(m, id, &cp)?;
    } else if cp.md5 != inspected.md5 || cp.sha1 != inspected.sha1 {
        return Err(err(
            "CONFLICT",
            "本地文件内容已变化，已保留旧上传进度且不会重复建档",
        ));
    }
    let mime = mime_guess::from_path(&local)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    if cp.pre.is_none() {
        tel.set_stage("pre");
        check(token)?;
        cp.parallel_requested = m.inner.core.settings()["uploadPartConcurrency"]
            .as_u64()
            .unwrap_or(3)
            > 1;
        cp.phase = "pre_started".into();
        store(m, id, &cp)?;
        // Do not cancel an in-flight pre request: wait for its response so an accepted upload cannot be forgotten.
        let result=m.inner.core.post_in_session(generation,"/1/clouddrive/file/upload/pre",json!({"ccp_hash_update":true,"parallel_upload":cp.parallel_requested,"dir_name":"","file_name":name,"format_type":mime,"l_created_at":now(),"l_updated_at":now(),"pdir_fid":parent,"size":size})).await;
        let env = match result {
            Ok(env) => env,
            Err(e) => {
                if is_definitive_rejection(&e) {
                    cp.phase.clear();
                    store(m, id, &cp)?;
                }
                return Err(e);
            }
        };
        cp.part_size = env["metadata"]["part_size"]
            .as_u64()
            .or_else(|| env["data"]["part_size"].as_u64())
            .unwrap_or(0);
        cp.part_thread = env["metadata"]["part_thread"]
            .as_u64()
            .or_else(|| env["data"]["part_thread"].as_u64())
            .unwrap_or(3)
            .max(1);
        if let Some(fid) = env["data"]["fid"].as_str().filter(|s| !s.is_empty()) {
            cp.returned_fid = Some(fid.to_string());
        }
        cp.pre = Some(env["data"].clone());
        cp.phase = "prepared".into();
        store(m, id, &cp)?;
    }
    tel.set_chunk_size(cp.part_size);
    let pre = cp.pre.clone().unwrap();
    if pre["finish"].as_bool() == Some(true) {
        tel.set_rapid(true);
        tel.set_strategy("rapid_pre");
        tel.set_stage("confirm");
        cp.phase = "result".into();
        store(m, id, &cp)?;
        m.progress_with_telemetry(id, size, size, Some(tel))?;
        return confirm(m, id, parent, name, &cp, false, token, generation).await;
    }
    check(token)?;
    if cp.phase == "prepared" {
        tel.set_stage("update_hash");
        let hash_request = json!({"md5":cp.md5,"sha1":cp.sha1,"task_id":required(&pre,"task_id")?});
        check(token)?;
        cp.phase = "hash_started".into();
        store(m, id, &cp)?;
        let hash_result = m
            .inner
            .core
            .post_in_session(generation, "/1/clouddrive/file/update/hash", hash_request)
            .await;
        match hash_result {
            Ok(env) if env["data"]["finish"].as_bool() == Some(true) => {
                if let Some(fid) = env["data"]["fid"].as_str().filter(|s| !s.is_empty()) {
                    cp.returned_fid = Some(fid.to_string());
                }
                tel.set_rapid(true);
                tel.set_strategy("rapid_hash");
                tel.set_stage("confirm");
                cp.phase = "result".into();
                store(m, id, &cp)?;
                m.progress_with_telemetry(id, size, size, Some(tel))?;
                return confirm(m, id, parent, name, &cp, false, token, generation).await;
            }
            Ok(_) => {}
            Err(e) => {
                if is_definitive_rejection(&e) {
                    cp.phase = "prepared".into();
                    store(m, id, &cp)?;
                }
                return Err(e);
            }
        }
        cp.phase = "parts".into();
        store(m, id, &cp)?;
    }
    let key = required(&pre, "obj_key")?;
    let task_id = required(&pre, "task_id")?;
    if size == 0 {
        tel.set_strategy("zero_byte");
        if cp.phase != "result" {
            tel.set_stage("finish_api");
            check(token)?;
            cp.phase = "finish_started".into();
            store(m, id, &cp)?;
            match m
                .inner
                .core
                .post_in_session(
                    generation,
                    "/1/clouddrive/file/upload/finish",
                    json!({"obj_key":key,"task_id":task_id}),
                )
                .await
            {
                Ok(env) => {
                    if let Some(fid) = env["data"]["fid"].as_str().filter(|s| !s.is_empty()) {
                        cp.returned_fid = Some(fid.to_string());
                    }
                }
                Err(e) => {
                    if is_definitive_rejection(&e) {
                        cp.phase = "parts".into();
                        store(m, id, &cp)?;
                    }
                    return Err(e);
                }
            }
            cp.phase = "result".into();
            store(m, id, &cp)?;
        }
        tel.set_stage("confirm");
        return confirm(m, id, parent, name, &cp, false, token, generation).await;
    }
    let part_size = cp.part_size;
    if part_size == 0 || part_size % 65536 != 0 || part_size > 16 * 1024 * 1024 {
        return Err(err(
            "SERVER",
            "服务端分片大小不合法，必须为 65536 倍数且不超过 16 MiB",
        ));
    }
    let bucket = required(&pre, "bucket")?;
    let upload_id = required(&pre, "upload_id")?;
    let base = oss_url(required(&pre, "upload_url")?, bucket, key)?;
    if cp.phase == "parts" {
        let count = size.div_ceil(part_size);
        if count > 10_000 {
            return Err(err("INVALID_ARG", "服务端分片参数会超过 10000 片上限"));
        }
        tel.set_stage("inspect_parts");
        let hash_start = Instant::now();
        let inspected = inspect(&local, &stamp, Some(part_size), token).await?;
        tel.add_hash_ms(hash_start.elapsed().as_millis() as u64);
        if inspected.md5 != cp.md5 || inspected.sha1 != cp.sha1 {
            return Err(err("CONFLICT", "上传源文件内容已变化，已停止分片提交"));
        }
        for (number, tag) in &cp.parts {
            if !inspected
                .part_md5
                .get(number)
                .is_some_and(|expected| expected.eq_ignore_ascii_case(tag))
            {
                return Err(err(
                    "CONTENT_MISMATCH",
                    "已保存上传分片与本地内容不一致，已保留记录",
                ));
            }
        }
        // Per-task rate limiter (fixes H3: one slow task can no longer stall all other uploads).
        let rate = if task.rate_limit_bps == 0 {
            None
        } else {
            Some(Arc::new(UploadRate::new(task.rate_limit_bps.max(16 * 1024))))
        };
        loop {
            let concurrency = if cp.parallel_requested && !cp.parallel_disabled {
                m.inner.core.settings()["uploadPartConcurrency"]
                    .as_u64()
                    .unwrap_or(3)
                    .max(1)
                    .min((256 * 1024 * 1024 / part_size).max(1)) as usize
            } else {
                1
            };
            tel.set_parallel(concurrency);
            tel.set_strategy(if cp.parallel_disabled {
                "seq_fallback"
            } else if concurrency > 1 {
                "parallel_oss"
            } else {
                "seq_oss"
            });
            tel.set_stage("put_parts");
            let contexts = &inspected.contexts;
            let part_hashes = &inspected.part_md5;
            let with_context = cp.parallel_requested && !cp.parallel_disabled;
            let local_ref = &local;
            let stamp_ref = &stamp;
            let pre_ref = &pre;
            let base_ref = &base;
            let mime_ref = mime.as_str();
            let rate = &rate;
            let workers_token = token.child_token();
            let pending = (1..=count)
                .filter(|n| !cp.parts.contains_key(n))
                .collect::<Vec<_>>();
            let mut uploaded = cp
                .parts
                .keys()
                .map(|n| part_size.min(size - (n - 1) * part_size))
                .sum::<u64>();
            m.progress_with_telemetry(id, uploaded, size, Some(tel))?;
            let live = Arc::new(Mutex::new((uploaded, BTreeMap::<u64, u64>::new())));
            let launch = |number: u64| {
                let wtok = workers_token.clone();
                let live = live.clone();
                let manager = m.clone();
                let task_id_owned = id.to_string();
                async move {
                    let _buffer = cancellable(&wtok, async {
                        m.inner
                            .upload_buffers
                            .acquire_many(part_size.div_ceil(1024) as u32)
                            .await
                            .map_err(|_| err("ABORTED", "上传已停止"))
                    })
                    .await?;
                    let expected_md5 = part_hashes
                        .get(&number)
                        .ok_or_else(|| err("CONTENT_MISMATCH", "缺少上传分片摘要"))?;
                    let bytes = read_part(
                        local_ref,
                        stamp_ref,
                        part_size,
                        number,
                        expected_md5,
                        &wtok,
                    )
                    .await?;
                    let length = bytes.len() as u64;
                    let context = if with_context {
                        contexts.get(&number).map(String::as_str)
                    } else {
                        None
                    };
                    let progress: Arc<dyn Fn(u64) + Send + Sync> = Arc::new(move |sent| {
                        let mut guard = live.lock().unwrap();
                        guard.1.insert(number, sent);
                        let cur = guard.0 + guard.1.values().sum::<u64>();
                        let _ = manager.progress(&task_id_owned, cur, size);
                    });
                    let etag = put_part(
                        m,
                        pre_ref,
                        base_ref,
                        mime_ref,
                        bucket,
                        key,
                        upload_id,
                        number,
                        bytes,
                        expected_md5,
                        context,
                        &wtok,
                        generation,
                        rate.clone(),
                        Some(progress),
                        Some(tel),
                    )
                    .await?;
                    Ok::<_, quark_core::Error>((number, length, etag))
                }
            };
            let mut unsaved_parts: u32 = 0;
            let mut last_flush = tokio::time::Instant::now();
            let live_done = live.clone();
            let result = part_window(
                pending,
                concurrency,
                &workers_token,
                launch,
                |number, length, etag| {
                    uploaded += length;
                    let cur = {
                        let mut guard = live_done.lock().unwrap();
                        guard.0 = uploaded;
                        guard.1.remove(&number);
                        guard.0 + guard.1.values().sum::<u64>()
                    };
                    cp.parts.insert(number, etag);
                    unsaved_parts += 1;
                    let should_flush = unsaved_parts >= 4
                        || last_flush.elapsed() >= Duration::from_millis(1500)
                        || cp.parts.len() as u64 == count;
                    if should_flush {
                        store_batched(m, id, &cp, true)?;
                        unsaved_parts = 0;
                        last_flush = tokio::time::Instant::now();
                    }
                    m.progress_with_telemetry(id, cur, size, Some(tel))
                },
            )
            .await;
            if unsaved_parts > 0 {
                let _ = store(m, id, &cp);
            }
            match result {
                Ok(()) => break,
                Err(error)
                    if error.code == "PARALLEL_UNSUPPORTED"
                        && cp.parallel_requested
                        && !cp.parallel_disabled =>
                {
                    check(token)?;
                    cp.parallel_disabled = true;
                    // Reuse the exact same multipart upload, overwriting its
                    // parts in ascending order. Never repeat upload/pre here.
                    cp.parts.clear();
                    store(m, id, &cp)?;
                }
                Err(error) => return Err(error),
            }
        }
        if cp.parts.len() as u64 != count {
            return Err(err("CONTENT_MISMATCH", "上传分片未完整提交"));
        }
        // Every part was already MD5-verified on read + ETag-verified by OSS + FileStamp-checked before/after read.
        // Re-verify FileStamp here instead of a redundant 4th full-disk read + hash pass (P1).
        if FileStamp::from(&fs::metadata(&local).await.map_err(io_err)?)? != stamp {
            return Err(err("CONFLICT", "本地文件在上传过程中发生变化，已停止提交"));
        }
        tel.set_stage("complete_oss");
        let parts: Vec<_> = cp.parts.iter().map(|(n, tag)| (*n, tag.clone())).collect();
        let xml = xml(&parts);
        let digest = STANDARD.encode(Md5::digest(xml.as_bytes()));
        let callback = STANDARD.encode(
            serde_json::to_vec(&pre["callback"]).map_err(|_| err("SERVER", "上传回调格式无效"))?,
        );
        let date = httpdate::fmt_http_date(SystemTime::now());
        let auth = signature(
            m,
            &pre,
            complete_meta(&digest, &date, &callback, bucket, key, upload_id),
            token,
            generation,
        )
        .await?;
        let mut url = base.clone();
        url.query_pairs_mut().append_pair("uploadId", upload_id);
        check(token)?;
        m.inner.core.ensure_session(generation)?;
        cp.phase = "complete_started".into();
        store(m, id, &cp)?;
        let response = m
            .inner
            .core
            .http_client()
            .post(url)
            .header("authorization", auth)
            .header("content-md5", digest)
            .header("content-type", "application/xml")
            .header("x-oss-callback", callback)
            .header("x-oss-date", date)
            .header("x-oss-user-agent", OSS_USER_AGENT)
            .body(xml)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(net_err)?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            tel.set_http_status(status);
            let text = small_response(response).await?;
            let code = text
                .split_once("<Code>")
                .and_then(|(_, s)| s.split_once("</Code>"))
                .map(|(s, _)| s)
                .filter(|s| s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric()))
                .unwrap_or("Rejected");
            // Definitive HTTP rejection from OSS means the commit did NOT succeed — revert phase so user can retry.
            cp.phase = "parts".into();
            store(m, id, &cp)?;
            let mut e = err(
                "SERVER",
                format!("对象存储完成上传返回 HTTP {status} ({code})"),
            );
            e.http_status = Some(status);
            return Err(e);
        }
        let text = small_response(response).await?;
        validate_completion(&text)?;
        cp.phase = "completed".into();
        store(m, id, &cp)?;
    }
    if cp.phase == "completed" {
        tel.set_stage("finish_api");
        check(token)?;
        cp.phase = "finish_started".into();
        store(m, id, &cp)?;
        match m
            .inner
            .core
            .post_in_session(
                generation,
                "/1/clouddrive/file/upload/finish",
                json!({"obj_key":key,"task_id":task_id}),
            )
            .await
        {
            Ok(env) => {
                if let Some(fid) = env["data"]["fid"].as_str().filter(|s| !s.is_empty()) {
                    cp.returned_fid = Some(fid.to_string());
                }
            }
            Err(e) => {
                if is_definitive_rejection(&e) {
                    cp.phase = "completed".into();
                    store(m, id, &cp)?;
                }
                return Err(e);
            }
        }
        cp.phase = "result".into();
        store(m, id, &cp)?;
    }
    tel.set_stage("confirm");
    m.progress_with_telemetry(id, size, size, Some(tel))?;
    confirm(m, id, parent, name, &cp, false, token, generation).await
}
async fn part_window<F, Fut, S>(
    pending: Vec<u64>,
    concurrency: usize,
    workers_token: &CancellationToken,
    launch: F,
    mut save: S,
) -> Result<()>
where
    F: Fn(u64) -> Fut,
    Fut: std::future::Future<Output = Result<(u64, u64, String)>>,
    S: FnMut(u64, u64, String) -> Result<()>,
{
    if concurrency == 0 {
        return Err(err("INVALID_ARG", "上传并发数必须大于零"));
    }
    let mut pending = pending.into_iter();
    let mut work = FuturesUnordered::new();
    for number in pending.by_ref().take(concurrency) {
        work.push(launch(number));
    }
    let mut failure = None;
    while let Some(result) = work.next().await {
        match result {
            Ok((number, length, etag)) => {
                if let Err(error) = save(number, length, etag) {
                    if failure.is_none() {
                        failure = Some(error);
                        workers_token.cancel();
                    }
                }
            }
            Err(error) => {
                if failure.is_none() || error.code != "PARALLEL_UNSUPPORTED" {
                    failure = Some(error);
                    workers_token.cancel();
                }
            }
        }
        // Stop issuing new PUTs on first failure and cancel siblings immediately (H6).
        if failure.is_none() {
            if let Some(number) = pending.next() {
                work.push(launch(number));
            }
        }
    }
    failure.map_or(Ok(()), Err)
}

async fn read_part(
    path: &Path,
    stamp: &FileStamp,
    part_size: u64,
    number: u64,
    expected_md5: &str,
    token: &CancellationToken,
) -> Result<bytes::Bytes> {
    check(token)?;
    let start = number
        .checked_sub(1)
        .and_then(|n| n.checked_mul(part_size))
        .filter(|start| *start < stamp.size)
        .ok_or_else(|| err("CONTENT_MISMATCH", "上传分片范围无效"))?;
    let path_buf = path.to_path_buf();
    let stamp = stamp.clone();
    let expected_md5 = expected_md5.to_owned();
    let tok = token.clone();
    tokio::task::spawn_blocking(move || -> Result<bytes::Bytes> {
        use std::io::{Read, Seek, SeekFrom};
        check(&tok)?;
        if FileStamp::from(&std::fs::metadata(&path_buf).map_err(io_err)?)? != stamp {
            return Err(err("CONFLICT", "本地文件在上传期间发生变化，已停止提交"));
        }
        let mut file = std::fs::File::open(&path_buf).map_err(io_err)?;
        if FileStamp::from(&file.metadata().map_err(io_err)?)? != stamp {
            return Err(err("CONFLICT", "本地上传文件已被替换"));
        }
        file.seek(SeekFrom::Start(start)).map_err(io_err)?;
        let mut bytes = vec![0u8; part_size.min(stamp.size - start) as usize];
        file.read_exact(&mut bytes).map_err(io_err)?;
        check(&tok)?;
        if !format!("{:x}", Md5::digest(&bytes)).eq_ignore_ascii_case(&expected_md5) {
            return Err(err("CONFLICT", "本地上传分片内容已变化，已停止传输"));
        }
        if FileStamp::from(&std::fs::metadata(&path_buf).map_err(io_err)?)? != stamp {
            return Err(err("CONFLICT", "本地文件在上传期间发生变化，已停止提交"));
        }
        Ok(bytes.into())
    })
    .await
    .map_err(|_| err("LOCAL_IO", "读取上传分片失败"))?
}

async fn small_response(mut response: reqwest::Response) -> Result<String> {
    const MAX: usize = 64 * 1024;
    if response.content_length().is_some_and(|n| n > MAX as u64) {
        return Err(err("SERVER", "对象存储响应过大"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(net_err)? {
        if body.len().saturating_add(chunk.len()) > MAX {
            return Err(err("SERVER", "对象存储响应过大"));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| err("SERVER", "对象存储响应编码无效"))
}

fn validate_completion(text: &str) -> Result<()> {
    let lower = text.trim().to_ascii_lowercase();
    if lower.contains("<error") || lower.is_empty() {
        return Err(err("SERVER", "对象存储没有确认完成上传"));
    }
    if lower.contains("<completemultipartuploadresult") {
        return Ok(());
    }
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        if value.as_object().is_some_and(|o| !o.is_empty())
            && value["success"] != false
            && !value["code"]
                .as_i64()
                .is_some_and(|code| code != 0 && code != 200)
            && !value["status"].as_str().is_some_and(|s| {
                ["error", "failed", "fail"].contains(&s.to_ascii_lowercase().as_str())
            })
        {
            return Ok(());
        }
    }
    Err(err(
        "SERVER",
        "对象存储完成响应未通过检查，已保留待确认进度",
    ))
}

#[allow(clippy::too_many_arguments)]
async fn put_part(
    m: &TransferManager,
    pre: &Value,
    base: &reqwest::Url,
    mime: &str,
    bucket: &str,
    key: &str,
    upload_id: &str,
    number: u64,
    bytes: bytes::Bytes,
    expected_md5: &str,
    hash_context: Option<&str>,
    token: &CancellationToken,
    generation: u64,
    rate: Option<Arc<UploadRate>>,
    on_progress: Option<Arc<dyn Fn(u64) + Send + Sync>>,
    tel: Option<&RunTelemetry>,
) -> Result<String> {
    for attempt in 0..5u32 {
        check(token)?;
        if attempt > 0 {
            if let Some(progress) = &on_progress {
                progress(0);
            }
        }
        let result = async {
            let date = httpdate::fmt_http_date(SystemTime::now());
            let auth = signature(
                m,
                pre,
                put_meta_with_ctx(mime, &date, bucket, key, number, upload_id, hash_context),
                token,
                generation,
            )
            .await?;
            let mut url = base.clone();
            url.query_pairs_mut()
                .append_pair("partNumber", &number.to_string())
                .append_pair("uploadId", upload_id);
            cancellable(
                token,
                put_request_streaming(
                    &m.inner.core.http_client(),
                    url,
                    mime,
                    &date,
                    &auth,
                    bytes.clone(),
                    Some(expected_md5),
                    hash_context,
                    rate.clone(),
                    on_progress.clone(),
                    tel,
                ),
            )
            .await
        }
        .await;
        match result {
            Ok(etag) => return Ok(etag),
            Err(e)
                if attempt < 4
                    && ["NETWORK", "TIMEOUT", "RATE_LIMIT", "SIGNATURE_EXPIRED"]
                        .contains(&e.code.as_str()) =>
            {
                if let Some(tel) = tel {
                    tel.inc_retry();
                    if let Some(st) = e.http_status {
                        tel.set_http_status(st);
                    }
                }
                let base_ms = if e.code == "RATE_LIMIT" { 800 } else { 400 };
                cancellable(token, async {
                    tokio::time::sleep(Duration::from_millis((base_ms * (1u64 << attempt)).min(4800))).await;
                    Ok(())
                })
                .await?;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

struct UploadRate {
    bps: u64,
    next: Arc<tokio::sync::Mutex<tokio::time::Instant>>,
}
impl UploadRate {
    fn new(bps: u64) -> Self {
        Self {
            bps: bps.max(16 * 1024),
            next: Arc::new(tokio::sync::Mutex::new(tokio::time::Instant::now())),
        }
    }
}
#[cfg(test)]
async fn put_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    mime: &str,
    date: &str,
    auth: &str,
    bytes: bytes::Bytes,
    hash_context: Option<&str>,
) -> Result<String> {
    put_request_limited(client, url, mime, date, auth, bytes, hash_context, None).await
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
async fn put_request_limited(
    client: &reqwest::Client,
    url: reqwest::Url,
    mime: &str,
    date: &str,
    auth: &str,
    bytes: bytes::Bytes,
    hash_context: Option<&str>,
    rate: Option<Arc<UploadRate>>,
) -> Result<String> {
    put_request_streaming(
        client,
        url,
        mime,
        date,
        auth,
        bytes,
        None,
        hash_context,
        rate,
        None,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn put_request_streaming(
    client: &reqwest::Client,
    url: reqwest::Url,
    mime: &str,
    date: &str,
    auth: &str,
    bytes: bytes::Bytes,
    expected_md5: Option<&str>,
    hash_context: Option<&str>,
    rate: Option<Arc<UploadRate>>,
    on_progress: Option<Arc<dyn Fn(u64) + Send + Sync>>,
    tel: Option<&RunTelemetry>,
) -> Result<String> {
    let expected = match expected_md5 {
        Some(h) if h.len() == 32 => h.to_string(),
        _ => format!("{:x}", Md5::digest(&bytes)),
    };
    let length = bytes.len();
    let timeout = 180
        + rate
            .as_ref()
            .map(|r| 64 * length as u64 / r.bps.max(1))
            .unwrap_or(0);
    let wire_counter = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let body = if rate.is_some() || on_progress.is_some() || length > STREAM_CHUNK_BYTES {
        let step = if rate.is_some() { 64 * 1024 } else { STREAM_CHUNK_BYTES };
        let wc = wire_counter.clone();
        let stream = futures_util::stream::unfold(
            (bytes, 0usize, rate, on_progress),
            move |(bytes, offset, rate, on_progress)| {
                let wc = wc.clone();
                async move {
                    if offset >= bytes.len() {
                        return None;
                    }
                    let end = (offset + step).min(bytes.len());
                    let delta = (end - offset) as u64;
                    if let Some(ref rate) = rate {
                        let mut next = rate.next.lock().await;
                        let now_inst = tokio::time::Instant::now();
                        if *next > now_inst {
                            tokio::time::sleep_until(*next).await;
                        }
                        let after = tokio::time::Instant::now();
                        let dt = Duration::from_secs_f64(delta as f64 / rate.bps.max(1) as f64);
                        // Token-bucket style advancement avoids Windows 15.6ms sleep overshoot capping throughput.
                        let floor = after.checked_sub(Duration::from_millis(50)).unwrap_or(after);
                        *next = (*next + dt).max(floor);
                    }
                    wc.fetch_add(delta, std::sync::atomic::Ordering::Relaxed);
                    if let Some(ref prog) = on_progress {
                        prog(end as u64);
                    }
                    Some((
                        Ok::<_, std::io::Error>(bytes.slice(offset..end)),
                        (bytes, end, rate, on_progress),
                    ))
                }
            },
        );
        reqwest::Body::wrap_stream(stream)
    } else {
        wire_counter.store(length as u64, std::sync::atomic::Ordering::Relaxed);
        reqwest::Body::from(bytes)
    };
    let mut request = client
        .put(url)
        .header("authorization", auth)
        .header("content-type", mime)
        .header("content-length", length)
        .header("x-oss-date", date)
        .header("x-oss-user-agent", OSS_USER_AGENT)
        .body(body)
        .timeout(Duration::from_secs(timeout));
    if let Some(context) = hash_context {
        request = request.header("X-Oss-Hash-Ctx", context);
    }
    // This client has no cookie store; cloud-account cookies are never sent to OSS.
    let response = request.send().await.map_err(net_err)?;
    let status = response.status();
    let etag = response
        .headers()
        .get("etag")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());
    let text = small_response(response).await?;
    if !status.is_success() {
        let lower = text.to_ascii_lowercase();
        let protocol_rejection = status.as_u16() == 400
            && ([
                "partnotsequential",
                "contextcomparefailed",
                "invalidpartorder",
                "hash-ctx",
                "hashctx",
            ]
            .iter()
            .any(|s| lower.contains(s))
                || (hash_context.is_some() && lower.contains("invalidargument")));
        let mut e = err(
            if protocol_rejection {
                "PARALLEL_UNSUPPORTED"
            } else if status.as_u16() == 403 {
                "SIGNATURE_EXPIRED"
            } else if status.as_u16() == 429 {
                "RATE_LIMIT"
            } else if status.as_u16() == 408 || status.is_server_error() {
                "NETWORK"
            } else {
                "SERVER"
            },
            format!("上传分片返回 HTTP {}", status.as_u16()),
        );
        e.http_status = Some(status.as_u16());
        return Err(e);
    }
    if text.to_ascii_lowercase().contains("<error") {
        return Err(err("SERVER", "对象存储未接受上传分片"));
    }
    let etag = etag.ok_or_else(|| err("SERVER", "上传分片未返回 ETag"))?;
    if etag.len() != 32
        || !etag.bytes().all(|b| b.is_ascii_hexdigit())
        || !etag.eq_ignore_ascii_case(&expected)
    {
        return Err(err(
            "CONTENT_MISMATCH",
            "上传分片 ETag 与本地 MD5 不一致，已停止完成上传",
        ));
    }
    if let Some(tel) = tel {
        tel.add_wire_bytes(wire_counter.load(std::sync::atomic::Ordering::Relaxed));
    }
    Ok(etag)
}
async fn matching(
    m: &TransferManager,
    parent: &str,
    name: &str,
    token: &CancellationToken,
    generation: u64,
) -> Result<Vec<Value>> {
    use unicode_normalization::UnicodeNormalization;
    let normalized = name.nfc().collect::<String>();
    let mut matches = Vec::new();
    for page in 1..=1000 {
        m.inner.core.ensure_session(generation)?;
        let result = cancellable(
            token,
            m.inner
                .core
                .call("fs.list", json!({"pdirFid":parent,"page":page,"size":100})),
        )
        .await?;
        m.inner.core.ensure_session(generation)?;
        let list = result["list"]
            .as_array()
            .ok_or_else(|| err("SERVER", "目录列表格式无效"))?;
        for item in list {
            if item["dir"].as_bool() != Some(true)
                && item["name"]
                    .as_str()
                    .is_some_and(|s| s.nfc().collect::<String>() == normalized)
                && !matches.iter().any(|old: &Value| old["fid"] == item["fid"])
            {
                matches.push(item.clone());
            }
        }
        if list.is_empty() || result["hasMore"].as_bool() != Some(true) {
            return Ok(matches);
        }
    }
    Err(err("TASK_FAILED", "目标目录过大，无法确认上传归属"))
}
async fn confirm(
    m: &TransferManager,
    id: &str,
    parent: &str,
    name: &str,
    checkpoint: &Checkpoint,
    require_digest: bool,
    token: &CancellationToken,
    generation: u64,
) -> Result<()> {
    // Fast path (P2): if pre/finish already returned the exact fid, verify via a single fs.info call
    // instead of paginating up to 1,000 fs.list pages.
    if let Some(fid) = checkpoint.returned_fid.as_deref().filter(|s| !s.is_empty()) {
        m.inner.core.ensure_session(generation)?;
        if let Ok(item) = cancellable(token, m.inner.core.call("fs.info", json!(fid))).await {
            if item["size"].as_u64() == Some(checkpoint.size)
                && verified_result(&item, checkpoint, require_digest)?
            {
                m.update(id, |t| t.fid = Some(fid.to_string()), true)?;
                return Ok(());
            }
        }
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        check(token)?;
        let files = tokio::time::timeout_at(deadline, matching(m, parent, name, token, generation))
            .await
            .map_err(|_| {
                err(
                    "TASK_FAILED",
                    "确认上传结果超时；重试只核对结果，不重复上传",
                )
            })??;
        let changed: Vec<_> = files
            .iter()
            .filter(|item| {
                item["size"].as_u64() == Some(checkpoint.size)
                    && checkpoint
                        .baseline
                        .as_deref()
                        .unwrap_or(&[])
                        .iter()
                        .find(|old| old["fid"] == item["fid"])
                        .is_none_or(|old| {
                            old["size"] != item["size"]
                                || item["updatedAt"].as_u64().unwrap_or(0)
                                    > old["updatedAt"].as_u64().unwrap_or(0)
                        })
            })
            .collect();
        if changed.len() == 1 {
            if verified_result(changed[0], checkpoint, require_digest)? {
                let fid = changed[0]["fid"]
                    .as_str()
                    .ok_or_else(|| err("TASK_FAILED", "上传结果缺少fid"))?
                    .to_string();
                m.update(id, |t| t.fid = Some(fid), true)?;
                return Ok(());
            }
        }
        if changed.len() > 1 {
            return Err(err("CONFLICT", "出现多个同名上传结果，请核对归属"));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(err(
                "TASK_FAILED",
                "服务端已接收上传，但尚未确认文件大小；重试只核对结果，不重复上传",
            ));
        }
        cancellable(token, async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            Ok(())
        })
        .await?;
    }
}

fn verified_result(item: &Value, checkpoint: &Checkpoint, require_digest: bool) -> Result<bool> {
    let mut verified = false;
    for (field, expected) in [("md5", &checkpoint.md5), ("sha1", &checkpoint.sha1)] {
        if let Some(actual) = item[field].as_str().filter(|s| !s.is_empty()) {
            if expected.is_empty() || !actual.eq_ignore_ascii_case(expected) {
                return Err(err(
                    "CONTENT_MISMATCH",
                    "云端上传结果摘要与本地文件不一致，已保留待核对记录",
                ));
            }
            verified = true;
        }
    }
    Ok(verified || !require_digest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn prefix_inspection_and_saved_part_replay_bind_to_actual_source_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.bin");
        let bytes: Vec<_> = (0..131_083).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        let stamp = FileStamp::from(&std::fs::metadata(&path).unwrap()).unwrap();
        let token = CancellationToken::new();
        let result = inspect(&path, &stamp, Some(65536), &token).await.unwrap();
        assert_eq!(result.md5, format!("{:x}", Md5::digest(&bytes)));
        assert_eq!(result.sha1, format!("{:x}", Sha1::digest(&bytes)));
        assert_eq!(result.contexts.keys().copied().collect::<Vec<_>>(), [2, 3]);
        let decoded: Value =
            serde_json::from_slice(&STANDARD.decode(&result.contexts[&3]).unwrap()).unwrap();
        assert_eq!(decoded["Nl"], (131072u64 * 8).to_string());
        assert_eq!(
            read_part(&path, &stamp, 65536, 3, &result.part_md5[&3], &token)
                .await
                .unwrap()
                .as_ref(),
            &bytes[131072..]
        );
        let original_modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let mut changed = bytes;
        changed[0] ^= 1;
        std::fs::write(&path, &changed).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_modified))
            .unwrap();
        assert_eq!(
            FileStamp::from(&std::fs::metadata(&path).unwrap())
                .unwrap()
                .modified,
            stamp.modified
        );
        assert_eq!(
            read_part(&path, &stamp, 65536, 1, &result.part_md5[&1], &token)
                .await
                .unwrap_err()
                .code,
            "CONFLICT"
        );
        token.cancel();
        assert_eq!(
            inspect(&path, &stamp, Some(65536), &token)
                .await
                .err()
                .unwrap()
                .code,
            "ABORTED"
        );
    }

    fn fixture(
        status: &str,
        body: &str,
        etag: Option<&str>,
    ) -> (reqwest::Url, std::thread::JoinHandle<Vec<u8>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/part", listener.local_addr().unwrap()))
            .unwrap();
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n{body}",
            body.len(),
            etag.map(|s| format!("ETag: \"{s}\"\r\n"))
                .unwrap_or_default()
        );
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let size = socket.read(&mut buffer).unwrap();
                if size == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..size]);
                if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = header
                        .lines()
                        .find_map(|s| s.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(reply.as_bytes()).unwrap();
            bytes
        });
        (url, handle)
    }

    #[tokio::test]
    async fn actual_http_put_carries_prefix_without_cookies_and_rejects_bad_etag() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let payload = bytes::Bytes::from_static(b"fixture-upload-bytes");
        let md5 = format!("{:x}", Md5::digest(&payload));
        let (url, handle) = fixture("200 OK", "", Some(&md5));
        assert_eq!(
            put_request(
                &client,
                url,
                "application/octet-stream",
                "date",
                "fixture-auth",
                payload.clone(),
                Some("Y3R4")
            )
            .await
            .unwrap(),
            md5
        );
        let request = String::from_utf8(handle.join().unwrap())
            .unwrap()
            .to_ascii_lowercase();
        assert!(request.contains("x-oss-hash-ctx: y3r4\r\n"));
        assert!(!request.contains("cookie:"));
        assert!(request.ends_with("fixture-upload-bytes"));
        let (url, handle) = fixture("200 OK", "", Some(&md5.to_ascii_uppercase()));
        assert_eq!(
            put_request(
                &client,
                url,
                "application/octet-stream",
                "date",
                "fixture-auth",
                payload.clone(),
                None
            )
            .await
            .unwrap(),
            md5.to_ascii_uppercase()
        );
        handle.join().unwrap();
        let (url, handle) = fixture("200 OK", "", Some("00000000000000000000000000000000"));
        assert_eq!(
            put_request(
                &client,
                url,
                "application/octet-stream",
                "date",
                "fixture-auth",
                payload.clone(),
                None
            )
            .await
            .unwrap_err()
            .code,
            "CONTENT_MISMATCH"
        );
        handle.join().unwrap();
        let (url, handle) = fixture(
            "400 Bad Request",
            "<Error><Code>ContextCompareFailed</Code></Error>",
            None,
        );
        assert_eq!(
            put_request(
                &client,
                url,
                "application/octet-stream",
                "date",
                "fixture-auth",
                payload,
                Some("Y3R4")
            )
            .await
            .unwrap_err()
            .code,
            "PARALLEL_UNSUPPORTED"
        );
        handle.join().unwrap();
    }

    #[test]
    fn completion_errors_and_cloud_digest_mismatches_cannot_finish_a_task() {
        assert!(validate_completion(
            "<CompleteMultipartUploadResult><ETag>a</ETag></CompleteMultipartUploadResult>"
        )
        .is_ok());
        assert!(validate_completion(r#"{"code":0,"data":{}}"#).is_ok());
        for value in [
            "",
            "<Error><Code>InvalidPart</Code></Error>",
            r#"{"code":500}"#,
            r#"{"success":false}"#,
            "<html>bad gateway</html>",
        ] {
            assert!(validate_completion(value).is_err(), "{value}");
        }
        let cp = Checkpoint {
            md5: "aa".into(),
            sha1: "bb".into(),
            ..Checkpoint::default()
        };
        assert!(verified_result(&json!({"md5":"aa"}), &cp, true).unwrap());
        assert!(!verified_result(&json!({}), &cp, true).unwrap());
        assert!(verified_result(&json!({}), &cp, false).unwrap());
        assert_eq!(
            verified_result(&json!({"md5":"cc"}), &cp, false)
                .unwrap_err()
                .code,
            "CONTENT_MISMATCH"
        );
    }
    #[tokio::test]
    async fn bandwidth_limit_applies_to_the_actual_http_request_body() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let bytes = bytes::Bytes::from(vec![9u8; 128 * 1024]);
        let digest = format!("{:x}", Md5::digest(&bytes));
        let (url, server) = fixture("200 OK", "", Some(&digest));
        let start = std::time::Instant::now();
        let tag = put_request_limited(
            &client,
            url,
            "application/octet-stream",
            "date",
            "test",
            bytes.clone(),
            None,
            Some(std::sync::Arc::new(UploadRate::new(512 * 1024))),
        )
        .await
        .unwrap();
        assert_eq!(tag, digest);
        assert!(
            start.elapsed() >= Duration::from_millis(100),
            "second chunk must wait for its bandwidth reservation"
        );
        let request = server.join().unwrap();
        assert!(request.ends_with(&bytes));
    }
}
