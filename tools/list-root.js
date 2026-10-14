'use strict';
/** 列出根目录条目，并标出测试残留（qk-*）。 */
const path = require('path');
const S = path.join(__dirname, '..', 'src', 'main');
const { createSecureStore } = require(path.join(S, 'core', 'secure-store.js'));
const { createSession } = require(path.join(S, 'core', 'session.js'));
const { HttpClient } = require(path.join(S, 'core', 'http.js'));

const COM = { pr: 'ucpro', fr: 'pc', uc_param_str: '' };

(async () => {
  const dir = path.join(process.env.APPDATA || '', 'quark-mini');
  const s = createSession({ store: createSecureStore({ userDataDir: dir, requireEncryption: true }) }).load();
  const http = new HttpClient({ getCookie: () => s.getCookie() });

  const l = await http.get('/1/clouddrive/file/sort', {
    ...COM, pdir_fid: '0', _page: 1, _size: 200, _fetch_total: 1,
  });
  const list = l.data.list || [];
  const names = list.map((x) => x.file_name);
  const left = names.filter((n) => /^qk-/.test(n));

  console.log(`根目录共 ${names.length} 项:`);
  names.forEach((n, i) => console.log(`  ${String(i + 1).padStart(3)}. ${n}`));
  console.log(`\n残留测试项（qk-*）: ${left.length ? left.join(', ') : '无 ✓'}`);
})();
