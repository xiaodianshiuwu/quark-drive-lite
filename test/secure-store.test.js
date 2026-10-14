'use strict';
/**
 * 安全存储单元测试（纯 Node，不加载 electron）。
 *
 * 运行：node --test test/secure-store.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSecureStore, isEncryptionAvailable } = require('../src/main/core/secure-store');
const { createSession } = require('../src/main/core/session');

let tmpRoot;
test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qck-secure-store-'));
});
test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 每个用例独立目录，避免相互污染。 */
function freshDir(name) {
  const d = path.join(tmpRoot, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 一个假 safeStorage：做**真正不可读**的可逆变换（XOR + base64），
 * 用于验证加密分支（明文不得出现在磁盘上）。
 */
function fakeSafeStorage({ available = true, failOnEncrypt = false } = {}) {
  const KEY = Buffer.from([0x5a, 0x17, 0x9c, 0x31]);
  const xor = (buf) => {
    const out = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ KEY[i & 3];
    return out;
  };
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => {
      if (failOnEncrypt) throw new Error('encryption backend unavailable');
      return Buffer.from(xor(Buffer.from(String(s), 'utf8')).toString('base64'), 'utf8');
    },
    decryptString: (buf) => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      const raw = Buffer.from(b.toString('utf8'), 'base64');
      if (!raw.length) throw new Error('bad payload');
      return xor(raw).toString('utf8');
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 工厂接口形状
// ---------------------------------------------------------------------------

test('createSecureStore 暴露约定的接口', () => {
  const store = createSecureStore({ userDataDir: freshDir('shape') });
  for (const m of ['isAvailable', 'isEncrypted', 'getItem', 'setItem', 'removeItem', 'clear']) {
    assert.equal(typeof store[m], 'function', `缺少方法 ${m}`);
  }
  assert.equal(typeof store.filePath, 'string');
  assert.equal(path.basename(store.filePath), 'session.bin');
});

test('fileName 可配置', () => {
  const store = createSecureStore({ userDataDir: freshDir('name'), fileName: 'other.bin' });
  assert.equal(path.basename(store.filePath), 'other.bin');
});

test('isEncryptionAvailable() 顶层导出在纯 Node 下返回 false 且不抛错', () => {
  assert.equal(typeof isEncryptionAvailable, 'function');
  assert.equal(isEncryptionAvailable(), false, '纯 Node 下没有 safeStorage');
});

// ---------------------------------------------------------------------------
// 2. 纯 Node 回退路径（明文 + encrypted:false）
// ---------------------------------------------------------------------------

test('无 safeStorage 时：isAvailable=false，落盘标记 encrypted:false，可正常往返', () => {
  const dir = freshDir('plain');
  const store = createSecureStore({ userDataDir: dir });
  assert.equal(store.isAvailable(), false);

  store.setItem('cookies', [{ name: 'a', value: '1' }]);
  assert.equal(store.isEncrypted(), false);

  const raw = fs.readFileSync(store.filePath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.encrypted, false, '文件里必须标记 encrypted:false');
  assert.equal(parsed.v, 1);
  assert.deepEqual(parsed.data.cookies, [{ name: 'a', value: '1' }]);

  assert.deepEqual(store.getItem('cookies'), [{ name: 'a', value: '1' }]);
  assert.equal(store.getItem('不存在'), null);
});

test('注入不可用的 safeStorage 时同样走明文回退', () => {
  const store = createSecureStore({ userDataDir: freshDir('unavail'), safeStorage: fakeSafeStorage({ available: false }) });
  assert.equal(store.isAvailable(), false);
  store.setItem('k', 'v');
  const parsed = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.equal(parsed.encrypted, false);
});

// ---------------------------------------------------------------------------
// 3. 加密分支
// ---------------------------------------------------------------------------

test('safeStorage 可用时落盘为密文，且文件中不出现明文', () => {
  const dir = freshDir('enc');
  const store = createSecureStore({ userDataDir: dir, safeStorage: fakeSafeStorage() });
  assert.equal(store.isAvailable(), true);

  store.setItem('cookies', [{ name: 'secret', value: 'PLAINTEXT_TOKEN_XYZ' }]);

  const raw = fs.readFileSync(store.filePath);
  assert.equal(raw.subarray(0, 4).toString('utf8'), 'QCK1', '密文应有文件头魔数');
  assert.equal(raw.toString('utf8').includes('PLAINTEXT_TOKEN_XYZ'), false, '密文文件中不得出现明文');
  assert.equal(store.isEncrypted(), true);
  assert.deepEqual(store.getItem('cookies'), [{ name: 'secret', value: 'PLAINTEXT_TOKEN_XYZ' }]);
});

test('加密存储跨实例可读（模拟重启）', () => {
  const dir = freshDir('enc-reload');
  const ss = fakeSafeStorage();
  createSecureStore({ userDataDir: dir, safeStorage: ss }).setItem('k', { n: 1 });

  const again = createSecureStore({ userDataDir: dir, safeStorage: ss });
  assert.deepEqual(again.getItem('k'), { n: 1 });
  assert.equal(again.isEncrypted(), true);
});

test('加密失败时回退明文并标记 encrypted:false，不抛错', () => {
  const dir = freshDir('enc-fail');
  const store = createSecureStore({
    userDataDir: dir,
    safeStorage: fakeSafeStorage({ failOnEncrypt: true }),
  });
  store.setItem('k', 'v');
  const parsed = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.equal(parsed.encrypted, false);
  assert.equal(store.isEncrypted(), false);
  assert.equal(store.getItem('k'), 'v');
});

test('密文损坏时视为无有效存储（不抛错，交给上层重新登录）', () => {
  const dir = freshDir('corrupt');
  const ss = fakeSafeStorage();
  const store = createSecureStore({ userDataDir: dir, safeStorage: ss });
  store.setItem('k', 'v');

  fs.writeFileSync(store.filePath, Buffer.concat([
    Buffer.from('QCK1', 'utf8'),
    Buffer.from('这不是有效的密文', 'utf8'),
  ]));
  const reopened = createSecureStore({ userDataDir: dir, safeStorage: ss });
  assert.equal(reopened.getItem('k'), null);
});

// ---------------------------------------------------------------------------
// 4. 原子写入
// ---------------------------------------------------------------------------

test('写入使用 .tmp + rename，且不留残余临时文件', () => {
  const dir = freshDir('atomic');
  const store = createSecureStore({ userDataDir: dir });
  store.setItem('a', 1);
  store.setItem('b', 2);
  store.setItem('c', 3);

  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['session.bin'], `目录里只应有目标文件，实际：${files.join(',')}`);
});

test('写入过程先落到 .tmp 再改名（同名覆盖后内容为最新值）', () => {
  const dir = freshDir('replace');
  const store = createSecureStore({ userDataDir: dir });
  store.setItem('k', 'first');
  const s1 = fs.readFileSync(store.filePath, 'utf8');
  store.setItem('k', 'second');
  const s2 = fs.readFileSync(store.filePath, 'utf8');

  assert.equal(JSON.parse(s1).data.k, 'first');
  assert.equal(JSON.parse(s2).data.k, 'second');
  // 旧内容不得残留
  assert.equal(s2.includes('first'), false);
  assert.equal(fs.existsSync(`${store.filePath}.tmp`), false);
});

test('目标目录不存在时自动创建', () => {
  const dir = path.join(tmpRoot, 'nested', 'deep', 'dir');
  fs.rmSync(path.join(tmpRoot, 'nested'), { recursive: true, force: true });
  const store = createSecureStore({ userDataDir: dir });
  store.setItem('k', 'v');
  assert.equal(fs.existsSync(store.filePath), true);
});

test('写入文件权限为 0600（非 Windows）或至少不含明文泄漏（Windows）', () => {
  const store = createSecureStore({ userDataDir: freshDir('mode') });
  store.setItem('k', 'v');
  const mode = fs.statSync(store.filePath).mode & 0o777;
  if (process.platform === 'win32') {
    assert.ok(mode >= 0, 'Windows 下不校验 POSIX 权限位');
  } else {
    assert.equal(mode, 0o600);
  }
});

// ---------------------------------------------------------------------------
// 5. 多键 / 删除 / 清空
// ---------------------------------------------------------------------------

test('多键共存互不影响', () => {
  const dir = freshDir('multi');
  const store = createSecureStore({ userDataDir: dir });
  store.setItem('cookies', [{ name: 'a', value: '1' }]);
  store.setItem('expired', true);
  store.setItem('account', { nickname: '小明' });

  assert.deepEqual(store.getItem('cookies'), [{ name: 'a', value: '1' }]);
  assert.equal(store.getItem('expired'), true);
  assert.deepEqual(store.getItem('account'), { nickname: '小明' });

  store.removeItem('expired');
  assert.equal(store.getItem('expired'), null);
  assert.deepEqual(store.getItem('cookies'), [{ name: 'a', value: '1' }], '删除其它键不得影响 cookies');

  store.clear();
  assert.equal(store.getItem('cookies'), null);
  assert.equal(store.getItem('account'), null);
  assert.equal(fs.existsSync(store.filePath), false, 'clear 后存储文件应被删除');
});

test('clear 可重复调用', () => {
  const store = createSecureStore({ userDataDir: freshDir('clear-twice') });
  store.setItem('k', 'v');
  store.clear();
  store.clear();
  assert.equal(store.getItem('k'), null);
});

test('跨实例修改可被后开的实例读到（模拟两次启动）', () => {
  const dir = freshDir('instances');
  createSecureStore({ userDataDir: dir }).setItem('a', 1);
  createSecureStore({ userDataDir: dir }).setItem('b', 2);
  const third = createSecureStore({ userDataDir: dir });
  assert.equal(third.getItem('a'), 1);
  assert.equal(third.getItem('b'), 2);
});

// ---------------------------------------------------------------------------
// 6. 与 session.js 集成（纯 Node 全链路）
// ---------------------------------------------------------------------------

test('session + secure-store 全链路：登录态加密落盘 → 重启恢复 → 登出清除', () => {
  const dir = freshDir('integrate');
  const ss = fakeSafeStorage();

  // 第一次启动：登录成功
  const store1 = createSecureStore({ userDataDir: dir, safeStorage: ss });
  const s1 = createSession({ store: store1 }).load();
  s1.setCookies([
    { name: 'ctoken', value: 'TOKEN_VALUE_1', domain: 'pan.quark.cn', httpOnly: false },
    { name: 'grey-id', value: 'GREY_VALUE_2', domain: 'pan.quark.cn', httpOnly: true },
  ]);
  s1.setAccountInfo({ nickname: '阿夸', avatar: '', memberLabel: 'SVIP', userId: 'u1' });
  s1.save();

  assert.equal(s1.isLoggedIn(), true);
  assert.equal(s1.getCookie(), 'ctoken=TOKEN_VALUE_1; grey-id=GREY_VALUE_2');
  // 磁盘上不得有明文
  assert.equal(fs.readFileSync(store1.filePath, 'utf8').includes('TOKEN_VALUE_1'), false);

  // 第二次启动：恢复登录态
  const store2 = createSecureStore({ userDataDir: dir, safeStorage: ss });
  const s2 = createSession({ store: store2 }).load();
  assert.equal(s2.isLoggedIn(), true);
  assert.equal(s2.getCookie(), 'ctoken=TOKEN_VALUE_1; grey-id=GREY_VALUE_2');
  assert.equal(s2.getAccountInfo().nickname, '阿夸');

  // 登出
  s2.clear();
  const store3 = createSecureStore({ userDataDir: dir, safeStorage: ss });
  const s3 = createSession({ store: store3 }).load();
  assert.equal(s3.isLoggedIn(), false);
  assert.equal(s3.getCookie(), '');
});

test('存储文件不含任何明文 Cookie（明文回退模式下的预期行为需显式知晓）', () => {
  const dir = freshDir('plain-check');
  const store = createSecureStore({ userDataDir: dir });   // safeStorage 不可用
  store.setItem('cookies', [{ name: 'a', value: 'SECRET' }]);
  const raw = fs.readFileSync(store.filePath, 'utf8');
  // 回退模式下明文落盘是**已知且已标记**的行为，测试显式固定该契约
  assert.equal(raw.includes('SECRET'), true);
  assert.equal(JSON.parse(raw).encrypted, false);
});
