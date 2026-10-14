'use strict';
/** 查询真实账号的容量与会员信息（用已实测可用的端点）。 */
const path = require('path');
const S = path.join(__dirname, '..', 'src', 'main');
const { createSecureStore } = require(path.join(S, 'core', 'secure-store.js'));
const { createSession } = require(path.join(S, 'core', 'session.js'));
const { HttpClient } = require(path.join(S, 'core', 'http.js'));

const COMMON = { pr: 'ucpro', fr: 'pc', uc_param_str: '' };

(async () => {
  const dir = path.join(process.env.APPDATA || '', 'quark-mini');
  const store = createSecureStore({ userDataDir: dir, requireEncryption: true });
  const s = createSession({ store }).load();
  const http = new HttpClient({ getCookie: () => s.getCookie() });

  const show = (label, v) => console.log(`  ${label}: ${v}`);

  // member：容量与会员信息通常在这里
  try {
    const e = await http.get('/1/clouddrive/member', COMMON);
    const d = e.data || {};
    console.log('=== /1/clouddrive/member ===');
    // 只打印与容量/会员相关的键，避免刷屏
    const KEEP = /(?:space|capacity|size|quota|used|total|member|vip|subscribe|expire)/i;
    for (const k of Object.keys(d)) {
      if (KEEP.test(k)) show(k, JSON.stringify(d[k]).slice(0, 120));
    }
  } catch (e) {
    console.log('member 失败:', e.code, e.message);
  }

  // quota/remain 带 type 参数（官方客户端有 type=DL_FLOW 用法）
  for (const q of [{}, { type: 'DL_FLOW' }]) {
    try {
      const e = await http.get('/1/clouddrive/quota/remain', { ...COMMON, ...q });
      console.log(`\n=== quota/remain ${JSON.stringify(q)} ===`);
      show('data', JSON.stringify(e.data).slice(0, 300));
    } catch (err) {
      console.log(`\nquota/remain ${JSON.stringify(q)} 失败:`, err.code, err.message);
    }
  }

  // 存储详情（官方客户端存在 storage/detail）
  for (const p of ['/1/clouddrive/storage/detail', '/1/clouddrive/quota/use']) {
    try {
      const e = await http.get(p, COMMON);
      console.log(`\n=== ${p} ===`);
      show('data', JSON.stringify(e.data).slice(0, 300));
    } catch (err) {
      console.log(`\n${p} 失败:`, err.code, err.message);
    }
  }
})();
