'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
if (process.platform !== 'darwin') throw new Error('macOS 应用需要在 Mac 上构建');
// macOS 文件提供者会持续为 Documents 内的 .app 重建 FinderInfo；签名前清理也无法避免竞态。
// 在不受云盘同步的缓存目录中完成整个构建与签名，验收入口通过清单定位真实产物。
const id = crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 12);
const directory = path.join(os.homedir(), 'Library', 'Caches', 'quark-mini-builds', id);
const manifest = path.join(root, '.work', 'macos-build.json');
fs.mkdirSync(path.dirname(manifest), { recursive: true });
fs.rmSync(manifest, { force: true });
const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
const result = spawnSync(process.execPath, [cli, '--mac', '--dir', '--publish', 'never',
  '--config', 'builder.config.json', `--config.directories.output=${directory}`, ...process.argv.slice(2)],
{ cwd: root, env: process.env, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const buildArch=process.argv.includes('--x64')?'x64':process.argv.includes('--arm64')?'arm64':process.arch;
const output = path.join(directory, buildArch === 'arm64' ? 'mac-arm64' : 'mac');
const appName = fs.readdirSync(output).find(name => name.endsWith('.app'));
if (!appName) throw new Error('未找到 macOS 构建产物');
const bundle = path.join(output, appName);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
const binaries = path.join(bundle, 'Contents', 'MacOS');
const executable = path.join(binaries, fs.readdirSync(binaries).find(name => fs.statSync(path.join(binaries, name)).isFile()));
fs.writeFileSync(manifest, JSON.stringify({ directory, bundle, executable, arch: buildArch }, null, 2) + '\n');
console.log(`macOS 应用已构建并通过签名校验：${bundle}`);
