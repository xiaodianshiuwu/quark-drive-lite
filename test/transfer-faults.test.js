'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {HttpClient}=require('../src/main/core/http');
const {downloadFile,safeFileName,TEMP_SUFFIX,CFG_SUFFIX}=require('../src/main/core/download');

async function fixture(t,handler){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qck-fault-'));
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  return {dir,base,http:new HttpClient({retries:0}),api:{downloadUrl:async()=>[{fid:'f',url:base+'/file'}]}};
}

test('中文与 emoji 长文件名按 UTF-8 字节裁剪，保留扩展名且不切断字符',()=>{
  for(const name of ['中文'.repeat(100)+'.bin','😀'.repeat(100)+'.txt']){
    const safe=safeFileName(name);assert.ok(Buffer.byteLength(safe,'utf8')<=180);assert.ok(!safe.includes('\ufffd'));assert.equal(path.extname(safe),path.extname(name));
  }
});

test('零字节文件的 Range 探测返回 416，仍通过完整 GET 正确保存空文件',async t=>{
  const f=await fixture(t,(req,res)=>{if(req.headers.range){res.writeHead(416,{'content-range':'bytes */0'});res.end();}else{res.writeHead(200,{'content-length':0});res.end();}});
  const result=await downloadFile({...f,fid:'f',fileName:'空文件.bin',localDir:f.dir,size:0,maxRetries:0});
  assert.equal(result.bytes,0);assert.equal(fs.statSync(result.localPath).size,0);
});
test('声明为空的文件返回非空内容时，不生成成功文件',async t=>{
  const f=await fixture(t,(req,res)=>{if(req.headers.range){res.writeHead(416);res.end();}else{res.end('意外内容');}});
  await assert.rejects(()=>downloadFile({...f,fid:'f',fileName:'空文件.bin',localDir:f.dir,size:0,maxRetries:0}),/超出文件大小/);
  assert.equal(fs.existsSync(path.join(f.dir,'空文件.bin')),false);
});
test('单流未知长度提前结束仍按已知大小检测，不把截断内容当成功',async t=>{
  const f=await fixture(t,(req,res)=>{res.writeHead(200);res.end('short');});
  await assert.rejects(()=>downloadFile({...f,fid:'f',fileName:'截断.bin',localDir:f.dir,size:100,maxRetries:0}),/下载未完成/);
  assert.equal(fs.existsSync(path.join(f.dir,'截断.bin')),false);
});
test('下载收到 HTTP 错误时，不将错误页面保存为文件',async t=>{
  const f=await fixture(t,(_,res)=>{res.writeHead(404);res.end('错误页面');});
  await assert.rejects(()=>downloadFile({...f,fid:'f',fileName:'错误.bin',localDir:f.dir,maxRetries:0}),e=>e.httpStatus===404);
  assert.equal(fs.existsSync(path.join(f.dir,'错误.bin')),false);
});

test('大于 4 GiB 的下载续传使用正确的 64 位文件偏移，尾部字节一致',async t=>{
  const total=5*1024**3+13,tail=Buffer.from('跨越四GiB后的尾部内容'),start=total-tail.length;
  const ranges=[];
  const f=await fixture(t,(req,res)=>{
    ranges.push(req.headers.range);
    if(req.headers.range==='bytes=0-0'){res.writeHead(206,{'content-range':`bytes 0-0/${total}`,'content-length':1});res.end(Buffer.alloc(1));}
    else{res.writeHead(206,{'content-range':`bytes ${start}-${total-1}/${total}`,'content-length':tail.length});res.end(tail);}
  });
  const temporary=path.join(f.dir,'大文件.bin')+TEMP_SUFFIX;
  const fd=fs.openSync(temporary,'w');fs.ftruncateSync(fd,start);fs.closeSync(fd);
  fs.writeFileSync(temporary+CFG_SUFFIX,JSON.stringify({fid:'f',total,received:start,mode:'single'}));
  const result=await downloadFile({...f,fid:'f',fileName:'大文件.bin',localDir:f.dir,size:total,multipartThreshold:Infinity,maxRetries:0});
  assert.equal(result.bytes,total);assert.equal(result.resumed,true);assert.ok(ranges.includes(`bytes=${start}-`));
  const read=Buffer.alloc(tail.length),saved=fs.openSync(result.localPath,'r');fs.readSync(saved,read,0,read.length,start);fs.closeSync(saved);
  assert.deepEqual(read,tail);assert.equal(fs.statSync(result.localPath).size,total);
});
