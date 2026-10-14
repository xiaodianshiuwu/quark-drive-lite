'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.QCK_AUDIT_ROOT || path.join(__dirname, '..');
const { ErrCode, QuarkError, isNeedLogin } = require(path.join(root, 'src/main/core/errors'));
async function harness() {
  const handlers = new Map();
  const state = { verified:0, expired:false, window:null, transferOptions:null };
  const session = { load(){ return this; }, getCookie(){ return ''; }, save(){}, markExpired(){ state.expired=true; } };
  const account = { status:async()=>({ loggedIn:true }), verify:async()=>{ state.verified++; return {}; }, onStateChange(){} };
  class Window {
    constructor() {
      this.events = {};
      this.webContents = { mainFrame:{}, send(){}, on(){}, setWindowOpenHandler(){}, getURL:()=> 'file:///app/index.html' };
      state.window=this;
    }
    isDestroyed(){ return false; } removeMenu(){} loadFile(){} show(){}
    once(name,fn){ this.events[name]=fn; } on(name,fn){ this.events[name]=fn; }
  }
  const electron = { app:{ requestSingleInstanceLock:()=>true, whenReady:()=>Promise.resolve(), on(){}, getPath:()=>'/unused' }, BrowserWindow:Window,
    ipcMain:{ handle:(name,fn)=>handlers.set(name,fn) }, dialog:{}, shell:{}, nativeTheme:{} };
  const requireMock = name => {
    if (name==='electron') return electron;
    if (name==='path' || name==='fs/promises') return require(name);
    if (name==='./core/http') return { HttpClient:class{} };
    if (name==='./core/secure-store') return { createSecureStore:()=>({}) };
    if (name==='./core/session') return { createSession:()=>session };
    if (name==='./modules/account') return { createAccountModule:()=>account };
    if (name==='./modules/fs') return { createFsModule:()=>({}) };
    if (name==='./modules/transfer') return { createTransferModule:opts=>{ state.transferOptions=opts; return {}; } };
    if (name==='./modules/settings') return { createSettingsModule:()=>({ getDownloadDir(){}, getConcurrency(){} }) };
    if (name==='./core/errors') return { ErrCode,QuarkError,isNeedLogin };
    throw Error('未预期的依赖：'+name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/main/main.js'),'utf8'), { require:requireMock, process:{ platform:'win32' }, __dirname:path.join(root,'src/main'), console });
  await new Promise(r=>setImmediate(r));
  return { state,handlers };
}

test('主进程：拒绝其他窗口和子框架的 IPC 调用', async()=>{
  const { state,handlers } = await harness();
  const invoke = handlers.get('qk:auth:status');
  const wc = state.window.webContents;
  const valid = await invoke({ sender:wc, senderFrame:wc.mainFrame });
  assert.equal(valid.__qk,true);
  for (const evt of [{ sender:{}, senderFrame:wc.mainFrame }, { sender:wc, senderFrame:{} }]) {
    const result = await invoke(evt);
    assert.equal(result.__qk,false);
    assert.equal(result.error.code,ErrCode.FORBIDDEN);
  }
});

test('主进程：已有凭据时启动会等待本地状态，再真实判活', async()=>{
  const { state } = await harness();
  await state.window.events['ready-to-show']();
  assert.equal(state.verified,1);
});

test('主进程：传输接口报登录失效时同时标记 session', async()=>{
  const { state } = await harness();
  state.transferOptions.onError(new QuarkError('登录失效',{ code:ErrCode.NEED_LOGIN }),{ name:'测试任务' });
  assert.equal(state.expired,true);
});
