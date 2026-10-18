'use strict';
/**
 * test/tauri-backup-ui.test.js —— 「备份」视图测试（Phase-2）
 *
 * 覆盖：
 *  A. 静态契约：index.html 的 id 与 app.js 引用一致；视图/导航存在；无 innerHTML 动态注入。
 *  B. 桥接契约：CONTRACT 登记 6 个 backup.*；tauri-bridge 提供 6 个方法；假桥参数转发。
 *  C. 交互：选目录 → 预览 → 开始 → 状态网格轮询 → 验证渲染 → 取消；轮询随视图隐藏停止。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  html, appSrc, apiSrc, stylesSrc,
  loadApi, bootApp, flush, plain, Document, Element, clone
} = require('./renderer-harness');

const BACKUP_IDS = [
  'view-backup', 'backup-wizard', 'backup-pick-dir', 'backup-root', 'backup-target',
  'backup-plan', 'backup-start', 'backup-plan-result',
  'backup-run', 'backup-stats', 'backup-retry', 'backup-cancel', 'backup-verify',
  'backup-verify-result',
];

/* ------------------------------ A. 静态契约 ------------------------------ */

test('A1: index.html 含备份导航与全部视图 id，app.js 引用一致', () => {
  for (const id of BACKUP_IDS) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺 id=${id}`);
  }
  assert.ok(html.includes('data-view="backup"'), '导航缺少备份按钮');
  for (const id of ['backup-root', 'backup-target', 'backup-stats']) {
    assert.ok(appSrc.includes(`'${id}'`), `app.js 未引用 ${id}`);
  }
});

test('A2: 备份渲染不使用 innerHTML（安全红线）', () => {
  const backupPart = appSrc.slice(appSrc.indexOf('重装前备份（Phase-2）'), appSrc.indexOf('function setView('));
  assert.ok(backupPart.length > 1000, '备份逻辑块存在');
  assert.ok(!backupPart.includes('innerHTML'), '备份逻辑不得使用 innerHTML');
});

test('A3: 样式含 backup-grid', () => {
  assert.ok(stylesSrc.includes('.backup-grid'));
});

/* ------------------------------ B. 桥接契约 ------------------------------ */

test('B1: CONTRACT 登记 6 个 backup.* 方法', () => {
  const api = loadApi();
  for (const m of ['plan', 'start', 'status', 'retry', 'cancel', 'verify']) {
    assert.equal(api.CONTRACT['backup.' + m], 1, `CONTRACT 缺 backup.${m}`);
  }
});

test('B2: tauri-bridge.js 循环注册 backup 方法', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'tauri-bridge.js'), 'utf8');
  assert.ok(bridge.includes("'backup.' + name"), 'bridge 应循环注册 backup 方法');
  assert.ok(bridge.includes("api.backup = {}"), 'bridge 应创建 backup 命名空间');
});

test('B3: 假桥调用参数转发', async () => {
  const inst = await bootApp({ backupImpl: { plan: { files: 8 } } });
  const r = await inst.qk.backup.plan({ rootDir: '/x', targetFid: '0' });
  assert.equal(r.files, 8);
  assert.ok(inst.calls.some((c) => c.ns === 'backup' && c.name === 'plan'
    && c.args[0].rootDir === '/x'), 'plan 参数应转发');
});

/* ------------------------------ C. 交互 ------------------------------ */

async function openBackup(opts = {}) {
  const inst = await bootApp(Object.assign({ backupRunning: false }, opts));
  inst.ui.setView('backup');
  await flush();
  return inst;
}

test('C1: 选目录 → 预览显示统计并解锁开始按钮', async () => {
  const inst = await openBackup();
  const doc = inst.doc;
  await inst.click('backup-pick-dir');
  await flush();
  await inst.click('backup-plan');
  await flush();
  const result = inst.$('backup-plan-result');
  assert.equal(result.hidden, false, '预览结果应显示');
  assert.ok(result.textContent.includes('8'), '预览应含文件数');
  assert.equal(inst.$('backup-start').disabled, false, '开始按钮解锁');
});

test('C2: 开始备份 → 运行区出现并轮询状态网格', async () => {
  const inst = await openBackup({ backupRunning: true });
  const doc = inst.doc;
  inst.$('backup-root').value = '/data';
  await inst.click('backup-start');
  await flush();
  assert.equal(inst.$('backup-run').hidden, false, '运行区显示');
  await flush();
  const grid = inst.$('backup-stats');
  assert.ok(grid.textContent.includes('成功'), '网格含成功标签');
  assert.ok(grid.textContent.includes('6'), '网格含计数');
});

test('C3: 验证结果渲染（verified 徽章文本）', async () => {
  const inst = await openBackup({ backupRunning: true });
  const doc = inst.doc;
  await inst.click('backup-verify');
  await flush();
  const box = inst.$('backup-verify-result');
  assert.equal(box.hidden, false);
  assert.ok(box.textContent.includes('verified'), '应显示状态');
  assert.ok(box.textContent.includes('8/8'), '应显示清单一致性');
});

test('C4: 取消 → 运行区隐藏且发出 cancel 调用', async () => {
  const inst = await openBackup({ backupRunning: true });
  const doc = inst.doc;
  await inst.click('backup-cancel');
  await flush();
  assert.ok(inst.calls.some((c) => c.ns === 'backup' && c.name === 'cancel'), '应调用 cancel');
});

test('C5: 视图离开时停止轮询（status 调用数不再增长）', async () => {
  const inst = await openBackup({ backupRunning: true });
  const doc = inst.doc;
  const before = inst.calls.filter((c) => c.ns === 'backup' && c.name === 'status').length;
  inst.ui.setView('files');
  await new Promise((r) => setTimeout(r, 2200)); // 超过一个轮询周期
  await flush();
  const after = inst.calls.filter((c) => c.ns === 'backup' && c.name === 'status').length;
  assert.ok(after <= before + 1, `隐藏后轮询应停止（before=${before} after=${after}）`);
});

test('C6: 部分验证（partial）issues 以 textContent 列出，无 HTML 注入', async () => {
  const partial = {
    status: 'partial', totalSuccess: 8, listedOk: 7, listedMissing: 1, sizeMismatch: 0,
    sampleRequested: 8, sampleChecked: 8, sampleOk: 8, sampleMismatch: 0,
    issues: [{ kind: 'missing', rel_path: 'a<b>.txt', detail: '远端目录中未见同名文件' }],
  };
  const inst = await openBackup({ backupRunning: true, backupImpl: { verify: partial } });
  const doc = inst.doc;
  await inst.click('backup-verify');
  await flush();
  const box = inst.$('backup-verify-result');
  assert.ok(box.textContent.includes('partial'));
  assert.ok(box.textContent.includes('a<b>.txt'), '文件名以文本显示');
  assert.ok(!box.querySelector('script'), '不得产生脚本节点');
});
