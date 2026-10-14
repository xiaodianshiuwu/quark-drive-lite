'use strict';
/**
 * 第三步：开关组合精调——目标是压掉 node.quantum 与 passage_embeddings。
 *
 * 已确认有效：--disable-apollo（播放器消失，-294MB）
 * 待测试：
 *   - disable-apollo 系列衍生开关全部带上
 *   - 从 DLL 再挖 quantum / passage_embeddings 相关的其它开关名
 *   - 不同参数形态（--xxx=1 / --xxx / --enable-features / --disable-features）
 */
const { spawn, execSync } = require('child_process');

const QUARK = process.env.QUARK_EXE
  || 'C:\\Users\\USER\\AppData\\Local\\Programs\\Quark\\quark.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
  let count = 0, memMB = 0;
  const types = [];
  try {
    const c = execSync(
      'powershell -NoProfile -Command "(Get-Process quark -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }).trim();
    count = Number(c) || 0;
    const raw = execSync(
      'powershell -NoProfile -Command "$p = Get-Process quark -ErrorAction SilentlyContinue; if($p){ $p | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum }"',
      { encoding: 'utf8' }).trim();
    memMB = Math.round(Number(raw) / 1024 / 1024);
    const out = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name like \'%quark%\'\\").CommandLine"',
      { encoding: 'utf8' });
    for (const m of out.matchAll(/utility-sub-type=([a-zA-Z._]+)/g)) types.push(m[1]);
  } catch {}
  return { count, memMB, types };
}

async function trial(label, args, waitMs = 14000) {
  console.log('\n===== ' + label + ' =====');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(QUARK, args, { env, stdio: 'ignore' });
  await sleep(waitMs);
  const snap = snapshot();
  const uniq = [...new Set(snap.types)];
  const has = (k) => uniq.some((t) => t.includes(k));
  console.log(`  进程 ${snap.count}  内存 ${snap.memMB}MB  量子:${has('quantum') ? '在' : '无'}  播放器:${has('media_player') ? '在' : '无'}  AI向量:${has('passage') ? '在' : '无'}  埋点(wpk):${has('wpk') ? '在' : '无'}`);
  try { child.kill(); } catch {}
  await sleep(2500);
  return snap;
}

(async () => {
  console.log('\x1b[1m=== 开关组合精调 ===\x1b[0m');

  // 基线：只带 disable-apollo 系列
  await trial('C1. apollo 全家桶',
    ['--disable-apollo', '--disable-apollo-web-audio',
     '--disable-apollo-memorybuffer-video-output', '--disable-apollo-qmni-asr-provider',
     '--no-first-run']);

  // apollo + 各种 quantum 写法
  await trial('C2. apollo全家桶 + quantum 变体',
    ['--disable-apollo', '--disable-quantum', '--disable-quantum-node', '--quantum-off',
     '--disable-node-service', '--no-node', '--no-first-run']);

  // apollo + features 形态（把 DLL 里可能的 feature 名都塞进去试试）
  await trial('C3. apollo + features=QuantumNode,NodeService,PassageEmbeddings',
    ['--disable-apollo',
     '--disable-features=QuantumNodeService,NodeQuantum,PassageEmbeddings,PassageEmbeddingsService,QuantumJsBridge',
     '--no-first-run']);

  console.log('\n[组合测试完成]');
  process.exit(0);
})();
