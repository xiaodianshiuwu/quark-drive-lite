'use strict';
/**
 * 最小复现：用真实会话直接调 mkdir，打印服务端原始响应与 code/message。
 * 用于定位「新建目录时报登录失效」的真实原因（不经过 Electron，排除 IPC 干扰）。
 */
const path = require('path');
const S = path.join(__dirname, '..', 'src', 'main');
const { createSecureStore } = require(path.join(S, 'core', 'secure-store.js'));
const { createSession } = require(path.join(S, 'core', 'session.js'));
const { HttpClient, DEFAULT_UA } = require(path.join(S, 'core', 'http.js'));

const COMMON = { pr: 'ucpro', fr: 'pc', uc_param_str: '' };

(async () => {
  const dir = path.join(process.env.APPDATA || '', 'quark-mini');
  const store = createSecureStore({ userDataDir: dir, requireEncryption: true });
  const s = createSession({ store }).load();
  console.log('已登录:', s.isLoggedIn(), 'cookie:', s.getCookie().split('; ').filter(Boolean).length, '个');

  const http = new HttpClient({
    getCookie: () => s.getCookie(),
    onSetCookie: (sc) => {
      console.log('  [Set-Cookie 收到]', sc.length, '条');
      for (const c of sc) {
        const name = String(c).split('=')[0];
        console.log('     -', name, '=', String(c).slice(0, 60));
      }
      s.applySetCookie(sc);
      s.save();
    },
  });

  // 1) 先看判活
  try {
    const env = await http.get('/1/clouddrive/config', COMMON);
    console.log('\n1) config: code=', env.code, 'status=', env.status);
  } catch (e) {
    console.log('\n1) config 失败:', e.code, e.message);
  }

  // 2) 列目录
  try {
    const env = await http.get('/1/clouddrive/file/sort', { ...COMMON, pdir_fid: '0', _page: 1, _size: 5, _fetch_total: 1 });
    console.log('2) sort: code=', env.code, '共', (env.data && env.data.list || []).length, '项 total=', env.metadata && env.metadata.total);
  } catch (e) {
    console.log('2) sort 失败:', e.code, e.message);
  }

  // 3) mkdir —— 关键
  const name = `qk-repro-${Date.now()}`;
  console.log('\n3) mkdir:', name);
  try {
    const env = await http.post('/1/clouddrive/file', {
      pdir_fid: '0', file_name: name, dir_path: '', dir_init_lock: false,
    }, { query: COMMON });
    console.log('   成功 code=', env.code, ' data=', JSON.stringify(env.data).slice(0, 200));
  } catch (e) {
    console.log('   失败 code=', e.code, ' bizCode=', e.bizCode, ' http=', e.httpStatus);
    console.log('   message=', e.message);
    console.log('   raw=', typeof e.raw === 'string' ? e.raw.slice(0, 400) : JSON.stringify(e.raw));
  }
})();
