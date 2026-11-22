'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
let checked = 0;

function checkFile(file) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  checked++;
}

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) checkFile(file);
  }
}

for (const folder of ['src/renderer', 'scripts', 'test']) {
  walk(path.join(root, folder));
}
for (const tool of ['tools/agent-bridge-client.js', 'tools/agent-cli.js', 'tools/agent-mcp.js']) {
  const p = path.join(root, tool);
  if (fs.existsSync(p)) checkFile(p);
}

for (const file of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json']) {
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

console.log(`语法与配置检查通过：${checked} 个 JavaScript 文件；JSON 配置有效。`);
