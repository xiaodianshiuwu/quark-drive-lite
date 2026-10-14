'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {matchingFiles,confirmUpload}=require('../src/main/core/upload-confirmation');
const {uploadFile}=require('../src/main/core/upload');
const {ErrCode}=require('../src/main/core/errors');

const file={fid:'new',name:'测试.bin',size:12,updatedAt:100};
test('macOS 分解 Unicode 与服务端规范 Unicode 名称可匹配',async()=>{
  const module={list:async()=>({list:[{...file,name:'café.bin'}]})};
  assert.equal((await matchingFiles(module,{name:'cafe\u0301.bin'})).length,1);
});
test('上传核对遍历目录分页，仅匹配目标文件',async()=>{
  const pages=[];
  const module={list:async p=>{pages.push(p.page);return p.page===1?{list:[{...file,dir:true}],hasMore:true}:{list:[file],hasMore:false};}};
  assert.deepEqual(await matchingFiles(module,{pdirFid:'d',name:file.name}),[file]);
  assert.deepEqual(pages,[1,2]);
});
test('秒传接口成功但文件延迟出现时，等待可见后再完成',async()=>{
  let calls=0;
  const module={list:async()=>({list:++calls===1?[]:[file],hasMore:false})};
  assert.equal((await confirmUpload(module,{pdirFid:'d',result:file,baseline:[],timeout:1000,interval:5})).fid,'new');
  assert.equal(calls,2);
});
test('旧同名等长文件不会被当作上传成功，大小不符也不会通过',async()=>{
  for(const current of [[file],[{...file,fid:'other',size:1}]]) {
    await assert.rejects(()=>confirmUpload({list:async()=>({list:current})},{pdirFid:'d',result:file,baseline:[file],timeout:10,interval:2}), e=>e.code===ErrCode.TASK_FAILED);
  }
});
test('多个新增同名等长文件不猜测归属',async()=>{
  await assert.rejects(()=>confirmUpload({list:async()=>({list:[file,{...file,fid:'second'}]})},{pdirFid:'d',result:file,baseline:[]}),e=>e.code===ErrCode.CONFLICT);
});
test('上传核对取消及登录失效会立即传递',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>confirmUpload({list:async()=>({list:[]})},{result:file,baseline:[],signal:controller.signal}),e=>e.code===ErrCode.ABORTED);
  const error=Object.assign(new Error('登录失效'),{code:ErrCode.NEED_LOGIN});
  await assert.rejects(()=>confirmUpload({list:async()=>{throw error;}},{result:file,baseline:[]}),e=>e===error);
});
test('服务端提交后仅核对重试，不重复预登记、分片或 finish',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qck-commit-'));
  try {
    const localPath=path.join(directory,'空文件.bin');fs.writeFileSync(localPath,'');
    const counts={pre:0,finish:0};
    const api={uploadPre:async()=>{counts.pre++;return {taskId:'t',objKey:'key',partSize:65536,uploadId:'u'};},updateHash:async()=>false,uploadFinish:async()=>{counts.finish++;return {code:0};}};
    const checkpoint={};
    const first=await uploadFile({localPath,api,checkpoint});
    const second=await uploadFile({localPath,api,checkpoint});
    assert.equal(first.size,0);assert.deepEqual(second,first);assert.deepEqual(counts,{pre:1,finish:1});
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
