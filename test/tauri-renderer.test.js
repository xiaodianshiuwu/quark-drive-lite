'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { range } = require('../src/renderer/virtual-list');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/tauri-bridge.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function bridge(invoke, listen = async () => () => {}) {
  const window = { navigator: { platform: 'MacIntel' }, __TAURI__: { core: { invoke }, event: { listen } } };
  vm.runInNewContext(source, { window });
  return window.qk;
}

test('Tauri bridge preserves the renderer contract and named scalar parameters', async () => {
  const calls = [];
  const qk = bridge(async (command, input) => { calls.push([command, plain(input)]); return 'ok'; });
  await qk.fs.info('file-id');
  await qk.fs.crumbs('dir-id');
  await qk.transfer.pause('task-id');
  await qk.transfer.clear(['a', 'b']);
  await qk.settings.set({ downloadParallel: 6 });
  await qk.dialog.openPath('/fixture/file');
  await qk.dialog.saveDir('/fixture');
  await qk.auth.login();
  await qk.app.quit();
  assert.deepEqual(calls, [
    ['qk_call', { method: 'fs.info', params: { fid: 'file-id' } }],
    ['qk_call', { method: 'fs.crumbs', params: { fid: 'dir-id' } }],
    ['qk_call', { method: 'transfer.pause', params: { id: 'task-id' } }],
    ['qk_call', { method: 'transfer.clear', params: { ids: ['a', 'b'] } }],
    ['qk_call', { method: 'settings.set', params: { downloadParallel: 6 } }],
    ['qk_call', { method: 'dialog.openPath', params: { path: '/fixture/file' } }],
    ['qk_call', { method: 'dialog.saveDir', params: { defaultPath: '/fixture' } }],
    ['qk_call', { method: 'auth.login', params: {} }],
    ['qk_call', { method: 'app.quit', params: {} }]
  ]);
  assert.equal(qk.platform, 'darwin');
  assert.equal(qk.dialog.getPathForFile({ path: '/untrusted' }), '');
  // agent/chat 扩展契约：方法名与 crates/quark-agent 的 runtime.handle 分发一致
  await qk.agent.journal(20);
  await qk.agent.mcpConfig();
  await qk.agent.setScope({ writeMode: 'read-only' });
  await qk.chat.history(100);
  await qk.chat.send('你好');
  // journal 返回 { records } 包装时在桥层解包为数组
  const bridge2 = (invoke) => {
    const window = { navigator: { platform: 'MacIntel' }, __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } } };
    vm.runInNewContext(source, { window });
    return window.qk;
  };
  const records = await bridge2(async () => ({ records: [{ seq: 1 }, { seq: 2 }] })).agent.journal(20);
  assert.equal(Array.isArray(records), true, 'journal 应解包 records 为数组');
  assert.equal(records.length, 2);
  assert.deepEqual(calls.slice(-5), [
    ['qk_call', { method: 'agent.journal', params: { limit: 20 } }],
    ['qk_call', { method: 'agent.mcpConfig', params: {} }],
    ['qk_call', { method: 'agent.updateScope', params: { writeMode: 'read-only' } }],
    ['qk_call', { method: 'chat.history', params: { limit: 100 } }],
    ['qk_call', { method: 'chat.send', params: { text: '你好' } }]
  ]);
  // chat.onEvent：Tauri 事件通道 qk:chat-event
  let chatHandler = null;
  const offChat = qk.chat.onEvent(() => {});
  assert.equal(typeof offChat, 'function', 'chat.onEvent 必须返回取消订阅函数');
  offChat();
});

test('Tauri rejects with NEED_LOGIN intact rather than losing its code', async () => {
  const qk = bridge(async () => { throw { code: 'NEED_LOGIN', message: '会话过期', httpStatus: 401 }; });
  await assert.rejects(qk.auth.verify(), error => error.code === 'NEED_LOGIN' && error.httpStatus === 401);
});

test('Tauri listener disposal before asynchronous registration closes the listener', async () => {
  let resolve;
  let stopped = 0;
  let handler;
  let received = 0;
  const qk = bridge(async () => {}, async (name, cb) => {
    assert.equal(name, 'qk:auth-changed');
    handler = cb;
    await new Promise(r => { resolve = r; });
    return () => { stopped++; };
  });
  const off = qk.auth.onChange(() => { received++; });
  off();
  handler({ payload: { loggedIn: true } });
  resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(stopped, 1);
  assert.equal(received, 0);
});

test('virtual rows remain bounded across a million items and preserve complete scroll extent', () => {
  for (const count of [0, 1, 100, 5001, 1000000]) {
    for (const top of [0, 100, count * 23, count * 46, Number.MAX_SAFE_INTEGER]) {
      const r = range(count, top, 720, 46, 8);
      assert.ok(r.start >= 0 && r.end <= count && r.start <= r.end);
      assert.ok(r.end - r.start <= Math.ceil(720 / 46) + 17);
      assert.equal(r.before + (r.end - r.start) * 46 + r.after, count * 46);
    }
  }
  assert.equal(range(5001, 5001 * 46, 720, 46, 8).end, 5001);
});

// Launch only a fresh project-specific headless browser profile, never the user's browser session.
const browserPath=[process.env.QCK_BROWSER_PATH,process.env.CHROME_BIN,
  process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':null,
  process.platform==='win32'?path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'):null,
  '/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>p&&fs.existsSync(p));
test('renderer DOM: virtual paging, file operations, transfers, settings and account lifecycle', { skip: !browserPath, timeout: 75000 }, async t => {
  const os = require('node:os');
  const { spawn } = require('node:child_process');
  const { pathToFileURL } = require('node:url');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qck-tauri-renderer-'));
  const child = spawn(browserPath, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--window-size=1280,900',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserLog = '';
  child.stderr.on('data', chunk => { browserLog = (browserLog + chunk).slice(-3000); });
  const deadline = Date.now() + 20000;
  let socket;
  t.after(async () => {
    if (socket) socket.close();
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error('Headless browser did not expose a project debug port: ' + browserLog);
    await new Promise(r => setTimeout(r, 50));
  }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(targets.find(item => item.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map();
  let seq = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  }
  async function evaluate(expression) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
  async function until(expression, label) {
    const expires = Date.now() + 5000;
    while (!(await evaluate(expression))) {
      if (Date.now() >= expires) throw new Error('Renderer fixture timed out: ' + label);
      await new Promise(r => setTimeout(r, 25));
    }
  }
  async function click(selector) {
    await until('!!document.querySelector(' + JSON.stringify(selector) + ')', selector);
    await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
  }
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__fixtureCalls = [];
    window.__fixtureListeners = {};
    window.__fixtureEmit = (name, payload) => (window.__fixtureListeners[name] || []).forEach(cb => cb({payload:structuredClone(payload)}));
    window.__fixture = {
      account:{loggedIn:true,expired:false,nickname:'Fixture',userId:'fixture-user'},
      settings:{downloadDir:'/fixture',askDownloadDir:false,uploadConcurrency:2,downloadConcurrency:2,downloadParallel:16,downloadStrategy:'auto',uploadPartConcurrency:3,theme:'light',aiBetaEnabled:false,serverOptIn:false,serverPrompted:true,tutorialSeen:true},
      tasks:[], names:{}, serial:0, customSaveDir:null,
      hubLatest:{
        ok:true,hasUpdate:true,currentVersion:'1.0.0',latestVersion:'1.0.1',
        channel:'stable',releaseDate:'2026-11-23',
        changelog:'• 下载引擎提速 2x\\n• 修复深层面包屑鼠标导航',
        notice:'欢迎体验新版直链更新通道',
        recommendedAssetKey:'macos-arm64',
        recommendedAsset:{filename:'QuarkDriveLite-1.0.1.zip',size:8388608,sha256:'a'.repeat(64),url:'https://qdl.xiaodianshiuwu.space/downloads/QuarkDriveLite-1.0.1.zip'},
        assets:{'macos-arm64':{filename:'QuarkDriveLite-1.0.1.zip',size:8388608,sha256:'a'.repeat(64),url:'https://qdl.xiaodianshiuwu.space/downloads/QuarkDriveLite-1.0.1.zip'}},
        signatureVerified:true,serverRegion:'海外节点 · Tokyo (JP)'
      }
    };
    window.__TAURI__ = {
      event: { listen: async (name, cb) => {
        (window.__fixtureListeners[name] ||= []).push(cb);
        return () => { window.__fixtureListeners[name] = window.__fixtureListeners[name].filter(fn => fn !== cb); };
      } },
      core: { invoke: async (command, request) => {
        window.__fixtureCalls.push(request);
        const p = request.params;
        const fixture = window.__fixture;
        const item = n => ({fid:String(n), name:fixture.names[n] || 'fixture-'+n+'.txt', dir:false, size:n, updatedAt:1, ext:'txt'});
        const snapshot = value => structuredClone(value);
        const emitTasks = () => window.__fixtureEmit('qk:transfer-update', fixture.tasks);
        switch (request.method) {
          case 'auth.status': case 'auth.verify': return snapshot(fixture.account);
          case 'auth.login': fixture.account={loggedIn:true,expired:false,nickname:'Fixture',userId:'fixture-user'};window.__fixtureEmit('qk:auth-changed',fixture.account);return snapshot(fixture.account);
          case 'auth.logout': fixture.account={loggedIn:false,expired:false};window.__fixtureEmit('qk:auth-changed',fixture.account);return snapshot(fixture.account);
          case 'auth.quota': return snapshot(fixture.quota || {total:1000000, used:1, free:999999});
          case 'auth.getUserInfo': return snapshot(fixture.account);
          case 'agent.status': return {enabled:false,running:false,writeMode:'read-only',remoteRoots:[],localReadRoots:[],localWriteRoots:[],connections:0};
          case 'agent.journal': return {records:[]};
          case 'agent.mcpConfig': return {mcpServers:{'quark-mini':{command:'node',args:['/fixture/agent/adapters/agent-mcp.js']}}};
          case 'chat.status': return {configured:false,hasKey:false,baseUrl:'',model:'',running:false};
          case 'chat.history': return [];
          case 'hub.config': return {optIn:!!fixture.settings.serverOptIn,prompted:!!fixture.settings.serverPrompted,baseUrl:'https://qdl.xiaodianshiuwu.space',region:'海外节点 · Tokyo (JP)',currentVersion:'1.0.0',recommendedAssetKey:'macos-arm64',cryptoSummary:'HTTPS TLS 1.3 + X25519/AES-256-GCM 端到端加密 + Ed25519 签名校验'};
          case 'hub.setOptIn': fixture.settings.serverOptIn=!!p.optIn;fixture.settings.serverPrompted=true;return {optIn:fixture.settings.serverOptIn,prompted:true,baseUrl:'https://qdl.xiaodianshiuwu.space',region:'海外节点 · Tokyo (JP)',currentVersion:'1.0.0',recommendedAssetKey:'macos-arm64',cryptoSummary:'HTTPS TLS 1.3 + X25519/AES-256-GCM 端到端加密 + Ed25519 签名校验'};
          case 'hub.checkUpdate': {
            if (!fixture.settings.serverOptIn) throw {code:'OPT_IN_REQUIRED',message:'未开启连接'};
            return snapshot(fixture.hubLatest);
          }
          case 'hub.downloadUpdate': {
            if (!fixture.settings.serverOptIn) throw {code:'OPT_IN_REQUIRED',message:'未开启连接'};
            window.__fixtureEmit('qk:update-progress',{phase:'done',filename:'QuarkDriveLite-1.0.1.zip',downloaded:8388608,total:8388608,percent:100,verified:true});
            return {ok:true,path:'/fixture/QuarkDriveLite-1.0.1.zip',filename:'QuarkDriveLite-1.0.1.zip',size:8388608,sha256:'a'.repeat(64),verified:true};
          }
          case 'hub.sendTelemetry': {
            if (!fixture.settings.serverOptIn) throw {code:'OPT_IN_REQUIRED',message:'未开启连接'};
            return {ok:true,encrypted:true};
          }
          case 'hub.submitFeedback': {
            if (!fixture.settings.serverOptIn) throw {code:'OPT_IN_REQUIRED',message:'未开启连接'};
            return {ok:true,id:42,encrypted:true,includedLogs:!!p.includeLogs};
          }
          case 'hub.logPreview': return {logs:[{ts:1763817600000,level:'info',category:'lifecycle',code:'APP_START',msg:'app started (darwin/aarch64)'}]};
          case 'hub.recordEvent': return {ok:true};
          case 'settings.get': return snapshot(fixture.settings);
          case 'settings.set': Object.assign(fixture.settings,p);return snapshot(fixture.settings);
          case 'fs.crumbs': {
            if (fixture.holdCrumbs && p.fid==='folder-A') return new Promise(resolve=>fixture.releaseCrumbs=resolve);
            if (fixture.crumbFailure) throw {code:'NETWORK',message:'路径服务暂不可用'};
            if (fixture.selfOnlyCrumbs && p.fid==='folder-deep') return [{fid:'folder-deep',name:'二级目录'}];
            if (fixture.ancestorCrumbs && p.fid==='folder-deep') return [{fid:'0',name:'全部文件'},{fid:'folder-A',name:'一级目录'}];
            if (p.fid==='folder-4') return [{fid:'0',name:'全部文件'},{fid:'folder-1',name:'新建文件夹'},{fid:'folder-2',name:'新建文件夹2'},{fid:'folder-3',name:'新建文件夹3'},{fid:'folder-4',name:'新建文件夹4'}];
            return [{fid:'0',name:'全部文件'}];
          }
          case 'fs.info': {
            if (p.fid==='folder-deep') return {fid:'folder-deep',name:'二级目录',dir:true,pdirFid:'folder-A',fullPath:'/全部文件/一级目录/二级目录'};
            if (p.fid==='folder-A') return {fid:'folder-A',name:'一级目录',dir:true,pdirFid:'0',fullPath:[{fid:'0',name:'全部文件'},{fid:'folder-A',name:'一级目录'}],includeItems:3};
            const fallbackName = fixture.names[p.fid] || (/^\\d+$/.test(String(p.fid)) ? ('fixture-' + p.fid + '.txt') : ('项目-' + p.fid));
            return {
              fid:p.fid, name:fallbackName, dir:false, pdirFid:'0',
              size: Number(p.fid) || 2048, formatType:'text/plain', source:'UPLOAD',
              fullPath:'/全部文件/' + fallbackName,
              md5:'d41d8cd98f00b204e9800998ecf8427e', sha1:'da39a3ee5e6b4b0d3255bfef95601890afd80709',
              duration: p.fid==='tool-video' ? 125 : 0, fps: p.fid==='tool-video' ? 60 : 0,
              operatedAt: 1763817600000, createdAt: 1763810000000, updatedAt: 1763817600000
            };
          }
          case 'fs.dirDetail': {
            const sizes = { 'folder-A': { size: 190124525, items: 7 }, 'folder-B': { size: 41943040, items: 3 } };
            const hit = sizes[p.fid] || { size: 1048576, items: 2 };
            return { fid: p.fid, finished: true, size: hit.size, items: hit.items };
          }
          case 'fs.revisions': {
            return {
              list: [
                { version: 3, fid: p.fid, name: 'doc.txt', size: 8192, updatedAt: 1763817600000, current: true },
                { version: 2, fid: p.fid, name: 'doc.txt', size: 6144, updatedAt: 1763731200000, current: false }
              ]
            };
          }
          case 'fs.revertRevision': return { ok: true, fid: p.fid, version: p.version };
          case 'fs.storageDetail': {
            return {
              list: [
                { srcName: 'UPLOAD', size: 1200000000, count: 42, contribution: 1200000000 },
                { srcName: 'SAVE_AS_ALL', size: 600000000, count: 19, contribution: 600000000 },
                { srcName: 'UNARCHIVE', size: 200000000, count: 8, contribution: 200000000 }
              ]
            };
          }
          case 'archive.rightTimes': return { baseEnough: true, extendLeft: 3 };
          case 'archive.targetDir': return { dirFid: 'folder-A', dirName: '一级目录', exists: true };
          case 'archive.preview': {
            if (fixture.archivePwdRequired && p.pwd !== 'secret123') {
              throw { code: p.pwd ? 'ARCHIVE_PWD_ERROR' : 'ARCHIVE_NEED_PWD', message: p.pwd ? '解压密码错误' : '压缩包需要密码' };
            }
            if (p.pathNo === '1') {
              return { finish: true, totalFileCount: 3, page: 1, size: 100, count: 1, tqGap: 500, list: [{ name: 'inside.md', isFolder: false, path: 'docs/inside.md', pathNo: '1/1', size: 2048, updatedAt: 1763817600000 }] };
            }
            return {
              finish: true, totalFileCount: 3, page: 1, size: 100, count: 2, tqGap: 500,
              list: [
                { name: 'docs', isFolder: true, path: 'docs', pathNo: '1', size: 0, updatedAt: 1763817600000 },
                { name: 'readme.txt', isFolder: false, path: 'readme.txt', pathNo: '2', size: 1024, updatedAt: 1763817600000 }
              ]
            };
          }
          case 'archive.unarchive': {
            if (fixture.archiveConflictOnce && (p.conflictMode || 1) === 1) {
              fixture.archiveConflictOnce = false;
              throw { code: 'CONFLICT', bizCode: 23008, message: '目标目录已存在同名文件' };
            }
            return { taskId: 'unzip-task-1', finish: false, status: 'running' };
          }
          case 'archive.queryTask': {
            return { taskId: p.taskId, status: 'finish', statusCode: 2, progress: 100, done: true, failed: false, message: '' };
          }
          case 'recycle.list': {
            const rlist = fixture.recycleItems || [
              { recordId: 'rec-1', fid: 'rf-1', name: '旧报告.pdf', dir: false, ext: 'pdf', size: 524288, pdirFid: '0', pdirName: '全部文件', deletedAt: 1763817600000, remainMs: 7 * 86400000 },
              { recordId: 'rec-2', fid: 'rf-2', name: '草稿目录', dir: true, ext: '', size: 0, pdirFid: 'folder-A', pdirName: '一级目录', deletedAt: 1763817600000, remainMs: 2 * 86400000 }
            ];
            return { list: snapshot(rlist), total: rlist.length, page: 1, size: 50, hasMore: false };
          }
          case 'recycle.recover': {
            const ids = new Set(p.recordIds || []);
            if (fixture.recycleItems) fixture.recycleItems = fixture.recycleItems.filter(x => !ids.has(x.recordId));
            return { taskId: '', done: true };
          }
          case 'recycle.remove': {
            if (p.clearAll) {
              fixture.recycleItems = [];
            } else {
              const ids = new Set(p.recordIds || []);
              if (fixture.recycleItems) fixture.recycleItems = fixture.recycleItems.filter(x => !ids.has(x.recordId));
            }
            return { taskId: '', done: true };
          }
          case 'fs.list': {
            if (fixture.holdPage) return new Promise(resolve => fixture.releasePage=resolve);
            if (!fixture.account.loggedIn) throw {code:'NEED_LOGIN',message:'请先登录'};
            if (fixture.cloudToolsMode) {
              const list = [
                {fid:'folder-A',name:'一级目录',dir:true,size:0,updatedAt:1763817600000,pdirFid:'0'},
                {fid:'folder-B',name:'素材归档',dir:true,size:0,updatedAt:1763817600000,pdirFid:'0'},
                {fid:'tool-zip',name:'工程源码包.zip',dir:false,size:15728640,updatedAt:1763817600000,ext:'zip',category:5,pdirFid:'0'},
                {fid:'tool-video',name:'演示录屏.mp4',dir:false,size:52428800,updatedAt:1763817600000,ext:'mp4',category:1,pdirFid:'0'}
              ];
              return {list,total:list.length,page:1,size:p.size,hasMore:false};
            }
            if (fixture.deepMode) {
              const map = {
                '0': [{fid:'folder-1',name:'新建文件夹',dir:true,pdirFid:'0'}],
                'folder-1': [{fid:'folder-2',name:'新建文件夹2',dir:true,pdirFid:'folder-1'}],
                'folder-2': [{fid:'folder-3',name:'新建文件夹3',dir:true,pdirFid:'folder-2'}],
                'folder-3': [{fid:'folder-4',name:'新建文件夹4',dir:true,pdirFid:'folder-3'}],
                'folder-4': [{fid:'deep-file',name:'深层文档.pdf',dir:false,size:4096,updatedAt:2,ext:'pdf',pdirFid:'folder-4'}]
              };
              const list = map[p.pdirFid] || [];
              return {list,total:list.length,page:1,size:p.size,hasMore:false};
            }
            if (fixture.navigationMode) {
              const list=p.pdirFid==='0'?[{fid:'folder-A',name:'一级目录',dir:true,pdirFid:''}]:p.pdirFid==='folder-A'?[{fid:'folder-deep',name:'二级目录',dir:true,pdirFid:'folder-A'}]:[{fid:'inside-file',name:'子目录内容.txt',dir:false,pdirFid:'folder-deep'}];
              return {list,total:list.length,page:1,size:p.size,hasMore:false};
            }
            if (fixture.directoryMode) return {list:[{fid:'folder-A',name:'Target A',dir:true},{fid:'folder-B',name:'Target B',dir:true}],total:2,page:1,size:p.size,hasMore:false};
            const start=(p.page-1)*p.size;
            return {list:Array.from({length:Math.min(p.size,5100-start)},(_,i)=>item(start+i+1)),total:5100,page:p.page,size:p.size,hasMore:start+p.size<5100};
          }
          case 'fs.search': return {list:fixture.searchFolder?[{fid:'folder-deep',name:'二级目录',dir:true,pdirFid:'folder-A'}]:[item(7000)],total:1,page:1,size:p.size,hasMore:false};
          case 'fs.mkdir': case 'fs.move': case 'fs.copy': case 'fs.remove': return {done:true};
          case 'fs.rename': fixture.names[p.fid]=p.name;return {done:true};
          case 'transfer.list': {
            if (fixture.holdTransfers) return new Promise(resolve => fixture.releaseTransfers=resolve);
            return snapshot(fixture.tasks);
          }
          case 'transfer.upload': case 'transfer.download': {
            const upload=request.method==='transfer.upload';
            const paths=upload?p.localPaths:p.fids;
            const ids=paths.map((value,i) => {
              const id='task-'+(++fixture.serial);
              fixture.tasks.push({id,kind:upload?'upload':'download',name:upload?value.split('/').pop():p.names[i],status:'running',size:100,transferred:25,speed:1,eta:75,localPath:upload?value:'/fixture/'+p.names[i],localDir:'/fixture'});
              return id;
            });
            emitTasks();return ids;
          }
          case 'transfer.pause': case 'transfer.resume': case 'transfer.retry': case 'transfer.cancel': {
            fixture.tasks.find(task=>task.id===p.id).status=({'transfer.pause':'paused','transfer.resume':'running','transfer.retry':'running','transfer.cancel':'canceled'})[request.method];
            emitTasks();return null;
          }
          case 'transfer.clear': fixture.tasks=fixture.tasks.filter(task=>!p.ids.includes(task.id));emitTasks();return null;
          case 'transfer.pauseAll': {
            let count=0;fixture.tasks.forEach(t=>{if(t.status==='running'||t.status==='queued'){t.status='paused';t.speed=0;count++;}});
            emitTasks();return {count};
          }
          case 'transfer.resumeAll': {
            let count=0;fixture.tasks.forEach(t=>{if(t.status==='paused'){t.status='running';t.speed=2048;count++;}});
            emitTasks();return {count};
          }
          case 'transfer.retryFailed': {
            let count=0;fixture.tasks.forEach(t=>{if(t.status==='error'){t.status='running';t.error='';t.speed=2048;count++;}});
            emitTasks();return {count};
          }
          case 'transfer.openItem': return null;
          case 'dialog.pickDirs': return ['/fixture/local-backup'];
          case 'dialog.pickFiles': return ['/fixture/local-upload.bin'];
          case 'dialog.saveDir': return fixture.customSaveDir || '/fixture';
          case 'app.info': return {version:'1.0.0',runtime:'Tauri 2 + Rust (Fixture)',platform:'test',arch:'x64'};
          case 'dialog.openPath': case 'dialog.showInFolder': case 'app.quit': return null;
          default: throw {code:'FIXTURE_UNEXPECTED',message:request.method};
        }
      }}
    };` });
  const navigation = await cdp('Page.navigate', { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href });
  assert.ok(!navigation.errorText, navigation.errorText);
  const fixtureDeadline = Date.now() + 20000;
  while (!(await evaluate('!!(window.QKUI && QKUI.state.loadedOnce && !QKUI.state.loading)'))) {
    if (Date.now() > fixtureDeadline) {
      const state = await evaluate('({ready:document.readyState, bridge:!!window.qk, fixture:!!window.__fixture, app:!!window.QKUI})');
      throw new Error('Renderer did not finish initial fixture load: ' + JSON.stringify(state));
    }
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(await evaluate('QKAPI.injected && QKAPI.bridgeInfo().missing.length === 0'));
  await evaluate('(async () => { while (QKUI.state.hasMore) await QKUI.loadPage({}); })()');
  assert.equal(await evaluate('QKUI.state.items.length'), 5100);
  assert.ok(await evaluate('QKUI.getRowCount() <= 40 && document.querySelectorAll(".row").length <= 40'));
  await evaluate('document.querySelector(".row input").click()');
  assert.ok(await evaluate('QKUI.state.selected.has("1")'));
  await evaluate('document.getElementById("listwrap").scrollTop=46*2500');
  await until('Number(document.querySelector(".row").dataset.fid)>2400','virtual list middle rendered');
  assert.ok(await evaluate('Number(document.querySelector(".row").dataset.fid)>2400 && QKUI.getRowCount()<=40'));
  await evaluate('document.getElementById("listwrap").scrollTop=46*5100');
  await until('!!document.querySelector(".row[data-fid=\\"5100\\"]")','virtual list final row rendered');
  assert.ok(await evaluate('QKUI.getRowCount()<=40'));
  await evaluate('document.getElementById("listwrap").scrollTop=0');
  await until('!!document.querySelector(".row[data-fid=\\"1\\"]")','virtual list first row restored');
  assert.ok(await evaluate('document.querySelector(".row[data-fid=\\"1\\"] input").checked'));
  await evaluate('document.getElementById("check-all").click()');
  assert.equal(await evaluate('QKUI.state.selected.size'), 5100);
  await evaluate('document.getElementById("search-input").value="fixture";document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  await new Promise(r => setTimeout(r, 70));
  assert.equal(await evaluate('QKUI.state.items[0].fid'), '7000');
  assert.equal(await evaluate('QKUI.state.selected.size'), 0);
  assert.equal(await evaluate('QKUI.getRowCount()'), 1);

  await t.test('folder navigation keeps a usable parent with root-only, failed, ancestor-only and stale path responses', async () => {
    const root=async()=>{await evaluate('QKUI.navigate("0")');await until('QKUI.state.fid==="0" && !QKUI.state.loading','root directory');};
    const enter=async(fid)=>{
      await evaluate('document.querySelector('+JSON.stringify('.row[data-fid="'+fid+'"]')+').dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
      await until('QKUI.state.fid==='+JSON.stringify(fid)+' && QKUI.state.loadedOnce && !QKUI.state.loading','enter '+fid);
    };
    const crumbIds=()=>evaluate('QKUI.state.crumbs.map(c=>c.fid)');
    const up=async()=>{
      // Wait for the resized viewport to be painted before sending a browser-level click.
      await cdp('Page.captureScreenshot', {clip:{x:0,y:0,width:1,height:1,scale:1}});
      const rect=await evaluate('(()=>{const r=document.getElementById("btn-up").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
      assert.ok(rect.width>50 && rect.height>20 && rect.x>=0,'up button has a usable visible size');
      const point={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      assert.equal(await evaluate('document.elementFromPoint('+point.x+','+point.y+')?.closest("#btn-up")?.id'),'btn-up','up button is the mouse target');
      await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    try {
      await evaluate('__fixture.navigationMode=true');await root();
      assert.equal(await evaluate('document.getElementById("btn-up").disabled'),true);
      await enter('folder-A');assert.deepEqual(await crumbIds(),['0','folder-A']);
      await evaluate('__fixture.crumbFailure=true');await enter('folder-deep');
      assert.deepEqual(await crumbIds(),['0','folder-A','folder-deep']);
      assert.equal(await evaluate('document.querySelector("#crumbs .crumb-item").disabled'),false);
      await cdp('Emulation.setDeviceMetricsOverride',{width:760,height:520,deviceScaleFactor:1,mobile:false});
      assert.equal(await evaluate('document.documentElement.scrollWidth<=760 && document.getElementById("btn-up").getBoundingClientRect().right<=760'),true);
      if(process.env.QCK_NAV_SCREENSHOTS){fs.mkdirSync(process.env.QCK_NAV_SCREENSHOTS,{recursive:true});await evaluate('document.querySelectorAll(".toast-close").forEach(b=>b.click())');await new Promise(r=>setTimeout(r,180));const shot=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.QCK_NAV_SCREENSHOTS,'nested-760.png'),Buffer.from(shot.data,'base64'));}
      await up();await until('QKUI.state.fid==="folder-A" && QKUI.state.items[0]?.fid==="folder-deep"','parent contents restored');
      await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",altKey:true,bubbles:true}))');
      await until('QKUI.state.fid==="0" && QKUI.state.items[0]?.fid==="folder-A"','Alt+Up returns to root');
      assert.equal(await evaluate('document.getElementById("btn-up").disabled'),true);
      await evaluate('__fixture.crumbFailure=false;__fixture.ancestorCrumbs=true');
      await enter('folder-A');await enter('folder-deep');assert.deepEqual(await crumbIds(),['0','folder-A','folder-deep']);
      await click('#crumbs .crumb-item:nth-of-type(2)');await until('QKUI.state.fid==="folder-A" && !QKUI.state.loading','ancestor breadcrumb');
      await evaluate('document.getElementById("search-input").value="fixture";document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
      await until('QKUI.state.mode==="search" && !QKUI.state.loading','search within directory');
      assert.equal(await evaluate('document.getElementById("btn-up-label").textContent'),'返回目录');
      await up();await until('QKUI.state.mode==="browse" && QKUI.state.fid==="folder-A" && !QKUI.state.loading','return to pre-search directory');
      await root();await evaluate('__fixture.ancestorCrumbs=false;__fixture.searchFolder=true');
      await evaluate('document.getElementById("search-input").value="目录";document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
      await until('QKUI.state.mode==="search" && !QKUI.state.loading','folder search result');
      await enter('folder-deep');await up();await until('QKUI.state.fid==="folder-A" && !QKUI.state.loading','search result uses actual parent');
      await root();await evaluate('__fixture.holdCrumbs=true');await enter('folder-A');
      await until('typeof __fixture.releaseCrumbs==="function"','delayed path request');
      await up();await until('QKUI.state.fid==="0" && !QKUI.state.loading','return before path response');
      await evaluate('__fixture.holdCrumbs=false;__fixture.releaseCrumbs([{fid:"0",name:"全部文件"},{fid:"folder-A",name:"一级目录"}])');
      await new Promise(r=>setTimeout(r,30));assert.deepEqual(await crumbIds(),['0']);
    } finally {
      await cdp('Emulation.clearDeviceMetricsOverride');
      await evaluate('__fixture.navigationMode=false;__fixture.crumbFailure=false;__fixture.ancestorCrumbs=false;__fixture.searchFolder=false;__fixture.holdCrumbs=false;QKUI.navigate("0")');
      await until('QKUI.state.mode==="browse" && !QKUI.state.loading','restore directory fixture');
      await evaluate('document.getElementById("search-input").value="fixture";document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
      await until('QKUI.state.items[0]?.fid==="7000" && !QKUI.state.loading','restore file search');
    }
  });

  await t.test('settings persist upload PUT concurrency, download strategy, connection limit and theme', async () => {
    await click('[data-view="settings"]');
    assert.equal(await evaluate('document.getElementById("set-up-part").value'), '3');
    assert.equal(await evaluate('document.getElementById("set-down-strategy").value'), 'auto');
    for (const [id, value] of [['set-up-part', '5'], ['set-down-parallel', '12'], ['set-down-strategy', 'parallel']]) {
      await evaluate('document.getElementById(' + JSON.stringify(id) + ').value=' + JSON.stringify(value) + ';document.getElementById(' + JSON.stringify(id) + ').dispatchEvent(new Event("change",{bubbles:true}))');
    }
    await click('[data-theme="dark"].seg');
    await until('__fixture.settings.uploadPartConcurrency===5 && __fixture.settings.downloadParallel===12 && __fixture.settings.downloadStrategy==="parallel" && document.documentElement.dataset.theme==="dark"', 'settings saved');
    await click('[data-view="files"]');
  });

  await t.test('rename, mkdir, move, copy and confirmed removal retain their native command parameters', async () => {
    // 改扩展名重命名时，item.ext 与图标类同步更新，随后再改回 renamed.txt 供后续断言复用
    await click('.row [data-op="rename"]');
    await evaluate('document.querySelector(".overlay:not(.overlay-out) .dlg-input").value="renamed.png"');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('QKUI.state.items[0].name==="renamed.png"', 'renamed ext row');
    assert.equal(await evaluate('QKUI.state.items[0].ext'), 'png');
    assert.ok(await evaluate('document.querySelector(".row .fileicon").classList.contains("cat-image")'));

    await click('.row [data-op="rename"]');
    await evaluate('document.querySelector(".overlay:not(.overlay-out) .dlg-input").value="renamed.txt"');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('QKUI.state.items[0].name==="renamed.txt"', 'renamed row');
    assert.equal(await evaluate('QKUI.state.items[0].ext'), 'txt');
    assert.deepEqual(await evaluate('__fixtureCalls.filter(call=>call.method==="fs.rename").at(-1).params'), { fid: '7000', name: 'renamed.txt' });

    await click('#search-clear');
    await until('QKUI.state.mode==="browse" && QKUI.state.loadedOnce && !QKUI.state.loading', 'browse after search');
    const beforeMkdir = await evaluate('__fixtureCalls.filter(call=>call.method==="fs.list").length');
    await click('#btn-mkdir');
    await evaluate('document.querySelector(".overlay:not(.overlay-out) .dlg-input").value="unique-test-dir"');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('__fixtureCalls.filter(call=>call.method==="fs.list").length>' + beforeMkdir + ' && !QKUI.state.loading', 'mkdir refreshed');
    assert.deepEqual(await evaluate('__fixtureCalls.find(call=>call.method==="fs.mkdir").params'), { pdirFid: '0', name: 'unique-test-dir' });

    await evaluate('__fixture.directoryMode=true;document.getElementById("search-input").value="fixture";document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    await until('QKUI.state.items[0]?.fid==="7000" && !QKUI.state.loading', 'search to operate on file');
    // 搜索模式下当前浏览目录是根目录 '0'，但子目录文件（pdirFid='folder-A'）必须允许移动到根目录 '0'
    await evaluate('QKUI.state.items[0].pdirFid="folder-A"');
    await click('.row [data-op="move"]');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('!!document.querySelector(".overlay:not(.overlay-out) .dlg-confirm")', 'confirm move to root in search mode');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('__fixtureCalls.some(call=>call.method==="fs.move" && call.params.toFid==="0")', 'move to root submitted');
    await until('!document.querySelector(".overlay:not(.overlay-out)") && !QKUI.state.loading', 'search reloaded after move to root');
    // 文件移回根目录后，再移向 folder-A 与复制到 folder-B 均应正常提交
    await evaluate('QKUI.state.items[0].pdirFid="0"');

    for (const [kind, fid] of [['move', 'folder-A'], ['copy', 'folder-B']]) {
      await click('.row [data-op="' + kind + '"]');
      await click('.overlay:not(.overlay-out) .picker-row[data-fid="' + fid + '"]');
      await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
      await until('!!document.querySelector(".overlay:not(.overlay-out) .dlg-confirm")', 'confirm ' + kind);
      await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
      await until('__fixtureCalls.some(call=>call.method==="fs.' + kind + '" && call.params.toFid===' + JSON.stringify(fid) + ')', kind + ' submitted');
      assert.deepEqual(await evaluate('__fixtureCalls.filter(call=>call.method==="fs.' + kind + '").at(-1).params'), { fids: ['7000'], toFid: fid });
    }
    await click('.row [data-op="remove"]');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:first-child');
    assert.equal(await evaluate('__fixtureCalls.filter(call=>call.method==="fs.remove").length'), 0);
    await click('.row [data-op="remove"]');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('__fixtureCalls.some(call=>call.method==="fs.remove")', 'confirmed removal submitted');
    assert.deepEqual(await evaluate('__fixtureCalls.find(call=>call.method==="fs.remove").params'), { fids: ['7000'] });
  });

  await t.test('download progress, pause/resume/cancel/retry, file reveal and record cleanup', async () => {
    await click('.row [data-op="download"]');
    await until('QKUI.state.transfers.length===1', 'download task');
    assert.deepEqual(await evaluate('__fixtureCalls.find(call=>call.method==="transfer.download").params'), { fids: ['7000'], names: ['renamed.txt'], localDir: '/fixture' });
    await click('[data-view="transfers"]');
    await evaluate('__fixture.tasks[0].transferred=50;__fixtureEmit("qk:transfer-update",__fixture.tasks)');
    assert.equal(await evaluate('document.querySelector(".tbar>i").style.width'), '50%');
    for (const [action, status] of [['pause', 'paused'], ['resume', 'running'], ['cancel', 'canceled']]) {
      await click('.trow [data-tact="' + action + '"]');
      await until('document.querySelector(".trow").dataset.status===' + JSON.stringify(status), action);
    }
    // 已取消任务显示「重试」与「清除记录」，不误显示「打开所在文件夹」
    assert.equal(await evaluate('!!document.querySelector(".trow [data-tact=\\"retry\\"]")'), true);
    assert.equal(await evaluate('!!document.querySelector(".trow [data-tact=\\"open\\"]")'), false);
    await click('.trow [data-tact="clear"]');
    await until('!document.querySelector(".trow")', 'canceled record cleared');
    await evaluate('QKUI.setView("files")');
    await click('.row [data-op="download"]');
    await until('QKUI.state.transfers.length===1', 'second download');
    await evaluate('__fixture.tasks[0].status="error";__fixture.tasks[0].error="fixture error";__fixtureEmit("qk:transfer-update",__fixture.tasks);QKUI.setView("transfers")');
    await click('.trow [data-tact="retry"]');
    await until('QKUI.state.transfers[0].status==="running"', 'retry running');
    await evaluate('__fixture.tasks[0].status="done";__fixture.tasks[0].transferred=100;__fixtureEmit("qk:transfer-update",__fixture.tasks)');
    await click('.trow [data-tact="open"]');
    await until('__fixtureCalls.some(call=>call.method==="transfer.openItem")', 'native reveal');
    assert.equal(await evaluate('__fixtureCalls.filter(call=>call.method==="transfer.openItem").length'), 1);
    assert.equal(await evaluate('__fixtureCalls.filter(call=>call.method==="dialog.showInFolder").length'), 0);
    await click('#btn-clear-finished');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('QKUI.state.transfers.length===0', 'done record cleanup');
  });

  await t.test('native file picker and Tauri drag/drop queue uploads in the current directory', async () => {
    await evaluate('QKUI.setView("files");QKUI.navigate("0")');
    await until('QKUI.state.loadedOnce && !QKUI.state.loading', 'upload target loaded');
    await click('#btn-upload');
    await until('QKUI.state.transfers.length===1 && QKUI.state.view==="transfers"', 'picker upload task');
    assert.deepEqual(await evaluate('__fixtureCalls.find(call=>call.method==="transfer.upload").params'), { localPaths: ['/fixture/local-upload.bin'], pdirFid: '0' });
    await evaluate('QKUI.setView("files");__fixtureEmit("tauri://drag-drop",{paths:["/fixture/dropped.bin"]})');
    await until('QKUI.state.transfers.length===2', 'native drop upload task');
    assert.deepEqual(await evaluate('__fixtureCalls.filter(call=>call.method==="transfer.upload")[1].params'), { localPaths: ['/fixture/dropped.bin'], pdirFid: '0' });
  });

  await t.test('a pushed task snapshot wins over an older in-flight task listing', async () => {
    await evaluate('__fixture.holdTransfers=true;QKUI.setView("transfers")');
    await until('typeof __fixture.releaseTransfers==="function"', 'pending task snapshot');
    await evaluate('__fixture.tasks[0].status="paused";__fixtureEmit("qk:transfer-update",__fixture.tasks);__fixture.holdTransfers=false;__fixture.releaseTransfers([])');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(await evaluate('QKUI.state.transfers[0].status'), 'paused');
  });

  await t.test('logout clears account files, selection, quota and invalidates an in-flight page; login reloads', async () => {
    await evaluate('QKUI.setView("files");__fixture.holdPage=true;QKUI.reload()');
    await until('typeof __fixture.releasePage==="function"', 'pending page');
    await click('#btn-logout-2');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('QKUI.state.account.loggedIn===false', 'logged out');
    assert.equal(await evaluate('QKUI.state.items.length'), 0);
    assert.equal(await evaluate('QKUI.state.selected.size'), 0);
    assert.equal(await evaluate('QKUI.state.quota'), null);
    await evaluate('__fixture.holdPage=false;__fixture.releasePage({list:[{fid:"stale",name:"old account",dir:false}],total:1,page:1,size:100,hasMore:false})');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(await evaluate('QKUI.state.items.length'), 0);
    await click('#account .btn');
    await until('QKUI.state.account.loggedIn && QKUI.state.loadedOnce && !QKUI.state.loading && QKUI.state.items.length===2', 'login reload');
  });
  await t.test('file workspace upgrades: history, self-only crumbs, filters, sort, grid, inspector, additive checkbox, batch transfers and 760px layout', async () => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 780, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.documentElement.setAttribute("data-theme","light");__fixture.navigationMode=true;__fixture.selfOnlyCrumbs=true;QKUI.setView("files");QKUI.navigate("0")');
    await until('QKUI.state.fid==="0" && !QKUI.state.loading', 'workspace root loaded');

    // 1. 自包含面包屑（仅返回 [cur]）绝不能冲掉父目录 folder-A；前进/后退历史可用
    await evaluate('document.querySelector(".row[data-fid=\\"folder-A\\"]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    await until('QKUI.state.fid==="folder-A" && !QKUI.state.loading', 'enter folder-A');
    await evaluate('document.querySelector(".row[data-fid=\\"folder-deep\\"]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    await until('QKUI.state.fid==="folder-deep" && !QKUI.state.loading', 'enter folder-deep');
    assert.deepEqual(await evaluate('QKUI.state.crumbs.map(c=>c.fid)'), ['0', 'folder-A', 'folder-deep'], 'self-only crumbs must preserve local ancestor chain');
    assert.equal(await evaluate('document.getElementById("btn-back").disabled'), false);
    await click('#btn-back');
    await until('QKUI.state.fid==="folder-A" && !QKUI.state.loading', 'history back to folder-A');
    assert.equal(await evaluate('document.getElementById("btn-forward").disabled'), false);
    await click('#btn-forward');
    await until('QKUI.state.fid==="folder-deep" && !QKUI.state.loading', 'history forward to folder-deep');

    // 2. 切回丰富多类型列表验证分类筛选、排序、视图模式、右侧详情与多选
    await evaluate('__fixture.navigationMode=false;__fixture.selfOnlyCrumbs=false;__fixture.directoryMode=false;QKUI.navigate("0","全部文件",undefined,{skipCache:true})');
    await until('QKUI.state.items.length>=100 && !QKUI.state.loading && !!document.querySelector(".row[data-fid=\\"1\\"] input[type=\\"checkbox\\"]")', 'rich root loaded');

    // 复选框多选为累加模式（点第 1 项再点第 2 项的 checkbox 应保留两项）
    await click('.row[data-fid="1"] input[type="checkbox"]');
    await click('.row[data-fid="2"] input[type="checkbox"]');
    assert.equal(await evaluate('QKUI.state.selected.size'), 2, 'checkbox clicks must be additive multi-select');

    // 右侧详情面板展示已选汇总 / 单选详情
    await click('#btn-inspector');
    assert.equal(await evaluate('document.getElementById("file-inspector").hidden'), false, 'inspector drawer opens');
    assert.ok((await evaluate('document.getElementById("inspector-body").textContent')).includes('已选中 2 个项目'));
    await click('.row[data-fid="1"]');
    assert.equal(await evaluate('QKUI.state.selected.size'), 1, 'plain row click selects single item');
    assert.ok((await evaluate('document.getElementById("inspector-body").textContent')).includes('fixture-1.txt'));

    // 网格模式与排序切换持久化到设置
    await click('#view-mode-seg [data-mode="grid"]');
    assert.ok(await evaluate('document.getElementById("list").classList.contains("view-grid")'));
    assert.equal(await evaluate('__fixture.settings.viewMode'), 'grid');
    await click('#view-mode-seg [data-mode="list"]');
    assert.equal(await evaluate('document.getElementById("list").classList.contains("view-grid")'), false);

    // 分类筛选（全部 → 文件夹 → 恢复全部）
    await click('#filter-pills [data-filter="dir"]');
    assert.equal(await evaluate('QKUI.state.filter'), 'dir');
    assert.ok((await evaluate('document.getElementById("statusbar-summary").textContent')).includes('筛选'));
    await click('#filter-pills [data-filter="all"]');
    assert.equal(await evaluate('QKUI.state.filter'), 'all');

    // 目录选择器：工具栏「上一级」与「新建文件夹」可用
    await evaluate('__fixture.navigationMode=true');
    await click('.row[data-fid="1"] [data-op="move"]');
    await until('!!document.querySelector(".overlay:not(.overlay-out) .picker-row[data-fid=\\"folder-A\\"]")', 'picker opened');
    await evaluate('document.querySelector(".overlay:not(.overlay-out) .picker-row[data-fid=\\"folder-A\\"]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    await until('!!document.querySelector(".overlay:not(.overlay-out) .picker-row[data-fid=\\"folder-deep\\"]")', 'picker drilled into folder-A');
    await click('.overlay:not(.overlay-out) .picker-toolbar .btn:first-child');
    await until('!!document.querySelector(".overlay:not(.overlay-out) .picker-row[data-fid=\\"folder-A\\"]")', 'picker up button returned to root');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:first-child');
    await evaluate('__fixture.navigationMode=false;__fixture.directoryMode=true');

    // 传输中心筛选与批量暂停/继续
    await evaluate('__fixture.tasks=[{id:"bt1",kind:"download",name:"a.zip",status:"running",size:100,transferred:40,speed:1024,eta:10},{id:"bt2",kind:"upload",name:"b.mp4",status:"error",size:200,transferred:20,speed:0,error:"超时"}];__fixtureEmit("qk:transfer-update",__fixture.tasks);QKUI.setView("transfers")');
    await until('document.querySelectorAll(".trow").length===2', 'two transfer rows');
    await click('#transfer-filters [data-tfilter="error"]');
    assert.equal(await evaluate('document.querySelectorAll(".trow").length'), 1, 'error filter narrows rows');
    await click('#transfer-filters [data-tfilter="all"]');
    await click('#btn-pause-all');
    await until('QKUI.state.transfers.find(x=>x.id==="bt1").status==="paused"', 'pauseAll paused running task');
    await click('#btn-resume-all');
    await until('QKUI.state.transfers.find(x=>x.id==="bt1").status==="running"', 'resumeAll resumed paused task');
    await click('#btn-retry-failed');
    await until('QKUI.state.transfers.find(x=>x.id==="bt2").status==="running"', 'retryFailed retried errored task');

    // 760x520 最小窗口下全部视图零横向溢出
    await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 520, deviceScaleFactor: 1, mobile: false });
    for (const v of ['files', 'recycle', 'transfers', 'settings', 'feedback']) {
      await evaluate('QKUI.setView(' + JSON.stringify(v) + ')');
      await new Promise(r => setTimeout(r, 30));
      assert.equal(await evaluate('document.documentElement.scrollWidth<=760'), true, v + ' must not overflow at 760px');
    }
    await evaluate('__fixture.tasks=[];__fixtureEmit("qk:transfer-update",[]);QKUI.setInspectorOpen(false);QKUI.setView("files");QKUI.navigate("0")');
    await until('QKUI.state.loadedOnce && !QKUI.state.loading', 'restored after workspace tests');
  });

  await t.test('deep breadcrumbs, live subbar pill, per-file download dir, relaxed limits, auto-refresh, optional server & feedback', async () => {
    const screenshots = process.env.QCK_AUDIT_SCREENSHOTS;
    async function capture(name) {
      if (!screenshots) return;
      await evaluate('document.querySelectorAll(".toast-close").forEach(b=>b.click())');
      await new Promise(r => setTimeout(r, 180));
      fs.mkdirSync(screenshots, { recursive: true });
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(screenshots, name + '.png'), Buffer.from(shot.data, 'base64'));
    }

    await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 780, deviceScaleFactor: 1, mobile: false });
    await new Promise(r => setTimeout(r, 60));
    await evaluate('document.documentElement.setAttribute("data-theme","light");__fixture.directoryMode=false;__fixture.deepMode=false;QKUI.setView("files");QKUI.navigate("0")');
    await until('QKUI.state.loadedOnce && !QKUI.state.loading', 'root files ready');

    // 1. 备份功能已彻底移除
    assert.equal(await evaluate('document.querySelector("[data-view=\\"backup\\"]")'), null, 'backup nav must be removed');
    assert.equal(await evaluate('document.getElementById("view-backup")'), null, 'backup view must be removed');

    // 2. 深层目录面包屑：全部文件常驻 + 「···」下拉菜单一键直达中间祖先
    await evaluate('__fixture.deepMode=true;QKUI.navigate("folder-4","新建文件夹4")');
    await until('QKUI.state.crumbs.length===5', '5-level deep crumbs loaded');
    assert.equal(await evaluate('document.querySelector("#crumbs .crumb-root").textContent'), '全部文件', 'root crumb must stay pinned');
    assert.ok(await evaluate('!!document.querySelector("#crumbs .crumb-ellipsis")'), 'ellipsis popover button rendered for 4+ levels');
    await click('#crumbs .crumb-ellipsis');
    await until('!document.getElementById("crumb-menu").hidden', 'crumb popover opened');
    assert.equal(await evaluate('document.querySelectorAll("#crumb-menu .ctx-item").length'), 3, 'collapsed ancestors listed in popover');
    await capture('deep-crumbs-popover');
    // 点击折叠菜单中的「新建文件夹2」直接跳回
    await click('#crumb-menu .ctx-item:nth-of-type(2)');
    await until('QKUI.state.fid==="folder-2"', 'jumped via collapsed crumb popover');
    assert.equal(await evaluate('document.getElementById("crumb-menu").hidden'), true, 'popover closes after jump');
    await evaluate('__fixture.deepMode=false;QKUI.navigate("0")');
    await until('QKUI.state.fid==="0" && !QKUI.state.loading', 'returned to root');

    // 3. 实时传输胶囊：压缩包与最新修改中间显示速度/进度/文件名，空闲时隐藏
    assert.equal(await evaluate('document.getElementById("subbar-transfer-live").hidden'), true, 'live pill hidden when idle');
    await evaluate('__fixture.tasks=[{id:"s1",kind:"download",name:"设计素材包_2026.zip",status:"running",size:524288000,transferred:286000000,speed:14200000,eta:16},{id:"s2",kind:"upload",name:"项目复盘视频.mp4",status:"paused",size:180000000,transferred:62000000,speed:0},{id:"s3",kind:"download",name:"季度报表.xlsx",status:"done",size:4200000,transferred:4200000,speed:0,localPath:"/fixture/季度报表.xlsx"}];__fixtureEmit("qk:transfer-update",__fixture.tasks)');
    await until('!document.getElementById("subbar-transfer-live").hidden', 'live subbar pill visible during active transfer');
    assert.ok((await evaluate('document.getElementById("stl-name").textContent')).includes('设计素材包_2026.zip'));
    assert.ok((await evaluate('document.getElementById("stl-meta").textContent')).includes('MB/s'));
    await capture('files-light-live-transfer');

    // 4. 自动刷新：<10 个任务完成时自动静默刷新当前目录；账号状态与剩余空间周期同步
    const listBefore = await evaluate('__fixtureCalls.filter(c=>c.method==="fs.list").length');
    await evaluate('__fixture.tasks[0].status="done";__fixture.tasks[0].transferred=__fixture.tasks[0].size;__fixture.tasks[0].speed=0;__fixtureEmit("qk:transfer-update",__fixture.tasks)');
    await until('__fixtureCalls.filter(c=>c.method==="fs.list").length > ' + listBefore, 'auto-refreshed after <10 transfer finished');
    assert.equal(await evaluate('document.getElementById("subbar-transfer-live").hidden'), true, 'live pill hides when no active tasks');
    await evaluate('__fixture.quota={total:10*1024*1024*1024,used:2*1024*1024*1024,free:8*1024*1024*1024};__fixture.account.memberLabel="SVIP";QKUI.silentRefreshAccountAndQuota({force:true,withAccount:true});void 0');
    await until('document.getElementById("sidebar-quota-free").textContent.includes("8.00 GB")', 'quota remaining space refreshed in sidebar');
    assert.ok((await evaluate('document.getElementById("sidebar-quota-text").textContent')).includes('2.00 GB'), 'sidebar shows used/total');
    assert.ok((await evaluate('document.getElementById("account").textContent')).includes('SVIP'), 'account status refreshed');
    assert.ok((await evaluate('document.getElementById("account").textContent')).includes('8.00 GB'), 'topbar shows remaining space at 1200px default width');
    assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".acct-quota-text")).display'), 'none', 'topbar remaining space must stay visible at 1200px');
    assert.ok((await evaluate('document.getElementById("set-account-hint").textContent')).includes('剩余可用 8.00 GB'), 'settings account hint includes remaining quota');

    // 5. 下载目录：设置「每次询问目录」后单次下载可指定独立路径，且不覆盖默认目录
    await evaluate('QKUI.setView("settings")');
    await click('#set-ask-dl-dir [data-ask-dl="on"]');
    await until('__fixture.settings.askDownloadDir===true', 'askDownloadDir persisted');
    await evaluate('__fixture.customSaveDir="/fixture/custom-one";QKUI.setView("files")');
    await evaluate('document.querySelector(".row[data-fid=\\"1\\"] .op[data-op=\\"download\\"]").click()');
    await until('__fixtureCalls.some(c=>c.method==="transfer.download" && c.params.localDir==="/fixture/custom-one")', 'downloaded to per-file custom directory');
    assert.equal(await evaluate('__fixture.settings.downloadDir'), '/fixture', 'default downloadDir preserved');

    // 6. 并发上限放宽 + 超过阈值显示提醒
    await evaluate('QKUI.setView("settings")');
    await evaluate('const inp=document.getElementById("set-down-parallel");inp.value="48";inp.dispatchEvent(new Event("input"));inp.dispatchEvent(new Event("change"))');
    await until('__fixture.settings.downloadParallel===48', 'uncapped downloadParallel saved');
    assert.equal(await evaluate('document.getElementById("set-perf-warn").hidden'), false, 'perf threshold warning shown');
    await capture('settings-relaxed-and-hub');

    // 7. 可选作者服务器：首次弹窗拒绝零外传 -> 开启后可验签检查更新 + 反馈提交
    await evaluate('__fixtureCalls.length=0;window.__optInRes=QKUI.showServerOptInModal();void 0');
    await until('!!document.getElementById("optin-btn-decline")', 'opt-in modal visible');
    await capture('server-optin-modal');
    await click('#optin-btn-decline');
    await until('__fixture.settings.serverOptIn===false', 'declined opt-in');
    assert.equal(await evaluate('__fixtureCalls.some(c=>c.method==="hub.checkUpdate"||c.method==="hub.sendTelemetry")'), false, 'zero server requests when declined');

    // 开启后检查更新并展示 Ed25519 验签通过的更新日志与直链下载按钮
    await click('#set-hub-optin [data-hub-optin="on"]');
    await until('!document.getElementById("hub-update-panel").hidden', 'update manifest loaded after opt-in');
    assert.ok((await evaluate('document.getElementById("hub-update-title").textContent')).includes('1.0.1'));
    assert.equal(await evaluate('document.getElementById("btn-hub-download").hidden'), false, 'direct download button visible');
    await click('#btn-hub-download');
    await until('!document.getElementById("btn-hub-reveal").hidden', 'direct update downloaded and verified');

    // 反馈视图：填写并附带脱敏日志提交
    await click('[data-view="feedback"]');
    await evaluate('document.getElementById("fb-message").value="新版本下载速度非常快，面包屑也很好用！"');
    await capture('feedback-view');
    await click('#fb-btn-submit');
    await until('document.getElementById("fb-status").textContent.includes("#42")', 'feedback submitted with ticket id');

    // 其余核心视图截图（深色 / 详情抽屉 / 网格 / 传输 / AI Beta / 760px 窄窗）
    await evaluate('QKUI.setView("files");QKUI.setInspectorOpen(true);document.querySelector(".row[data-fid=\\"1\\"]").click()');
    await capture('files-inspector');
    await evaluate('QKUI.applyViewMode("grid",false)');
    await capture('files-grid');
    await evaluate('QKUI.applyViewMode("list",false);QKUI.setInspectorOpen(false);document.documentElement.setAttribute("data-theme","dark")');
    await capture('files-dark');
    await evaluate('document.documentElement.setAttribute("data-theme","light");QKUI.setView("transfers")');
    await capture('transfers');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 520, deviceScaleFactor: 1, mobile: false });
    for (const v of ['files', 'recycle', 'transfers', 'settings', 'feedback']) {
      await evaluate('QKUI.setView(' + JSON.stringify(v) + ')');
      await new Promise(r => setTimeout(r, 40));
      assert.equal(await evaluate('document.documentElement.scrollWidth<=760'), true, v + ' must fit 760px');
    }
    await evaluate('QKUI.setView("files")');
    await capture('files-760');
  });

  await t.test('cloud tools: folder size, enriched details & revisions, cloud archive (pwd/conflict/progress), storage breakdown & recycle bin', async () => {
    const screenshots = process.env.QCK_AUDIT_SCREENSHOTS;
    async function capture(name) {
      if (!screenshots) return;
      await evaluate('document.querySelectorAll(".toast-close").forEach(b=>b.click())');
      await new Promise(r => setTimeout(r, 180));
      fs.mkdirSync(screenshots, { recursive: true });
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(screenshots, name + '.png'), Buffer.from(shot.data, 'base64'));
    }

    await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 780, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.documentElement.setAttribute("data-theme","light");__fixture.cloudToolsMode=true;__fixture.directoryMode=false;__fixture.deepMode=false;__fixture.navigationMode=false;__fixture.archivePwdRequired=true;__fixture.archiveConflictOnce=true;__fixture.recycleItems=[{recordId:"rec-1",fid:"rf-1",name:"旧报告.pdf",dir:false,ext:"pdf",size:524288,pdirFid:"0",pdirName:"全部文件",deletedAt:1763817600000,remainMs:7*86400000},{recordId:"rec-2",fid:"rf-2",name:"草稿目录",dir:true,ext:"",size:0,pdirFid:"folder-A",pdirName:"一级目录",deletedAt:1763817600000,remainMs:2*86400000}];QKUI.setView("files");QKUI.navigate("0","全部文件",undefined,{skipCache:true})');
    await until('QKUI.state.items.length===4 && !QKUI.state.loading && !!document.querySelector(".row[data-fid=\\"folder-A\\"]")', 'cloud tools list loaded');

    // 1. 无需点开详情抽屉，主列表自动后台统计并直接显示文件夹真实大小；打开详情抽屉也正确格式化数组形式 fullPath
    await until('document.querySelector(".row[data-fid=\\"folder-A\\"] .col-size").textContent.includes("181 MB") && document.querySelector(".row[data-fid=\\"folder-B\\"] .col-size").textContent.includes("40.0 MB")', 'folder sizes auto-populated in main file list without opening inspector');
    await evaluate('QKUI.setInspectorOpen(true)');
    await click('.row[data-fid="folder-A"]');
    await until('document.getElementById("inspector-body").textContent.includes("181 MB") && document.getElementById("inspector-body").textContent.includes("7 项") && document.getElementById("inspector-body").textContent.includes("/全部文件/一级目录")', 'folder real size and formatted path displayed in inspector');
    await capture('cloud-folder-inspector');

    // 增量勾选第二个文件夹，触发多选总大小统计
    await click('.row[data-fid="folder-B"] input[type="checkbox"]');
    await until('!!document.getElementById("btn-inspector-calc-multi")', 'multi-select folder calc button visible');
    await click('#btn-inspector-calc-multi');
    await until('document.getElementById("inspector-body").textContent.includes("221 MB") && document.getElementById("inspector-body").textContent.includes("10 项")', 'multi-select folder total calculated');

    // 2. 文件详细信息增强（时长/fps/来源/路径/摘要）+ 历史版本查看与恢复
    await click('.row[data-fid="tool-video"]');
    await until('document.getElementById("inspector-body").textContent.includes("02:05") && document.getElementById("inspector-body").textContent.includes("60 fps") && document.getElementById("inspector-body").textContent.includes("手动上传")', 'enriched media details shown');
    await click('#btn-inspector-revisions');
    await until('document.querySelectorAll(".inspector-rev-item").length===2', 'file revisions loaded');
    await click('.inspector-rev-item button');
    await until('!!document.querySelector(".overlay:not(.overlay-out) .dlg-confirm")', 'revision revert confirm dialog opened');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn:last-child');
    await until('__fixtureCalls.some(c=>c.method==="fs.revertRevision" && c.params.fid==="tool-video" && c.params.version===2)', 'revision reverted');

    // 3. 云解压弹窗：密码拦截 -> 正确密码解锁 -> 目录钻取 -> 同名覆盖确认 -> 任务完成与跳转
    assert.equal(await evaluate('document.querySelector(".row[data-fid=\\"tool-zip\\"] .op[data-op=\\"unarchive\\"]").hidden'), false, 'archive row shows unarchive op button');
    assert.equal(await evaluate('document.querySelector(".row[data-fid=\\"tool-video\\"] .op[data-op=\\"unarchive\\"]").hidden'), true, 'non-archive row hides unarchive op button');
    await click('.row[data-fid="tool-zip"] .op[data-op="unarchive"]');
    await until('!!document.getElementById("archive-pwd-input") && !document.querySelector(".archive-pwd-bar").hidden', 'password prompt shown for encrypted archive');
    await evaluate('document.getElementById("archive-pwd-input").value="wrong"');
    await click('#archive-pwd-submit');
    await until('document.querySelector(".archive-pwd-msg").textContent.includes("不正确")', 'wrong password feedback shown');
    await evaluate('document.getElementById("archive-pwd-input").value="secret123"');
    await click('#archive-pwd-submit');
    await until('document.querySelectorAll(".archive-row").length===2', 'archive root unlocked and listed');
    await capture('cloud-archive-modal');
    // 钻取子目录 docs
    await click('.archive-row[data-path-no="1"] .picker-enter');
    await until('document.querySelector(".archive-row-name")?.textContent==="inside.md"', 'drilled into archive subfolder');
    // 勾选子文件并触发解压 -> 遭遇 CONFLICT 弹窗 -> 确认覆盖 -> 进度完成 -> 前往查看
    await click('.archive-row[data-path-no="1/1"] input[type="checkbox"]');
    await click('#archive-btn-extract-sel');
    await until('!!document.querySelector(".overlay:not(.overlay-out) .dlg-confirm")', 'conflict overwrite confirm dialog shown');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn-danger');
    await until('!document.getElementById("archive-btn-goto").hidden', 'archive extraction finished with goto button');
    assert.ok(await evaluate('__fixtureCalls.some(c=>c.method==="archive.unarchive" && c.params.conflictMode===2)'), 'retried with overwrite conflictMode=2');
    await click('#archive-btn-goto');
    await until('QKUI.state.fid==="folder-A"', 'jumped to extracted target dir');

    // 4. 空间占用明细弹窗（点击侧边栏空间卡片打开）
    await click('#sidebar-quota');
    await until('document.querySelectorAll(".storage-row").length===3', 'storage breakdown modal loaded');
    assert.ok((await evaluate('document.querySelector(".dlg-storage").textContent')).includes('手动上传'), 'storage category label shown');
    await capture('cloud-storage-modal');
    await click('#storage-btn-recycle');

    // 5. 回收站视图：列表渲染 -> 单项还原 -> 彻底删除 -> 760px 零溢出
    await until('QKUI.state.view==="recycle" && document.querySelectorAll(".recycle-row").length===2', 'recycle view opened from storage modal');
    await capture('cloud-recycle-view');
    await click('.recycle-row[data-record-id="rec-1"] button[aria-label^="还原"]');
    await until('__fixtureCalls.some(c=>c.method==="recycle.recover" && c.params.recordIds[0]==="rec-1") && document.querySelectorAll(".recycle-row").length===1', 'recycled item recovered');
    await click('#btn-recycle-clear');
    await until('!!document.querySelector(".overlay:not(.overlay-out) .dlg-confirm")', 'clear recycle confirm shown');
    await click('.overlay:not(.overlay-out) .dlg-foot .btn-danger');
    await until('__fixtureCalls.some(c=>c.method==="recycle.remove" && c.params.clearAll===true) && document.querySelectorAll(".recycle-row").length===0', 'recycle bin cleared');

    // 6. 首次使用引导教程：支持分步浏览、一键「全部跳过」持久化 tutorialSeen，并可从设置页重新打开
    await evaluate('QKUI.setView("files");QKUI.state.settings.tutorialSeen=false;__fixture.settings.tutorialSeen=false;window.__tutRes=QKUI.showOnboardingTutorial();void 0');
    await until('!!document.getElementById("tut-btn-skip")', 'onboarding tutorial opened');
    assert.equal(await evaluate('document.querySelector(".tut-step-counter").textContent'), '1 / 4', 'tutorial starts at step 1/4');
    await capture('v1-onboarding-tutorial');
    await click('#tut-btn-next');
    assert.equal(await evaluate('document.querySelector(".tut-step-counter").textContent'), '2 / 4', 'next button advances to step 2/4');
    await click('#tut-btn-prev');
    assert.equal(await evaluate('document.querySelector(".tut-step-counter").textContent'), '1 / 4', 'prev button goes back to step 1/4');
    await click('#tut-btn-skip');
    await until('!document.querySelector(".dlg-tutorial") && __fixture.settings.tutorialSeen===true', 'skip all closes tutorial and persists tutorialSeen');
    await evaluate('QKUI.setView("settings")');
    await click('#btn-open-tutorial');
    await until('!!document.querySelector(".overlay:not(.overlay-out) .dlg-tutorial")', 'reopened tutorial from settings');
    await click('.overlay:not(.overlay-out) #tut-btn-next');
    await click('.overlay:not(.overlay-out) #tut-btn-next');
    await click('.overlay:not(.overlay-out) #tut-btn-next');
    assert.equal(await evaluate('document.querySelector(".overlay:not(.overlay-out) .tut-step-counter").textContent'), '4 / 4', 'reached final step 4/4');
    await click('.overlay:not(.overlay-out) #tut-btn-next');
    await until('!document.querySelector(".overlay:not(.overlay-out) .dlg-tutorial")', 'completed tutorial closes cleanly');

    await evaluate('__fixture.cloudToolsMode=false;QKUI.setInspectorOpen(false);QKUI.setView("files")');
  });

});
