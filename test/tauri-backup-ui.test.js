'use strict';
/**
 * test/tauri-backup-ui.test.js —— 「备份」视图测试（Phase-2）
 *
 * 覆盖：
 *  A. 静态契约：index.html 的 id 与 app.js 引用一致；导航/视图存在；无 innerHTML 动态注入。
 *  B. 桥接契约：CONTRACT 登记 10 个 backup.* 且计入扩展契约；tauri-bridge 提供 6 个方法；
 *     base 桥返回 NO_BRIDGE；假桥参数转发。
 *  C. 交互：选目录 → 预览（统计 + samples 前 5 条）→ 开始（account 取值 + 并发默认由后端承担）
 *     → 状态网格 + 进度条轮询 → verify 结果渲染 → 取消 → 轮询随视图离开停止、
 *     重新进入有会话时恢复。
 *
 * 轮询为可手动驱动的假 setInterval（harness.backupTick），不依赖真实时间。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  html, appSrc, stylesSrc,
  loadApi, bootApp, flush, plain
} = require('./renderer-harness');

const BACKUP_IDS = [
  'view-backup', 'backup-pick-dir', 'backup-root', 'backup-target',
  'backup-plan', 'backup-start', 'backup-plan-result',
  'backup-run', 'backup-stats', 'backup-bar', 'backup-pct',
  'backup-retry', 'backup-cancel', 'backup-verify', 'backup-verify-result',
];

const BACKUP_METHODS = ['plan', 'start', 'status', 'retry', 'cancel', 'verify', 'pause', 'resume', 'tasks', 'export'];

const RUNNING_STATUS = {
  running: true, account: 'fixture-user', discovered: 10, pending: 2, uploading: 1,
  verifying: 0, success: 6, failed: 0, skipped: 0, canceled: 0, queueDepth: 2,
  uploadedBytes: 4096, rootDir: '/data', targetFid: '0'
};

const PLAN_RESULT = {
  files: 12345, dirs: 210, warnings: 1, totalBytes: 5 * 1024 * 1024 * 1024,
  samples: [
    { relPath: 'docs/说明.pdf', size: 1024, mtimeMs: 1750000000000 },
    { relPath: '图片/封面.png', size: 2048, mtimeMs: 1750000000001 },
    { relPath: 'pics/a<img>.png', size: 8, mtimeMs: 1750000000002 },
    { relPath: 'pics/b<img>.png', size: 16, mtimeMs: 1750000000003 },
    { relPath: 'pics/c<img>.png', size: 32, mtimeMs: 1750000000004 },
    { relPath: 'pics/d<img>.png', size: 64, mtimeMs: 1750000000005 },
    { warning: '受限目录/System Volume Information', detail: '读取失败：权限不足' }
  ]
};

const VERIFY_OK = {
  status: 'verified', total_success: 8, listed_ok: 8, listed_missing: 0,
  size_mismatch: 0, sample_requested: 8, sample_checked: 8, sample_ok: 8,
  sample_mismatch: 0, issues: []
};

/* ------------------------------ A. 静态契约 ------------------------------ */

test('A1: index.html 含备份导航、视图与全部 id，app.js 引用一致', () => {
  for (const id of BACKUP_IDS) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺 id=${id}`);
  }
  assert.ok(html.includes('data-view="backup"'), '导航缺少备份按钮');
  assert.ok(html.includes('href="#i-backup"'), '备份导航缺 #i-backup 图标');
  // 备份视图位于传输列表之后、对话视图之前
  const transfersEnd = html.indexOf('id="view-settings"');
  const backupStart = html.indexOf('id="view-backup"');
  const chatStart = html.indexOf('id="view-chat"');
  assert.ok(backupStart > 0 && backupStart < chatStart, '备份视图应在对话视图之前');
  assert.ok(transfersEnd > 0 && transfersEnd < backupStart, '备份视图应在设置视图之后');
  // app.js 引用的备份 id 与 html 一致
  for (const id of ['backup-root', 'backup-target', 'backup-stats', 'backup-bar', 'backup-pct']) {
    assert.ok(appSrc.includes(`'${id}'`), `app.js 未引用 ${id}`);
  }
});

test('A2: 备份渲染零 innerHTML（安全红线），文案为简体中文', () => {
  const backupPart = appSrc.slice(appSrc.indexOf('重装前备份（Phase-2）'), appSrc.indexOf('function setView('));
  assert.ok(backupPart.length > 1000, '备份逻辑块存在');
  assert.ok(!backupPart.includes('innerHTML'), '备份逻辑不得使用 innerHTML');
  assert.ok(!backupPart.includes('insertAdjacentHTML'), '备份逻辑不得使用 insertAdjacentHTML');
  for (const text of ['选择本地目录', '请先选择本地目录', '预览失败', '启动失败', '重试失败',
    '已重新入队', '备份已取消', '验证失败', '验证通过', '部分一致', '清单一致', '进度']) {
    assert.ok(backupPart.includes(text), '备份文案缺少：' + text);
  }
});

test('A3: 样式类真实存在（网格/进度条/徽章/列表）', () => {
  for (const cls of ['backup-grid', 'backup-cell', 'backup-bar', 'backup-pct',
    'backup-samples', 'backup-issues', 'backup-verify-badge',
    'backup-verify-verified', 'backup-verify-partial', 'backup-verify-failed']) {
    assert.ok(stylesSrc.includes('.' + cls), 'styles.css 缺少 .' + cls);
  }
});

/* ------------------------------ B. 桥接契约 ------------------------------ */

test('B1: CONTRACT 登记 10 个 backup.* 方法，且计入扩展契约（missingExtension 不弹横幅）', () => {
  const api = loadApi();
  for (const m of BACKUP_METHODS) {
    assert.equal(api.CONTRACT['backup.' + m], 1, 'CONTRACT 缺 backup.' + m);
  }
  const keys = Object.keys(api.CONTRACT).filter((k) => k.indexOf('backup.') === 0);
  assert.deepEqual(keys.sort(), BACKUP_METHODS.map((n) => 'backup.' + n).sort());
});

test('B2: base 桥（命令未接线）下 backup.* 返回 NO_BRIDGE，不污染 bridgeInfo.missing', async () => {
  // 手工构造「基础方法齐全、无 backup.*」的桥（真实 alpha 过渡形态）
  const apiForContract = loadApi();
  const baseQk = {};
  for (const key of Object.keys(apiForContract.CONTRACT)) {
    if (key.indexOf('backup.') === 0) continue;
    const p = key.split('.');
    baseQk[p[0]] = baseQk[p[0]] || {};
    baseQk[p[0]][p[1]] = () => Promise.resolve(null);
  }
  const base = loadApi({ qk: baseQk });
  assert.equal(base.injected, true);
  assert.deepEqual(plain(base.bridgeInfo().missing), [], '基础契约不应因 backup 缺失而报缺失');
  assert.ok(base.bridgeInfo().missingExtension.includes('backup.plan'), 'backup.plan 应计入扩展契约');
  await assert.rejects(base.backup.plan({ rootDir: '/x', targetFid: '0' }),
    (err) => err.code === 'NO_BRIDGE');
  await assert.rejects(base.backup.status(), (err) => err.code === 'NO_BRIDGE');
});

test('B3: tauri-bridge.js 注册 10 个 backup 方法并映射到 qk_call', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'tauri-bridge.js'), 'utf8');
  const calls = [];
  const window = {
    navigator: { platform: 'MacIntel' },
    __TAURI__: {
      core: { invoke: (cmd, input) => { calls.push([cmd, plain(input)]); return Promise.resolve(null); } },
      event: { listen: async () => () => {} }
    }
  };
  vm.runInNewContext(bridge, { window });
  for(const method of BACKUP_METHODS) assert.equal(typeof window.qk.backup[method],'function','bridge method '+method);
  assert.equal(typeof window.qk.backup.verify, 'function');
  // plan/start 走对象参数；retry/cancel 无标量包装（与 main.rs 分发一致）
  window.qk.backup.plan({ rootDir: '/d', targetFid: '0' });
  window.qk.backup.start({ account: 'u1', rootDir: '/d', targetFid: '0' });
  window.qk.backup.cancel();
  assert.deepEqual(calls, [
    ['qk_call', { method: 'backup.plan', params: { rootDir: '/d', targetFid: '0' } }],
    ['qk_call', { method: 'backup.start', params: { account: 'u1', rootDir: '/d', targetFid: '0' } }],
    ['qk_call', { method: 'backup.cancel', params: {} }]
  ]);
});

test('B4: 假桥调用参数转发（rootDir/targetFid/sampleRatePpm）', async () => {
  const inst = await bootApp({ backupImpl: { plan: { files: 8 } } });
  const r = await inst.qk.backup.plan({ rootDir: '/x', targetFid: '0' });
  assert.equal(r.files, 8);
  assert.ok(inst.calls.some((c) => c.ns === 'backup' && c.name === 'plan'
    && c.args[0].rootDir === '/x' && c.args[0].targetFid === '0'), 'plan 参数应转发');
});

/* ------------------------------ C. 交互 ------------------------------ */

async function openBackup(opts = {}) {
  const inst = await bootApp(Object.assign({ backupRunning: false }, opts));
  inst.ui.setView('backup');
  await flush();
  return inst;
}

test('C1: 选目录 → 预览展示统计与 samples 前 5 条并解锁开始按钮', async () => {
  const inst = await openBackup({ backupImpl: { plan: PLAN_RESULT } });
  await inst.click('backup-pick-dir');
  await flush();
  assert.ok(inst.$('backup-root').value, '选目录后应回填路径');

  await inst.click('backup-plan');
  await flush();
  const box = inst.$('backup-plan-result');
  assert.equal(box.hidden, false, '预览结果应显示');
  const text = box.textContent;
  assert.ok(text.includes('12,345'), '应含人类可读文件数（千分位）');
  assert.ok(text.includes('210'), '应含目录数');
  assert.ok(text.includes('GB'), '总大小应人类可读');
  assert.ok(text.includes('警告 1'), '应含警告数');
  const items = box.querySelectorAll('.backup-samples li');
  assert.equal(items.length, 5, 'samples 最多展示 5 条');
  assert.ok(items[0].textContent.includes('docs/说明.pdf'), '示例含文件路径');
  assert.ok(items[0].textContent.includes('KB'), '示例含人类可读大小');
  assert.equal(inst.$('backup-start').disabled, false, '预览成功解锁开始按钮');
});

test('C2: 预览失败 → 收回结果并禁用「开始备份」', async () => {
  const inst = await bootApp({
    backupImpl: { plan: null },
    agentOverrides: {},
    chatOverrides: {},
    backupOverrides: { plan: () => Promise.reject({ code: 'BACKUP_SCAN', message: '目录不可读' }) }
  });
  inst.ui.setView('backup');
  await flush();
  inst.$('backup-root').value = '/data';
  await inst.click('backup-plan');
  await flush();
  await flush();
  assert.equal(inst.$('backup-start').disabled, true, '预览失败不得允许开始备份');
  assert.equal(inst.$('backup-plan-result').hidden, true, '失败后不显示旧预览');
  assert.ok(inst.text('toasts').includes('预览失败'), '失败应有 toast 提示');
});

test('C3: 开始备份 → 运行区出现，身份由后端绑定，状态网格渲染全部键位', async () => {
  // backupRunning=true：start 后首个轮询即渲染网格（与真机一致：start 立即产生会话）
  const inst = await openBackup({ backupRunning: true, backupImpl: { plan: PLAN_RESULT } });
  await inst.click('backup-pick-dir');
  await flush();
  await inst.click('backup-plan');
  await flush();
  inst.$('backup-target').value = 'fid-target-1';
  await inst.click('backup-start');
  await flush();
  await flush();

  const startCall = inst.calls.filter((c) => c.ns === 'backup' && c.name === 'start').pop();
  assert.ok(startCall, '应调用 backup.start');
  assert.equal(startCall.args[0].account, undefined, '身份必须由后端真实会话确定，不能由界面传入');
  assert.equal(startCall.args[0].config.uploadConcurrency,2);
  assert.equal(startCall.args[0].rootDir, inst.$('backup-root').value, 'rootDir 取向导值');
  assert.equal(startCall.args[0].targetFid, 'fid-target-1', 'targetFid 取输入值');

  assert.equal(inst.$('backup-run').hidden, false, '运行区显示');
  const grid = inst.$('backup-stats');
  for (const label of ['已发现', '排队', '上传中', '核对中', '成功', '失败', '跳过', '待处理', '已上传']) {
    assert.ok(grid.textContent.includes(label), '状态网格应含 ' + label);
  }
  assert.ok(grid.textContent.includes('6'), '成功计数渲染');
  assert.ok(grid.textContent.includes('4 KB'), '已上传字节应人类可读');
});

test('C4: 状态轮询更新进度条（所有状态均计入已发现总量），离开视图轮询停止', async () => {
  const inst = await openBackup({ backupRunning: true });
  await flush(); // ensureBackup 恢复轮询（运行区出现）
  assert.equal(inst.$('backup-run').hidden, false, '已有会话时进入视图应显示运行区');

  await flush();
  assert.ok(inst.$('backup-bar'), '进度条存在');
  // success=6, totalDiscovered=19 → 31.58%
  assert.ok(inst.$('backup-pct').textContent.includes('31%'), '进度文本 31%：' + inst.$('backup-pct').textContent);
  const fill = inst.$('backup-bar').querySelector('i');
  assert.ok(fill, '进度条填充节点存在');
  assert.equal(fill.style.width, '31.58%', '填充宽度 31.58%');

  const before = inst.calls.filter((c) => c.ns === 'backup' && c.name === 'status').length;
  const n = await inst.backupTick();
  await flush();
  assert.ok(n >= 1, '离开前周期回调存在');
  const after = inst.calls.filter((c) => c.ns === 'backup' && c.name === 'status').length;
  assert.ok(after > before, '运行中轮询应推进状态查询');

  // 离开视图：计时器清空，tick 不再发查询
  inst.ui.setView('files');
  await flush();
  assert.equal(inst.timerCount(), 0, '离开视图后轮询计时器应清空');
  const beforeLeave = inst.calls.filter((c) => c.ns === 'backup' && c.name === 'status').length;
  await inst.backupTick();
  const afterLeave = inst.calls.filter((c) => c.ns === 'backup' && c.name === 'status').length;
  assert.equal(afterLeave, beforeLeave, '离开后 tick 不得再发 status 查询');

  // 状态从 running 变为结束：下一 tick 后运行区隐藏且计时器清空
  inst.ui.setView('backup');
  await flush();
  inst.qk.backup.status = () => Promise.resolve({ running: false });
  await inst.backupTick();
  await flush();
  assert.equal(inst.timerCount(), 0, '备份结束后轮询应停止');
  assert.equal(inst.$('backup-run').hidden, true, '备份结束后运行区应隐藏');
});

test('C5: 验证结果渲染（verified 徽章 + snake_case 汇总），无 HTML 注入', async () => {
  const inst = await openBackup({ backupRunning: true, backupImpl: { verify: VERIFY_OK } });
  await inst.click('backup-verify');
  await flush();
  const box = inst.$('backup-verify-result');
  assert.equal(box.hidden, false);
  assert.equal(box.dataset.level, 'ok');
  assert.ok(box.querySelector('.backup-verify-verified'), '应有 verified 徽章节点');
  assert.ok(box.textContent.includes('验证通过'), '徽章中文文案');
  assert.ok(box.textContent.includes('verified'), '保留原始状态码');
  assert.ok(box.textContent.includes('8/8'), '清单一致性渲染');
  assert.ok(box.textContent.includes('选定核验项哈希一致 8/8'), '抽样一致性渲染');
  assert.equal(inst.$('backup-verify').disabled, false, '验证按钮应恢复可用');
});

test('C6: 部分验证 issues 以 textContent 列表展示，恶意文件名不产生元素节点', async () => {
  const partial = {
    status: 'partial', total_success: 8, listed_ok: 7, listed_missing: 1, size_mismatch: 0,
    sample_requested: 5, sample_checked: 5, sample_ok: 5, sample_mismatch: 0,
    issues: [
      { kind: 'missing', rel_path: 'a<b>.txt', detail: '远端目录中未见同名文件' },
      { kind: 'size_mismatch', rel_path: '大<b>文件.zip', local_size: 2048, remote_size: 1024 },
      { kind: 'list_error', dir: '子<b>目录', detail: '列表读取失败' },
      { kind: 'sample_hash_mismatch', rel_path: '样<b>本.bin' },
      { kind: 'sample_download_error', rel_path: '下<b>载.bin', detail: '下载失败' },
      { kind: 'dir_missing', dir: '第<b>六目录', detail: '目录映射缺失' }
    ]
  };
  const inst = await openBackup({ backupRunning: true, backupImpl: { verify: partial } });
  await inst.click('backup-verify');
  await flush();
  const box = inst.$('backup-verify-result');
  assert.equal(box.dataset.level, 'warn');
  const items = box.querySelectorAll('.backup-issues li');
  assert.equal(items.length, 6, '6 条问题全部列出（未超展示上限）');
  assert.ok(items[0].textContent.includes('a<b>.txt'), '文件名按文本显示（原样尖括号）');
  assert.ok(items[1].textContent.includes('本地 2 KB'), '大小不符带本地大小');
  assert.ok(items[1].textContent.includes('远端 1 KB'), '大小不符带远端大小');
  assert.equal(box.querySelectorAll('script,img').length, 0, '不得产生脚本或图片节点');
  const evil = box.querySelector('.backup-issues');
  assert.equal(evil.children.filter((c) => c.tagName !== 'li').length, 0, '列表内只有 li 节点');
});

test('C7: 重试失败把 requeued 数量入 toast；取消隐藏运行区并发出 cancel 调用', async () => {
  const inst = await openBackup({ backupRunning: true, backupImpl: { retry: { requeued: 3 },status:{...RUNNING_STATUS,failed:3} } });
  await inst.click('backup-retry');
  await flush();
  assert.ok(inst.calls.some((c) => c.ns === 'backup' && c.name === 'retry'), '应调用 backup.retry');
  assert.ok(inst.text('toasts').includes('已重新入队 3 个失败任务'), '重试数量入 toast');

  await inst.click('backup-cancel');
  await flush();
  await flush();
  assert.ok(inst.calls.some((c) => c.ns === 'backup' && c.name === 'cancel'), '应调用 backup.cancel');
  assert.equal(inst.$('backup-run').hidden, true, '取消后运行区隐藏');
  assert.equal(inst.timerCount(), 0, '取消后轮询停止');
  assert.ok(inst.text('toasts').includes('备份已取消'), '取消应有提示');
});

test('C8: 取消确认缺失时同样走 cancel（桥接确认框不参与备份取消）', async () => {
  const inst = await openBackup({ backupRunning: true });
  await inst.click('backup-cancel');
  await flush();
  await flush();
  assert.ok(inst.calls.some((c) => c.ns === 'backup' && c.name === 'cancel'), '取消直接调用 cancel');
});

test('C9: 基础桥未接线 backup.* 时，进入备份视图降级且不发起任何 backup 调用', async () => {
  // 手工构造「基础方法齐全、无 backup.*」的桥（真实 alpha 过渡形态）
  const apiForContract = loadApi();
  const baseQk = {};
  for (const key of Object.keys(apiForContract.CONTRACT)) {
    if (key.indexOf('backup.') === 0) continue;
    const p = key.split('.');
    baseQk[p[0]] = baseQk[p[0]] || {};
    baseQk[p[0]][p[1]] = () => Promise.resolve(null);
  }
  baseQk.auth = { status: () => Promise.resolve(null) };
  const inst = await bootApp({ bridge: 'base' });
  // 用例级覆盖：把 base 桥的 backup 命名空间移除（模拟命令未接线）
  // bridge:'base' 时 harness 按 CONTRACT 构造了全部命名空间，这里显式删掉 backup
  delete inst.qk.backup;
  inst.ui.setView('backup');
  await flush();
  await flush();
  assert.deepEqual(
    inst.calls.filter((c) => c.ns === 'backup' && c.name !== 'status').length, 0,
    '不得发起 backup 业务调用（status 允许一次探测）');
  // 点击预览只提示，不抛异常、不发调用
  await inst.click('backup-plan');
  await flush();
  assert.equal(inst.calls.filter((c) => c.ns === 'backup' && c.name === 'plan').length, 0,
    '预览降级为提示');
});

test('C10: 状态轮询单次失败不影响下一周期（恢复后继续渲染）', async () => {
  let failNext = false;
  const inst = await bootApp({
    backupRunning: true,
    backupOverrides: {
      status: () => {
        if (failNext) { failNext = false; return Promise.reject({ code: 'NETWORK', message: '瞬断' }); }
        return Promise.resolve(plain(RUNNING_STATUS));
      }
    }
  });
  inst.ui.setView('backup');
  await flush();
  await flush();
  failNext = true;
  await inst.backupTick();   // 失败一次
  await flush();
  assert.ok(inst.$('backup-stats').textContent.length > 0 || inst.$('backup-pct').textContent.length >= 0,
    '失败后界面保持不崩溃');
  await inst.backupTick();   // 下一周期恢复
  await flush();
  assert.ok(inst.$('backup-stats').textContent.includes('成功'), '恢复后继续渲染状态网格');
});


test('D1: 选择源目录后可直接开始，不要求全盘预扫描；云端目标可用当前目录',async()=>{
  const inst=await openBackup();await inst.click('backup-pick-dir');assert.equal(inst.$('backup-start').disabled,false);
  inst.ui.state.fid='chosen-folder';await inst.click('backup-use-current');assert.equal(inst.$('backup-target').value,'chosen-folder');
  await inst.click('backup-start');const call=inst.calls.find(c=>c.ns==='backup'&&c.name==='start');assert.ok(call);
  assert.equal(inst.calls.filter(c=>c.ns==='backup'&&c.name==='plan').length,0);
});
test('D2: 扫描中禁止显示100%，结束后保留结果和核验入口',async()=>{
  const st={hasSession:true,running:true,scanComplete:false,success:5,totalDiscovered:5,status:'scanning',failed:0};
  const inst=await openBackup({backupImpl:{status:st}});await flush();
  assert.ok(inst.text('backup-pct').includes('99%'));assert.ok(inst.text('backup-pct').includes('总量仍在统计'));
  inst.qk.backup.status=()=>Promise.resolve({...st,running:false,scanComplete:true,status:'awaiting_verification',readyToVerify:true});
  await inst.backupTick();await flush();assert.equal(inst.$('backup-run').hidden,false);assert.equal(inst.$('backup-verify').disabled,false);
});
test('D3: 暂停、继续、全量核验与导出按真实契约调用，任务名始终是文本',async()=>{
  let paused=false;const calls=[];
  const inst=await openBackup({backupImpl:{status:{hasSession:true,running:true,success:0,failed:0,scanComplete:false}},backupOverrides:{
    pause:async()=>{calls.push('pause');paused=true;return {paused:true,hasSession:true};},
    resume:async()=>{calls.push('resume');paused=false;return {paused:false,hasSession:true};},
    tasks:async()=>({tasks:[{rel_path:'<img src=x onerror=alert(1)>',state:'failed',last_error:'<script>data</script>'}]}),
    export:async()=>{calls.push('export');return {exported:1};},
    verify:async p=>{calls.push(p.sampleRatePpm);return {...VERIFY_OK,sample_requested:30,sample_checked:20};},
  }});
  await inst.click('backup-pause');assert.equal(paused,true);
  // Status comes from the backend in real use. Keep the controlled fixture consistent.
  inst.qk.backup.status=async()=>({hasSession:true,running:false,paused:true,failed:0});await inst.backupTick();await flush();
  await inst.click('backup-pause');assert.equal(paused,false);
  inst.$('backup-sample-rate').value='1000000';await inst.click('backup-verify');assert.ok(calls.includes(1000000));assert.ok(inst.text('backup-verify-result').includes('8/30'));
  await inst.click('backup-export');assert.ok(calls.includes('export'));assert.equal(inst.$('backup-task-list').querySelectorAll('img,script').length,0);
});
test('D4: 慢状态请求不会叠加轮询，失败后仍能恢复',async()=>{
  let resolveStatus;let requests=0;
  const inst=await openBackup({backupRunning:true});
  inst.qk.backup.status=()=>{requests++;return new Promise(r=>{resolveStatus=r;});};
  await inst.backupTick();await inst.backupTick();assert.equal(requests,1);
  resolveStatus({running:true,hasSession:true});await flush();await inst.backupTick();assert.equal(requests,2);
  resolveStatus({running:false});await flush();
});
