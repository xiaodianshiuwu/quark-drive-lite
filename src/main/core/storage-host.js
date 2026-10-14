'use strict';
// 供本项目的 Node 命令行工具调用；请求只在子进程内存中传递，不进入命令参数、磁盘或日志。
const { app, BrowserWindow } = require('electron');
app.setName('quark-mini');
const text=Buffer.from(process.env.QCK_STORAGE_REQUEST||'', 'base64').toString('utf8');
delete process.env.QCK_STORAGE_REQUEST;
let data;
try {
  data=JSON.parse(text);
  app.setPath('userData',data.userDataDir);
} catch { app.exit(1); }
let stage='等待系统加密服务';
app.whenReady().then(async () => {
  if(process.platform==='darwin')await new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}}).loadURL('about:blank');
  const {safeStorage}=require('electron');
  stage='加密能力检查';
  const asynchronous = typeof safeStorage.isAsyncEncryptionAvailable === 'function';
  const available = asynchronous ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  if (!available) throw new Error('加密服务不可用');
  if (typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('系统密钥环不可用');
  stage='执行加密操作';
  let value;
  if (data.op === 'encrypt') {
    const encrypted = asynchronous ? await safeStorage.encryptStringAsync(data.value) : safeStorage.encryptString(data.value);
    value = encrypted.toString('base64');
  } else if (data.op === 'decrypt') {
    if (asynchronous) {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(data.value, 'base64'));
      if (typeof decrypted?.result !== 'string') throw new Error('解密格式无效');
      value = decrypted.result;
    } else value = safeStorage.decryptString(Buffer.from(data.value, 'base64'));
  }
  else throw new Error('操作无效');
  process.stdout.write(JSON.stringify({ value }), () => app.quit());
}).catch(() => { console.error('加密子进程失败：'+stage); app.exit(1); });
