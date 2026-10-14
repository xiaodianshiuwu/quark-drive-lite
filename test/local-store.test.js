'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createSecureStore } = require('../src/main/core/secure-store');
const { configureBrowserStorage } = require('../src/main/core/browser-storage');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qck-local-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createSecureStore({ userDataDir: dir }) };
}

test('本地登录态用随机密钥加密，跨进程恢复且没有任何系统加密调用', async t => {
  const { dir, store } = fixture(t);
  store.setItems({ cookies: [{ name: 'fixture', value: '仅用于测试的凭据' }], settings: { theme: 'dark' } });
  const raw = fs.readFileSync(store.filePath);
  assert.equal(raw.subarray(0, 4).toString(), 'QCK2');
  assert.equal(raw.includes(Buffer.from('仅用于测试的凭据')), false);
  assert.equal(fs.readFileSync(store.keyPath).length, 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.keyPath).mode & 0o777, 0o600);
  const fresh = createSecureStore({ userDataDir: dir });
  await fresh.initialize();
  assert.deepEqual(fresh.snapshot(), store.snapshot());
  const modulePath = path.resolve(__dirname, '../src/main/core/secure-store');
  const source = `const M=require('node:module'),load=M._load;M._load=function(name,...args){if(name==='electron')throw Error('禁止调用系统存储');return load.call(this,name,...args);};const s=require(${JSON.stringify(modulePath)}).createSecureStore({userDataDir:${JSON.stringify(dir)}});if(s.getItem('settings').theme!=='dark')process.exit(1);`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error('子进程未能无系统密码恢复资料')));
  });
});

test('正常空 profile 不建立钥匙串、不生成无用密钥', t => {
  const { store } = fixture(t);
  assert.equal(store.getItem('cookies'), null);
  assert.equal(store.isAvailable(), true);
  assert.equal(fs.existsSync(store.keyPath), false);
});

test('密文被篡改、密钥错误或缺失时拒绝读取，保留原数据', t => {
  const { dir, store } = fixture(t);
  store.setItem('fixture', '测试值');
  const original = fs.readFileSync(store.filePath);
  const key = fs.readFileSync(store.keyPath);
  const tampered = Buffer.from(original); tampered[tampered.length - 1] ^= 1;
  fs.writeFileSync(store.filePath, tampered);
  assert.throws(() => createSecureStore({ userDataDir: dir }).getItem('fixture'), /无法校验/);
  assert.deepEqual(fs.readFileSync(store.filePath), tampered);
  fs.writeFileSync(store.filePath, original);
  fs.writeFileSync(store.keyPath, crypto.randomBytes(32));
  assert.throws(() => createSecureStore({ userDataDir: dir }).getItem('fixture'), /无法校验/);
  fs.writeFileSync(store.keyPath, Buffer.alloc(1));
  assert.throws(() => createSecureStore({ userDataDir: dir }).getItem('fixture'), /密钥损坏/);
  fs.rmSync(store.keyPath);
  assert.throws(() => createSecureStore({ userDataDir: dir }).getItem('fixture'), /ENOENT/);
  assert.equal(fs.existsSync(store.keyPath), false);
  fs.writeFileSync(store.keyPath, key);
  assert.equal(createSecureStore({ userDataDir: dir }).getItem('fixture'), '测试值');
});

test('旧密文显式迁移后原件保留，正常启动不再依赖系统密钥', t => {
  const { dir, store } = fixture(t);
  const legacy = Buffer.from('QCK1固定迁移样本');
  fs.writeFileSync(store.filePath, legacy);
  const migrated = createSecureStore({ userDataDir: dir, migrateLegacy: () => ({ fixture: '已迁移' }) });
  assert.equal(migrated.getItem('fixture'), '已迁移');
  assert.deepEqual(fs.readFileSync(`${store.filePath}.legacy-QCK1`), legacy);
  assert.equal(createSecureStore({ userDataDir: dir }).getItem('fixture'), '已迁移');
});

test('旧格式解密后不是有效 JSON 时迁移拒绝覆盖原件',t=>{
  const {dir,store}=fixture(t);
  const legacy=Buffer.from('QCK1固定无效样本');fs.writeFileSync(store.filePath,legacy);
  const {createSystemSecureStore}=require('../src/main/core/secure-store');
  const system=createSystemSecureStore({userDataDir:dir,strictRead:true,safeStorage:{decryptString:()=> '错误数据'}});
  assert.throws(()=>system.snapshot(),/格式损坏/);
  assert.deepEqual(fs.readFileSync(store.filePath),legacy);
});

test('未显式迁移的旧 profile 可重新登录，旧密文不会被删除或覆盖', t => {
  const { dir, store } = fixture(t);
  const legacy = Buffer.from('QCK1固定旧样本');
  fs.writeFileSync(store.filePath, legacy);
  const { createLocalStore } = require('../src/main/core/local-store');
  const applicationStore = createLocalStore({ userDataDir: dir });
  assert.equal(applicationStore.getItem('cookies'), null);
  applicationStore.setItem('cookies', [{ name: 'fixture', value: '新测试凭据' }]);
  assert.deepEqual(fs.readFileSync(`${store.filePath}.legacy-QCK1`), legacy);
  assert.equal(createSecureStore({ userDataDir: dir }).getItem('cookies').length, 1);
});

test('保存失败不破坏已有密文，也不接受未成功落盘的缓存修改', t => {
  const { store } = fixture(t); store.setItem('fixture', '原值');
  const original = fs.readFileSync(store.filePath);
  const rename = fs.renameSync;
  fs.renameSync = (...args) => { if (args[1] === store.filePath) throw Error('模拟写入失败'); return rename(...args); };
  try { assert.throws(() => store.setItem('fixture', '新值'), /模拟写入失败/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(store.filePath), original);
  assert.equal(store.getItem('fixture'), '原值');
});

test('并发首次保存使用同一完整密钥，各文件均可解密', async t => {
  const { dir } = fixture(t);
  const modulePath = path.resolve(__dirname, '../src/main/core/secure-store');
  await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const source = `require(${JSON.stringify(modulePath)}).createSecureStore({userDataDir:${JSON.stringify(dir)},fileName:'client-${index}.bin'}).setItem('index',${index});`;
    const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error('并发保存失败')));
  })));
  for (let index = 0; index < 6; index++) assert.equal(createSecureStore({ userDataDir: dir, fileName: `client-${index}.bin` }).getItem('index'), index);
});

test('浏览器只配置应用内存储，macOS/Linux 不依赖系统密钥环，Windows 不设置主密码', () => {
  for (const [platform, expected] of [['darwin', [['use-mock-keychain']]], ['linux', [['password-store', 'basic']]], ['win32', []]]) {
    const switches = [];
    configureBrowserStorage({ commandLine: { appendSwitch: (...args) => switches.push(args) } }, platform);
    assert.deepEqual(switches, expected);
  }
});
