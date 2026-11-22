'use strict';
/**
 * test/tauri-agent-ui.test.js —— 「设置 → Agent 接入」面板测试
 *
 * 覆盖三层：
 *  A. 静态契约：index.html 的 id 与 app.js 引用一致；面板挂在设置页内；
 *     渲染代码不使用 innerHTML；样式类真实存在。
 *  B. 桥接层契约：CONTRACT 登记 8 个 agent.* 方法；扩展契约不计入 bridgeInfo.missing；
 *     假桥参数原样转发；base 桥（真实 alpha 过渡形态）返回 NO_BRIDGE 拒绝。
 *  C. 真实渲染与交互：vm 加载 index.html + api.js + app.js + 极简 DOM 垫片，
 *     覆盖降级、状态点、按钮矩阵、journal、MCP 配置与全部确认交互。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  html, appSrc, apiSrc, stylesSrc,
  loadApi, fakeQk, bootApp, plain,
  BASE_AGENT_STATUS, BASE_MCP
} = require('./renderer-harness');

const AGENT_IDS = [
  'agent-card',
  'agent-status-text',
  'agent-status-hint',
  'agent-status-error',
  'agent-status-extra',
  'agent-status-dot',
  'agent-btn-enable',
  'agent-btn-disable',
  'agent-btn-rotate',
  'agent-scope-seg',
  'agent-scope-hint',
  'agent-delete-seg',
  'agent-delete-hint',
  'agent-remote-roots',
  'agent-btn-add-remote',
  'agent-local-read-roots',
  'agent-btn-add-read',
  'agent-local-write-roots',
  'agent-btn-add-write',
  'agent-journal',
  'agent-btn-refresh-journal',
  'agent-mcp-config',
  'agent-btn-copy-mcp'
];

const AGENT_METHODS = ['status', 'enable', 'disable', 'setScope', 'rotate', 'journal', 'mcpConfig', 'copyMcpConfig'];

/* ==================================================================== *
 * 静态扫描工具
 * ==================================================================== */

function htmlIds() {
  const ids = new Set();
  const re = /\sid="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return ids;
}

function referencedIds() {
  const refs = new Set();
  const re = /(?:\$\(|getElementById\()\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(appSrc)) !== null) refs.add(m[1]);
  return refs;
}

function dynamicIds() {
  const ids = new Set();
  const re = /\.id\s*=\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(appSrc)) !== null) ids.add(m[1]);
  return ids;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** app.js 中「Agent 接入（设置页卡片）」代码段（含块注释起始符，确保 stripComments 能整段去除注释）。 */
function agentSectionSource() {
  const startMarker = appSrc.indexOf('* Agent 接入（设置页卡片）');
  const endMarker = appSrc.indexOf('* 对话（Chat 视图）');
  const start = startMarker > 0 ? appSrc.lastIndexOf('/*', startMarker) : -1;
  const end = endMarker > 0 ? appSrc.lastIndexOf('/*', endMarker) : -1;
  assert.ok(start >= 0 && end > start, 'app.js 中未找到 Agent 面板代码段');
  return appSrc.slice(start, end);
}

/** 本地时间 HH:mm:ss（与 app.js 的 fmtClock 一致）。 */
function clock(ts) {
  const d = new Date(Number(ts));
  const p = (n) => (String(n).length < 2 ? '0' + n : String(n));
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ==================================================================== *
 * A. 静态契约
 * ==================================================================== */

test('app.js 引用的每个 DOM id 都必须存在于 index.html', () => {
  const ids = htmlIds();
  const dynamic = dynamicIds();
  const refs = [...referencedIds()].sort();
  const missing = refs.filter((id) => !ids.has(id) && !dynamic.has(id));
  assert.deepEqual(missing, [], 'app.js 引用了 index.html 中不存在的 id：' + missing.join('、'));
  assert.ok(refs.length > 60, 'app.js 的 id 引用数量异常偏少（实际 ' + refs.length + '）');
  for (const id of refs.filter((x) => !ids.has(x))) {
    assert.ok(dynamic.has(id), 'id ' + id + ' 既不在 index.html 中，也没有动态创建点');
  }
});

test('Agent 面板元素 id 全部存在、app.js 确实引用，且面板挂在设置视图内', () => {
  const ids = htmlIds();
  const refs = referencedIds();
  assert.deepEqual(AGENT_IDS.filter((id) => !ids.has(id)), [], 'index.html 缺少 Agent 面板元素');
  assert.deepEqual(AGENT_IDS.filter((id) => !refs.has(id)), [], 'app.js 未引用以下 Agent 面板元素');

  const viewStart = html.indexOf('id="view-settings"');
  const viewEnd = html.indexOf('id="view-chat"');
  assert.ok(viewStart > 0 && viewEnd > viewStart, 'index.html 结构异常：未找到设置视图边界');
  const settingsHtml = html.slice(viewStart, viewEnd);
  for (const id of AGENT_IDS) {
    assert.ok(settingsHtml.includes('id="' + id + '"'), '元素 ' + id + ' 不在 #view-settings 内');
  }
  // 导航新增「对话」项，且对话视图紧跟设置视图
  assert.ok(/data-view="chat"/.test(html), '导航缺少 data-view="chat"');
  assert.ok(html.includes('id="view-chat"'), '缺少 #view-chat 视图');
  assert.ok(html.includes('id="i-chat"'), 'SVG sprite 缺少 #i-chat symbol');
});

test('Agent 面板关键文案齐全、渲染不使用 innerHTML、样式类真实存在', () => {
  assert.ok(appSrc.includes('根目录不能被授权，请进入具体目录'), '缺少根目录授权提示');
  assert.ok(appSrc.includes('已连接的 Agent 会立即失效，需要重新配置'), '停用确认未说明后果');
  assert.ok(appSrc.includes('暂无记录'), '操作记录空态缺少「暂无记录」');
  assert.ok(appSrc.includes("'未注入桥接层'"), '缺少未注入桥接层时的状态文案');
  assert.ok(appSrc.includes('agent-dot-on'), '缺少运行中状态点');
  assert.ok(appSrc.includes('setAgentDot'), '缺少状态点渲染函数');
  assert.ok(stylesSrc.includes('.agent-dot-warn'), '缺少已启用未运行状态点样式');

  const panelCode = stripComments(agentSectionSource());
  assert.ok(!panelCode.includes('innerHTML'), 'Agent 面板渲染不得使用 innerHTML');
  assert.ok(!panelCode.includes('insertAdjacentHTML'), 'Agent 面板渲染不得使用 insertAdjacentHTML');

  for (const cls of ['agent-dot', 'agent-item', 'agent-journal', 'agent-code', 'agent-error',
    'agent-actions', 'agent-ext', 'agent-off', 'agent-group', 'agent-empty']) {
    assert.ok(stylesSrc.includes('.' + cls), 'styles.css 缺少样式类 .' + cls);
  }
  assert.ok(stylesSrc.includes('.setcard'), 'styles.css 缺少 .setcard');
  assert.ok(/\.setcard\s*\{[^}]*flex-shrink:\s*0/.test(stylesSrc), '.setcard 缺少 flex-shrink:0 修复');
  assert.ok(/\.view\s*\{[^}]*overflow-y:\s*auto/.test(stylesSrc), '.view 缺少 overflow-y:auto 修复');
});

/* ==================================================================== *
 * B. 桥接层契约
 * ==================================================================== */

test('api.js 的 CONTRACT 登记全部 8 个 agent.* 键，且扩展契约不计入 missing', () => {
  const api = loadApi();
  assert.equal(api.injected, false);
  for (const name of AGENT_METHODS) {
    assert.equal(api.CONTRACT['agent.' + name], 1, 'CONTRACT 缺少 agent.' + name);
  }
  const agentKeys = Object.keys(api.CONTRACT).filter((k) => k.indexOf('agent.') === 0);
  assert.deepEqual(agentKeys.sort(), AGENT_METHODS.map((n) => 'agent.' + n).sort());

  // 全量假桥：missing 与 missingExtension 均为空
  const full = loadApi({ qk: fakeQk().qk });
  assert.deepEqual(plain(full.bridgeInfo().missing), []);
  assert.deepEqual(plain(full.bridgeInfo().missingExtension), []);

  // 真实 alpha 形态：基础方法齐全、agent/chat 未接线 → missing 为空，扩展缺失单独统计
  const base = loadApi({ qk: fakeQk({ omit: ['agent', 'chat'] }).qk });
  const info = base.bridgeInfo();
  assert.equal(info.injected, true);
  assert.deepEqual(plain(info.missing), [], '基础契约不应因扩展方法缺失而报缺失');
  assert.equal(info.missingExtension.length, 17, '应统计 17 个 agent.*/chat.* 扩展方法');
  assert.ok(info.text.includes('尚未接线'), '扩展缺失提示文案缺失');
});

test('注入假 qk 后 API.agent.* 把参数原样转发给桥接层', async () => {
  const fake = fakeQk();
  const api = loadApi({ qk: fake.qk });
  assert.equal(api.injected, true);
  assert.equal(api.bridgeInfo().missing.length, 0);

  for (const name of AGENT_METHODS) {
    assert.equal(typeof api.agent[name], 'function', 'API.agent.' + name + ' 不是函数');
  }

  const patch = { writeMode: 'scoped-write', remoteRoots: [{ fid: 'fid-1', name: '项目资料' }] };
  await api.agent.status();
  await api.agent.enable({});
  await api.agent.disable();
  await api.agent.setScope(patch);
  await api.agent.rotate();
  await api.agent.journal(20);
  await api.agent.mcpConfig();
  await api.agent.copyMcpConfig();

  const expected = AGENT_METHODS.map((n) => 'agent.' + n);
  const seen = fake.calls.map((c) => c.ns + '.' + c.name).filter((k) => expected.indexOf(k) >= 0);
  assert.deepEqual(seen, expected, '转发顺序/次数与调用不一致');
  assert.deepEqual(plain(fake.calls.find((c) => c.name === 'setScope').args), [patch], 'setScope 参数未被原样转发');
  assert.deepEqual(plain(fake.calls.find((c) => c.name === 'journal').args), [20], 'journal(limit) 未被原样转发');
});

test('base 桥（真实 alpha 过渡形态）下 agent.* 返回 NO_BRIDGE 拒绝而不是同步抛异常', async () => {
  const api = loadApi({ qk: fakeQk({ omit: ['agent', 'chat'] }).qk });
  assert.equal(api.injected, true);
  assert.equal(api.has('agent', 'status'), false);

  let rejection = null;
  assert.doesNotThrow(() => {
    rejection = api.agent.status();
    rejection.catch(() => {});
  }, 'NO_BRIDGE 必须以拒绝的 Promise 返回，不能同步抛异常');
  await assert.rejects(rejection, (err) => {
    assert.equal(err.code, 'NO_BRIDGE');
    assert.ok(err.message.includes('agent.status()'), '错误文案应指出缺失的方法');
    return true;
  });
  await assert.rejects(api.agent.enable({}), (err) => err.code === 'NO_BRIDGE');
});

/* ==================================================================== *
 * C. 真实渲染与交互
 * ==================================================================== */

test('AI 实验室默认关闭（Beta 测试功能）：默认隐藏 Agent 面板与对话入口，手动开启后才加载并展示', async () => {
  assert.ok(html.includes('id="ai-beta-card"') && html.includes('Beta 测试功能'), 'index.html 的 AI 实验室必须明确标注 Beta 测试功能');
  const app = await bootApp();
  await app.openSettings();

  assert.equal(app.$('nav-chat').hidden, true, '默认应隐藏侧边栏 AI 对话入口');
  assert.equal(app.$('agent-card').hidden, true, '默认应隐藏设置页 Agent 面板');
  assert.ok(app.text('ai-beta-hint').includes('默认关闭'), '关闭态说明应提示默认关闭');
  assert.deepEqual(app.agentCalls(), [], 'AI Beta 关闭时不得发起任何 agent.* 调用');

  // 手动在设置页开启 AI Beta
  await app.enableAiBeta();
  const setCall = app.calls.filter((c) => c.ns === 'settings' && c.name === 'set').pop();
  assert.deepEqual(plain(setCall.args), [{ aiBetaEnabled: true }], '开启后应持久化 aiBetaEnabled: true');
  assert.equal(app.$('nav-chat').hidden, false, '开启后侧边栏应显示对话 Beta 入口');
  assert.equal(app.$('agent-card').hidden, false, '开启后应展示 Agent 接入卡片');
  assert.ok(app.text('ai-beta-hint').includes('Beta 测试功能'), '开启态说明应明确标注 Beta 测试功能');
  assert.equal(app.text('agent-status-text'), '运行中', '开启后应立即拉取 Agent 状态');

  // 手动关闭恢复极简模式
  await app.disableAiBeta();
  assert.equal(app.$('nav-chat').hidden, true, '关闭后应重新隐藏对话入口');
  assert.equal(app.$('agent-card').hidden, true, '关闭后应重新隐藏 Agent 面板');
});

test('未注入桥接层：整卡降级（agent-off）、全部按钮禁用、不发起任何 agent 调用', async () => {
  const app = await bootApp({ bridge: 'none' });
  await app.openSettings();

  assert.ok(app.$('agent-card').hasClass('agent-off'), '#agent-card 未加 agent-off 降级类');
  assert.equal(app.text('agent-status-text'), '未注入桥接层');
  assert.ok(app.text('agent-status-hint').includes('window.qk 不存在'));
  assert.ok(app.text('agent-journal').includes('未注入桥接层，无法读取操作记录'));
  assert.ok(app.text('agent-mcp-config').includes('未注入桥接层，无法读取 MCP 配置'));

  for (const id of ['agent-btn-enable', 'agent-btn-disable', 'agent-btn-rotate', 'agent-btn-add-remote',
    'agent-btn-add-read', 'agent-btn-add-write', 'agent-btn-refresh-journal', 'agent-btn-copy-mcp']) {
    assert.equal(app.$(id).disabled, true, id + ' 应禁用');
  }
  for (const seg of app.$('agent-scope-seg').querySelectorAll('.seg')) {
    assert.equal(seg.disabled, true, '写入模式分段按钮应禁用');
  }
  assert.deepEqual(app.agentCalls(), [], '未注入桥接层时不得发起 agent.* 调用');
});

test('base 桥（命令未接线）：面板降级为「接入命令未接线」，且不发起 agent 调用', async () => {
  const app = await bootApp({ bridge: 'base', aiBetaEnabled: true });
  await app.openSettings();

  assert.ok(app.$('agent-card').hasClass('agent-off'));
  assert.equal(app.text('agent-status-text'), '接入命令未接线');
  assert.ok(app.text('agent-status-hint').includes('agent.*'));
  assert.ok(app.text('agent-journal').includes('Agent 接入命令未接线'));
  assert.equal(app.$('agent-btn-enable').disabled, true);
  assert.deepEqual(app.agentCalls(), [], '桥命令缺失时不得发起 agent.* 调用');
});

test('运行中：状态点、状态摘要、按钮矩阵、journal 与 MCP 配置全部按主进程形状渲染', async () => {
  const app = await bootApp({ aiBetaEnabled: true });
  await app.openSettings();

  assert.equal(app.text('agent-status-text'), '运行中');
  assert.ok(app.text('agent-status-hint').includes('写入模式：只读'));
  assert.ok(app.text('agent-status-hint').includes('修改后立即生效'));
  assert.ok(app.$('agent-status-dot').hasClass('agent-dot-on'), '运行中状态点应为绿色');
  assert.equal(app.$('agent-status-error').hidden, true);

  const extra = app.text('agent-status-extra');
  assert.ok(extra.includes('传输方式：unix-socket'));
  assert.ok(extra.includes('监听地址：/tmp/qck-agent/agent-1.sock'));
  assert.ok(extra.includes('已服务调用：7 次'));
  assert.ok(extra.includes('当前连接：2'));
  assert.ok(extra.includes('凭据文件：/tmp/qck-agent/bridge.json'));
  assert.ok(extra.includes('记录文件：/tmp/qck-agent/journal.jsonl'));
  assert.equal(app.$('agent-status-extra').hidden, false);

  // 按钮矩阵：运行中「启用」禁用，「停用/重新生成凭据」可用
  assert.equal(app.$('agent-btn-enable').disabled, true);
  assert.equal(app.$('agent-btn-disable').disabled, false);
  assert.equal(app.$('agent-btn-rotate').disabled, false);
  assert.equal(app.$('agent-btn-add-remote').disabled, false);
  assert.equal(app.$('agent-btn-copy-mcp').disabled, false);

  // 写入模式：只读高亮
  const segs = app.$('agent-scope-seg').querySelectorAll('.seg');
  const readOnly = segs.find((b) => b.getAttribute('data-agent-scope') === 'read-only');
  const scoped = segs.find((b) => b.getAttribute('data-agent-scope') === 'scoped-write');
  assert.ok(readOnly.hasClass('active'));
  assert.equal(readOnly.getAttribute('aria-checked'), 'true');
  assert.equal(scoped.hasClass('active'), false);

  // 授权目录
  assert.equal(app.$('agent-remote-roots').querySelectorAll('.agent-item').length, 1);
  assert.ok(app.text('agent-remote-roots').includes('项目资料'));
  assert.ok(app.text('agent-remote-roots').includes('fid：fid-100'));
  assert.equal(app.$('agent-local-read-roots').querySelectorAll('.agent-item').length, 1);
  assert.ok(app.text('agent-local-read-roots').includes('只读'));
  assert.ok(app.text('agent-local-write-roots').includes('可读写'));

  // journal：后端正序 → UI 反转（最新在上），结果映射与摘要优先级
  const rows = app.$('agent-journal').querySelectorAll('.agent-journal-row');
  assert.equal(rows.length, 4);
  const cols = (row) => row.children.map((c) => c.textContent);
  assert.deepEqual(cols(rows[0])[1], '配置 · auth');
  assert.deepEqual(cols(rows[0])[2], '已拒绝');
  assert.equal(cols(rows[0])[0], clock(1750000004000));
  assert.equal(cols(rows[1])[1], 'fs_remove');
  assert.equal(cols(rows[1])[2], '失败');
  assert.equal(cols(rows[1])[3], 'AGENT_READ_ONLY：只读模式下不允许删除');
  assert.equal(cols(rows[2])[1], 'fs_list');
  assert.equal(cols(rows[2])[2], '成功');
  assert.equal(cols(rows[2])[3], '耗时 42 ms');
  assert.equal(cols(rows[3])[1], '配置 · config');
  assert.equal(cols(rows[3])[2], '已启用');

  // MCP 配置：JSON 文本，不含凭据
  assert.equal(app.text('agent-mcp-config'), JSON.stringify(BASE_MCP, null, 2));

  // 凭据文件路径与 token 之外的信息之外，界面不出现任何凭据字段
  const cardText = app.text('agent-card');
  assert.equal(cardText.includes('"token"'), false, 'Agent 面板不应出现 token');
  assert.equal(cardText.includes('Cookie'), false, 'Agent 面板不应出现 Cookie');
});

test('已启用未运行（黄）与未启用（灰）：状态点与按钮矩阵随状态切换', async () => {
  const paused = await bootApp({
    aiBetaEnabled: true,
    agentStatus: Object.assign({}, BASE_AGENT_STATUS, { running: false, connections: 0, callsServed: 0 })
  });
  await paused.openSettings();
  assert.equal(paused.text('agent-status-text'), '已启用但未运行');
  assert.ok(paused.$('agent-status-dot').hasClass('agent-dot-warn'), '未运行状态点应为黄色');
  assert.ok(paused.text('agent-status-hint').includes('监听未建立'));
  assert.equal(paused.text('agent-status-extra').includes('已服务调用'), false);
  assert.equal(paused.text('agent-status-extra').includes('当前连接'), false);
  assert.equal(paused.$('agent-btn-enable').disabled, false, '未运行时允许重新启用');
  assert.equal(paused.$('agent-btn-disable').disabled, false);
  assert.equal(paused.$('agent-btn-rotate').disabled, false);

  const off = await bootApp({
    aiBetaEnabled: true,
    agentStatus: Object.assign({}, BASE_AGENT_STATUS, { enabled: false, running: false, endpoint: '' })
  });
  await off.openSettings();
  assert.equal(off.text('agent-status-text'), '未启用');
  const dot = off.$('agent-status-dot');
  assert.ok(dot.hasClass('agent-dot'));
  assert.equal(dot.hasClass('agent-dot-on') || dot.hasClass('agent-dot-warn') || dot.hasClass('agent-dot-error'), false,
    '未启用状态点应为默认灰色');
  assert.ok(off.text('agent-status-hint').includes('启用后外部 Agent'));
  assert.ok(off.text('agent-status-extra').includes('监听地址：—'));
  assert.equal(off.$('agent-btn-enable').disabled, false);
  assert.equal(off.$('agent-btn-disable').disabled, true);
  assert.equal(off.$('agent-btn-rotate').disabled, true);
});

test('状态读取失败：红色状态点、错误详情行、操作按钮禁用', async () => {
  const app = await bootApp({ aiBetaEnabled: true, agentStatusError: '授权范围文件损坏' });
  await app.openSettings();

  assert.equal(app.text('agent-status-text'), '状态读取失败');
  assert.ok(app.$('agent-status-dot').hasClass('agent-dot-error'));
  assert.equal(app.$('agent-status-error').hidden, false);
  assert.equal(app.text('agent-status-error'), '错误详情：授权范围文件损坏');
  assert.equal(app.$('agent-btn-enable').disabled, true);
  assert.equal(app.$('agent-btn-disable').disabled, true);
  assert.equal(app.$('agent-btn-rotate').disabled, true);
  // journal / MCP 仍可读取（互不影响）
  assert.equal(app.$('agent-journal').querySelectorAll('.agent-journal-row').length, 4);
});

test('journal 空态/读取失败与 MCP 读取失败各自给出文案', async () => {
  const empty = await bootApp({ aiBetaEnabled: true, journal: [] });
  await empty.openSettings();
  assert.equal(empty.text('agent-journal').trim(), '暂无记录');

  const journalErr = await bootApp({ aiBetaEnabled: true, journalFails: '记录文件不可读' });
  await journalErr.openSettings();
  assert.ok(journalErr.text('agent-journal').includes('读取失败：记录文件不可读'));

  const mcpErr = await bootApp({ aiBetaEnabled: true, mcpFails: '配置读取失败' });
  await mcpErr.openSettings();
  assert.ok(mcpErr.text('agent-mcp-config').includes('读取失败：配置读取失败'));
});

test('写入模式：点击分段按钮提交 setScope({writeMode}) 并就地刷新状态', async () => {
  const app = await bootApp({ aiBetaEnabled: true });
  await app.openSettings();
  const before = app.agentCalls().filter((n) => n === 'status').length;

  const scoped = app.$('agent-scope-seg').querySelectorAll('.seg')
    .find((b) => b.getAttribute('data-agent-scope') === 'scoped-write');
  await app.click(scoped);

  const scopeCall = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').pop();
  assert.ok(scopeCall, '未调用 agent.setScope');
  assert.deepEqual(plain(scopeCall.args), [{ writeMode: 'scoped-write' }], 'setScope 参数形状不正确');
  assert.ok(app.text('toasts').includes('写入模式已更新为授权范围内可写'));
  assert.ok(app.agentCalls().filter((n) => n === 'status').length > before, '写入模式更新后应重读状态');
  assert.ok(scoped.hasClass('active'), '分段按钮应切换为激活态');
  assert.equal(scoped.getAttribute('aria-checked'), 'true');
  assert.ok(app.text('agent-scope-hint').includes('授权范围内可写'));
});

test('网盘授权目录：按数据属性移除、根目录拒绝、添加当前目录', async () => {
  const app = await bootApp({ aiBetaEnabled: true });
  await app.openSettings();

  // 移除：按钮带 data-agent-remove / data-agent-kind，事件委托到列表容器
  const removeBtn = app.$('agent-remote-roots').querySelector('[data-agent-remove]');
  assert.ok(removeBtn, '授权目录行缺少移除按钮');
  assert.equal(removeBtn.getAttribute('data-agent-kind'), 'remote');
  await app.click(removeBtn);
  const afterRemove = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').pop();
  assert.deepEqual(plain(afterRemove.args), [{ remoteRoots: [] }]);
  assert.ok(app.text('agent-remote-roots').includes('尚未授权任何网盘目录'));

  // 根目录（fid=0）拒绝
  const scopeCount = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').length;
  await app.click('agent-btn-add-remote');
  assert.ok(app.text('toasts').includes('根目录不能被授权，请进入具体目录'));
  assert.equal(app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').length, scopeCount,
    '根目录不应提交授权更新');

  // 进入具体目录后添加
  app.ui.state.fid = 'dir-999';
  app.ui.state.crumbs = [{ fid: '0', name: '全部文件' }, { fid: 'dir-999', name: '新目录' }];
  await app.click('agent-btn-add-remote');
  const scopeCall = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').pop();
  assert.deepEqual(plain(scopeCall.args), [{
    remoteRoots: [{ fid: 'dir-999', name: '新目录' }]
  }]);
  assert.ok(app.text('toasts').includes('已授权当前目录'));
  assert.ok(app.text('agent-remote-roots').includes('新目录'));
});

test('本地授权目录：pickDirs 结果合并去重后提交 setScope', async () => {
  const app = await bootApp({ aiBetaEnabled: true, pickedDirs: ['/Users/tester/图片', '/Users/tester/Downloads'] });
  await app.openSettings();

  await app.click('agent-btn-add-read');
  let scopeCall = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').pop();
  assert.deepEqual(plain(scopeCall.args), [{
    localReadRoots: ['/Users/tester/Downloads', '/Users/tester/图片']
  }], '重复目录应去重、既有目录保留');
  assert.ok(app.text('toasts').includes('已添加上传来源目录'));

  await app.click('agent-btn-add-write');
  scopeCall = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').pop();
  assert.deepEqual(plain(scopeCall.args), [{
    localWriteRoots: ['/Users/tester/work', '/Users/tester/图片', '/Users/tester/Downloads']
  }]);
  assert.ok(app.text('toasts').includes('已添加工作目录'));
});

test('停用与重新生成凭据：系统确认框参数正确，取消时不执行', async () => {
  const app = await bootApp({ aiBetaEnabled: true });
  await app.openSettings();

  // 取消停用
  app.setConfirmed(false);
  await app.click('agent-btn-disable');
  const confirmCall = app.calls.filter((c) => c.ns === 'dialog' && c.name === 'confirm').pop();
  assert.deepEqual(plain(confirmCall.args), [{
    title: '停用 Agent 接入',
    message: '停用后桥接凭据立即删除，已连接的 Agent 会立即失效，需要重新配置。',
    detail: '授权范围会保留，再次启用时无需重新配置。',
    danger: true,
    confirmText: '停用'
  }]);
  assert.equal(app.calls.filter((c) => c.ns === 'agent' && c.name === 'disable').length, 0, '取消后不得停用');

  // 重新生成凭据（启用状态下才可操作）
  app.setConfirmed(true);
  await app.click('agent-btn-rotate');
  const rotateConfirm = app.calls.filter((c) => c.ns === 'dialog' && c.name === 'confirm').pop();
  assert.equal(rotateConfirm.args[0].title, '重新生成桥接凭据');
  assert.equal(rotateConfirm.args[0].confirmText, '重新生成');
  assert.ok(rotateConfirm.args[0].message.includes('已连接的 Agent 会断开'));
  assert.equal(app.calls.filter((c) => c.ns === 'agent' && c.name === 'rotate').length, 1);
  assert.ok(app.text('toasts').includes('桥接凭据已重新生成'));

  // 确认停用
  app.setConfirmed(true);
  await app.click('agent-btn-disable');
  assert.equal(app.calls.filter((c) => c.ns === 'agent' && c.name === 'disable').length, 1);
  assert.ok(app.text('toasts').includes('Agent 接入已停用，权限立即失效'));
  assert.equal(app.text('agent-status-text'), '未启用');
  assert.equal(app.$('agent-btn-enable').disabled, false);
});

test('系统确认框缺失：回落应用内确认框（danger 红色），取消不执行、确认才执行', async () => {
  const app = await bootApp({ aiBetaEnabled: true, confirmSupported: false });
  await app.openSettings();

  await app.click('agent-btn-disable');
  let dlg = app.latestOverlay();
  assert.ok(dlg, '应打开应用内确认框');
  assert.ok(dlg.querySelector('.dlg-confirm'), '确认框缺少 .dlg-confirm');
  assert.equal(dlg.querySelector('.dlg-title').textContent, '停用 Agent 接入');
  assert.ok(dlg.querySelector('.dlg-ic').hasClass('danger'), 'danger 确认框图标应标红');
  const foot = dlg.querySelector('.dlg-foot');
  const buttons = foot.children.filter((c) => c.tagName === 'button');
  assert.ok(buttons[buttons.length - 1].hasClass('btn-danger'), '确认按钮应为危险样式');

  await app.clickOverlay('cancel');
  assert.equal(app.calls.filter((c) => c.ns === 'agent' && c.name === 'disable').length, 0);

  await app.click('agent-btn-disable');
  await app.clickOverlay('ok');
  assert.equal(app.calls.filter((c) => c.ns === 'agent' && c.name === 'disable').length, 1);
});

test('复制 MCP 配置：后端回配置时由渲染层写剪贴板；NO_BRIDGE 回落面板文本；失败/空态各有提示', async () => {
  // Tauri 形态：copyMcpConfig 只返回配置对象，渲染层写剪贴板
  const app = await bootApp({ aiBetaEnabled: true });
  await app.openSettings();
  const mcpBefore = app.agentCalls().filter((n) => n === 'mcpConfig').length;
  await app.click('agent-btn-copy-mcp');
  assert.equal(app.calls.filter((c) => c.ns === 'agent' && c.name === 'copyMcpConfig').length, 1);
  const clip = app.calls.find((c) => c.ns === 'clipboard');
  assert.ok(clip, 'Tauri 后端不写剪贴板，应由渲染层写入');
  assert.equal(clip.args[0], JSON.stringify(BASE_MCP, null, 2));
  assert.ok(app.text('toasts').includes('MCP 配置已复制到剪贴板'));
  assert.ok(app.agentCalls().filter((n) => n === 'mcpConfig').length > mcpBefore, '复制后应重读 MCP 配置');

  // 后端命令不可用（NO_BRIDGE）：回落到面板已读到的配置文本
  const fallback = await bootApp({ aiBetaEnabled: true, copyFails: true });
  await fallback.openSettings();
  await fallback.click('agent-btn-copy-mcp');
  const fallbackClip = fallback.calls.find((c) => c.ns === 'clipboard');
  assert.ok(fallbackClip, 'NO_BRIDGE 时应回落到渲染层剪贴板');
  assert.equal(fallbackClip.args[0], JSON.stringify(BASE_MCP, null, 2));
  assert.ok(fallback.text('toasts').includes('MCP 配置已复制到剪贴板'));

  // 渲染层剪贴板也失败：提示手动复制
  const broken = await bootApp({ aiBetaEnabled: true, clipboardFails: true });
  await broken.openSettings();
  await broken.click('agent-btn-copy-mcp');
  assert.ok(broken.text('toasts').includes('复制失败：请手动选中 MCP 配置文本复制'));

  // 配置为空（后端返回 null）：给出「没有可复制」提示
  const blank = await bootApp({ aiBetaEnabled: true, mcp: null });
  await blank.openSettings();
  await blank.click('agent-btn-copy-mcp');
  assert.ok(blank.text('toasts').includes('没有可复制的 MCP 配置'));
});

test('安全文案准确表达只读与删除边界，删除权限默认关闭且开启需二次确认', async () => {
  const app = await bootApp({ aiBetaEnabled: true });
  await app.openSettings();

  // 只读模式文案准确：不能下载、上传或修改；删除开启按钮禁用
  assert.ok(app.text('agent-scope-hint').includes('不能下载、上传或修改'));
  assert.equal(app.text('agent-scope-hint').includes('删除接口未对 Agent 开放'), false);
  const delSegs = app.$('agent-delete-seg').querySelectorAll('.seg');
  const delOff = delSegs.find((b) => b.getAttribute('data-agent-delete') === 'off');
  const delOn = delSegs.find((b) => b.getAttribute('data-agent-delete') === 'on');
  assert.ok(delOff.hasClass('active'));
  assert.equal(delOn.disabled, true, '只读模式下不允许开启删除权限');

  // 切到授权范围内可写后，删除按钮解锁但默认仍为禁止删除
  const scoped = app.$('agent-scope-seg').querySelectorAll('.seg')
    .find((b) => b.getAttribute('data-agent-scope') === 'scoped-write');
  await app.click(scoped);
  assert.ok(app.text('agent-scope-hint').includes('删除权限需在下方单独开启'));
  assert.equal(delOn.disabled, false);
  assert.ok(delOff.hasClass('active'));

  // 点击允许移入回收站：取消确认时不提交
  app.setConfirmed(false);
  const scopeBefore = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').length;
  await app.click(delOn);
  assert.equal(app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').length, scopeBefore);
  assert.ok(delOff.hasClass('active'));

  // 确认后提交 setScope({ allowDelete: true })，再切回禁止删除提交 { allowDelete: false }
  app.setConfirmed(true);
  await app.click(delOn);
  let lastScope = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').pop();
  assert.deepEqual(plain(lastScope.args), [{ allowDelete: true }]);
  assert.ok(delOn.hasClass('active'));
  assert.ok(app.text('agent-delete-hint').includes('允许移入回收站'));

  await app.click(delOff);
  lastScope = app.calls.filter((c) => c.ns === 'agent' && c.name === 'setScope').pop();
  assert.deepEqual(plain(lastScope.args), [{ allowDelete: false }]);
  assert.ok(delOff.hasClass('active'));
});
