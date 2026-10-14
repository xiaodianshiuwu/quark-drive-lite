'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const output = path.join(root, '.work', 'release');
fs.mkdirSync(output, { recursive: true });
const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
const extension = process.platform === 'linux' ? 'tar.gz' : 'zip';
const macManifest = process.platform === 'darwin' ? JSON.parse(fs.readFileSync(path.join(root, '.work', 'macos-build.json'), 'utf8')) : null;
const arch = macManifest?.arch || process.arch;
const name = `quark-drive-lite-${version}-${platform}-${arch}.${extension}`;
const destination = path.join(output, name);
fs.rmSync(destination, { force: true });
if (process.platform === 'darwin') {
  const { bundle } = macManifest;
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', bundle, destination]);
} else if (process.platform === 'win32') {
  // 参数经环境变量传递，避免 PowerShell 路径引号与代码插值。
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath $env:QCK_ARCHIVE_SOURCE -DestinationPath $env:QCK_ARCHIVE_DESTINATION -CompressionLevel Optimal'],
  { env: { ...process.env, QCK_ARCHIVE_SOURCE: path.join(root, 'dist', '夸克网盘极简版'), QCK_ARCHIVE_DESTINATION: destination }, stdio: 'inherit' });
} else if (process.platform === 'linux') {
  execFileSync('tar', ['-czf', destination, '-C', path.join(root, 'dist'), 'linux-unpacked']);
} else throw Error('不支持此发布平台');
const digest = crypto.createHash('sha256');
const stream = fs.createReadStream(destination);
stream.on('data', bytes => digest.update(bytes));
stream.on('error', error => { throw error; });
stream.on('end', () => {
  fs.writeFileSync(`${destination}.sha256`, `${digest.digest('hex')}  ${name}\n`);
  console.log(`预发布产物：${name}`);
});
