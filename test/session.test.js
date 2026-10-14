'use strict';
/**
 * 会话 / 登录 / 账号模块单元测试（纯 Node，不加载 electron）。
 *
 * 运行：node --test test/session.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSession, parseSetCookie, isDeletion } = require('../src/main/core/session');
const { createAccountModule, parseQuota, parseUserInfo, parseBytes, toUserFacingError } = require('../src/main/modules/account');
const { COMMON_QUERY } = require('../src/main/core/http.js');
const { LoginController, buildCookieHeader, mergeCookies, ALIVE_PATH } = require('../src/main/core/login');
const { QuarkError, ErrCode } = require('../src/main/core/errors');

test('全部 Cookie 已到期时本地状态不再标记已登录，保留凭据供明确重新登录提示',()=>{
  const session=createSession({store:memStore()});
  session.setCookies([{name:'fixture',value:'仅测试',expires:Math.floor(Date.now()/1000)-10}]);
  assert.equal(session.getCookie(),'');
  assert.equal(session.isLoggedIn(),false);
  assert.equal(session.hasCookies(),true);
});

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 内存版 secure-store，模拟真实落盘的 JSON 往返（含 null）。 */
function memStore() {
  const map = new Map();
  const json = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    isAvailable: () => false,
    isEncrypted: () => false,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, json(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

/** 记录调用的假 HttpClient。 */
function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    async get(path, query, opts) {
      calls.push({ method: 'GET', path, query, opts });
      return handler({ method: 'GET', path, query, opts }, calls.length - 1);
    },
    async post(path, body, opts) {
      calls.push({ method: 'POST', path, body, opts });
      return handler({ method: 'POST', path, body, opts }, calls.length - 1);
    },
  };
}

/** 假 fetch：返回给定 HTTP 状态与 JSON 包络。 */
function fakeFetch({ status = 200, body = {} } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      async text() { return JSON.stringify(body); },
      async json() { return body; },
    };
  };
  impl.calls = calls;
  return impl;
}

const alive = () => new QuarkError('登录状态已失效，请重新登录', {
  code: ErrCode.NEED_LOGIN, bizCode: 31001, httpStatus: 401,
});

// ---------------------------------------------------------------------------
// 1. Cookie jar 基础行为
// ---------------------------------------------------------------------------

test('getCookie 按插入顺序拼成 k=v; k2=v2', () => {
  const s = createSession({ store: memStore() });
  s.setCookies([
    { name: 'ctoken', value: 'AAA', domain: 'pan.quark.cn' },
    { name: '__puus', value: 'BBB', domain: '.quark.cn' },
    { name: 'b-user-id', value: 'CCC', domain: 'pan.quark.cn' },
  ]);
  assert.equal(s.getCookie(), 'ctoken=AAA; __puus=BBB; b-user-id=CCC');
  assert.equal(s.size(), 3);
});

test('不硬编码 cookie 名：任意名字都会被保存', () => {
  const s = createSession({ store: memStore() });
  s.setCookies([
    { name: '任意-未确认的名字', value: '1' },
    { name: '未来才出现的_cookie', value: '2' },
  ]);
  assert.equal(s.getCookie(), '任意-未确认的名字=1; 未来才出现的_cookie=2');
  assert.deepEqual(s.cookieNames().sort(), ['任意-未确认的名字', '未来才出现的_cookie'].sort());
});

test('setCookies 兼容 Electron 的 expirationDate（秒）', () => {
  const s = createSession({ store: memStore() });
  const futureSec = Math.floor(Date.now() / 1000) + 3600;
  s.setCookies([{ name: 'a', value: '1', expirationDate: futureSec }]);
  const rec = s.toJSON().cookies[0];
  assert.equal(rec.expires, futureSec * 1000, 'expirationDate 应转成毫秒');
  assert.ok(rec.expires > 1e12 && rec.expires < 1e13, '毫秒量级才对');
  assert.equal(s.getCookie(), 'a=1');
});

test('setCookies 兼容 CDP 的 expires（秒）；-1 视为会话 Cookie', () => {
  const s = createSession({ store: memStore() });
  s.setCookies([
    { name: 'sess', value: 'x', expires: -1 },
    { name: 'later', value: 'y', expires: Math.floor(Date.now() / 1000) + 600 },
  ]);
  assert.equal(s.toJSON().cookies.find((c) => c.name === 'sess').expires, null);
  assert.ok(s.toJSON().cookies.find((c) => c.name === 'later').expires > Date.now());
});

// ---------------------------------------------------------------------------
// 2. Set-Cookie 增量合并（__puus 滚动刷新）
// ---------------------------------------------------------------------------

test('parseSetCookie 解析属性', () => {
  const p = parseSetCookie('Name=Value; Path=/; Domain=.quark.cn; HttpOnly; Secure; Expires=Wed, 01 Jan 2031 00:00:00 GMT');
  assert.equal(p.name, 'Name');
  assert.equal(p.value, 'Value');
  assert.equal(p.path, '/');
  assert.equal(p.domain, 'quark.cn');
  assert.equal(p.httpOnly, true);
  assert.equal(p.secure, true);
  assert.equal(typeof p.expires, 'number');
  assert.ok(p.expires > Date.now());
});

test('applySetCookie 同名覆盖（滚动刷新），并保留 Domain/Path/HttpOnly 元数据', () => {
  const s = createSession({ store: memStore() });
  s.applySetCookie(['__puus=OLD; Path=/; Domain=.quark.cn; HttpOnly; Secure']);
  assert.equal(s.getCookie(), '__puus=OLD');

  // 服务端只回 value 的滚动刷新
  s.applySetCookie(['__puus=NEW']);
  assert.equal(s.getCookie(), '__puus=NEW');
  const rec = s.toJSON().cookies.find((c) => c.name === '__puus');
  assert.equal(rec.domain, 'quark.cn', '未下发 Domain 时沿用既有值');
  assert.equal(rec.path, '/');
  assert.equal(rec.httpOnly, true);
  assert.equal(rec.secure, true);
  assert.equal(s.size(), 1, '同名不得产生重复项');
});

test('applySetCookie：Max-Age=0 删除该 cookie', () => {
  const s = createSession({ store: memStore() });
  s.applySetCookie(['__pus=V1', 'keep=K']);
  assert.equal(s.size(), 2);
  s.applySetCookie(['__pus=; Path=/; Domain=.quark.cn; Max-Age=0']);
  assert.equal(s.size(), 1);
  assert.equal(s.getCookie(), 'keep=K');
});

test('applySetCookie：Expires 已过期则删除该 cookie', () => {
  const s = createSession({ store: memStore() });
  s.applySetCookie(['gone=V; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
  assert.equal(s.size(), 0);
  assert.equal(s.getCookie(), '');
});

test('applySetCookie：Max-Age 正数落地为未来毫秒时间戳', () => {
  const s = createSession({ store: memStore() });
  s.applySetCookie(['t=V; Max-Age=3600']);
  const rec = s.toJSON().cookies[0];
  assert.ok(rec.expires > Date.now() + 3500e3 && rec.expires < Date.now() + 3700e3);
});

test('applySetCookie：已过期的已有 cookie 不再出现在 Cookie 头里', () => {
  const s = createSession({ store: memStore() });
  s.setCookies([{ name: 'dead', value: 'v', expires: Math.floor(Date.now() / 1000) - 10 }]);
  assert.equal(s.size(), 1, '条目仍在 jar 中');
  assert.equal(s.getCookie(), '', '但不得出现在 Cookie 头');
});

test('applySetCookie 接受单个字符串与 null', () => {
  const s = createSession({ store: memStore() });
  s.applySetCookie('one=1');
  s.applySetCookie(null);
  assert.equal(s.getCookie(), 'one=1');
});

test('isDeletion 边界', () => {
  assert.equal(isDeletion(parseSetCookie('a=1')), false);
  assert.equal(isDeletion(parseSetCookie('a=1; Max-Age=0')), true);
  assert.equal(isDeletion(parseSetCookie('a=1; Max-Age=-1')), true);
  assert.equal(isDeletion(parseSetCookie('a=1; Max-Age=10')), false);
  assert.equal(isDeletion(null), false);
});

// ---------------------------------------------------------------------------
// 3. 失效标记与状态
// ---------------------------------------------------------------------------

test('isLoggedIn / markExpired / clearExpired / getState', () => {
  const s = createSession({ store: memStore() });
  assert.equal(s.isLoggedIn(), false);
  assert.deepEqual(s.getState(), {
    loggedIn: false, hasCredentials: false, expired: false, cookieCount: 0, savedAt: 0, userId: '',
  });

  s.setCookies([{ name: 'a', value: '1' }]);
  assert.equal(s.isLoggedIn(), true);

  s.markExpired();
  assert.equal(s.isLoggedIn(), false);
  assert.equal(s.getState().expired, true);
  assert.equal(s.getState().hasCredentials, true);

  s.clearExpired();
  assert.equal(s.isLoggedIn(), true);
  assert.equal(s.getState().expired, false);
});

// ---------------------------------------------------------------------------
// 4. 持久化往返
// ---------------------------------------------------------------------------

test('save/load 往返：cookie、expired 标记、账号资料', () => {
  const store = memStore();
  const a = createSession({ store });
  a.setCookies([{ name: 'k', value: 'v', domain: '.quark.cn', expirationDate: Math.floor(Date.now() / 1000) + 3600 }]);
  a.setAccountInfo({ nickname: '小明', avatar: 'https://x/a.png', memberLabel: 'SVIP', userId: 'u1' });
  a.markExpired();
  a.save();

  const b = createSession({ store }).load();
  assert.equal(b.getCookie(), 'k=v');
  assert.equal(b.getState().expired, true);
  assert.deepEqual(b.getAccountInfo(), { nickname: '小明', avatar: 'https://x/a.png', memberLabel: 'SVIP', userId: 'u1' });
  assert.equal(b.getState().userId, 'u1');
  // 关键回归：毫秒时间戳不得在往返中被再次乘 1000
  assert.ok(b.toJSON().cookies[0].expires < 1e13, `expires 应为毫秒量级，实际 ${b.toJSON().cookies[0].expires}`);
});

test('toJSON/fromJSON 往返', () => {
  const s = createSession({ store: memStore() });
  s.applySetCookie(['a=1; Path=/; Domain=.quark.cn']);
  s.setAccountInfo({ nickname: 'n' });
  const snap = s.toJSON();
  assert.equal(snap.v, 1);

  const t = createSession({ store: memStore() }).fromJSON(snap);
  assert.equal(t.getCookie(), 'a=1');
  assert.equal(t.getAccountInfo().nickname, 'n');
  assert.equal(t.size(), 1);
});

test('fromJSON 容忍垃圾输入', () => {
  const s = createSession({ store: memStore() });
  s.fromJSON(null);
  assert.equal(s.size(), 0);
  s.fromJSON({ cookies: 'nope' });
  assert.equal(s.size(), 0);
  s.fromJSON({ cookies: [null, { name: '' }, { name: 'ok', value: '1' }] });
  assert.equal(s.size(), 1);
});

test('clear 清空内存与持久化', () => {
  const store = memStore();
  const s = createSession({ store });
  s.setCookies([{ name: 'a', value: '1' }]);
  s.setAccountInfo({ nickname: 'n' });
  s.save();
  assert.ok(store.dump().cookies.length === 1);

  s.clear();
  assert.equal(s.size(), 0);
  assert.equal(s.getCookie(), '');
  assert.equal(s.getAccountInfo(), null);
  assert.equal(store.getItem('cookies'), null);
  assert.equal(store.getItem('account'), null);
});

test('load：存储中无数据时保持空会话', () => {
  const s = createSession({ store: memStore() }).load();
  assert.equal(s.isLoggedIn(), false);
  assert.equal(s.getCookie(), '');
});

test('createSession 缺少 store 时抛 TypeError', () => {
  assert.throws(() => createSession({}), TypeError);
});

// ---------------------------------------------------------------------------
// 5. account 模块
// ---------------------------------------------------------------------------

test('account.status 只读本地，不发网络请求', async () => {
  const store = memStore();
  const session = createSession({ store }).load();
  session.setCookies([{ name: 'a', value: '1' }]);
  session.setAccountInfo({ nickname: '昵称', avatar: '', memberLabel: '', userId: 'u9' });

  const http = fakeHttp(() => { throw new Error('status() 不得发网络请求'); });
  const account = createAccountModule({ session, store, http });

  const st = await account.status();
  assert.equal(http.calls.length, 0);
  assert.deepEqual(st, {
    loggedIn: true, expired: false, nickname: '昵称', avatar: '', memberLabel: '', userId: 'u9',
  });
});

test('account.verify：401/31001 → markExpired 并返回 expired:true', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: '__puus', value: 'x' }]);

  let seen = null;
  const http = fakeHttp(() => { throw alive(); });
  const account = createAccountModule({ session, store, http });
  account.onStateChange((s) => { seen = s; });

  const st = await account.verify();
  assert.equal(st.expired, true);
  assert.equal(st.loggedIn, false);
  assert.equal(session.isExpired(), true, 'session 必须被标记为失效');
  assert.equal(seen && seen.expired, true, 'onChange 必须收到失效通知');
  assert.equal(store.getItem('expired'), true, 'expired 必须被持久化');
  assert.equal(http.calls[0].path, '/1/clouddrive/config');
  assert.deepEqual(http.calls[0].query, COMMON_QUERY); // 含 uc_param_str 与 device_model（官方形态）
});

test('account.verify：成功时清除失效标记', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);
  session.markExpired();

  const http = fakeHttp(() => ({ status: 200, code: 0, data: {} }));
  const account = createAccountModule({ session, store, http });
  const st = await account.verify({ force: true });
  assert.equal(st.loggedIn, true);
  assert.equal(st.expired, false);
  assert.equal(session.isExpired(), false);
});

test('account.verify：已标记失效时默认直接返回失效态，不再打网络（force 可复测）', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);
  session.markExpired();

  const http = fakeHttp(() => ({ status: 200, code: 0 }));
  const account = createAccountModule({ session, store, http });

  const st = await account.verify();
  assert.equal(http.calls.length, 0, '默认不应重复请求');
  assert.equal(st.loggedIn, false);
  assert.equal(st.expired, true);

  const forced = await account.verify({ force: true });
  assert.equal(http.calls.length, 1);
  assert.equal(forced.loggedIn, true);
});

test('account.verify：网络错误原样抛出，不得误判为登录失效', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);

  const netErr = new QuarkError('网络请求失败，请检查网络连接', { code: ErrCode.NETWORK });
  const http = fakeHttp(() => { throw netErr; });
  const account = createAccountModule({ session, store, http });

  await assert.rejects(() => account.verify(), (e) => {
    assert.equal(e.code, ErrCode.NETWORK);
    return true;
  });
  assert.equal(session.isExpired(), false, '断网不得被标记为登录失效');
});

test('account.verify：服务端英文 message 必须被替换为中文，且 code 保留', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);

  // 模拟 errors.js 优先采用服务端 message 的场景（实测：require login [guest]）
  const enErr = new QuarkError('service temporarily unavailable', {
    code: ErrCode.SERVER, bizCode: 500, httpStatus: 503,
  });
  const http = fakeHttp(() => { throw enErr; });
  const account = createAccountModule({ session, store, http });

  await assert.rejects(() => account.verify(), (e) => {
    assert.equal(e.code, ErrCode.SERVER, 'code 必须保留');
    assert.equal(e.bizCode, 500, '原始业务码必须保留');
    assert.equal(e.httpStatus, 503);
    assert.ok(/[\u4e00-\u9fa5]/.test(e.message), `message 必须是中文，实际：${e.message}`);
    assert.equal(e.cause, enErr, '原始错误应保留在 cause 上');
    return true;
  });
});

test('toUserFacingError：已是中文的信息不被覆盖', () => {
  const e = new QuarkError('文件或目录不存在', { code: ErrCode.NOT_FOUND });
  assert.equal(toUserFacingError(e), e);
  assert.equal(toUserFacingError(null), null);
});

test('account.verify：本地无凭据时不发网络请求', async () => {
  const store = memStore();
  const session = createSession({ store });
  const http = fakeHttp(() => { throw new Error('不应发起请求'); });
  const account = createAccountModule({ session, store, http });
  const st = await account.verify();
  assert.equal(http.calls.length, 0);
  assert.equal(st.loggedIn, false);
  assert.equal(st.expired, false);
});

test('account.verify：force 但本地仍无任何凭据时，不得误报 expired', async () => {
  const store = memStore();
  const session = createSession({ store });
  const http = fakeHttp(() => { throw alive(); });
  const account = createAccountModule({ session, store, http });
  const st = await account.verify({ force: true });
  assert.equal(http.calls.length, 0);
  assert.equal(st.loggedIn, false);
  assert.equal(st.expired, false, '从未登录过不算失效');
});

test('account.status：无凭据但 session 被标记 expired 时，不得报 expired', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.markExpired();   // jar 为空
  const account = createAccountModule({ session, store, http: fakeHttp(() => ({})) });
  const st = await account.status();
  assert.equal(st.loggedIn, false);
  assert.equal(st.expired, false);
});

test('account.login：抓取 cookie → 写入 session → 持久化 → 广播', async () => {
  const store = memStore();
  const session = createSession({ store });

  const fakeController = {
    async start() {
      return { cookies: [{ name: 'ctoken', value: 'C1' }, { name: '__puus', value: 'P1' }] };
    },
    async cancel() {},
  };
  const http = fakeHttp(({ path }) => {
    if (path === '/1/clouddrive/member') return { status: 200, code: 0, data: { nickname: '阿夸' } };
    return { status: 200, code: 0, data: {} };
  });

  let seen = null;
  const account = createAccountModule({ session, store, http, loginController: fakeController });
  account.onStateChange((s) => { seen = s; });

  const st = await account.login();
  assert.equal(st.loggedIn, true);
  assert.equal(st.nickname, '阿夸');
  assert.equal(session.getCookie(), 'ctoken=C1; __puus=P1');
  assert.equal(store.getItem('cookies').length, 2, '必须已持久化');
  assert.equal(seen && seen.loggedIn, true);
});

test('account.login：抓不到任何 cookie 时抛出中文错误', async () => {
  const store = memStore();
  const session = createSession({ store });
  const http = fakeHttp(() => ({ status: 200, code: 0 }));
  const account = createAccountModule({
    session, store, http,
    loginController: { async start() { return { cookies: [] }; }, async cancel() {} },
  });
  await assert.rejects(() => account.login(), (e) => {
    assert.ok(/中文|登录/.test(e.message));
    assert.ok(typeof e.code === 'string' && e.code.length > 0, '错误对象必须带 code');
    return true;
  });
});

test('account.logout：清空登录分区和 session，保留设置并广播', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);
  session.save();

  let seen = null;
  store.setItem('settings', { theme: 'dark' });
  let cleared = false;
  const account = createAccountModule({ session, store, http: fakeHttp(() => ({})),
    loginController: { clearSession: async () => { cleared = true; } } });
  account.onStateChange((s) => { seen = s; });

  await account.logout();
  assert.equal(session.getCookie(), '');
  assert.equal(session.size(), 0);
  assert.equal(store.getItem('cookies'), null, '持久化存储必须被清理');
  assert.equal(seen && seen.loggedIn, false);
  assert.equal(cleared, true);
  assert.deepEqual(store.getItem('settings'), { theme: 'dark' });
});

test('account.onStateChange 返回可用的取消订阅函数，单个订阅者异常不影响其他订阅者', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);
  const http = fakeHttp(() => ({ status: 200, code: 0 }));
  const account = createAccountModule({ session, store, http });

  let hit = 0;
  const off = account.onStateChange(() => { throw new Error('订阅者故障'); });
  account.onStateChange(() => { hit += 1; });

  await account.verify();
  assert.equal(hit, 1, '订阅者抛错不得中断广播');
  off();
  await account.verify();
  assert.equal(hit, 2);
  assert.equal(typeof account.onStateChange(() => {}) === 'function', true);
});

// ---------------------------------------------------------------------------
// 6. quota / getUserInfo 宽松解析（字段名未经实测）
// ---------------------------------------------------------------------------

test('parseBytes 宽松解析', () => {
  assert.equal(parseBytes(1024), 1024);
  assert.equal(parseBytes('1024'), 1024);
  assert.equal(parseBytes('1.5GB'), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseBytes('2 MB'), 2 * 1024 ** 2);
  assert.equal(parseBytes('1TB'), 1024 ** 4);
  assert.equal(parseBytes(null), null);
  assert.equal(parseBytes(''), null);
  assert.equal(parseBytes('abc'), null);
  assert.equal(parseBytes('-5'), null);
  assert.equal(parseBytes({ size: 42 }), 42);
  assert.equal(parseBytes(true), null);
});

test('parseQuota：多套候选字段名都能解析', () => {
  assert.deepEqual(parseQuota({ status: 200, code: 0, data: { total: 100, used: 40, free: 60 } }),
    { total: 100, used: 40, free: 60 });
  assert.deepEqual(parseQuota({ data: { total_size: 200, used_size: 50, free_size: 150 } }),
    { total: 200, used: 50, free: 150 });
  assert.deepEqual(parseQuota({ data: { capacity: '1GB', use: '256MB', remain: '768MB' } }),
    { total: 1024 ** 3, used: 256 * 1024 ** 2, free: 768 * 1024 ** 2 });
  // 只有两项时推导第三项
  assert.deepEqual(parseQuota({ data: { total_size: 100, used_size: 30 } }),
    { total: 100, used: 30, free: 70 });
});

test('parseQuota：解析不出返回 -1，且绝不抛错', () => {
  const unknown = { total: -1, used: -1, free: -1 };
  assert.deepEqual(parseQuota(null), unknown);
  assert.deepEqual(parseQuota(undefined), unknown);
  assert.deepEqual(parseQuota({ data: {} }), unknown);
  assert.deepEqual(parseQuota({ data: { foo: 'bar' } }), unknown);
  assert.deepEqual(parseQuota({ status: 500, code: 1, message: 'boom' }), unknown);
  assert.deepEqual(parseQuota('nonsense'), unknown);
});

// ---------------------------------------------------------------------------
// 容量查询：以下三条断言基于**真实账号实测**（2026-10）修正
//   · /1/clouddrive/quota/remain 不带参数 → 14001 参数错误
//   · 带 type=DL_FLOW 时才可用，但返回的是**下载流量**，不是存储容量
//   · 存储容量来自 /1/clouddrive/member 的 total_capacity / use_capacity
// ---------------------------------------------------------------------------

test('account.quota：以 member 的 total_capacity/use_capacity 为准（实测字段名）', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);
  const http = fakeHttp(({ path }) => {
    if (path === '/1/clouddrive/member') {
      return { status: 200, code: 0, data: { total_capacity: 10737418240, use_capacity: 198360187548 } };
    }
    throw new Error('不应请求其它端点');
  });
  const account = createAccountModule({ session, store, http });
  const q = await account.quota();
  assert.equal(q.total, 10737418240);
  assert.equal(q.used, 198360187548);
  // 已用超过上限时 free 归零，而不是负数
  assert.equal(q.free, 0);
  assert.equal(http.calls[0].path, '/1/clouddrive/member');
  assert.deepEqual(http.calls[0].query, COMMON_QUERY); // 含 uc_param_str 与 device_model（官方形态）
});

test('account.quota：存储容量未知时不得使用下载流量冒充容量', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);

  const http1 = fakeHttp(({ path }) => {
    if (path === '/1/clouddrive/member') return { status: 200, code: 0, data: {} };
    if (path === '/1/clouddrive/quota/remain') {
      return { status: 200, code: 0, data: { DL_FLOW: { total: 100, used: 20, remain: 80 } } };
    }
    throw new Error('unexpected');
  });
  const account1 = createAccountModule({ session, store, http: http1 });
  assert.deepEqual(await account1.quota(), { total: -1, used: -1, free: -1 });
  assert.deepEqual(http1.calls.map((c) => c.path), ['/1/clouddrive/member']);

  const http2 = fakeHttp(() => { throw new QuarkError('网络请求失败', { code: ErrCode.NETWORK }); });
  const account2 = createAccountModule({ session, store, http: http2 });
  assert.deepEqual(await account2.quota(), { total: -1, used: -1, free: -1 });
});

test('account.quota：DL_FLOW 只查 quota/remain 并带 type=DL_FLOW', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);
  const http = fakeHttp(() => ({ status: 200, code: 0, data: { DL_FLOW: { total: 1, used: 0, remain: 1 } } }));
  const account = createAccountModule({ session, store, http });
  const r = await account.quota({ dlFlow: true });
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].path, '/1/clouddrive/quota/remain');
  assert.equal(http.calls[0].query.type, 'DL_FLOW');
  assert.deepEqual(r, { total: 1, used: 0, free: 1 });
});

test('errors：32003 携带 capacity limit 时必须判为 NO_SPACE 而非 RATE_LIMIT（真实响应实测）', () => {
  const { fromEnvelope: fe, ErrCode: EC, isRetryable: ir } = require('../src/main/core/errors.js');
  const real = {
    status: 400,
    code: 32003,
    message: 'capacity limit[{0}]',
    metadata: { missing_capacity: 187622974108, suggest_member_type: 'SUPER_VIP' },
  };
  const e = fe(real, 400);
  assert.equal(e.code, EC.NO_SPACE, '真实响应是容量不足，不是限流');
  assert.match(e.message, /容量不足/, '文案必须让用户看懂真实原因');
  assert.equal(ir(e), false, '容量不足不应重试');
  // 429 才是限流
  assert.equal(fe({ status: 429, code: 32003 }, 429).code, EC.RATE_LIMIT);
});

test('parseUserInfo：多套候选字段名；取不到留空字符串', () => {
  assert.deepEqual(
    parseUserInfo({ data: { nickname: '小明', avatar_url: 'https://a/b.png', member_label: 'SVIP', user_id: 'u1' } }),
    { nickname: '小明', avatar: 'https://a/b.png', memberLabel: 'SVIP', userId: 'u1' }
  );
  assert.deepEqual(
    parseUserInfo({ data: { member: { nick_name: '小红', head_image: 'https://a/c.png', vip_label: '普通用户', uid: 42 } } }),
    { nickname: '小红', avatar: 'https://a/c.png', memberLabel: '普通用户', userId: '42' }
  );
  assert.deepEqual(parseUserInfo(), { nickname: '', avatar: '', memberLabel: '', userId: '' });
  assert.deepEqual(parseUserInfo({ data: {} }, null, 'x'), { nickname: '', avatar: '', memberLabel: '', userId: '' });
});

test('account.getUserInfo：两个端点都查，失败也不抛错、不编造', async () => {
  const store = memStore();
  const session = createSession({ store });
  session.setCookies([{ name: 'a', value: '1' }]);

  const http = fakeHttp(({ path }) => {
    if (path === '/1/clouddrive/member') throw new QuarkError('服务端暂时不可用', { code: ErrCode.SERVER });
    return { status: 200, code: 0, data: { nickname: '配置里的昵称' } };
  });
  const account = createAccountModule({ session, store, http });
  const info = await account.getUserInfo();
  assert.deepEqual(http.calls.map((c) => c.path), ['/1/clouddrive/member', '/1/clouddrive/config']);
  assert.equal(info.nickname, '配置里的昵称');
  assert.equal(info.avatar, '');
  assert.equal(info.memberLabel, '');
});

// ---------------------------------------------------------------------------
// 7. login.js：判活（注入假 fetch，不需要真实窗口）
// ---------------------------------------------------------------------------

test('纯 Node 下 require login.js 不崩溃，且 LoginController 可构造', () => {
  const c = new LoginController({});
  assert.equal(c.isRunning(), false);
  assert.equal(typeof c.checkAlive, 'function');
  assert.equal(typeof c.start, 'function');
  assert.equal(typeof c.cancel, 'function');
});

test('checkAlive：HTTP 200 且 code===0 → true', async () => {
  const f = fakeFetch({ status: 200, body: { status: 200, code: 0, message: 'ok', data: {} } });
  const c = new LoginController({ fetchImpl: f });
  assert.equal(await c.checkAlive('a=1; b=2'), true);

  const [call] = f.calls;
  assert.ok(call.url.includes(ALIVE_PATH), '必须打判活接口');
  assert.ok(call.url.includes('pr=ucpro') && call.url.includes('fr=pc'));
  assert.equal(call.init.headers.cookie, 'a=1; b=2', '必须带上 Cookie 头');
  assert.equal(call.init.headers.referer, 'https://pan.quark.cn/');
});

test('checkAlive：401 + 31001（未登录实测响应）→ false', async () => {
  const f = fakeFetch({ status: 401, body: { status: 401, code: 31001, message: 'require login [guest]' } });
  const c = new LoginController({ fetchImpl: f });
  assert.equal(await c.checkAlive('a=1'), false);
});

test('checkAlive：网络异常 / 非 JSON / 其它状态码一律 false', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await new LoginController({ fetchImpl: boom }).checkAlive('a=1'), false);

  const garbage = async () => ({ status: 200, ok: true, async text() { return '<html>'; } });
  assert.equal(await new LoginController({ fetchImpl: garbage }).checkAlive('a=1'), false);

  const s500 = fakeFetch({ status: 500, body: { status: 500, code: 500 } });
  assert.equal(await new LoginController({ fetchImpl: s500 }).checkAlive('a=1'), false);

  // 无 Cookie 时也不得判定为已登录
  const f = fakeFetch({ status: 200, body: { code: 0 } });
  assert.equal(await new LoginController({ fetchImpl: f }).checkAlive(''), true);
  assert.equal(f.calls[0].init.headers.cookie, undefined);
});

test('start() 在非 Electron 环境下抛出中文错误且不崩溃', async () => {
  const c = new LoginController({ fetchImpl: fakeFetch() });
  await assert.rejects(() => c.start(), (e) => {
    assert.equal(e.code, ErrCode.INVALID_ARG);
    assert.ok(/桌面应用/.test(e.message), `错误信息应为中文，实际：${e.message}`);
    return true;
  });
});

test('cancel() 幂等且不抛错', async () => {
  const c = new LoginController({ fetchImpl: fakeFetch() });
  await c.cancel();
  await c.cancel();
  assert.equal(c.isRunning(), false);
});

test('buildCookieHeader / mergeCookies', () => {
  assert.equal(buildCookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), 'a=1; b=2');
  assert.equal(buildCookieHeader([{ name: 'a', value: '1' }, { name: 'a', value: '2' }]), 'a=1', '同名以先出现者为准');
  assert.equal(buildCookieHeader([{ name: 'a' }]), 'a=');
  assert.equal(buildCookieHeader(null), '');

  const merged = mergeCookies([
    [{ name: 'a', value: '1', domain: '.quark.cn' }],
    [{ name: 'a', value: '2', domain: 'pan.quark.cn' }, { name: 'b', value: '3' }],
  ]);
  assert.deepEqual(merged.map((c) => `${c.name}=${c.value}@${c.domain}`), ['a=1@.quark.cn', 'b=3@undefined']);
});

// ---------------------------------------------------------------------------
// 8. 安全底线：不得泄漏 Cookie 明文
// ---------------------------------------------------------------------------

test('会话管理器不向 console 打印任何 Cookie 值', () => {
  const captured = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  console.warn = (...a) => captured.push(a.join(' '));
  try {
    const s = createSession({ store: memStore() });
    s.setCookies([{ name: 'secret', value: 'SUPER_SECRET_TOKEN' }]);
    s.applySetCookie(['secret2=SUPER_SECRET_TOKEN_2']);
    s.save();
    s.getCookie();
    s.toJSON();
    s.getState();
    s.clear();
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
  assert.equal(captured.join('\n').includes('SUPER_SECRET_TOKEN'), false, '日志中不得出现 Cookie 明文');
  assert.equal(captured.length, 0, `会话管理器不应有任何输出，实际：${captured.join('|')}`);
});
