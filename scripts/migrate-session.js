'use strict';
// 只迁移当前用户的旧格式登录资料，不打印凭据。旧系统密文可能需要一次原系统授权。
const fs = require('node:fs');
const { createSecureStore } = require('../src/main/core/secure-store');
const { userDataDir } = require('../src/main/core/platform');
const store = createSecureStore({ userDataDir: userDataDir() });
if (!fs.existsSync(store.filePath)) {
  console.log('没有需要迁移的登录资料。');
} else {
  const before = fs.readFileSync(store.filePath).subarray(0, 4).toString();
  try {
    store.snapshot();
    console.log(before === 'QCK1' ? '旧登录资料已迁移为免系统密码的本地加密格式，原密文已备份。' : '登录资料已使用当前格式，无需迁移。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
