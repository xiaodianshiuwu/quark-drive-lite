'use strict';
/**
 * 安全本地存储（登录态落盘）。
 *
 * 设计要点：
 * 1. **绝不绑定 Electron**：`require('electron')` 懒加载且 try/catch 包裹，纯 Node
 *    单测环境下测试模式可使用明文；正式工具通过 Electron 加密后端操作。
 * 2. Electron 环境下用 `safeStorage.encryptString/decryptString`（Windows 走 DPAPI）加密，
 *    落盘格式为 `QCK1` + Electron safeStorage 密文。
 * 3. 写入一律**原子替换**：先写 `<file>.tmp` 再 `rename`，避免进程中断产生半截文件。
 * 4. 任何日志/错误信息里**不得出现 Cookie 明文**；本模块只做字节搬运，其内部数据由
 *    调用方（session.js）决定，且本模块自身不打印任何内容。
 *
 * 落盘格式（JSON 文本）：
 *   { v: 1, encrypted: boolean, data: <任意可 JSON 化的值> }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 文件头魔数，便于识别密文。 */
const MAGIC = Buffer.from('QCK1', 'utf8');

/** 纯 Node 环境下的兜底目录（测试用，进程间稳定，便于断言）。 */
const NODE_FALLBACK_DIR = path.join(os.tmpdir(), 'quark-mini');

let _electron = null;
let _electronProbed = false;

/**
 * 尝试加载 Electron 主进程模块。
 * 纯 Node 下 `require('electron')` 会返回可执行文件路径字符串或直接抛错，这里统一吞掉。
 */
function electronModule() {
  if (_electronProbed) return _electron;
  _electronProbed = true;
  // 纯 Node 中加载 electron npm 包会自动下载运行时；离线测试无需该副作用。
  if (!process.versions.electron) return null;
  try {
    // 仅在 Electron 主进程内可用；懒加载保证纯 Node 下不崩溃
    const m = require('electron');
    _electron = m && typeof m === 'object' ? m : null;
  } catch {
    _electron = null;
  }
  return _electron;
}

/** 取 safeStorage 实例（不可用时返回 null）。 */
function getSafeStorage(injected) {
  if (injected) return injected;
  const m = electronModule();
  return (m && m.safeStorage) || null;
}

/**
 * 加密能力探测。
 * @param {object} [injectedSafeStorage] 仅测试注入
 * @returns {boolean}
 */
function isEncryptionAvailable(injectedSafeStorage) {
  try {
    const ss = getSafeStorage(injectedSafeStorage);
    // Linux 的 basic_text 使用预定义口令，不能作为正式凭据的加密后端。
    if (ss && typeof ss.getSelectedStorageBackend === 'function' && ss.getSelectedStorageBackend() === 'basic_text') return false;
    return !!(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable());
  } catch {
    return false;
  }
}

/**
 * 解析 userData 目录。
 * @param {string} [userDataDir] 调用方注入；缺省时使用 Electron `app.getPath('userData')`
 */
function resolveUserDataDir(userDataDir) {
  if (userDataDir) return userDataDir;
  const m = electronModule();
  try {
    if (m && m.app && typeof m.app.getPath === 'function') {
      const p = m.app.getPath('userData');
      if (p) return p;
    }
  } catch {
    /* 非 Electron */
  }
  return NODE_FALLBACK_DIR;
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子写入：先写同级 `.tmp`，再 rename 覆盖目标。
 * @param {string} target
 * @param {Buffer} buf
 */
function writeAtomic(target, buf) {
  const dir = path.dirname(target);
  ensureDir(dir);
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 创建安全存储实例。
 * @param {object} opts
 * @param {string} opts.userDataDir  存储目录（Electron：app.getPath('userData')）
 * @param {string} [opts.fileName='session.bin']
 * @param {object} [opts.safeStorage] 仅测试注入
 * @returns {{isAvailable:Function,isEncrypted:Function,getItem:Function,setItem:Function,removeItem:Function,clear:Function,path:string,filePath:string}}
 */
function createSecureStore({ userDataDir, fileName = 'session.bin', safeStorage, requireEncryption = false, strictRead = false } = {}) {
  const dir = resolveUserDataDir(userDataDir);
  const file = path.join(dir, fileName);
  let cached = null;      // 内存副本（对象）
  let cachedLoaded = false;
  let lastEncrypted = false;
  // 命令行脚本也通过 Electron 的同一加密后端读写，不能把 Cookie 降级为明文。
  if (requireEncryption && !safeStorage && !electronModule()) {
    const { spawnSync } = require('child_process');
    let executable;
    try { executable = require('electron'); } catch { /* 后端缺失时拒绝写入 */ }
    const call = (op, value) => {
      if (typeof executable !== 'string') throw new Error('无法使用系统加密存储，请在桌面应用内登录');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      env.QCK_STORAGE_REQUEST = Buffer.from(JSON.stringify({ op, value, userDataDir: dir }), 'utf8').toString('base64');
      const host = require('./platform').createElectronHostApp(path.join(__dirname,'storage-host.js'));
      let result;
      try { result = spawnSync(executable, [host.directory], {
        env, windowsHide: true, timeout: 20000, killSignal: 'SIGKILL',
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      }); } finally { host.cleanup(); }
      if (result.status !== 0) {
        if (process.env.CI === 'true') console.error((result.error?.code === 'ETIMEDOUT' ? '旧格式辅助进程超时：' : '旧格式辅助进程失败：') + (result.stderr || '未提供阶段信息'));
        throw new Error('系统加密存储不可用，请在桌面应用内登录');
      }
      return JSON.parse(result.stdout).value;
    };
    safeStorage = {
      isEncryptionAvailable: () => typeof executable === 'string',
      encryptString: (text) => Buffer.from(call('encrypt', text), 'base64'),
      decryptString: (buf) => call('decrypt', buf.toString('base64')),
    };
  }

  function available() {
    return isEncryptionAvailable(safeStorage);
  }

  function encrypt(text) {
    const ss = getSafeStorage(safeStorage);
    const out = ss.encryptString(text);
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  }

  function decrypt(buf) {
    const ss = getSafeStorage(safeStorage);
    const out = ss.decryptString(buf);
    return Buffer.isBuffer(out) ? out.toString('utf8') : String(out);
  }

  function loadFromDisk() {
    if (cachedLoaded) return cached;
    cachedLoaded = true;
    cached = {};
    lastEncrypted = false;
    if (!fs.existsSync(file)) return cached;
    let raw;
    try {
      raw = fs.readFileSync(file);
    } catch {
      if (strictRead) throw new Error('旧版登录资料无法读取，未迁移或覆盖原文件');
      return cached;
    }
    if (!raw.length) return cached;

    let text;
    if (raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      lastEncrypted = true;
      try {
        text = decrypt(raw.subarray(MAGIC.length));
      } catch {
        if (strictRead) throw new Error('旧版登录资料无法解密，请重新登录或使用原运行环境迁移');
        // 解密失败（换机器 / 凭据被重置）：视为无有效存储，不抛错，交给上层走重新登录
        return cached;
      }
    } else {
      text = raw.toString('utf8');
    }

    return parseStoredText(text);
  }

  function parseStoredText(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (strictRead) throw new Error('旧版登录资料格式损坏，未迁移或覆盖原文件');
      return cached;
    }
    if (strictRead && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed.v !== undefined && (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data))))) {
      throw new Error('旧版登录资料格式损坏，未迁移或覆盖原文件');
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.data && typeof parsed.data === 'object') cached = parsed.data;
      else if (parsed.v === undefined) cached = parsed; // 容忍无包络的裸对象
    }
    return cached;
  }

  /** macOS 的原生授权可能等待用户；在工作线程读取密钥，避免冻结主进程。 */
  async function initialize() {
    if (cachedLoaded) return;
    const ss = getSafeStorage(safeStorage);
    if (!ss || typeof ss.decryptStringAsync !== 'function' || typeof ss.isAsyncEncryptionAvailable !== 'function') {
      loadFromDisk();
      return;
    }
    let raw;
    try { raw = await fs.promises.readFile(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; raw = Buffer.alloc(0); }
    cached = {};
    lastEncrypted = raw.subarray(0, MAGIC.length).equals(MAGIC);
    if (lastEncrypted) {
      if (ss.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统加密存储不可用');
      if (!await ss.isAsyncEncryptionAvailable()) throw new Error('系统加密存储不可用');
      const decrypted = await ss.decryptStringAsync(raw.subarray(MAGIC.length));
      // Electron 44 返回 { result, shouldReEncrypt }，不是同步 API 的字符串。
      if (typeof decrypted?.result !== 'string') throw new Error('系统解密返回格式无效');
      parseStoredText(decrypted.result);
    } else if (raw.length) {
      parseStoredText(raw.toString('utf8'));
    }
    cachedLoaded = true;
  }

  function persist() {
    const data = cached && typeof cached === 'object' ? cached : {};
    const json = JSON.stringify({ v: 1, encrypted: available(), data });
    if (available()) {
      try {
        writeAtomic(file, Buffer.concat([MAGIC, encrypt(json)]));
        lastEncrypted = true;
        return;
      } catch {
        // 正式模式加密失败时拒绝保存；仅非正式测试模式允许明文
        if (requireEncryption) throw new Error('登录态加密保存失败，未写入明文凭证');
      }
    }
    if (requireEncryption) throw new Error('系统加密存储不可用，未写入明文凭证');
    writeAtomic(file, Buffer.from(JSON.stringify({ v: 1, encrypted: false, data }), 'utf8'));
    lastEncrypted = false;
  }

  return {
    snapshot: () => JSON.parse(JSON.stringify(loadFromDisk())),
    initialize,
    /** @returns {boolean} safeStorage 是否可用 */
    isAvailable: available,
    /** @returns {boolean} 当前落盘内容是否为加密格式 */
    isEncrypted() {
      if (!cachedLoaded) loadFromDisk();
      return lastEncrypted;
    },
    /**
     * @param {string} key
     * @returns {any|null}
     */
    getItem(key) {
      const data = loadFromDisk();
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    /**
     * @param {string} key
     * @param {any} value
     */
    setItem(key, value) {
      const data = loadFromDisk();
      data[key] = value;
      persist();
    },
    /** 单次原子保存关联键，保持会话快照完整。 */
    setItems(values) {
      Object.assign(loadFromDisk(), values);
      persist();
    },
    /** @param {string} key */
    removeItem(key) {
      const data = loadFromDisk();
      delete data[key];
      persist();
    },
    /** 清空全部键（保留文件，内容为空对象） */
    clear() {
      cached = {};
      cachedLoaded = true;
      lastEncrypted = false;
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    },
    /** 存储目录 */
    dir,
    /** 存储文件绝对路径 */
    filePath: file,
  };
}

module.exports = { createSecureStore, isEncryptionAvailable };
