'use strict';
/**
 * test/tauri-chat-ui.test.js —— 「对话」视图测试
 *
 * 覆盖三层：
 *  A. 静态契约：index.html 的 id 与 app.js 引用一致；导航「对话」入口与视图位置；
 *     隐私说明文案齐全；渲染代码不使用 innerHTML；样式类真实存在。
 *  B. 桥接层契约：CONTRACT 登记 9 个 chat.* 方法；假桥参数原样转发；
 *     base 桥（真实 alpha 过渡形态）返回 NO_BRIDGE；onEvent 返回取消订阅函数。
 *  C. 真实渲染与交互：vm 加载 index.html + api.js + app.js + 极简 DOM 垫片，
 *     覆盖配置状态机、消息气泡、工具卡片配对、事件流与 send() 兜底、XSS 红线。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  html, appSrc, apiSrc, stylesSrc,
  loadApi, fakeQk, bootApp, plain,
  UNCONFIGURED_CHAT, CONFIGURED_CHAT
} = require('./renderer-harness');

const CHAT_IDS = [
  'view-chat',
  'chat-card',
  'chat-card-hint',
  'chat-card-dot',
  'chat-card-status',
  'chat-btn-settings',
  'chat-btn-clear-config',
  'chat-config-form',
  'chat-base-url',
  'chat-api-key',
  'chat-model',
  'chat-config-hint',
  'chat-btn-save',
  'chat-btn-test',
  'chat-btn-models',
  'chat-model-list',
  'chat-summary',
  'chat-messages',
  'chat-input',
  'chat-btn-send',
  'chat-btn-clear',
  'chat-status'
];

const CHAT_METHODS = ['status', 'saveConfig', 'clearConfig', 'test', 'models', 'history', 'clear', 'send', 'onEvent'];

const BASE_HISTORY = [
  { role: 'user', text: '帮我看看根目录', at: 111 },
  {
    role: 'assistant', text: '已列出根目录', at: 112, rounds: 1, ms: 120,
    toolCalls: [{ name: 'fs_list', title: '列出文件', ok: true, ms: 12, summary: '共 3 个文件', args: '{"pdir_fid":"0"}' }]
  },
  { role: 'assistant', text: '读取失败', at: 113, error: true }
];

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

/** app.js 中「对话（Chat 视图）」代码段（含块注释起始符）。 */
function chatSectionSource() {
  const startMarker = appSrc.indexOf('* 对话（Chat 视图）');
  const endMarker = appSrc.search(/\* 设置\r?\n/);
  const start = startMarker > 0 ? appSrc.lastIndexOf('/*', startMarker) : -1;
  const end = endMarker > 0 ? appSrc.lastIndexOf('/*', endMarker) : -1;
  assert.ok(start >= 0 && end > start, 'app.js 中未找到对话视图代码段');
  return appSrc.slice(start, end);
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
  for (const id of refs.filter((x) => !ids.has(x))) {
    assert.ok(dynamic.has(id), 'id ' + id + ' 既不在 index.html 中，也没有动态创建点');
  }
});

test('对话视图元素 id 全部存在，且 app.js 确实引用它们', () => {
  const ids = htmlIds();
  const refs = referencedIds();
  assert.deepEqual(CHAT_IDS.filter((id) => !ids.has(id)), [], 'index.html 缺少对话视图元素');
  assert.deepEqual(CHAT_IDS.filter((id) => !refs.has(id)), [], 'app.js 未引用以下对话视图元素');
});

test('导航新增「对话」项（位于传输列表与设置之间），对话视图紧跟设置视图', () => {
  const nav = html.slice(html.indexOf('id="nav"'), html.indexOf('</nav>'));
  const chatIndex = nav.indexOf('data-view="chat"');
  const transfersIndex = nav.indexOf('data-view="transfers"');
  const settingsIndex = nav.indexOf('data-view="settings"');
  assert.ok(chatIndex > 0, '导航缺少 data-view="chat"');
  assert.ok(transfersIndex >= 0 && transfersIndex < chatIndex, '「对话」应位于「传输列表」之后');
  assert.ok(settingsIndex > chatIndex, '「对话」应位于「设置」之前');
  assert.ok(nav.includes('href="#i-chat"'), '导航对话按钮缺少 #i-chat 图标');

  const settingsEnd = html.indexOf('id="dropmask"');
  const chatStart = html.indexOf('id="view-chat"');
  assert.ok(chatStart > 0 && chatStart < settingsEnd, '对话视图应位于设置视图之后、拖拽遮罩之前');
});

test('隐私与工具说明文案齐全，渲染不使用 innerHTML，样式类真实存在', () => {
  assert.ok(appSrc.includes('API Key 只写入本机加密存储') ||
    html.includes('API Key 只写入本机加密存储'), '缺少 API Key 存储说明');
  assert.ok(html.includes('工具结果已脱敏'), '缺少脱敏说明');
  assert.ok(html.includes('与「Agent 接入」完全相同'), '缺少工具授权同源说明');
  assert.ok(appSrc.includes('请先配置大模型'), '缺少未配置时的引导文案');
  assert.ok(appSrc.includes('（模型没有返回内容）'), '缺少空回复兜底文案');
  assert.ok(appSrc.includes('已达到轮次上限'), '缺少轮次上限文案');

  const chatCode = stripComments(chatSectionSource());
  assert.ok(!chatCode.includes('innerHTML'), '对话渲染不得使用 innerHTML');
  assert.ok(!chatCode.includes('insertAdjacentHTML'), '对话渲染不得使用 insertAdjacentHTML');

  for (const cls of ['chat-off', 'chat-card-state', 'chat-field', 'chat-input-url', 'chat-note',
    'chat-messages', 'chat-empty', 'chat-msg', 'chat-msg-user', 'chat-msg-assistant', 'chat-msg-error',
    'chat-msg-pending', 'chat-msg-text', 'chat-msg-sub', 'chat-note-line', 'chat-tools', 'chat-tool',
    'chat-tool-toggle', 'chat-tool-running', 'chat-tool-ok', 'chat-tool-fail', 'chat-tool-body',
    'chat-tool-args', 'chat-tool-summary', 'chat-composer', 'chat-input', 'chat-status']) {
    assert.ok(stylesSrc.includes('.' + cls), 'styles.css 缺少样式类 .' + cls);
  }
  assert.ok(/#view-chat\s*\{\s*overflow:\s*hidden/.test(stylesSrc), '#view-chat 应覆盖为 overflow:hidden');
  assert.ok(stylesSrc.includes('.chat-input:disabled'), '缺少输入框禁用样式');
});

/* ==================================================================== *
 * B. 桥接层契约
 * ==================================================================== */

test('api.js 的 CONTRACT 登记全部 9 个 chat.* 键', () => {
  const api = loadApi();
  for (const name of CHAT_METHODS) {
    assert.equal(api.CONTRACT['chat.' + name], 1, 'CONTRACT 缺少 chat.' + name);
  }
  const chatKeys = Object.keys(api.CONTRACT).filter((k) => k.indexOf('chat.') === 0);
  assert.deepEqual(chatKeys.sort(), CHAT_METHODS.map((n) => 'chat.' + n).sort());
});

test('注入假 qk 后 API.chat.* 把参数原样转发给桥接层，onEvent 返回取消订阅函数', async () => {
  const fake = fakeQk();
  const api = loadApi({ qk: fake.qk });
  assert.equal(api.injected, true);
  assert.equal(plain(api.bridgeInfo().missing).length, 0);

  for (const name of CHAT_METHODS) {
    assert.equal(typeof api.chat[name], 'function', 'API.chat.' + name + ' 不是函数');
  }

  const patch = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' };
  await api.chat.status();
  await api.chat.saveConfig(patch);
  await api.chat.clearConfig();
  await api.chat.test();
  await api.chat.models();
  await api.chat.history(100);
  await api.chat.clear();
  await api.chat.send('你好');

  const expected = ['chat.status', 'chat.saveConfig', 'chat.clearConfig', 'chat.test', 'chat.models',
    'chat.history', 'chat.clear', 'chat.send'];
  const seen = fake.calls.map((c) => c.ns + '.' + c.name).filter((k) => expected.indexOf(k) >= 0);
  assert.deepEqual(seen, expected, '转发顺序/次数与调用不一致');
  assert.deepEqual(plain(fake.calls.find((c) => c.name === 'saveConfig').args), [patch]);
  assert.deepEqual(plain(fake.calls.find((c) => c.name === 'history').args), [100]);
  assert.deepEqual(plain(fake.calls.find((c) => c.name === 'send').args), ['你好']);

  const off = api.chat.onEvent(() => {});
  assert.equal(typeof off, 'function', 'onEvent 必须返回取消订阅函数');
  off();
});

test('base 桥（真实 alpha 过渡形态）下 chat.* 返回 NO_BRIDGE，onEvent 返回空操作', async () => {
  const api = loadApi({ qk: fakeQk({ omit: ['agent', 'chat'] }).qk });
  assert.equal(api.injected, true);
  assert.equal(api.has('chat', 'status'), false);
  await assert.rejects(api.chat.status(), (err) => {
    assert.equal(err.code, 'NO_BRIDGE');
    assert.ok(err.message.includes('chat.status()'));
    return true;
  });
  await assert.rejects(api.chat.send('x'), (err) => err.code === 'NO_BRIDGE');
  const off = api.chat.onEvent(() => {});
  assert.equal(typeof off, 'function');
  off();
});

/* ==================================================================== *
 * C. 真实渲染与交互
 * ==================================================================== */

test('AI 对话默认关闭（Beta 测试功能）：隐藏入口并拦截直达，手动在设置开启后才可进入对话', async () => {
  const navChatMatch = html.match(/id="nav-chat"[\s\S]*?<\/button>/);
  assert.ok(navChatMatch && navChatMatch[0].includes('Beta'), 'index.html 侧边栏对话入口应标注 Beta');
  const viewChatIdx = html.indexOf('id="view-chat"');
  assert.ok(viewChatIdx > 0 && html.slice(viewChatIdx, viewChatIdx + 1200).includes('Beta 测试功能'), 'index.html 对话视图应明确标注 Beta 测试功能');

  const app = await bootApp({ chatStatus: CONFIGURED_CHAT, history: BASE_HISTORY });
  assert.equal(app.$('nav-chat').hidden, true, '默认应隐藏侧边栏「对话」导航项');

  // 未开启时尝试切入 chat 视图，应被拦回设置页且不发任何 chat.* 调用
  await app.openChat();
  assert.equal(app.ui.state.view, 'settings', '未开启 AI Beta 时进入对话应引导回设置页');
  assert.equal(app.$('view-chat').hidden, true);
  assert.deepEqual(app.chatCalls(), [], 'AI Beta 关闭时不得发起 chat.* 调用');

  // 在设置页手动开启 AI Beta 后即可正常进入对话
  await app.enableAiBeta();
  assert.equal(app.$('nav-chat').hidden, false);
  await app.openChat();
  assert.equal(app.ui.state.view, 'chat');
  assert.equal(app.$('view-chat').hidden, false);
  assert.equal(app.text('chat-card-status'), 'deepseek-chat · api.deepseek.com/v1');
});

test('未注入桥接层：对话视图整块降级，输入禁用，不发起任何 chat 调用', async () => {
  const app = await bootApp({ bridge: 'none' });

  assert.equal(app.$('nav-chat').hidden, true);
  assert.ok(app.$('chat-card').hasClass('chat-off'));
  assert.equal(app.text('chat-card-status'), '未注入桥接层');
  assert.ok(app.text('chat-card-hint').includes('window.qk 不存在'));
  assert.ok(app.text('chat-messages').includes('未注入桥接层，无法读取对话历史'));
  assert.ok(app.text('chat-status').includes('未注入桥接层，无法使用对话'));
  assert.equal(app.$('chat-input').disabled, true);
  assert.equal(app.$('chat-btn-send').disabled, true);
  assert.equal(app.$('chat-btn-save').disabled, true);
  assert.equal(app.$('chat-btn-test').disabled, true);
  assert.equal(app.$('chat-btn-models').disabled, true);
  assert.equal(app.$('chat-btn-clear').disabled, true);
  assert.deepEqual(app.chatCalls(), [], '未注入桥接层时不得发起 chat.* 调用');
});

test('base 桥（命令未接线）：显示「对话命令未接线」，不发起 chat 调用', async () => {
  const app = await bootApp({ bridge: 'base', aiBetaEnabled: true });
  await app.openChat();

  assert.ok(app.$('chat-card').hasClass('chat-off'));
  assert.equal(app.text('chat-card-status'), '对话命令未接线');
  assert.ok(app.text('chat-card-hint').includes('chat.*'));
  assert.ok(app.text('chat-messages').includes('对话命令未接线'));
  assert.ok(app.text('chat-status').includes('对话命令未接线'));
  assert.deepEqual(app.chatCalls(), []);
});

test('未配置：配置表单展开、输入禁用、状态行给出配置引导', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: UNCONFIGURED_CHAT });
  await app.openChat();

  assert.equal(app.$('chat-card-status').textContent, '尚未配置');
  assert.equal(app.$('chat-config-form').hidden, false, '未配置时表单应展开');
  assert.equal(app.$('chat-btn-settings').hidden, true, '未配置时不应显示「设置」按钮');
  assert.equal(app.$('chat-btn-clear-config').disabled, false);
  assert.equal(app.$('chat-input').disabled, true);
  assert.equal(app.$('chat-btn-send').disabled, true);
  assert.ok(app.text('chat-status').includes('请先配置大模型'));
  assert.equal(app.text('chat-summary'), '尚未配置大模型');
  assert.equal(app.text('chat-card-dot').trim(), '', '未配置状态点应为灰色（无内容）');
  assert.ok(app.$('chat-card-dot').hasClass('agent-dot'));
  assert.ok(!app.$('chat-card-dot').hasClass('agent-dot-on'));
  assert.ok(app.text('chat-messages').includes('暂无对话'));
});

test('已配置：折叠为一行状态（模型名 + Base URL 尾段），历史按形状渲染', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, history: BASE_HISTORY });
  await app.openChat();

  assert.equal(app.text('chat-card-status'), 'deepseek-chat · api.deepseek.com/v1');
  assert.ok(app.$('chat-card-dot').hasClass('agent-dot-on'), '已配置状态点应为绿色');
  assert.equal(app.text('chat-summary'), '模型 deepseek-chat · 工具 19 个');
  assert.equal(app.$('chat-config-form').hidden, true, '已配置时表单默认折叠');
  assert.equal(app.$('chat-btn-settings').hidden, false);
  assert.equal(app.$('chat-input').disabled, false, '已配置且空闲时输入可用');
  assert.equal(app.$('chat-btn-send').disabled, false);
  assert.equal(app.$('chat-api-key').placeholder, '已保存，留空则不修改');
  assert.ok(app.text('chat-status').includes('deepseek-chat · 工具 19 个'));

  const msgs = app.findAll('.chat-msg');
  assert.equal(msgs.length, 3);
  assert.ok(msgs[0].hasClass('chat-msg-user'));
  assert.ok(msgs[0].textContent.includes('帮我看看根目录'));
  assert.ok(msgs[1].hasClass('chat-msg-assistant'));
  assert.ok(msgs[1].textContent.includes('已列出根目录'));
  const tool = msgs[1].querySelector('.chat-tool');
  assert.ok(tool, '助手历史消息缺少工具卡片');
  assert.ok(tool.querySelector('.chat-tool-toggle').textContent.includes('✓ 列出文件 · 12 ms'));
  assert.ok(tool.querySelector('.chat-tool-args').textContent.includes('"pdir_fid":"0"'));
  assert.ok(tool.querySelector('.chat-tool-summary').textContent.includes('共 3 个文件'));
  assert.ok(msgs[1].textContent.includes('1 轮 · 120 ms'));
  assert.ok(msgs[2].hasClass('chat-msg-error'), 'error 历史消息应有错误描边');
});

test('Enter 发送：调用 send、用户气泡上屏、工具事件实时更新、done 渲染回复（核心体验）', async () => {
  let resolveSend = null;
  const pending = new Promise((resolve) => { resolveSend = resolve; });
  const app = await bootApp({
    aiBetaEnabled: true,
    chatStatus: CONFIGURED_CHAT,
    sendImpl: () => pending
  });
  await app.openChat();

  // 事件订阅必须早于任何发送
  assert.equal(app.chatListeners(), 1, '对话进度事件应在发送前完成订阅');

  await app.typeAndSend(app.$('chat-input'), '列出根目录');

  const sendCall = app.calls.filter((c) => c.ns === 'chat' && c.name === 'send').pop();
  assert.ok(sendCall, '未调用 chat.send');
  assert.deepEqual(plain(sendCall.args), ['列出根目录']);
  assert.equal(app.$('chat-input').value, '', '发送后输入框应清空');
  assert.equal(app.$('chat-input').disabled, true);
  assert.equal(app.$('chat-btn-send').disabled, true);
  assert.equal(app.$('chat-btn-send').textContent, '处理中…');

  const userMsgs = app.findAll('.chat-msg-user');
  assert.equal(userMsgs.length, 1);
  assert.equal(userMsgs[0].textContent.includes('列出根目录'), true);

  const assistant = app.findAll('.chat-msg-assistant');
  assert.equal(assistant.length, 1);
  assert.ok(assistant[0].hasClass('chat-msg-pending'), '进行中的助手气泡应半透明');
  assert.ok(app.text('chat-status').includes('正在与模型对话'));

  // round 事件
  app.emitChat({ type: 'round', round: 1, maxRounds: 8 });
  await app.flush();
  assert.ok(app.text('chat-status').includes('第 1/8 轮'));

  // tool_start：工具卡片进入 running
  app.emitChat({ type: 'tool_start', name: 'fs_list', title: '列出文件', args: '{"pdir_fid":"0"}', callId: 'c1' });
  await app.flush();
  let tools = app.findAll('.chat-tool');
  assert.equal(tools.length, 1);
  assert.ok(tools[0].hasClass('chat-tool-running'));
  let toggle = tools[0].querySelector('.chat-tool-toggle');
  assert.equal(toggle.textContent, '正在执行 列出文件…');
  assert.equal(toggle.disabled, true, '进行中的工具不可展开');
  assert.ok(app.text('chat-status').includes('正在调用 列出文件'));

  // tool_end：原地配对更新为 ✓ + 耗时
  app.emitChat({ type: 'tool_end', name: 'fs_list', title: '列出文件', ok: true, ms: 37, summary: '共 3 个文件', args: '{"pdir_fid":"0"}' });
  await app.flush();
  tools = app.findAll('.chat-tool');
  assert.equal(tools.length, 1, 'tool_end 应原地更新而不是新增一行');
  assert.ok(tools[0].hasClass('chat-tool-ok'));
  assert.equal(tools[0].hasClass('chat-tool-running'), false);
  toggle = tools[0].querySelector('.chat-tool-toggle');
  assert.equal(toggle.textContent, '✓ 列出文件 · 37 ms');
  assert.equal(toggle.disabled, false);

  // 展开看参数与摘要
  await app.click(toggle);
  const body = tools[0].querySelector('.chat-tool-body');
  assert.equal(body.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(tools[0].hasClass('chat-tool-open'));
  assert.ok(body.querySelector('.chat-tool-args').textContent.includes('pdir_fid'));
  assert.ok(body.querySelector('.chat-tool-summary').textContent.includes('共 3 个文件'));

  // done 事件先于 send() Promise 落地
  app.emitChat({ type: 'done', reply: '根目录已列出', rounds: 1, ms: 120, toolCalls: [] });
  await app.flush();
  const doneBubble = app.findAll('.chat-msg-assistant')[0];
  assert.equal(doneBubble.hasClass('chat-msg-pending'), false);
  assert.ok(doneBubble.textContent.includes('根目录已列出'));
  assert.ok(doneBubble.textContent.includes('1 轮 · 120 ms'));
  assert.ok(app.text('chat-status').includes('已完成 · 1 轮 · 耗时 120 ms'));
  assert.equal(app.$('chat-btn-send').textContent, '发送');

  // send 返回值随后落地：本轮已有结论，不应重复渲染
  resolveSend({ reply: '根目录已列出', rounds: 1, ms: 120, toolCalls: [] });
  await app.flush();
  await app.flush();
  const subs = app.findAll('.chat-msg-sub');
  assert.equal(subs.length, 1, 'done 事件已渲染后，send 返回值不得重复追加副标题');
  assert.equal(app.findAll('.chat-msg-assistant').length, 1);
  assert.equal(app.$('chat-btn-send').disabled, false);
});

test('工具卡片配对：同名 running 行原地更新；找不到配对时追加新行', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, sendImpl: () => new Promise(() => {}) });
  await app.openChat();
  await app.typeAndSend(app.$('chat-input'), '测试配对');
  app.emitChat({ type: 'round', round: 1, maxRounds: 8 });
  app.emitChat({ type: 'tool_start', name: 'fs_info', title: '查看详情', args: '{}' });
  app.emitChat({ type: 'tool_start', name: 'fs_list', title: '列出文件', args: '{}' });
  await app.flush();
  assert.equal(app.findAll('.chat-tool').length, 2);

  // 乱序结束：先结束第二个，应配对到 fs_list 而不是 fs_info
  app.emitChat({ type: 'tool_end', name: 'fs_list', title: '列出文件', ok: true, ms: 5 });
  await app.flush();
  const rows = app.findAll('.chat-tool');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].hasClass('chat-tool-running'), 'fs_info 仍在执行');
  assert.ok(rows[1].hasClass('chat-tool-ok'), 'fs_list 已完成');

  app.emitChat({ type: 'tool_end', name: 'fs_info', title: '查看详情', ok: false, ms: 2, summary: '资源不存在' });
  await app.flush();
  assert.ok(rows[0].hasClass('chat-tool-fail'));
  assert.ok(rows[0].querySelector('.chat-tool-toggle').textContent.includes('✗ 查看详情'));

  // 未配对的 tool_end：追加一条已完成行
  app.emitChat({ type: 'tool_end', name: 'fs_search', title: '搜索', ok: true, ms: 9, summary: '1 项' });
  await app.flush();
  assert.equal(app.findAll('.chat-tool').length, 3, '未配对结束时追加新行');
});

test('事件流缺席：用 send() 返回值兜底渲染，不会卡在「处理中…」', async () => {
  const app = await bootApp({
    aiBetaEnabled: true,
    chatStatus: CONFIGURED_CHAT,
    sendResult: {
      reply: '兜底回复',
      rounds: 2,
      ms: 88,
      toolCalls: [
        { name: 'fs_search', title: '搜索文件', ok: true, ms: 5, summary: '1 项', args: '{"keyword":"x"}' },
        { name: 'fs_info', title: '查看详情', ok: false, ms: 2, summary: '失败' }
      ]
    }
  });
  await app.openChat();
  await app.typeAndSend(app.$('chat-input'), '兜底测试');
  await app.flush();

  const bubble = app.findAll('.chat-msg-assistant')[0];
  assert.ok(bubble.textContent.includes('兜底回复'));
  assert.equal(bubble.hasClass('chat-msg-pending'), false, '兜底完成后应移除 pending');
  const tools = app.findAll('.chat-tool');
  assert.equal(tools.length, 2, '返回值里的 toolCalls 应补齐为工具卡片');
  assert.ok(tools[0].hasClass('chat-tool-ok'));
  assert.ok(tools[1].hasClass('chat-tool-fail'));
  assert.ok(bubble.textContent.includes('2 轮 · 88 ms'));
  assert.ok(app.text('chat-status').includes('已完成 · 2 轮 · 耗时 88 ms'));
  assert.equal(app.$('chat-btn-send').textContent, '发送');
  assert.equal(app.$('chat-btn-send').disabled, false);
  assert.equal(app.$('chat-input').disabled, false);
});

test('达到轮次上限：done 事件带 max_rounds 时给出「回复可能不完整」提示', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, sendImpl: () => new Promise(() => {}) });
  await app.openChat();
  await app.typeAndSend(app.$('chat-input'), '上限测试');
  app.emitChat({ type: 'round', round: 8, maxRounds: 8 });
  app.emitChat({ type: 'done', reply: '部分结果', rounds: 8, ms: 900, stopped: 'max_rounds' });
  await app.flush();

  const bubble = app.findAll('.chat-msg-assistant')[0];
  assert.ok(bubble.textContent.includes('已达到轮次上限，回复可能不完整'));
  assert.ok(app.text('chat-status').includes('已达到轮次上限'));
  assert.ok(app.text('chat-status').includes('8 轮'));
});

test('保存配置：Key 留空不提交 apiKey；保存后折叠表单并清空 Key 输入；填了 Key 才提交', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, history: [] });
  await app.openChat();

  // 展开表单
  await app.click('chat-btn-settings');
  assert.equal(app.$('chat-config-form').hidden, false);

  app.$('chat-base-url').value = 'https://api.example.com/v1';
  app.$('chat-model').value = 'example-chat';
  app.$('chat-api-key').value = '';
  await app.click('chat-btn-save');

  let call = app.calls.filter((c) => c.ns === 'chat' && c.name === 'saveConfig').pop();
  assert.deepEqual(plain(call.args), [{ baseUrl: 'https://api.example.com/v1', model: 'example-chat' }],
    'Key 留空时不应提交 apiKey 字段');
  assert.equal(app.$('chat-config-form').hidden, true, '保存成功后应折叠表单');
  assert.equal(app.$('chat-api-key').value, '');
  assert.ok(app.text('toasts').includes('大模型配置已保存'));

  // 再次展开并填入 Key
  await app.click('chat-btn-settings');
  app.$('chat-base-url').value = 'https://api.example.com/v1';
  app.$('chat-model').value = 'example-chat';
  app.$('chat-api-key').value = ' sk-test ';
  await app.click('chat-btn-save');
  call = app.calls.filter((c) => c.ns === 'chat' && c.name === 'saveConfig').pop();
  assert.deepEqual(plain(call.args), [{
    baseUrl: 'https://api.example.com/v1', model: 'example-chat', apiKey: 'sk-test'
  }], '填入 Key 时应提交去除空白的 apiKey');
  assert.equal(app.$('chat-api-key').value, '', '保存后立即清空 Key 输入框');
});

test('获取模型列表：填充 datalist、保留已输入值、按钮文案切换', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, models: ['deepseek-chat', 'deepseek-reasoner'] });
  await app.openChat();
  await app.click('chat-btn-settings');

  app.$('chat-model').value = 'deepseek-chat';
  await app.click('chat-btn-models');

  const options = app.$('chat-model-list').children.filter((c) => c.tagName === 'option');
  assert.equal(options.length, 2);
  assert.deepEqual(options.map((o) => o.value), ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal(app.$('chat-model').value, 'deepseek-chat', '已输入的值不应被覆盖');
  assert.equal(app.$('chat-btn-models').textContent, '获取列表');
  assert.ok(app.text('toasts').includes('已获取 2 个模型'));
});

test('失败路径：send reject 与 error 事件都在气泡和状态行给出原因', async () => {
  // send reject
  const rejected = await bootApp({
    aiBetaEnabled: true,
    chatStatus: CONFIGURED_CHAT,
    sendError: { code: 'NETWORK', message: '模型服务不可达', hint: '检查 Base URL' }
  });
  await rejected.openChat();
  await rejected.typeAndSend(rejected.$('chat-input'), '会失败的消息');
  const failBubble = rejected.findAll('.chat-msg-assistant')[0];
  assert.ok(failBubble.hasClass('chat-msg-error'));
  assert.ok(failBubble.textContent.includes('❌ 模型服务不可达'));
  assert.ok(rejected.text('chat-status').includes('失败：模型服务不可达（检查 Base URL）'));
  assert.equal(rejected.$('chat-btn-send').disabled, false);

  // error 事件（先 start 再 error）
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, sendImpl: () => new Promise(() => {}) });
  await app.openChat();
  await app.typeAndSend(app.$('chat-input'), '事件失败');
  app.emitChat({ type: 'round', round: 1, maxRounds: 8 });
  app.emitChat({ type: 'error', code: 'RATE_LIMIT', message: '额度不足', hint: '稍后再试' });
  await app.flush();
  const bubble = app.findAll('.chat-msg-assistant')[0];
  assert.ok(bubble.hasClass('chat-msg-error'));
  assert.ok(bubble.textContent.includes('❌ 额度不足'));
  assert.ok(app.text('chat-status').includes('失败：额度不足（稍后再试）'));
  assert.equal(app.$('chat-btn-send').textContent, '发送');
});

test('清空对话：走 chat.clear 并回到空态；发送中按钮禁用', async () => {
  let resolveSend = null;
  const pending = new Promise((resolve) => { resolveSend = resolve; });
  const app = await bootApp({
    aiBetaEnabled: true,
    chatStatus: CONFIGURED_CHAT,
    history: BASE_HISTORY,
    sendImpl: () => pending
  });
  await app.openChat();

  await app.typeAndSend(app.$('chat-input'), '进行中的消息');
  assert.equal(app.$('chat-btn-clear').disabled, true, '发送中禁止清空对话');
  resolveSend({ reply: '好了', rounds: 1, ms: 10, toolCalls: [] });
  await app.flush();
  await app.flush();
  assert.equal(app.$('chat-btn-clear').disabled, false);

  await app.click('chat-btn-clear');
  assert.equal(app.calls.filter((c) => c.ns === 'chat' && c.name === 'clear').length, 1);
  assert.ok(app.text('chat-messages').includes('暂无对话'));
  assert.ok(app.text('toasts').includes('对话已清空'));
  assert.ok(app.text('chat-status').includes('deepseek-chat'));
});

test('清除配置：二次确认后才调用 clearConfig，并回到展开的未配置表单', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, history: BASE_HISTORY });
  await app.openChat();

  app.setConfirmed(false);
  await app.click('chat-btn-clear-config');
  const confirmCall = app.calls.filter((c) => c.ns === 'dialog' && c.name === 'confirm').pop();
  assert.deepEqual(plain(confirmCall.args), [{
    title: '清除大模型配置',
    message: '将删除 Base URL、模型名以及本机加密存储中的 API Key。',
    detail: '对话历史不受影响；清除后需要重新填写才能继续对话。',
    danger: true,
    confirmText: '清除'
  }]);
  assert.equal(app.calls.filter((c) => c.ns === 'chat' && c.name === 'clearConfig').length, 0);

  app.setConfirmed(true);
  await app.click('chat-btn-clear-config');
  assert.equal(app.calls.filter((c) => c.ns === 'chat' && c.name === 'clearConfig').length, 1);
  assert.equal(app.text('chat-card-status'), '尚未配置');
  assert.equal(app.$('chat-config-form').hidden, false, '清除后应直接展开表单');
  assert.equal(app.$('chat-base-url').value, '');
  assert.equal(app.$('chat-api-key').value, '');
  assert.equal(app.$('chat-model').value, '');
  assert.ok(app.text('toasts').includes('大模型配置已清除'));
});

test('系统确认框缺失：清除配置回落应用内确认框，取消不执行', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, confirmSupported: false });
  await app.openChat();

  await app.click('chat-btn-clear-config');
  const dlg = app.latestOverlay();
  assert.ok(dlg && dlg.querySelector('.dlg-confirm'), '应打开应用内确认框');
  assert.equal(dlg.querySelector('.dlg-title').textContent, '清除大模型配置');
  await app.clickOverlay('cancel');
  assert.equal(app.calls.filter((c) => c.ns === 'chat' && c.name === 'clearConfig').length, 0);

  await app.click('chat-btn-clear-config');
  await app.clickOverlay('ok');
  assert.equal(app.calls.filter((c) => c.ns === 'chat' && c.name === 'clearConfig').length, 1);
});

test('XSS 红线：工具名/参数/摘要中的 HTML 只作为文本渲染，不产生元素节点', async () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, sendImpl: () => new Promise(() => {}) });
  await app.openChat();
  await app.typeAndSend(app.$('chat-input'), '恶意内容测试');
  app.emitChat({ type: 'round', round: 1, maxRounds: 8 });
  app.emitChat({ type: 'tool_start', name: 'fs_info', title: evil, args: evil, callId: 'x' });
  app.emitChat({
    type: 'tool_end', name: 'fs_info', title: evil, ok: true, ms: 1,
    summary: evil, args: evil
  });
  app.emitChat({ type: 'done', reply: evil, rounds: 1, ms: 2, toolCalls: [] });
  await app.flush();

  // 工具标题按纯文本显示（原样保留尖括号），且没有真的插入 img 元素
  const toggle = app.find('.chat-tool-toggle');
  assert.ok(toggle.textContent.includes(evil), '工具标题应以文本形式保留原文');
  assert.equal(app.findAll('img').length, 0, '不得产生 img 元素');
  assert.equal(app.findAll('.chat-msg img').length, 0);
  const args = app.find('.chat-tool-args');
  assert.ok(args.textContent.includes(evil));
  assert.equal(args.children.filter((c) => c.tagName !== '#text').length, 0, 'args 内部不应出现元素节点');
  // 回复同样按文本渲染
  const bubble = app.findAll('.chat-msg-assistant')[0];
  assert.ok(bubble.querySelector('.chat-msg-text').textContent.includes(evil));
});

test('再次进入对话视图会重读配置：外部改动不显示过期状态', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT });
  await app.openChat();
  assert.equal(app.text('chat-card-status'), 'deepseek-chat · api.deepseek.com/v1');

  app.chatStatus.model = 'deepseek-reasoner';
  app.chatStatus.baseUrl = 'https://api.example.com/v1/chat';
  const before = app.chatCalls().filter((n) => n === 'status').length;
  await app.openChat();
  assert.ok(app.chatCalls().filter((n) => n === 'status').length > before, '进入视图应重读配置');
  assert.equal(app.text('chat-card-status'), 'deepseek-reasoner · api.example.com/chat');
});

test('配置状态读取失败：红色状态点与错误原因，表单保持展开', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatusError: '配置文件损坏' });
  await app.openChat();

  assert.equal(app.text('chat-card-status'), '状态读取失败');
  assert.ok(app.$('chat-card-dot').hasClass('agent-dot-error'));
  assert.ok(app.text('chat-status').includes('状态读取失败：配置文件损坏'));
  assert.equal(app.$('chat-config-form').hidden, false);
  assert.equal(app.$('chat-input').disabled, true);
});

test('已配置状态加载与展开设置表单时回填 Base URL 与模型名', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT });
  await app.openChat();

  assert.equal(app.$('chat-base-url').value, CONFIGURED_CHAT.baseUrl);
  assert.equal(app.$('chat-model').value, CONFIGURED_CHAT.model);

  // 清空输入框后点击「设置」展开表单，应强制回填当前生效配置，避免误把空值覆盖提交
  app.$('chat-base-url').value = '';
  app.$('chat-model').value = '';
  await app.click('chat-btn-settings');
  assert.equal(app.$('chat-config-form').hidden, false);
  assert.equal(app.$('chat-base-url').value, CONFIGURED_CHAT.baseUrl);
  assert.equal(app.$('chat-model').value, CONFIGURED_CHAT.model);
});

test('退出登录清空对话历史并重置会话视图', async () => {
  const app = await bootApp({ aiBetaEnabled: true, chatStatus: CONFIGURED_CHAT, history: BASE_HISTORY });
  await app.openChat();
  assert.equal(app.findAll('.chat-msg').length, 3);

  await app.click('btn-logout-2');
  await app.clickOverlay('ok');
  assert.equal(app.ui.state.chat.history.length, 0);
  assert.equal(app.findAll('.chat-msg').length, 0);
  assert.ok(app.text('chat-messages').includes('暂无对话'));
});
