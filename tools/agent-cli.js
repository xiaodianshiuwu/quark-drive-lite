#!/usr/bin/env node
'use strict';
/**
 * 夸克网盘 Agent 结构化命令行（与 MCP 适配器共用同一条本机桥接）。
 *
 * 用途：
 *   1. 在接入 MCP 客户端之前，先用命令行确认客户端、网关与授权范围是否就绪；
 *   2. 在脚本/CI 中做可复现的离线或受控验证；
 *   3. 排查"Agent 说操作成功但网盘没变化"这类问题时，直接看结构化返回。
 *
 * 退出码：0 成功；1 工具执行失败；2 用法错误；3 连接/认证失败。
 *
 * 用法：
 *   node tools/agent-cli.js status
 *   node tools/agent-cli.js tools
 *   node tools/agent-cli.js call <tool_name> ['{"参数":...}']
 *   node tools/agent-cli.js call list_dir '{"pdir_fid":"0","size":10}'
 */

const { BridgeClient, BridgeError } = require('./agent-bridge-client');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/** 客户端资料目录（与 Tauri 应用一致）。 */
function defaultProfileDir(env = process.env) {
  if (env.QCK_PROFILE_DIR) return env.QCK_PROFILE_DIR;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'cn.quarkdrive.lite.tauri');
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'cn.quarkdrive.lite.tauri');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cn.quarkdrive.lite.tauri');
}

/** 读取 <profile>/agent/bridge.json（0600，端点与 token）。 */
function readBridgeCredentials(profileDir) {
  const file = path.join(profileDir, 'agent', 'bridge.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error('客户端未启用 Agent 接入，或客户端尚未启动');
      err.code = 'AGENT_DISABLED';
      err.hint = '请在客户端「设置 → Agent 接入」中启用，并保持客户端运行';
      throw err;
    }
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error('Agent 桥接凭据文件已损坏，请在客户端重新生成');
    err.code = 'AGENT_INTERNAL';
    throw err;
  }
  if (!parsed || typeof parsed.endpoint !== 'string' || typeof parsed.token !== 'string') {
    const err = new Error('Agent 桥接凭据不完整，请在客户端重新生成');
    err.code = 'AGENT_INTERNAL';
    throw err;
  }
  return { endpoint: parsed.endpoint, token: parsed.token, transport: parsed.transport || 'unix-socket', file };
}





function resolveBridge(env = process.env) {
  if (env.QCK_AGENT_ENDPOINT && env.QCK_AGENT_TOKEN) {
    return { endpoint: env.QCK_AGENT_ENDPOINT, token: env.QCK_AGENT_TOKEN };
  }
  const dir = env.QCK_PROFILE_DIR ? env.QCK_PROFILE_DIR : defaultProfileDir(env);
  const cred = readBridgeCredentials(dir);
  return { endpoint: cred.endpoint, token: cred.token };
}

function usage() {
  process.stderr.write([
    '用法：',
    '  node tools/agent-cli.js status',
    '  node tools/agent-cli.js tools',
    '  node tools/agent-cli.js call <tool_name> [\'{"参数":...}\']',
    '',
    '环境变量：QCK_PROFILE_DIR / QCK_AGENT_ENDPOINT + QCK_AGENT_TOKEN',
    '',
  ].join('\n'));
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') {
    usage();
    return 2;
  }

  let bridge;
  try {
    bridge = resolveBridge();
  } catch (e) {
    process.stderr.write(`${(e && e.message) || '无法读取桥接凭据'}\n`);
    if (e && e.hint) process.stderr.write(`建议：${e.hint}\n`);
    return 3;
  }

  const client = new BridgeClient({
    endpoint: bridge.endpoint,
    token: bridge.token,
    clientName: 'quark-mini-cli',
    clientVersion: '0.3.0-alpha.1',
    timeoutMs: 900000,
    log: (msg, detail) => process.stderr.write(`[agent-cli] ${msg} ${detail ? JSON.stringify(detail) : ''}\n`),
  });

  try {
    if (command === 'status') {
      const res = await client.status();
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return 0;
    }
    if (command === 'tools') {
      const res = await client.listTools();
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return 0;
    }
    if (command === 'call') {
      const name = rest[0];
      if (!name) { usage(); return 2; }
      let args = {};
      if (rest[1]) {
        try {
          args = JSON.parse(rest[1]);
        } catch {
          process.stderr.write('参数必须是合法 JSON\n');
          return 2;
        }
      }
      const res = await client.callTool(name, args);
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return 0;
    }
    usage();
    return 2;
  } catch (e) {
    if (e instanceof BridgeError) {
      process.stderr.write(`失败：${e.message}\n`);
      if (e.hint) process.stderr.write(`建议：${e.hint}\n`);
      process.stderr.write(`错误码：${e.code}\n`);
      return e.code && e.code.startsWith('BRIDGE') ? 3 : 1;
    }
    process.stderr.write(`失败：${(e && e.message) || String(e)}\n`);
    return 1;
  } finally {
    client.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`未预期错误：${(e && e.stack) || String(e)}\n`);
    process.exit(1);
  });
}

module.exports = { resolveBridge };
