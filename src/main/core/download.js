'use strict';
/**
 * 下载引擎 —— 单文件下载执行器。
 *
 * 需求对应：下载文件至电脑、**断点续传**、**失败重试**、**大文件高速下载**、不阻塞 UI。
 *
 * 两种模式（自动选择）：
 *  1. **并行分片（multipart）**：大文件走多连接 Range 分片并发下载。
 *     依据（本机官方客户端 app.asar，dist/renderer/index.js）：
 *       - 导出 `multipartDownload` / `downloadAllPart` / `downloadPart` / `downloadWhole`
 *       - `partItem` 携带 `partNo` / `start` / `end` / `netReceived` / `getSize()`
 *       - `partitionParallelNum` 控制并行分片数，且可 `scaleTasks(n)` 动态调整
 *       - 每片下载后校验 `netReceived < getSize()` → 抛 `INNER_RESTART`(CONTENT_MISMATCH)
 *       - `switchLinkPlugin` 在下载途中切换直链
 *     第三方驱动同样采用分片并发（OpenList: Concurrency 3 / PartSize 10MB）。
 *  2. **单流（single）**：小文件或服务端不支持 Range 时退化为单连接流式下载。
 *
 * 不变式：**最终文件要么完整、要么不存在**（全部字节校验通过后才原子改名）。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { QuarkError, ErrCode, isNeedLogin, isRetryable } = require('./errors');

const TEMP_SUFFIX = '.qkdownloading';
const CFG_SUFFIX = '.cfg';
const PROGRESS_FLUSH_MS = 500;

/** 超过该大小才启用并行分片（小于它单流更快，也更省连接）。 */
const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
/** 分片大小，取官方同量级（官方 partSize=4MB，OpenList 10MB，这里取 8MB 折中）。 */
const PART_SIZE = 8 * 1024 * 1024;
/** 并行分片数默认值（官方为可调参数，普通用户档位通常为 3~5）。 */
const DEFAULT_PARALLEL = 4;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new QuarkError('操作已取消', { code: ErrCode.ABORTED }));
      return;
    }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new QuarkError('操作已取消', { code: ErrCode.ABORTED }));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

/** 清洗文件名，避免路径穿越与 Windows 非法字符。 */
function safeFileName(name) {
  let n = String(name == null ? '' : name);
  n = n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  n = n.replace(/^\.+$/, '').trim();
  n = n.replace(/[. ]+$/, '');
  if (!n) n = `未命名文件_${Date.now()}`;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n)) n = `_${n}`;
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

// 同一进程中的任务必须各自占有目标路径，包含尚未改名的临时文件。
const activeTargets = new Set();
function targetKey(p) { return process.platform === 'win32' ? p.toLowerCase() : p; }
async function reserveTarget(dir, fileName, fid, preferred) {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let i = 0; i < 10000; i += 1) {
    const candidate = preferred || path.join(dir, i ? `${base}(${i})${ext}` : fileName);
    const key = targetKey(candidate);
    if (activeTargets.has(key)) {
      if (preferred) throw new QuarkError('该下载仍在停止中，请稍后继续', { code: ErrCode.CONFLICT });
      continue;
    }
    activeTargets.add(key);
    try {
      let exists = false;
      try { await fsp.stat(candidate); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (exists) {
        if (preferred) throw new QuarkError('下载目标已存在，请更换文件名', { code: ErrCode.CONFLICT });
        activeTargets.delete(key); continue;
      }
      const temp = `${candidate}${TEMP_SUFFIX}`;
      let partial = false;
      try { await fsp.stat(temp); partial = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const cfg = partial ? await readJsonSafe(`${temp}${CFG_SUFFIX}`) : null;
      if (partial && (!cfg || cfg.fid !== fid)) {
        if (preferred) throw new QuarkError('下载临时文件属于其他任务，已停止写入', { code: ErrCode.CONFLICT });
        activeTargets.delete(key); continue;
      }
      return candidate;
    } catch (e) { activeTargets.delete(key); throw e; }
  }
  throw new QuarkError('目标目录同名文件过多，请更换目录', { code: ErrCode.CONFLICT });
}

async function writeAll(fh, buf, offset) {
  let written = 0;
  while (written < buf.length) {
    const r = await fh.write(buf, written, buf.length - written, offset + written);
    if (!r.bytesWritten) throw new QuarkError('本地文件写入失败', { code: ErrCode.UNKNOWN });
    written += r.bytesWritten;
  }
}

async function commitPartial(tempPath, cfgPath, signal) {
  if (signal && signal.aborted) throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
  const finalPath = tempPath.slice(0, -TEMP_SUFFIX.length);
  // 硬链接以原子方式创建目标；目标已存在时失败，绝不覆盖用户文件。
  try { await fsp.link(tempPath, finalPath); }
  catch (e) {
    if (e.code === 'EEXIST') throw new QuarkError('目标文件已存在，下载未覆盖它', { code: ErrCode.CONFLICT });
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL'].includes(e.code)) throw e;
    try { await fsp.copyFile(tempPath, finalPath, fs.constants.COPYFILE_EXCL); }
    catch (copyError) {
      if (copyError.code === 'EEXIST') throw new QuarkError('目标文件已存在，下载未覆盖它', { code: ErrCode.CONFLICT });
      throw copyError;
    }
  }
  await fsp.rm(tempPath, { force: true }).catch(() => {});
  await fsp.rm(cfgPath, { force: true }).catch(() => {});
}

/** 目标文件重名时自动加 (1)(2)… 避免覆盖用户已有文件。 */
async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  let candidate = path.join(dir, fileName);
  let i = 0;
  for (;;) {
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
    i += 1;
    candidate = path.join(dir, `${base}(${i})${ext}`);
    if (i > 9999) return path.join(dir, `${base}_${Date.now()}${ext}`);
  }
}

async function readJsonSafe(p) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fsp.rename(tmp, p);
}

/** 直链过期：403 / AccessDenied / 403:Forbidden（官方客户端据此重取链）。 */
function isLinkExpired(e) {
  if (!e) return false;
  if (e.httpStatus === 403) return true;
  const s = `${e.code || ''} ${e.message || ''}`;
  return /AccessDenied|403|Forbidden|过期/i.test(s);
}

/**
 * 把响应体归一成可 for-await 的异步迭代器。
 *
 * Node 的 undici Response.body 与 Electron net.fetch 返回的体未必都实现
 * `Symbol.asyncIterator`（Electron 用 ReadableStream），直接 for-await 在部分运行时会抛错。
 */
function iterateBody(body) {
  if (typeof body[Symbol.asyncIterator] === 'function') return body;
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const { done, value } = await reader.read();
            return done ? { done: true, value: undefined } : { done: false, value };
          },
          async return() {
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
  if (typeof body.on === 'function') return body;
  throw new QuarkError('无法读取下载响应内容', { code: ErrCode.SERVER });
}

/** 按分片大小切分区间。 */
function divideParts(total, partSize) {
  const out = [];
  const count = Math.ceil(total / partSize);
  for (let i = 0; i < count; i += 1) {
    const start = i * partSize;
    out.push({ index: i, start, end: Math.min(start + partSize, total) });
  }
  return out;
}

/**
 * 探测总大小与 Range 支持情况。
 * 用 `Range: bytes=0-0` 探测：支持则返回 206 且 Content-Range 形如 `bytes 0-0/TOTAL`。
 * @returns {Promise<{total:number, rangeSupported:boolean}>}
 */
async function probeRange(url, http, signal, hintTotal) {
  const res = await http.request({
    path: url,
    absolute: true,
      direct: true,
    method: 'GET',
    raw: true,
    headers: { range: 'bytes=0-0' },
    signal,
    retries: 0,
    timeout: 0,
  });
  const status = res.status;
  let total = hintTotal > 0 ? hintTotal : -1;
  if (status === 206) {
    const cr = res.headers.get('content-range') || '';
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) total = Number(m[1]);
    try {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
    } catch {
      /* ignore */
    }
    return { total, rangeSupported: true };
  }
  // 200 → 服务端忽略 Range：不支持并行/续传
  try {
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
  } catch {
    /* ignore */
  }
  const cl = Number(res.headers.get('content-length'));
  if (!(total > 0) && Number.isFinite(cl) && cl > 0) {
    // 这里拿到的是 1 字节响应的长度，不可作为总大小；仅在无提示时保留 -1
  }
  return { total, rangeSupported: false };
}

/**
 * 下载一个文件（自动选择单流 / 并行分片）。
 *
 * @param {object} o
 * @param {string} o.fid
 * @param {string} o.fileName
 * @param {string} o.localDir
 * @param {object} o.http
 * @param {object} o.api                createTransferApi 实例
 * @param {number} [o.size]             已知的文件大小（来自列表，可省一次探测）
 * @param {AbortSignal} [o.signal]
 * @param {(p:{transferred:number,total:number})=>void} [o.onProgress]
 * @param {(finalPath:string)=>void} [o.onTarget]
 * @param {number} [o.parallel]         并行分片数，默认 4
 * @param {number} [o.multipartThreshold] 启用并行分片的文件大小阈值（测试可注入）
 * @param {number} [o.mpartSize]        分片大小（测试可注入）
 * @param {number} [o.maxRetries=3]
 * @returns {Promise<{localPath:string,bytes:number,resumed:boolean,multipart:boolean}>}
 */
async function downloadFile(o) {
  const {
    fid,
    fileName,
    localDir,
    http,
    api,
    size,
    signal,
    onProgress,
    onTarget,
    parallel = DEFAULT_PARALLEL,
    multipartThreshold = MULTIPART_THRESHOLD,
    mpartSize = PART_SIZE,
    maxRetries = 3,
  } = o || {};

  if (!fid) throw new QuarkError('缺少文件 id，无法下载', { code: ErrCode.INVALID_ARG });
  if (!localDir) throw new QuarkError('未设置下载目录', { code: ErrCode.INVALID_ARG });

  await fsp.mkdir(localDir, { recursive: true });
  const finalPath = await reserveTarget(localDir, safeFileName(fileName), fid, o.targetPath);
  const tempPath = `${finalPath}${TEMP_SUFFIX}`;
  const cfgPath = `${tempPath}${CFG_SUFFIX}`;

  if (typeof onTarget === 'function') {
    try {
      onTarget(finalPath);
    } catch {
      /* 回调异常不应影响下载 */
    }
  }

  try {
  let attempt = 0;
  let resumed = false;
  for (;;) {
    attempt += 1;
    try {
      // 每次都重新取链：既处理直链过期（403），也确保 Cookie 快照与直链匹配
      const links = await api.downloadUrl([fid], { signal });
      const url = links[0].url;

      const probe = await probeRange(url, http, signal, size);

      let result;
      if (probe.rangeSupported && probe.total > multipartThreshold) {
        try { result = await downloadMultipart({
          url, tempPath, cfgPath, fid, total: probe.total, http, api,
          signal, onProgress, parallel, partSize: mpartSize,
          onResumed: () => { resumed = true; },
        }); } catch (e) {
          if (e.code !== ErrCode.RANGE_UNSUPPORTED) throw e;
          await cleanupPartial(finalPath);
          result = await downloadSingleStream({ url, tempPath, cfgPath, fid, http, api,
            signal, onProgress, total: probe.total });
        }
      } else {
        result = await downloadSingleStream({
          url, tempPath, cfgPath, fid, http, api,
          signal, onProgress, total: probe.total > 0 ? probe.total : size,
          onResumed: () => { resumed = true; },
        });
      }
      return { ...result, localPath: finalPath, resumed };
    } catch (e) {
      if (e && e.code === ErrCode.ABORTED) throw e;
      if (isNeedLogin(e)) throw e;
      const retryable = isRetryable(e) || isLinkExpired(e);
      if (!retryable || attempt > maxRetries) throw e;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000), signal);
    }
  }
  } finally { activeTargets.delete(targetKey(finalPath)); }
}

// ===========================================================================
// 并行分片下载
// ===========================================================================

/**
 * 官方同款并行分片下载：每个分片一个 Range 请求，多分片并发，
 * 用显式文件偏移写入（pwrite），因此并发写同一句柄是安全的。
 */
async function downloadMultipart({
  url, tempPath, cfgPath, fid, total, http, api, signal, onProgress, parallel,
  onResumed, partSize = PART_SIZE, maxPartRetries = 3,
}) {
  const parts = divideParts(total, partSize);

  // 读取既有进度（必须是同一 fid 且总大小一致才可续传）
  let cfg = await readJsonSafe(cfgPath);
  let done = {};
  let existingSize = 0;
  try {
    const st = await fsp.stat(tempPath);
    existingSize = st.size;
  } catch {
    existingSize = 0;
  }
  if (cfg && cfg.mode === 'multi' && cfg.partSize === partSize && cfg.fid === fid && cfg.total === total && cfg.parts && existingSize === total) {
    for (const p of parts) {
      if (cfg.parts[p.index] === p.end - p.start) done[p.index] = p.end - p.start;
    }
  } else {
    cfg = null;
    done = {};
  }

  if (Object.keys(done).length > 0) {
    if (onResumed) onResumed();
  }

  // 预分配整个文件，保证并发 pwrite 落在正确偏移
  const fh = await fsp.open(tempPath, existingSize === total ? 'r+' : 'w+');
  if (existingSize !== total) await fh.truncate(total);

  let received = 0;
  for (const key of Object.keys(done)) {
    const p = parts[Number(key)];
    if (p) received += p.end - p.start;
  }

  let persistence = Promise.resolve();
  const persist = () => {
    const snapshot = { fid, total, parts: { ...done }, mode: 'multi', partSize, updatedAt: Date.now() };
    persistence = persistence.then(() => writeJsonAtomic(cfgPath, snapshot)).catch(() => {});
    return persistence;
  };
  await persist();
  if (onProgress) onProgress({ transferred: received, total });

  let lastFlush = Date.now();
  const partReceived = parts.map((p) => done[p.index] || 0);
  const bump = (index, n) => {
    partReceived[index] = n;
    received = partReceived.reduce((a, b) => a + b, 0);
    if (onProgress) onProgress({ transferred: received, total });
    if (Date.now() - lastFlush > PROGRESS_FLUSH_MS) {
      lastFlush = Date.now();
      persist();
    }
  };

  const workerAbort = new AbortController();
  const workerSignal = signal ? AbortSignal.any([signal, workerAbort.signal]) : workerAbort.signal;

  /** 下载单个分片（失败重试；403 时刷新直链）。 */
  const fetchPart = async (part) => {
    let lastErr = null;
    let currentUrl = url;
    for (let attempt = 1; attempt <= maxPartRetries; attempt += 1) {
      try {
        const res = await http.request({
          path: currentUrl,
          absolute: true,
      direct: true,
          method: 'GET',
          raw: true,
          headers: { range: `bytes=${part.start}-${part.end - 1}` },
          signal: workerSignal,
          retries: 0,
          timeout: 0,
        });

        // 必须是 206；若返回 200 说明服务端忽略了 Range —— 交由上层降级处理
        if (res.status !== 206) {
          if (res.body) await res.body.cancel().catch(() => {});
          throw new QuarkError('服务端未按分片范围返回数据', {
            code: ErrCode.RANGE_UNSUPPORTED,
            httpStatus: res.status,
          });
        }
        const cr = res.headers.get('content-range') || '';
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(cr);
        if (!range || Number(range[1]) !== part.start || Number(range[2]) !== part.end - 1 || Number(range[3]) !== total) {
          if (res.body) await res.body.cancel().catch(() => {});
          throw new QuarkError('分片响应范围与请求不符，已停止下载', { code: ErrCode.RANGE_UNSUPPORTED });
        }

        let offset = part.start;
        let got = 0;
        for await (const chunk of iterateBody(res.body)) {
          if (workerSignal.aborted) throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (!buf.length) continue;
          if (offset + buf.length > part.end) throw new QuarkError('分片数据超出请求范围', { code: ErrCode.RANGE_UNSUPPORTED });
          await writeAll(fh, buf, offset);
          offset += buf.length;
          got += buf.length;
          bump(part.index, got);
        }

        const want = part.end - part.start;
        if (got !== want) {
          // 与官方一致的完整性校验：字节数不符则本片重下
          throw new QuarkError(
            `分片数据不完整（收到 ${got} 字节，应为 ${want} 字节）`,
            { code: ErrCode.NETWORK }
          );
        }
        return;
      } catch (e) {
        bump(part.index, 0);
        if (e && e.code === ErrCode.ABORTED) throw e;
        if (isNeedLogin(e)) throw e;
        // 分片不支持 Range：直接放弃并行模式
        if (e && e.code === ErrCode.RANGE_UNSUPPORTED) throw e;
        lastErr = e;
        // 直链过期 → 重新取链后继续（官方 switchLink 行为）
        if (isLinkExpired(e)) {
          try {
            const links = await api.downloadUrl([fid], { signal });
            currentUrl = links[0].url;
          } catch (le) {
            if (isNeedLogin(le)) throw le;
          }
        }
        if (attempt < maxPartRetries) {
          await sleep(Math.min(500 * 2 ** (attempt - 1), 4000), workerSignal);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new QuarkError('分片下载失败', { code: ErrCode.SERVER });
  };

  try {
    // 并发执行（每个分片完成后写入 done 并持久化）
    const pending = parts.filter((p) => done[p.index] === undefined);
    let failure = null;
    let cursor = 0;
    const workers = new Array(Math.max(1, Math.min(parallel, pending.length || 1)))
      .fill(0)
      .map(async () => {
        for (;;) {
          if (failure || workerSignal.aborted) return;
          const i = cursor;
          cursor += 1;
          if (i >= pending.length) return;
          const part = pending[i];
          try {
            await fetchPart(part);
            await fh.sync();
            done[part.index] = part.end - part.start;
            await persist();
          } catch (e) { if (!failure) { failure = e; workerAbort.abort(); } return; }
        }
      });

    try {
      await Promise.all(workers);
      if (failure) throw failure;
    } catch (e) {
      // 若是"不支持 Range"导致，向上抛出后由 downloadFile 的重试逻辑处理；
      // 这里先把已完成的进度落盘，保证下次能续传
      await persist();
      throw e;
    }

    await persist();

    // 最终完整性校验：所有分片都完成且总字节一致
    const missing = parts.filter((p) => done[p.index] !== p.end - p.start);
    if (missing.length) {
      throw new QuarkError(`仍有 ${missing.length} 个分片未完成`, { code: ErrCode.NETWORK });
    }
  } finally {
    await fh.close().catch(() => {});
  }

  await commitPartial(tempPath, cfgPath, signal);
  return { bytes: total, multipart: true };
}

// ===========================================================================
// 单流下载（小文件 / 不支持 Range 时的降级路径）
// ===========================================================================

async function downloadSingleStream({
  url, tempPath, cfgPath, fid, http, api, signal, onProgress, total, onResumed,
}) {
  let cfg = await readJsonSafe(cfgPath);
  let existing = 0;
  try {
    const st = await fsp.stat(tempPath);
    existing = st.size;
  } catch {
    existing = 0;
  }
  // 只有同一 fid、且模式一致时才续传
  if (!cfg || cfg.fid !== fid || cfg.mode === 'multi' || existing <= 0 || (total > 0 && cfg.total > 0 && cfg.total !== total)) {
    cfg = null;
    existing = 0;
  }
  // 已写满的单流进度：中断发生于收尾之前，无需发出超出范围的 bytes=total- 请求。
  if (existing > 0 && cfg && cfg.total === existing && cfg.received === existing) {
    await commitPartial(tempPath, cfgPath, signal);
    if (onResumed) onResumed();
    return { bytes: existing, multipart: false };
  }

  const headers = {};
  let wantRange = false;
  if (existing > 0) {
    headers.range = `bytes=${existing}-`;
    wantRange = true;
  }

  const res = await http.request({
    path: url,
    absolute: true,
      direct: true,
    method: 'GET',
    raw: true,
    headers,
    signal,
    retries: 0,
    timeout: 0,
  });

  const status = res.status;
  let startAt;

  if (wantRange && status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(res.headers.get('content-range') || '');
    const etag = (res.headers.get('etag') || '').replace(/^"|"$/g, '');
    if (!range || Number(range[1]) !== existing || (total > 0 && Number(range[3]) !== total) || (cfg.etag && etag && cfg.etag !== etag)) {
      if (res.body) await res.body.cancel().catch(() => {});
      await fsp.rm(tempPath, { force: true });
      await fsp.rm(cfgPath, { force: true });
      return downloadSingleStream({ url, tempPath, cfgPath, fid, http, api, signal, onProgress, total });
    }
    startAt = existing;
    if (onResumed) onResumed();
  } else if (wantRange && status === 200) {
    // CDN 忽略了 Range：必须从 0 重写，否则文件会损坏。
    // 依据 docs/API_NOTES.md 待确认项 5 —— Range 支持情况未经真实账号验证，此为安全兜底。
    startAt = 0;
    await fsp.rm(tempPath, { force: true });
    await fsp.rm(cfgPath, { force: true });
    cfg = null;
  } else {
    startAt = 0;
  }

  let size = total > 0 ? total : 0;
  const cr = res.headers.get('content-range');
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) size = Number(m[1]) || size;
  }
  if (!size) {
    const cl = Number(res.headers.get('content-length'));
    if (Number.isFinite(cl) && cl > 0) size = startAt + cl;
  }
  if (!size && cfg && cfg.total) size = cfg.total;

  const etag = (res.headers.get('etag') || '').replace(/^"|"$/g, '');
  const fh = await fsp.open(tempPath, startAt > 0 ? 'r+' : 'w');
  let written = startAt;
  let pos = startAt; // 'r+' 句柄位置从 0 开始，必须显式维护偏移
  let lastFlush = Date.now();

  const persist = async () => {
    try {
      await writeJsonAtomic(cfgPath, {
        fid, total: size, received: written, etag, mode: 'single', updatedAt: Date.now(),
      });
    } catch {
      /* ignore */
    }
  };

  try {
    if (startAt > 0) await fh.truncate(startAt);
    await persist();

    const body = res.body;
    if (!body) throw new QuarkError('下载响应没有内容', { code: ErrCode.SERVER });

    for await (const chunk of iterateBody(body)) {
      if (signal && signal.aborted) throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!buf.length) continue;
      if (size > 0 && pos + buf.length > size) throw new QuarkError('下载响应超出文件大小', { code: ErrCode.NETWORK });
      await writeAll(fh, buf, pos);
      pos += buf.length;
      written += buf.length;
      if (onProgress) onProgress({ transferred: written, total: size });
      if (Date.now() - lastFlush > PROGRESS_FLUSH_MS) {
        lastFlush = Date.now();
        await persist();
      }
    }

    if (size > 0 && written !== size) {
      await persist();
      throw new QuarkError(
        `下载未完成（已收到 ${written} 字节，应为 ${size} 字节）`,
        { code: ErrCode.NETWORK }
      );
    }
    await fh.sync().catch(() => {});
  } finally {
    await fh.sync().catch(() => {});
    await persist();
    await fh.close().catch(() => {});
  }

  await persist();
  await commitPartial(tempPath, cfgPath, signal);
  return { bytes: written, multipart: false };
}

/** 取消/失败时清理临时文件与进度文件（保证"要么完整、要么不存在"）。 */
async function cleanupPartial(finalPath) {
  const tempPath = `${finalPath}${TEMP_SUFFIX}`;
  await fsp.rm(tempPath, { force: true });
  await fsp.rm(`${tempPath}${CFG_SUFFIX}`, { force: true });
}

/** 探测某路径对应的临时文件是否存在（用于判断能否续传）。 */
async function hasPartial(finalPath) {
  try {
    await fsp.access(`${finalPath}${TEMP_SUFFIX}`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  downloadFile,
  cleanupPartial,
  hasPartial,
  safeFileName,
  uniquePath,
  divideParts,
  probeRange,
  isLinkExpired,
  iterateBody,
  TEMP_SUFFIX,
  CFG_SUFFIX,
  MULTIPART_THRESHOLD,
  PART_SIZE,
  DEFAULT_PARALLEL,
};
