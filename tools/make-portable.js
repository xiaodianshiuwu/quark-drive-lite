'use strict';
/**
 * 一键生成「夸克网盘极简版」便携绿色版。
 *
 * 产出：dist/夸克网盘极简版/
 *   ├─ 夸克网盘极简版.exe   ← 重命名后的 electron.exe（双击即运行）
 *   ├─ *.dll / *.pak / locales/  ← Electron 运行时（已就位）
 *   └─ resources/app.asar      ← 应用源码（已就位）
 *
 * 原理：electron-builder 已把 Electron 运行时解压到 dist/win-unpacked，
 *       便携目录完整复制构建产物，不改写 app.asar 或可执行文件中的完整性信息。
 */
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const fuses = require(require.resolve('@electron/fuses', { paths: [path.dirname(require.resolve('electron-builder'))] }));

const ROOT = path.join(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const OUT = path.join(ROOT, 'dist', '夸克网盘极简版');
for (const target of [UNPACKED, OUT]) {
  const rel = path.relative(ROOT, path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('打包目录超出项目范围');
}

function log(m) { console.log(m); }

(async () => {
  log('\x1b[1m=== 生成夸克网盘极简版（便携绿色版）===\x1b[0m\n');

  // 必须由当前源码先执行 electron-builder；不可混用旧缓存运行时。
  const builtName = '夸克网盘极简版.exe';
  const exe = path.join(UNPACKED, builtName);
  const asarOut = path.join(UNPACKED, 'resources', 'app.asar');
  if (!fs.existsSync(exe) || !fs.existsSync(asarOut)) throw Error('请先执行 npm run pack:win');
  const metadata = JSON.parse(asar.extractFile(asarOut, 'package.json'));
  if (metadata.version !== require('../package.json').version) throw Error('构建版本与源码不一致');
  function verifySource(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) verifySource(file);
      else if (!entry.name.endsWith('.map')) {
        const relative = path.relative(ROOT, file);
        if (!fs.readFileSync(file).equals(asar.extractFile(asarOut, relative))) throw Error(`构建源码过期：${relative}`);
      }
    }
  }
  verifySource(path.join(ROOT, 'src'));
  log('✓ 当前版本源码与已构建的 app.asar 完全一致');

  // 4) 组装输出目录
  log('组装输出目录...');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(UNPACKED, OUT, { recursive: true });

  // builder 已设置安全 fuses；此处验证，保持构建文件字节不变。
  const newExe = path.join(OUT, builtName);
  const configured = await fuses.getCurrentFuseWire(newExe);
  for (const option of [fuses.FuseV1Options.RunAsNode, fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    fuses.FuseV1Options.EnableNodeCliInspectArguments]) {
    if (configured[option] !== '0'.charCodeAt(0)) throw Error('便携包运行时未禁用 Node 注入');
  }

  // 6) 写一个说明
  fs.writeFileSync(path.join(OUT, '使用说明.txt'),
    '夸克网盘极简版\n' +
    '============\n\n' +
    '双击「夸克网盘极简版.exe」即可运行，无需安装、无需 Node。\n\n' +
    '功能：文件浏览 / 搜索 / 新建 / 移动 / 复制 / 重命名 / 批量删除 / 上传 / 下载 / 传输任务管理\n' +
    '已移除：AI、播放器、推广、同步盘等无关功能。\n\n' +
    '首次使用请点右上角「登录」扫码。\n' +
    '登录态加密保存在本机，下次免扫码。\n',
    'utf8');

  // 统计
  const files = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else files.push([n, st.size]);
    }
  })(OUT);
  const totalMB = files.reduce((a, [, s]) => a + s, 0) / 1024 / 1024;

  log(`\n\x1b[32m✓ 便携版已生成: ${OUT}\x1b[0m`);
  log(`  共 ${files.length} 个文件，合计 ${totalMB.toFixed(1)} MB`);
  log(`  主程序: 夸克网盘极简版.exe (${(fs.statSync(newExe).size / 1024 / 1024).toFixed(0)} MB)`);
  log('\n把整个文件夹拷到任意 Windows 机器，双击 exe 即可用。');
  process.exit(0);
})().catch((e) => { console.error('生成失败:', e.message); process.exit(1); });
