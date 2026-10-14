/**
 * Probe the Quark cloud drive API using a decrypted cookie jar.
 * Read-only endpoints only.
 *
 * usage: node probe_api.js <decrypted_cookies.json> [baseUrl]
 */
const fs = require('fs');

const [, , cookiesPath] = process.argv;
const jar = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));

const PC_BASE = 'https://drive-pc.quark.cn';
const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 QuarkPC/7.3.5.1009';

function cookieHeaderFor(host) {
  // include cookies whose host matches the target host or is a parent domain of it
  const parts = host.split('.');
  const out = [];
  for (const c of jar) {
    if (!c.value) continue;
    const h = c.host.replace(/^\./, '');
    const isParent = parts.slice(parts.length - h.split('.').length).join('.') === h;
    if (host === h || host.endsWith('.' + h) || isParent) out.push(`${c.name}=${c.value}`);
  }
  return out.join('; ');
}

const COMMON = 'pr=ucpro&fr=pc&uc_param_str=';

async function call(label, url) {
  const host = new URL(url).host;
  const ck = cookieHeaderFor(host);
  const started = Date.now();
  let res, text;
  try {
    res = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: 'https://pan.quark.cn/',
        origin: 'https://pan.quark.cn',
        'user-agent': PC_UA,
        cookie: ck,
      },
    });
    text = await res.text();
  } catch (e) {
    console.log(`\n### ${label}\n  ${url}\n  NETWORK ERROR: ${e.message}`);
    return null;
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-json */
  }
  const code = body?.code ?? body?.status ?? '';
  console.log(`\n### ${label}`);
  console.log(`  ${url}`);
  console.log(`  http=${res.status} code=${code} msg=${body?.message ?? ''} ${Date.now() - started}ms`);
  console.log(`  cookieNames=[${ck.split('; ').map((s) => s.split('=')[0]).join(',')}]`);
  const shown = text.length > 900 ? text.slice(0, 900) + '…' : text;
  console.log(`  body: ${shown}`);
  return { status: res.status, body };
}

(async () => {
  await call('config', `${PC_BASE}/1/clouddrive/config?${COMMON}`);
  await call(
    'file/sort root',
    `${PC_BASE}/1/clouddrive/file/sort?${COMMON}pdir_fid=0&_page=1&_size=10&_fetch_total=1&_sort=file_type:asc,updated_at:desc`
  );
  await call('member', `${PC_BASE}/1/clouddrive/member?${COMMON}`);
  await call('quota/remain', `${PC_BASE}/1/clouddrive/quota/remain?${COMMON}`);
  await call('account/info', `${PC_BASE}/account/info?fr=pc&platform=pc`);
  await call('auth/pc/flush', `${PC_BASE}/1/clouddrive/auth/pc/flush?${COMMON}`);
})();
