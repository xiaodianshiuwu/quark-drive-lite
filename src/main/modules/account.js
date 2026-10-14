'use strict';
/**
 * 账号模块：登录态查询 / 校验 / 登录 / 退出 / 容量 / 用户资料。
 *
 * 只使用 docs/API_NOTES.md 已确认过的端点：
 *   - GET /1/clouddrive/config        （判活，3.3 本机实测；亦见 reference/MINED_ENDPOINTS.md）
 *   - GET /1/clouddrive/quota/remain  （容量；reference/MINED_ENDPOINTS.md）
 *   - GET /1/clouddrive/member        （用户资料；reference/MINED_ENDPOINTS.md）
 *
 * 待确认事项（见 API_NOTES 第 9 节）在本模块的降级方式：
 *   - `quota/remain` 与 `member` 的**响应字段名未经真实账号实测** → 全部走宽松解析，
 *     解析不出时返回 `{total:-1,used:-1,free:-1}` 或空字符串，**绝不编造，也不抛错**。
 *   - 登录态判定不猜 Cookie 名，一律以判活接口 200 + `code===0` 为准。
 */

const { ErrCode, QuarkError, isNeedLogin } = require('../core/errors');

/** 判活接口（docs/API_NOTES.md 3.3，本机实测）。 */
const CONFIG_PATH = '/1/clouddrive/config';
/** 容量接口（出处见 docs/API_NOTES.md §4.3「容量与会员」）。 */
const QUOTA_PATH = '/1/clouddrive/quota/remain';
/** 用户资料接口（reference/MINED_ENDPOINTS.md：main/main.js）。 */
const MEMBER_PATH = '/1/clouddrive/member';

/**
 * 公共查询参数。复用 http.js 中按官方形态定义的常量（含 uc_param_str 与 device_model）；
 * 曾只写 {pr,fr}，与官方请求形态不一致。
 */
const { COMMON_QUERY } = require('../core/http');

/**
 * 各错误码的中文兜底文案。
 * 背景：`errors.js` 的 `fromEnvelope()` 会**优先采用服务端 message**，而服务端在
 * 未登录时返回的正是英文 `require login [guest]`（本机实测）。本模块面向用户，
 * 因此在把错误向上抛出前统一保证 message 为中文。
 */
const CN_FALLBACK = Object.freeze({
  [ErrCode.NEED_LOGIN]: '登录状态已失效，请重新登录',
  [ErrCode.FORBIDDEN]: '没有权限执行该操作',
  [ErrCode.RATE_LIMIT]: '请求过于频繁，请稍后再试',
  [ErrCode.NOT_FOUND]: '资源不存在',
  [ErrCode.CONFLICT]: '目标位置已存在同名文件或目录',
  [ErrCode.INVALID_ARG]: '请求参数有误',
  [ErrCode.NETWORK]: '网络请求失败，请检查网络连接',
  [ErrCode.TIMEOUT]: '请求超时，请检查网络',
  [ErrCode.ABORTED]: '操作已取消',
  [ErrCode.TASK_FAILED]: '任务执行失败，请重试',
  [ErrCode.LINK_EXPIRED]: '下载链接已过期，请重试',
  [ErrCode.SERVER]: '服务端暂时不可用，请稍后重试',
  [ErrCode.UNKNOWN]: '操作失败，请重试',
});

/**
 * 保证「面向用户」的错误 message 为中文，且 `code` 字段保留。
 * 已经是中文的（服务端中文提示 / errors.js 的兜底文案）原样返回，不覆盖更具体的信息。
 */
function toUserFacingError(err) {
  if (!err || typeof err !== 'object') return err;
  const msg = String(err.message || '');
  if (/[\u4e00-\u9fa5]/.test(msg)) return err;
  const fallback = CN_FALLBACK[err.code];
  if (!fallback) return err;
  return new QuarkError(fallback, {
    code: err.code,
    bizCode: err.bizCode,
    httpStatus: err.httpStatus,
    raw: err.raw,
    cause: err,
  });
}

/** 容量字段候选名（**未经实测**，多来源猜测，必须宽松解析）。 */
const TOTAL_KEYS = [
  'total', 'total_size', 'total_bytes', 'total_capacity', 'capacity', 'capacity_total',
  'space_total', 'space', 'disk_total', 'quota', 'quota_total', 'all_total', 'size_total',
];
const USED_KEYS = [
  'used', 'used_size', 'used_bytes', 'used_capacity', 'capacity_used', 'space_used',
  'use', 'use_size', 'disk_used', 'quota_used', 'used_total', 'size_used',
];
const FREE_KEYS = [
  'free', 'free_size', 'free_bytes', 'free_capacity', 'capacity_free', 'space_free',
  'remain', 'remaining', 'remain_size', 'surplus', 'left', 'available', 'free_space',
];

/**
 * 宽松解析字节数：容忍 number、数字字符串、带单位字符串（"1.5TB"）、空值。
 * @returns {number|null} 解析失败返回 null
 */
function parseBytes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : null;
  if (typeof value === 'boolean') return null;

  if (typeof value === 'object') {
    // 有些实现返回 { size: 123, unit: 'B' } / { value, unit }
    if (value.size !== undefined) return parseBytes(value.size);
    if (value.value !== undefined) return parseBytes(value.value);
    return null;
  }

  const s = String(value).trim();
  if (!s) return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toUpperCase();
  const scale = {
    '': 1,
    B: 1,
    KB: 1024,
    K: 1024,
    MB: 1024 ** 2,
    M: 1024 ** 2,
    GB: 1024 ** 3,
    G: 1024 ** 3,
    TB: 1024 ** 4,
    T: 1024 ** 4,
    PB: 1024 ** 5,
  }[unit];
  if (scale === undefined) return null;
  return Math.round(n * scale);
}

/** 在候选字段名里找第一个能解析出数字的值。 */
function pickBytes(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const n = parseBytes(obj[k]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * 从任意响应包络里宽松提取容量信息。
 * 依次尝试常见容器：`data` → `data.data` → `metadata` → 包络本身。
 * @returns {{total:number,used:number,free:number}} 解析不出的字段为 -1
 */
function parseQuota(envelope) {
  if (!envelope || typeof envelope !== 'object') return { total: -1, used: -1, free: -1 };

  const containers = [];
  const d = envelope.data;
  if (d && typeof d === 'object') {
    containers.push(d);
    if (d.data && typeof d.data === 'object') containers.push(d.data);
    if (d.quota && typeof d.quota === 'object') containers.push(d.quota);
  }
  if (envelope.metadata && typeof envelope.metadata === 'object') containers.push(envelope.metadata);
  containers.push(envelope);

  let total = -1;
  let used = -1;
  let free = -1;
  for (const c of containers) {
    if (total < 0) {
      const v = pickBytes(c, TOTAL_KEYS);
      if (v !== null) total = v;
    }
    if (used < 0) {
      const v = pickBytes(c, USED_KEYS);
      if (v !== null) used = v;
    }
    if (free < 0) {
      const v = pickBytes(c, FREE_KEYS);
      if (v !== null) free = v;
    }
    if (total >= 0 && used >= 0 && free >= 0) break;
  }

  // 三项中已知两项时推导第三项（仅在结果非负时采用）
  if (total < 0 && used >= 0 && free >= 0) total = used + free;
  if (used < 0 && total >= 0 && free >= 0) used = Math.max(0, total - free);
  if (free < 0 && total >= 0 && used >= 0) free = Math.max(0, total - used);

  return { total, used, free };
}

/** 取字符串（去空白），非字符串返回 null。 */
function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * 从任意包络里宽松提取用户资料。**字段名未经实测**：取不到一律留空字符串。
 * @returns {{nickname:string,avatar:string,memberLabel:string,userId:string}}
 */
function parseUserInfo(...envelopes) {
  const out = { nickname: '', avatar: '', memberLabel: '', userId: '' };
  const containers = [];
  for (const env of envelopes) {
    if (!env || typeof env !== 'object') continue;
    for (const key of ['data', 'metadata', 'user_info', 'userInfo', 'member_info', 'memberInfo']) {
      const c = env[key];
      if (c && typeof c === 'object' && !Array.isArray(c)) containers.push(c);
    }
    containers.push(env);
    // member 接口可能把资料放在 data.member / data.user
    const d = env.data;
    if (d && typeof d === 'object') {
      for (const key of ['member', 'user', 'profile', 'account']) {
        const c = d[key];
        if (c && typeof c === 'object' && !Array.isArray(c)) containers.push(c);
      }
    }
  }

  for (const c of containers) {
    if (!out.nickname) {
      out.nickname = pickString(c, ['nickname', 'nick_name', 'nickName', 'user_name', 'userName', 'name', 'display_name', 'displayName']) || '';
    }
    if (!out.avatar) {
      out.avatar = pickString(c, ['avatar', 'avatar_url', 'avatarUrl', 'head_image', 'headImage', 'head_img', 'headImg', 'portrait', 'icon']) || '';
    }
    if (!out.memberLabel) {
      out.memberLabel = pickString(c, ['member_label', 'memberLabel', 'member_type_name', 'memberTypeName', 'vip_label', 'vipLabel', 'vip_name', 'vipName', 'member_name', 'memberName', 'level_name', 'levelName', 'title']) || '';
    }
    if (!out.userId) {
      out.userId = pickString(c, ['user_id', 'userId', 'uid', 'member_id', 'memberId', 'id']) || '';
    }
  }
  return out;
}

/**
 * 创建账号模块。
 * @param {object} opts
 * @param {object} opts.session  会话管理器（session.js）
 * @param {object} [opts.store]  安全存储（仅用于登出时清空；缺省时只用 session.clear）
 * @param {object} opts.http     HttpClient（http.js）
 * @param {string} [opts.userDataDir]
 * @param {object} [opts.loginController] LoginController 实例（缺省时惰性 new）
 * @param {Function} [opts.fetchImpl]     注入 fetch（测试用，构造 LoginController 时透传）
 */
function createAccountModule({ session, store, http, userDataDir, loginController = null, fetchImpl = null } = {}) {
  if (!session) throw new TypeError('createAccountModule 需要 session');
  if (!http) throw new TypeError('createAccountModule 需要 http 客户端');

  const listeners = new Set();
  let controller = loginController;

  /** 广播登录态；单个订阅者抛错不影响其他订阅者。 */
  function emit() {
    const state = buildState();
    for (const cb of [...listeners]) {
      try { cb(state); } catch { /* 订阅者异常不得影响主流程 */ }
    }
    return state;
  }

  function buildState() {
    const info = session.getAccountInfo ? session.getAccountInfo() : null;
    const s = session.getState ? session.getState() : { loggedIn: false, expired: false, hasCredentials: false };
    const hasCred = s.hasCredentials !== undefined ? !!s.hasCredentials : !!s.loggedIn;
    return {
      loggedIn: !!s.loggedIn,
      // 无任何凭据时不算「已失效」：那是"未登录"，UI 应引导登录而非提示 Cookie 失效。
      // 有凭据但被服务端拒绝（31001）时才置 expired=true。
      expired: hasCred ? !!s.expired : false,
      nickname: (info && info.nickname) || '',
      avatar: (info && info.avatar) || '',
      memberLabel: (info && info.memberLabel) || '',
      userId: (info && info.userId) || s.userId || '',
    };
  }

  /** 惰性构造 LoginController（纯 Node 环境下不 import 也不会崩溃）。 */
  function getController() {
    if (!controller) {
      const { LoginController } = require('../core/login');
      controller = new LoginController({ userDataDir, fetchImpl: fetchImpl || undefined });
    }
    return controller;
  }

  /** 仅读本地：不发起任何网络请求。 */
  async function status() {
    return buildState();
  }

  /** GET /1/clouddrive/config —— 判活。 */
  async function probeAlive() {
    return http.get(CONFIG_PATH, { ...COMMON_QUERY });
  }

  /**
   * 主动校验 Cookie：调用判活接口。
   * - 本地就无凭据 → 直接返回未登录，不浪费一次网络请求
   * - 已标记失效 → 默认直接返回（UI 应引导重新登录）；传 `{ force: true }` 可强制复测
   * - 失效（NEED_LOGIN / 31001）→ markExpired() 并返回 expired:true
   * - **网络类错误原样抛出**：断网不能被误报成"请重新登录"
   * @param {{force?: boolean}} [opts]
   */
  async function verify(opts = {}) {
    const force = !!(opts && opts.force);
    if (!session.isLoggedIn() && !(force && session.hasCookies())) {
      return buildState();
    }
    try {
      await probeAlive();
      session.clearExpired();
      session.save();
      return emit();
    } catch (e) {
      if (isNeedLogin(e)) {
        session.markExpired();
        session.save();
        return emit();
      }
      throw toUserFacingError(e);
    }
  }

  /** 打开登录窗口抓取登录态，成功后写入 session 并持久化。 */
  async function login() {
    const ctrl = getController();
    const res = await ctrl.start();
    const cookies = (res && res.cookies) || [];
    if (!cookies.length) {
      throw new QuarkError('登录未完成，请重试', { code: ErrCode.UNKNOWN });
    }
    session.setCookies(cookies);
    // 尽力补充资料；失败不影响登录本身
    try {
      const info = await getUserInfo();
      if (info && typeof session.setAccountInfo === 'function') session.setAccountInfo(info);
    } catch {
      /* 资料获取失败不影响登录态 */
    }
    session.save();
    return emit();
  }

  /** 退出登录：清空内存会话与持久化存储。 */
  async function logout() {
    const ctrl = getController();
    if (typeof ctrl.clearSession === 'function') await ctrl.clearSession();
    try {
      session.clear();
    } finally {
      emit();
    }
    return undefined;
  }

  /**
   * 容量信息。
   * 先试 `GET /1/clouddrive/quota/remain`（官方客户端确认存在），字段名宽松解析；
   * 若解析不出（三项皆为 -1），再退回 `GET /1/clouddrive/member` 尝试一次
   * （第三方驱动普遍从 member 取容量，字段名同样未经实测）。
   * **无论哪种，解析失败一律返回 `{total:-1,used:-1,free:-1}` 而不抛错。**
   * @param {object} [opts] `{ dlFlow: true }` 时附加 `type=DL_FLOW`（下载流量维度）
   * @returns {Promise<{total:number,used:number,free:number}>}
   */
  /**
   * 网盘容量（已实测确认，2026-10，真实账号）。
   *
   * 实测结论（推翻此前的候选端点假设）：
   *  - `GET /1/clouddrive/quota/remain` **不带参数会返回 14001 参数错误**；
   *    带 `type=DL_FLOW` 时可用，但它返回的是**下载流量**而非存储容量：
   *      { DL_FLOW: { total, remain, used, cycle_flag } }
   *  - 真正的**存储容量**来自 `GET /1/clouddrive/member`：
   *      total_capacity —— 容量上限
   *      use_capacity   —— 已用容量
   *      （二者均为字节数；另有 secret_total_capacity / secret_use_capacity 为隐私空间）
   *
   * 因此存储容量只取 `member`，解析失败时返回未知；下载流量不能作为容量。
   * 无论哪种，解析不出都返回 `{total:-1,used:-1,free:-1}` 而不抛错。
   *
   * @param {object} [opts] `{ dlFlow: true }` 时只查下载流量
   * @returns {Promise<{total:number,used:number,free:number}>}
   */
  async function quota(opts = {}) {
    const unknown = { total: -1, used: -1, free: -1 };

    if (opts && opts.dlFlow) {
      try {
        const env = await http.get(QUOTA_PATH, { ...COMMON_QUERY, type: 'DL_FLOW' });
        const flow = env && env.data && (env.data.DL_FLOW || env.data);
        if (flow && typeof flow === 'object') {
          const total = numOr(flow.total, -1);
          const used = numOr(flow.used, -1);
          const remain = numOr(flow.remain, -1);
          if (total >= 0 || used >= 0 || remain >= 0) return { total, used, free: remain };
        }
      } catch (e) {
        if (isNeedLogin(e)) {
          session.markExpired();
          session.save();
          emit();
        }
      }
      return unknown;
    }

    // 主：member
    try {
      const env = await http.get(MEMBER_PATH, { ...COMMON_QUERY });
      const d = (env && env.data) || {};
      const total = numOr(d.total_capacity, -1);
      const used = numOr(d.use_capacity, -1);
      if (total >= 0 || used >= 0) {
        const free = total >= 0 && used >= 0 ? Math.max(0, total - used) : -1;
        return { total, used, free };
      }
    } catch (e) {
      if (isNeedLogin(e)) {
        session.markExpired();
        session.save();
        emit();
        return unknown;
      }
      // 继续尝试备用端点
    }

    return unknown;
  }

  /** 宽松取数字：支持 number 与纯数字字符串。 */
  function numOr(v, fallback) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
    return fallback;
  }

  /**
   * 用户资料。依次尝试 /1/clouddrive/member 与 /1/clouddrive/config，
   * **字段名未经实测**：取不到一律返回空字符串。
   */
  async function getUserInfo() {
    const envelopes = [];
    for (const path of [MEMBER_PATH, CONFIG_PATH]) {
      try {
        envelopes.push(await http.get(path, { ...COMMON_QUERY }));
      } catch (e) {
        if (isNeedLogin(e)) {
          session.markExpired();
          session.save();
          emit();
        }
        // 单个接口失败继续尝试下一个
      }
    }
    return parseUserInfo(...envelopes);
  }

  /** 订阅登录态变化；返回取消订阅函数。 */
  function onStateChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return {
    status,
    verify,
    login,
    logout,
    quota,
    getUserInfo,
    onStateChange,
    /** 供测试/上层复用 */
    _buildState: buildState,
    _emit: emit,
  };
}

module.exports = {
  createAccountModule,
  parseQuota,
  parseUserInfo,
  parseBytes,
  toUserFacingError,
  CONFIG_PATH,
  QUOTA_PATH,
  MEMBER_PATH,
};
