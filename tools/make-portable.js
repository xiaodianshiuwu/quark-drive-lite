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
 *       我们用 @electron/asar 把源码打进 resources/app.asar，再把 electron.exe
 *       重命名为中文名。主进程零第三方依赖，因此无需 node_modules。
 */
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const fuses = require(require.resolve('@electron/fuses', { paths: [path.dirname(require.resolve('electron-builder'))] }));

const ROOT = path.join(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const OUT = path.join(ROOT, 'dist', '夸克网盘极简版');
const STAGING = path.join(ROOT, '.build-staging');
for (const target of [UNPACKED, OUT, STAGING]) {
  const rel = path.relative(ROOT, path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('打包目录超出项目范围');
}

function log(m) { console.log(m); }

(async () => {
  log('\x1b[1m=== 生成夸克网盘极简版（便携绿色版）===\x1b[0m\n');

  // 1) 检查 Electron 运行时是否已就位
  const exe = path.join(UNPACKED, 'electron.exe');
  if (!fs.existsSync(exe)) {
    const runtimeExe = require('electron');
    if (typeof runtimeExe !== 'string' || !fs.existsSync(runtimeExe)) throw new Error('请先安装 Electron 运行时');
    if (path.basename(runtimeExe) !== 'electron.exe') {
      throw new Error('便携版需要 Windows Electron 运行时，请先将官方 Windows x64 运行时解压到 dist/win-unpacked');
    }
    fs.mkdirSync(UNPACKED, { recursive: true });
    fs.cpSync(path.dirname(runtimeExe), UNPACKED, { recursive: true });
  }
  log('✓ Electron 运行时已就位: dist/win-unpacked');

  // 2) 准备 staging（源码 + package.json）
  log('准备应用源码...');
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGING, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(STAGING, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(STAGING, 'package.json'));

  // 3) 打成 app.asar（用 @electron/asar 的 API）
  log('打包 app.asar...');
  const asarOut = path.join(UNPACKED, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(asarOut), { recursive: true });
  await asar.createPackage(STAGING, asarOut);
  log('✓ app.asar 已生成');

  // 4) 组装输出目录
  log('组装输出目录...');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(UNPACKED, OUT, { recursive: true });

  // 5) 重命名 exe 为中文名
  const newExe = path.join(OUT, '夸克网盘极简版.exe');
  fs.renameSync(path.join(OUT, 'electron.exe'), newExe);
  // 便携版双击启动不能被 IDE 注入的 Node 环境变量劫持。
  await fuses.flipFuses(newExe, {
    version: fuses.FuseVersion.V1,
    [fuses.FuseV1Options.RunAsNode]: false,
    [fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [fuses.FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
  log('✓ 已重命名为: 夸克网盘极简版.exe');

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
