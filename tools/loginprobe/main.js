'use strict';
/**
 * 登录机制实测（真实 Electron 环境，无需人工扫码）。
 *
 * 目的：验证 LoginController 的**机制**是否正确工作，而不是验证"用户能否登录成功"
 * （后者需要人工扫码，无法自动化）。具体验证：
 *   1. 能创建独立持久化分区并打开真实登录窗口
 *   2. 窗口能真实加载 pan.quark.cn（证明网络与分区都通）
 *   3. 能从该分区真实读到 Cookie（证明 Electron 原生 Cookie 方案可用）
 *   4. checkAlive 真的对**真实判活接口**发起了请求（匿名时应判定为未登录）
 *   5. 超时能被正确触发，并抛出中文错误
 *   6. 超时后窗口被正确关闭（无进程泄漏）
 *   7. 取消能立即中止
 *
 * 这是不依赖人工操作、又能覆盖登录链路关键点的最强验证方式。
 */
const { app, session, BrowserWindow } = require('electron');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'main', 'core');
const { LoginController } = require(path.join(SRC, 'login.js'));

let pass = 0;
let fail = 0;
const failures = [];
const results = [];

function ok(name, detail) {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
function bad(name, detail) {
  fail += 1;
  failures.push({ name, detail });
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
}
function expect(cond, name, detail) {
  cond ? ok(name, detail) : bad(name, detail);
  return !!cond;
}

const PARTITION = 'persist:qk-login-probe';

// 关键：Electron 默认在**所有窗口关闭时自动退出应用**。
// 本探针在超时后销毁登录窗口，会因此提前退出、后续断言根本跑不到。
// （真实应用里主窗口一直存在，所以不受影响；但探针必须显式阻止自动退出。）
app.on('window-all-closed', () => {
  /* 阻止自动退出，由本脚本自己决定何时 app.exit */
});

app.whenReady().then(async () => {
  console.log('\x1b[1m=== 登录机制实测（真实 Electron + 真实网络）===\x1b[0m\n');

  const ses = session.fromPartition(PARTITION);

  // -------------------------------------------------------------------------
  console.log('\x1b[1m1. 分区与 Cookie 读取能力\x1b[0m');
  // -------------------------------------------------------------------------
  const before = await ses.cookies.get({ domain: '.quark.cn' });
  ok('能访问独立分区 persist:qk-login-probe', `初始 cookie ${before.length} 个`);

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1m2. 完整登录流程（短超时，真实加载登录页）\x1b[0m');
  // -------------------------------------------------------------------------
  const stages = [];
  let aliveCalls = 0;
  let aliveResult = null;

  const ctrl = new LoginController({
    partition: PARTITION,
    onProgress: (s) => stages.push(s),
    timeout: 22000, // 短超时，避免自动测试挂太久
    pollInterval: 3000,
  });

  // 包一层，统计 checkAlive 的真实调用与结果
  const origAlive = ctrl.checkAlive.bind(ctrl);
  ctrl.checkAlive = async (h) => {
    aliveCalls += 1;
    const r = await origAlive(h);
    if (aliveResult === null) aliveResult = r;
    return r;
  };

  const started = Date.now();
  let thrown = null;
  try {
    await ctrl.start();
  } catch (e) {
    thrown = e;
  }
  const elapsed = Date.now() - started;

  // ---- 3. 超时行为 ----
  const timedOut = !!thrown && thrown.code === 'TIMEOUT';
  expect(timedOut, '未登录时按超时结束（而非无限等待或崩溃）',
    thrown ? `code=${thrown.code} message=${thrown.message} 耗时=${elapsed}ms` : '未抛错');
  expect(thrown && /登录超时/.test(thrown.message), '超时错误为中文文案',
    thrown ? thrown.message : '');

  // ---- 4. 进度回调 ----
  expect(stages.length >= 2, '进度回调被真实调用', `${stages.length} 次: ${stages.join(' → ')}`);
  expect(stages.some((s) => /登录窗口/.test(s)), '报告了「正在打开登录窗口」');

  // ---- 5. 判活接口真的被调用 ----
  expect(aliveCalls >= 1, 'checkAlive 对真实判活接口发起了请求', `调用 ${aliveCalls} 次`);
  expect(aliveResult === false, '匿名状态下判活结果为「未登录」（真实 401/31001 路径）',
    `首次判活返回 ${aliveResult}`);

  // ---- 6. 窗口清理 ----
  await new Promise((r) => setTimeout(r, 800));
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  expect(wins.length === 0, '超时后登录窗口已关闭（无窗口泄漏）', `剩余窗口 ${wins.length} 个`);

  // ---- 7. 取消路径 ----
  console.log('\n\x1b[1m3. 取消路径\x1b[0m');
  const ctrl2 = new LoginController({ partition: PARTITION, timeout: 60000, pollInterval: 3000 });
  const p2 = ctrl2.start().then(
    () => ({ okRun: true }),
    (e) => ({ okRun: false, code: e && e.code, msg: e && e.message })
  );
  await new Promise((r) => setTimeout(r, 4000)); // 等窗口起来
  await ctrl2.cancel();
  const r2 = await p2;
  expect(r2.okRun === false, '取消后 start() 以错误结束', JSON.stringify(r2));
  expect(r2.code === 'ABORTED', '取消错误码为 ABORTED', `code=${r2.code}`);
  await new Promise((r) => setTimeout(r, 600));
  const wins2 = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  expect(wins2.length === 0, '取消后窗口已关闭', `剩余 ${wins2.length} 个`);

  // ---- 8. Cookie 实际读取能力 ----
  console.log('\n\x1b[1m4. Cookie 读取能力（决定方案可行性）\x1b[0m');
  const after = await ses.cookies.get({ domain: '.quark.cn' });
  const httpOnly = after.filter((c) => c.httpOnly);
  ok('能读取该分区下的 Cookie', `共 ${after.length} 个，其中 HttpOnly ${httpOnly.length} 个`);
  if (after.length) {
    const hasValues = after.every((c) => typeof c.value === 'string');
    expect(hasValues, 'Cookie 的 value 可读（含 HttpOnly）', `样例名: ${after.slice(0, 4).map((c) => c.name).join(', ')}`);
  } else {
    ok('（匿名访问未下发 quark 域 Cookie，属预期）');
  }

  // 清理分区数据
  try {
    await ses.clearStorageData();
  } catch {
    /* ignore */
  }

  console.log(`\n\x1b[1m=== 登录机制结果：${pass} 通过 / ${fail} 失败 ===\x1b[0m`);
  if (fail) {
    console.log('\n\x1b[31m失败详情：\x1b[0m');
    for (const f of failures) console.log(`  · ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  app.exit(fail ? 1 : 0);
});
