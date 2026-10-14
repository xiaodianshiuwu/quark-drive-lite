'use strict';
const { execFileSync } = require('node:child_process');

// Documents 等目录中的 Finder 元数据会被复制进应用包并使 codesign 拒绝签名。
// 只清理新生成的 macOS 构建目录；不改动源码、安装运行时或用户文件。
module.exports = async ({ electronPlatformName, appOutDir }) => {
  if (electronPlatformName === 'darwin') {
    execFileSync('/usr/bin/xattr', ['-cr', appOutDir]);
  }
};
