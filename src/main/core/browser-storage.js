'use strict';
// 仅改变本应用的 Chromium 凭据存储，不修改系统设置，不影响 TLS 验证。
// 登录 Cookie 由应用的随机本地密钥持久化，浏览器登录分区使用内存。
function configureBrowserStorage(app, platform = process.platform) {
  if (platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  if (platform === 'linux') app.commandLine.appendSwitch('password-store', 'basic');
}
module.exports = { configureBrowserStorage };
