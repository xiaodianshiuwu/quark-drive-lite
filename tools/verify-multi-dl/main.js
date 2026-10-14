'use strict';
/**
 * 验证多文件并发下载（真实账号）。
 *
 * 回应「多文件下载需求」：验证同时提交多个下载任务时，
 *   1. 任务队列真的并发执行（而非串行）
 *   2. 每个文件都完整下载成功（大小与云端一致）
 *   3. 无残留临时文件
 *
 * 走 UI 真实路径（modules/transfer.js），不是直接调底层引擎。
 */
const { app } = require('electron');
require('../../src/main/core/browser-storage').configureBrowserStorage(app);
const path = require('path');
const fs = require('fs');
const os = require('os');

const S = path.join(__dirname, '..', '..', 'src', 'main');
app.on('window-all-closed', () => {});

let pass = 0, fail = 0;
const failures = [];
function ok(n, d) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); }
function bad(n, d) { fail += 1; failures.push({ n, d }); console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `\n      ${d}` : ''}`); }
const expect = (c, n, d) => (c ? ok(n, d) : bad(n, d));

app.whenReady().then(async () => {
  const { createSecureStore } = require(path.join(S, 'core', 'secure-store.js'));
  const { createSession } = require(path.join(S, 'core', 'session.js'));
  const { HttpClient } = require(path.join(S, 'core', 'http.js'));
  const { createFsModule } = require(path.join(S, 'modules', 'fs.js'));
  const { createTransferModule } = require(path.join(S, 'modules', 'transfer.js'));

  const real = require('../../src/main/core/platform').userDataDir();
  const ud = app.getPath('userData');
  fs.mkdirSync(ud, { recursive: true });
  if (path.resolve(real) === path.resolve(ud)) throw Error('验收目录不能覆盖真实用户目录');
  fs.copyFileSync(path.join(real, 'session.bin'), path.join(ud, 'session.bin'));
  if (fs.existsSync(path.join(real, 'session.key'))) fs.copyFileSync(path.join(real, 'session.key'), path.join(ud, 'session.key'));
  if (process.platform !== 'win32' && fs.existsSync(path.join(ud, 'session.key'))) fs.chmodSync(path.join(ud, 'session.key'), 0o600);

  const store = createSecureStore({ userDataDir: ud, requireEncryption: true });
  const session = createSession({ store }).load();

  console.log('\x1b[1m=== 多文件并发下载验证（真实账号）===\x1b[0m');
  console.log('已登录:', session.isLoggedIn(), ' Cookie:', session.getCookie().split('; ').filter(Boolean).length, '个');
  if (!session.isLoggedIn()) { console.log('未登录，请先 npm run login'); app.exit(2); return; }

  // 拦截 fetch 统计并发
  const orig = globalThis.fetch;
  const st = { peak: 0, active: 0, reqs: 0 };
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u);
    const isCdn = !url.includes('drive-pc.quark.cn');
    if (isCdn) {
      st.reqs += 1;
      st.active += 1;
      st.peak = Math.max(st.peak, st.active);
    }
    try { return await orig(u, init); }
    finally { if (isCdn) st.active -= 1; }
  };

  const http = new HttpClient({
    getCookie: () => session.getCookie(),
    onSetCookie: (sc) => { session.applySetCookie(sc); session.save(); },
  });
  const fsMod = createFsModule({ http });

  const downDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-multidl-'));
  const transfer = createTransferModule({
    http,
    fsModule: fsMod,
    getDownloadDir: () => downDir,
    getConcurrency: () => ({ upload: 2, download: 3, downloadParallel: 4, uploadPartConcurrency: 2 }),
    onUpdate: () => {},
    onError: (e, t) => { console.log('    任务错误:', t && t.name, '→', e && e.message); },
  });

  // 选较小的文件，避免下载过久
  const l = await fsMod.list({ pdirFid: '0', page: 1, size: 100 });
  const files = (l.list || [])
    .filter((x) => !x.dir && x.size > 0 && x.size < 6 * 1024 * 1024)
    .slice(0, 3);

  if (files.length < 2) {
    console.log('\n\x1b[33m可下载的小文件不足 2 个，无法验证多文件并发。\x1b[0m');
    globalThis.fetch = orig;
    fs.rmSync(downDir, { recursive: true, force: true });
    app.exit(2);
    return;
  }

  console.log(`\n待下载 ${files.length} 个文件:`);
  files.forEach((f) => console.log(`  - ${f.name} (${(f.size / 1024).toFixed(0)} KB)`));

  const t0 = Date.now();
  const ids = transfer.download({
    fids: files.map((f) => f.fid),
    localDir: downDir,
    names: files.map((f) => f.name),
  });

  expect(Array.isArray(ids) && ids.length === files.length,
    'download() 立即返回全部任务 id（不阻塞）', `${ids.length} 个`);

  // 轮询等待全部结束
  const deadline = Date.now() + 600000;
  let tasks = [];
  for (;;) {
    const all = transfer.list();
    tasks = ids.map((id) => all.find((t) => t.id === id)).filter(Boolean);
    if (tasks.length === ids.length &&
        tasks.every((t) => t.status === 'done' || t.status === 'error' || t.status === 'canceled')) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const cost = (Date.now() - t0) / 1000;
  const done = tasks.filter((t) => t.status === 'done');
  expect(done.length === files.length, '全部文件下载完成',
    `完成 ${done.length}/${files.length}，耗时 ${cost.toFixed(1)}s`);
  tasks.forEach((t) => {
    if (t.status !== 'done') console.log(`    ${t.name}: status=${t.status} err=${t.error}`);
  });

  // 逐个校验大小
  const got = fs.readdirSync(downDir).filter((n) => !n.includes('.qkdownloading'));
  console.log(`\n本地文件: ${got.join(', ') || '(空)'}`);
  for (const f of files) {
    const target = path.join(downDir, f.name);
    if (fs.existsSync(target)) {
      const size = fs.statSync(target).size;
      expect(size === f.size, `${f.name} 大小与云端一致`, `本地=${size} 云端=${f.size}`);
    } else {
      const base = f.name.replace(/\.[^.]+$/, '');
      const alt = got.find((n) => n.startsWith(base));
      if (alt) {
        const size = fs.statSync(path.join(downDir, alt)).size;
        expect(size === f.size, `${f.name} 大小一致（避让改名 ${alt}）`, `本地=${size} 云端=${f.size}`);
      } else {
        bad(`${f.name} 未下载`, '本地找不到该文件');
      }
    }
  }

  expect(st.peak >= 2, '多文件下载确实并发执行', `CDN 请求并发峰值 ${st.peak}`);

  const leftovers = fs.readdirSync(downDir).filter((n) => n.includes('.qkdownloading'));
  expect(leftovers.length === 0, '无残留临时文件', leftovers.join(', ') || '无');

  globalThis.fetch = orig;
  fs.rmSync(downDir, { recursive: true, force: true });

  console.log(`\n\x1b[1m=== 结果：${pass} 通过 / ${fail} 失败 ===\x1b[0m`);
  if (fail) failures.forEach((f) => console.log(`  · ${f.n}${f.d ? ': ' + f.d : ''}`));
  app.exit(fail ? 1 : 0);
});
