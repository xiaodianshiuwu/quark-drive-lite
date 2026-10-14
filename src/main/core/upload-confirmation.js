'use strict';
const { QuarkError, ErrCode } = require('./errors');
const { sleep } = require('./http');

/** 仅调用已取证的目录列表接口，避免把旧同名文件当成本次上传结果。 */
async function matchingFiles(fsModule, { pdirFid, name, signal, maxPages = 1000 }) {
  const matches = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    if (signal?.aborted) throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
    const result = await fsModule.list({ pdirFid, page, size: 100, signal });
    const list = result?.list || [];
    for (const file of list) {
      if (!file.dir && String(file.name).normalize('NFC') === name.normalize('NFC') && !seen.has(file.fid)) { matches.push(file); seen.add(file.fid); }
    }
    if (!result.hasMore || list.length === 0) return matches;
  }
  throw new QuarkError('目标目录过大，尚未确认上传结果，请到目标目录核对', { code: ErrCode.TASK_FAILED });
}

async function confirmUpload(fsModule, { pdirFid, result, baseline, signal, timeout = 30000, interval = 500 }) {
  const deadline = Date.now() + timeout;
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeout));
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const previous = new Map(baseline.map(file => [file.fid, file]));
  try {
    for (;;) {
      const files = await matchingFiles(fsModule, { pdirFid, name: result.name, signal: combined });
      const changed = files.filter(file => {
        const old = previous.get(file.fid);
        return file.size === result.size && (!old || file.size !== old.size || file.updatedAt > old.updatedAt);
      });
      if (changed.length === 1) return changed[0];
      if (changed.length > 1) throw new QuarkError('出现多个同名上传结果，尚未确认归属，请到目标目录核对', { code: ErrCode.CONFLICT });
      if (Date.now() >= deadline) break;
      await sleep(Math.min(interval, deadline - Date.now()), combined);
    }
  } catch (error) {
    if (signal?.aborted || !timeoutSignal.aborted) throw error;
  }
  throw new QuarkError('服务端已接收上传，但尚未确认目标文件及大小；重试只核对结果，不重复上传', { code: ErrCode.TASK_FAILED });
}
module.exports = { matchingFiles, confirmUpload };
