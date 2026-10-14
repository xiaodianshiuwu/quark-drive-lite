'use strict';
// 供本项目的 Node 命令行工具调用；请求只在子进程内存中传递，不进入命令参数、磁盘或日志。
const { app, safeStorage } = require('electron');
const text=Buffer.from(process.env.QCK_STORAGE_REQUEST||'', 'base64').toString('utf8');
delete process.env.QCK_STORAGE_REQUEST;
let data;
try {
  data=JSON.parse(text);
  app.setPath('userData',data.userDataDir);
} catch { app.exit(1); }
let stage='等待系统加密服务';
app.whenReady().then(() => {
  stage='加密能力检查';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('加密服务不可用');
  stage='执行加密操作';
  let value;
  if (data.op === 'encrypt') value = safeStorage.encryptString(data.value).toString('base64');
  else if (data.op === 'decrypt') value = safeStorage.decryptString(Buffer.from(data.value, 'base64'));
  else throw new Error('操作无效');
  process.stdout.write(JSON.stringify({ value }), () => app.quit());
}).catch(() => { console.error('加密子进程失败：'+stage); app.exit(1); });
