'use strict';
/**
 * 第二步：实测 quark.dll 里发现的官方内部禁用开关。
 *
 * 发现的明文开关（来自 DLL 字符串取证）：
 *   disable-quantum                              ← 量子桥（node.quantum NodeService，191+135MB）
 *   disable-apollo                               ← 播放器 Apollo（media_player，32MB）
 *   disable-apollo-web-audio
 *   disable-apollo-memorybuffer-video-output
 *   disable-apollo-qmni-asr-provider
 *
 * 测试形态：
 *   A. 作为独立命令行参数：quark.exe --disable-quantum --disable-apollo
 *   B. 挂在 --enable-features / --disable-features 里（Chromium 风格）
 * 观察指标：进程数、内存、关键子进程是否消失。
 */
const { spawn } = require('child_process');

const QUARK = process.env.QUARK_EXE
  || 'C:\\Users\\USER\\AppData\\Local\\Programs\\Quark\\quark.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot(label) {
  const { execSync } = require('child_process');
  let count = 0, memMB = 0;
  const types = [];
  try {
    const raw = execSync(
      'powershell -NoProfile -Command "' +
      '$p = Get-Process quark -ErrorAction SilentlyContinue; ' +
      'if($p){ $p | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum }"',
      { encoding: 'utf8' }
    ).trim();
    memMB = Math.round(Number(raw) / 1024 / 1024);
    const c = execSync(
      'powershell -NoProfile -Command "(Get-Process quark -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }
    ).trim();
    count = Number(c) || 0;
    // 子进程类型
    const out = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name like \'%quark%\'\\").CommandLine"',
      { encoding: 'utf8' }
    );
    for (const m of out.matchAll(/utility-sub-type=([a-zA-Z._]+)/g)) types.push(m[1]);
  } catch (e) {
    return { label, count: -1, memMB: -1, types: [] };
  }
  return { label, count, memMB, types };
}

async function trial(label, extraArgs, waitMs) {
  console.log('\n===== %s ====='.replace('%s', label));
  console.log('  参数:', extraArgs.join(' ') || '(无)');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(QUARK, extraArgs, { env, stdio: 'ignore' });
  await sleep(waitMs);
  const snap = snapshot(label);
  console.log(`  结果: 进程 ${snap.count} 个, 内存 ${snap.memMB} MB`);
  const uniq = [...new Set(snap.types)];
  console.log(`  子进程类型 ${uniq.length} 种:`);
  for (const t of uniq) console.log('     -', t);
  // 检查关键服务是否消失
  const has = (k) => uniq.some((t) => t.includes(k));
  console.log('  量子桥(node.quantum):', has('quantum') ? '仍在 ✗' : '已消失 ✓');
  console.log('  播放器(media_player):', has('media_player') ? '仍在 ✗' : '已消失 ✓');
  console.log('  AI向量(passage_embeddings):', has('passage') ? '仍在 ✗' : '已消失 ✓');
  try { child.kill(); } catch {}
  await sleep(2500);
  return snap;
}

(async () => {
  console.log('\x1b[1m=== 官方内部禁用开关实测 ===\x1b[0m');

  // A: 独立参数形态
  await trial('A1. --disable-quantum --disable-apollo',
    ['--disable-quantum', '--disable-apollo', '--no-first-run'], 14000);

  // B: Chromium features 形态
  await trial('B1. --disable-features 内挂载',
    ['--disable-features=quantum,apollo,QuantumNodeService,ApolloMediaPlayer', '--no-first-run'], 14000);

  console.log('\n[实测完成]');
  process.exit(0);
})();
