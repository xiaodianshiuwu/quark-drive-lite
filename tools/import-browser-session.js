'use strict';
/**
 * 提取浏览器 Cookie 并注入本应用的会话（免扫码快速通道）。
 *
 * 用途与边界
 * ----------
 * 官方 PC 客户端的登录机制就是"复用浏览器登录态"（调用 Chromium 原生
 * `chrome.account.openLoginWindow` 打开应用内登录窗口后读取原生 Cookie）。
 * 本脚本做的是**同一件事**：从用户本机已登录的浏览器（Chrome/Edge）读取
 * **用户自己**的夸克 Cookie，写入本应用的加密会话存储。
 *
 * 它**不绕过任何认证**：Cookie 来自用户本人已完成的真实登录，
 * 脚本只是省去"在本应用里再扫一次码"这一重复步骤。
 * 同时也为自动化 E2E 提供可复现的登录态来源。
 *
 * 用法：
 *   node tools/import-browser-session.js            # 自动挑选有登录态的浏览器
 *   node tools/import-browser-session.js --from=edge
 *   node tools/import-browser-session.js --dry-run   # 只检测，不写入
 *   node tools/import-browser-session.js --list      # 列出所有浏览器的检测结果
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'src', 'main');

const { createSecureStore } = require(path.join(SRC, 'core', 'secure-store.js'));
const { createSession } = require(path.join(SRC, 'core', 'session.js'));
const { HttpClient } = require(path.join(SRC, 'core', 'http.js'));

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const LIST_ONLY = ARGS.includes('--list');
const FROM = (ARGS.find((a) => a.startsWith('--from=')) || '').split('=')[1] || '';

const LOCAL = process.env.LOCALAPPDATA || '';
const APPDATA = process.env.APPDATA || '';

/** 本应用 userData 目录：Electron 默认取 package.json 的 name（quark-mini）。 */
const APP_DIR = path.join(APPDATA, 'quark-mini');

const BROWSERS = [
  { key: 'edge', name: 'Microsoft Edge', base: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data') },
  { key: 'chrome', name: 'Google Chrome', base: path.join(LOCAL, 'Google', 'Chrome', 'User Data') },
  // 官方夸克客户端本身也是 Chromium，其分区里可能有登录态
  { key: 'quark', name: '夸克网盘客户端', base: path.join(LOCAL, 'Quark', 'User Data') },
];

async function main() {
  console.log('\x1b[1m=== 从浏览器导入夸克登录态 ===\x1b[0m');

  const found = [];
  for (const b of BROWSERS) {
    if (!fs.existsSync(b.base)) continue;
    const localState = path.join(b.base, 'Local State');
    if (!fs.existsSync(localState)) continue;

    for (const prof of listProfiles(b.base)) {
      const db = path.join(prof.dir, 'Network', 'Cookies');
      if (!fs.existsSync(db)) continue;

      let cookies = [];
      try {
        cookies = await readCookies(db, localState, prof.name);
      } catch (e) {
        console.log(`  \x1b[33m·\x1b[0m ${b.name}/${prof.name}: 读取失败（${short(e.message)}）`);
        continue;
      }
      const quark = cookies.filter((c) => /quark\.cn$/i.test(c.domain.replace(/^\./, '')) || /quark\.cn$/i.test(c.domain));
      if (!quark.length) continue;

      const alive = await checkAlive(quark);
      const mark = alive ? '\x1b[32m已登录\x1b[0m' : '\x1b[90m未登录\x1b[0m';
      console.log(
        `  ${alive ? '\x1b[32m✓\x1b[0m' : '\x1b[33m·\x1b[0m'} ${b.name}/${prof.name}: quark cookie ${quark.length} 个 → ${mark}`
      );
      found.push({ browser: b, profile: prof.name, cookieCount: quark.length, alive, cookies });
    }
  }

  if (LIST_ONLY) {
    console.log('\n（--list 模式，未写入任何数据）');
    return;
  }

  const usable = found.filter((f) => f.alive && (!FROM || f.browser.key === FROM));
  if (!usable.length) {
    console.log(
      '\n\x1b[33m未找到可用的登录态。\x1b[0m\n' +
        '请先在浏览器（Edge/Chrome）里登录 https://pan.quark.cn/ ，然后重新运行本脚本；\n' +
        '或者直接在应用里登录：\n\n    npm start\n'
    );
    process.exitCode = 2;
    return;
  }

  const pick = usable[0];
  console.log(
    `\n选用：\x1b[1m${pick.browser.name}/${pick.profile}\x1b[0m（可用的 quark cookie ${pick.cookieCount} 个）`
  );

  if (DRY) {
    console.log('（--dry-run 模式，未写入）');
    return;
  }

  // 写入本应用的加密会话存储
  const store = createSecureStore({ userDataDir: APP_DIR, requireEncryption: true });
  const session = createSession({ store }).load();
  session.setCookies(pick.cookies);
  session.clearExpired();
  session.save();

  // 立即用真实接口复验
  const http = new HttpClient({ getCookie: () => session.getCookie() });
  let verified = false;
  try {
    const env = await http.get('/1/clouddrive/config', { pr: 'ucpro', fr: 'pc', uc_param_str: '' });
    verified = !!(env && env.code === 0);
  } catch (e) {
    console.log(`  \x1b[33m复验失败：${short(e.message)}\x1b[0m`);
  }

  console.log(
    verified
      ? '  \x1b[32m✓ 登录态已写入并通过真实接口复验（/1/clouddrive/config 返回 code=0）\x1b[0m'
      : '  \x1b[31m✗ 已写入，但真实接口复验未通过\x1b[0m'
  );
  console.log(`  \x1b[90m存储位置：${path.join(APP_DIR, 'session.bin')}\x1b[0m`);
  if (!verified) process.exitCode = 3;
}

function short(s) {
  s = String(s || '');
  return s.length > 70 ? `${s.slice(0, 70)}…` : s;
}

function listProfiles(base) {
  const out = [];
  const push = (name, dir) => {
    if (fs.existsSync(dir)) out.push({ name, dir });
  };
  push('Default', path.join(base, 'Default'));
  for (let i = 1; i <= 8; i += 1) push(`Profile ${i}`, path.join(base, `Profile ${i}`));
  return out;
}

/**
 * 读取并解密指定 profile 的 Cookie。
 *
 * 解密链路（与 tools/decrypt_cookies.js 相同，此处内联以便独立运行）：
 *   1. 从 Local State 取 os_crypt.encrypted_key，去掉 "DPAPI" 前缀后用 DPAPI 解出 AES-256 密钥
 *      —— 这一步必须由 PowerShell 完成（Node 无 DPAPI 绑定）
 *   2. 用该密钥 AES-256-GCM 解密每条 encrypted_value
 *   3. Chrome 130+ 会在明文前加 32 字节 SHA256(domain)，需剥离
 */
async function readCookies(dbPath, localStatePath, profileName) {
  const { execFileSync } = require('child_process');

  // ---- 1. 用 PowerShell 解出 DPAPI 密钥 ----
  const keyB64 = getDpapiKey(localStatePath);

  // ---- 2. 用 Python 读取 sqlite（Node 无内置 sqlite） ----
  const py = process.env.DSH_PYTHON || findPython();
  if (!py) throw new Error('未找到 Python，无法读取浏览器 Cookie 数据库');
  const tmp = path.join(os.tmpdir(), `qkimp_${Date.now()}_${Math.random().toString(16).slice(2)}.db`);
  const dbEsc = dbPath.replace(/\\/g, '\\\\');
  const tmpEsc = tmp.replace(/\\/g, '\\\\');
  // 首选 immutable=1 只读直开（浏览器正在运行时也能读，无需复制）；
  // 失败再退化为复制一份（某些情况 immutable 不可用）。
  const script = `
import sqlite3, json, sys, os
rows = None
err = None
try:
    con = sqlite3.connect(f"file:${dbEsc}?mode=ro&immutable=1", uri=True, timeout=5)
    rows = con.execute("SELECT host_key,name,value,encrypted_value,path,is_secure,is_httponly FROM cookies WHERE host_key LIKE '%quark%'").fetchall()
    con.close()
except Exception as e:
    err = e
if rows is None:
    import shutil
    try:
        shutil.copy2(r"${dbEsc}", r"${tmpEsc}")
        con = sqlite3.connect(r"${tmpEsc}", timeout=8)
        rows = con.execute("SELECT host_key,name,value,encrypted_value,path,is_secure,is_httponly FROM cookies WHERE host_key LIKE '%quark%'").fetchall()
        con.close()
    except Exception as e2:
        sys.stderr.write("READ_FAIL: %s | %s" % (err, e2))
        sys.stdout.write("[]")
        sys.exit(0)
out = []
for h,n,v,ev,p,sec,ho in rows:
    out.append({"host":h,"name":n,"value":v or "","enc":(ev or b"").hex(),"path":p,"secure":sec,"httponly":ho})
sys.stdout.write(json.dumps(out))
`;
  let raw;
  try {
    raw = execFileSync(py, ['-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = `${(e.stderr || '').toString()}`.trim() || e.message;
    throw new Error(`Cookie 数据库被占用或无法读取（请关闭该浏览器后重试）：${msg.slice(0, 120)}`);
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }

  const rows = JSON.parse(raw || '[]');
  const key = Buffer.from(keyB64, 'base64');
  const crypto = require('crypto');

  const out = [];
  for (const r of rows) {
    let value = r.value;
    const enc = Buffer.from(r.enc || '', 'hex');
    if (!value && enc.length > 15) {
      const tag = enc.subarray(0, 3).toString('latin1');
      if (tag === 'v10' || tag === 'v11') {
        try {
          const iv = enc.subarray(3, 15);
          const ct = enc.subarray(15, enc.length - 16);
          const auth = enc.subarray(enc.length - 16);
          const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
          d.setAuthTag(auth);
          let plain = Buffer.concat([d.update(ct), d.final()]);
          // Chrome 130+ 域名绑定：明文前 32 字节为 SHA256(host)
          if (plain.length > 32) {
            const expect = crypto.createHash('sha256').update(r.host).digest();
            if (plain.subarray(0, 32).equals(expect)) plain = plain.subarray(32);
          }
          value = plain.toString('utf8');
        } catch {
          continue; // 解密失败（可能属于别的用户/DPAPI 作用域）→ 跳过
        }
      } else {
        continue; // v20 应用绑定加密，暂不支持
      }
    }
    if (!value) continue;
    out.push({ name: r.name, value, domain: r.host, path: r.path, secure: !!r.secure, httpOnly: !!r.httponly });
  }
  return out;
}

/** 用 PowerShell 调 DPAPI 解出 Chromium 的 AES 密钥。 */
function getDpapiKey(localStatePath) {
  const { execFileSync } = require('child_process');
  const ls = localStatePath.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$j = Get-Content -LiteralPath '${ls}' -Raw -Encoding UTF8 | ConvertFrom-Json
$enc = [Convert]::FromBase64String($j.os_crypt.encrypted_key)
$blob = [byte[]]::new($enc.Length-5)
[Array]::Copy($enc,5,$blob,0,$blob.Length)
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($key)
`;
  const r = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true }
  );
  const b64 = (r || '').trim().split(/\r?\n/).pop().trim();
  if (!b64) throw new Error('未能解出浏览器加密密钥');
  return b64;
}

function findPython() {
  const cands = [
    process.env.DSH_PYTHON,
    path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python.exe',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (c === 'python.exe') return c;
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 用真实判活接口校验这组 cookie 是否仍然有效。 */
async function checkAlive(cookies) {
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  if (!header) return false;
  try {
    const { DEFAULT_UA } = require(path.join(SRC, 'core', 'http.js'));
    const res = await fetch('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc&uc_param_str=', {
      headers: {
        cookie: header,
        referer: 'https://pan.quark.cn/',
        origin: 'https://pan.quark.cn',
        'user-agent': DEFAULT_UA,
        accept: 'application/json, text/plain, */*',
      },
    });
    const body = await res.json().catch(() => null);
    return res.status === 200 && body && body.code === 0;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error('\x1b[31m导入失败：\x1b[0m', e && e.message ? e.message : e);
  process.exitCode = 1;
});
