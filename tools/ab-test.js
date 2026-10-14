'use strict';
/**
 * A/B 对照实验：隔离「DLL 补丁」与「未登录」两个变量。
 *
 * 背景：上次 DLL 补丁测试时跳到了会员页，用户指出可能是账号已退出登录所致
 *      （未登录时官方客户端本来就会弹会员引导页）。
 *
 * 实验设计（同一登录态下做 A/B 对比）：
 *   步骤 1: 启动官方客户端（原版 DLL），等待并检测主窗口/会员页
 *   步骤 2: 用户在窗口内完成登录（若未登录）
 *   步骤 3: 关闭 → 打补丁 DLL → 再次启动 → 检测
 *   步骤 4: 还原 → 再次启动 → 检测（对照）
 *
 * 判定标准（以主窗口 URL 为准）：
 *   - 出现 /list/all 等文件管理页 = 功能正常
 *   - 出现 vip.html 且无主窗口   = 跳会员页
 */
const { spawn } = require('child_process');
const fs = require('fs');

const QUARK = process.env.QUARK_EXE
  || 'C:\\Users\\USER\\AppData\\Local\\Programs\\Quark\\quark.exe';
const OFFICIAL_DLL = 'C:\\Users\\USER\\AppData\\Local\\Programs\\Quark\\7.3.5.1009\\quark.dll';
const PATCHED_DLL = 'C:\\Users\\USER\\Documents\\qck\\.work\\quark.dll.patched';
const BAK_DLL = 'C:\\Users\\USER\\Documents\\qck\\.work\\quark.dll.bak';
const PORT = 9777;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  try { execSync0('powershell -NoProfile -Command "Get-Process quark -ErrorAction SilentlyContinue | Stop-Process -Force"'); } catch {}
  try { execSync0('powershell -NoProfile -Command "Get-Process QuarkAccelerator -ErrorAction SilentlyContinue | Stop-Process -Force"'); } catch {}
  sleep0(2500);
}
function execSync0(cmd) { return require('child_process').execSync(cmd, { encoding: 'utf8' }); }
function sleep0(ms) { const d = Date.now() + ms; while (Date.now() < d) {} }

async function listPages() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return await r.json();
  } catch { return []; }
}

/** 启动并观察窗口构成，返回 {main, vip, share, ai, all} */
async function observe(label, waitMs) {
  const deadline = Date.now() + waitMs;
  let result = null;
  while (Date.now() < deadline) {
    const pages = await listPages();
    const real = pages.filter((t) => t.type === 'page' && !/^chrome:/.test(t.url));
    if (real.length) {
      const urls = real.map((t) => t.url);
      result = {
        urls,
        main: urls.some((u) => /clouddrive\/renderer\/index\.html\?name=main/.test(u)),
        vip: urls.some((u) => /vip\.html/.test(u)),
        share: urls.some((u) => /share-link/.test(u)),
        ai: urls.some((u) => /ai_vip|ai-knowledge/.test(u)),
        login: urls.some((u) => /login|passport/.test(u)),
      };
      // 主窗口出现后再等 3 秒确认稳定
      if (result.main || result.vip) { await sleep(3000); break; }
    }
    await sleep(800);
  }
  console.log(`\n【${label}】`);
  if (!result) { console.log('  未捕获到任何页面'); return { main: false, vip: false }; }
  console.log('  主窗口(文件管理): ' + (result.main ? '✓ 有' : '✗ 无'));
  console.log('  会员页(vip.html): ' + (result.vip ? '⚠ 出现' : '无'));
  console.log('  分享窗口: ' + (result.share ? '有' : '无'));
  console.log('  AI 页面: ' + (result.ai ? '有' : '无'));
  console.log('  登录页: ' + (result.login ? '有' : '无'));
  console.log('  全部页面:');
  result.urls.forEach((u) => console.log('    - ' + u.slice(0, 85)));
  return result;
}

async function launchAndObserve(label, waitMs = 25000) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(QUARK, [`--remote-debugging-port=${PORT}`, '--no-first-run'], { env, stdio: 'ignore' });
  return observe(label, waitMs);
}

(async () => {
  console.log('\x1b[1m=== DLL 补丁 A/B 对照实验 ===\x1b[0m');
  console.log('目的：隔离「补丁」与「未登录」两个变量，判定跳会员页的真实原因\n');

  const step = process.argv[2] || '';

  if (step === 'a') {
    // ---------- 步骤 A：原版 DLL ----------
    killAll();
    console.log('\n[A] 原版 DLL 启动（请在此窗口内登录，若已登录则忽略）');
    const r = await launchAndObserve('A: 原版 DLL');
    fs.writeFileSync('C:\\Users\\USER\\Documents\\qck\\.work\\ab-result-A.json',
      JSON.stringify(r, null, 2));
    console.log('\n结果已写入 .work/ab-result-A.json');
    console.log('请保持客户端开启并完成登录，然后运行: node tools/ab-test.js b');
    process.exit(0);
  }

  if (step === 'b') {
    // ---------- 步骤 B：打补丁 DLL ----------
    killAll();
    if (!fs.existsSync(PATCHED_DLL)) {
      console.error('未找到补丁 DLL: ' + PATCHED_DLL);
      console.error('请先运行 step7_apply_patch.py --apply 生成（输出到 .work 而非覆盖官方）');
      process.exit(1);
    }
    // 备份当前官方 DLL（应为原版），再换上补丁版
    fs.copyFileSync(OFFICIAL_DLL, BAK_DLL + '.current');
    fs.copyFileSync(PATCHED_DLL, OFFICIAL_DLL);
    console.log('\n[B] 补丁 DLL 启动');
    const r = await launchAndObserve('B: 补丁 DLL');
    fs.writeFileSync('C:\\Users\\USER\\Documents\\qck\\.work\\ab-result-B.json',
      JSON.stringify(r, null, 2));
    // 立即还原
    fs.copyFileSync(BAK_DLL + '.current', OFFICIAL_DLL);
    console.log('\n已还原官方 DLL');
    console.log('结果已写入 .work/ab-result-B.json');
    process.exit(0);
  }

  console.log('用法：');
  console.log('  node tools/ab-test.js a    # 步骤A：原版启动（请在此完成登录）');
  console.log('  node tools/ab-test.js b    # 步骤B：补丁启动（自动还原）');
  process.exit(0);
})();
