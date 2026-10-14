'use strict';
/** 用真实 userData 目录直读会话并对真实接口判活（排错用）。 */
const path = require('path');

const R = path.join(__dirname, '..');
const S = path.join(R, 'src', 'main');
const { createSecureStore } = require(path.join(S, 'core', 'secure-store.js'));
const { createSession } = require(path.join(S, 'core', 'session.js'));
const { HttpClient } = require(path.join(S, 'core', 'http.js'));

(async () => {
  const dir = path.join(process.env.APPDATA || process.env.HOME || '', 'quark-mini');
  console.log('userData 目录:', dir);
  const store = createSecureStore({ userDataDir: dir, requireEncryption: true });
  const s = createSession({ store }).load();
  const ck = s.getCookie();
  const names = ck.split('; ').filter(Boolean).map((x) => x.split('=')[0]);
  console.log('  isLoggedIn :', s.isLoggedIn());
  console.log('  cookie 数量:', names.length);
  console.log('  cookie 名  :', names.join(', '));

  const http = new HttpClient({ getCookie: () => s.getCookie() });
  try {
    const env = await http.get('/1/clouddrive/config', { pr: 'ucpro', fr: 'pc', uc_param_str: '' });
    console.log('  判活 code  :', env.code, ' status:', env.status);
  } catch (e) {
    console.log('  判活失败:', e.code, e.message);
  }
})();
