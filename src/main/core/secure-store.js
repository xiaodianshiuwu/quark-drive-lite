'use strict';
// 默认使用免系统密码的本地随机密钥；系统加密仅用于显式旧格式迁移及兼容验收。
const { createLocalStore } = require('./local-store');
function createSystemSecureStore(options) { return require('./system-store').createSecureStore(options); }
function createSecureStore(options = {}) {
  if (options.storageBackend === 'system' || options.safeStorage) return createSystemSecureStore(options);
  let migrateLegacy = options.migrateLegacy;
  if (!migrateLegacy && !process.versions.electron) {
    migrateLegacy = () => createSystemSecureStore({ ...options, requireEncryption: true, strictRead: true }).snapshot();
  }
  return createLocalStore({ ...options, migrateLegacy });
}
function isEncryptionAvailable(safeStorage) {
  return safeStorage ? require('./system-store').isEncryptionAvailable(safeStorage) : true;
}
module.exports = { createSecureStore, createSystemSecureStore, isEncryptionAvailable };
