'use strict';
/**
 * 真机冒烟测试 —— 启动**真实的 Electron 应用**，验证：
 *   1. 主进程不崩溃（装配无误：secure-store / session / http / fs / transfer / settings）
 *   2. IPC 处理器全部注册成功（无重复注册异常）
 *   3. 渲染进程真的加载了 index.html，且 preload 桥注入成功（window.qk 存在）
 *   4. 渲染进程无未捕获异常 / console.error
 *   5. UI 关键元素渲染出来了（导航、列表容器、上传按钮等）
 *   6. 渲染进程没有发起任何外部网络请求（需求：无推广、无 AI）
 *
 * 做法：用 CDP 附加到真实应用窗口（--remote-debugging-port），
 * 在页面里执行断言。这是唯一能同时覆盖"主进程 + preload + 渲染进程"的验证方式。
 *
 * 运行：node verify/smoke-electron.js
 */
const { spawn, spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveElectron, electronEnvironment, createElectronHostApp } = require('../src/main/core/platform');

const root = path.join(__dirname, '..');
const PORT = Number(process.env.QCK_SMOKE_PORT || 9777);
const startupTimeout=Math.min(300000,Math.max(30000,Number(process.env.QCK_SMOKE_TIMEOUT_MS)||30000));

const packagedExecutable = process.env.QCK_SMOKE_EXECUTABLE;
const electronPath = packagedExecutable || resolveElectron(root);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function storageFixture(action,userData) {
  const host=createElectronHostApp(path.join(__dirname,'storage-fixture.js'));
  try {
    const legacySeed=action==='write'&&process.env.QCK_SMOKE_SEED_LEGACY==='1';
    const executable=legacySeed?JSON.parse(fs.readFileSync(path.join(root,'.work','legacy-runtime.json'),'utf8')).executable:resolveElectron(root);
    const result=spawnSync(executable,[host.directory],{
      env:{...electronEnvironment(),QCK_STORAGE_TEST_DIR:userData,QCK_STORAGE_TEST_ACTION:action,...(legacySeed?{QCK_STORAGE_TEST_BACKEND:'system'}:{}),...(action==='read'?{QCK_STORAGE_EXPECT_CONCURRENCY:'3'}:{})},
      encoding:'utf8',timeout:30000,killSignal:'SIGKILL',
    });
    if(result.status!==0)throw Error('构建产物与开发运行时的加密存储不兼容');
    if(legacySeed)require('../src/main/core/secure-store').createSecureStore({userDataDir:userData}).snapshot();
    if(legacySeed)console.log('  已使用 Electron 33.4.11 的测试密文作为打包应用启动样本。');
  } finally {host.cleanup();}
}

async function waitForDevtools(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)});
      if (r.ok) {
        const list = await r.json();
        const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
        if (page) return page;
      }
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error('未能连接到应用窗口的调试端口（应用可能启动失败）');
}

/** 极简 CDP 客户端（Node 内置 WebSocket）。 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
        }
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`窗口检查超时：${method}`));},20000);
      this.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `页面内异常: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`
      );
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

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    failures.push({ name, detail });
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

(async () => {
  console.log('\x1b[1m=== 真机冒烟测试（真实 Electron 应用）===\x1b[0m\n');

  if (!electronPath) {
    console.error('未找到 Electron 可执行文件，请先安装：pnpm install && node node_modules/electron/install.js');
    process.exit(1);
  }

  // 用独立的临时 userData，避免污染真实运行数据
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-smoke-'));

  if(packagedExecutable) {
    try {storageFixture('write',userData);}
    catch(error){fs.rmSync(userData,{recursive:true,force:true});throw error;}
  }

  const env = electronEnvironment();
  if (packagedExecutable) {
    // 构建产物关闭对应 fuses，应能抵抗 IDE 注入的 Node 启动变量。
    env.ELECTRON_RUN_AS_NODE = '1';
    env.NODE_OPTIONS = '--unrecognized-quark-test-flag';
  }

  const child = spawn(
    electronPath,
    [root, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  let cdp = null;
  try {
    const page = await waitForDevtools(PORT,startupTimeout);
    console.log(`  已连接到窗口：${page.url}\n`);

    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await sleep(2500); // 等待首屏渲染完成

    // ---- 1. 主进程存活且装配成功 ----
    check('主进程存活（未因装配错误崩溃）', child.exitCode === null, `exitCode=${child.exitCode}`);

    const fatal =
      /(Uncaught|Unhandled|TypeError|ReferenceError|Cannot read propert|is not a function|Failed to serialize|Error sending from webFrameMain)/i.test(
        stderr
      );
    check('主进程 stderr 无致命错误（含 IPC 序列化失败）', !fatal, stderr.split('\n').slice(0, 8).join('\n'));

    // ---- 2. preload 桥注入 ----
    const bridge = await cdp.eval(`(() => {
      if (!window.qk) return { ok: false };
      const g = (o, k) => (o && typeof o[k] === 'function');
      return {
        ok: true,
        auth: ['status','verify','login','logout','quota','getUserInfo','onChange'].every(k => g(window.qk.auth,k)),
        fs: ['list','search','info','crumbs','mkdir','rename','move','copy','remove','taskStatus'].every(k => g(window.qk.fs,k)),
        transfer: ['list','upload','download','pause','resume','retry','cancel','clear','openItem','onUpdate'].every(k => g(window.qk.transfer,k)),
        dialog: ['pickDirs','pickFiles','saveDir','confirm','openPath','showInFolder','getPathForFile'].every(k => g(window.qk.dialog,k)),
        settings: g(window.qk.settings,'get') && g(window.qk.settings,'set'),
        toast: g(window.qk,'onToast'),
      };
    })()`);
    check('window.qk 桥已注入', bridge.ok, '未注入说明 preload 未生效');
    check('window.qk.auth 契约完整', bridge.auth);
    check('window.qk.fs 契约完整', bridge.fs);
    check('window.qk.transfer 契约完整', bridge.transfer);
    check('window.qk.dialog 契约完整', bridge.dialog);
    check('window.qk.settings 契约完整', bridge.settings);
    check('qk:toast 订阅可用', bridge.toast);

    // ---- 3. 渲染进程安全边界 ----
    const sandboxOk = await cdp.eval(`({
      noRequire: typeof require === 'undefined',
      noProcess: typeof process === 'undefined',
      noModule: typeof module === 'undefined'
    })`);
    check('渲染进程无 Node 权限（require 不可用）', sandboxOk.noRequire);
    check('渲染进程无 process 全局', sandboxOk.noProcess);
    check('渲染进程无 module 全局', sandboxOk.noModule);

    // ---- 4. UI 关键元素 ----
    const dom = await cdp.eval(`(() => {
      const q = (s) => document.querySelector(s);
      const txt = document.body.innerText || '';
      return {
        title: document.title,
        hasNav: !!q('.nav, nav, [class*=nav]'),
        hasList: !!q('[class*=list], #filelist, table'),
        hasUpload: (() => { const button=q('#btn-upload'); return !!button && button.getClientRects().length>0 && /上传/.test(button.title || button.textContent || ''); })(),
        hasSearch: !!q('input[type=search], input[placeholder*=搜索], [class*=search]'),
        bodyLen: txt.length,
        themeAttr: document.documentElement.dataset.theme || '',
        forbidden: ['AI','播放器','推广','同步盘','会员','分享'].filter(k => txt.includes(k)),
        stylesLoaded: !!q('link[rel=stylesheet]') && getComputedStyle(document.body).fontFamily.length > 0,
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    })()`);

    check('页面标题正确', /夸克/.test(dom.title || ''), `title=${dom.title}`);
    check('导航区已渲染', dom.hasNav);
    check('文件列表容器已渲染', dom.hasList);
    check('存在「上传」入口', dom.hasUpload);
    check('存在搜索框', dom.hasSearch);
    check('页面有实际内容（非白屏）', dom.bodyLen > 20, `innerText 长度=${dom.bodyLen}`);
    check('样式表已生效（背景色已应用）', dom.bodyBg && dom.bodyBg !== 'rgba(0, 0, 0, 0)', `bg=${dom.bodyBg}`);
    check('界面无 AI/播放器/推广/同步盘/会员/分享 字样', dom.forbidden.length === 0, `发现: ${dom.forbidden.join(',')}`);

    // ---- 5. 渲染进程无异常 ----
    const pageErrors = cdp.events.filter(
      (e) => e.method === 'Runtime.exceptionThrown'
    );
    const consoleErrors = cdp.events.filter(
      (e) =>
        e.method === 'Runtime.consoleAPICalled' &&
        e.params &&
        e.params.type === 'error'
    );
    check('渲染进程无未捕获异常', pageErrors.length === 0,
      pageErrors.slice(0, 3).map((e) => e.params?.exceptionDetails?.text).join('; '));
    check('渲染进程无 console.error', consoleErrors.length === 0,
      consoleErrors.slice(0, 3).map((e) => (e.params.args || []).map((a) => a.value).join(' ')).join('; '));

    // ---- 6. 无外部网络请求（CSP connect-src 'none' + 无推广） ----
    const reqs = cdp.events
      .filter((e) => e.method === 'Network.requestWillBeSent')
      .map((e) => e.params.request.url);
    const external = reqs.filter((u) => !/^(file|data|blob|devtools):/i.test(u));
    check('渲染进程未发起任何外部网络请求', external.length === 0, external.slice(0, 5).join('\n      '));

    // ---- 7. IPC 真实往返：设置读写 ----
    const settingsRoundTrip = await cdp.eval(`(async () => {
      try {
        const before = await window.qk.settings.get();
        const after = await window.qk.settings.set({ downloadConcurrency: 3 });
        const reread = await window.qk.settings.get();
        return { ok: reread.downloadConcurrency === 3, seeded: before.theme === 'dark', before: before.downloadConcurrency, after: reread.downloadConcurrency };
      } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`);
    check('IPC 往返可用（settings 读写持久化）', settingsRoundTrip.ok && (!packagedExecutable || settingsRoundTrip.seeded),
      `before=${settingsRoundTrip.before} after=${settingsRoundTrip.after} seeded=${settingsRoundTrip.seeded} ${settingsRoundTrip.err || ''}`);

    // ---- 8. IPC 真实往返：登录态查询（本地读取，不发网络） ----
    const authState = await cdp.eval(`(async () => {
      try { return { ok: true, s: await window.qk.auth.status() }; }
      catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`);
    check('IPC 往返可用（auth.status 返回结构）', authState.ok && authState.s && typeof authState.s.loggedIn === 'boolean',
      JSON.stringify(authState).slice(0, 200));

    // ---- 9. IPC 真实往返：文件列表（未登录应抛 NEED_LOGIN，而不是崩溃） ----
    const fsCall = await cdp.eval(`(async () => {
      try {
        const r = await window.qk.fs.list({ pdirFid: '0', page: 1, size: 10 });
        return { ok: true, list: Array.isArray(r.list) };
      } catch (e) { return { ok: false, code: e && e.code, msg: e && e.message }; }
    })()`);
    const fsBehaves = fsCall.ok || fsCall.code === 'NEED_LOGIN';
    check(
      'IPC 往返可用（fs.list 正常返回或明确提示需登录）',
      fsBehaves,
      JSON.stringify(fsCall).slice(0, 200)
    );
    if (!fsCall.ok) {
      check('未登录时错误为中文且带 NEED_LOGIN', fsCall.code === 'NEED_LOGIN' && /登录/.test(fsCall.msg || ''),
        JSON.stringify(fsCall));
    }

    // ---- 10. 传输模块 IPC ----
    const transferList = await cdp.eval(`(async () => {
      try { const t = await window.qk.transfer.list(); return { ok: true, isArr: Array.isArray(t) }; }
      catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`);
    check('IPC 往返可用（transfer.list 返回数组）', transferList.ok && transferList.isArr,
      JSON.stringify(transferList).slice(0, 160));

    if(packagedExecutable) {
      let compatible=true;
      try {storageFixture('read',userData);} catch {compatible=false;}
      check('构建产物的密文可由开发运行时回读',compatible);
    }

  } catch (e) {
    fail += 1;
    failures.push({ name: '冒烟测试执行', detail: e.message });
    console.log(`  \x1b[31m✗\x1b[0m 冒烟测试执行失败：${e.message}`);
    // 此进程只有固定测试数据；保留有限原生诊断用于定位启动或 Keychain 阻塞。
    if(stderr)console.error(stderr.slice(-3000));
    if(process.platform==='darwin'&&process.env.CI==='true'&&packagedExecutable){
      // 仅诊断当前固定测试 profile 的进程，输出原生函数名与测试项是否存在，不输出密钥。
      try{
        const stack=execFileSync('sample',[String(child.pid),'1','1'],{encoding:'utf8',timeout:10000});
        console.error(stack.split('\n').filter(line=>/OSCrypt|Keychain|SecItem|semaphore|Decrypt|Encrypt/.test(line)).slice(0,45).join('\n'));
      }catch{console.error('原生进程采样不可用');}
      for(const appName of ['quark-mini','Electron','夸克网盘极简版']){
        const probe=spawnSync('security',['find-generic-password','-a',appName,'-s',appName+' Safe Storage',path.join(process.env.RUNNER_TEMP,'quark-ci-packed.keychain-db')],{stdio:'ignore',timeout:2000,killSignal:'SIGKILL'});
        console.error(`测试 Keychain 条目 ${appName}：${probe.status===0?'存在':'不可见'}`);
      }
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
    if(child.exitCode===null)child.kill('SIGKILL');
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n\x1b[1m=== 冒烟测试结果：${pass} 通过 / ${fail} 失败 ===\x1b[0m`);
  if (fail > 0) {
    console.log('\n\x1b[31m失败详情：\x1b[0m');
    for (const f of failures) console.log(`  · ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
  process.exit(fail > 0 ? 1 : 0);
})();
