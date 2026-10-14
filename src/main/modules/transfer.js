'use strict';
/**
 * 传输任务管理 —— 上传 / 下载的统一队列。
 *
 * 需求对应：传输任务管理、网络操作异步执行、不阻塞 UI、失败重试、断点续传、
 * 上传/下载并发控制、实时速度与剩余时间。
 *
 * 关键契约（docs/IPC_CONTRACT.md 第 4 节）：
 *   - `upload()` / `download()` **同步立即返回**任务 id 数组，绝不在返回前 await 网络。
 *   - 通过 onUpdate 推送**全量快照**，频率 ≤ 4 次/秒（节流在本模块内实现）。
 *   - TransferTask 字段严格对齐契约（含 speed / eta / attempts / errorCode）。
 *
 * 状态机：pending → running → done | error | canceled | paused
 */

const path = require('path');
const crypto = require('crypto');

const { ErrCode, QuarkError, isNeedLogin, isRetryable } = require('./../core/errors');
const { sleep } = require('../core/http');
const { createTransferApi } = require('../core/api-transfer');
const { downloadFile, cleanupPartial, safeFileName } = require('../core/download');
const { uploadFile } = require('../core/upload');

const UPDATE_THROTTLE_MS = 250; // ≤ 4 次/秒
const SPEED_WINDOW_MS = 3000;
const MAX_RETRIES = 3;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createTransferModule(o = {}) {
  const {
    http,
    fsModule, // 保留以便未来在传输后刷新列表；目前不直接调用
    getDownloadDir = () => '',
    getConcurrency = () => ({ upload: 2, download: 2 }),
    onUpdate = () => {},
    onError = () => {},
  } = o;

  if (!http) throw new Error('createTransferModule 需要 http 实例');
  const api = createTransferApi({ http });

  /** @type {Map<string, any>} */
  const tasks = new Map();
  /** 运行中的 controller，用于 pause/cancel */
  const controllers = new Map();
  const executions = new Map();
  /** 每个任务的样本：[[ts, transferred], ...] 用于算速度 */
  const samples = new Map();

  let lastEmit = 0;
  let emitTimer = null;

  // -------------------------------------------------------------------------
  // 推送（节流）
  // -------------------------------------------------------------------------
  function snapshot() {
    return [...tasks.values()].map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      size: t.size,
      transferred: t.transferred,
      status: t.status,
      error: t.error,
      errorCode: t.errorCode,
      attempts: t.attempts,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      localPath: t.localPath,
      pdirFid: t.pdirFid,
      fid: t.fid,
      localDir: t.localDir,
      speed: t.speed,
      eta: t.eta,
    }));
  }

  function emitNow() {
    lastEmit = Date.now();
    try {
      onUpdate(snapshot());
    } catch {
      /* UI 回调异常不应影响传输 */
    }
  }

  /** 节流推送：最多每 250ms 一次，尾部保证最终状态一定送达。 */
  function emit() {
    const now = Date.now();
    if (now - lastEmit >= UPDATE_THROTTLE_MS) {
      if (emitTimer) {
        clearTimeout(emitTimer);
        emitTimer = null;
      }
      emitNow();
      return;
    }
    if (!emitTimer) {
      emitTimer = setTimeout(() => {
        emitTimer = null;
        emitNow();
      }, UPDATE_THROTTLE_MS - (now - lastEmit));
    }
  }

  // -------------------------------------------------------------------------
  // 速度 / 剩余时间
  // -------------------------------------------------------------------------
  function recordSample(t) {
    const list = samples.get(t.id) || [];
    const now = Date.now();
    list.push([now, t.transferred]);
    const cutoff = now - SPEED_WINDOW_MS;
    while (list.length > 2 && list[0][0] < cutoff) list.shift();
    samples.set(t.id, list);

    if (list.length < 2) {
      t.speed = 0;
      t.eta = -1;
      return;
    }
    const [t0, b0] = list[0];
    const [t1, b1] = list[list.length - 1];
    const dt = (t1 - t0) / 1000;
    const db = b1 - b0;
    t.speed = dt > 0 ? Math.max(0, Math.round(db / dt)) : 0;
    if (t.speed > 0 && t.size > 0) {
      const remain = t.size - t.transferred;
      t.eta = remain > 0 ? Math.round(remain / t.speed) : 0;
    } else {
      t.eta = -1;
    }
  }

  function touch(t) {
    t.updatedAt = Date.now();
    recordSample(t);
    emit();
  }

  function failTask(t, e) {
    t.status = 'error';
    const localMessages = { ENOSPC:'本地磁盘空间不足，请清理空间或更换目录',
      EACCES:'没有权限访问本地文件，请更换目录', EPERM:'本地文件无法访问，可能被占用或权限不足',
      ENOENT:'本地文件或目录不存在' };
    t.error = localMessages[e && e.code] || (e && /[\u4e00-\u9fff]/.test(e.message) ? e.message : '传输失败，请检查网络和本地文件');
    t.errorCode = (e && e.code) || ErrCode.UNKNOWN;
    t.updatedAt = Date.now();
    emit();
    try {
      onError(e, t);
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // 调度
  // -------------------------------------------------------------------------
  let pumping = false;

  function canRun(kind) {
    const cfg = getConcurrency() || {};
    const limit = Math.max(1, Number(kind === 'upload' ? cfg.upload : cfg.download) || 2);
    let running = 0;
    for (const t of tasks.values()) {
      if (t.kind === kind && controllers.has(t.id)) running += 1;
    }
    return running < limit;
  }

  /** 取下一个待执行任务并启动；不阻塞调用方。 */
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        let picked = null;
        for (const t of tasks.values()) {
          if (t.status === 'pending' && !controllers.has(t.id) && canRun(t.kind)) {
            picked = t;
            break;
          }
        }
        if (!picked) break;
        startTask(picked);
      }
    } finally {
      pumping = false;
    }
  }

  function startTask(t) {
    const controller = new AbortController();
    controllers.set(t.id, controller);
    t.status = 'running';
    t.transferred = 0;
    t.attempts = 0;
    t.error = undefined;
    t.errorCode = undefined;
    samples.set(t.id, []);
    touch(t);

    const execution = runWithRetry(t, controller.signal)
      .then((r) => {
        if (controller.signal.aborted || t.status !== 'running') return;
        t.status = 'done';
        t.transferred = t.size || t.transferred;
        t.speed = 0;
        t.eta = 0;
        if (r && r.localPath) t.localPath = r.localPath;
        if (r && typeof r.bytes === 'number' && !t.size) t.size = r.bytes;
        t.updatedAt = Date.now();
        emit();
      })
      .catch((e) => {
        if (controller.signal.aborted || t.status !== 'running') return;
        if (e && e.code === ErrCode.ABORTED) {
          // 区分"暂停"与"取消"：暂停时 status 已由调用方置为 paused
          if (t.status !== 'paused' && t.status !== 'canceled') {
            t.status = 'canceled';
            t.updatedAt = Date.now();
            emit();
          }
          return;
        }
        failTask(t, e);
      })
      .finally(async () => {
        if (t.status === 'canceled' && t.kind === 'download' && t.localPath) {
          await cleanupPartial(t.localPath).catch(() => {});
        }
        controllers.delete(t.id);
        executions.delete(t.id);
        pump();
      });
    executions.set(t.id, execution);
  }

  async function runWithRetry(t, signal) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      t.attempts = attempt;
      try {
        return await runOnce(t, signal);
      } catch (e) {
        if (e && e.code === ErrCode.ABORTED) throw e;
        if (isNeedLogin(e)) throw e;
        // 上传分片内部已经重试；整次重新预登记可能产生重复文件。
        if (t.kind === 'upload' || !isRetryable(e)) throw e;
        if (attempt > MAX_RETRIES) throw e;
        // 指数退避 1s / 2s / 4s
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000), signal);
        if (signal.aborted) throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
      }
    }
  }

  async function runOnce(t, signal) {
    const onProgress = (p) => {
      if (signal.aborted || t.status !== 'running') return;
      if (p && typeof p.transferred === 'number') {
        t.transferred = p.transferred;
        if (Number.isFinite(p.total) && p.total >= 0) t.size = p.total;
        touch(t);
      }
    };

    if (t.kind === 'download') {
      if (!t._metadataLoaded && fsModule && typeof fsModule.info === 'function') {
        const item = await fsModule.info(t.fid, { signal });
        if (signal.aborted) throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
        if (item.dir) throw new QuarkError('暂不支持下载文件夹，请进入文件夹选择文件', { code: ErrCode.INVALID_ARG });
        t.size = item.size;
        if (t.name === t.fid && item.name) t.name = safeFileName(item.name);
        t._metadataLoaded = true;
      }
      const c = getConcurrency() || {};
      return downloadFile({
        fid: t.fid,
        fileName: t.name,
        localDir: t.localDir,
        http,
        api,
        signal,
        onProgress,
        // 已知大小可省去一次探测请求
        size: t.size > 0 ? t.size : undefined,
        // 单文件并行连接数（对齐官方 partitionParallelNum）：决定**大文件**速度
        parallel: Math.max(1, Number(c.downloadParallel) || 4),
        maxRetries: 0,
        targetPath: t.localPath,
        // 目标路径一确定就记下来，取消时才能清理未完成的临时文件
        onTarget: (finalPath) => {
          t.localPath = finalPath;
        },
      });
    }
    const c2 = getConcurrency() || {};
    return uploadFile({
      localPath: t.localPath,
      pdirFid: t.pdirFid,
      http,
      api,
      signal,
      onProgress,
      // 单文件分片并发数：决定**大文件**上传速度
      concurrency: Math.max(1, Number(c2.uploadPartConcurrency) || 2),
      checkpoint: t._uploadState || (t._uploadState = {}),
    });
  }

  // -------------------------------------------------------------------------
  // 对外 API
  // -------------------------------------------------------------------------
  return {
    list() {
      return snapshot();
    },

    /**
     * 入队上传。**立即返回**任务 id 数组。
     * @param {{localPaths:string[], pdirFid?:string}} p
     */
    upload(p = {}) {
      const paths = Array.isArray(p.localPaths) ? p.localPaths.filter(Boolean) : [];
      const pdirFid = p.pdirFid || '0';
      const ids = [];
      for (const lp of paths) {
        const id = uid();
        tasks.set(id, {
          id,
          kind: 'upload',
          name: path.basename(lp),
          size: 0, // 真实大小在执行时由 stat 得到；避免入队时做同步 IO 阻塞 UI
          transferred: 0,
          status: 'pending',
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          localPath: lp,
          pdirFid,
          speed: 0,
          eta: -1,
        });
        ids.push(id);
      }
      if (ids.length) {
        emit();
        // 用 microtask 启动，确保 upload() 先返回（严格不阻塞调用方）
        queueMicrotask(pump);
      }
      return ids;
    },

    /**
     * 入队下载。**立即返回**任务 id 数组。
     * @param {{fids:string[], localDir?:string, names?:string[]}} p
     */
    download(p = {}) {
      const fids = Array.isArray(p.fids) ? p.fids.filter(Boolean) : [];
      const localDir = p.localDir || getDownloadDir() || '';
      const names = Array.isArray(p.names) ? p.names : [];
      const ids = [];
      for (let i = 0; i < fids.length; i += 1) {
        const fid = fids[i];
        const id = uid();
        tasks.set(id, {
          id,
          kind: 'download',
          name: safeFileName(names[i] || fid),
          size: 0,
          transferred: 0,
          status: 'pending',
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          fid,
          localDir,
          speed: 0,
          eta: -1,
        });
        ids.push(id);
      }
      if (ids.length) {
        emit();
        queueMicrotask(pump);
      }
      return ids;
    },

    async pause(id) {
      const t = tasks.get(id);
      if (!t) return;
      if (t.status !== 'running' && t.status !== 'pending') return;
      t.status = 'paused';
      t.updatedAt = Date.now();
      const c = controllers.get(id);
      if (c) c.abort();
      t.speed = 0;
      t.eta = -1;
      emit();
      await executions.get(id);
      queueMicrotask(pump);
    },

    async resume(id) {
      const t = tasks.get(id);
      if (!t) return;
      if (t.status !== 'paused' && t.status !== 'error') return;
      t.status = 'pending';
      t.updatedAt = Date.now();
      emit();
      queueMicrotask(pump);
    },

    async retry(id) {
      const t = tasks.get(id);
      if (!t) return;
      if (t.status !== 'error' && t.status !== 'canceled') return;
      t.status = 'pending';
      t.error = undefined;
      t.errorCode = undefined;
      t.attempts = 0;
      t.transferred = 0;
      t.updatedAt = Date.now();
      emit();
      queueMicrotask(pump);
    },

    async cancel(id) {
      const t = tasks.get(id);
      if (!t) return;
      if (t.status === 'done' || t.status === 'canceled') return;
      const c = controllers.get(id);
      const execution = executions.get(id);
      if (c) c.abort();
      t.status = 'canceled';
      t.updatedAt = Date.now();
      t.speed = 0;
      t.eta = -1;
      emit();
      await execution;
      // 清理下载残留，保证"要么完整、要么不存在"
      if (!execution && t.kind === 'download' && t.localPath) {
        try {
          await cleanupPartial(t.localPath);
        } catch {
          /* 清理失败不影响取消语义 */
        }
      }
      emit();
      queueMicrotask(pump);
    },

    async clear(ids) {
      const list = Array.isArray(ids) ? ids : [ids];
      for (const id of list) {
        const t = tasks.get(id);
        // 只允许清除已结束的任务，避免把正在跑的任务从列表里"抹掉"
        if (t && !controllers.has(id) && (t.status === 'done' || t.status === 'error' || t.status === 'canceled')) {
          tasks.delete(id);
          samples.delete(id);
        }
      }
      emit();
    },

    /** 打开任务对应的本地文件所在位置（由 main.js 的 shell 实现，这里给出路径）。 */
    openItem(id) {
      const t = tasks.get(id);
      if (!t) return null;
      return t.localPath || t.localDir || null;
    },
  };
}

module.exports = { createTransferModule };
