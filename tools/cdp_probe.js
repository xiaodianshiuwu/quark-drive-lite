/**
 * Validate the CDP cookie-harvest mechanism:
 *  1. launch a real Chromium (Edge) with a dedicated user-data-dir + remote debugging
 *  2. attach to the page target over WebSocket
 *  3. navigate to pan.quark.cn
 *  4. read every cookie Chromium holds for quark domains via Network.getAllCookies
 *
 * usage: node cdp_probe.js
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9444;
const PROFILE = path.join(os.tmpdir(), 'qck_cdp_probe_profile');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('devtools endpoint never came up');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else if (msg.method) {
        const hs = this.handlers.get(msg.method) || [];
        for (const h of hs) h(msg.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
    return new CDP(ws);
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const child = spawn(
    EDGE,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeSyncConfirmationDialog',
      '--window-size=1200,860',
      'about:blank',
    ],
    { detached: false, stdio: 'ignore' }
  );

  let cdp;
  try {
    const ver = await waitForDevtools(PORT);
    console.log('devtools up:', ver.Browser);

    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    console.log('attached to:', page.url);

    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
    await cdp.send('Page.navigate', { url: 'https://pan.quark.cn/' });
    await Promise.race([loaded, sleep(25000)]);
    await sleep(3000);

    const title = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    console.log('page title:', title.result.value);

    const { cookies } = await cdp.send('Network.getAllCookies');
    const quark = cookies.filter((c) => /quark|uc\.cn/i.test(c.domain));
    console.log(`\ntotal cookies: ${cookies.length}, quark cookies: ${quark.length}`);
    for (const c of quark) {
      const v = c.value.length > 50 ? `${c.value.slice(0, 30)}…(${c.value.length})` : c.value;
      console.log(`  ${c.domain.padEnd(28)} ${c.name.padEnd(24)} len=${String(c.value.length).padStart(4)} HttpOnly=${c.httpOnly} = ${v}`);
    }
  } catch (e) {
    console.error('PROBE FAILED:', e.message);
  } finally {
    if (cdp) cdp.close();
    await sleep(500);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
})();
