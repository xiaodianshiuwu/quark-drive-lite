'use strict';
/**
 * 上传引擎 —— 单个文件的上传执行器。
 *
 * 需求对应：上传文件至网盘、不阻塞 UI、失败重试、支持暂停/继续/取消。
 *
 * 链路（docs/API_NOTES.md 第 6 节，双重取证：官方客户端 app.asar + OpenList）：
 *   1. 流式计算 md5 / sha1
 *   2. POST /1/clouddrive/file/upload/pre        → task_id / obj_key / bucket / upload_id / auth_info / part_size
 *      若返回 finish=true → 秒传，直接结束
 *   3. 逐片：POST /1/clouddrive/file/upload/auth  → auth_key
 *            PUT  https://{bucket}.{host}/{obj_key}?partNumber=n&uploadId=id
 *   4. 全部完成：POST /1/clouddrive/file/upload/auth（POST 版 auth_meta）→ auth_key
 *               POST 同一 OSS 地址（?uploadId=id），body 为 CompleteMultipartUpload XML
 *   5. POST /1/clouddrive/file/upload/finish     → { obj_key, task_id }
 *
 * 实现约束
 * - 全程流式读取（不整file读入内存），支持大文件。
 * - `x-oss-date` 与 `x-oss-user-agent` 在**签名串**与**实际请求头**中必须完全一致
 *   （自洽铁律，否则 OSS 校验失败）。
 * - 分片并发默认 2，单片失败最多重试 3 次；已完成分片在 resume 时不重传。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { QuarkError, ErrCode, isNeedLogin, isRetryable } = require('./errors');
const {
  buildAuthMetaPut,
  buildAuthMetaComplete,
  buildCompleteXml,
  divideParts,
  resolveOssUrl,
  ossDateNow,
} = require('./api-transfer');

const DEFAULT_CONCURRENCY = 2;
const PART_RETRIES = 3;

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

/** 依据扩展名猜 MIME（仅覆盖常见类型，够用且零依赖）。 */
const MIME_MAP = {
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.exe': 'application/x-msdownload',
  '.msi': 'application/x-msdownload',
  '.apk': 'application/vnd.android.package-archive',
  '.iso': 'application/x-iso9660-image',
};

function guessMime(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/** 流式计算 md5 + sha1（单次读取，避免读两遍文件）。 */
function calcHashes(filePath, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    const rs = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    let read = 0;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      rs.destroy();
      reject(e);
    };
    const onAbort = () => fail(new QuarkError('操作已取消', { code: ErrCode.ABORTED }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    rs.on('data', (buf) => {
      md5.update(buf);
      sha1.update(buf);
      read += buf.length;
      if (onProgress) onProgress(read);
    });
    rs.on('error', (e) => fail(new QuarkError(`读取本地文件失败：${e.message}`, { code: ErrCode.UNKNOWN, cause: e })));
    rs.on('end', () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ md5: md5.digest('hex'), sha1: sha1.digest('hex') });
    });
  });
}

/** 读取文件某个区间为 Buffer（分片上传用；分片大小有限，可安全驻留内存）。 */
function readRange(filePath, start, end, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const rs = fs.createReadStream(filePath, { start, end: end - 1 });
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      rs.destroy();
      reject(e);
    };
    const onAbort = () => fail(new QuarkError('操作已取消', { code: ErrCode.ABORTED }));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    rs.on('data', (c) => chunks.push(c));
    rs.on('error', (e) => fail(new QuarkError(`读取文件分片失败：${e.message}`, { code: ErrCode.UNKNOWN, cause: e })));
    rs.on('end', () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(Buffer.concat(chunks));
    });
  });
}

/** 分片区间覆盖的总字节数（用于自检"该传的都传了"）。 */
function uploadedTotal(parts, size) {
  return parts.reduce((sum, p) => sum + (p.end - p.start), 0);
}

/** 并发受限的 map（保持顺序返回）。 */
async function mapLimit(items, limit, worker, onError = () => {}) {
  const out = new Array(items.length);
  let cursor = 0;
  let failure = null;
  const n = Math.max(1, Math.min(limit, items.length));
  const runners = new Array(n).fill(0).map(async () => {
    for (;;) {
      if (failure) return;
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) {
        if (!failure) { failure = e; onError(e); }
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure;
  return out;
}

/**
 * 上传一个文件。
 *
 * @param {object} o
 * @param {string} o.localPath     本地文件绝对路径
 * @param {string} o.pdirFid       目标目录 fid（根目录为 '0'）
 * @param {object} o.http          HttpClient
 * @param {object} o.api           createTransferApi 实例
 * @param {AbortSignal} [o.signal]
 * @param {(p:{transferred:number,total:number,phase:string})=>void} [o.onProgress]
 * @param {number} [o.concurrency] 分片并发，默认 2
 * @returns {Promise<{name:string,size:number,instant:boolean}>}
 */
async function uploadFile(o) {
  const {
    localPath,
    pdirFid = '0',
    http,
    api,
    signal: outerSignal,
    onProgress,
    concurrency = DEFAULT_CONCURRENCY,
    checkpoint = {},
  } = o || {};

  if (!localPath) throw new QuarkError('未指定要上传的文件', { code: ErrCode.INVALID_ARG });

  let st;
  try {
    st = await fsp.stat(localPath);
  } catch (e) {
    throw new QuarkError(`无法读取本地文件：${path.basename(localPath)}`, {
      code: ErrCode.NOT_FOUND,
      cause: e,
    });
  }
  if (!st.isFile()) {
    throw new QuarkError('只能上传文件（暂不支持上传文件夹）', { code: ErrCode.INVALID_ARG });
  }

  const fileName = path.basename(localPath);
  const size = st.size;
  const workerAbort = new AbortController();
  const signal = outerSignal ? AbortSignal.any([outerSignal, workerAbort.signal]) : workerAbort.signal;
  if (checkpoint.localPath !== localPath || checkpoint.size !== size || checkpoint.mtimeMs !== st.mtimeMs) {
    for (const key of Object.keys(checkpoint)) delete checkpoint[key];
    Object.assign(checkpoint, { localPath, size, mtimeMs: st.mtimeMs });
  }
  const mime = guessMime(fileName);

  const report = (transferred, phase) => {
    if (onProgress) onProgress({ transferred, total: size, phase });
  };

  // ---- 1. 计算哈希（占进度前 0%，仅用于秒传判定与服务端校验） ----
  report(0, 'hashing');
  const { md5, sha1 } = checkpoint.hashes || await calcHashes(localPath, signal);
  checkpoint.hashes = { md5, sha1 };

  // ---- 2. 预登记 ----
  report(0, 'preparing');
  const pre = checkpoint.pre || await api.uploadPre(
    { fileName, size, pdirFid, formatType: mime, dirName: '' },
    { signal }
  );
  checkpoint.pre = pre;

  if (pre.finish) {
    report(size, 'done');
    return { name: fileName, size, instant: true };
  }

  // 秒传校验：告知服务端哈希，若已存在则可直接完成
  if (pre.taskId) {
    try {
      const instant = await api.updateHash({ md5, sha1, taskId: pre.taskId }, { signal });
      if (instant) {
        report(size, 'done');
        return { name: fileName, size, instant: true };
      }
    } catch (e) {
      // 秒传校验失败不影响正常上传流程（例如该接口对某些账号不可用）
      if (isNeedLogin(e) || e.code === ErrCode.ABORTED) throw e;
    }
  }

  const { objKey, bucket, uploadId, uploadUrl, authInfo, callback } = pre;
  if (!uploadId || !objKey) {
    throw new QuarkError('服务端返回的上传信息不完整，无法继续上传', { code: ErrCode.SERVER });
  }

  // ---- 3. 分片上传 ----
  const partSize = pre.partSize;

  // 防御性校验（纵深防御）：
  // api 层已经校验过 part_size，但 uploadFile 是导出给外部直接调用的，
  // 若此处不校验，一个非法/缺失的 partSize 会让 divideParts 返回空数组，
  // 于是 **跳过全部分片直接调用 uploadFinish** —— 静默产生"上传成功但文件是空的"，
  // 属于最危险的一类缺陷。因此在真正切分片之前必须再拦一道。
  if (size > 0 && !(Number.isFinite(partSize) && partSize > 0)) {
    throw new QuarkError('服务端未返回有效的分片大小，无法上传', { code: ErrCode.SERVER });
  }
  if (size > 0 && partSize % 65536 !== 0) {
    throw new QuarkError(
      `服务端返回的分片大小不合法（${partSize}，必须是 65536 的整数倍）`,
      { code: ErrCode.SERVER }
    );
  }

  const parts = divideParts(size, partSize);

  // size 为 0 的空文件：无分片可传，直接走收尾
  if (parts.length === 0) {
    await finishUpload({ api, objKey, taskId: pre.taskId, signal });
    report(size, 'done');
    return { name: fileName, size, instant: false };
  }

  // 再次确认没有"该传却没传"的情况
  if (uploadedTotal(parts, size) !== size) {
    throw new QuarkError('分片规划与文件大小不一致，已中止上传', { code: ErrCode.SERVER });
  }

  const completed = checkpoint.parts || (checkpoint.parts = {});
  const doneBytes = parts.map((p) => completed[p.partNumber] ? p.end - p.start : 0);
  let uploadedBytes = doneBytes.reduce((a, b) => a + b, 0);
  const pushProgress = () => {
    report(uploadedBytes, 'uploading');
  };
  // 当前 pds 目标实测要求连续编号顺序 PUT，否则返回 PartNotSequential。
  // 分片可并发预读，真正签名和 PUT 必须等上一片完成。
  const turns = parts.map(() => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
  });
  const waitTurn = index => {
    if (index === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new QuarkError('操作已取消', { code: ErrCode.ABORTED }));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      turns[index - 1].promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
    });
  };

  const etags = await mapLimit(parts, concurrency, async (part) => {
    if (completed[part.partNumber]) {
      turns[part.partNumber - 1].resolve();
      return completed[part.partNumber];
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= PART_RETRIES; attempt += 1) {
      try {
        const buf = await readRange(localPath, part.start, part.end, signal);
        if (buf.length !== part.end - part.start) {
          throw new QuarkError('本地文件在上传过程中发生变化，请重新选择文件', { code: ErrCode.INVALID_ARG });
        }
        await waitTurn(part.partNumber - 1);
        if (signal.aborted) throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });

        // 每片独立取签名；ossDate 必须与实际请求头一致
        const ossDate = ossDateNow();
        const authMeta = buildAuthMetaPut({
          mime,
          ossDate,
          bucket,
          objKey,
          partNumber: part.partNumber,
          uploadId,
        });
        const authKey = await api.uploadAuth(
          { taskId: pre.taskId, authInfo, authMeta },
          { signal }
        );

    const etag = await api.ossPutPart({
          url: `${resolveOssUrl(uploadUrl, bucket, objKey)}?partNumber=${part.partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
          authKey,
          mime,
          ossDate,
          body: buf,
          contentLength: buf.length,
          signal,
        });

        doneBytes[part.partNumber - 1] = buf.length;
        uploadedBytes = doneBytes.reduce((a, b) => a + b, 0);
        pushProgress();
        const done = { partNumber: part.partNumber, etag };
        completed[part.partNumber] = done;
        turns[part.partNumber - 1].resolve();
        return done;
      } catch (e) {
        lastErr = e;
        if (e && e.code === ErrCode.ABORTED) throw e;
        if (isNeedLogin(e)) throw e;
        // 单片的 403 通常是签名/时间漂移，重试一次往往即可命中
        if (attempt < PART_RETRIES && (isRetryable(e) || e.httpStatus === 403)) {
          await sleep(Math.min(500 * 2 ** (attempt - 1), 4000), signal);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new QuarkError('分片上传失败', { code: ErrCode.SERVER });
  }, () => workerAbort.abort());

  const current = await fsp.stat(localPath);
  if (current.size !== size || current.mtimeMs !== st.mtimeMs) {
    throw new QuarkError('本地文件在上传过程中发生变化，已停止提交', { code: ErrCode.INVALID_ARG });
  }

  // ---- 4. 完成分片（OSS CompleteMultipartUpload） ----
  report(uploadedBytes, 'committing');
  const xml = buildCompleteXml(etags);
  const contentMd5 = crypto.createHash('md5').update(xml, 'utf8').digest('base64');
  const callbackBase64 = Buffer.from(JSON.stringify(callback || {}), 'utf8').toString('base64');

  const completeDate = ossDateNow();
  const completeMeta = buildAuthMetaComplete({
    contentMd5,
    ossDate: completeDate,
    callbackBase64,
    bucket,
    objKey,
    uploadId,
  });
  const completeKey = await api.uploadAuth(
    { taskId: pre.taskId, authInfo, authMeta: completeMeta },
    { signal }
  );

  await api.ossComplete({
    url: `${resolveOssUrl(uploadUrl, bucket, objKey)}?uploadId=${encodeURIComponent(uploadId)}`,
    authKey: completeKey,
    contentMd5,
    ossDate: completeDate,
    callbackBase64,
    xml,
    signal,
  });

  // ---- 5. 收尾 ----
  await finishUpload({ api, objKey, taskId: pre.taskId, signal });
  report(size, 'done');

  return { name: fileName, size, instant: false };
}

async function finishUpload({ api, objKey, taskId, signal }) {
  await api.uploadFinish({ objKey, taskId }, { signal });
}

module.exports = {
  uploadFile,
  guessMime,
  calcHashes,
  readRange,
  mapLimit,
  uploadedTotal,
  MIME_MAP,
  DEFAULT_CONCURRENCY,
  PART_RETRIES,
};
