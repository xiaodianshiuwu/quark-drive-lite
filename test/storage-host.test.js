'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
async function run(safeStorage){
  let result,exited;
  const electron={app:{setName(){},setPath(){},whenReady:()=>Promise.resolve(),quit(){},exit(code){exited=code;}},safeStorage};
  const request={op:'decrypt',value:Buffer.from('测试密文').toString('base64'),userDataDir:'/tmp/test'};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main/core/storage-host.js'),'utf8'),{
    require:()=>electron,process:{platform:'win32',env:{QCK_STORAGE_REQUEST:Buffer.from(JSON.stringify(request)).toString('base64')},stdout:{write(text,done){result=JSON.parse(text);done();}}},Buffer,console:{error(){}}
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {result,exited};
}
test('旧格式辅助进程使用现代异步解密并读取 result 字段，避免同步阻塞',async()=>{
  const {result,exited}=await run({isAsyncEncryptionAvailable:async()=>true,decryptStringAsync:async()=>({result:'固定测试资料',shouldReEncrypt:false}),isEncryptionAvailable(){throw Error('不可调用同步后端');}});
  assert.equal(exited,undefined);assert.equal(result.value,'固定测试资料');
});
test('旧格式辅助进程拒绝无效异步解密结果，不输出错误内容',async()=>{
  const {result,exited}=await run({isAsyncEncryptionAvailable:async()=>true,decryptStringAsync:async()=>({result:null})});
  assert.equal(exited,1);assert.equal(result,undefined);
});
