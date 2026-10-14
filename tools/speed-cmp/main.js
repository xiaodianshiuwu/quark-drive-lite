'use strict';
/**
 * 对比：同一大文件，串行（parallel=1） vs 并行（parallel=4）的下载速度。
 * 用于确认并行分片是否真的带来提速，以及该账号的实际带宽上限。
 */
const { app } = require('electron');
require('../../src/main/core/browser-storage').configureBrowserStorage(app);
const path = require('path');
const fs = require('fs');
const os = require('os');

const S = path.join(__dirname, '..', '..', 'src', 'main');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const { createSecureStore } = require(path.join(S, 'core', 'secure-store.js'));
  const { createSession } = require(path.join(S, 'core', 'session.js'));
  const { HttpClient } = require(path.join(S, 'core', 'http.js'));
  const { createFilesApi } = require(path.join(S, 'core', 'api-files.js'));
  const { createTransferApi } = require(path.join(S, 'core', 'api-transfer.js'));
  const { downloadFile } = require(path.join(S, 'core', 'download.js'));

  const real = require('../../src/main/core/platform').userDataDir();
  const ud = app.getPath('userData');
  fs.mkdirSync(ud, { recursive: true });
  if (path.resolve(real) === path.resolve(ud)) throw Error('验收目录不能覆盖真实用户目录');
  fs.copyFileSync(path.join(real, 'session.bin'), path.join(ud, 'session.bin'));
  if (fs.existsSync(path.join(real, 'session.key'))) fs.copyFileSync(path.join(real, 'session.key'), path.join(ud, 'session.key'));
  if (process.platform !== 'win32' && fs.existsSync(path.join(ud, 'session.key'))) fs.chmodSync(path.join(ud, 'session.key'), 0o600);

  const store = createSecureStore({ userDataDir: ud, requireEncryption: true });
  const s = createSession({ store }).load();
  const http = new HttpClient({ getCookie: () => s.getCookie() });
  const fApi = createFilesApi({ http });
  const tApi = createTransferApi({ http });

  console.log('\x1b[1m=== 并行 vs 串行 下载速度对比（真实账号）===\x1b[0m');

  // 选一个中等大小文件，避免测太久
  const l = await fApi.list({ pdirFid: '0', page: 1, size: 200 });
  const all = (l.list || []).filter((x) => !x.dir && x.size > 8 * 1024 * 1024).sort((a, b) => a.size - b.size);
  const target = all[0];
  if (!target) { console.log('没有 >8MB 的文件'); app.exit(2); return; }

  console.log(`文件: ${target.name}  ${(target.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`（为避免耗时过长，取最小的 >8MB 文件）\n`);

  async function run(parallel, tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qk-cmp-${parallel}-`));
    const t0 = Date.now();
    let result = null;
    try {
      const r = await downloadFile({
        fid: target.fid, fileName: target.name, localDir: dir, http, api: tApi,
        size: target.size, parallel,
      });
      const cost = (Date.now() - t0) / 1000;
      const files = fs.readdirSync(dir).filter((n) => !n.includes('.qkdownloading'));
      const size = files.length ? fs.statSync(path.join(dir, files[0])).size : 0;
      const speed = size / 1024 / 1024 / cost;
      result = { ok: size === target.size, cost, size, speed, multipart: r.multipart };
      console.log(
        `  ${tag.padEnd(14)} parallel=${parallel}  耗时 ${cost.toFixed(1)}s  ` +
        `速度 ${speed.toFixed(2)} MB/s  大小校验 ${size === target.size ? '✓' : '✗'}  multipart=${r.multipart}`
      );
    } catch (e) {
      console.log(`  ${tag.padEnd(14)} parallel=${parallel}  ✗ ${e.code} ${e.message}`);
      result = { ok: false };
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }

  const serial = await run(1, '串行');
  const par = await run(4, '并行');

  console.log('\n=== 结论 ===');
  if (serial.ok && par.ok) {
    const ratio = par.speed / serial.speed;
    console.log(`  并行/串行 速度比: ${ratio.toFixed(2)}x`);
    if (ratio > 1.15) {
      console.log('  → 并行分片确实带来提速 ✓');
    } else {
      console.log('  → 提速不明显，说明瓶颈在服务端限速/带宽，而非并发数');
      console.log(`     该账号实际下载速度上限约 ${Math.max(serial.speed, par.speed).toFixed(2)} MB/s`);
    }
  } else {
    console.log('  有失败项，无法比较');
  }

  app.exit(0);
});
