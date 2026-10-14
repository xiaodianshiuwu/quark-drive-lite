'use strict';
/**
 * 设置模块：下载目录、并发数、主题。
 * 存储复用 secure-store（与登录态同一套原子写入 + 加密能力）。
 *
 * 并发分为两类，互不干扰，共同决定"多文件"与"大文件"的速度：
 *   - `downloadConcurrency` / `uploadConcurrency`：**同时进行的文件数**
 *   - `downloadParallel`：**单个大文件的并行连接数**（对齐官方 partitionParallelNum）
 *   - `uploadPartConcurrency`：**单个大文件的分片预读并发，实际 PUT 顺序执行数**
 */
const os = require('os');
const path = require('path');

const DEFAULTS = Object.freeze({
  downloadDir: '',
  uploadConcurrency: 2, // 同时上传的文件数
  downloadConcurrency: 2, // 同时下载的文件数
  downloadParallel: 4, // 单文件下载并行连接数（官方同量级）
  uploadPartConcurrency: 2, // 单文件上传分片并发数
  theme: 'light',
});

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function defaultDownloadDir() {
  try {
    return path.join(os.homedir(), 'Downloads');
  } catch {
    return os.tmpdir();
  }
}

function createSettingsModule({ store }) {
  let cache = null;

  function readAll() {
    const raw = store.getItem('settings');
    const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (!merged.downloadDir) merged.downloadDir = defaultDownloadDir();
    // 文件级并发：过高会被服务端限流，也容易耗尽本机连接
    merged.uploadConcurrency = clampInt(merged.uploadConcurrency, 1, 8, DEFAULTS.uploadConcurrency);
    merged.downloadConcurrency = clampInt(merged.downloadConcurrency, 1, 5, DEFAULTS.downloadConcurrency);
    // 分片级并发：官方参数档位最高约 16，这里给到 16
    merged.downloadParallel = clampInt(merged.downloadParallel, 1, 16, DEFAULTS.downloadParallel);
    merged.uploadPartConcurrency = clampInt(
      merged.uploadPartConcurrency, 1, 8, DEFAULTS.uploadPartConcurrency
    );
    if (merged.theme !== 'dark') merged.theme = 'light';
    return merged;
  }

  return {
    /** 读取全部设置（带缓存） */
    get() {
      if (!cache) cache = readAll();
      return { ...cache };
    },

    /** 局部更新并持久化，返回更新后的完整设置 */
    set(patch) {
      const cur = this.get();
      const next = { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) };
      if (next.downloadDir && typeof next.downloadDir !== 'string') next.downloadDir = cur.downloadDir;
      next.uploadConcurrency = clampInt(next.uploadConcurrency, 1, 8, cur.uploadConcurrency);
      next.downloadConcurrency = clampInt(next.downloadConcurrency, 1, 5, cur.downloadConcurrency);
      next.downloadParallel = clampInt(next.downloadParallel, 1, 16, cur.downloadParallel);
      next.uploadPartConcurrency = clampInt(
        next.uploadPartConcurrency, 1, 8, cur.uploadPartConcurrency
      );
      if (next.theme !== 'dark') next.theme = 'light';
      cache = next;
      store.setItem('settings', next);
      return { ...next };
    },

    /** 供传输模块读取下载目录 */
    getDownloadDir() {
      return this.get().downloadDir;
    },

    /** 供传输模块读取并发配置 */
    getConcurrency() {
      const s = this.get();
      return {
        upload: s.uploadConcurrency,
        download: s.downloadConcurrency,
        downloadParallel: s.downloadParallel,
        uploadPartConcurrency: s.uploadPartConcurrency,
      };
    },
  };
}

module.exports = { createSettingsModule, DEFAULTS, defaultDownloadDir };
