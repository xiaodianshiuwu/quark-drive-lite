'use strict';
// 不调用系统钥匙串/密钥环，无主密码。密钥与密文同属当前用户 profile。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const MAGIC = Buffer.from('QCK2');
const LEGACY = Buffer.from('QCK1');

function createLocalStore({ userDataDir, fileName = 'session.bin', migrateLegacy } = {}) {
  const dir = userDataDir || path.join(os.tmpdir(), 'quark-mini');
  const file = path.join(dir, fileName);
  const keyFile = path.join(dir, 'session.key');
  let cached;
  let encrypted = false;
  let legacyUnmigrated = false;
  function atomic(target, data) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  function readKey() {
    const key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new Error('本地登录资料密钥损坏，请恢复登录资料备份或重新登录');
    return key;
  }
  function ensureKey() {
    if (fs.existsSync(keyFile)) return readKey();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    const temporary = `${keyFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, key, { mode: 0o600, flag: 'wx' });
      try { fs.linkSync(temporary, keyFile); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      return readKey();
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  function parse(text) {
    const document = JSON.parse(text);
    const data = document?.v === undefined ? document : document.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本地登录资料格式损坏');
    return data;
  }
  function write(data) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ensureKey(), nonce);
    cipher.setAAD(MAGIC);
    const bytes = Buffer.concat([cipher.update(JSON.stringify({ v: 2, data }), 'utf8'), cipher.final()]);
    if (legacyUnmigrated) {
      try { fs.copyFileSync(file, `${file}.legacy-QCK1`, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    atomic(file, Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), bytes]));
    cached = data; encrypted = true; legacyUnmigrated = false;
  }
  function load() {
    if (cached !== undefined) return cached;
    let raw;
    try { raw = fs.readFileSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; cached = {}; return cached; }
    if (!raw.length) { cached = {}; return cached; }
    if (raw.subarray(0, 4).equals(MAGIC)) {
      if (raw.length < 32) throw new Error('本地登录资料已损坏');
      const decipher = crypto.createDecipheriv('aes-256-gcm', readKey(), raw.subarray(4, 16));
      decipher.setAAD(MAGIC); decipher.setAuthTag(raw.subarray(16, 32));
      try { cached = parse(Buffer.concat([decipher.update(raw.subarray(32)), decipher.final()]).toString('utf8')); }
      catch { throw new Error('本地登录资料无法校验，请恢复登录资料和密钥备份或重新登录'); }
      encrypted = true;
    } else if (raw.subarray(0, 4).equals(LEGACY)) {
      if (migrateLegacy) {
        const migrated = migrateLegacy();
        if (!migrated || typeof migrated !== 'object' || Array.isArray(migrated)) throw new Error('旧版登录资料迁移失败');
        legacyUnmigrated = true;
        write(migrated);
      } else {
        // 普通应用不打开系统密码窗口；重新登录时保留原密文备份。
        cached = {}; legacyUnmigrated = true;
      }
    } else {
      cached = parse(raw.toString('utf8'));
    }
    return cached;
  }
  return {
    initialize: async () => { load(); },
    isAvailable: () => true,
    isEncrypted: () => { load(); return encrypted; },
    getItem: key => { const data = load(); return Object.hasOwn(data, key) ? data[key] : null; },
    setItem: (key, value) => write({ ...load(), [key]: value }),
    setItems: values => write({ ...load(), ...values }),
    removeItem: key => { const data = { ...load() }; delete data[key]; write(data); },
    clear: () => { fs.rmSync(file, { force: true }); cached = {}; encrypted = false; legacyUnmigrated = false; },
    snapshot: () => JSON.parse(JSON.stringify(load())),
    dir, filePath: file, keyPath: keyFile,
  };
}
module.exports = { createLocalStore };
