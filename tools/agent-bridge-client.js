'use strict';
/**
 * Agent 桥接客户端（供 MCP 适配器与 CLI 复用）。
 *
 * 职责：连接客户端内的 Agent 网关、完成凭据认证、按 id 匹配请求与响应。
 * 只做传输，不含任何业务判断；凭据从 profile 内的 bridge.json 读取（0600）。
 *
 * 安全：
 *   - token 不打印、不写日志（出错信息里也不带）。
 *   - 网关未启动/未启用时给出可操作的中文提示，而不是抛出底层 ECONNREFUSED。
 */

const net = require('node:net');

const DEFAULT_TIMEOUT_MS = 120000;
const CONNECT_TIMEOUT_MS = 5000;

/** 桥接错误：带稳定 code，便于 MCP 层转成可读文案。 */
class BridgeError extends Error {
  constructor(message, { code = 'BRIDGE_ERROR', hint, detail, biz_code } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (hint) this.hint = hint;
    if (detail !== undefined) this.detail = detail;
    if (biz_code !== undefined) this.biz_code = biz_code;
  }
}

/**
 * 与 Agent 网关的持久连接。
 *
 * 连接是**惰性**的：首次请求时才连，连接断开后下一次请求自动重连，
 * 这样 MCP 客户端在客户端重启后无需重启适配器进程。
 */
class BridgeClient {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint Unix socket 路径或命名管道
   * @param {string} opts.token
   * @param {string} [opts.clientName]
   * @param {string} [opts.clientVersion]
   * @param {number} [opts.timeoutMs]
   * @param {(msg:string, detail?:object) => void} [opts.log] 只允许写 stderr
   */
  constructor({ endpoint, token, clientName = 'unknown', clientVersion = '', timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
    if (!endpoint) throw new BridgeError('缺少桥接端点');
    if (!token) throw new BridgeError('缺少桥接凭据');
    this.endpoint = endpoint;
    this.token = token;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.timeoutMs = timeoutMs;
    this.log = log;
    /** @type {import('node:net').Socket|null} */
    this.socket = null;
    /** @type {Map<string, {resolve:Function, reject:Function, timer:any}>} */
    this.pending = new Map();
    this.buffer = '';
    this.seq = 0;
    this.authenticated = false;
    /** @type {Promise<void>|null} */
    this.connecting = null;
    this.closed = false;
  }

  /** 建立连接并完成认证；并发调用复用同一个连接过程。 */
  connect() {
    if (this.closed) return Promise.reject(new BridgeError('桥接客户端已关闭'));
    if (this.socket && this.authenticated && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect(this.endpoint);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new BridgeError('连接 Agent 网关超时', {
          code: 'BRIDGE_TIMEOUT',
          hint: '请确认夸克网盘客户端仍在运行，且已启用 Agent 接入',
        }));
      }, CONNECT_TIMEOUT_MS);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        try { socket.destroy(); } catch { /* ignore */ }
        reject(err);
      };

      socket.on('error', (e) => {
        const code = e && e.code;
        if (code === 'ENOENT' || code === 'ECONNREFUSED') {
          fail(new BridgeError('无法连接到客户端（客户端未运行或未启用 Agent 接入）', {
            code: 'BRIDGE_UNAVAILABLE',
            hint: '请在夸克网盘客户端「设置 → Agent 接入」中启用，并保持客户端运行',
          }));
          return;
        }
        fail(new BridgeError(`桥接连接失败：${(e && e.message) || '未知错误'}`, { code: 'BRIDGE_ERROR' }));
      });

      socket.setEncoding('utf8');
      socket.setNoDelay(true);

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => this._onClose());

      socket.on('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        this._authenticate(socket).then(() => {
          this.authenticated = true;
          this.connecting = null;
          resolve();
        }).catch((err) => {
          this.connecting = null;
          this.authenticated = false;
          try { socket.destroy(); } catch { /* ignore */ }
          reject(err);
        });
      });
    });

    // 失败时不要把 rejected promise 永久缓存
    this.connecting.catch(() => { this.connecting = null; });
    return this.connecting;
  }

  _authenticate(socket) {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('Agent 网关认证超时', { code: 'BRIDGE_TIMEOUT' }));
      }, CONNECT_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        timer,
      });
      this._write(socket, {
        id,
        method: 'auth',
        params: { token: this.token, client: this.clientName, client_version: this.clientVersion },
      });
    });
  }

  _nextId() {
    this.seq += 1;
    return `c${this.seq}`;
  }

  _write(socket, payload) {
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch (e) {
      throw new BridgeError(`写入桥接失败：${(e && e.message) || '未知错误'}`);
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log('收到无法解析的桥接消息（已忽略）');
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    const entry = this.pending.get(String(msg.id));
    if (!entry) {
      this.log('收到无对应请求的桥接响应（已忽略）', { id: msg && msg.id });
      return;
    }
    this.pending.delete(String(msg.id));
    clearTimeout(entry.timer);
    if (msg.ok === true) {
      entry.resolve(msg.result);
      return;
    }
    const err = (msg && msg.error) || {};
    entry.reject(new BridgeError(err.message || '客户端返回了错误', {
      code: err.code || 'BRIDGE_ERROR',
      hint: err.hint,
      detail: err.detail,
      biz_code: err.biz_code,
    }));
  }

  _onClose() {
    this.socket = null;
    this.authenticated = false;
    this.connecting = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError('桥接连接已断开', {
        code: 'BRIDGE_CLOSED',
        hint: '请确认夸克网盘客户端仍在运行',
      }));
      this.pending.delete(id);
    }
  }

  /**
   * 发送一次请求。
   * @param {string} method
   * @param {object} params
   * @param {{timeoutMs?:number}} [opts]
   */
  async request(method, params = {}, opts = {}) {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new BridgeError('桥接连接不可用', { code: 'BRIDGE_CLOSED' });
    const id = this._nextId();
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('等待客户端响应超时', {
          code: 'BRIDGE_TIMEOUT',
          hint: '操作可能仍在客户端中执行，请稍后用 list_transfers 或 list_journal 复核，不要重复提交',
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write(socket, { id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  listTools() {
    return this.request('tools.list', {}, { timeoutMs: 30000 });
  }

  callTool(name, args, opts = {}) {
    return this.request('tools.call', { name, arguments: args || {} }, opts);
  }

  status() {
    return this.request('status', {}, { timeoutMs: 30000 });
  }

  close() {
    this.closed = true;
    if (this.socket) {
      try { this.socket.end(); } catch { /* ignore */ }
      try { this.socket.destroy(); } catch { /* ignore */ }
    }
    this.socket = null;
    this.authenticated = false;
  }
}

module.exports = { BridgeClient, BridgeError, DEFAULT_TIMEOUT_MS, CONNECT_TIMEOUT_MS };
