'use strict';
// 真实账号 P0 扩展验收：生产模块、真实 HTTP、专用目录；不读取或修改既有网盘文件。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createSecureStore } = require('../src/main/core/secure-store');
const { createSession } = require('../src/main/core/session');
const { userDataDir } = require('../src/main/core/platform');
const { HttpClient, COMMON_QUERY } = require('../src/main/core/http');
const { createFsModule } = require('../src/main/modules/fs');
const { createTransferModule } = require('../src/main/modules/transfer');

const root = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qck-p0-real-'));
const down = path.join(work, 'downloads');
fs.mkdirSync(down);
const report = { checks: [], trace: { pre: 0, preInstant: 0, hashInstant: 0, put: 0 }, largeFileTested: false };
const reportFile = path.join(root, '.work', 'p0-real-results.json');
let runLarge = process.argv.includes('--large');
process.on('SIGUSR2', () => { runLarge = false; console.log('已取消后续多 GB 用例，当前传输与清理继续完成。'); });
let folder;
let transfer;
let pauseTarget;
let lastProgress = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function passed(name, details = {}) {
  report.checks.push({ name, passed: true, details });
  console.log('通过：' + name + ' ' + JSON.stringify(details));
}
function generate(name, bytes) {
  const file = path.join(work, name);
  const fd = fs.openSync(file, 'wx');
  const block = crypto.randomBytes(Math.min(bytes || 1, 1024 * 1024));
  try {
    for (let offset = 0; offset < bytes; offset += block.length) {
      let written = 0;
      const length = Math.min(block.length, bytes - offset);
      while (written < length) written += fs.writeSync(fd, block, written, length - written);
    }
  } finally { fs.closeSync(fd); }
  return file;
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}
async function waitTasks(ids) {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  for (;;) {
    const tasks = transfer.list().filter(task => ids.includes(task.id));
    assert.equal(tasks.length, ids.length);
    const failed = tasks.find(task => ['error', 'canceled'].includes(task.status));
    if (failed) throw new Error(`${failed.name}：${failed.error || failed.status}`);
    if (tasks.every(task => task.status === 'done')) return tasks;
    if (Date.now() > deadline) throw new Error('真实传输验收超时');
    await pause(250);
  }
}
async function itemFor(files, local) {
  const name = path.basename(local);
  const matches = files.filter(file => file.name === name && !file.dir);
  assert.equal(matches.length, 1, `${name} 必须只有一个对应云端文件`);
  assert.equal(matches[0].size, fs.statSync(local).size);
  return matches[0];
}
async function roundTrip(fsModule, locals, { interruptUpload = false, interruptDownload = false } = {}) {
  if (interruptUpload) pauseTarget = { kind: 'upload', name: path.basename(locals[0]), fired: false };
  const before = report.trace.pre;
  await waitTasks(transfer.upload({ localPaths: locals, pdirFid: folder.fid }));
  if (interruptUpload) {
    assert.ok(pauseTarget.fired, '真实上传过程中必须发生中断');
    assert.equal(report.trace.pre - before, 1, '恢复上传不得再次预登记');
    passed('真实分片上传中断后恢复，仅一次预登记');
  }
  pauseTarget = null;
  const listing = await fsModule.listAll({ pdirFid: folder.fid });
  const items = await Promise.all(locals.map(local => itemFor(listing.list, local)));
  if (interruptDownload) pauseTarget = { kind: 'download', name: items[0].name, fired: false };
  const tasks = await waitTasks(transfer.download({ fids: items.map(file => file.fid), names: items.map(file => file.name), localDir: down }));
  if (interruptDownload) {
    assert.ok(pauseTarget.fired, '真实下载过程中必须发生中断');
    passed('真实下载连接中断后断点恢复');
  }
  pauseTarget = null;
  for (let index = 0; index < locals.length; index++) {
    const task = tasks.find(task => task.fid === items[index].fid);
    assert.equal(fs.statSync(task.localPath).size, items[index].size);
    assert.equal(await sha256(task.localPath), await sha256(locals[index]));
    passed('真实上传下载 SHA256 一致', { name: items[index].name, bytes: items[index].size });
  }
  return items;
}

(async () => {
  const session = createSession({ store: createSecureStore({ userDataDir: userDataDir(), requireEncryption: true }) }).load();
  assert.ok(session.getCookie(), '请先在客户端登录');
  const http = new HttpClient({ getCookie: () => session.getCookie(), onSetCookie: cookies => session.applySetCookie(cookies) });
  // 只记录返回的状态与调用次数，原始请求及响应不写日志，不改变服务端返回值。
  const post = http.post.bind(http);
  http.post = async (route, ...args) => {
    const result = await post(route, ...args);
    if (route.endsWith('/upload/pre')) { report.trace.pre++; if (result.data?.finish) report.trace.preInstant++; }
    if (route.endsWith('/update/hash') && result.data?.finish) report.trace.hashInstant++;
    return result;
  };
  const request = http.request.bind(http);
  http.request = async req => {
    const result = await request(req);
    if (req.method === 'PUT' && req.cookies === false) report.trace.put++;
    return result;
  };
  const fsModule = createFsModule({ http });
  if(process.argv.includes('--cleanup-check')) {
    const previous=JSON.parse(fs.readFileSync(reportFile,'utf8'));
    assert.ok(/^qck-p0-\d+-[a-f0-9]{12}$/.test(previous.testDirectoryName));
    assert.ok(previous.checks.some(check=>check.name==='所有下载临时文件已收尾'),'原运行尚未完成传输验收');
    const live=(await fsModule.listAll({pdirFid:'0'})).list.find(item=>item.fid===previous.testDirectoryFid);
    assert.equal(live,undefined,'上次专用测试目录仍存在，需保留原记录并处理清理');
    Object.assign(report,previous);
    if(report.error) {
      assert.match(report.error,/已等待 180 秒/,'原失败原因并非清理任务的未确认状态');
      report.cleanupRecovery={previousError:report.error,method:'直接核对根目录中测试 fid 已不存在'};
      delete report.error;
    }
    passed('专用测试目录及其测试文件已清理');
    report.cleaned=true;
    return;
  }
  transfer = createTransferModule({ http, fsModule, getConcurrency: () => ({ upload: 2, download: 2, uploadPartConcurrency: 2, downloadParallel: 4 }),
    onUpdate: tasks => {
      if (Date.now() - lastProgress > 15000) {
        lastProgress = Date.now();
        for (const task of tasks.filter(task => task.status === 'running')) console.log(`进度：${task.kind} ${task.name} ${task.transferred}/${task.size}`);
      }
      const task = pauseTarget && tasks.find(task => task.kind === pauseTarget.kind && task.name === pauseTarget.name && task.status === 'running' && task.transferred >= 4 * 1024 * 1024 && task.transferred < task.size);
      if (task && !pauseTarget.fired) {
        pauseTarget.fired = true;
        transfer.pause(task.id).then(() => pause(500)).then(() => transfer.resume(task.id)).catch(error => { report.pauseError = error.message; });
      }
    },
  });
  const name = `qck-p0-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  report.testDirectoryName = name;
  try {
    const accepted = await fsModule.mkdir({ pdirFid: '0', name });
    if (accepted.taskId) await fsModule.waitTask([accepted.taskId]);
    for (let attempt = 0; attempt < 30 && !folder; attempt++) {
      folder = (await fsModule.listAll({ pdirFid: '0' })).list.find(item => item.name === name && item.dir);
      if (!folder) await pause(500);
    }
    assert.ok(folder, '未找到本次专用测试目录');
    report.testDirectoryFid = folder.fid;
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    const empty = generate('零字节-日本語.txt', 0);
    await roundTrip(fsModule, [empty]);
    passed('零字节上传下载与 UTF-8 文件名');
    const small = [generate('多文件-一.bin', 1024 * 1024 + 17), generate('多文件-二.bin', 2 * 1024 * 1024 + 19), generate('多文件-三.bin', 3 * 1024 * 1024 + 23)];
    await roundTrip(fsModule, small);
    passed('多文件队列并发上传与下载');
    const interrupted = generate('中断恢复.bin', 32 * 1024 * 1024 + 12345);
    await roundTrip(fsModule, [interrupted], { interruptUpload: true, interruptDownload: true });
    const duplicate = path.join(work, '相同内容秒传.bin');
    fs.copyFileSync(interrupted, duplicate);
    const beforePut = report.trace.put;
    const beforeInstant = report.trace.hashInstant + report.trace.preInstant;
    await roundTrip(fsModule, [duplicate]);
    assert.equal(report.trace.put, beforePut, '相同内容应由真实服务端秒传，不能发起分片 PUT');
    assert.ok(report.trace.hashInstant + report.trace.preInstant > beforeInstant, '必须观察到真实秒传返回');
    passed('真实服务端秒传且无分片 PUT', { preInstant: report.trace.preInstant, hashInstant: report.trace.hashInstant });
    if (runLarge) {
      const size = 2 * 1024 ** 3 + 12345;
      const quota = await http.get('/1/clouddrive/member', COMMON_QUERY);
      const free = Number(quota.data?.total_capacity) - Number(quota.data?.use_capacity);
      assert.ok(Number.isFinite(free) && free >= size, '账号空余容量不足以完成 2 GiB 真实文件验收');
      console.log('开始 2 GiB 真实上传下载验收（完整文件，不使用稀疏文件）。');
      await roundTrip(fsModule, [generate('真实多GB.bin', size)]);
      report.largeFileTested = true;
    }
    assert.equal(fs.readdirSync(down).filter(name => name.includes('.qkdownloading')).length, 0);
    passed('所有下载临时文件已收尾');
  } finally {
    for (const task of transfer.list().filter(task => ['running', 'pending', 'paused'].includes(task.status))) await transfer.cancel(task.id);
    if (folder) {
      await fsModule.remove({ fids: [folder.fid] });
      // 未确认的服务端任务数值不能推断完成；以测试目录实际消失作为清理证据。
      let exists = true;
      for (let attempt = 0; attempt < 30 && exists; attempt++) {
        exists = (await fsModule.listAll({ pdirFid: '0' })).list.some(item => item.fid === folder.fid);
        if (exists) await pause(500);
      }
      assert.equal(exists, false, '本次测试目录未清理完成');
      passed('专用测试目录及其测试文件已清理');
      report.cleaned = true;
    }
  }
})().catch(error => { report.error = error.message; console.error('P0 真实验收失败：' + error.message); process.exitCode = 1; })
  .finally(async () => {
    await fsp.rm(work, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(`P0 真实验收：${report.checks.length} 项通过${report.error ? '，存在失败' : ''}；报告：${reportFile}`);
  });
