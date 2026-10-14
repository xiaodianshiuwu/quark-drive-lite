'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.QCK_AUDIT_ROOT || path.join(__dirname, '..');
const { ErrCode, QuarkError, isNeedLogin } = require(path.join(root, 'src/main/core/errors'));
async function harness(platform='win32', {holdStorage=false}={}) {
  const handlers = new Map();
  const state = { verified:0, expired:false, window:null, transferOptions:null, contextReady:false };
  const session = { load(){ return this; }, getCookie(){ return ''; }, save(){}, markExpired(){ state.expired=true; } };
  const account = { status:async()=>({ loggedIn:true }), verify:async()=>{ state.verified++; return {}; }, onStateChange(){} };
  class Window {
    constructor() {
      this.events = {};
      this.webContents = { mainFrame:{}, send(){}, on(name,fn){state[name]=fn;}, setWindowOpenHandler(fn){state.windowOpen=fn;}, getURL:()=> 'file:///app/index.html' };
      state.window=this;
    }
    isDestroyed(){ return false; } removeMenu(){}
    async loadFile(file){
      if(file.endsWith('startup.html')){assert.equal(handlers.size,0);state.contextReady=true;}
      else{assert.ok(handlers.size>0);state.interfaceLoaded=true;}
    }
    show(){state.shown=true;}
    async loadURL(url){assert.equal(url,'about:blank');await new Promise(r=>setImmediate(r));state.contextReady=true;}
    once(name,fn){ this.events[name]=fn; } on(name,fn){ this.events[name]=fn; }
  }
  const electron = { app:{ setName(){},commandLine:{appendSwitch(){}},requestSingleInstanceLock:()=>true, whenReady:()=>Promise.resolve(), on(){}, getPath:()=>'/unused' }, BrowserWindow:Window,
    ipcMain:{ handle:(name,fn)=>handlers.set(name,fn) }, dialog:{}, shell:{}, nativeTheme:{} };
  const requireMock = name => {
    if (name==='electron') return electron;
    if (name==='path' || name==='fs/promises') return require(name);
    if (name==='./core/http') return { HttpClient:class{} };
    if (name==='./core/browser-storage') return require('../src/main/core/browser-storage');
    if (name==='./core/secure-store') return { createSecureStore:()=>{
      if(platform==='darwin')assert.equal(state.contextReady,true);
      return {initialize:async()=>{state.storageStarted=true;if(holdStorage)await new Promise(resolve=>{state.finishStorage=resolve;});state.storageReady=true;}};
    } };
    if (name==='./core/session') return { createSession:()=>session };
    if (name==='./modules/account') return { createAccountModule:()=>account };
    if (name==='./modules/fs') return { createFsModule:()=>({}) };
    if (name==='./modules/transfer') return { createTransferModule:opts=>{ state.transferOptions=opts; return {}; } };
    if (name==='./modules/settings') return { createSettingsModule:()=>({ getDownloadDir(){}, getConcurrency(){} }) };
    if (name==='./core/errors') return { ErrCode,QuarkError,isNeedLogin };
    throw Error('未预期的依赖：'+name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/main/main.js'),'utf8'), { require:requireMock, process:{ platform }, __dirname:path.join(root,'src/main'), console });
  await new Promise(r=>setImmediate(r));
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

test('主进程：未登录的文件操作不发起匿名网盘请求',async()=>{
  const {state,handlers}=await harness();
  const wc=state.window.webContents;
  const result=await handlers.get('qk:fs:list')({sender:wc,senderFrame:wc.mainFrame},{});
  assert.equal(result.__qk,false);assert.equal(result.error.code,ErrCode.NEED_LOGIN);
  assert.equal(state.expired,false);
});

test('macOS：上下文就绪后才读取存储，IPC 注册后才加载应用界面',async()=>{
  const {state,handlers}=await harness('darwin');
  assert.equal(state.contextReady,true);assert.ok(handlers.has('qk:auth:status'));
});

test('macOS：读取登录资料时已显示启动界面，读取完成前不提供文件 IPC',async()=>{
  const {state,handlers}=await harness('darwin',{holdStorage:true});
  assert.equal(state.shown,true);assert.equal(state.storageStarted,true);
  assert.equal(state.interfaceLoaded,undefined);assert.equal(handlers.size,0);
  state.finishStorage();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.storageReady,true);assert.equal(state.interfaceLoaded,true);
  assert.ok(handlers.has('qk:auth:status'));
});

test('主进程：已有凭据时启动会等待本地状态，再真实判活', async()=>{
  const { state } = await harness();
  assert.equal(state.verified,1);
});

test('主进程：传输接口报登录失效时同时标记 session', async()=>{
  const { state } = await harness();
  state.transferOptions.onError(new QuarkError('登录失效',{ code:ErrCode.NEED_LOGIN }),{ name:'测试任务' });
  assert.equal(state.expired,true);
});

test('主窗口：读取登录资料期间已拒绝外部导航和弹窗',async()=>{
  const {state}=await harness('darwin',{holdStorage:true});
  let prevented=false;
  state['will-navigate']({preventDefault(){prevented=true;}},'https://example.com');
  assert.equal(prevented,true);assert.equal(state.windowOpen().action,'deny');
  state.finishStorage();
  await new Promise(resolve=>setImmediate(resolve));
});
