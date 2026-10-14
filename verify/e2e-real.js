'use strict';
/**
 * 真实端到端验证（E2E）—— 在**真实 Electron 应用**内、对**真实夸克账号**跑完整链路。
 *
 * 这是唯一能消除"上传/下载从未真实执行过"这一风险的手段。
 * 它不做任何打桩：所有请求都真的打到夸克服务器。
 *
 * 覆盖链路（按破坏性从小到大排列，任一步失败即停止，避免留下垃圾数据）：
 *   0. 登录态校验（未登录则明确提示，不会伪造成功）
 *   1. 读取根目录（分页）
 *   2. 新建测试目录
 *   3. 本地生成测试文件 → **真实上传**
 *   4. 列出目录，确认文件存在且**大小一致**
 *   5. 搜索刚上传的文件
 *   6. 重命名
 *   7. 复制到另一目录
 *   8. **真实下载** → 校验字节与源文件完全一致（含断点续传能力已由单测覆盖）
 *   9. 批量删除（清理）
 *  10. 确认清理干净（回滚验证）
 *
 * 用法：
 *   npm run e2e              # 真实跑；未登录会明确失败并提示如何登录
 *   npm run e2e -- --keep    # 保留测试文件（排错用）
 *   npm run e2e -- --root=<fid>   # 指定在哪个目录下做测试（默认根目录）
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const PORT = 9788;
const ARGS = process.argv.slice(2);
const KEEP = ARGS.includes('--keep');
const ROOT_FID_ARG = (ARGS.find((a) => a.startsWith('--root=')) || '').split('=')[1] || '0';

const electronPath = (() => {
  try {
    const p = require('electron');
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {
    /* fallthrough */
  }
  const f = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(f) ? f : null;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

function ok(name, detail) {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
function bad(name, detail) {
  fail += 1;
  failures.push({ name, detail });
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
}
function skip(name, why) {
  skipped += 1;
  console.log(`  \x1b[33m↷\x1b[0m ${name}  \x1b[90m(${why})\x1b[0m`);
}
function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/** 断言辅助 */
function expect(cond, name, detail) {
  if (cond) ok(name, detail);
  else bad(name, detail);
  return !!cond;
}

async function waitForDevtools(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) {
        const list = await r.json();
        const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
        if (page) return page;
      }
    } catch {
      /* not up */
    }
    await sleep(400);
  }
  throw new Error('未连接到应用窗口');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
        }
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 失败')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression, timeoutMs = 300000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: timeoutMs,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || '页面内异常');
    }
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 在页面里注入一个 E2E 助手（仅使用 window.qk，与 UI 走同一条路径）。 */
const HELPER = `
window.__E2E__ = {
  // 用 UI 同款桥调用，失败时把 code/message 一起抛出来
  async call(ns, fn, arg) {
    const f = window.qk && window.qk[ns] && window.qk[ns][fn];
    if (typeof f !== 'function') throw new Error('桥方法缺失: ' + ns + '.' + fn);
    try { return await f(arg); }
    catch (e) { const err = new Error((e && e.message) || String(e)); err.code = e && e.code; throw err; }
  },
  async status() { return window.qk.auth.status(); },
  async quota() { return window.qk.auth.quota(); },
  async userInfo() { return window.qk.auth.getUserInfo(); },
  async list(fid, page, size) { return this.call('fs','list',{ pdirFid: fid||'0', page: page||1, size: size||50 }); },
  async search(kw) { return this.call('fs','search',{ keyword: kw, page:1, size:50 }); },
  async mkdir(fid, name) { return this.call('fs','mkdir',{ pdirFid: fid||'0', name }); },
  async rename(fid, name) { return this.call('fs','rename',{ fid, name }); },
  async move(fids, to) { return this.call('fs','move',{ fids, toFid: to }); },
  async copy(fids, to) { return this.call('fs','copy',{ fids, toFid: to }); },
  async remove(fids) { return this.call('fs','remove',{ fids }); },
  async upload(localPaths, pdirFid) { return this.call('transfer','upload',{ localPaths, pdirFid }); },
  async download(fids, localDir, names) { return this.call('transfer','download',{ fids, localDir, names }); },
  async tasks() { return this.call('transfer','list'); },
  // 轮询任务直到终态
  async waitTasks(ids, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 180000);
    for (;;) {
      const all = await this.call('transfer','list');
      const mine = all.filter(t => ids.indexOf(t.id) >= 0);
      if (mine.length === ids.length && mine.every(t => t.status==='done'||t.status==='error'||t.status==='canceled')) return mine;
      if (Date.now() > deadline) return mine.map(t => ({ ...t, __timeout: true }));
      await new Promise(r => setTimeout(r, 500));
    }
  },
  async settings() { return window.qk.settings.get(); },
  async setDownloadDir(d) { return window.qk.settings.set({ downloadDir: d }); },
};
'ok';
`;

(async () => {
  console.log('\x1b[1m=== 真实端到端验证（真实账号 · 真实上传下载）===\x1b[0m');

  if (!electronPath) {
    console.error('未找到 Electron，请先安装');
    process.exit(1);
  }

  // 测试沙箱目录：本地文件都放这里，便于清理
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-e2e-'));
  const downDir = path.join(workDir, 'downloaded');
  fs.mkdirSync(downDir, { recursive: true });

  // 生成一个**跨分片**的测试文件：略大于 1MB，足以触发多分片上传路径
  const PAYLOAD_SIZE = 8 * 1024 * 1024 + 12345;
  const payload = Buffer.alloc(PAYLOAD_SIZE);
  // 每次生成不同内容，避免全局去重秒传绕开真实 OSS 多分片链路。
  require('crypto').randomFillSync(payload);
  const localFile = path.join(workDir, 'qk-e2e-测试文件.bin');
  fs.writeFileSync(localFile, payload);
  const srcMd5 = require('crypto').createHash('md5').update(payload).digest('hex');

  // 关键：E2E 用独立的临时 userData 启动，否则会污染真实用户数据。
  // 但登录态保存在真实 userData 里，因此必须把它复制过来，否则应用读不到会话。
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-e2e-ud-'));
  const realUserData = path.join(process.env.APPDATA || '', 'quark-mini');
  const realSession = path.join(realUserData, 'session.bin');
  let sessionCopied = false;
  if (fs.existsSync(realSession)) {
    try {
      // Electron 加密依赖该 profile 的 Local State 密钥，复制密文无法跨 profile 解密。
      const { createSecureStore } = require('../src/main/core/secure-store');
      const source = createSecureStore({ userDataDir: realUserData, requireEncryption: true });
      const destination = createSecureStore({ userDataDir: userData, requireEncryption: true });
      const snapshot = {};
      for (const key of ['cookies', 'expired', 'account', 'savedAt', 'settings']) {
        const value = source.getItem(key);
        if (value !== null) snapshot[key] = value;
      }
      destination.setItems(snapshot);
      sessionCopied = true;
    } catch (e) {
      console.log(`\x1b[33m警告：无法复制登录态（${e.message}）\x1b[0m`);
    }
  }
  if (!sessionCopied) {
    console.log(
      '\n\x1b[33m未找到已保存的登录态。\x1b[0m请先登录：\n\n' +
        '    npm run login        # 弹出窗口扫码\n' +
        '    npm run import-session  # 或从浏览器导入\n'
    );
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const child = spawn(electronPath, [root, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  let cdp = null;
  const created = { dirs: [], files: [] }; // 记录创建物，最后清理

  try {
    const page = await waitForDevtools(PORT);
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await sleep(2000);
    await cdp.eval(HELPER);
    ok('应用已启动且桥可用');

    // ---------------------------------------------------------------------
    section('0. 登录态');
    // ---------------------------------------------------------------------
    let st = await cdp.eval('window.__E2E__.status()');
    if (!st.loggedIn) {
      console.log(
        '\n\x1b[33m未检测到有效的夸克登录态。\x1b[0m\n' +
          '真实 E2E 需要登录后才能执行。请先运行应用并完成登录：\n\n' +
          '    npm start\n\n' +
          '点击界面右上角「登录」，在弹出的窗口里扫码登录。登录成功后 Cookie 会被加密保存，\n' +
          '之后再次运行 `npm run e2e` 即可自动复用该登录态（免扫码）。\n'
      );
      skip('后续所有真实链路', '未登录');
      throw { __needLogin: true };
    }
    ok('已登录', `userId=${st.userId || '(未知)'} expired=${st.expired}`);

    // 顺手验证"已登录时 verify 不报失效"
    const verifyRes = await cdp
      .eval('(async()=>{try{await window.qk.auth.verify();return {ok:true}}catch(e){return {ok:false,code:e.code,msg:e.message}}})()');
    expect(verifyRes.ok, 'auth.verify() 在已登录状态下成功', verifyRes.ok ? '' : JSON.stringify(verifyRes));

    // ---------------------------------------------------------------------
    section('1. 目录浏览（分页）');
    // ---------------------------------------------------------------------
    const page1 = await cdp.eval(`window.__E2E__.list(${JSON.stringify(ROOT_FID_ARG)}, 1, 20)`);
    expect(Array.isArray(page1.list), 'list() 返回列表', `共 ${page1.list.length} 项, total=${page1.total}`);
    expect(page1.page === 1 && page1.size === 20, '分页元信息正确', `page=${page1.page} size=${page1.size} hasMore=${page1.hasMore}`);
    if (page1.list.length) {
      const it = page1.list[0];
      expect(
        typeof it.fid === 'string' && typeof it.name === 'string' && typeof it.dir === 'boolean' && typeof it.size === 'number',
        '文件记录字段类型正确（fid/name/dir/size）',
        `样例: ${JSON.stringify({ fid: it.fid, name: it.name, dir: it.dir, size: it.size })}`
      );
      expect(!/&(amp|lt|gt|quot|#39);/.test(it.name), '文件名已做 HTML 实体反转义', `name=${it.name}`);
    } else {
      skip('文件记录字段校验', '根目录为空');
    }

    const crumbs = await cdp.eval(`window.__E2E__.call('fs','crumbs', ${JSON.stringify(ROOT_FID_ARG)})`);
    expect(Array.isArray(crumbs) && crumbs.length >= 1, 'crumbs() 返回路径链', crumbs.map((c) => c.name).join(' / '));

    // ---------------------------------------------------------------------
    section('2. 新建目录（真实写操作）');
    // ---------------------------------------------------------------------
    const stamp = Date.now();
    const dirName = `qk-e2e-${stamp}`;
    const copyDirName = `qk-e2e-copy-${stamp}`;

    await cdp.eval(`window.__E2E__.mkdir(${JSON.stringify(ROOT_FID_ARG)}, ${JSON.stringify(dirName)})`);
    await sleep(1200); // 服务端有最终一致性，稍等再列
    let listing = await cdp.eval(`window.__E2E__.list(${JSON.stringify(ROOT_FID_ARG)}, 1, 200)`);
    let dirItem = listing.list.find((x) => x.name === dirName && x.dir);
    expect(!!dirItem, '新建目录已出现在列表中', dirItem ? `fid=${dirItem.fid}` : '未找到');
    if (!dirItem) throw new Error('新建目录未出现，无法继续');
    created.dirs.push(dirItem.fid);

    await cdp.eval(`window.__E2E__.mkdir(${JSON.stringify(ROOT_FID_ARG)}, ${JSON.stringify(copyDirName)})`);
    await sleep(1200);
    listing = await cdp.eval(`window.__E2E__.list(${JSON.stringify(ROOT_FID_ARG)}, 1, 200)`);
    const copyDirItem = listing.list.find((x) => x.name === copyDirName && x.dir);
    expect(!!copyDirItem, '第二个目录（用于复制）已创建', copyDirItem ? `fid=${copyDirItem.fid}` : '未找到');
    if (copyDirItem) created.dirs.push(copyDirItem.fid);

    // ---------------------------------------------------------------------
    section('3. 真实上传');
    // ---------------------------------------------------------------------
    const fileName = path.basename(localFile);
    console.log(`  \x1b[90m上传 ${fileName}（${(PAYLOAD_SIZE / 1024).toFixed(1)} KB, md5=${srcMd5.slice(0, 8)}…）\x1b[0m`);
    const upIds = await cdp.eval(
      `window.__E2E__.upload([${JSON.stringify(localFile)}], ${JSON.stringify(dirItem.fid)})`
    );
    expect(Array.isArray(upIds) && upIds.length === 1, 'upload() 立即返回任务 id', `id=${upIds[0]}`);
    const upTasks = await cdp.eval(`window.__E2E__.waitTasks(${JSON.stringify(upIds)}, 240000)`);
    const upTask = upTasks[0] || {};

    const uploadOk = upTask.status === 'done';
    if (uploadOk) {
      ok('上传任务完成', `size=${upTask.size}`);
    } else if (upTask.errorCode === 'NO_SPACE' || /容量不足/.test(upTask.error || '')) {
      skip('真实上传', `账号容量不足：${upTask.error || ''}`);
      console.log(
        '  \x1b[33m说明：该账号已超出容量上限，服务端拒绝写入。这属于账号状态，不是程序缺陷。\x1b[0m\n' +
          '        为安全起见，后续「重命名 / 移动 / 删除」等破坏性用例将被跳过——\n' +
          '        它们必须作用在本次测试自己创建的文件上，绝不能碰你已有的文件。\n' +
          '        仍会继续验证不破坏数据的链路：搜索、复制副本、下载。'
      );
    } else {
      bad('上传任务完成', `status=${upTask.status} error=${upTask.error || '-'} code=${upTask.errorCode || '-'}`);
    }

    await sleep(1500);
    let dirListing = await cdp.eval(`window.__E2E__.list(${JSON.stringify(dirItem.fid)}, 1, 100)`);
    let upItem = dirListing.list.find((x) => x.name === fileName && !x.dir);
    if (uploadOk && upItem) {
      created.files.push(upItem.fid);
      expect(upItem.size === PAYLOAD_SIZE, '云端文件大小与本地一致', `云端=${upItem.size} 本地=${PAYLOAD_SIZE}`);
    }

    // ---------------------------------------------------------------------
    section('4. 搜索（只读）');
    // ---------------------------------------------------------------------
    // 实测结论（真实账号，2026-10）：
    //   · `q` 是唯一被服务端识别的关键字参数；keyword/_keyword/key/file_name/query 均被忽略
    //     （它们会返回根目录默认列表，看起来"有结果"实际是假的）。
    //   · 搜索匹配的是**文件名**（支持前缀/模糊匹配），不匹配目录名。
    // 因此这里用一个确定存在的**文件名前缀**做关键词，避免误判。
    const searchKw = fileName;
    try {
      const sr = await cdp.eval(`window.__E2E__.search(${JSON.stringify(searchKw)})`);
      const list = sr.list || [];
      expect(list.length > 0, '搜索返回结果', `关键词 "${searchKw}" 命中 ${list.length} 项`);
      const ours = list.filter((x) => upItem && x.fid === upItem.fid);
      expect(ours.length > 0, '搜索结果确实包含本次测试创建的项目',
        `其中 ${ours.length} 项为本次上传的精确 fid`);
    } catch (e) {
      bad('搜索', `失败：${e.message}`);
    }

    // ---------------------------------------------------------------------
    // 以下为破坏性用例，**仅当上传成功（即存在我们自己的文件）时才执行**
    // ---------------------------------------------------------------------
    if (!uploadOk || !upItem) {
      skip('重命名 / 复制 / 移动 / 批量删除', '没有本次测试自己创建的文件，为保护你的数据而跳过');

      // 仍验证「复制副本后下载」这条不破坏原文件的链路
      await verifyDownloadOnly(cdp, dirListing, dirItem, downDir, copyDirItem);
      throw { __earlyExit: true };
    }

    // ---------------------------------------------------------------------
    section('5. 重命名（仅作用于本次上传的文件）');
    // ---------------------------------------------------------------------
    const renamed = `qk-e2e-renamed-${stamp}.bin`;
    await cdp.eval(`window.__E2E__.rename(${JSON.stringify(upItem.fid)}, ${JSON.stringify(renamed)})`);
    await sleep(1200);
    dirListing = await cdp.eval(`window.__E2E__.list(${JSON.stringify(dirItem.fid)}, 1, 100)`);
    const renamedItem = dirListing.list.find((x) => x.fid === upItem.fid);
    expect(renamedItem && renamedItem.name === renamed, '重命名生效',
      renamedItem ? `现名=${renamedItem.name}` : '未找到该 fid');
    if (renamedItem) upItem = renamedItem;

    // ---------------------------------------------------------------------
    section('6. 复制（本次文件 → 第二个测试目录）');
    // ---------------------------------------------------------------------
    let copied = null;
    if (copyDirItem) {
      await cdp.eval(`window.__E2E__.copy([${JSON.stringify(upItem.fid)}], ${JSON.stringify(copyDirItem.fid)})`);
      await sleep(4000);
      const copyListing = await cdp.eval(`window.__E2E__.list(${JSON.stringify(copyDirItem.fid)}, 1, 100)`);
      copied = copyListing.list.find((x) => x.name === renamed);
      expect(!!copied, '复制到目标目录成功',
        copied ? `fid=${copied.fid} size=${copied.size}` : `目标目录 ${copyListing.list.length} 项，未找到`);
      if (copied) {
        created.files.push(copied.fid);
        expect(copied.size === PAYLOAD_SIZE, '复制件大小与原文件一致', `${copied.size}`);
      }
    } else {
      skip('复制', '目标目录未创建成功');
    }

    // ---------------------------------------------------------------------
    section('7. 真实下载 + 字节级校验');
    // ---------------------------------------------------------------------
    await cdp.eval(`window.__E2E__.setDownloadDir(${JSON.stringify(downDir)})`);
    const dlIds = await cdp.eval(
      `window.__E2E__.download([${JSON.stringify(upItem.fid)}], ${JSON.stringify(downDir)}, [${JSON.stringify(renamed)}])`
    );
    expect(Array.isArray(dlIds) && dlIds.length === 1, 'download() 立即返回任务 id', `id=${dlIds[0]}`);
    const dlTasks = await cdp.eval(`window.__E2E__.waitTasks(${JSON.stringify(dlIds)}, 300000)`);
    const dlTask = dlTasks[0] || {};
    expect(dlTask.status === 'done', '下载任务完成',
      `status=${dlTask.status} error=${dlTask.error || '-'} code=${dlTask.errorCode || '-'}`);
    if (dlTask.status !== 'done') {
      throw new Error(`下载失败：${dlTask.error || '未知'}（code=${dlTask.errorCode}）`);
    }

    const downloaded = findFileByNames(downDir, [renamed]);
    expect(!!downloaded, '本地已生成下载文件',
      downloaded ? path.basename(downloaded) : `目录内容: ${fs.readdirSync(downDir).join(', ')}`);
    if (downloaded) {
      const got = fs.readFileSync(downloaded);
      const gotMd5 = require('crypto').createHash('md5').update(got).digest('hex');
      expect(got.length === PAYLOAD_SIZE, '下载文件大小与源文件一致', `下载=${got.length} 源=${PAYLOAD_SIZE}`);
      expect(gotMd5 === srcMd5, '下载文件 MD5 与源文件完全一致（内容无损坏）',
        `下载=${gotMd5.slice(0, 12)} 源=${srcMd5.slice(0, 12)}`);
    }
    const leftovers = fs.readdirSync(downDir).filter((n) => n.includes('.qkdownloading'));
    expect(leftovers.length === 0, '下载完成后无残留临时文件', leftovers.join(', ') || '无残留');

    // ---------------------------------------------------------------------
    section('8. 移动（本次文件 → 第二个测试目录）');
    // ---------------------------------------------------------------------
    if (copyDirItem && copied) {
      try {
        // 复制件已占用原名称。使用独立名称测试移动，再按 fid 检查源/目标，
        // 不能假设服务端允许两个同名文件，也不能只靠文件名判断移动完成。
        const movedName = `qk-e2e-moved-${stamp}.bin`;
        await cdp.eval(`window.__E2E__.rename(${JSON.stringify(upItem.fid)}, ${JSON.stringify(movedName)})`);
        await cdp.eval(`window.__E2E__.move([${JSON.stringify(upItem.fid)}], ${JSON.stringify(copyDirItem.fid)})`);
        await sleep(2500);
        const movedListing = await cdp.eval(`window.__E2E__.list(${JSON.stringify(copyDirItem.fid)}, 1, 100)`);
        const moved = movedListing.list.find((x) => x.fid === upItem.fid && x.name === movedName);
        expect(!!moved, '移动后目标目录出现原文件 fid', moved ? '精确 fid 与名称匹配' : '未找到原文件');
        const sourceListing = await cdp.eval(`window.__E2E__.list(${JSON.stringify(dirItem.fid)}, 1, 100)`);
        expect(!sourceListing.list.some(x=>x.fid===upItem.fid), '移动后源目录不再含原文件 fid');
      } catch (e) {
        bad('移动', `失败：${e.message}`);
      }
    } else {
      skip('移动', '缺少可移动的测试文件');
    }

    // ---------------------------------------------------------------------
    section('9. 批量删除与清理');
    // ---------------------------------------------------------------------
    if (KEEP) {
      skip('删除清理', '指定了 --keep，保留测试数据');
      console.log(`  \x1b[33m提醒：请在夸克网盘中手动清理 ${dirName} / ${copyDirName}\x1b[0m`);
    } else {
      await cleanup(cdp, created, ROOT_FID_ARG, [dirName, copyDirName]);
      await sleep(2500);
      const finalListing = await cdp.eval(`window.__E2E__.list(${JSON.stringify(ROOT_FID_ARG)}, 1, 200)`);
      const remainDirs = finalListing.list.filter((x) => x.name === dirName || x.name === copyDirName);
      expect(remainDirs.length === 0, '测试目录已清理干净（回滚验证）',
        remainDirs.length ? `仍存在: ${remainDirs.map((d) => d.name).join(', ')}` : '已清空');
    }
  } catch (e) {
    if (!e || (!e.__needLogin && !e.__earlyExit)) {
      bad('E2E 执行中断', e && e.message ? e.message : String(e));
    }
  } finally {
    if (cdp) cdp.close();
    await sleep(300);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(500);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n\x1b[1m=== E2E 结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过 ===\x1b[0m`);
  if (fail) {
    console.log('\n\x1b[31m失败详情：\x1b[0m');
    for (const f of failures) console.log(`  · ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  if (stderr && /Failed to serialize|Uncaught|TypeError/.test(stderr)) {
    console.log('\n\x1b[33m主进程 stderr 有异常：\x1b[0m');
    console.log(stderr.split('\n').filter((l) => !/libpng/.test(l)).slice(0, 10).join('\n'));
  }
  process.exit(fail ? 1 : skipped ? 2 : 0);

  // ---- helpers ----
  function findFileByNames(dir, names) {
    for (const n of fs.readdirSync(dir)) {
      if (names.some((x) => n === x || n.startsWith(x.replace(/\.bin$/, '')))) {
        const p = path.join(dir, n);
        if (fs.statSync(p).isFile()) return p;
      }
    }
    return null;
  }

  async function cleanup(cdpRef, createdRef, rootFid, dirNames) {
    // 逐一删除创建的文件与目录；文件用批量删除接口
    const fids = [...createdRef.files];
    if (fids.length) {
      try {
        await cdpRef.eval(`window.__E2E__.remove(${JSON.stringify(fids)})`);
        ok('批量删除测试文件', `共 ${fids.length} 个 fid（一次请求）`);
      } catch (e) {
        bad('批量删除测试文件', e.message);
      }
    } else {
      skip('批量删除测试文件', '没有创建文件');
    }
    // 目录用递归思路：先删目录内残留，再删目录本身
    for (const d of createdRef.dirs) {
      try {
        const inside = await cdpRef.eval(`window.__E2E__.list(${JSON.stringify(d)}, 1, 200)`);
        const inner = (inside.list || []).map((x) => x.fid);
        if (inner.length) await cdpRef.eval(`window.__E2E__.remove(${JSON.stringify(inner)})`);
      } catch {
        /* 目录可能已空 */
      }
    }
    await sleep(1500);
    for (const d of createdRef.dirs) {
      try {
        await cdpRef.eval(`window.__E2E__.remove([${JSON.stringify(d)}])`);
      } catch (e) {
        bad('删除测试目录', `${d}: ${e.message}`);
      }
    }
    ok('已提交删除测试目录', `共 ${createdRef.dirs.length} 个`);
  }

  /**
   * 无法上传时的降级验证：只验证**只读**链路（列表 + 下载）。
   *
   * 安全约束：绝不重命名 / 移动 / 删除用户已有文件。
   * 下载是只读操作，不会改变云端数据，因此在任何情况下都可以安全验证。
   */
  async function verifyDownloadOnly(cdpRef, listing, dirItem, downDir, copyDirItem) {
    console.log('\n\x1b[1m降级验证：只读链路（列表 + 下载）\x1b[0m');

    // 优先选目录内的文件；没有则从根目录找
    let target = (listing.list || []).find((x) => !x.dir && x.size > 0);
    let from = dirItem;
    if (!target) {
      const rootList = await cdpRef.eval(`window.__E2E__.list('0', 1, 100)`);
      target = (rootList.list || []).find((x) => !x.dir && x.size > 0);
      from = { fid: '0', name: '全部文件' };
    }
    if (!target) {
      skip('下载', '未找到任何可下载的文件');
      return;
    }

    const mb = (n) => (n / 1024 / 1024).toFixed(2);
    console.log(
      `  \x1b[90m选用已有文件：${target.name}（${mb(target.size)} MB，fid=${target.fid}）\x1b[0m`
    );
    console.log('  \x1b[90m该操作只读取云端数据并写入临时目录，不会修改或删除任何云端文件。\x1b[0m');

    await cdpRef.eval(`window.__E2E__.setDownloadDir(${JSON.stringify(downDir)})`);
    const ids = await cdpRef.eval(
      `window.__E2E__.download([${JSON.stringify(target.fid)}], ${JSON.stringify(downDir)}, [${JSON.stringify(target.name)}])`
    );
    expect(Array.isArray(ids) && ids.length === 1, 'download() 立即返回任务 id', `id=${ids[0]}`);

    const tasks = await cdpRef.eval(`window.__E2E__.waitTasks(${JSON.stringify(ids)}, 300000)`);
    const t = tasks[0] || {};
    const doneOk = t.status === 'done';
    expect(doneOk, '下载任务完成',
      `status=${t.status} error=${t.error || '-'} code=${t.errorCode || '-'} size=${t.size}`);
    if (!doneOk) return;

    const names = fs.readdirSync(downDir);
    const got = names.find((n) => n === target.name) || names.find((n) => !n.includes('.qkdownloading'));
    expect(!!got, '本地已生成下载文件', got ? `${got}（目录内共 ${names.length} 项）` : names.join(', '));
    if (got) {
      const full = path.join(downDir, got);
      const size = fs.statSync(full).size;
      expect(size === target.size, '下载文件大小与云端声明一致',
        `本地=${size} 云端=${target.size}`);
      if (target.size > 8 * 1024 * 1024) {
        ok('大文件下载（应已走并行分片路径）', `${mb(size)} MB`);
      }
      // 校验文件头尾部不是全零/截断（做一次基本完整性抽样）
      if (size > 0) {
        const fd = fs.openSync(full, 'r');
        const head = Buffer.alloc(Math.min(64, size));
        fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        expect(head.some((b) => b !== 0), '下载内容非全零（未出现空文件/截断）');
      }
    }
    const leftovers = fs.readdirSync(downDir).filter((n) => n.includes('.qkdownloading'));
    expect(leftovers.length === 0, '下载完成后无残留临时文件', leftovers.join(', ') || '无残留');
  }
})();
