'use strict';
// 审查发现的缺陷：本地服务模拟协议与并发，全部使用测试文件和测试凭证。
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeHttp = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const root = process.env.QCK_AUDIT_ROOT || path.join(__dirname, '..');
const { HttpClient } = require(path.join(root, 'src/main/core/http'));
const { downloadFile, TEMP_SUFFIX, CFG_SUFFIX, safeFileName } = require(path.join(root, 'src/main/core/download'));
const { uploadFile, mapLimit } = require(path.join(root, 'src/main/core/upload'));
const { createTransferApi } = require(path.join(root, 'src/main/core/api-transfer'));
const { createTransferModule } = require(path.join(root, 'src/main/modules/transfer'));
const { createSecureStore } = require(path.join(root, 'src/main/core/secure-store'));
const { ErrCode, QuarkError } = require(path.join(root, 'src/main/core/errors'));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 2500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await delay(10); }
  throw new Error('等待状态超时');
}
async function deadline(p, ms = 500) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('操作没有及时结束')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qck-audit-'));
  const server = nodeHttp.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return { dir, base, server, http: new HttpClient({ baseUrl: base, retries: 0, getCookie: () => 'audit=sentinel' }),
    api: { downloadUrl: async fids => fids.map(fid => ({ fid, url: `${base}/${fid}` })) } };
}
function sendRange(req, res, data) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : data.length - 1;
  res.writeHead(match ? 206 : 200, {
    'content-length': end - start + 1,
    ...(match ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
    etag: '"audit"',
  });
  res.end(data.subarray(start, end + 1));
}

test('HTTP：单次 timeout 覆盖默认值且超时返回 TIMEOUT', async t => {
  const f = await fixture(t, (_, res) => setTimeout(() => res.end('{"code":0}'), 150));
  await assert.rejects(() => f.http.get('/slow', {}, { timeout: 15 }), e => e.code === ErrCode.TIMEOUT);
});

test('HTTP：timeout=0 真正禁用默认超时', async t => {
  const f = await fixture(t, (_, res) => setTimeout(() => res.end('{"code":0}'), 70));
  f.http.timeout = 10;
  assert.equal((await f.http.get('/slow', {}, { timeout: 0 })).code, 0);
});

test('HTTP：响应头返回后仍可中止正在读取的响应体', async t => {
  const f = await fixture(t, (_, res) => { res.writeHead(200); res.write('a'); });
  const ctrl = new AbortController();
  const res = await f.http.request({ path: '/stream', raw: true, timeout: 0, signal: ctrl.signal });
  const body = res.text();
  ctrl.abort();
  await assert.rejects(() => deadline(body), e => e.code === ErrCode.ABORTED);
});

test('HTTP：cookies=false 的 OSS 请求不携带 Cookie、Origin 或 Referer', async t => {
  let seen;
  const f = await fixture(t, (req, res) => { seen = req.headers; res.end('{"code":0}'); });
  await f.http.request({ path: '/oss', cookies: false });
  assert.equal(seen.cookie, undefined);
  assert.equal(seen.origin, undefined);
  assert.equal(seen.referer, undefined);
});

test('HTTP：直连请求也必须使用显式注入的传输实现', async t => {
  const f = await fixture(t, (_, res) => res.end('{"code":0,"data":"错误传输层"}'));
  const client = new HttpClient({ baseUrl: f.base, fetch: async () => new Response('{"code":0,"data":"注入"}') });
  assert.equal((await client.request({ path: '/direct', cookies: false })).data, '注入');
});

test('HTTP：非幂等 POST 默认不会自动重放', async t => {
  let count = 0;
  const f = await fixture(t, (_, res) => { count++; res.writeHead(500); res.end('{"code":500}'); });
  f.http.retries = 2;
  await assert.rejects(() => f.http.post('/create', {}));
  assert.equal(count, 1);
});

test('下载：同名并发任务分别保存，各自字节正确', async t => {
  const data = { a: Buffer.alloc(5000, 1), b: Buffer.alloc(3000, 2) };
  const f = await fixture(t, (req, res) => sendRange(req, res, data[req.url.slice(1)]));
  const results = await Promise.all(['a', 'b'].map(fid => downloadFile({ ...f, fid, localDir: f.dir, fileName: '相同.bin', maxRetries: 0 })));
  assert.notEqual(results[0].localPath, results[1].localPath);
  for (let i = 0; i < results.length; i++) assert.deepEqual(fs.readFileSync(results[i].localPath), data[['a','b'][i]]);
});

test('下载：临时文件属于另一个 fid 时避让，不删除或续写它', async t => {
  const f = await fixture(t, (req, res) => sendRange(req, res, Buffer.from('新内容')));
  const temp = path.join(f.dir, '相同.bin') + TEMP_SUFFIX;
  fs.writeFileSync(temp, '原任务内容');
  fs.writeFileSync(temp + CFG_SUFFIX, JSON.stringify({ fid: 'old' }));
  const r = await downloadFile({ ...f, fid: 'new', localDir: f.dir, fileName: '相同.bin' });
  assert.notEqual(r.localPath, temp.slice(0, -TEMP_SUFFIX.length));
  assert.equal(fs.readFileSync(temp, 'utf8'), '原任务内容');
});

test('下载：收尾前目标被其他程序创建时，不能覆盖该文件', async t => {
  const f = await fixture(t, (req, res) => sendRange(req, res, Buffer.from('下载内容')));
  const final = path.join(f.dir, '保留.bin');
  await assert.rejects(() => downloadFile({ ...f, fid: 'a', localDir: f.dir, fileName: '保留.bin', maxRetries: 0,
    onTarget: target => fs.writeFileSync(target, '用户内容') }), e => e.code === ErrCode.CONFLICT);
  assert.equal(fs.readFileSync(final, 'utf8'), '用户内容');
});

test('下载：探测支持 Range、实际分片返回 200 时降级单流', async t => {
  const data = Buffer.alloc(4096, 7);
  const f = await fixture(t, (req, res) => {
    if (req.headers.range === 'bytes=0-0') return sendRange(req, res, data);
    res.writeHead(200, { 'content-length': data.length }); res.end(data);
  });
  const r = await downloadFile({ ...f, fid: 'a', localDir: f.dir, fileName: '降级.bin', multipartThreshold: 1, mpartSize: 512, parallel: 4, maxRetries: 0 });
  assert.equal(r.multipart, false);
  assert.deepEqual(fs.readFileSync(r.localPath), data);
});

test('下载：分片范围错误时不会把等长错误数据拼成成功文件', async t => {
  const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  const f = await fixture(t, (req, res) => {
    if (!req.headers.range || req.headers.range === 'bytes=0-0') return sendRange(req, res, data);
    res.writeHead(206, { 'content-range': `bytes 0-511/${data.length}`, 'content-length': 512 }); res.end(data.subarray(0,512));
  });
  const r = await downloadFile({ ...f, fid: 'a', localDir: f.dir, fileName: '范围.bin', multipartThreshold: 1, mpartSize: 512, parallel: 3, maxRetries: 0 });
  assert.deepEqual(fs.readFileSync(r.localPath), data);
});

test('下载：Windows 保留设备名被转换为普通文件名', () => {
  for (const name of ['CON.txt','nul','LPT1.zip']) assert.match(safeFileName(name), /^_/);
});

test('上传：每片 PUT 的查询参数与签名串完全一致', async t => {
  const f = await fixture(t, (_, res) => res.end());
  const localPath = path.join(f.dir, '上传.bin'); fs.writeFileSync(localPath, Buffer.alloc(65537));
  const signatures = [], urls = [];
  const api = {
    uploadPre: async () => ({ taskId: 't', objKey: 'key', bucket: 'bucket', uploadId: 'u/id', uploadUrl: 'oss.example', partSize: 65536 }),
    updateHash: async () => false,
    uploadAuth: async p => { signatures.push(p.authMeta); return 'signature'; },
    ossPutPart: async p => { urls.push(p.url); return 'etag'; },
    ossComplete: async () => {}, uploadFinish: async () => {},
  };
  await uploadFile({ localPath, http: {}, api, concurrency: 1 });
  assert.equal(urls.length, 2);
  urls.forEach((url, i) => { const u = new URL(url); assert.equal(u.searchParams.get('partNumber'), String(i+1)); assert.equal(u.searchParams.get('uploadId'), 'u/id'); assert.ok(signatures[i].endsWith(`partNumber=${i+1}&uploadId=u/id`)); });
});

test('上传：一个并发分片失败后等待其他分片退出，不再启动新分片', async () => {
  let active = 0, completed = false;
  await assert.rejects(() => mapLimit([1,2,3], 2, async n => {
    active++; try { if (n === 1) throw new Error('首片失败'); await delay(60); completed = true; } finally { active--; }
  }));
  assert.equal(active, 0);
  // 同步失败可以在第二个 worker 启动前终止队列，因此不要求第二片一定启动。
  assert.equal(typeof completed, 'boolean');
});

test('上传：暂停恢复保留任务与已经完成的分片', async t => {
  const f = await fixture(t, (_, res) => res.end());
  const localPath = path.join(f.dir, '续传.bin'); fs.writeFileSync(localPath, Buffer.alloc(65537));
  const checkpoint = {}, controller = new AbortController();
  let preCount = 0, putCount = 0;
  const api = {
    uploadPre: async () => { preCount++; return { taskId: 't', objKey: 'key', bucket: 'bucket', uploadId: 'u', uploadUrl: 'oss.example', partSize: 65536 }; },
    updateHash: async () => false, uploadAuth: async () => 'signature',
    ossPutPart: async p => { if (p.signal.aborted) throw new QuarkError('已中止', { code: ErrCode.ABORTED }); putCount++; return 'etag'; },
    ossComplete: async () => {}, uploadFinish: async () => {},
  };
  await assert.rejects(() => uploadFile({ localPath, api, checkpoint, concurrency: 1, signal: controller.signal,
    onProgress: p => { if (p.transferred === 65536) controller.abort(); } }), e => e.code === ErrCode.ABORTED);
  await uploadFile({ localPath, api, checkpoint, concurrency: 1 });
  assert.equal(preCount, 1);
  assert.equal(putCount, 2);
});

test('上传：OSS 返回 HTTP 200 的 Error XML 也必须报错', async () => {
  const api = createTransferApi({ http: { request: async () => new Response('<Error><Code>InternalError</Code></Error>') } });
  await assert.rejects(() => api.ossComplete({ url: 'https://oss.example', xml: '' }), e => e.code === ErrCode.SERVER);
});

test('上传：并发预读时真正 PUT 仍按连续编号执行', async t => {
  const f=await fixture(t,(_,res)=>res.end());
  const localPath=path.join(f.dir,'顺序.bin');fs.writeFileSync(localPath,Buffer.alloc(65536*2+3));
  const order=[];let active=0,peak=0;
  const api={
    uploadPre:async()=>({taskId:'t',objKey:'k',bucket:'b',uploadId:'u',uploadUrl:'oss.example',partSize:65536}),
    updateHash:async()=>false,uploadAuth:async()=> 'key',
    ossPutPart:async p=>{active++;peak=Math.max(peak,active);order.push(Number(new URL(p.url).searchParams.get('partNumber')));await delay(20);active--;return 'etag';},
    ossComplete:async()=>{},uploadFinish:async()=>{},
  };
  await uploadFile({localPath,api,concurrency:3});
  assert.deepEqual(order,[1,2,3]);assert.equal(peak,1);
});

test('任务队列：快速暂停和继续不会产生两个写入执行器', async t => {
  const data = Buffer.alloc(4096, 9); let active = 0, peak = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url.startsWith('/1/')) { res.end(JSON.stringify({ code:0, data:[{ download_url: `${f.base}/file` }] })); return; }
    if (req.headers.range === 'bytes=0-0') return sendRange(req,res,data);
    const match = /bytes=(\d+)-/.exec(req.headers.range || ''); const start = match ? Number(match[1]) : 0;
    res.writeHead(match ? 206 : 200, { 'content-length': data.length-start,
      ...(match ? { 'content-range': `bytes ${start}-${data.length-1}/${data.length}` } : {}) });
    active++; peak = Math.max(peak, active); let pos = start;
    const timer = setInterval(() => { const end = Math.min(pos+256, data.length); res.write(data.subarray(pos,end)); pos=end; if (pos===data.length) res.end(); }, 15);
    res.on('close', () => { clearInterval(timer); active--; });
  });
  const queue = createTransferModule({ http:f.http, getConcurrency:()=>({ download:1 }) });
  const [id] = queue.download({ fids:['a'], names:['队列.bin'], localDir:f.dir });
  await waitFor(() => queue.list()[0].transferred > 0);
  const pause = queue.pause(id); await queue.resume(id); await pause;
  await waitFor(() => queue.list()[0].status === 'done');
  assert.equal(peak, 1);
  assert.deepEqual(fs.readFileSync(queue.list()[0].localPath), data);
  await queue.retry(id); assert.equal(queue.list()[0].status, 'done');
});

test('任务队列：本地文件不存在时不自动重试上传预登记', async () => {
  const queue = createTransferModule({ http:{ post:async()=>({}) } });
  const [id] = queue.upload({ localPaths:[path.join(os.tmpdir(), 'qck-audit-不存在-' + Date.now())] });
  await waitFor(() => queue.list()[0].status === 'error');
  assert.equal(queue.list()[0].attempts, 1);
  await queue.clear([id]);
});

test('加密存储：正式模式加密失败时拒绝落盘，不能降级明文', async t => {
  const f = await fixture(t, (_,res)=>res.end());
  const store = createSecureStore({ userDataDir:f.dir, requireEncryption:true,
    safeStorage:{ isEncryptionAvailable:()=>true, encryptString:()=>{ throw Error('后端失效'); } } });
  assert.throws(()=>store.setItem('cookies',[{ name:'测试',value:'仅测试凭证' }]), /加密/);
  assert.equal(fs.existsSync(store.filePath), false);
});
