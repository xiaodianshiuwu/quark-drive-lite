'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { root, target, env } = require('./build-env');
const cli = require.resolve('@tauri-apps/cli/tauri.js');
const args = process.argv.slice(2);
const release = args[0] === 'build' && !args.includes('--debug');
const targetIndex = args.indexOf('--target');
const triple = targetIndex >= 0 ? args[targetIndex + 1] : args.find(a => a.startsWith('--target='))?.slice(9);
const releaseTarget = path.join(target, ...(triple ? [triple] : []), 'release');
const remap = new Map([
  [root, '/src'],
  [path.resolve(env.CARGO_HOME || path.join(homedir(), '.cargo')), '/cargo'],
  [path.resolve(target), '/build'],
]);
const buildEnv = { ...env };
if (release) {
  const userFlags = env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean)
    : (env.RUSTFLAGS || '').split(/\s+/).filter(Boolean);
  const remaps = [...remap].map(([dir, replacement]) => `--remap-path-prefix=${dir}=${replacement}`);
  buildEnv.CARGO_ENCODED_RUSTFLAGS = [...userFlags, ...remaps].join('\x1f');
}

if (args[0] === 'build' && process.platform === 'darwin' && !args.some(a => a === '--bundles' || a.startsWith('--bundles='))) args.push('--bundles', 'app');
const child = spawn(process.execPath, [cli, ...args], {cwd: root, stdio:'inherit', env: buildEnv});
child.on('error', e => {process.stderr.write(e.message+'\n');process.exitCode=1;});
child.on('exit', (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exitCode = code;
  if (code !== 0 || !release) return;
  try {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const binary = fs.readFileSync(path.join(releaseTarget, 'quark-drive-lite-tauri' + suffix));
    for (const [dir, replacement] of remap) {
      const variants = new Set([dir, dir.split(path.sep).join('/')]);
      if ([...variants].some(value => (
        binary.includes(Buffer.from(value)) || binary.includes(Buffer.from(value, 'utf16le'))
      ))) {
        throw new Error(`Release binary contains an unremapped ${replacement} build path.`);
      }
    }
    console.log('Release binary build path check passed.');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
    return;
  }
  if (process.platform !== 'darwin' || args.includes('--no-bundle')) return;
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const app = path.join(releaseTarget, 'bundle/macos', config.productName + '.app');
  if (!fs.existsSync(app)) return;
  const verify = () => spawnSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore' });
  if (verify().status === 0) return;
  // Some unsigned Tauri bundles retain only the executable's resource seal.
  // Seal the complete local bundle; never replace a configured signing identity.
  if (env.APPLE_SIGNING_IDENTITY || spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' }).status !== 0 || verify().status !== 0) {
    process.stderr.write('macOS bundle signature verification failed\n'); process.exitCode = 1;
  }
});
