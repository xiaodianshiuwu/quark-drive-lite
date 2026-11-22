'use strict';
/**
 * test/tauri-agent-mcp.test.js —— MCP 适配器与桥接客户端回归测试
 *
 * 覆盖：
 *  1. BridgeError 保留 detail 与 biz_code；toToolErrorPayload / toErrorResult 渲染字符串与对象形态 detail；
 *  2. defaultProfileDir / resolveBridge 兼容 QK_PROFILE_DIR 与 Linux XDG_DATA_HOME（对齐 Tauri app_data_dir）；
 *  3. AGENT_UNAUTHORIZED（例如客户端轮换 token）触发 resetClient 并自动重读凭据重连；
 *  4. stdin 管道 EOF 等待队列内请求全部完成并写出 stdout 后再退出。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { BridgeError } = require('../tools/agent-bridge-client');
const mcp = require('../tools/agent-mcp');
const cli = require('../tools/agent-cli');

test('BridgeError 与 MCP toErrorResult 保留并渲染 detail / biz_code', () => {
  const err1 = new BridgeError('移动失败', {
    code: 'AGENT_UPSTREAM',
    hint: '请更换目标目录',
    detail: 'move file fail:[不能移动至相同目录]',
    biz_code: 23003,
  });
  const payload1 = mcp.toToolErrorPayload(err1);
  assert.equal(payload1.detail, 'move file fail:[不能移动至相同目录]');
  assert.equal(payload1.biz_code, 23003);
  const res1 = mcp.toErrorResult(payload1);
  assert.equal(res1.isError, true);
  assert.ok(res1.content[0].text.includes('服务端原始信息：move file fail:[不能移动至相同目录]（code=23003）'));

  const payload2 = {
    code: 'AGENT_UPSTREAM',
    message: '上游报错',
    detail: { upstream_message: 'raw msg', upstream_code: 14001 },
  };
  const res2 = mcp.toErrorResult(payload2);
  assert.ok(res2.content[0].text.includes('服务端原始信息：raw msg（code=14001）'));
});

test('defaultProfileDir 与 resolveBridge 对齐 QK_PROFILE_DIR 及 Linux XDG_DATA_HOME', () => {
  assert.equal(
    mcp.defaultProfileDir({ QK_PROFILE_DIR: '/custom/profile' }, 'linux'),
    '/custom/profile',
  );
  assert.equal(
    mcp.defaultProfileDir({ QCK_PROFILE_DIR: '/qck/dir', QK_PROFILE_DIR: '/qk/dir' }, 'linux'),
    '/qck/dir',
  );
  assert.equal(
    mcp.defaultProfileDir({ XDG_DATA_HOME: '/xdg/data' }, 'linux'),
    path.join('/xdg/data', 'cn.quarkdrive.lite.tauri'),
  );
  assert.equal(
    mcp.defaultProfileDir({}, 'linux'),
    path.join(os.homedir(), '.local', 'share', 'cn.quarkdrive.lite.tauri'),
  );

  // 通过 QK_PROFILE_DIR 读取 bridge.json（同时校验 agent-mcp 与 agent-cli）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-mcp-prof-'));
  try {
    const agentDir = path.join(tmp, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'bridge.json'),
      JSON.stringify({ endpoint: '/tmp/fake.sock', token: 't'.repeat(64) }),
    );
    const r1 = mcp.resolveBridge({ QK_PROFILE_DIR: tmp });
    const r2 = cli.resolveBridge({ QK_PROFILE_DIR: tmp });
    assert.equal(r1.endpoint, '/tmp/fake.sock');
    assert.equal(r2.endpoint, '/tmp/fake.sock');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGENT_UNAUTHORIZED 触发 resetClient 并在凭据更新后自动重连，且透传 detail/biz_code', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'qk-mcp-unauth-'));
  const endpoint = os.platform() === 'win32'
    ? `\\\\.\\pipe\\qk-mcp-unauth-${process.pid}-${Date.now()}`
    : path.join(dir, 'bridge.sock');

  let currentToken = 'new-token-'.padEnd(64, '2');
  let providedToken = 'old-token-'.padEnd(64, '1');
  let resolveCount = 0;

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'auth') {
          if (msg.params && msg.params.token === currentToken) {
            socket.write(`${JSON.stringify({ id: msg.id, ok: true, result: { protocol_version: 1 } })}\n`);
          } else {
            socket.write(`${JSON.stringify({ id: msg.id, ok: false, error: { code: 'AGENT_UNAUTHORIZED', message: '认证失败' } })}\n`);
            socket.end();
          }
        } else if (msg.method === 'tools.list') {
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, result: { tools: [{ name: 'move_entries', description: '移动' }] } })}\n`);
        } else if (msg.method === 'tools.call') {
          socket.write(`${JSON.stringify({
            id: msg.id,
            ok: false,
            error: {
              code: 'AGENT_UPSTREAM',
              message: '移动失败',
              hint: '请检查目录',
              detail: 'move file fail:[目标相同]',
              biz_code: 23003,
            },
          })}\n`);
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(endpoint, resolve));
  const session = mcp.createSession({
    resolveBridge: () => {
      resolveCount += 1;
      return { endpoint, token: providedToken, source: 'test' };
    },
  });
  t.after(async () => {
    session.shutdown();
    for (const s of sockets) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 第一次使用旧 token → AGENT_UNAUTHORIZED → 必须自动 resetClient()
  const failList = await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.ok(failList.error, '旧 token 应返回错误');
  assert.equal(session.client, null, 'AGENT_UNAUTHORIZED 后必须重置 client 以便重读新凭据');

  // 更新凭据后，下一次调用自动重读并成功，且工具错误完整透传 detail 与 biz_code
  providedToken = currentToken;
  const okList = await session.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(okList.result.tools.length, 1);
  assert.ok(resolveCount >= 2, '应重新调用 resolveBridge 获取新凭据');

  const callErr = await session.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'move_entries', arguments: {} },
  });
  assert.equal(callErr.result.isError, true);
  assert.ok(callErr.result.content[0].text.includes('move file fail:[目标相同]（code=23003）'));
});

test('agent-mcp.js 在管道 stdin 立即 EOF 时仍等待队列完成并完整写出响应', async () => {
  const script = path.join(__dirname, '..', 'tools', 'agent-mcp.js');
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }),
  ].join('\n') + '\n';

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    // 一次性写入两行后立即关闭 stdin（触发 EOF）
    child.stdin.end(input);
  });

  assert.equal(result.code, 0, 'stderr=' + result.stderr);
  const lines = result.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, 'EOF 不能提前退出丢掉队列中的响应: ' + result.stdout);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.resultType, 'complete');
  assert.equal(lines[1].id, 2);
  assert.deepEqual(lines[1].result, {});
});
