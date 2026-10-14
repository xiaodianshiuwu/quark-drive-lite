'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/** 与 Electron 默认 userData 位置一致；显式覆盖用于独立验收 profile。 */
function userDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.QCK_USER_DATA_DIR) return paths.resolve(env.QCK_USER_DATA_DIR);
  const base = platform === 'win32' ? (env.APPDATA || paths.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || paths.join(home, '.config'));
  return paths.join(base, 'quark-mini');
}

function electronRelativePath(platform = process.platform) {
  return platform === 'win32' ? 'electron.exe'
    : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
}

function resolveElectron(root, { platform = process.platform, load = () => require('electron'), exists = fs.existsSync } = {}) {
  try {
    const executable = load();
    if (typeof executable === 'string' && exists(executable)) return executable;
  } catch { /* 尝试包内运行时 */ }
  const fallback = path.join(root, 'node_modules', 'electron', 'dist', electronRelativePath(platform));
  return exists(fallback) ? fallback : null;
}

function electronEnvironment(env = process.env) {
  const clean = { ...env };
  delete clean.ELECTRON_RUN_AS_NODE;
  delete clean.NODE_OPTIONS;
  return clean;
}

/** CLI 加密进程必须以完整应用入口启动，使 macOS 的原生 Keychain 名称在早期初始化时一致。 */
function createElectronHostApp(entry) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qck-host-app-'));
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'quark-mini',version:'0.1.0',main:path.resolve(entry),private:true}));
  return {directory,cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}

/** 设备描述反映实际系统；协议版本与已取证的客户端常量分别维护。 */
function deviceModel({ platform = os.platform(), release = os.release(), arch = os.arch() } = {}) {
  const bits = arch === 'x64' || arch === 'arm64' ? '64-bit' : '32-bit';
  if (platform === 'win32') {
    const [major, minor, build] = String(release).split('.').map(Number);
    const name = major === 6 ? ({ 1: 'Windows 7', 2: 'Windows 8', 3: 'Windows 8.1' }[minor] || 'Windows')
      : major === 10 && build >= 22000 ? 'Windows 11' : 'Windows 10';
    return `${name} ${bits}`;
  }
  return `${platform === 'darwin' ? 'macOS (Darwin)' : 'Linux'} ${release} ${arch}`;
}

module.exports = { userDataDir, electronRelativePath, resolveElectron, electronEnvironment, createElectronHostApp, deviceModel };
