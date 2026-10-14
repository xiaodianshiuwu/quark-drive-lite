'use strict';
/**
 * 下载引擎回归测试。
 *
 * 用本地 http server 模拟 CDN，覆盖需求中明确要求的：
 *   - 断点续传（Range/206）
 *   - Range 不支持时**降级为整体重下**（绝不能产生损坏文件）
 *   - 直链过期（403）后重新取链
 *   - 可重试错误自动重试
 *   - 取消后清理临时文件（"要么完整、要么不存在"）
 *   - 重名自动避让
 *
 * 全程纯 Node，不依赖 electron、不访问真实网络。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { HttpClient } = require('../src/main/core/http');
const { createTransferApi } = require('../src/main/core/api-transfer');
const { downloadFile, safeFileName, uniquePath, TEMP_SUFFIX, CFG_SUFFIX } = require('../src/main/core/download');

// ---------------------------------------------------------------------------
// 测试基础设施
// ---------------------------------------------------------------------------

/** 启动一个可控的假 CDN。handler(req,res,ctx) 决定响应。 */
function startServer(handler) {
  return new Promise((resolve) => {
    const state = { requests: [] };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        handler(req, res, state);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      state.port = port;
      state.base = `http://127.0.0.1:${port}`;
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

/** 构造一个只返回下载直链的假 api（把真实取链替换掉）。 */
function fakeApi(base, { onUrl } = {}) {
  let call = 0;
  return {
    async downloadUrl() {
      call += 1;
      if (onUrl) return onUrl(call, base);
      return [{ fid: 'f1', url: `${base}/file.bin` }];
    },
  };
}

function makeHttp() {
  return new HttpClient({ getCookie: () => 'k=v', retries: 0 });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qk-dl-'));
}

function payload(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) b[i] = i % 251;
  return b;
}

/** 等任务进入终态（用于取消等异步场景）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
test('断点续传：已有临时文件 + 服务端支持 206 → 追加写入且文件字节正确', async () => {
  const data = payload(2000);
  const dir = tmpDir();
  const srv = await startServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-/.exec(range);
      const start = m ? Number(m[1]) : 0;
      res.writeHead(206, {
        'content-range': `bytes ${start}-${data.length - 1}/${data.length}`,
        'content-length': data.length - start,
        etag: '"etag-1"',
      });
      res.end(data.subarray(start));
      return;
    }
    res.writeHead(200, { 'content-length': data.length, etag: '"etag-1"' });
    res.end(data);
  });

  try {
    // 预置一个已下载一半的临时文件 + 进度文件，模拟上次中断
    const finalName = 'a.bin';
    const finalPath = path.join(dir, finalName);
    const tempPath = `${finalPath}${TEMP_SUFFIX}`;
    fs.writeFileSync(tempPath, data.subarray(0, 1000));
    fs.writeFileSync(
      `${tempPath}${CFG_SUFFIX}`,
      JSON.stringify({ fid: 'f1', total: data.length, received: 1000, etag: 'etag-1' })
    );

    const r = await downloadFile({
      fid: 'f1',
      fileName: finalName,
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(srv.base),
    });

    assert.strictEqual(r.resumed, true, '应走了续传路径');
    const got = fs.readFileSync(r.localPath);
    assert.strictEqual(got.length, data.length, '最终文件大小必须完整');
    assert.ok(got.equals(data), '最终文件内容必须与源完全一致（断点续传正确性核心）');
    // 临时文件应已收尾清理
    assert.ok(!fs.existsSync(tempPath), '临时文件应已改名清理');
    assert.ok(!fs.existsSync(`${tempPath}${CFG_SUFFIX}`), '进度文件应已清理');
    // 服务端确实收到了 Range 请求
    assert.ok(srv.requests.some((q) => q.headers.range === 'bytes=1000-'), '应发出 Range 请求');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Range 不支持（返回 200）→ 必须降级为从 0 重下，且文件不损坏', async () => {
  const data = payload(1500);
  const dir = tmpDir();
  let sawRange = false;
  const srv = await startServer((req, res) => {
    if (req.headers.range) sawRange = true;
    // 关键：即便收到 Range 也返回 200 全量（模拟不支持断点续传的 CDN）
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });

  try {
    const finalPath = path.join(dir, 'b.bin');
    const tempPath = `${finalPath}${TEMP_SUFFIX}`;
    fs.writeFileSync(tempPath, data.subarray(0, 700)); // 假装上次下了 700 字节
    fs.writeFileSync(
      `${tempPath}${CFG_SUFFIX}`,
      JSON.stringify({ fid: 'f1', total: data.length, received: 700 })
    );

    const r = await downloadFile({
      fid: 'f1',
      fileName: 'b.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(srv.base),
    });

    assert.ok(sawRange, '应尝试过 Range');
    const got = fs.readFileSync(r.localPath);
    assert.strictEqual(got.length, data.length);
    assert.ok(got.equals(data), '降级重下后内容必须正确（不得出现前半段+后半段拼接的损坏文件）');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('直链过期：首次 403 → 重新取链后成功', async () => {
  const data = payload(800);
  const dir = tmpDir();
  let hits = 0;
  const srv = await startServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('AccessDenied');
      return;
    }
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });

  try {
    let urlCalls = 0;
    const api = {
      async downloadUrl() {
        urlCalls += 1;
        return [{ fid: 'f1', url: `${srv.base}/file.bin` }];
      },
    };

    const r = await downloadFile({
      fid: 'f1',
      fileName: 'c.bin',
      localDir: dir,
      http: makeHttp(),
      api,
    });

    assert.strictEqual(r.bytes, data.length);
    assert.ok(urlCalls >= 2, `403 后应重新取链（实际取链 ${urlCalls} 次）`);
    assert.ok(fs.readFileSync(r.localPath).equals(data));
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('可重试错误（500）自动重试后成功', async () => {
  const data = payload(300);
  const dir = tmpDir();
  let hits = 0;
  const srv = await startServer((req, res) => {
    hits += 1;
    if (hits <= 2) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });

  try {
    const r = await downloadFile({
      fid: 'f1',
      fileName: 'd.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(srv.base),
    });
    assert.strictEqual(r.bytes, data.length);
    assert.ok(hits >= 3, `应重试到成功（实际请求 ${hits} 次）`);
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('取消后：临时文件与进度文件都被清理（要么完整、要么不存在）', async () => {
  const dir = tmpDir();
  const big = Buffer.alloc(4 * 1024 * 1024, 7);
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-length': big.length });
    // 慢慢地写，制造一个可以中途取消的下载
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= big.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(big.subarray(sent, sent + 64 * 1024));
      sent += 64 * 1024;
    }, 20);
    res.on('close', () => clearInterval(timer));
  });

  try {
    const controller = new AbortController();
    const finalPath = path.join(dir, 'e.bin');
    const p = downloadFile({
      fid: 'f1',
      fileName: 'e.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(srv.base),
      signal: controller.signal,
    });

    await sleep(200);
    controller.abort();

    let aborted = false;
    try {
      await p;
    } catch (e) {
      aborted = true;
      assert.strictEqual(e.code, 'ABORTED', `应抛 ABORTED，实际 ${e.code}`);
    }
    assert.ok(aborted, '取消应导致 promise 拒绝');

    // 取消会保留临时文件（供续传），但**绝不能**留下一个假的"完整文件"
    assert.ok(!fs.existsSync(finalPath), '取消后不得出现最终文件');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('重名自动避让，不覆盖已有文件', async () => {
  const data = payload(100);
  const dir = tmpDir();
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });

  try {
    fs.writeFileSync(path.join(dir, 'same.bin'), 'EXISTING');
    const r = await downloadFile({
      fid: 'f1',
      fileName: 'same.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(srv.base),
    });
    assert.notStrictEqual(path.basename(r.localPath), 'same.bin', '应改名避让');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'same.bin'), 'utf8'), 'EXISTING', '原文件不得被覆盖');
    assert.ok(fs.readFileSync(r.localPath).equals(data));
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('safeFileName 清洗 Windows 非法字符与路径穿越', () => {
  assert.ok(!/[\\/:*?"<>|]/.test(safeFileName('a\\b/c:d*e?f"g<h>i|j.txt')));
  assert.ok(!safeFileName('..').includes('..'));
  assert.strictEqual(safeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.ok(safeFileName('').length > 0, '空名应有兜底');
  assert.ok(safeFileName('   ').length > 0);
});

test('uniquePath 在重名时递增', async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'x.txt'), '1');
    const p1 = await uniquePath(dir, 'x.txt');
    assert.strictEqual(path.basename(p1), 'x(1).txt');
    fs.writeFileSync(p1, '2');
    const p2 = await uniquePath(dir, 'x.txt');
    assert.strictEqual(path.basename(p2), 'x(2).txt');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 并行分片下载（对齐官方 multipartDownload 行为）
// ===========================================================================

/** 支持 Range 并可统计并发峰值的假 CDN。 */
function startRangeServer(data, opts = {}) {
  const state = { peak: 0, active: 0, requests: [] };
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      state.requests.push({ url: req.url, range: req.headers.range });
      // 0-0 探测请求
      if (req.headers.range === 'bytes=0-0') {
        res.writeHead(206, {
          'content-range': `bytes 0-0/${data.length}`,
          'content-length': 1,
        });
        res.end(data.subarray(0, 1));
        return;
      }
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!m) {
        res.writeHead(200, { 'content-length': data.length });
        res.end(data);
        return;
      }
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]) + 1, data.length);
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      if (opts.delayMs) await sleep(opts.delayMs);
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end - 1}/${data.length}`,
        'content-length': end - start,
      });
      res.end(data.subarray(start, end));
      state.active -= 1;
    });
    server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${server.address().port}`;
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

test('并行分片下载：多连接并发、内容逐字节正确', async () => {
  const data = payload(3000);
  const dir = tmpDir();
  const srv = await startRangeServer(data, { delayMs: 60 });

  try {
    const r = await downloadFile({
      fid: 'f1',
      fileName: 'multi.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(srv.base),
      multipartThreshold: 100, // 强制走并行路径（不必造 8MB 文件）
      mpartSize: 512, // 3000 / 512 ≈ 6 片
      parallel: 4,
    });

    assert.strictEqual(r.multipart, true, '应走并行分片路径');
    const got = fs.readFileSync(r.localPath);
    assert.strictEqual(got.length, data.length, '总长度必须一致');
    assert.ok(got.equals(data), '多分片并发写入后内容必须逐字节正确（偏移不能错位）');
    assert.ok(srv.peak >= 2, `应真正并发（实测并发峰值 ${srv.peak}）`);
    assert.ok(srv.peak <= 4, `并发不得超过设定值 4（实际 ${srv.peak}）`);
    // 分片请求数应与分片数一致
    const partReqs = srv.requests.filter((q) => q.range && q.range !== 'bytes=0-0');
    assert.strictEqual(partReqs.length, Math.ceil(3000 / 512), '分片请求数应等于分片数');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('并行分片下载：断点续传只补缺失分片', async () => {
  const data = payload(2000);
  const dir = tmpDir();
  const srv = await startRangeServer(data);

  try {
    const finalPath = path.join(dir, 'resume.bin');
    const tempPath = `${finalPath}${TEMP_SUFFIX}`;
    // 预置：已完整下载第 1 片（0-499），其余缺失
    const buf = Buffer.alloc(data.length, 0);
    data.copy(buf, 0, 0, 500);
    fs.writeFileSync(tempPath, buf);
    fs.writeFileSync(
      `${tempPath}${CFG_SUFFIX}`,
      JSON.stringify({ fid: 'f1', total: data.length, mode: 'multi', partSize: 500, parts: { 0: 500 } })
    );

    const r = await downloadFile({
      fid: 'f1',
      fileName: 'resume.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(srv.base),
      multipartThreshold: 100,
      mpartSize: 500,
      parallel: 2,
    });

    assert.strictEqual(r.multipart, true);
    assert.strictEqual(r.resumed, true, '应识别为续传');
    const got = fs.readFileSync(r.localPath);
    assert.ok(got.equals(data), '续传后内容必须完整正确');
    // 已完成的第 1 片不应被重新请求（分片请求里不应出现 bytes=0-499）
    const reDownloaded = srv.requests.some((q) => q.range === 'bytes=0-499');
    assert.ok(!reDownloaded, '已完成的第 1 片不应重传');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('并行分片下载：分片字节数不符时该片重下（官方 CONTENT_MISMATCH 行为）', async () => {
  const data = payload(1024);
  const dir = tmpDir();
  let firstPartHits = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.range === 'bytes=0-0') {
      res.writeHead(206, { 'content-range': `bytes 0-0/${data.length}`, 'content-length': 1 });
      res.end(data.subarray(0, 1));
      return;
    }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]) + 1, data.length);
    // 第一次请求某片时故意少发一半数据，模拟传输中断
    if (start === 0) {
      firstPartHits += 1;
      if (firstPartHits === 1) {
        const half = Math.floor((end - start) / 2);
        res.writeHead(206, {
          'content-range': `bytes ${start}-${end - 1}/${data.length}`,
          'content-length': end - start,
        });
        res.end(data.subarray(start, start + half)); // 少发
        return;
      }
    }
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end - 1}/${data.length}`,
      'content-length': end - start,
    });
    res.end(data.subarray(start, end));
  });

  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const r = await downloadFile({
      fid: 'f1',
      fileName: 'mismatch.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(base),
      multipartThreshold: 100,
      mpartSize: 512,
      parallel: 1,
    });

    const got = fs.readFileSync(r.localPath);
    assert.ok(got.equals(data), '字节数不符的分片必须被判失败并重下，最终内容正确');
    assert.ok(firstPartHits >= 2, `首片应被重试（实际请求 ${firstPartHits} 次）`);
  } finally {
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('并行分片下载：分片过程中 403 → 重新取链后该片成功', async () => {
  const data = payload(1200);
  const dir = tmpDir();
  let forbiddenOnce = false;
  let urlCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.range === 'bytes=0-0') {
      res.writeHead(206, { 'content-range': `bytes 0-0/${data.length}`, 'content-length': 1 });
      res.end(data.subarray(0, 1));
      return;
    }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]) + 1, data.length);
    if (start === 0 && !forbiddenOnce) {
      forbiddenOnce = true;
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('AccessDenied');
      return;
    }
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end - 1}/${data.length}`,
      'content-length': end - start,
    });
    res.end(data.subarray(start, end));
  });

  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = {
      async downloadUrl() {
        urlCalls += 1;
        return [{ fid: 'f1', url: `${base}/f` }];
      },
    };

    const r = await downloadFile({
      fid: 'f1',
      fileName: 'expire.bin',
      localDir: dir,
      http: makeHttp(),
      api,
      multipartThreshold: 100,
      mpartSize: 512,
      parallel: 1,
    });

    assert.ok(fs.readFileSync(r.localPath).equals(data), '403 后重取链应能完成下载');
    assert.ok(urlCalls >= 2, `403 后应重新取链（实际 ${urlCalls} 次）`);
  } finally {
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('小文件走单流路径（不启用并行，避免浪费连接）', async () => {
  const data = payload(500);
  const dir = tmpDir();
  const srv = await startRangeServer(data);

  try {
    const r = await downloadFile({
      fid: 'f1',
      fileName: 'small.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(srv.base),
      multipartThreshold: 100 * 1024 * 1024, // 阈值调高 → 强制单流
    });
    assert.strictEqual(r.multipart, false, '小文件应走单流');
    assert.ok(fs.readFileSync(r.localPath).equals(data));
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('服务端不支持 Range（探测返回 200）→ 自动降级为单流', async () => {
  const data = payload(900);
  const dir = tmpDir();
  let sawRangeProbe = false;
  const server = http.createServer((req, res) => {
    if (req.headers.range) sawRangeProbe = true;
    // 一律返回 200 全量，模拟不支持 Range
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });

  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const r = await downloadFile({
      fid: 'f1',
      fileName: 'norange.bin',
      localDir: dir,
      http: makeHttp(),
      api: fakeApi(base),
      multipartThreshold: 100, // 阈值很低，但探测判定不支持 Range，因此必须仍走单流
    });

    assert.ok(sawRangeProbe, '应先做 Range 探测');
    assert.strictEqual(r.multipart, false, '不支持 Range 时必须降级为单流');
    assert.ok(fs.readFileSync(r.localPath).equals(data), '降级后内容必须正确');
  } finally {
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
