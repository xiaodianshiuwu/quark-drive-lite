'use strict';
/**
 * 第四步：用标准 Chromium 开关压掉 AI 向量(passage_embeddings) 与埋点(wpk)。
 *
 * 依据：
 *  - DLL 中发现 History.Embeddings / PermissionsAI 字样 → 这是 Chromium 上游组件
 *  - 标准 Chromium 对应开关：
 *      --disable-features=HistoryEmbeds,OptimizationGuide...,PageContentAnnotations
 *      --disable-component-update --disable-background-networking
 *  - wpk 是夸克自研埋点，无标准开关 → 尝试 features 猜测 + hosts 级别无关（本地服务）
 */
const { spawn, execSync } = require('child_process');

const QUARK = 'C:\\Users\\USER\\AppData\\Local\\Programs\\Quark\\quark.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
  let count = 0, memMB = 0;
  const types = [];
  try {
    count = Number(execSync(
      'powershell -NoProfile -Command "(Get-Process quark -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }).trim()) || 0;
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
  const s = snapshot();
  const uniq = [...new Set(s.types)];
  const has = (k) => uniq.some((t) => t.includes(k));
  console.log(`  进程 ${s.count}  内存 ${s.memMB}MB  量子:${has('quantum') ? '在' : '无'}  播放器:${has('media_player') ? '在' : '无'}  AI向量:${has('passage') ? '在' : '无'}  埋点:${has('wpk') ? '在' : '无'}`);
  try { child.kill(); } catch {}
  await sleep(2500);
  return s;
}

(async () => {
  console.log('\x1b[1m=== AI向量/埋点 压制测试 ===\x1b[0m');
  const apollo = ['--disable-apollo', '--disable-apollo-web-audio',
    '--disable-apollo-memorybuffer-video-output', '--disable-apollo-qmni-asr-provider',
    '--disable-quantum-node', '--no-node'];

  // D1: apollo + 标准 Chromium embeddings/optimization 开关
  await trial('D1. apollo + HistoryEmbeds 等标准开关', [
    ...apollo,
    '--disable-features=HistoryEmbeds,PageContentAnnotations,OptimizationGuideModelDownloading,PermissionsAI,PassageEmbeddings,EmbedderBackend',
    '--disable-component-update',
    '--disable-background-networking',
  ]);

  // D2: 更激进——把 OptGuide 整个禁了 + 本地无 hosts 方案
  await trial('D2. apollo + 全量 AI/优化 开关', [
    ...apollo,
    '--disable-features=HistoryEmbeds,PageContentAnnotations,OptimizationHints,OptimizationGuideModelDownloading,OptimizationTargetPrediction,PermissionsAI,PassageEmbeddings,EmbedderBackend,EmbeddingModelDownload,MachineIntelligence',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-remote-fonts',
  ]);

  console.log('\n[测试完成]');
  process.exit(0);
})();
