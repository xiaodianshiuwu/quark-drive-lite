'use strict';
/**
 * 辅助登录：弹出一个**可见**的浏览器窗口让你扫码，登录成功后自动导入本应用会话。
 *
 * 为什么需要它
 * ------------
 * 本应用的登录机制本身已经可用（见 verify 的 loginprobe：13/13 通过），
 * 但「你用手机扫一下码」这一步必须由人完成，自动化脚本无法代劳。
 *
 * 本脚本把这件事变得最简单：
 *   1. 弹出一个可见窗口打开 https://pan.quark.cn/
 *   2. 你在窗口里扫码 / 输手机号登录
 *   3. 脚本自动轮询检测登录成功（用真实判活接口校验，不靠猜 Cookie 名）
 *   4. 成功即把 Cookie 写入本应用的加密会话存储，并立即用真实接口复验
 *
 * 之后 `npm run e2e` 就能跑完整真实链路（列表/上传/下载/删除）了。
 *
 * 用法：
 *   node tools/login-assisted.js                 # 弹出窗口，等你扫码（默认 5 分钟）
 *   node tools/login-assisted.js --timeout=600   # 自定义等待秒数
 *
 * 退出码：0=成功并已导入；2=超时/未登录；1=执行出错
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'src', 'main');

const { createSecureStore } = require(path.join(SRC, 'core', 'secure-store.js'));
const { createSession } = require(path.join(SRC, 'core', 'session.js'));
const { HttpClient, DEFAULT_UA } = require(path.join(SRC, 'core', 'http.js'));
const { userDataDir } = require('../src/main/core/platform');
const { configureNativeProxy } = require('../src/main/core/network-environment');
configureNativeProxy();

const ARGS = process.argv.slice(2);
const timeoutArg = (ARGS.find((a) => a.startsWith('--timeout=')) || '').split('=')[1];
const WAIT_MS = (Number(timeoutArg) > 0 ? Number(timeoutArg) : 300) * 1000;

const APP_DIR = userDataDir();
const PROFILE_DIR = path.join(os.tmpdir(), 'qk-assisted-login-profile');
const CHECK_URL = 'https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc&uc_param_str=';

/** 用真实判活接口判断这组 cookie 是否已登录。 */
async function isLoggedIn(cookies) {
  if (!cookies.length) return false;
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  try {
    const res = await fetch(CHECK_URL, {
      headers: {
        cookie: header,
        referer: 'https://pan.quark.cn/',
        origin: 'https://pan.quark.cn',
        'user-agent': DEFAULT_UA,
        accept: 'application/json, text/plain, */*',
      },
    });
    const body = await res.json().catch(() => null);
    return res.status === 200 && !!body && body.code === 0;
  } catch {
    return false;
  }
}

(async () => {
  console.log('\x1b[1m=== 辅助登录：请在弹出窗口中扫码 ===\x1b[0m\n');

  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (e) {
    console.error('未安装 playwright-core，请先执行：pnpm add -D playwright-core');
    process.exit(1);
  }

  if (!fs.existsSync(chromium.executablePath())) {
    console.error('未找到 Chromium，请先执行：node node_modules/playwright-core/cli.js install chromium');
    process.exit(1);
  }

  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, // 必须可见，才能让你看到二维码
    executablePath: chromium.executablePath(),
    args: ['--no-first-run', '--no-default-browser-check'],
    viewport: { width: 1100, height: 820 },
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://pan.quark.cn/', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('已在窗口中打开夸克网盘登录页。');
  console.log('\x1b[33m请用夸克 App 扫码，或在窗口中用手机号登录。\x1b[0m');
  console.log(`等待最多 ${Math.round(WAIT_MS / 1000)} 秒…\n`);

  const deadline = Date.now() + WAIT_MS;
  const seen = new Set();
  let cookies = [];

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let all = [];
    try {
      all = await ctx.cookies();
    } catch {
      continue;
    }
    cookies = all.filter((c) => /quark\.cn$/i.test(c.domain.replace(/^\./, '')));
    const sig = cookies.map((c) => `${c.name}:${c.value.length}`).sort().join('|');
    const changed = !seen.has(sig);
    seen.add(sig);

    if (cookies.length === 0) continue;
    if (!changed) continue; // 无变化就不浪费判活请求

    const alive = await isLoggedIn(cookies);
    process.stdout.write(
      `\r  检测到 ${cookies.length} 个 quark cookie，判活：${alive ? '\x1b[32m已登录\x1b[0m' : '\x1b[90m未登录\x1b[0m'}   `
    );
    if (alive) break;
  }

  process.stdout.write('\n');

  const okLogin = await isLoggedIn(cookies);

  if (!okLogin) {
    console.log('\n\x1b[33m登录未完成或已超时。\x1b[0m');
    await ctx.close().catch(() => {});
    process.exit(2);
  }

  // 写入本应用的加密会话存储
  const store = createSecureStore({ userDataDir: APP_DIR, requireEncryption: true });
  const session = createSession({ store }).load();
  session.setCookies(cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    expires: c.expires,
    sameSite: c.sameSite,
  })));
  session.clearExpired();
  session.save();

  // 立即用真实接口复验一次（走本应用自己的 HttpClient）
  const http = new HttpClient({ getCookie: () => session.getCookie() });
  let verified = false;
  try {
    const env = await http.get('/1/clouddrive/config', { pr: 'ucpro', fr: 'pc', uc_param_str: '' });
    verified = !!(env && env.code === 0);
  } catch {
    verified = false;
  }

  await ctx.close().catch(() => {});

  console.log(
    verified
      ? '\n\x1b[32m✓ 登录成功，会话已写入并通过真实接口复验。\x1b[0m'
      : '\n\x1b[31m✗ Cookie 已写入，但真实接口复验未通过。\x1b[0m'
  );
  console.log(`\x1b[90m会话文件：${path.join(APP_DIR, 'session.bin')}\x1b[0m`);
  console.log(verified ? '\n现在可以运行真实端到端验证：\n\n    npm run e2e\n' : '');

  process.exit(verified ? 0 : 3);
})().catch((e) => {
  console.error('\x1b[31m执行出错：\x1b[0m', e && e.message ? e.message : e);
  process.exit(1);
});
