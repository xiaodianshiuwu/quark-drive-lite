'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
test('Electron 升级后 UA 使用实际 Chromium 版本并保留已取证协议后缀',()=>{
  const directory=path.join(__dirname,'../src/main/core');
  const context={module:{exports:{}},process:{versions:{chrome:'151.0.1234.5'}},
    require:name=>require(name.startsWith('./')?path.join(directory,name):name)};
  vm.runInNewContext(fs.readFileSync(path.join(directory,'http.js'),'utf8'),context);
  const ua=context.module.exports.DEFAULT_UA;
  assert.match(ua,/Chrome\/151\.0\.1234\.5/);
  assert.match(ua,/QuarkPC\/4\.1\.5\.397 quark-cloud-drive\/2\.5\.40 Channel\/pckk_other_ch$/);
});
