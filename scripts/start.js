'use strict';
/**
 * Electron 启动器。
 *
 * 存在的唯一原因：本机（以及部分 CI/IDE 环境）会注入 `ELECTRON_RUN_AS_NODE=1`，
 * 这会让 electron.exe 以**纯 Node 模式**启动——表现为 `require('electron').app === undefined`，
 * 主进程在 `app.whenReady()` 处直接崩溃，且错误信息极具误导性。
 *
 * 实测证据（Electron 33.4.11）：
 *   设置该变量时 → TypeError: Cannot read properties of undefined (reading 'whenReady')
 *   清除该变量后 → 正常启动，app/BrowserWindow/session 全部可用
 *
 * 因此启动前必须清除该变量；同时若检测到已被剥离，给出明确的中文提示。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolveElectron, electronEnvironment } = require('../src/main/core/platform');

const root = path.join(__dirname, '..');

const electronPath = resolveElectron(root);
if (!electronPath) {
  console.error('无法找到 Electron 可执行文件。请先运行：pnpm install && node node_modules/electron/install.js');
  process.exit(1);
}

// 关键：清除会强制纯 Node 模式的环境变量
const env = electronEnvironment();

const args = [root, ...process.argv.slice(2)];

const child = spawn(electronPath, args, {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code) => process.exit(code === null ? 0 : code));
child.on('error', (e) => {
  console.error('启动 Electron 失败：', e.message);
  process.exit(1);
});
