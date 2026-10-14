'use strict';
// 仅处理验收创建的 profile 与固定测试数据，不读取真实账号会话。
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {createSecureStore}=require('../src/main/core/secure-store');
app.setName('quark-mini');
const systemFixture=process.env.QCK_STORAGE_TEST_BACKEND==='system';
if(!systemFixture)require('../src/main/core/browser-storage').configureBrowserStorage(app);
const directory=process.env.QCK_STORAGE_TEST_DIR;
if(!directory||!path.isAbsolute(directory))throw Error('缺少独立验收 profile');
app.setPath('userData',directory);
app.whenReady().then(async()=>{
  console.error(`加密验收：Electron ${process.versions.electron}，应用 ${app.getName()}，操作 ${process.env.QCK_STORAGE_TEST_ACTION}`);
  // 旧 macOS Electron 需先建立 BrowserContext 才能使用正确的应用 Keychain 上下文。
  if(process.platform==='darwin')await new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}}).loadURL('about:blank');
  console.error('加密验收：系统存储上下文已就绪');
  const store=createSecureStore({userDataDir:directory,requireEncryption:true,storageBackend:systemFixture?'system':'local'});
  console.error('加密验收：检测系统加密可用性');
  if(!store.isAvailable())throw Error('系统加密服务不可用');
  console.error('加密验收：执行密文读写');
  if(process.env.QCK_STORAGE_TEST_ACTION==='write')store.setItems({fixture:'跨版本测试',settings:{theme:'dark'}});
  else if(store.getItem('fixture')!=='跨版本测试'||store.getItem('settings')?.theme!=='dark')throw Error('加密存储回读不一致');
  if(process.env.QCK_STORAGE_EXPECT_CONCURRENCY&&store.getItem('settings')?.downloadConcurrency!==Number(process.env.QCK_STORAGE_EXPECT_CONCURRENCY))throw Error('设置未正确落盘');
  if(!fs.readFileSync(store.filePath).subarray(0,4).equals(Buffer.from(systemFixture?'QCK1':'QCK2')))throw Error('存储未加密');
  process.stdout.write(JSON.stringify({encrypted:true,electron:process.versions.electron,backend:systemFixture?'legacy-system':'local-aes-256-gcm'}),()=>app.quit());
}).catch(()=>{console.error('系统加密存储验收失败');app.exit(1);});
