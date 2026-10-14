'use strict';
/**
 * 验证大文件并行分片下载（真实账号）。
 *
 * 目标：触发 >8MB 的并行分片路径（8MB/片、4 连接并发），
 * 校验最终文件与云端大小一致，且并发峰值确实 >1（证明真的并行了）。
 *
 * 用法（在真实 Electron 主进程内运行）：
 *   electron tools/verify-parallel-dl
 */
const { app } = require('electron');
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
  const { createFilesApi } = require(path.join(S, 'core', 'api-files.js'));
  const { createTransferApi } = require(path.join(S, 'core', 'api-transfer.js'));
  const { downloadFile } = require(path.join(S, 'core', 'download.js'));

  const real = path.join(process.env.APPDATA || '', 'quark-mini');
  const ud = app.getPath('userData');
  fs.mkdirSync(ud, { recursive: true });
  fs.copyFileSync(path.join(real, 'session.bin'), path.join(ud, 'session.bin'));

  const store = createSecureStore({ userDataDir: ud, requireEncryption: true });
  const s = createSession({ store }).load();
  console.log('\x1b[1m=== 大文件并行分片下载验证（真实账号）===\x1b[0m');
  console.log('已登录:', s.isLoggedIn(), ' 会话 Cookie:', s.getCookie().split('; ').filter(Boolean).length, '个');
  if (!s.isLoggedIn()) { console.log('未登录，请先 npm run login'); app.exit(2); return; }

  // 拦截 fetch，统计并发与分片请求
  const orig = globalThis.fetch;
  const stats = { peak: 0, active: 0, partReqs: [], totalReqs: 0 };
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u);
    const isCdn = !url.includes('drive-pc.quark.cn');
    if (isCdn) {
      stats.totalReqs += 1;
      if (init.headers && init.headers.range && init.headers.range !== 'bytes=0-0') {
        stats.partReqs.push(init.headers.range);
        stats.active += 1;
        stats.peak = Math.max(stats.peak, stats.active);
      }
    }
    try {
      const r = await orig(u, init);
      return r;
    } finally {
      if (isCdn && init.headers && init.headers.range && init.headers.range !== 'bytes=0-0') {
        stats.active -= 1;
      }
    }
  };

  const http = new HttpClient({ getCookie: () => s.getCookie() });
  const fApi = createFilesApi({ http });
  const tApi = createTransferApi({ http });

  // 找一个 >8MB 的文件
  const l = await fApi.list({ pdirFid: '0', page: 1, size: 200 });
  const big = (l.list || []).filter((x) => !x.dir && x.size > 8 * 1024 * 1024)
    .sort((a, b) => b.size - a.size)[0];
  if (!big) {
    console.log('\n\x1b[33m根目录没有 >8MB 的文件，无法触发并行分片路径。\x1b[0m');
    console.log('  根目录文件:');
    (l.list || []).filter((x) => !x.dir).forEach((x) => console.log(`    - ${x.name} (${(x.size / 1024 / 1024).toFixed(2)} MB)`));
    globalThis.fetch = orig;
    app.exit(2);
    return;
  }

  console.log(`\n选定大文件: ${big.name}  ${(big.size / 1024 / 1024).toFixed(2)} MB  (fid=${big.fid})`);
  console.log(`理论分片数: ${Math.ceil(big.size / (8 * 1024 * 1024))} 片（8 MB/片）\n`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-pardl-'));
  const t0 = Date.now();
  try {
    const r = await downloadFile({
      fid: big.fid,
      fileName: big.name,
      localDir: dir,
      http,
      api: tApi,
      size: big.size,
      parallel: 4,
      // 保持默认阈值（8MB），让真实条件决定路径
    });
    const cost = (Date.now() - t0) / 1000;

    expect(r.multipart === true, '走了并行分片路径', `multipart=${r.multipart} bytes=${r.bytes}`);
    const files = fs.readdirSync(dir).filter((n) => !n.includes('.qkdownloading'));
    const got = files.length ? path.join(dir, files[0]) : null;
    expect(!!got, '本地已生成文件', got ? path.basename(got) : '未找到');
    if (got) {
      const size = fs.statSync(got).size;
      expect(size === big.size, '下载大小与云端一致', `本地=${size} 云端=${big.size}`);
      console.log(`  \x1b[90m耗时 ${cost.toFixed(1)}s，平均 ${(size / 1024 / 1024 / cost).toFixed(2)} MB/s\x1b[0m`);
    }
    expect(stats.partReqs.length >= 2, '确实发起多个分片 Range 请求', `${stats.partReqs.length} 个`);
    expect(stats.peak >= 2, '分片请求真的并发执行', `并发峰值 ${stats.peak}`);
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.qkdownloading'));
    expect(leftovers.length === 0, '无残留临时文件', leftovers.join(', ') || '无');
  } catch (e) {
    bad('大文件下载', `code=${e.code} http=${e.httpStatus} msg=${e.message}${e.raw ? '\n      raw=' + String(e.raw).slice(0, 300) : ''}`);
  }

  globalThis.fetch = orig;
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n\x1b[1m=== 结果：${pass} 通过 / ${fail} 失败 ===\x1b[0m`);
  if (fail) failures.forEach((f) => console.log(`  · ${f.n}${f.d ? ': ' + f.d : ''}`));
  app.exit(fail ? 1 : 0);
});
