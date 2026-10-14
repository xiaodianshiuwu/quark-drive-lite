'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { userDataDir, resolveElectron, electronEnvironment, createElectronHostApp, deviceModel } = require('../src/main/core/platform');
const { createSecureStore } = require('../src/main/core/secure-store');
const fs = require('node:fs');
const os = require('node:os');
const {createSettingsModule}=require('../src/main/modules/settings');

test('三平台用户目录与 Electron 的约定一致，覆盖目录不会落到仓库根', () => {
  assert.equal(userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\用户\\AppData\\Roaming' }, home: 'C:\\用户' }), 'C:\\用户\\AppData\\Roaming\\quark-mini');
  assert.equal(userDataDir({ platform: 'darwin', env: {}, home: '/Users/测试' }), '/Users/测试/Library/Application Support/quark-mini');
  assert.equal(userDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/tmp/config' }, home: '/home/test' }), '/tmp/config/quark-mini');
  assert.equal(userDataDir({ platform: 'linux', env: {}, home: '/home/test' }), '/home/test/.config/quark-mini');
  assert.equal(userDataDir({ platform: 'linux', env: { QCK_USER_DATA_DIR: '/tmp/验收' }, home: '/home/test' }), '/tmp/验收');
});

test('启动器在三平台解析对应二进制，并保留显式运行时覆盖', () => {
  for (const [platform, suffix] of [['win32','electron.exe'],['linux','electron'],['darwin','Electron.app/Contents/MacOS/Electron']]) {
    const expected = path.join('/project','node_modules/electron/dist',suffix);
    assert.equal(resolveElectron('/project', { platform, load: () => { throw Error(); }, exists: file => file === expected }), expected);
  }
  assert.equal(resolveElectron('/project', { load: () => '/custom/electron', exists: () => true }), '/custom/electron');
  assert.equal(resolveElectron('/project', { load: () => ({}), exists: () => false }), null);
});

test('启动环境仅剥离 Node 劫持变量，保留代理与证书配置', () => {
  const env = { ELECTRON_RUN_AS_NODE:'1', NODE_OPTIONS:'bad', HTTPS_PROXY:'http://localhost:1234', NODE_EXTRA_CA_CERTS:'/tmp/ca.pem' };
  const clean = electronEnvironment(env);
  assert.equal(clean.ELECTRON_RUN_AS_NODE, undefined); assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.HTTPS_PROXY, env.HTTPS_PROXY); assert.equal(clean.NODE_EXTRA_CA_CERTS, env.NODE_EXTRA_CA_CERTS);
  assert.equal(env.NODE_OPTIONS, 'bad');
});

test('设备信息区分 Windows 10/11、macOS 与 Linux', () => {
  assert.equal(deviceModel({ platform:'win32',release:'10.0.19045',arch:'x64' }), 'Windows 10 64-bit');
  assert.equal(deviceModel({ platform:'win32',release:'10.0.26100',arch:'arm64' }), 'Windows 11 64-bit');
  assert.match(deviceModel({ platform:'darwin',release:'24.0.0',arch:'arm64' }), /^macOS/);
  assert.match(deviceModel({ platform:'linux',release:'6.8',arch:'x64' }), /^Linux/);
});

test('加密辅助进程在原生初始化前拥有与产品一致的应用名称',()=>{
  const host=createElectronHostApp(__filename);
  const metadata=JSON.parse(fs.readFileSync(path.join(host.directory,'package.json'),'utf8'));
  assert.equal(metadata.name,'quark-mini');assert.equal(metadata.main,__filename);
  host.cleanup();assert.equal(fs.existsSync(host.directory),false);
});

test('Linux basic_text 不能被正式存储当作安全加密能力', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qck-keyring-'));
  try {
    const store = createSecureStore({ userDataDir: dir, requireEncryption:true, safeStorage:{
      isEncryptionAvailable:()=>true, getSelectedStorageBackend:()=> 'basic_text', encryptString:()=> Buffer.from('假密文'),
    } });
    assert.equal(store.isAvailable(),false);
    assert.throws(()=>store.setItem('test','非账号测试数据'), /系统加密存储不可用/);
    assert.equal(fs.existsSync(store.filePath),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('下载目录采用系统原生位置，已保存的自定义路径不被覆盖',()=>{
  let saved=null;
  const store={getItem:()=>saved,setItem:(_key,value)=>{saved=value;}};
  const getDefaultDownloadDir=()=>'/home/测试/下载';
  const settings=createSettingsModule({store,getDefaultDownloadDir});
  assert.equal(settings.getDownloadDir(),'/home/测试/下载');
  settings.set({downloadDir:'/专用目录'});
  assert.equal(createSettingsModule({store,getDefaultDownloadDir}).getDownloadDir(),'/专用目录');
});

test('设置落盘失败后读取仍保持原值，不返回未保存的新设置',()=>{
  const settings=createSettingsModule({store:{getItem:()=>({theme:'light'}),setItem:()=>{throw Error('写入失败');}}});
  assert.throws(()=>settings.set({theme:'dark'}),/写入失败/);
  assert.equal(settings.get().theme,'light');
});
