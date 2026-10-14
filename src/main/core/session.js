'use strict';
/**
 * 会话管理器（Cookie jar）。
 *
 * 设计要点：
 * 1. **不硬编码任何具体 Cookie 名**：服务端下发什么就存什么。登录后 `__puus`/`__pus`
 *    的确切名称与下发时机尚未实测确认（见 docs/API_NOTES.md 第 9 节待确认项 1），
 *    因此这里只做「全量保存 + Set-Cookie 增量合并」。
 * 2. 每次响应都可能轮换 `__puus`，`applySetCookie()` 必须支持同名覆盖、Max-Age=0 /
 *    Expires 已过期时删除。`http.js` 的 `onSetCookie` 回调是它的唯一入口。
 * 3. 纯内存 + 显式 `save()`：不在 getter 里偷偷做 IO，便于单测。
 * 4. 无日志输出，绝不打印 Cookie 值。
 */

const SESSION_VERSION = 1;

/** store 中使用的键名。 */
const K_COOKIES = 'cookies';
const K_EXPIRED = 'expired';
const K_ACCOUNT = 'account';
const K_SAVED_AT = 'savedAt';

/**
 * 解析单条 Set-Cookie。
 * 形如：`Name=Value; Path=/; Domain=.quark.cn; HttpOnly; Secure; Expires=Wed, 01 Jan 2025 00:00:00 GMT`
 * @returns {{name:string,value:string,path:string,domain:string,expires:number|null,httpOnly:boolean,secure:boolean,sameSite:string|null,maxAge:number|null}|null}
 */
function parseSetCookie(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  if (!name) return null;

  const out = {
    name,
    value: first.slice(eq + 1).trim(),
    path: '/',
    domain: '',
    expires: null,
    httpOnly: false,
    secure: false,
    sameSite: null,
    maxAge: null,
  };

  for (const part of parts) {
    const seg = part.trim();
    if (!seg) continue;
    const i = seg.indexOf('=');
    const key = (i === -1 ? seg : seg.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : seg.slice(i + 1).trim();
    switch (key) {
      case 'path':
        if (val) out.path = val;
        break;
      case 'domain':
        if (val) out.domain = val.replace(/^\./, '').toLowerCase();
        break;
      case 'expires': {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) out.expires = t;
        break;
      }
      case 'max-age': {
        const n = Number.parseInt(val, 10);
        if (Number.isFinite(n)) out.maxAge = n;
        break;
      }
      case 'httponly':
        out.httpOnly = true;
        break;
      case 'secure':
        out.secure = true;
        break;
      case 'samesite':
        out.sameSite = val || null;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 判断一条已解析的 Set-Cookie 是否表示「删除该 Cookie」。
 * 规则：Max-Age <= 0，或 Expires 已过期。
 */
function isDeletion(parsed, now = Date.now()) {
  if (!parsed) return false;
  if (parsed.maxAge !== null && parsed.maxAge <= 0) return true;
  if (parsed.expires !== null && parsed.expires <= now) return true;
  return false;
}

/**
 * 把「秒级」或「毫秒级」时间戳统一成**毫秒**。
 * 秒级（现在约 1.7e9）与毫秒级（约 1.7e12）用 1e11 作为分界，避免把 ms 再乘 1000。
 * @returns {number|null} 无效或非正数返回 null（表示会话 Cookie）
 */
function toMillis(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * 归一化一条**外部来源**的 cookie 对象（两种形状的时间字段都是**秒**）：
 *   - CDP `Network.getAllCookies`：`{ name, value, domain, path, expires, httpOnly, secure, sameSite }`
 *     （`expires === -1` 表示会话 Cookie）
 *   - Electron `session.cookies.get()`：`{ name, value, domain, path, expirationDate, ... }`
 *
 * 注意：`expiresMs`/内部记录形状请用 `normalizeRecord()`，两者不可混用。
 */
function normalizeExternalCookie(c) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').trim();
  if (!name) return null;
  const expires = toMillis(c.expires !== undefined ? c.expires : c.expirationDate);
  return {
    name,
    value: c.value === undefined || c.value === null ? '' : String(c.value),
    domain: String(c.domain || '').replace(/^\./, '').toLowerCase(),
    path: c.path || '/',
    expires,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || null,
  };
}

/**
 * 归一化一条**内部记录**（`toJSON()`/`save()` 落盘的形状，`expires` 已是毫秒）。
 * 同时容忍外部形状（秒级）传入，靠 toMillis 的量级判断兜底。
 */
function normalizeRecord(c) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').trim();
  if (!name) return null;
  const src = c.expiresMs !== undefined ? c.expiresMs : c.expires;
  return {
    name,
    value: c.value === undefined || c.value === null ? '' : String(c.value),
    domain: String(c.domain || '').replace(/^\./, '').toLowerCase(),
    path: c.path || '/',
    expires: toMillis(src),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || null,
  };
}

/**
 * 创建会话管理器。
 * @param {object} opts
 * @param {{getItem:Function,setItem:Function,removeItem:Function,clear:Function}} opts.store
 */
function createSession({ store } = {}) {
  if (!store) throw new TypeError('createSession 需要一个安全存储实例（store）');

  /** @type {Map<string, {name:string,value:string,domain:string,path:string,expires:number|null,httpOnly:boolean,secure:boolean,sameSite:string|null}>} */
  const cookies = new Map();
  let expired = false;
  let account = null;      // { nickname, avatar, memberLabel, userId }
  let savedAt = 0;

  function isUsable(rec, now = Date.now()) {
    return !(rec && rec.expires !== null && rec.expires <= now);
  }

  /** 仅保留 Cookie 头需要的 name=value（按插入顺序）。 */
  function getCookie() {
    const now = Date.now();
    const out = [];
    for (const rec of cookies.values()) {
      if (!isUsable(rec, now)) continue;
      out.push(`${rec.name}=${rec.value}`);
    }
    return out.join('; ');
  }

  /** 是否持有凭据（不论是否已失效）。 */
  function hasCookies() {
    return cookies.size > 0;
  }

  /** 是否可直接使用（有凭据且未被标记失效）。 */
  function isLoggedIn() {
    return !!getCookie() && !expired;
  }

  /**
   * 增量合并 Set-Cookie 列表。同名直接覆盖；Max-Age<=0 / 已过期则删除。
   * @param {string[]} list
   */
  function applySetCookie(list) {
    if (!list) return;
    const arr = Array.isArray(list) ? list : [list];
    const now = Date.now();
    for (const raw of arr) {
      const parsed = parseSetCookie(raw);
      if (!parsed) continue;
      if (isDeletion(parsed, now)) {
        cookies.delete(parsed.name);
        continue;
      }
      const prev = cookies.get(parsed.name) || {};
      let expires = parsed.expires;
      if (expires === null && parsed.maxAge !== null) {
        expires = now + parsed.maxAge * 1000;
      }
      cookies.set(parsed.name, {
        name: parsed.name,
        value: parsed.value,
        // 服务端未下发 Domain/Path 时沿用既有值（滚动刷新通常只回 value）
        domain: parsed.domain || prev.domain || '',
        path: parsed.path || prev.path || '/',
        expires: expires === undefined ? null : expires,
        httpOnly: parsed.httpOnly || !!prev.httpOnly,
        secure: parsed.secure || !!prev.secure,
        sameSite: parsed.sameSite || prev.sameSite || null,
      });
    }
  }

  /**
   * 用「完整 cookie 数组」整体覆盖（登录成功后的落地入口）。
   * 输入形状兼容 Electron `session.cookies.get()`（`expirationDate`，秒）
   * 与 CDP `Network.getAllCookies`（`expires`，秒）。
   * @param {Array<object>} list
   */
  function setCookies(list) {
    cookies.clear();
    if (!Array.isArray(list)) {
      expired = false;
      return;
    }
    for (const c of list) {
      const norm = normalizeExternalCookie(c);
      if (!norm) continue;
      cookies.set(norm.name, norm);
    }
    expired = false;
  }

  function clear() {
    cookies.clear();
    expired = false;
    account = null;
    savedAt = 0;
    try {
      store.removeItem(K_COOKIES);
      store.removeItem(K_EXPIRED);
      store.removeItem(K_ACCOUNT);
      store.removeItem(K_SAVED_AT);
    } catch {
      /* 存储损坏时也要能清空内存态 */
    }
  }

  function toJSON() {
    return {
      v: SESSION_VERSION,
      cookies: [...cookies.values()],
      expired,
      account: account ? { ...account } : null,
      savedAt,
    };
  }

  function fromJSON(obj) {
    cookies.clear();
    expired = false;
    account = null;
    savedAt = 0;
    if (!obj || typeof obj !== 'object') return api;
    const list = Array.isArray(obj.cookies) ? obj.cookies : [];
    for (const c of list) {
      const norm = normalizeRecord(c);
      if (!norm) continue;
      cookies.set(norm.name, norm);
    }
    expired = !!obj.expired;
    if (obj.account && typeof obj.account === 'object') account = { ...obj.account };
    if (Number.isFinite(Number(obj.savedAt))) savedAt = Number(obj.savedAt);
    return api;
  }

  function load() {
    const persisted = typeof store.getItem === 'function' ? store.getItem(K_COOKIES) : null;
    if (Array.isArray(persisted)) {
      fromJSON({
        cookies: persisted,
        expired: store.getItem(K_EXPIRED),
        account: store.getItem(K_ACCOUNT),
        savedAt: store.getItem(K_SAVED_AT),
      });
    }
    return api;
  }

  function save() {
    savedAt = Date.now();
    if (typeof store.setItems === 'function') {
      store.setItems({ [K_COOKIES]: [...cookies.values()], [K_EXPIRED]: expired,
        [K_ACCOUNT]: account ? { ...account } : null, [K_SAVED_AT]: savedAt });
      return api;
    }
    store.setItem(K_COOKIES, [...cookies.values()]);
    store.setItem(K_EXPIRED, expired);
    store.setItem(K_ACCOUNT, account ? { ...account } : null);
    store.setItem(K_SAVED_AT, savedAt);
    return api;
  }

  /**
   * 账号资料（昵称/头像/会员标签）随会话一起持久化，供 status() 离线读取。
   * @param {object|null} info
   */
  function setAccountInfo(info) {
    account = info && typeof info === 'object' ? { ...info } : null;
    return api;
  }

  function getAccountInfo() {
    return account ? { ...account } : null;
  }

  /**
   * @returns {{loggedIn:boolean, hasCredentials:boolean, expired:boolean, cookieCount:number, savedAt:number, userId:string}}
   */
  function getState() {
    const info = account || {};
    return {
      loggedIn: isLoggedIn(),
      hasCredentials: hasCookies(),
      expired,
      cookieCount: cookies.size,
      savedAt,
      userId: info.userId || '',
    };
  }

  const api = {
    load,
    save,
    clear,
    getCookie,
    isLoggedIn,
    hasCookies,
    applySetCookie,
    setCookies,
    markExpired() {
      expired = true;
      return api;
    },
    clearExpired() {
      expired = false;
      return api;
    },
    isExpired() {
      return expired;
    },
    getState,
    setAccountInfo,
    getAccountInfo,
    toJSON,
    fromJSON,
    /** 只读快照，便于排错（不含 value，避免泄漏） */
    cookieNames() {
      return [...cookies.keys()];
    },
    size() {
      return cookies.size;
    },
  };

  return api;
}

module.exports = { createSession, parseSetCookie, isDeletion, toMillis, normalizeExternalCookie, normalizeRecord };
