use crate::{
    manager::{
        cancellable, check, err, io_err, net_err, Result, RunTelemetry, Task, TransferManager,
    },
    protocol::{content_range, is_windows_reserved_name, safe_name},
};
use futures_util::StreamExt;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha1::Sha1;
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    ops::Range,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
    task::JoinSet,
};
#[cfg(test)]
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::sync::CancellationToken;
const PART: u64 = 1024 * 1024;
// Two buffers sustain one pending write without increasing the 1 MiB per stream budget.
const WRITE_BUF_CAP: usize = 512 * 1024;
const HASH_BUF_CAP: usize = 4 * 1024 * 1024;
const CHECKPOINT_VERSION: u32 = 2;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const SLOW_NODE_SWITCH_COOLDOWN: Duration = Duration::from_secs(20);
const AUTO_RAMP_INITIAL_PARALLEL: usize = 4;
const AUTO_RAMP_MIN_EXPAND_BPS: u64 = 10 * 1024 * 1024;
const GLOBAL_AUTO_SOCKET_BUDGET: usize = 24;

fn cdn_host_class(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or("");
    if host.is_empty() {
        return "other".into();
    }
    if host == "quark.cn" || host.ends_with(".quark.cn") {
        if let Some(prefix) = host.split('.').next() {
            let clean: String = prefix
                .chars()
                .take(20)
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            if clean.starts_with("dl-") && clean.len() >= 4 {
                return clean;
            }
        }
        return "quark-cdn".into();
    }
    if host.ends_with(".aliyuncs.com") {
        return "aliyun-oss".into();
    }
    if host.ends_with(".uc.cn") {
        return "uc-cdn".into();
    }
    if host == "127.0.0.1" || host == "localhost" {
        return "loopback".into();
    }
    "other".into()
}

fn cdn_cache_status(headers: &reqwest::header::HeaderMap) -> Option<&'static str> {
    for key in ["x-cache", "x-cache-status", "cf-cache-status"] {
        if let Some(val) = headers.get(key).and_then(|v| v.to_str().ok()) {
            let up = val.to_ascii_uppercase();
            for tok in ["HIT", "MISS", "BYPASS"] {
                if up
                    .split(|c: char| !c.is_ascii_alphanumeric())
                    .any(|w| w == tok)
                {
                    return Some(tok);
                }
            }
        }
    }
    None
}

#[cfg(test)]
fn choose_chunk_size(total: u64) -> u64 {
    quark_core::tuning::TuningProfile::default().choose_chunk_size(total)
}

fn choose_chunk_size_with_tuning(total: u64, tuning: &quark_core::tuning::TuningProfile) -> u64 {
    tuning.choose_chunk_size(total)
}

/// Singleflight shared CDN URL so a 403 expiration or slow-node stall triggers ONE refresh
/// reused by all active and future workers.
struct SharedLink {
    state: RwLock<(String, u64)>,
    refresh_lock: tokio::sync::Mutex<()>,
    last_switch_at: Mutex<Option<Instant>>,
}
impl SharedLink {
    fn new(url: String) -> Self {
        Self {
            state: RwLock::new((url, 0)),
            refresh_lock: tokio::sync::Mutex::new(()),
            last_switch_at: Mutex::new(None),
        }
    }
    fn current(&self) -> (String, u64) {
        self.state.read().unwrap().clone()
    }
    async fn refresh_if_stale(
        &self,
        seen_gen: u64,
        m: &TransferManager,
        fid: &str,
        token: &CancellationToken,
        tel: Option<&RunTelemetry>,
    ) -> Result<String> {
        let _guard = self.refresh_lock.lock().await;
        {
            let cur = self.state.read().unwrap();
            if cur.1 != seen_gen {
                return Ok(cur.0.clone());
            }
        }
        let fresh = get_link(m, fid, token).await?;
        if let Some(tel) = tel {
            tel.inc_link_refresh();
        }
        let mut cur = self.state.write().unwrap();
        cur.0 = fresh.clone();
        cur.1 = cur.1.wrapping_add(1);
        Ok(fresh)
    }
    /// Best-effort slow/stalled CDN node switch using official `old_dl_url` + `dns_sw` hint.
    async fn refresh_for_slow_node(
        &self,
        seen_gen: u64,
        m: &TransferManager,
        fid: &str,
        token: &CancellationToken,
        tel: Option<&RunTelemetry>,
    ) {
        let _guard = self.refresh_lock.lock().await;
        let prev_url = {
            let cur = self.state.read().unwrap();
            if cur.1 != seen_gen {
                return;
            }
            cur.0.clone()
        };
        {
            let last = self.last_switch_at.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < SLOW_NODE_SWITCH_COOLDOWN) {
                return;
            }
        }
        if let Ok(fresh) = get_link_with_switch(m, fid, Some(&prev_url), token).await {
            *self.last_switch_at.lock().unwrap() = Some(Instant::now());
            if let Some(tel) = tel {
                tel.inc_link_refresh();
                let old_host = reqwest::Url::parse(&prev_url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned));
                let new_host = reqwest::Url::parse(&fresh)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned));
                if old_host.is_some() && new_host.is_some() && old_host != new_host {
                    tel.inc_cdn_node_switch();
                }
            }
            let mut cur = self.state.write().unwrap();
            cur.0 = fresh;
            cur.1 = cur.1.wrapping_add(1);
        }
    }
}

fn valid_chunk_size(size: u64) -> bool {
    size >= PART && size <= 16 * PART && size % PART == 0
}

fn write_exact_at(file: &std::fs::File, mut offset: u64, mut data: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_all_at(data, offset)?;
        let _ = (&mut offset, &mut data);
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        while !data.is_empty() {
            let n = file.seek_write(data, offset)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "write_exact_at returned 0",
                ));
            }
            offset += n as u64;
            data = &data[n..];
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct DonePart {
    len: u64,
    #[serde(default)]
    sha256: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Checkpoint {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    chunk_size: u64,
    target: String,
    temp: String,
    total: u64,
    #[serde(default)]
    etag: String,
    #[serde(default)]
    parts: BTreeMap<u64, DonePart>,
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    md5: String,
    #[serde(default)]
    sha1: String,
    #[serde(default)]
    sha256: String,
}
fn parse_checkpoint(t: &Task) -> Result<Checkpoint> {
    if t.checkpoint.as_object().is_some_and(|o| o.is_empty()) {
        Ok(Checkpoint::default())
    } else {
        serde_json::from_value(t.checkpoint.clone())
            .map_err(|_| err("LOCAL_IO", "下载进度格式无效，原文件已保留"))
    }
}
fn store(m: &TransferManager, id: &str, cp: &Checkpoint) -> Result<()> {
    m.checkpoint(
        id,
        serde_json::to_value(cp).map_err(|_| err("LOCAL_IO", "下载进度无法序列化"))?,
    )
}
fn path_key(path: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        path.nfc().collect::<String>().to_lowercase()
    } else {
        path.into()
    }
}

pub(crate) async fn run(
    m: &TransferManager,
    id: &str,
    token: &CancellationToken,
    tel: &Arc<RunTelemetry>,
) -> Result<()> {
    tel.set_stage("fs_info");
    let generation = m.bound_generation()?;
    let task = m.task(id)?;
    if task.account_key.is_none() || task.account_key != m.inner.core.account_key() {
        return Err(err("ACCOUNT_MISMATCH", "传输所属账号已改变"));
    }
    m.inner.core.ensure_session(generation)?;
    let fid = task
        .fid
        .clone()
        .ok_or_else(|| err("INVALID_ARG", "缺少下载文件 id"))?;
    let info_start = Instant::now();
    let info = cancellable(token, m.inner.core.call("fs.info", json!(fid))).await?;
    tel.add_link_ms(info_start.elapsed().as_millis() as u64);
    if info["dir"].as_bool().unwrap_or(false) {
        return Err(err("INVALID_ARG", "请进入文件夹选择要下载的文件"));
    }
    let total = info["size"]
        .as_u64()
        .ok_or_else(|| err("SERVER", "服务端没有返回有效文件大小"))?;
    tel.set_size(total);
    let name = safe_name(info["name"].as_str().unwrap_or(&task.name));
    let mut cp = parse_checkpoint(&task)?;
    if !cp.temp.is_empty() && (cp.version != CHECKPOINT_VERSION || !valid_chunk_size(cp.chunk_size))
    {
        return Err(err(
            "CHECKPOINT_VERSION",
            "旧版下载分片格式不兼容，请取消此任务后重新下载；原文件已保留",
        ));
    }
    if !cp.temp.is_empty() && cp.total != total {
        return Err(err("CONFLICT", "云端文件大小已改变，请取消并重新下载"));
    }
    let tuning = m.inner.core.tuning();
    if cp.target.is_empty() {
        tel.set_stage("reserve");
        let dir = PathBuf::from(task.local_dir.as_deref().unwrap_or(""));
        fs::create_dir_all(&dir).await.map_err(io_err)?;
        cp.version = CHECKPOINT_VERSION;
        cp.chunk_size = choose_chunk_size_with_tuning(total, &tuning);
        cp.total = total;
        cp.target = reserve(m, id, &dir, &name)
            .await?
            .to_string_lossy()
            .into_owned();
        cp.temp = format!("{}.{}.qkdownloading", cp.target, id);
        // Record ownership before creating the temporary file; clean up .qkreserve if persistence fails.
        if let Err(e) = store(m, id, &cp) {
            let _ = fs::remove_file(format!("{}.qkreserve", cp.target)).await;
            return Err(e);
        }
        if let Err(e) = m.update(
            id,
            |t| {
                t.local_path = Some(cp.target.clone());
                t.name = name.clone();
                t.size = total;
            },
            true,
        ) {
            let _ = fs::remove_file(format!("{}.qkreserve", cp.target)).await;
            return Err(e);
        }
    }
    tel.set_chunk_size(cp.chunk_size);
    let temp = PathBuf::from(&cp.temp);
    validate_owned(&task, &cp)?;
    if cp.ready {
        tel.set_strategy("ready_resume");
        tel.set_resumed(true);
        tel.set_stage("publish");
        // Verify using the fastest single stored digest (MD5 > SHA1 > SHA256) instead of recomputing all 3.
        let verify_ready_file = |p: PathBuf,
                                 cp_md5: String,
                                 cp_sha1: String,
                                 cp_sha256: String,
                                 tok: CancellationToken| async move {
            let (nm, ns1, ns256) = if !cp_md5.is_empty() {
                (true, false, false)
            } else if !cp_sha1.is_empty() {
                (false, true, false)
            } else if !cp_sha256.is_empty() {
                (false, false, true)
            } else {
                (false, false, false)
            };
            if !nm && !ns1 && !ns256 {
                return Ok((true, 0u64));
            }
            let hs = Instant::now();
            let (m, s1, s256) = hash_file_selected(&p, nm, ns1, ns256, &tok).await?;
            let elapsed = hs.elapsed().as_millis() as u64;
            let matched = (!nm || m == cp_md5) && (!ns1 || s1 == cp_sha1) && (!ns256 || s256 == cp_sha256);
            Ok::<(bool, u64), quark_core::Error>((matched, elapsed))
        };
        if fs::try_exists(&cp.target).await.map_err(io_err)? {
            let (matched, elapsed) = verify_ready_file(
                PathBuf::from(&cp.target),
                cp.md5.clone(),
                cp.sha1.clone(),
                cp.sha256.clone(),
                token.clone(),
            )
            .await?;
            tel.add_hash_ms(elapsed);
            if !matched || fs::metadata(&cp.target).await.map_err(io_err)?.len() != total {
                return Err(err("CONFLICT", "下载目标已被其他文件占用"));
            }
            let _ = fs::remove_file(&temp).await;
            let _ = fs::remove_file(format!("{}.qkreserve", cp.target)).await;
            return m.progress_with_telemetry(id, total, total, Some(tel));
        }
        let (matched, elapsed) = verify_ready_file(
            temp.clone(),
            cp.md5.clone(),
            cp.sha1.clone(),
            cp.sha256.clone(),
            token.clone(),
        )
        .await?;
        tel.add_hash_ms(elapsed);
        if fs::metadata(&temp).await.map_err(io_err)?.len() != total || !matched {
            return Err(err(
                "CONTENT_MISMATCH",
                "已完成下载的临时文件损坏，原文件已保留",
            ));
        }
        m.check_session()?;
        publish(&temp, Path::new(&cp.target), token).await?;
        return m.progress_with_telemetry(id, total, total, Some(tel));
    }

    let settings = m.inner.core.settings();
    let strategy_pref = settings["downloadStrategy"].as_str().unwrap_or("auto");
    let use_small_direct = cp.parts.is_empty()
        && strategy_pref != "parallel"
        && (total == 0 || (tuning.small_file_direct_max_bytes > 0 && total <= tuning.small_file_direct_max_bytes));

    let inline_digest = if use_small_direct {
        // Fast path for small files: skip the 1-byte Range probe and download in one direct stream
        // with inline hashing (eliminates 1 RTT + full post-download disk re-read).
        tel.set_stage("get_link");
        let link_start = Instant::now();
        let link = get_link(m, &fid, token).await?;
        tel.add_link_ms(link_start.elapsed().as_millis() as u64);
        let exists = fs::try_exists(&temp).await.map_err(io_err)?;
        if exists {
            let meta = fs::symlink_metadata(&temp).await.map_err(io_err)?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(err("CONFLICT", "下载临时路径已被替换"));
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp)
            .await
            .map_err(io_err)?;
        file.set_len(total).await.map_err(io_err)?;
        drop(file);
        cp.etag.clear();
        cp.parts.clear();
        tel.set_strategy(if total == 0 {
            "single_zero"
        } else {
            "single_small_direct"
        });
        tel.set_stage("single");
        let xfer_start = Instant::now();
        let digests = single_with_tel(m, id, &fid, &link, &temp, &mut cp, token, Some(tel)).await?;
        tel.add_transfer_ms(xfer_start.elapsed().as_millis() as u64);
        Some(digests)
    } else {
        // Probe server FIRST (with retries on transient failures + draining 1-byte body for keep-alive)
        // before touching disk or spending multi-GB I/O on verify_parts().
        tel.set_stage("probe");
        let link_start = Instant::now();
        let mut link = get_link(m, &fid, token).await?;
        tel.add_link_ms(link_start.elapsed().as_millis() as u64);
        let probe_start = Instant::now();
        let probe = {
            let mut last_probe_err = None;
            let mut ok_probe = None;
            for attempt in 0..3u32 {
                check(token)?;
                let mut resp = match send(m, &link, Some((0, 0)), None, token).await {
                    Ok(r) => r,
                    Err(e) if attempt < 2 && matches!(e.code.as_str(), "NETWORK" | "RATE_LIMIT") => {
                        tel.inc_retry();
                        last_probe_err = Some(e);
                        cancellable(token, async {
                            tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                            Ok(())
                        })
                        .await?;
                        continue;
                    }
                    Err(e) => return Err(e),
                };
                if resp.status() == reqwest::StatusCode::FORBIDDEN {
                    let _ = resp.bytes().await;
                    link = get_link(m, &fid, token).await?;
                    tel.inc_link_refresh();
                    resp = send(m, &link, Some((0, 0)), None, token).await?;
                }
                if matches!(
                    resp.status(),
                    reqwest::StatusCode::TOO_MANY_REQUESTS
                        | reqwest::StatusCode::REQUEST_TIMEOUT
                        | reqwest::StatusCode::BAD_GATEWAY
                        | reqwest::StatusCode::SERVICE_UNAVAILABLE
                        | reqwest::StatusCode::GATEWAY_TIMEOUT
                ) && attempt < 2
                {
                    tel.set_http_status(resp.status().as_u16());
                    tel.inc_retry();
                    last_probe_err = Some(http_error(resp.status()));
                    let _ = resp.bytes().await;
                    cancellable(token, async {
                        tokio::time::sleep(Duration::from_millis(600 * (1 << attempt))).await;
                        Ok(())
                    })
                    .await?;
                    continue;
                }
                ok_probe = Some(resp);
                break;
            }
            match ok_probe {
                Some(r) => r,
                None => return Err(last_probe_err.unwrap_or_else(|| err("NETWORK", "下载探测失败"))),
            }
        };
        validate_encoding(&probe)?;
        let range = probe.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if range {
            if content_range(
                probe
                    .headers()
                    .get("content-range")
                    .and_then(|s| s.to_str().ok())
                    .unwrap_or(""),
            ) != Some((0, 0, total))
            {
                return Err(err("CONTENT_MISMATCH", "探测响应范围与文件大小不符"));
            }
        } else if probe.status() != reqwest::StatusCode::OK
            && !(total == 0 && probe.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE)
        {
            let e = http_error(probe.status());
            if let Some(st) = e.http_status {
                tel.set_http_status(st);
            }
            return Err(e);
        }
        let etag = probe
            .headers()
            .get("etag")
            .and_then(|s| s.to_str().ok())
            .unwrap_or("")
            .to_string();
        // Drain the 1-byte 206 probe body so hyper returns the TCP+TLS connection cleanly to the pool.
        if range {
            let _ = probe.bytes().await;
        } else {
            drop(probe);
        }
        tel.add_probe_ms(probe_start.elapsed().as_millis() as u64);
        // Ranges may only be combined when the server supplies a strong representation validator.
        // A missing/weak validator falls back to one complete response and never resumes old pieces.
        let bound_etag = strong_etag(&etag).unwrap_or("").to_string();
        if bound_etag.is_empty() || cp.etag != bound_etag {
            cp.parts.clear();
        }
        cp.etag = bound_etag;

        let exists = fs::try_exists(&temp).await.map_err(io_err)?;
        if exists {
            let meta = fs::symlink_metadata(&temp).await.map_err(io_err)?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(err("CONFLICT", "下载临时路径已被替换"));
            }
            if meta.len() != total {
                cp.parts.clear();
            }
        } else {
            cp.parts.clear();
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&temp)
            .await
            .map_err(io_err)?;
        file.set_len(total).await.map_err(io_err)?;
        drop(file);
        if !cp.parts.is_empty() {
            tel.set_stage("verify_parts");
            tel.set_resumed(true);
            let hash_start = Instant::now();
            verify_parts(&temp, &mut cp, token).await?;
            tel.add_hash_ms(hash_start.elapsed().as_millis() as u64);
        }
        store(m, id, &cp)?;
        if range && total > 0 && !cp.etag.is_empty() {
            let strat = if strategy_pref == "sequential" {
                "sequential"
            } else {
                "multipart"
            };
            tel.set_strategy(strat);
            tel.set_stage("multipart");
            let xfer_start = Instant::now();
            match multipart_with_tel(m, id, &fid, &link, &temp, &mut cp, token, Some(tel)).await {
                Ok(()) => {
                    tel.add_transfer_ms(xfer_start.elapsed().as_millis() as u64);
                    None
                }
                Err(e) if e.code == "RANGE_UNSUPPORTED" => {
                    tel.set_strategy("single_fallback");
                    tel.set_stage("single");
                    cp.parts.clear();
                    store(m, id, &cp)?;
                    let digests = single_with_tel(m, id, &fid, &link, &temp, &mut cp, token, Some(tel)).await?;
                    tel.add_transfer_ms(xfer_start.elapsed().as_millis() as u64);
                    Some(digests)
                }
                Err(e) => {
                    tel.add_transfer_ms(xfer_start.elapsed().as_millis() as u64);
                    return Err(e);
                }
            }
        } else {
            tel.set_strategy(if !range {
                "single_no_range"
            } else if cp.etag.is_empty() {
                "single_no_etag"
            } else {
                "single_zero"
            });
            tel.set_stage("single");
            let xfer_start = Instant::now();
            let digests = single_with_tel(m, id, &fid, &link, &temp, &mut cp, token, Some(tel)).await?;
            tel.add_transfer_ms(xfer_start.elapsed().as_millis() as u64);
            Some(digests)
        }
    };
    check(token)?;
    let metadata = fs::metadata(&temp).await.map_err(io_err)?;
    if metadata.len() != total {
        return Err(err("CONTENT_MISMATCH", "下载文件长度不符"));
    }
    // Multipart uses buffered positional writes; sync once before final validation & publication.
    // Compute ONLY the checksum algorithms that the cloud metadata actually provided (parallelized when >=2).
    // When no cloud digest is provided, every multipart chunk has already verified its per-part SHA-256 inline.
    tel.set_stage("final_hash");
    let (md5, sha1, sha256) = if let Some(digests) = inline_digest {
        digests
    } else {
        OpenOptions::new()
            .write(true)
            .open(&temp)
            .await
            .map_err(io_err)?
            .sync_all()
            .await
            .map_err(io_err)?;
        let need_md5 = info["md5"].as_str().is_some_and(|s| !s.is_empty());
        let need_sha1 = info["sha1"].as_str().is_some_and(|s| !s.is_empty());
        let need_sha256 = info["sha256"].as_str().is_some_and(|s| !s.is_empty());
        if need_md5 || need_sha1 || need_sha256 {
            let hash_start = Instant::now();
            let digests = hash_file_selected(&temp, need_md5, need_sha1, need_sha256, token).await?;
            tel.add_hash_ms(hash_start.elapsed().as_millis() as u64);
            digests
        } else {
            (String::new(), String::new(), String::new())
        }
    };
    for (key, value) in [("md5", &md5), ("sha1", &sha1), ("sha256", &sha256)] {
        if let Some(expected) = info[key].as_str().filter(|s| !s.is_empty()) {
            if !expected.eq_ignore_ascii_case(value) {
                return Err(err(
                    "CONTENT_MISMATCH",
                    "下载文件校验和不符，临时文件已保留",
                ));
            }
        }
    }
    cp.ready = true;
    cp.md5 = md5;
    cp.sha1 = sha1;
    cp.sha256 = sha256;
    store(m, id, &cp)?;
    m.check_session()?;
    tel.set_stage("publish");
    let pub_start = Instant::now();
    publish(&temp, Path::new(&cp.target), token).await?;
    tel.add_publish_ms(pub_start.elapsed().as_millis() as u64);
    m.progress_with_telemetry(id, total, total, Some(tel))
}
async fn verify_parts(temp: &Path, cp: &mut Checkpoint, token: &CancellationToken) -> Result<()> {
    if cp.parts.is_empty() {
        return Ok(());
    }
    let chunk_size = if valid_chunk_size(cp.chunk_size) {
        cp.chunk_size
    } else {
        PART
    };
    let path = temp.to_path_buf();
    let total = cp.total;
    let parts = cp.parts.clone();
    let tok = token.clone();
    let invalid = tokio::task::spawn_blocking(move || -> Result<Vec<u64>> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(&path).map_err(io_err)?;
        let mut buf = vec![0u8; HASH_BUF_CAP];
        let mut bad = Vec::new();
        for (index, done) in parts {
            check(&tok)?;
            let start = index
                .checked_mul(chunk_size)
                .ok_or_else(|| err("LOCAL_IO", "下载分片位置溢出"))?;
            let len = chunk_size.min(total.saturating_sub(start));
            if start >= total || done.len != len {
                bad.push(index);
                continue;
            }
            file.seek(SeekFrom::Start(start)).map_err(io_err)?;
            let mut hash = Sha256::new();
            let mut left = len;
            let mut ok = true;
            while left > 0 {
                check(&tok)?;
                let cap = (left as usize).min(buf.len());
                let n = file.read(&mut buf[..cap]).map_err(io_err)?;
                if n == 0 {
                    ok = false;
                    break;
                }
                hash.update(&buf[..n]);
                left -= n as u64;
            }
            if !ok || format!("{:x}", hash.finalize()) != done.sha256 {
                bad.push(index);
            }
        }
        Ok(bad)
    })
    .await
    .map_err(|_| err("LOCAL_IO", "校验下载断点失败"))??;
    for index in invalid {
        cp.parts.remove(&index);
    }
    Ok(())
}
/// Ensure `dir + sep + name + .{uuid}.qkdownloading` stays within classic Windows MAX_PATH (260)
/// when downloading deeply nested subdirectories, preserving extension and UTF-8 char boundaries.
fn fit_name_for_dir(dir: &Path, name: &str) -> String {
    let dir_len = dir.to_string_lossy().len();
    // Reserve room for path separator (1) + "(9999)" suffix (6) + ".{36-char-uuid}.qkdownloading" (51) + margin
    let overhead = dir_len.saturating_add(62);
    let max_name = 250usize.saturating_sub(overhead).max(24);
    if name.len() <= max_name {
        return name.to_string();
    }
    let p = Path::new(name);
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| {
            let mut end = s.len().min(16);
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            format!(".{}", &s[..end])
        })
        .unwrap_or_default();
    let stem_raw = if ext.is_empty() {
        name
    } else {
        name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name)
    };
    let stem_budget = max_name.saturating_sub(ext.len()).max(8);
    let mut end = stem_raw.len().min(stem_budget);
    while !stem_raw.is_char_boundary(end) {
        end -= 1;
    }
    let stem = stem_raw[..end].trim_end_matches(['.', ' ']);
    let stem = if stem.is_empty() { "file" } else { stem };
    let mut out = format!("{stem}{ext}");
    if is_windows_reserved_name(&out) {
        out = format!("_{out}");
    }
    out
}

async fn reserve(m: &TransferManager, id: &str, dir: &Path, name: &str) -> Result<PathBuf> {
    let fitted = fit_name_for_dir(dir, name);
    let name = fitted.as_str();
    let p = Path::new(name);
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    for i in 0..10000 {
        let candidate = dir.join(if i == 0 {
            name.to_string()
        } else {
            format!("{stem}({i}){ext}")
        });
        let key = path_key(&candidate.to_string_lossy());
        // Check in-memory task reservations in O(N) without serializing all tasks to JSON on every attempt.
        let reserved = m.is_local_path_reserved(id, &key, path_key);
        if reserved || fs::try_exists(&candidate).await.map_err(io_err)? {
            continue;
        }
        // A create_new sidecar reserves the target against other processes; it contains no credentials.
        let lock = PathBuf::from(format!("{}.qkreserve", candidate.to_string_lossy()));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        opts.mode(0o600);
        match opts.open(&lock).await {
            Ok(mut f) => {
                f.write_all(id.as_bytes()).await.map_err(io_err)?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_err(e)),
        }
    }
    Err(err("CONFLICT", "目标目录同名文件过多"))
}
async fn get_link(m: &TransferManager, fid: &str, token: &CancellationToken) -> Result<String> {
    get_link_with_switch(m, fid, None, token).await
}
async fn get_link_with_switch(
    m: &TransferManager,
    fid: &str,
    old_dl_url: Option<&str>,
    token: &CancellationToken,
) -> Result<String> {
    let mut payload = json!({"fids": [fid], "support_error_code": ["41060"]});
    if let Some(old) = old_dl_url.filter(|s| !s.is_empty()) {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("dns_sw".into(), json!("open"));
            obj.insert("old_dl_url".into(), json!(old));
        }
    }
    let env = cancellable(
        token,
        m.inner.core.post_in_session(
            m.bound_generation()?,
            "/1/clouddrive/file/download",
            payload,
        ),
    )
    .await?;
    let list = env["data"]
        .as_array()
        .or_else(|| env["data"]["list"].as_array())
        .ok_or_else(|| err("SERVER", "服务端未返回下载链接"))?;
    list.first()
        .and_then(|r| r["download_url"].as_str().or_else(|| r["url"].as_str()))
        .map(str::to_string)
        .ok_or_else(|| err("SERVER", "服务端未返回下载链接"))
}
fn permitted_cookie_host(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| h == "quark.cn" || h.ends_with(".quark.cn"))
}
fn strong_etag(value: &str) -> Option<&str> {
    let bytes = value.as_bytes();
    (bytes.len() >= 2
        && bytes[0] == b'"'
        && bytes[bytes.len() - 1] == b'"'
        && bytes[1..bytes.len() - 1]
            .iter()
            .all(|b| *b >= 0x21 && *b != b'"' && *b != 0x7f))
    .then_some(value)
}
fn validate_etag(response: &reqwest::Response, expected: &str) -> Result<()> {
    if !expected.is_empty()
        && response.headers().get("etag").and_then(|h| h.to_str().ok()) != Some(expected)
    {
        return Err(err(
            "CONFLICT",
            "下载对象的 ETag 已改变或丢失，未拼接不同版本",
        ));
    }
    Ok(())
}
fn validate_encoding(response: &reqwest::Response) -> Result<()> {
    if response
        .headers()
        .get("content-encoding")
        .is_some_and(|h| h.as_bytes() != b"identity")
    {
        return Err(err("CONTENT_MISMATCH", "下载响应使用了非预期压缩编码"));
    }
    Ok(())
}
fn connections(settings: &serde_json::Value, total: u64) -> usize {
    let max = settings["downloadParallel"]
        .as_u64()
        .unwrap_or(16)
        .max(1) as usize;
    match settings["downloadStrategy"].as_str().unwrap_or("auto") {
        "sequential" => 1,
        "parallel" => max,
        _ if total <= 8 * 1024 * 1024 => max.min(total.div_ceil(PART).clamp(1, 4) as usize),
        _ if total <= 16 * 1024 * 1024 => max.min(4),
        _ => max,
    }
}
async fn send(
    m: &TransferManager,
    url: &str,
    range: Option<(u64, u64)>,
    etag: Option<&str>,
    token: &CancellationToken,
) -> Result<reqwest::Response> {
    let mut url = reqwest::Url::parse(url).map_err(|_| err("SERVER", "下载链接无效"))?;
    for _ in 0..6 {
        m.check_session()?;
        if url.scheme() != "https"
            && !(cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
        {
            return Err(err("SERVER", "下载链接必须使用 HTTPS"));
        }
        let mut req = m
            .inner
            .core
            .download_http_client()
            .get(url.clone())
            .header("accept-encoding", "identity")
            .header("cache-control", "no-store")
            .header("referer", "https://pan.quark.cn/");
        if permitted_cookie_host(&url) {
            let mut cookie =
                reqwest::header::HeaderValue::from_str(&m.inner.core.cookie_header_for_url(&url))
                    .map_err(|_| err("INVALID_ARG", "Cookie 格式无效"))?;
            cookie.set_sensitive(true);
            req = req.header("cookie", cookie);
        }
        if let Some(etag) = etag.filter(|s| !s.is_empty()) {
            req = req.header("if-match", etag);
            if range.is_some() {
                req = req.header("if-range", etag);
            }
        }
        if let Some((start, end)) = range {
            req = req.header("range", format!("bytes={start}-{end}"));
        }
        m.check_session()?;
        let response = cancellable(token, async {
            tokio::time::timeout(Duration::from_secs(60), req.send())
                .await
                .map_err(|_| err("NETWORK", "下载响应超时"))?
                .map_err(net_err)
        })
        .await?;
        m.check_session()?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|s| s.to_str().ok())
                .ok_or_else(|| err("SERVER", "下载重定向缺少地址"))?;
            url = url
                .join(location)
                .map_err(|_| err("SERVER", "下载重定向地址无效"))?;
            continue;
        }
        return Ok(response);
    }
    Err(err("NETWORK", "下载重定向次数过多"))
}

async fn send_body_request(
    m: &TransferManager,
    url: &str,
    range: Option<(u64, u64)>,
    etag: Option<&str>,
    token: &CancellationToken,
    tel: Option<&RunTelemetry>,
) -> Result<reqwest::Response> {
    let start = Instant::now();
    let result = send(m, url, range, etag, token).await;
    if let Some(tel) = tel {
        tel.add_download_request_time(start.elapsed());
    }
    result
}

fn http_error(status: reqwest::StatusCode) -> quark_core::Error {
    let mut e = if status == reqwest::StatusCode::PRECONDITION_FAILED {
        err("CONFLICT", "下载过程中云端文件已改变，未拼接不同版本")
    } else if status == reqwest::StatusCode::FORBIDDEN {
        err("LINK_EXPIRED", "下载链接已过期")
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        err("RATE_LIMIT", "下载请求过于频繁，正在限速重试")
    } else if matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::GONE
    ) {
        err("NOT_FOUND", format!("下载资源不可用（HTTP {}）", status.as_u16()))
    } else if status == reqwest::StatusCode::BAD_REQUEST {
        err("SERVER", "下载服务器拒绝请求（HTTP 400）")
    } else {
        err(
            "NETWORK",
            format!("下载服务器返回 HTTP {}", status.as_u16()),
        )
    };
    e.http_status = Some(status.as_u16());
    e
}
#[cfg(test)]
async fn multipart(
    m: &TransferManager,
    id: &str,
    fid: &str,
    link: &str,
    temp: &Path,
    cp: &mut Checkpoint,
    token: &CancellationToken,
) -> Result<()> {
    multipart_with_tel(m, id, fid, link, temp, cp, token, None).await
}
#[allow(clippy::too_many_arguments)]
async fn multipart_with_tel(
    m: &TransferManager,
    id: &str,
    fid: &str,
    link: &str,
    temp: &Path,
    cp: &mut Checkpoint,
    token: &CancellationToken,
    tel: Option<&Arc<RunTelemetry>>,
) -> Result<()> {
    let chunk_size = if valid_chunk_size(cp.chunk_size) {
        cp.chunk_size
    } else {
        PART
    };
    let count = cp.total.div_ceil(chunk_size);
    let settings = m.inner.core.settings();
    let tuning = m.inner.core.tuning();
    let strategy_pref = settings["downloadStrategy"].as_str().unwrap_or("auto");
    let raw_max_parallel = connections(&settings, cp.total);
    let max_parallel = if strategy_pref == "auto" {
        let active_dls = m.active_download_count().max(1);
        let budget = (GLOBAL_AUTO_SOCKET_BUDGET / active_dls).max(2);
        raw_max_parallel.min(budget)
    } else {
        raw_max_parallel
    };
    let auto_ramp = strategy_pref == "auto" && max_parallel > AUTO_RAMP_INITIAL_PARALLEL && count > 4;
    let min_parallel = tuning.aimd_min_parallel.min(max_parallel).max(1);
    let mut effective_parallel = if auto_ramp {
        AUTO_RAMP_INITIAL_PARALLEL.min(max_parallel)
    } else {
        max_parallel
    };
    let mut ramp_locked = !auto_ramp;
    let mut ramp_window_parts: u32 = 0;
    let mut ramp_window_bytes: u64 = 0;
    let mut ramp_window_start = Instant::now();
    let mut ramp_prev_bps: u64 = 0;
    let mut recent_retries: u32 = 0;
    let mut clean_streak: u32 = 0;
    if let Some(tel) = tel {
        tel.set_parallel(effective_parallel);
        tel.set_chunk_size(chunk_size);
    }
    let shared_link = Arc::new(SharedLink::new(link.to_string()));
    // Open the temporary file ONCE for the entire multipart download instead of per-part open/close.
    let shared_file = Arc::new(
        std::fs::OpenOptions::new()
            .write(true)
            .open(temp)
            .map_err(io_err)?,
    );
    let mut cursor = 0u64;
    let mut workers = JoinSet::new();
    let workers_token = token.child_token();
    let mut failure = None;
    let mut complete = cp.parts.values().map(|p| p.len).sum::<u64>();
    let mut unsaved_parts: u32 = 0;
    let mut last_flush = tokio::time::Instant::now();
    let mut checkpoint_write = None;
    m.progress_with_telemetry(id, complete, cp.total, tel.map(Arc::as_ref))?;
    let live = Arc::new(Mutex::new((complete, BTreeMap::<u64, u64>::new())));
    loop {
        while failure.is_none() && workers.len() < effective_parallel && cursor < count {
            let index = cursor;
            cursor += 1;
            if cp.parts.contains_key(&index) {
                continue;
            }
            let live = live.clone();
            let manager = m.clone();
            let task_id = id.to_string();
            let total = cp.total;
            let progress_tel = tel.cloned();
            let progress: Arc<dyn Fn(u64) + Send + Sync> = Arc::new(move |bytes| {
                let mut live = live.lock().unwrap();
                live.1.insert(index, bytes);
                let received = live.0 + live.1.values().sum::<u64>();
                let _ = manager.progress_with_telemetry(&task_id, received, total, progress_tel.as_deref());
            });
            let manager = m.clone();
            let fid = fid.to_owned();
            let shared_link = shared_link.clone();
            let shared_file = shared_file.clone();
            let etag = cp.etag.clone();
            let part_token = workers_token.clone();
            let part_tel = tel.cloned();
            workers.spawn(async move {
                fetch_part_file(
                    &manager, &fid, shared_link, shared_file, index, chunk_size, total,
                    etag, part_token, Some(progress), part_tel.as_deref(),
                )
                .await
            });
        }
        if checkpoint_write.is_none()
            && unsaved_parts > 0
            && (workers.is_empty()
                || unsaved_parts >= 16
                || last_flush.elapsed() >= Duration::from_millis(1500))
        {
            let manager = m.clone();
            let task_id = id.to_owned();
            let snapshot = cp.clone();
            let checkpoint_tel = tel.cloned();
            // Serialize disk writes per download, so an older snapshot can never replace a newer one.
            checkpoint_write = Some(tokio::task::spawn_blocking(move || {
                let start = Instant::now();
                let saved = store(&manager, &task_id, &snapshot);
                if let Some(tel) = checkpoint_tel {
                    tel.add_download_checkpoint_time(start.elapsed());
                }
                saved
            }));
            unsaved_parts = 0;
            last_flush = tokio::time::Instant::now();
        }
        let next = tokio::select! {
            biased;
            saved = async { checkpoint_write.as_mut().unwrap().await }, if checkpoint_write.is_some() => {
                checkpoint_write = None;
                let result = saved.unwrap_or_else(|_| Err(err("LOCAL_IO", "保存下载进度失败")));
                if let Err(e) = result {
                    if failure.is_none() {
                        failure = Some(e);
                        workers_token.cancel();
                    }
                }
                continue;
            }
            next = workers.join_next(), if !workers.is_empty() => next,
            else => break,
        };
        let Some(result) = next else {
            break;
        };
        let result = result.unwrap_or_else(|_| Err(err("SYSTEM", "下载分片任务异常退出")));
        match result {
            Ok((index, done, part_retries_used)) => {
                if tuning.aimd_enabled && max_parallel > min_parallel {
                    if part_retries_used > 0 {
                        recent_retries = recent_retries.saturating_add(part_retries_used);
                        clean_streak = 0;
                        ramp_locked = true;
                        if recent_retries >= tuning.aimd_retry_threshold
                            && effective_parallel > min_parallel
                        {
                            effective_parallel = (effective_parallel / 2).max(min_parallel);
                            recent_retries = 0;
                            if let Some(tel) = tel {
                                tel.record_aimd_downshift(effective_parallel);
                            }
                        }
                    } else {
                        clean_streak = clean_streak.saturating_add(1);
                        if !ramp_locked && effective_parallel < max_parallel {
                            ramp_window_parts = ramp_window_parts.saturating_add(1);
                            ramp_window_bytes = ramp_window_bytes.saturating_add(done.len);
                            if ramp_window_parts >= 4 {
                                let elapsed_ms = ramp_window_start.elapsed().as_millis().max(1) as u64;
                                let window_bps = ramp_window_bytes.saturating_mul(1000) / elapsed_ms;
                                if ramp_prev_bps == 0 {
                                    if window_bps >= AUTO_RAMP_MIN_EXPAND_BPS {
                                        effective_parallel = (effective_parallel + 2).min(max_parallel);
                                        ramp_prev_bps = window_bps;
                                        if let Some(tel) = tel {
                                            tel.set_parallel(effective_parallel);
                                        }
                                    } else {
                                        ramp_locked = true;
                                    }
                                } else if window_bps >= ramp_prev_bps.saturating_mul(112) / 100 {
                                    effective_parallel = (effective_parallel + 2).min(max_parallel);
                                    ramp_prev_bps = window_bps;
                                    if let Some(tel) = tel {
                                        tel.set_parallel(effective_parallel);
                                    }
                                } else {
                                    if window_bps < ramp_prev_bps.saturating_mul(88) / 100
                                        && effective_parallel > AUTO_RAMP_INITIAL_PARALLEL
                                    {
                                        effective_parallel = effective_parallel
                                            .saturating_sub(2)
                                            .max(AUTO_RAMP_INITIAL_PARALLEL);
                                        if let Some(tel) = tel {
                                            tel.set_parallel(effective_parallel);
                                        }
                                    }
                                    ramp_locked = true;
                                }
                                ramp_window_parts = 0;
                                ramp_window_bytes = 0;
                                ramp_window_start = Instant::now();
                            }
                        } else if ramp_locked
                            && clean_streak >= tuning.aimd_recover_clean_parts
                        {
                            if !auto_ramp && effective_parallel < max_parallel {
                                effective_parallel += 1;
                            }
                            clean_streak = 0;
                            recent_retries = recent_retries.saturating_sub(1);
                        }
                    }
                }
                complete += done.len;
                let progress = {
                    let mut live = live.lock().unwrap();
                    live.0 = complete;
                    live.1.remove(&index);
                    let received = live.0 + live.1.values().sum::<u64>();
                    m.progress_with_telemetry(id, received, cp.total, tel.map(Arc::as_ref))
                };
                cp.parts.insert(index, done);
                unsaved_parts += 1;
                if let Err(e) = progress {
                    if failure.is_none() {
                        failure = Some(e);
                        workers_token.cancel();
                    }
                }
            }
            Err(e) => {
                if failure.is_none() {
                    failure = Some(e);
                    workers_token.cancel();
                }
            }
        }
    }
    if let Some(e) = failure {
        return Err(e);
    }
    if cp.parts.len() as u64 != count {
        return Err(err("CONTENT_MISMATCH", "下载仍有未完成分片"));
    }
    Ok(())
}
fn write_buffer(
    file: Arc<std::fs::File>,
    offset: u64,
    mut buf: Vec<u8>,
) -> tokio::task::JoinHandle<Result<Vec<u8>>> {
    tokio::task::spawn_blocking(move || {
        write_exact_at(&file, offset, &buf).map_err(io_err)?;
        buf.clear();
        Ok(buf)
    })
}

async fn finish_write(job: tokio::task::JoinHandle<Result<Vec<u8>>>) -> Result<Vec<u8>> {
    job.await.map_err(|_| err("LOCAL_IO", "写入下载临时文件失败"))?
}

async fn download_body(
    response: reqwest::Response,
    file: Arc<std::fs::File>,
    range: Range<u64>,
    token: &CancellationToken,
    tel: Option<&RunTelemetry>,
    mut hash: impl FnMut(&[u8]),
    mut progress: impl FnMut(u64) -> Result<()>,
) -> Result<()> {
    let active_response = tel.map(RunTelemetry::download_response_started);
    let protocol = response.version();
    if let Some(tel) = tel {
        tel.set_cdn_host_class(&cdn_host_class(response.url()));
        if let Some(cache) = cdn_cache_status(response.headers()) {
            tel.record_cdn_cache(cache);
        }
    }
    let mut stream = response.bytes_stream();
    let length = range.end - range.start;
    let mut offset = range.start;
    let mut received = 0u64;
    let mut last_reported = 0u64;
    let mut last_report_at = Instant::now();
    let mut buffer = Vec::with_capacity(length.min(WRITE_BUF_CAP as u64) as usize);
    let mut pending = None;
    let mut read_wait = Duration::ZERO;
    let mut write_wait = Duration::ZERO;
    let mut hash_work = Duration::ZERO;
    let body: Result<()> = async {
        loop {
            let read_start = Instant::now();
            let chunk = cancellable(token, async {
                tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next())
                    .await
                    .map_err(|_| err("STALL_TIMEOUT", "下载连接长时间无响应，正在重连"))?
                    .transpose()
                    .map_err(net_err)
            })
            .await;
            read_wait += read_start.elapsed();
            let Some(chunk) = chunk? else {
                break;
            };
            let bytes = chunk.len() as u64;
            if bytes > length - received {
                return Err(err("CONTENT_MISMATCH", "下载响应超出请求范围"));
            }
            let hash_start = Instant::now();
            hash(&chunk);
            hash_work += hash_start.elapsed();
            received += bytes;
            if let Some(tel) = tel {
                tel.add_wire_bytes(bytes);
            }
            let mut remaining = chunk.as_ref();
            while !remaining.is_empty() {
                let take = remaining.len().min(WRITE_BUF_CAP - buffer.len());
                let (next, rest) = remaining.split_at(take);
                buffer.extend_from_slice(next);
                remaining = rest;
                if buffer.len() < WRITE_BUF_CAP {
                    continue;
                }
                // Let network polling and hashing keep going while one positional write completes.
                let next_offset = offset + buffer.len() as u64;
                let spare = if let Some(job) = pending.take() {
                    let wait_start = Instant::now();
                    let spare = finish_write(job).await;
                    write_wait += wait_start.elapsed();
                    spare?
                } else {
                    Vec::with_capacity((range.end - next_offset).min(WRITE_BUF_CAP as u64) as usize)
                };
                pending = Some(write_buffer(
                    file.clone(),
                    offset,
                    std::mem::replace(&mut buffer, spare),
                ));
                offset = next_offset;
            }
            if received - last_reported >= 256 * 1024
                || last_report_at.elapsed() >= Duration::from_millis(120)
            {
                progress(received)?;
                last_reported = received;
                last_report_at = Instant::now();
            }
        }
        if received != length {
            return Err(err("CONTENT_MISMATCH", "下载响应不完整"));
        }
        Ok(())
    }
    .await;
    drop(active_response);
    // Even a canceled or truncated response must drain its issued write before a
    // retry or cleanup can reuse the same range or path.
    let write_start = Instant::now();
    let disk: Result<()> = async {
        if let Some(job) = pending {
            finish_write(job).await?;
        }
        if body.is_ok() && !buffer.is_empty() {
            finish_write(write_buffer(file, offset, buffer)).await?;
        }
        Ok(())
    }
    .await;
    write_wait += write_start.elapsed();
    if let Some(tel) = tel {
        tel.add_download_body_metrics(protocol, read_wait, write_wait, hash_work);
    }
    body?;
    disk?;
    if received != last_reported {
        progress(received)?;
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn fetch_part_file(
    m: &TransferManager,
    fid: &str,
    shared_link: Arc<SharedLink>,
    file: Arc<std::fs::File>,
    index: u64,
    chunk_size: u64,
    total: u64,
    etag: String,
    token: CancellationToken,
    on_progress: Option<Arc<dyn Fn(u64) + Send + Sync>>,
    tel: Option<&RunTelemetry>,
) -> Result<(u64, DonePart, u32)> {
    let _slot = cancellable(&token, async {
        m.inner
            .download_slots
            .acquire()
            .await
            .map_err(|_| err("ABORTED", "下载已停止"))
    })
    .await?;
    let start = index * chunk_size;
    let length = chunk_size.min(total - start);
    for attempt in 0..5u32 {
        check(&token)?;
        let (link, link_gen) = shared_link.current();
        if let Some(progress) = &on_progress {
            if attempt > 0 {
                progress(0);
            }
        }
        let result = async {
            let response = send_body_request(
                m,
                &link,
                Some((start, start + length - 1)),
                Some(&etag),
                &token,
                tel,
            )
            .await?;
            if response.status().is_success() {
                validate_encoding(&response)?;
                validate_etag(&response, &etag)?;
            }
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(if response.status() == reqwest::StatusCode::OK {
                    err("RANGE_UNSUPPORTED", "服务器忽略 Range，切换完整下载")
                } else {
                    http_error(response.status())
                });
            }
            if content_range(
                response
                    .headers()
                    .get("content-range")
                    .and_then(|s| s.to_str().ok())
                    .unwrap_or(""),
            ) != Some((start, start + length - 1, total))
            {
                return Err(err("CONTENT_MISMATCH", "分片响应范围与请求不符"));
            }
            if let Some(cl) = response.content_length() {
                if cl != length {
                    return Err(err("CONTENT_MISMATCH", "分片 Content-Length 不符"));
                }
            }
            let mut hash = Sha256::new();
            download_body(
                response,
                file.clone(),
                start..start + length,
                &token,
                tel,
                |chunk| hash.update(chunk),
                |received| {
                    if let Some(progress) = &on_progress {
                        progress(received);
                    }
                    Ok(())
                },
            )
            .await?;
            Ok((
                index,
                DonePart {
                    len: length,
                    sha256: format!("{:x}", hash.finalize()),
                },
                attempt,
            ))
        }
        .await;
        match result {
            Ok(v) => return Ok(v),
            Err(e)
                if attempt < 4
                    && [
                        "NETWORK",
                        "STALL_TIMEOUT",
                        "RATE_LIMIT",
                        "LINK_EXPIRED",
                        "CONTENT_MISMATCH",
                    ]
                    .contains(&e.code.as_str()) =>
            {
                if let Some(tel) = tel {
                    tel.inc_retry();
                    if e.code == "STALL_TIMEOUT" {
                        tel.inc_stall_restart();
                    }
                    if let Some(st) = e.http_status {
                        tel.set_http_status(st);
                    }
                }
                if e.code == "LINK_EXPIRED" {
                    let _ = shared_link
                        .refresh_if_stale(link_gen, m, fid, &token, tel)
                        .await?;
                } else if e.code == "STALL_TIMEOUT" && attempt >= 1 {
                    shared_link
                        .refresh_for_slow_node(link_gen, m, fid, &token, tel)
                        .await;
                }
                let base_ms = if e.code == "RATE_LIMIT" {
                    800
                } else if e.code == "STALL_TIMEOUT" {
                    150
                } else {
                    300
                };
                let backoff_ms = (base_ms * (1u64 << attempt)).min(4800) + (index % 7) * 40;
                cancellable(&token, async {
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    Ok(())
                })
                .await?;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
async fn fetch_part(
    m: &TransferManager,
    fid: &str,
    link: &str,
    temp: &Path,
    index: u64,
    total: u64,
    etag: String,
    token: CancellationToken,
    on_progress: Option<Arc<dyn Fn(u64) + Send + Sync>>,
) -> Result<(u64, DonePart)> {
    let file = Arc::new(
        std::fs::OpenOptions::new()
            .write(true)
            .open(temp)
            .map_err(io_err)?,
    );
    let shared_link = Arc::new(SharedLink::new(link.to_string()));
    let (idx, done, _) = fetch_part_file(
        m,
        fid,
        shared_link,
        file,
        index,
        PART,
        total,
        etag,
        token,
        on_progress,
        None,
    )
    .await?;
    Ok((idx, done))
}
#[cfg(test)]
async fn single(
    m: &TransferManager,
    id: &str,
    fid: &str,
    link: &str,
    temp: &Path,
    cp: &mut Checkpoint,
    token: &CancellationToken,
) -> Result<(String, String, String)> {
    single_with_tel(m, id, fid, link, temp, cp, token, None).await
}
#[allow(clippy::too_many_arguments)]
async fn single_with_tel(
    m: &TransferManager,
    id: &str,
    fid: &str,
    link: &str,
    temp: &Path,
    cp: &mut Checkpoint,
    token: &CancellationToken,
    tel: Option<&RunTelemetry>,
) -> Result<(String, String, String)> {
    if let Some(tel) = tel {
        tel.set_parallel(1);
    }
    let _slot = cancellable(token, async {
        m.inner
            .download_slots
            .acquire()
            .await
            .map_err(|_| err("ABORTED", "下载已停止"))
    })
    .await?;
    let mut link = link.to_string();
    cp.parts.clear();
    store(m, id, cp)?;
    for attempt in 0..5u32 {
        if attempt > 0 {
            m.reset_sample(id);
        }
        let result = async {
            let response = send_body_request(m, &link, None, Some(&cp.etag), token, tel).await?;
            if response.status() != reqwest::StatusCode::OK {
                return Err(http_error(response.status()));
            }
            validate_encoding(&response)?;
            validate_etag(&response, &cp.etag)?;
            if let Some(cl) = response.content_length() {
                if cl != cp.total {
                    return Err(err(
                        "CONTENT_MISMATCH",
                        "下载 Content-Length 与文件大小不符",
                    ));
                }
            }
            let file = Arc::new(
                std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(temp)
                    .map_err(io_err)?,
            );
            let mut md5 = Md5::new();
            let mut sha1 = Sha1::new();
            let mut sha256 = Sha256::new();
            download_body(
                response,
                file.clone(),
                0..cp.total,
                token,
                tel,
                |chunk| {
                    md5.update(chunk);
                    sha1.update(chunk);
                    sha256.update(chunk);
                },
                |received| m.progress_with_telemetry(id, received, cp.total, tel),
            )
            .await?;
            tokio::task::spawn_blocking(move || file.sync_all().map_err(io_err))
                .await
                .map_err(|_| err("LOCAL_IO", "同步下载文件失败"))??;
            Ok((
                format!("{:x}", md5.finalize()),
                format!("{:x}", sha1.finalize()),
                format!("{:x}", sha256.finalize()),
            ))
        }
        .await;
        match result {
            Ok(digests) => return Ok(digests),
            Err(e)
                if attempt < 4
                    && [
                        "NETWORK",
                        "STALL_TIMEOUT",
                        "RATE_LIMIT",
                        "LINK_EXPIRED",
                        "CONTENT_MISMATCH",
                    ]
                    .contains(&e.code.as_str()) =>
            {
                if let Some(tel) = tel {
                    tel.inc_retry();
                    if e.code == "STALL_TIMEOUT" {
                        tel.inc_stall_restart();
                    }
                    if let Some(st) = e.http_status {
                        tel.set_http_status(st);
                    }
                }
                if e.code == "LINK_EXPIRED" {
                    link = get_link(m, fid, token).await?;
                    if let Some(tel) = tel {
                        tel.inc_link_refresh();
                    }
                } else if e.code == "STALL_TIMEOUT" && attempt >= 1 {
                    if let Ok(fresh) = get_link_with_switch(m, fid, Some(&link), token).await {
                        if let Some(tel) = tel {
                            tel.inc_link_refresh();
                            let old_h = reqwest::Url::parse(&link)
                                .ok()
                                .and_then(|u| u.host_str().map(str::to_owned));
                            let new_h = reqwest::Url::parse(&fresh)
                                .ok()
                                .and_then(|u| u.host_str().map(str::to_owned));
                            if old_h.is_some() && new_h.is_some() && old_h != new_h {
                                tel.inc_cdn_node_switch();
                            }
                        }
                        link = fresh;
                    }
                }
                let base_ms = if e.code == "RATE_LIMIT" {
                    800
                } else if e.code == "STALL_TIMEOUT" {
                    150
                } else {
                    400
                };
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
#[cfg(test)]
async fn hash_range_file(
    file: &mut fs::File,
    buf: &mut [u8],
    start: u64,
    len: u64,
    token: &CancellationToken,
) -> Result<String> {
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(io_err)?;
    let mut hash = Sha256::new();
    let mut left = len;
    while left > 0 {
        check(token)?;
        let cap = (left as usize).min(buf.len());
        let n = file.read(&mut buf[..cap]).await.map_err(io_err)?;
        if n == 0 {
            return Ok(String::new());
        }
        hash.update(&buf[..n]);
        left -= n as u64;
    }
    Ok(format!("{:x}", hash.finalize()))
}
#[cfg(test)]
async fn hash_range(
    path: &Path,
    start: u64,
    len: u64,
    token: &CancellationToken,
) -> Result<String> {
    let mut file = fs::File::open(path).await.map_err(io_err)?;
    let mut buf = vec![0u8; 1024 * 1024];
    hash_range_file(&mut file, &mut buf, start, len, token).await
}
#[cfg(test)]
async fn hash_file(path: &Path, token: &CancellationToken) -> Result<(String, String, String)> {
    hash_file_selected(path, true, true, true, token).await
}

async fn hash_file_selected(
    path: &Path,
    need_md5: bool,
    need_sha1: bool,
    need_sha256: bool,
    token: &CancellationToken,
) -> Result<(String, String, String)> {
    if !need_md5 && !need_sha1 && !need_sha256 {
        return Ok((String::new(), String::new(), String::new()));
    }
    let path = path.to_path_buf();
    let tok = token.clone();
    tokio::task::spawn_blocking(move || -> Result<(String, String, String)> {
        use std::io::Read;
        let mut file = std::fs::File::open(&path).map_err(io_err)?;
        let mut md5 = need_md5.then(Md5::new);
        let mut sha1 = need_sha1.then(Sha1::new);
        let mut sha256 = need_sha256.then(Sha256::new);
        let active_count = (need_md5 as u8) + (need_sha1 as u8) + (need_sha256 as u8);
        let mut buf = vec![0u8; HASH_BUF_CAP];
        loop {
            check(&tok)?;
            let n = file.read(&mut buf).map_err(io_err)?;
            if n == 0 {
                break;
            }
            let slice = &buf[..n];
            if active_count >= 2 && n >= 256 * 1024 {
                std::thread::scope(|s| {
                    let h1 = md5.as_mut().map(|h| s.spawn(move || h.update(slice)));
                    let h2 = sha1.as_mut().map(|h| s.spawn(move || h.update(slice)));
                    if let Some(h) = sha256.as_mut() {
                        h.update(slice);
                    }
                    if let Some(j) = h1 {
                        let _ = j.join();
                    }
                    if let Some(j) = h2 {
                        let _ = j.join();
                    }
                });
            } else {
                if let Some(h) = md5.as_mut() {
                    h.update(slice);
                }
                if let Some(h) = sha1.as_mut() {
                    h.update(slice);
                }
                if let Some(h) = sha256.as_mut() {
                    h.update(slice);
                }
            }
        }
        Ok((
            md5.map(|h| format!("{:x}", h.finalize())).unwrap_or_default(),
            sha1.map(|h| format!("{:x}", h.finalize())).unwrap_or_default(),
            sha256.map(|h| format!("{:x}", h.finalize())).unwrap_or_default(),
        ))
    })
    .await
    .map_err(|_| err("LOCAL_IO", "校验下载文件失败"))?
}
fn validate_owned(task: &Task, cp: &Checkpoint) -> Result<()> {
    if cp.target.is_empty()
        || cp.temp != format!("{}.{}.qkdownloading", cp.target, task.id)
        || task
            .local_dir
            .as_deref()
            .is_none_or(|dir| Path::new(&cp.target).parent() != Some(Path::new(dir)))
    {
        return Err(err("CONFLICT", "下载临时文件所有权记录不符"));
    }
    Ok(())
}
fn is_hard_link_fallback_err(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(
            e.raw_os_error(),
            Some(libc::EPERM)
                | Some(libc::ENOTSUP)
                | Some(libc::EOPNOTSUPP)
                | Some(libc::EXDEV)
                | Some(libc::EINVAL)
                | Some(libc::EACCES)
                | Some(libc::EMLINK)
        )
    }
    #[cfg(windows)]
    {
        // ERROR_INVALID_FUNCTION(1), ERROR_ACCESS_DENIED(5), ERROR_NOT_SAME_DEVICE(17),
        // ERROR_NOT_SUPPORTED(50), ERROR_INVALID_PARAMETER(87), ERROR_DIRECTORY(267)
        matches!(
            e.raw_os_error(),
            Some(1) | Some(5) | Some(17) | Some(50) | Some(87) | Some(267)
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}
fn is_transient_publish_err(e: &quark_core::Error) -> bool {
    e.code == "LOCAL_IO"
        && matches!(
            e.io_kind.as_deref(),
            Some("PermissionDenied" | "ResourceBusy" | "Interrupted")
        )
}

async fn publish_once(temp: &Path, target: &Path, token: &CancellationToken) -> Result<()> {
    check(token)?;
    match fs::hard_link(temp, target).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(err("CONFLICT", "目标文件已存在，下载没有覆盖它"))
        }
        Err(e) if is_hard_link_fallback_err(&e) => {
            let source = temp.to_owned();
            let destination = target.to_owned();
            tokio::task::spawn_blocking(move || rename_no_replace(&source, &destination))
                .await
                .map_err(|_| err("LOCAL_IO", "发布下载文件失败"))?
        }
        Err(e) => Err(io_err(e)),
    }
}

async fn publish(temp: &Path, target: &Path, token: &CancellationToken) -> Result<()> {
    let mut last_err = None;
    for attempt in 0..3u64 {
        match publish_once(temp, target, token).await {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) if is_transient_publish_err(&e) && attempt < 2 => {
                last_err = Some(e);
                cancellable(token, async {
                    tokio::time::sleep(Duration::from_millis(80 * (attempt + 1))).await;
                    Ok(())
                })
                .await?;
            }
            Err(e) => return Err(e),
        }
    }
    if let Some(e) = last_err {
        return Err(e);
    }
    // Target is already safely published; clean up temporary link best-effort (with short retries for Windows Defender).
    if fs::try_exists(temp).await.unwrap_or(false) {
        for attempt in 0..3u64 {
            match fs::remove_file(temp).await {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) if attempt < 2 => {
                    tokio::time::sleep(Duration::from_millis(40 * (attempt + 1))).await;
                }
                Err(_) => break,
            }
        }
    }
    let _ = fs::remove_file(format!("{}.qkreserve", target.to_string_lossy())).await;
    Ok(())
}
pub async fn cleanup(task: &Task) -> Result<()> {
    let cp = parse_checkpoint(task)?;
    if cp.temp.is_empty() {
        return Ok(());
    }
    validate_owned(task, &cp)?;
    match fs::remove_file(&cp.temp).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_err(e)),
    }
    let lock = format!("{}.qkreserve", cp.target);
    if fs::read_to_string(&lock).await.ok().as_deref() == Some(&task.id) {
        match fs::remove_file(lock).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err(e)),
        }
    }
    Ok(())
}

fn rename_no_replace(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let source_c = std::ffi::CString::new(source.as_os_str().as_bytes())
            .map_err(|_| err("INVALID_ARG", "文件路径包含无效字符"))?;
        let destination_c = std::ffi::CString::new(destination.as_os_str().as_bytes())
            .map_err(|_| err("INVALID_ARG", "文件路径包含无效字符"))?;
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renamex_np(
                source_c.as_ptr(),
                destination_c.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source_c.as_ptr(),
                libc::AT_FDCWD,
                destination_c.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let result = -1;
        if result == 0 {
            return Ok(());
        }
        let e = std::io::Error::last_os_error();
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(err("CONFLICT", "目标文件已存在，下载没有覆盖它"));
        }
        // exFAT / FAT32 / FUSE / SMB volumes often return ENOTSUP/EOPNOTSUPP/EINVAL/ENOSYS on exclusive rename.
        // Because `.qkreserve` already guards the destination, fall back safely after checking non-existence.
        if matches!(
            e.raw_os_error(),
            Some(libc::ENOTSUP)
                | Some(libc::EOPNOTSUPP)
                | Some(libc::EINVAL)
                | Some(libc::ENOSYS)
        ) {
            if std::fs::symlink_metadata(destination).is_ok() {
                return Err(err("CONFLICT", "目标文件已存在，下载没有覆盖它"));
            }
            return std::fs::rename(source, destination).map_err(io_err);
        }
        return Err(io_err(e));
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }
        fn win_wide(p: &Path) -> Vec<u16> {
            let s = p.to_string_lossy();
            let prefixed = if s.len() >= 240 && !s.starts_with(r"\\?\") {
                if let Some(unc) = s.strip_prefix(r"\\") {
                    format!(r"\\?\UNC\{unc}")
                } else {
                    format!(r"\\?\{s}")
                }
            } else {
                s.into_owned()
            };
            std::ffi::OsStr::new(&prefixed)
                .encode_wide()
                .chain(Some(0))
                .collect()
        }
        let source_w = win_wide(source);
        let destination_w = win_wide(destination);
        if unsafe { MoveFileExW(source_w.as_ptr(), destination_w.as_ptr(), 0) } != 0 {
            return Ok(());
        }
        let e = std::io::Error::last_os_error();
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(err("CONFLICT", "目标文件已存在，下载没有覆盖它"));
        }
        Err(io_err(e))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (source, destination);
        Err(err("LOCAL_IO", "当前文件系统不支持安全发布"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Server {
        url: String,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Server {
        fn new(reply: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/fixture", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let reply = Arc::new(reply);
            let thread = std::thread::spawn(move || {
                let mut connections = Vec::new();
                while !flag.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut socket, _)) => {
                            // macOS accept inherits O_NONBLOCK from the listener.
                            socket.set_nonblocking(false).unwrap();
                            socket
                                .set_write_timeout(Some(Duration::from_secs(3)))
                                .unwrap();
                            let reply = reply.clone();
                            connections.push(std::thread::spawn(move || {
                                socket
                                    .set_read_timeout(Some(Duration::from_secs(3)))
                                    .unwrap();
                                let mut input = Vec::new();
                                let mut buf = [0; 1024];
                                while !input.ends_with(b"\r\n\r\n") && input.len() < 16384 {
                                    let n = socket.read(&mut buf).unwrap_or(0);
                                    if n == 0 {
                                        break;
                                    }
                                    input.extend_from_slice(&buf[..n]);
                                }
                                let response =
                                    reply(&String::from_utf8_lossy(&input).to_ascii_lowercase());
                                let _ = socket.write_all(&response);
                            }));
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(2)),
                    }
                }
                for thread in connections {
                    thread.join().unwrap();
                }
            });
            Self {
                url,
                stop,
                thread: Some(thread),
            }
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.thread.take().unwrap().join().unwrap();
        }
    }
    fn response(status: &str, headers: &str, bytes: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
            bytes.len()
        )
        .into_bytes();
        out.extend_from_slice(bytes);
        out
    }
    async fn prepare(dir: &Path, total: u64) -> (TransferManager, String, PathBuf, Checkpoint) {
        let (m, id) = crate::manager::fixture(dir);
        let target = dir.join("fixture.bin");
        let temp = PathBuf::from(format!("{}.{}.qkdownloading", target.display(), id));
        fs::File::create(&temp)
            .await
            .unwrap()
            .set_len(total)
            .await
            .unwrap();
        let cp = Checkpoint {
            version: CHECKPOINT_VERSION,
            chunk_size: PART,
            target: target.to_string_lossy().into_owned(),
            temp: temp.to_string_lossy().into_owned(),
            total,
            etag: "\"fixture-v1\"".into(),
            ..Default::default()
        };
        store(&m, &id, &cp).unwrap();
        (m, id, temp, cp)
    }
    #[test]
    fn strategy_is_size_adaptive_and_respects_user_limit() {
        let settings = json!({"downloadParallel":16,"downloadStrategy":"auto"});
        assert_eq!(connections(&settings, PART), 1);
        assert_eq!(connections(&settings, 8 * PART), 4);
        assert_eq!(connections(&settings, 16 * PART + 1), 16);
        assert_eq!(connections(&json!({"downloadParallel":48,"downloadStrategy":"parallel"}), 100 * PART), 48);
        assert_eq!(connections(&json!({"downloadParallel":48,"downloadStrategy":"auto"}), 100 * PART), 48);
        assert_eq!(connections(&json!({"downloadParallel":2}), 100 * PART), 2);
        assert_eq!(choose_chunk_size(10 * PART), PART);
        assert_eq!(choose_chunk_size(64 * PART), 4 * PART);
        assert_eq!(choose_chunk_size(512 * PART), 4 * PART);
        assert_eq!(
            cdn_host_class(&reqwest::Url::parse("https://dl-pc-sz.drive.quark.cn/file?auth_key=secret").unwrap()),
            "dl-pc-sz"
        );
        assert_eq!(
            cdn_host_class(&reqwest::Url::parse("https://bucket.oss-cn-hangzhou.aliyuncs.com/k").unwrap()),
            "aliyun-oss"
        );
        let mut hdrs = reqwest::header::HeaderMap::new();
        hdrs.insert("x-cache", "HIT TCP_MEM_HIT dirn:-2:-2".parse().unwrap());
        assert_eq!(cdn_cache_status(&hdrs), Some("HIT"));
        assert_eq!(
            connections(
                &json!({"downloadParallel":16,"downloadStrategy":"sequential"}),
                100 * PART
            ),
            1
        );
        for invalid in ["", "W/\"v1\"", "v1", "\"bad\"quote\"", "\"bad\n\""] {
            assert_eq!(strong_etag(invalid), None);
        }
        assert_eq!(strong_etag("\"v1\""), Some("\"v1\""));
    }
    #[tokio::test]
    async fn real_range_stream_binds_etag_and_never_sends_cookies_to_cdn() {
        let bytes = vec![0x5a; PART as usize + 17];
        let serve = bytes.clone();
        let server = Server::new(move |request| {
            assert!(request.contains("range: bytes=1048576-1048592\r\n"));
            assert!(request.contains("if-match: \"fixture-v1\"\r\n"));
            assert!(request.contains("if-range: \"fixture-v1\"\r\n"));
            assert!(!request.contains("cookie:"));
            response(
                "206 Partial Content",
                "ETag: \"fixture-v1\"\r\nContent-Range: bytes 1048576-1048592/1048593\r\n",
                &serve[PART as usize..],
            )
        });
        let dir = tempfile::tempdir().unwrap();
        let (m, _, temp, _) = prepare(dir.path(), bytes.len() as u64).await;
        let token = CancellationToken::new();
        let (i, done) = fetch_part(
            &m,
            "fixture",
            &server.url,
            &temp,
            1,
            bytes.len() as u64,
            "\"fixture-v1\"".into(),
            token.clone(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(i, 1);
        assert_eq!(done.len, 17);
        assert_eq!(
            done.sha256,
            hash_range(&temp, PART, 17, &token).await.unwrap()
        );
        assert_eq!(
            &fs::read(temp).await.unwrap()[PART as usize..],
            &bytes[PART as usize..]
        );
    }
    #[tokio::test]
    async fn canceled_body_drains_queued_write_before_range_is_reused() {
        let length = 3 * WRITE_BUF_CAP + 17;
        let start = 13u64;
        let server = Server::new(move |_| response("200 OK", "", &vec![7; length]));
        let dir = tempfile::tempdir().unwrap();
        let (manager, _, temp, _) = prepare(dir.path(), start + length as u64).await;
        let file = Arc::new(std::fs::OpenOptions::new().write(true).open(&temp).unwrap());
        let token = CancellationToken::new();
        let tel = RunTelemetry::new(1, 1, false);
        let first = send(&manager, &server.url, None, None, &token).await.unwrap();
        let error = download_body(
            first,
            file.clone(),
            start..start + length as u64,
            &token,
            Some(&tel),
            |_| {},
            |n| {
                if n >= WRITE_BUF_CAP as u64 {
                    token.cancel();
                }
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "ABORTED");
        let partial = fs::read(&temp).await.unwrap();
        assert!(partial[..start as usize].iter().all(|&b| b == 0));
        assert!(partial[start as usize..start as usize + WRITE_BUF_CAP]
            .iter()
            .all(|&b| b == 7));
        let sample = tel.to_sample("download", "canceled", None);
        assert_eq!(sample["downloadHttpVersion"], "http/1.1");
        assert!(sample["downloadReadWaitMs"].is_number());
        assert!(sample["downloadWriteWaitMs"].is_number());
        let replacement = Server::new(move |_| response("200 OK", "", &vec![9; length]));
        let token = CancellationToken::new();
        let response = send(&manager, &replacement.url, None, None, &token).await.unwrap();
        download_body(
            response,
            file,
            start..start + length as u64,
            &token,
            None,
            |_| {},
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(
            &fs::read(&temp).await.unwrap()[start as usize..],
            &vec![9; length],
        );
    }
    #[tokio::test]
    async fn changed_or_missing_etag_and_wrong_range_never_publish() {
        for (headers,code) in [
            ("ETag: \"fixture-v2\"\r\nContent-Range: bytes 0-15/16\r\n","CONFLICT"),
            ("Content-Range: bytes 0-15/16\r\n","CONFLICT"),
            ("ETag: \"fixture-v1\"\r\nContent-Range: bytes 1-16/17\r\n","CONTENT_MISMATCH"),
            ("ETag: \"fixture-v1\"\r\nContent-Encoding: gzip\r\nContent-Range: bytes 0-15/16\r\n","CONTENT_MISMATCH"),
        ] {
            let server=Server::new(move |_| response("206 Partial Content",headers,&[3;16]));
            let dir=tempfile::tempdir().unwrap();
            let (m,_,temp,cp)=prepare(dir.path(),16).await;
            let e=fetch_part(&m,"fixture",&server.url,&temp,0,16,cp.etag,CancellationToken::new(),None).await.unwrap_err();
            assert_eq!(e.code,code); assert!(!Path::new(&cp.target).exists());
        }
    }
    #[tokio::test]
    async fn ignored_range_falls_back_to_complete_response_and_exclusive_publication() {
        let server = Server::new(|_| response("200 OK", "ETag: \"fixture-v1\"\r\n", &[9; 32]));
        let dir = tempfile::tempdir().unwrap();
        let (m, id, temp, mut cp) = prepare(dir.path(), 32).await;
        let token = CancellationToken::new();
        let e = fetch_part(
            &m,
            "fixture",
            &server.url,
            &temp,
            0,
            32,
            cp.etag.clone(),
            token.clone(),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "RANGE_UNSUPPORTED");
        single(&m, &id, "fixture", &server.url, &temp, &mut cp, &token)
            .await
            .unwrap();
        assert_eq!(fs::read(&temp).await.unwrap(), vec![9; 32]);
        fs::write(&cp.target, b"original user data").await.unwrap();
        assert_eq!(
            publish(&temp, Path::new(&cp.target), &token)
                .await
                .unwrap_err()
                .code,
            "CONFLICT"
        );
        assert_eq!(fs::read(&cp.target).await.unwrap(), b"original user data");
        fs::remove_file(&cp.target).await.unwrap();
        publish(&temp, Path::new(&cp.target), &token).await.unwrap();
        assert_eq!(fs::read(&cp.target).await.unwrap(), vec![9; 32]);
        assert!(!temp.exists());
    }
    #[tokio::test]
    async fn durable_resume_skips_verified_parts_and_redownloads_corrupted_parts() {
        let bytes = Arc::new(
            (0..(2 * PART + 29))
                .map(|i| (i % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let received = Arc::new(Mutex::new(Vec::new()));
        let served = bytes.clone();
        let requests = received.clone();
        let server = Server::new(move |request| {
            let range = request
                .lines()
                .find_map(|s| s.strip_prefix("range: bytes="))
                .unwrap();
            let (start, end) = range.split_once('-').unwrap();
            let start: usize = start.parse().unwrap();
            let end: usize = end.parse().unwrap();
            requests.lock().unwrap().push(start as u64 / PART);
            response(
                "206 Partial Content",
                &format!(
                    "ETag: \"fixture-v1\"\r\nContent-Range: bytes {start}-{end}/{}\r\n",
                    served.len()
                ),
                &served[start..=end],
            )
        });
        let dir = tempfile::tempdir().unwrap();
        let (m, id, temp, mut cp) = prepare(dir.path(), bytes.len() as u64).await;
        let token = CancellationToken::new();
        let (_, done) = fetch_part(
            &m,
            "fixture",
            &server.url,
            &temp,
            0,
            cp.total,
            cp.etag.clone(),
            token.clone(),
            None,
        )
        .await
        .unwrap();
        cp.parts.insert(0, done);
        store(&m, &id, &cp).unwrap();
        let reopened = TransferManager::open(m.inner.core.clone()).unwrap();
        let mut restored = parse_checkpoint(&reopened.task(&id).unwrap()).unwrap();
        verify_parts(&temp, &mut restored, &token).await.unwrap();
        multipart(
            &reopened,
            &id,
            "fixture",
            &server.url,
            &temp,
            &mut restored,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(
            received.lock().unwrap().iter().filter(|i| **i == 0).count(),
            1
        );
        assert_eq!(fs::read(&temp).await.unwrap(), *bytes);
        let from_disk = TransferManager::open(reopened.inner.core.clone()).unwrap();
        let saved = parse_checkpoint(&from_disk.task(&id).unwrap()).unwrap();
        assert_eq!(saved.parts.len(), restored.parts.len());
        assert_eq!(saved.parts[&2].sha256, restored.parts[&2].sha256);
        let mut file = OpenOptions::new().write(true).open(&temp).await.unwrap();
        file.write_all(&[255; 32]).await.unwrap();
        file.sync_all().await.unwrap();
        drop(file);
        verify_parts(&temp, &mut restored, &token).await.unwrap();
        assert!(!restored.parts.contains_key(&0));
        assert_eq!(restored.parts.len(), 2);
        multipart(
            &reopened,
            &id,
            "fixture",
            &server.url,
            &temp,
            &mut restored,
            &token,
        )
        .await
        .unwrap();
        assert_eq!(
            received.lock().unwrap().iter().filter(|i| **i == 0).count(),
            2
        );
        assert_eq!(
            hash_file(&temp, &token).await.unwrap().2,
            format!("{:x}", Sha256::digest(&*bytes))
        );
    }
    #[tokio::test]
    async fn cancelled_stream_stops_without_publishing_and_cleanup_is_owned() {
        let dir = tempfile::tempdir().unwrap();
        let (m, id, temp, cp) = prepare(dir.path(), 16).await;
        let token = CancellationToken::new();
        token.cancel();
        let e = fetch_part(
            &m,
            "fixture",
            "http://127.0.0.1:1",
            &temp,
            0,
            16,
            cp.etag.clone(),
            token,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "ABORTED");
        assert!(temp.exists());
        let mut t = m.task(&id).unwrap();
        let mut forged = cp.clone();
        forged.temp = dir.path().join("user.txt").to_string_lossy().into_owned();
        fs::write(&forged.temp, b"keep").await.unwrap();
        t.checkpoint = serde_json::to_value(forged.clone()).unwrap();
        assert_eq!(cleanup(&t).await.unwrap_err().code, "CONFLICT");
        assert_eq!(fs::read(&forged.temp).await.unwrap(), b"keep");
        cleanup(&m.task(&id).unwrap()).await.unwrap();
        assert!(!temp.exists());
    }
    #[test]
    fn fit_name_for_dir_keeps_deep_nested_paths_within_windows_budget() {
        let deep = PathBuf::from("C:\\Users\\Administrator\\Downloads\\项目资料\\2026年度汇总\\子目录A\\更深一级目录\\第二层子目录");
        let long_name = format!("{}.xlsx", "非常长的季度财务报表文件名测试".repeat(6));
        let fitted = fit_name_for_dir(&deep, &long_name);
        assert!(fitted.ends_with(".xlsx"), "extension must be preserved: {fitted}");
        assert!(fitted.len() < long_name.len(), "long filename must be trimmed");
        assert!(deep.to_string_lossy().len() + fitted.len() + 62 <= 250 || fitted.len() <= 24);
        assert_eq!(fit_name_for_dir(Path::new("/tmp"), "normal.txt"), "normal.txt");
    }
}
