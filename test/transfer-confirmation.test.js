'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createTransferModule}=require('../src/main/modules/transfer');
const {ErrCode}=require('../src/main/core/errors');

function fixture(t,list){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qck-queue-confirm-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const localPath=path.join(directory,'空文件.bin');fs.writeFileSync(localPath,'');
  const calls=[];
  const queue=createTransferModule({fsModule:{list},http:{post:async endpoint=>{
    calls.push(endpoint);
    if(endpoint.endsWith('/upload/pre'))return {data:{task_id:'t',obj_key:'key',upload_id:'u'},metadata:{part_size:65536}};
    if(endpoint.endsWith('/update/hash'))return {data:{finish:false}};
    if(endpoint.endsWith('/upload/finish'))return {code:0};
    throw Error('意外接口调用：'+endpoint);
  }}});
  return {queue,localPath,calls,item:{fid:'new',name:'空文件.bin',size:0,dir:false,updatedAt:100}};
}
async function waitFor(queue,id,status){
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){
    const task=queue.list().find(task=>task.id===id);
    if(task?.status===status)return task;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('队列未进入预期状态：'+status);
}

test('队列在服务端收尾成功后仍等待目录核对，通过核对才进入 done',async t=>{
  let reads=0,resolveConfirmation,started;
  const confirmationStarted=new Promise(resolve=>{started=resolve;});
  const f=fixture(t,async()=>{
    if(++reads===1)return {list:[]};
    started();return new Promise(resolve=>{resolveConfirmation=resolve;});
  });
  const [id]=f.queue.upload({localPaths:[f.localPath],pdirFid:'target'});
  await confirmationStarted;
  assert.equal(f.queue.list()[0].status,'running');
  assert.equal(f.calls.filter(endpoint=>endpoint.endsWith('/upload/finish')).length,1);
  resolveConfirmation({list:[f.item]});
  const task=await waitFor(f.queue,id,'done');
  assert.equal(task.size,0);assert.equal(task.errorCode,undefined);
});

test('队列在结果核对断网后重试，仅核对目录，不重复预登记和 finish',async t=>{
  let reads=0;
  const f=fixture(t,async()=>{
    if(++reads===1)return {list:[]};
    if(reads===2)throw Object.assign(Error('目录核对暂时断网'),{code:ErrCode.NETWORK});
    return {list:[f.item]};
  });
  const [id]=f.queue.upload({localPaths:[f.localPath],pdirFid:'target'});
  assert.equal((await waitFor(f.queue,id,'error')).errorCode,ErrCode.NETWORK);
  const submittedCalls=[...f.calls];
  await f.queue.retry(id);
  await waitFor(f.queue,id,'done');
  assert.deepEqual(f.calls,submittedCalls);assert.equal(reads,3);
});
