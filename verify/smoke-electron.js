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
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const PORT = 9777;

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

async function waitForDevtools(port, timeoutMs = 30000) {
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
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
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

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 关键：否则 electron 会以纯 Node 模式启动并崩溃
  delete env.NODE_OPTIONS;

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
    const page = await waitForDevtools(PORT);
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
        hasUpload: /上传/.test(txt),
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
        return { ok: reread.downloadConcurrency === 3, before: before.downloadConcurrency, after: reread.downloadConcurrency };
      } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`);
    check('IPC 往返可用（settings 读写持久化）', settingsRoundTrip.ok,
      `before=${settingsRoundTrip.before} after=${settingsRoundTrip.after} ${settingsRoundTrip.err || ''}`);

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

  } catch (e) {
    fail += 1;
    failures.push({ name: '冒烟测试执行', detail: e.message });
    console.log(`  \x1b[31m✗\x1b[0m 冒烟测试执行失败：${e.message}`);
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
