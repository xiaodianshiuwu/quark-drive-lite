'use strict';
/**
 * 可行性验证：CDP 连接官方夸克客户端，读取侧边栏导航 DOM，
 * 确认能否定位并隐藏 AI / 分享 / 同步盘 / 推广 等无用项。
 * 全程只读 + 一次 DOM 只读快照，不改任何数据。
 */
const PORT = 9777;

async function getTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) { const p = c.pending.get(m.id); if (p) { c.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } }
    };
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.value; }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  const list = await getTargets();
  const page = list.find(t => t.type === 'page' && /clouddrive\/renderer\/index/.test(t.url));
  if (!page) { console.log('未找到夸克网盘主窗口'); process.exit(1); }
  console.log('主窗口:', page.url);

  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 读取侧边栏所有导航项的文本（只读）
  const navs = await cdp.eval(`(() => {
    const aside = document.querySelector('aside') || document.querySelector('[class*=aside]') || document.querySelector('[class*=sider]');
    if (!aside) return { found: false, bodyClass: document.body.className, sample: document.body.innerText.slice(0,300) };
    const items = [...aside.querySelectorAll('*')].filter(el => el.children.length === 0 && el.innerText && el.innerText.trim().length < 12)
      .map(el => el.innerText.trim());
    return { found: true, items: [...new Set(items)] };
  })()`);

  console.log('侧边栏探测:', JSON.stringify(navs, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
