'use strict';
/**
 * 登录：复用真实 Chromium 登录态（Electron 原生 Cookie 方案）。
 *
 * 机制与官方 PC 客户端一致：官方客户端本身不实现登录协议，而是调用 Chromium 原生
 * `chrome.account.openLoginWindow()` 打开应用内登录窗口，登录完成后直接读取浏览器
 * 原生 Cookie；本模块用 Electron 的 `BrowserWindow` + `session.cookies` 达到同样效果：
 *   1. 用独立持久化分区 `persist:quark-login` 打开一个真实登录窗口，用户在窗口内扫码/
 *      输手机号，滑块等风控由真实 Chromium 完成
 *   2. 轮询 `session.cookies.get()` 读取 `.quark.cn` 下**全部** Cookie（含 HttpOnly）
 *   3. 用「带 Cookie 调用判活接口」确认登录成功，而不是猜测 Cookie 名
 *      判活接口：GET https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc
 *      已登录 → HTTP 200 且 code===0；未登录 → 401 / code 31001（已本机实测）
 *
 * 说明：`require('electron')` 懒加载，纯 Node 环境下本模块可安全 require（用于单测
 * `checkAlive` 等不依赖窗口的逻辑）；只有真正调用 `start()` 时才需要 Electron 运行时。
 * 本模块不输出任何 Cookie 值。
 */

const { QuarkError, ErrCode, CODE_NEED_LOGIN } = require('./errors');

/** PC 云盘 API 基址（docs/API_NOTES.md 第 1 节）。 */
const PC_BASE_URL = 'https://drive-pc.quark.cn';
/** 判活接口路径（docs/API_NOTES.md 3.3，本机实测）。 */
const ALIVE_PATH = '/1/clouddrive/config';
const ALIVE_URL = `${PC_BASE_URL}${ALIVE_PATH}?pr=ucpro&fr=pc`;
/** 登录页。 */
const LOGIN_URL = 'https://pan.quark.cn/';

/**
 * 判活请求使用的 UA —— 复用 http.js 中按官方模板拼装的 UA，
 * 避免两处各写一份导致不一致（官方以 UA 中的 QuarkPC 标识做客户端识别）。
 */
const { DEFAULT_UA } = require('./http');

const DEFAULT_TIMEOUT = 180000;   // 登录总超时：180 秒
const DEFAULT_POLL = 1500;        // 登录态轮询间隔
const ALIVE_TIMEOUT = 20000;      // 单次判活请求超时

/** 持久化分区名：登录态保存在 userData/Partitions/quark-login，下次免扫码。 */
const LOGIN_PARTITION = 'persist:quark-login';

/**
 * 需要覆盖的 Cookie 域。实测登录后 Cookie 分散在 `pan.quark.cn`、`.quark.cn` 等域上，
 * 单独查一个 domain 可能漏项，因此逐个查询后按 name 合并。
 */
const COOKIE_DOMAINS = ['.quark.cn', 'pan.quark.cn', 'drive-pc.quark.cn', 'uop.quark.cn'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function zh(message, code, extra) {
  return new QuarkError(message, { code: code || ErrCode.UNKNOWN, ...(extra || {}) });
}

/** 懒加载 Electron；非 Electron 环境返回 null。 */
function electronModule() {
  try {
    const m = require('electron');
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/**
 * 把 Electron cookie 数组拼成 Cookie 头。
 * @param {Array<{name:string,value:string}>} cookies
 * @returns {string} `k=v; k2=v2`
 */
function buildCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return '';
  const seen = new Set();
  const out = [];
  for (const c of cookies) {
    if (!c || !c.name) continue;
    if (seen.has(c.name)) continue;   // 同名以先出现者为准（按 domain 优先级传入）
    seen.add(c.name);
    out.push(`${c.name}=${c.value === undefined || c.value === null ? '' : c.value}`);
  }
  return out.join('; ');
}

/** 合并多个 domain 的查询结果（按 name 去重，先到先得）。 */
function mergeCookies(lists) {
  const byName = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || !c.name) continue;
      if (!byName.has(c.name)) byName.set(c.name, c);
    }
  }
  return [...byName.values()];
}

class LoginController {
  /**
   * @param {object} opts
   * @param {string} [opts.partition='persist:quark-login'] 持久化分区（登录态复用）
   * @param {(stage:string)=>void} [opts.onProgress] 进度回调（中文文案，不含 Cookie）
   * @param {number} [opts.timeout]        登录总超时，默认 180000ms
   * @param {number} [opts.pollInterval]   轮询间隔，默认 1500ms
   * @param {object} [opts.electron]       注入 electron 模块（测试用）
   * @param {Function} [opts.fetchImpl]    注入 fetch（测试用）
   * @param {object} [opts.windowOptions]  追加的 BrowserWindow 选项
   */
  constructor({
    partition = LOGIN_PARTITION,
    onProgress,
    timeout = DEFAULT_TIMEOUT,
    pollInterval = DEFAULT_POLL,
    electron = null,
    fetchImpl = null,
    windowOptions = null,
  } = {}) {
    this.partition = partition;
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.timeout = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT;
    this.pollInterval = Number.isFinite(pollInterval) && pollInterval > 0 ? pollInterval : DEFAULT_POLL;
    this._electron = electron;
    this._injectedFetch = fetchImpl;
    this._windowOptions = windowOptions;

    this._win = null;
    this._running = false;
    this._canceled = false;
    this._abort = new AbortController();
  }

  _progress(stage) {
    try { this.onProgress(stage); } catch { /* 进度回调不得影响登录流程 */ }
  }

  _assertNotCanceled() {
    if (this._canceled || this._abort.signal.aborted) throw zh('登录已取消', ErrCode.ABORTED);
  }

  _electronModule() {
    const m = this._electron || electronModule();
    if (!m || !m.session || !m.BrowserWindow) {
      throw zh('登录功能需要在桌面应用内运行', ErrCode.INVALID_ARG);
    }
    return m;
  }

  _fetch() {
    const em = this._electron || electronModule();
    if (!this._injectedFetch) {
      if (em && em.net && typeof em.net.fetch === 'function') return em.net.fetch.bind(em.net);
      if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    }
    const f = this._injectedFetch || globalThis.fetch;
    if (typeof f !== 'function') throw zh('运行环境缺少可用的网络实现', ErrCode.NETWORK);
    return f;
  }

  /**
   * 判活：带 cookie 调用 GET /1/clouddrive/config?pr=ucpro&fr=pc
   * 仅当 HTTP 200 且包络 `code === 0` 时返回 true；未登录（401/31001）或网络异常返回 false。
   * @param {string} cookieHeader 形如 `k=v; k2=v2`
   * @returns {Promise<boolean>}
   */
  async checkAlive(cookieHeader) {
    const doFetch = this._fetch();
    const ctrl = new AbortController();
    const cancel = () => ctrl.abort();
    if (this._abort.signal.aborted) return false;
    this._abort.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => ctrl.abort(), ALIVE_TIMEOUT);
    try {
      const res = await doFetch(ALIVE_URL, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: 'https://pan.quark.cn/',
          origin: 'https://pan.quark.cn',
          'user-agent': DEFAULT_UA,
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        signal: ctrl.signal,
      });
      let env = null;
      try {
        const text = await res.text();
        env = text ? JSON.parse(text) : null;
      } catch {
        env = null;
      }
      if (env && env.code === CODE_NEED_LOGIN) return false;
      if (res.status === 200 && env && env.code === 0) return true;
      return false;
    } catch {
      // 网络异常不能判定为「已登录」，交由轮询重试
      return false;
    } finally {
      clearTimeout(timer);
      this._abort.signal.removeEventListener('abort', cancel);
    }
  }

  /** 读取该分区下夸克相关域的全部 Cookie。 */
  async _readCookies(ses) {
    const lists = await Promise.all(
      COOKIE_DOMAINS.map((domain) =>
        ses.cookies.get({ domain }).catch(() => [])
      )
    );
    return mergeCookies(lists);
  }

  _teardown() {
    const win = this._win;
    this._win = null;
    if (!win) return;
    try {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
      win.destroy();
    } catch {
      /* ignore */
    }
  }

  async _run() {
    const em = this._electronModule();
    const ses = em.session.fromPartition(this.partition);

    this._progress('正在打开登录窗口…');
    const win = new em.BrowserWindow({
      width: 1000,
      height: 700,
      title: '登录夸克网盘',
      autoHideMenuBar: true,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      ...(this._windowOptions || {}),
    });
    this._win = win;
    // 用户手动关窗即视为取消
    try {
      win.on('closed', () => {
        if (this._win === win) this._win = null;
        this._canceled = true;
        try { this._abort.abort(); } catch { /* ignore */ }
      });
    } catch { /* 测试替身可能没有 on() */ }

    try {
      await win.loadURL(LOGIN_URL);
      this._progress('请在弹出的窗口内扫码或登录夸克网盘…');

      const deadline = Date.now() + this.timeout;
      for (;;) {
        this._assertNotCanceled();
        if (Date.now() >= deadline) throw zh('登录超时，请重试', ErrCode.TIMEOUT);

        let cookies = [];
        try {
          cookies = await this._readCookies(ses);
        } catch (e) {
          if (this._canceled) throw zh('登录已取消', ErrCode.ABORTED, { cause: e });
          cookies = [];
        }

        if (cookies.length) {
          const header = buildCookieHeader(cookies);
          if (header && (await this.checkAlive(header))) {
            this._progress('登录成功，正在保存登录状态…');
            return { cookies };
          }
        }

        await this._sleep(this.pollInterval);
      }
    } finally {
      this._teardown();
    }
  }

  _sleep(ms) {
    return new Promise((resolve, reject) => {
      if (this._canceled) {
        reject(zh('登录已取消', ErrCode.ABORTED));
        return;
      }
      const onAbort = () => {
        clearTimeout(t);
        reject(zh('登录已取消', ErrCode.ABORTED));
      };
      const t = setTimeout(() => {
        this._abort.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      this._abort.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 打开登录窗口并等待登录成功。
   * @returns {Promise<{cookies: Array<{name:string,value:string,domain:string}>}>}
   */
  start() {
    if (this._running) return Promise.reject(zh('登录流程已在进行中', ErrCode.INVALID_ARG));
    this._running = true;
    this._canceled = false;
    this._abort = new AbortController();
    const p = this._run().finally(() => { this._running = false; });
    p.catch(() => { /* 由调用方处理，避免未捕获拒绝 */ });
    return p;
  }

  /**
   * 取消登录：关闭登录窗口并结束流程。
   * 持久化分区（userData/Partitions/quark-login）**保留**，以便下次免扫码。
   */
  async cancel() {
    this._canceled = true;
    try { this._abort.abort(); } catch { /* ignore */ }
    this._teardown();
    if (this._current) {
      try { await this._current; } catch { /* 取消导致的失败无需外抛 */ }
    }
    return undefined;
  }

  isRunning() {
    return this._running;
  }

  async clearSession() {
    await this.cancel();
    const em = this._electronModule();
    await em.session.fromPartition(this.partition).clearStorageData();
  }
}

module.exports = { LoginController, buildCookieHeader, mergeCookies, ALIVE_PATH, ALIVE_URL, LOGIN_URL, LOGIN_PARTITION, COOKIE_DOMAINS };
