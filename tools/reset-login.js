'use strict';
/**
 * 清理测试残留 + 清空登录态。
 *
 * 步骤：
 *   1. 用当前（错误的）账号删除测试过程中创建的目录 qk-e2e-* / qk-repro-*
 *   2. 清空本地登录态（session.bin 中的 Cookie），以便重新登录正确账号
 *
 * 用法：
 *   node tools/reset-login.js --clean-only   # 只清理测试残留，不清登录态
 *   node tools/reset-login.js                # 清理 + 清空登录态
 */
const path = require('path');
const fs = require('fs');

const S = path.join(__dirname, '..', 'src', 'main');
const { createSecureStore } = require(path.join(S, 'core', 'secure-store.js'));
const { createSession } = require(path.join(S, 'core', 'session.js'));
const { HttpClient } = require(path.join(S, 'core', 'http.js'));

const COMMON = { pr: 'ucpro', fr: 'pc', uc_param_str: '' };
const CLEAN_ONLY = process.argv.includes('--clean-only');
const DELETE_FIDS = new Set((process.argv.find(a=>a.startsWith('--delete-fids='))||'').slice(14).split(',').filter(Boolean));

const PREFIXES = ['qk-e2e-', 'qk-repro-'];

(async () => {
  const dir = path.join(process.env.APPDATA || '', 'quark-mini');
  const store = createSecureStore({ userDataDir: dir, requireEncryption: true });
  const s = createSession({ store }).load();

  console.log('=== 步骤 1：清理测试残留 ===');
  if (!s.isLoggedIn()) {
    console.log('  当前未登录，跳过远端清理。');
  } else {
    const http = new HttpClient({ getCookie: () => s.getCookie() });
    let targets = [];
    try {
      // 翻页取根目录全部条目，找出测试前缀
      for (let page = 1; page <= 10; page += 1) {
        const env = await http.get('/1/clouddrive/file/sort', {
          ...COMMON, pdir_fid: '0', _page: page, _size: 100, _fetch_total: 1,
        });
        const list = (env.data && env.data.list) || [];
        for (const it of list) {
          if (PREFIXES.some((p) => String(it.file_name || '').startsWith(p))) {
            targets.push({ fid: it.fid, name: it.file_name, dir: !!it.dir });
          }
        }
        const total = env.metadata && env.metadata.total;
        if (!list.length || (total && page * 100 >= total)) break;
      }
    } catch (e) {
      console.log('  列举根目录失败：', e.message);
    }

    if (targets.length && !DELETE_FIDS.size) console.log('未指定 --delete-fids=精确ID列表；名称前缀不能证明归属，未执行远端删除。');
    targets = targets.filter(t => DELETE_FIDS.has(String(t.fid)));
    if (!targets.length) {
      console.log('  未发现测试残留（qk-e2e-* / qk-repro-*）。');
    } else {
      console.log(`  发现 ${targets.length} 个测试项：`);
      for (const t of targets) console.log(`    - ${t.name}${t.dir ? '（文件夹）' : ''}  ${t.fid}`);

      // 先删除文件夹内部（mkdir 产生的目录通常是空的，但稳妥起见先递归一层）
      for (const t of targets.filter((x) => x.dir)) {
        try {
          const inner = await http.get('/1/clouddrive/file/sort', {
            ...COMMON, pdir_fid: t.fid, _page: 1, _size: 200, _fetch_total: 1,
          });
          const innerFids = ((inner.data && inner.data.list) || []).map((x) => x.fid);
          if (innerFids.length) {
            await http.post('/1/clouddrive/file/delete',
              { action_type: 2, filelist: innerFids, exclude_fids: [] }, { query: COMMON });
            console.log(`    · 已删除 ${t.name} 内 ${innerFids.length} 个子项`);
          }
        } catch (e) {
          console.log(`    · 清理 ${t.name} 内部失败：${e.message}`);
        }
      }

      try {
        await http.post('/1/clouddrive/file/delete',
          { action_type: 2, filelist: targets.map((t) => t.fid), exclude_fids: [] }, { query: COMMON });
        console.log(`  ✓ 已提交删除 ${targets.length} 个测试项（进入回收站）`);
      } catch (e) {
        console.log('  ✗ 删除失败：', e.code, e.message);
      }
    }
  }

  if (CLEAN_ONLY) {
    console.log('\n（--clean-only 模式，未清空登录态）');
    return;
  }

  console.log('\n=== 步骤 2：清空登录态 ===');
  const before = s.getCookie().split('; ').filter(Boolean).length;
  s.clear();
  s.clearExpired();
  try {
    s.save();
  } catch {
    /* 若 save 在无凭据时不写文件，忽略 */
  }
  const after = s.getCookie().split('; ').filter(Boolean).length;
  console.log(`  cookie: ${before} → ${after}`);

  const sessionFile = path.join(dir, 'session.bin');
  if (fs.existsSync(sessionFile)) {
    console.log(`\n  \x1b[90m提示：${sessionFile} 仍存在（用于保存设置等），其中已不含 Cookie。\x1b[0m`);
  }
  console.log('\n\x1b[32m✓ 登录态已清空。\x1b[0m');
  console.log('\n现在可以重新登录正确账号：\n\n    npm run login\n');
})();
