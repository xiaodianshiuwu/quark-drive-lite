'use strict';
/**
 * test/renderer-harness.js —— 渲染层测试的极简 DOM 垫片与假桥
 *
 * 目的：在 Node 中真实执行 src/renderer 的 api.js / virtual-list.js / app.js，
 * 覆盖 Agent 面板与对话视图的渲染与交互，不需要浏览器、不发网络请求。
 *
 * 约束：
 *  - 垫片只实现应用真正用到的 DOM 子集；**不解析 innerHTML**，任何 innerHTML 写入
 *    都会原样保留为字符串，这也正好让「不可信数据变成 HTML」的断言成立；
 *  - 假桥按 api.js 的 CONTRACT 逐方法构造，行为可按用例覆盖；
 *  - 本文件不是测试文件（命名不含 .test.js），不会被 node --test 直接执行。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'src/renderer/index.html');
const APP_PATH = path.join(ROOT, 'src/renderer/app.js');
const API_PATH = path.join(ROOT, 'src/renderer/api.js');
const VIRTUAL_PATH = path.join(ROOT, 'src/renderer/virtual-list.js');
const STYLES_PATH = path.join(ROOT, 'src/renderer/styles.css');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const appSrc = fs.readFileSync(APP_PATH, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const virtualSrc = fs.readFileSync(VIRTUAL_PATH, 'utf8');
const stylesSrc = fs.readFileSync(STYLES_PATH, 'utf8');

/** 让所有已 resolve 的 Promise 走到 settle。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** vm 沙箱里的对象与测试进程属于不同 realm，断言前统一转成当前 realm 的纯数据。 */
const plain = (value) => JSON.parse(JSON.stringify(value));
const clone = (value) => JSON.parse(JSON.stringify(value));

/* ==================================================================== *
 * DOM 垫片
 * ==================================================================== */

const VOID_TAGS = new Set([
  'input', 'br', 'hr', 'img', 'meta', 'link', 'use', 'path', 'circle', 'rect',
  'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr'
]);

function parseAttributes(text) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    attrs[name] = value;
  }
  return attrs;
}

function parseHtml(source, doc) {
  const root = doc.createElement('html');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][-a-zA-Z0-9]*)\s*>|<([a-zA-Z][-a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const token = m[0];
    if (token.startsWith('<!--') || /^<!doctype/i.test(token)) continue;
    const closing = m[1];
    const opening = m[2];
    if (closing) {
      const tag = closing.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const node = doc.createElement(opening.toLowerCase());
    const attrs = parseAttributes(m[3] || '');
    for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
    stack[stack.length - 1].appendChild(node);
    if (!VOID_TAGS.has(node.tagName) && !token.endsWith('/>')) stack.push(node);
  }
  return root;
}

/** 单个复合选择器（tag/#id/.class/[attr] 的组合）→ 匹配函数。 */
function compoundMatcher(compound) {
  const parts = String(compound).trim().split(/(?=[.#[])/);
  const checks = parts.map((part) => {
    if (part.startsWith('#')) return (el) => el.id === part.slice(1);
    if (part.startsWith('.')) return (el) => el.hasClass(part.slice(1));
    if (part.startsWith('[')) {
      const inner = part.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq >= 0) {
        const name = inner.slice(0, eq);
        const value = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
        return (el) => el.getAttribute(name) === value;
      }
      return (el) => el.hasAttribute(inner);
    }
    return (el) => el.tagName === part.toLowerCase();
  });
  return (el) => checks.every((fn) => fn(el));
}

/** 支持后代组合（".a li"）：末段匹配自身，其余段自底向上在祖先链上按序匹配。 */
function selectorMatcher(selector) {
  const compounds = String(selector).trim().split(/\s+/).filter(Boolean).map(compoundMatcher);
  if (compounds.length === 1) return compounds[0];
  return (el) => {
    let idx = compounds.length - 1;
    let cur = el;
    while (cur) {
      if (compounds[idx](cur)) {
        idx -= 1;
        if (idx < 0) return true;
      }
      cur = cur.parentNode;
    }
    return false;
  };
}

/** data-foo-bar → dataset.fooBar（与浏览器一致）。 */
function camelize(name) {
  return String(name).replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

class ClassList {
  constructor(element) { this.element = element; }
  get items() { return this.element.className.split(/\s+/).filter(Boolean); }
  has(name) { return this.items.indexOf(name) >= 0; }
  contains(name) { return this.has(name); }
  add(name) { if (!this.has(name)) this.element.className = this.items.concat(name).join(' '); }
  remove(name) { this.element.className = this.items.filter((x) => x !== name).join(' '); }
  toggle(name, force) {
    const want = force === undefined ? !this.has(name) : !!force;
    if (want) this.add(name); else this.remove(name);
    return want;
  }
}

class Element {
  constructor(tagName) {
    const attributes = {};
    this.tagName = String(tagName).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = attributes;
    this.dataset = new Proxy({}, {
      // 与浏览器一致：写 dataset.fooBar 等价于写 data-foo-bar 属性
      set: (target, key, value) => {
        if (typeof key === 'string') {
          target[key] = String(value);
          attributes['data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = String(value);
        } else {
          target[key] = value;
        }
        return true;
      }
    });
    this.style = {};
    this.listeners = {};
    this.className = '';
    this.id = '';
    this.ownText = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.type = '';
    this.title = '';
    this.placeholder = '';
    this.rows = 3;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.classList = new ClassList(this);
  }

  /* ---- 文本（与浏览器一致：读取时聚合子孙文本，写入时替换全部子节点） ---- */
  get textContent() {
    if (!this.children.length && this.ownText) return this.ownText;
    if (!this.children.length) return '';
    return this.children.map((c) => (c.tagName === '#text' ? c.ownText : c.textContent)).join('');
  }
  set textContent(value) {
    for (const child of this.children.slice()) this.removeChild(child);
    this.ownText = value === undefined || value === null ? '' : String(value);
    if (this.ownText) {
      const text = new Element('#text');
      text.ownText = this.ownText;
      text.parentNode = this;
      this.children.push(text);
    }
  }

  /* ---- 属性 ---- */
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name.indexOf('data-') === 0) this.dataset[camelize(name.slice(5))] = String(value);
  }
  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
  }
  hasAttribute(name) {
    if (name === 'id') return !!this.id;
    if (name === 'class') return !!this.className;
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }
  hasClass(name) { return this.classList.has(name); }

  /* ---- 树 ---- */
  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    const idx = this.children.indexOf(ref);
    if (idx < 0) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.splice(idx, 0, node);
    return node;
  }
  removeChild(node) {
    const idx = this.children.indexOf(node);
    if (idx >= 0) { this.children.splice(idx, 1); node.parentNode = null; }
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  get firstChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.filter((c) => c.tagName !== '#text').length; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx >= 0 ? (this.parentNode.children[idx + 1] || null) : null;
  }
  get isConnected() {
    return this.tagName === 'document' || this.tagName === 'html' ||
      (!!this.parentNode && this.parentNode.isConnected);
  }
  contains(node) {
    let cur = node;
    while (cur) { if (cur === this) return true; cur = cur.parentNode; }
    return false;
  }

  /* ---- 查询 ---- */
  /** 收集全部子孙元素节点（跳过 #text 节点，与浏览器 selectors 行为一致）。 */
  walk(out) {
    for (const child of this.children) {
      if (child.tagName === '#text') continue;
      out.push(child);
      child.walk(out);
    }
    return out;
  }
  querySelectorAll(selector) {
    const match = selectorMatcher(selector);
    return this.walk([]).filter(match);
  }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }
  closest(selector) {
    const match = selectorMatcher(selector);
    let cur = this;
    while (cur) { if (match(cur)) return cur; cur = cur.parentNode; }
    return null;
  }

  /* ---- 事件（含冒泡） ---- */
  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners[type] || [];
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }
  /** 从本节点向上冒泡派发一个简单事件；返回事件对象。 */
  bubble(type, init) {
    const event = Object.assign({
      type: type,
      target: this,
      detail: 1,
      stopped: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    }, init || {});
    let cur = this;
    while (cur && !event.stopped) {
      const handlers = (cur.listeners[type] || []).slice();
      for (const fn of handlers) fn.call(cur, event);
      cur = cur.parentNode;
    }
    return event;
  }
  dispatchClick() { return this.bubble('click'); }
  click() {
    if (this.disabled) return null;
    if (this.tagName === 'input' && this.type === 'checkbox') this.checked = !this.checked;
    return this.dispatchClick();
  }
  dispatchEvent(event) {
    return this.bubble(event && event.type ? event.type : String(event), {});
  }
  dispatchKey(key, init) {
    return this.bubble('keydown', Object.assign({ key: key }, init || {}));
  }
}

class Document extends Element {
  constructor(source) {
    super('document');
    this.readyState = 'complete';
    this.documentElement = new Element('html');
    this.documentElement.setAttribute('data-theme', 'light');
    this.body = parseHtml(source, this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createElement(tag) { return new Element(tag); }
  createElementNS(_ns, tag) { return new Element(tag); }
  createTextNode(text) { const n = new Element('#text'); n.textContent = String(text); return n; }
  getElementById(id) {
    return this.walk([]).find((el) => el.id === id) || null;
  }
}

/** 简单的事件构造器（sandbox.Event）。 */
class TestEvent {
  constructor(type) { this.type = String(type); }
}

/* ==================================================================== *
 * api.js 加载工具（纯桥接层契约）
 * ==================================================================== */

/**
 * 在 vm 中真实加载 api.js，按需注入假 window。
 * @param {{mock?:boolean, qk?:object|null, clipboard?:object}} opts
 */
function loadApi(opts = {}) {
  const qk = opts.qk === undefined ? null : opts.qk;
  const win = {
    location: { search: opts.mock ? '?mock=1' : '' },
    navigator: opts.clipboard === undefined ? {} : { clipboard: opts.clipboard },
    qk: qk || undefined
  };
  win.window = win;
  const sandbox = {
    window: win, globalThis: win, console,
    setTimeout, clearTimeout,
    // api.js 的 ?mock=1 假数据桥会起进度定时器；用桩避免测试进程被挂住
    setInterval: () => 0,
    clearInterval: () => {}
  };
  sandbox.self = win;
  vm.createContext(sandbox);
  vm.runInContext(apiSrc, sandbox, { filename: API_PATH });
  return win.QKAPI;
}

/** 按 CONTRACT 构造一个「所有方法都可调用」的假 qk 桥；可选排除某些命名空间。 */
function fakeQk(opts = {}) {
  const calls = [];
  const qk = {};
  const skip = opts.omit || [];
  const record = (ns, name) => (...args) => {
    calls.push({ ns, name, args });
    return Promise.resolve(null);
  };
  const contract = loadApi().CONTRACT;
  for (const key of Object.keys(contract)) {
    const parts = key.split('.');
    if (skip.indexOf(parts[0]) >= 0) continue;
    qk[parts[0]] = qk[parts[0]] || {};
    qk[parts[0]][parts[1]] = record(parts[0], parts[1]);
  }
  return { calls, qk };
}

/* ==================================================================== *
 * 应用启动工具（假桥 + 真实渲染）
 * ==================================================================== */

const BASE_ACCOUNT = { loggedIn: true, expired: false, nickname: '测试账号', memberLabel: '普通用户', userId: 'fixture-user' };

const BASE_AGENT_STATUS = {
  enabled: true,
  running: true,
  endpoint: '/tmp/qck-agent/agent-1.sock',
  transport: 'unix-socket',
  bridgeFile: '/tmp/qck-agent/bridge.json',
  journalFile: '/tmp/qck-agent/journal.jsonl',
  writeMode: 'read-only',
  allowDelete: false,
  remoteRoots: [{ fid: 'fid-100', name: '项目资料' }],
  localReadRoots: ['/Users/tester/Downloads'],
  localWriteRoots: ['/Users/tester/work'],
  connections: 2,
  callsServed: 7,
  authFailures: 0,
  startedAt: 1750000000000,
  lastError: '',
  toolCount: 12
};

const BASE_JOURNAL = [
  { seq: 1, ts: 1750000001000, kind: 'config', actor: 'user', result: 'enabled' },
  { seq: 2, ts: 1750000002000, kind: 'tool_call', tool: 'fs_list', actor: 'agent', result: 'ok', detail: { ms: 42 } },
  {
    seq: 3, ts: 1750000003000, kind: 'tool_call', tool: 'fs_remove', actor: 'agent', result: 'error',
    detail: { code: 'AGENT_READ_ONLY', message: '只读模式下不允许删除' }
  },
  { seq: 4, ts: 1750000004000, kind: 'auth', actor: 'external', result: 'rejected', detail: {} }
];

const BASE_MCP = {
  mcpServers: {
    'quark-mini': { command: 'node', args: ['/opt/qck/tools/agent-mcp.js'], env: { QCK_USER_DATA_DIR: '/tmp/qck' } }
  }
};

const UNCONFIGURED_CHAT = {
  configured: false, baseUrl: '', model: '', hasKey: false,
  maxRounds: 8, timeoutMs: 120000, systemPrompt: '', temperature: 0.7,
  defaultSystemPrompt: '', running: false, lastError: '', historyCount: 0,
  toolCount: 19, scope: null
};

const CONFIGURED_CHAT = Object.assign({}, UNCONFIGURED_CHAT, {
  configured: true,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  hasKey: true,
  historyCount: 2
});

/**
 * 启动渲染层：真实执行 index.html + api.js + virtual-list.js + app.js。
 *
 * @param {object} opts
 *  - bridge: 'full'（默认）| 'base'（有基础桥、无 agent/chat）| 'none'（无 window.qk）
 *  - agentStatus / agentStatusError / journal / mcp / copyFails
 *  - chatStatus / chatStatusError / history / models / sendImpl / testResult
 *  - confirmSupported（默认 true）/ confirmResult（默认 true）
 *  - pickedDirs / clipboardFails / agentOverrides / chatOverrides
 */
async function bootApp(opts = {}) {
  const calls = [];
  const doc = new Document(html);
  const listeners = { chat: [], auth: [] };
  let confirmed = opts.confirmResult !== false;

  const agentStatus = opts.agentStatus === undefined
    ? clone(BASE_AGENT_STATUS)
    : (opts.agentStatus === null ? null : clone(opts.agentStatus));
  const journal = (opts.journal === undefined ? BASE_JOURNAL : opts.journal).map((e) => clone(e));
  const mcp = opts.mcp === undefined ? clone(BASE_MCP) : clone(opts.mcp);
  const chatStatus = clone(opts.chatStatus === undefined ? UNCONFIGURED_CHAT : opts.chatStatus);
  const history = (opts.history === undefined ? [] : opts.history).map((e) => clone(e));

  const qk = {};
  const record = (ns, name) => (...args) => {
    calls.push({ ns, name, args });
    return Promise.resolve(null);
  };

  // 基础命名空间：与真实 Tauri 桥一致（agent/chat 是否提供由 bridge 选项决定）
  const bridgeMode = opts.bridge || 'full';
  if (bridgeMode !== 'none') {
    const contract = loadApi().CONTRACT;
    for (const key of Object.keys(contract)) {
      const parts = key.split('.');
      if (bridgeMode === 'base' && (parts[0] === 'agent' || parts[0] === 'chat')) continue;
      qk[parts[0]] = qk[parts[0]] || {};
      qk[parts[0]][parts[1]] = record(parts[0], parts[1]);
    }
  }

  // 基础数据桥（覆盖默认的通用 Promise）
  if (bridgeMode !== 'none') {
    qk.auth.status = () => Promise.resolve(clone(BASE_ACCOUNT));
    qk.auth.verify = () => Promise.resolve(clone(BASE_ACCOUNT));
    qk.auth.login = () => Promise.resolve(clone(BASE_ACCOUNT));
    qk.auth.logout = () => Promise.resolve(null);
    qk.auth.quota = () => Promise.resolve({ total: 1024, used: 10 });
    qk.settings.get = () => Promise.resolve({
      downloadDir: '/tmp/dl', uploadConcurrency: 2, downloadConcurrency: 2,
      downloadParallel: 16, downloadStrategy: 'auto', uploadPartConcurrency: 3, theme: 'light'
    });
    qk.settings.set = (patch) => Promise.resolve(Object.assign({
      downloadDir: '/tmp/dl', theme: 'light'
    }, patch));
    qk.fs.list = (p) => Promise.resolve({ list: [], total: 0, page: (p && p.page) || 1, size: 100, hasMore: false });
    qk.fs.search = (p) => Promise.resolve({ list: [], total: 0, page: (p && p.page) || 1, size: 100, hasMore: false });
    qk.fs.crumbs = () => Promise.resolve([{ fid: '0', name: '全部文件' }]);
    qk.transfer.list = () => Promise.resolve([]);
    qk.transfer.onUpdate = (cb) => { return function () {}; };
    qk.onTransferUpdate = (cb) => { return function () {}; };
    qk.onToast = (cb) => { return function () {}; };
    qk.dialog.pickDirs = (...args) => {
      calls.push({ ns: 'dialog', name: 'pickDirs', args });
      return Promise.resolve((opts.pickedDirs || ['/Users/tester/图片']).slice());
    };
    qk.dialog.pickFiles = () => Promise.resolve([]);
    qk.dialog.saveDir = () => Promise.resolve('/tmp/dl');
    qk.dialog.confirm = (...args) => {
      calls.push({ ns: 'dialog', name: 'confirm', args });
      return Promise.resolve(confirmed);
    };
    if (opts.confirmSupported === false) delete qk.dialog.confirm;
    qk.dialog.openPath = () => Promise.resolve(null);
    qk.dialog.showInFolder = () => Promise.resolve(null);
    if (opts.agentStatusError && bridgeMode === 'full') {
      qk.agent.status = () => Promise.reject({ code: 'SERVER', message: opts.agentStatusError });
    }
    if (opts.chatStatusError && bridgeMode === 'full') {
      qk.chat.status = () => Promise.reject({ code: 'SERVER', message: opts.chatStatusError });
    }
    if (opts.sendImpl && bridgeMode === 'full') qk.chat.send = opts.sendImpl;
    // 备份（Phase-2）：backupImpl = { plan, start, status, verify } 可覆盖；默认空响应
    // backupOverrides 直接替换 qk.backup 上的方法（用例级，优先级最高）。
    if (bridgeMode === 'full') {
      const bkImpl = opts.backupImpl || {};
      const bkDefault = {
        plan: {
          files: 8, dirs: 2, warnings: 1, totalBytes: 4096,
          samples: [
            { relPath: 'docs/说明.pdf', size: 1024, mtimeMs: 1750000000000 },
            { relPath: '图片/封面.png', size: 2048, mtimeMs: 1750000000001 },
            { warning: '受限目录/System Volume Information', detail: '读取失败：权限不足' }
          ]
        },
        start: { running: true },
        status: null, // 动态（跑/不跑两态由 opts.backupRunning 决定）
        retry: { requeued: 0 },
        cancel: { canceled: true },
        // 字段形态对齐真实后端 VerifyReport（serde 无 rename_all → snake_case）
        verify: { status: 'verified', total_success: 8, listed_ok: 8, listed_missing: 0,
          size_mismatch: 0, sample_requested: 8, sample_checked: 8, sample_ok: 8, sample_mismatch: 0, issues: [] },
      };
      ['plan', 'start', 'retry', 'cancel', 'verify'].forEach((name) => {
        qk.backup[name] = (...args) => {
          calls.push({ ns: 'backup', name, args });
          return Promise.resolve(bkImpl[name] !== undefined ? clone(bkImpl[name]) : clone(bkDefault[name]));
        };
      });
      qk.backup.status = (...args) => {
        calls.push({ ns: 'backup', name: 'status', args });
        if (bkImpl.status) return Promise.resolve(clone(bkImpl.status));
        const running = !!opts.backupRunning;
        return Promise.resolve(running ? {
          hasSession:true,scanComplete:false,totalDiscovered:19,status:'scanning',running: true, account: 'fixture-user', discovered: 10, pending: 2, uploading: 1,
          verifying: 0, success: 6, failed: 0, skipped: 0, canceled: 0, queueDepth: 2, uploadedBytes: 4096,
        } : { running: false });
      };
    }
  }

  // Agent 接入：状态机在假桥里保持，模拟主进程真实行为
  if (bridgeMode === 'full') {
    qk.agent.status = (...args) => {
      calls.push({ ns: 'agent', name: 'status', args });
      if (opts.agentStatusError) return Promise.reject({ code: 'SERVER', message: opts.agentStatusError });
      return Promise.resolve(agentStatus === null ? {} : clone(agentStatus));
    };
    qk.agent.enable = (...args) => {
      calls.push({ ns: 'agent', name: 'enable', args });
      if (agentStatus) { agentStatus.enabled = true; agentStatus.running = true; }
      return Promise.resolve(agentStatus ? clone(agentStatus) : {});
    };
    qk.agent.disable = (...args) => {
      calls.push({ ns: 'agent', name: 'disable', args });
      if (agentStatus) { agentStatus.enabled = false; agentStatus.running = false; }
      return Promise.resolve(agentStatus ? clone(agentStatus) : {});
    };
    qk.agent.setScope = (...args) => {
      calls.push({ ns: 'agent', name: 'setScope', args });
      const patch = args[0] || {};
      if (agentStatus) Object.assign(agentStatus, clone(patch));
      return Promise.resolve(agentStatus ? clone(agentStatus) : {});
    };
    qk.agent.rotate = (...args) => {
      calls.push({ ns: 'agent', name: 'rotate', args });
      return Promise.resolve(agentStatus ? clone(agentStatus) : {});
    };
    qk.agent.journal = (...args) => {
      calls.push({ ns: 'agent', name: 'journal', args });
      if (opts.journalFails) return Promise.reject({ code: 'SERVER', message: opts.journalFails });
      const limit = Number(args[0]) || journal.length;
      return Promise.resolve(clone(journal.slice(-limit)));
    };
    qk.agent.mcpConfig = (...args) => {
      calls.push({ ns: 'agent', name: 'mcpConfig', args });
      if (opts.mcpFails) return Promise.reject({ code: 'SERVER', message: opts.mcpFails });
      return Promise.resolve(clone(mcp));
    };
    qk.agent.copyMcpConfig = (...args) => {
      calls.push({ ns: 'agent', name: 'copyMcpConfig', args });
      if (opts.copyFails) return Promise.reject({ code: 'NO_BRIDGE', message: '复制命令不可用' });
      // 与真实后端一致：mcpConfig 为空时返回 null（而不是字符串 "null"）
      if (mcp === null) return Promise.resolve(null);
      return Promise.resolve(JSON.stringify(mcp, null, 2));
    };

    // 对话：状态机与历史同样在假桥里保持
    qk.chat.onEvent = (cb) => {
      if (typeof cb !== 'function') return function () {};
      listeners.chat.push(cb);
      return () => {
        const i = listeners.chat.indexOf(cb);
        if (i >= 0) listeners.chat.splice(i, 1);
      };
    };
    qk.chat.status = (...args) => {
      calls.push({ ns: 'chat', name: 'status', args });
      if (opts.chatStatusError) return Promise.reject({ code: 'SERVER', message: opts.chatStatusError });
      return Promise.resolve(clone(chatStatus));
    };
    qk.chat.saveConfig = (...args) => {
      calls.push({ ns: 'chat', name: 'saveConfig', args });
      const patch = args[0] || {};
      if (typeof patch.baseUrl === 'string') chatStatus.baseUrl = patch.baseUrl;
      if (typeof patch.model === 'string') chatStatus.model = patch.model;
      // 与主进程约定一致：apiKey 省略或空字符串 = 保留原 Key；传 null = 清空
      if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
        if (patch.apiKey === null) chatStatus.hasKey = false;
        else if (patch.apiKey) chatStatus.hasKey = true;
      }
      chatStatus.configured = !!(chatStatus.baseUrl && chatStatus.model && chatStatus.hasKey);
      return Promise.resolve(clone(chatStatus));
    };
    qk.chat.clearConfig = (...args) => {
      calls.push({ ns: 'chat', name: 'clearConfig', args });
      chatStatus.configured = false;
      chatStatus.baseUrl = '';
      chatStatus.model = '';
      chatStatus.hasKey = false;
      return Promise.resolve(clone(chatStatus));
    };
    qk.chat.test = (...args) => {
      calls.push({ ns: 'chat', name: 'test', args });
      if (opts.testFails) return Promise.reject({ code: 'NETWORK', message: '连接失败', hint: '检查 Base URL' });
      return Promise.resolve({ ok: true, model: chatStatus.model || 'deepseek-chat', reply: '可用' });
    };
    qk.chat.models = (...args) => {
      calls.push({ ns: 'chat', name: 'models', args });
      if (opts.modelsFails) return Promise.reject({ code: 'SERVER', message: '模型列表读取失败' });
      return Promise.resolve({ models: (opts.models || ['deepseek-chat', 'deepseek-reasoner']).slice() });
    };
    qk.chat.history = (...args) => {
      calls.push({ ns: 'chat', name: 'history', args });
      const limit = Number(args[0]) || history.length;
      return Promise.resolve(clone(history.slice(-limit)));
    };
    qk.chat.clear = (...args) => {
      calls.push({ ns: 'chat', name: 'clear', args });
      history.length = 0;
      return Promise.resolve({ ok: true });
    };
    qk.chat.send = (...args) => {
      calls.push({ ns: 'chat', name: 'send', args });
      if (opts.sendImpl) return opts.sendImpl(...args);
      if (opts.sendError) {
        return Promise.reject({ code: opts.sendError.code || 'NETWORK', message: opts.sendError.message || '发送失败', hint: opts.sendError.hint });
      }
      return Promise.resolve(opts.sendResult || { reply: '默认回复', rounds: 1, ms: 8, toolCalls: [] });
    };
  }

  // 用例级覆盖放在完整桥构造之后，避免被默认方法覆盖
  if (opts.agentOverrides && qk.agent) Object.assign(qk.agent, opts.agentOverrides);
  if (opts.backupOverrides && qk.backup) Object.assign(qk.backup, opts.backupOverrides);
  if (opts.chatOverrides && qk.chat) Object.assign(qk.chat, opts.chatOverrides);

  const win = {
    document: doc,
    location: { search: '', reload: () => {} },
    navigator: {
      clipboard: {
        writeText: (text) => {
          calls.push({ ns: 'clipboard', name: 'writeText', args: [text] });
          return opts.clipboardFails ? Promise.reject(new Error('clipboard unavailable')) : Promise.resolve();
        }
      }
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => confirmed,
    qk: bridgeMode === 'none' ? undefined : qk
  };
  win.window = win;

  // 可控时钟：真实 setInterval 会把测试进程挂住，死桩又让「轮询启停」无法被用例驱动。
  // 这里提供手动推进的桩：返回可识别的句柄（对象），由返回值 backupTick 逐格触发。
  const timers = new Set();
  const fakeSetInterval = (fn) => { timers.add(fn); return fn; };
  const fakeClearInterval = (fn) => { timers.delete(fn); };

  const sandbox = {
    window: win,
    document: doc,
    location: win.location,
    navigator: win.navigator,
    console,
    setTimeout,
    clearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    // 同步执行回调：列表/弹层动画不依赖真实帧调度
    requestAnimationFrame: (fn) => { fn(); return null; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Event: TestEvent
  };
  sandbox.globalThis = win;
  sandbox.self = win;
  vm.createContext(sandbox);

  vm.runInContext(apiSrc, sandbox, { filename: API_PATH });
  vm.runInContext(virtualSrc, sandbox, { filename: VIRTUAL_PATH });
  vm.runInContext(appSrc, sandbox, { filename: APP_PATH });
  await flush();
  await flush();
  await flush();

  const ui = win.QKUI;
  assert.ok(ui, 'app.js 未导出 window.QKUI');
  const $ = (id) => doc.getElementById(id);

  function pick(target) {
    if (typeof target !== 'string') return target;
    const byId = doc.getElementById(target);
    if (byId) return byId;
    return doc.querySelector(target);
  }

  async function click(target) {
    const el = pick(target);
    assert.ok(el, '找不到可点击元素：' + target);
    if (typeof el.click === 'function') el.click();
    else el.dispatchClick();
    await flush();
    await flush();
    await flush();
    return el;
  }

  async function typeAndSend(targetEl, text, keyOpts) {
    targetEl.value = text;
    targetEl.dispatchKey('Enter', keyOpts || {});
    await flush();
    await flush();
    await flush();
  }

  /** 最近打开的自绘弹层（confirmDialog 等）。 */
  function latestOverlay() {
    const all = doc.querySelectorAll('.overlay');
    return all.length ? all[all.length - 1] : null;
  }

  /** 点击最近弹层底部按钮：'ok' 最后一个，'cancel' 第一个。 */
  async function clickOverlay(which) {
    const overlay = latestOverlay();
    assert.ok(overlay, '没有打开的自绘弹层');
    const foot = overlay.querySelector('.dlg-foot');
    assert.ok(foot, '弹层缺少 .dlg-foot');
    const btns = foot.children.filter((c) => c.tagName === 'button');
    const btn = which === 'cancel' ? btns[0] : btns[btns.length - 1];
    assert.ok(btn, '弹层底部没有按钮');
    await click(btn);
    return btn;
  }

  return {
    calls,
    doc,
    win,
    ui,
    qk,
    status: agentStatus,
    chatStatus,
    journal,
    history,
    $,
    text: (id) => ($(id) ? $(id).textContent : null),
    find: (sel) => doc.querySelector(sel),
    findAll: (sel) => doc.querySelectorAll(sel),
    click,
    typeAndSend,
    latestOverlay,
    clickOverlay,
    setConfirmed: (v) => { confirmed = !!v; },
    agentCalls: () => calls.filter((c) => c.ns === 'agent').map((c) => c.name),
    chatCalls: () => calls.filter((c) => c.ns === 'chat').map((c) => c.name),
    /** 触发桥接层注册的对话进度事件（Tauri 通道 qk:chat-event 的等价物）。 */
    emitChat: (ev) => {
      listeners.chat.slice().forEach((cb) => { try { cb(ev); } catch (e) { /* 订阅者异常不影响测试 */ } });
    },
    chatListeners: () => listeners.chat.length,
    openSettings: async () => { ui.setView('settings'); await flush(); await flush(); await flush(); },
    openChat: async () => { ui.setView('chat'); await flush(); await flush(); await flush(); },
    /** 当前仍在挂着的周期回调数（app.js 的 setInterval 句柄）。 */
    timerCount: () => timers.size,
    /** 手动把所有挂着的周期回调各触发一次（等价于时间前进一步），返回触发次数。 */
    backupTick: async () => {
      const fns = [...timers];
      for (const fn of fns) {
        try { fn(); } catch (e) { /* 单个回调异常不中断推进 */ }
      }
      await flush();
      return fns.length;
    },
    flush,
    plain
  };
}

module.exports = {
  ROOT,
  HTML_PATH, APP_PATH, API_PATH, VIRTUAL_PATH, STYLES_PATH,
  html, appSrc, apiSrc, virtualSrc, stylesSrc,
  loadApi, fakeQk, bootApp, flush, plain, clone,
  Document, Element,
  BASE_AGENT_STATUS, BASE_JOURNAL, BASE_MCP,
  UNCONFIGURED_CHAT, CONFIGURED_CHAT
};
