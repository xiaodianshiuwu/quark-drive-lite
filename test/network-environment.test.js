'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const net=require('node:net');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {configureChromiumSession}=require('../src/main/core/network-environment');

test('Chromium 默认会话和登录分区分别配置环境代理，并复用就绪结果',async()=>{
  const calls=[];
  const session={setProxy:async config=>calls.push(config)};
  const env={HTTPS_PROXY:'http://proxy.example.test:8080',NO_PROXY:'localhost,127.0.0.1'};
  await Promise.all([configureChromiumSession(session,env),configureChromiumSession(session,env)]);
  assert.deepEqual(calls,[{proxyRules:env.HTTPS_PROXY,proxyBypassRules:'localhost;127.0.0.1'}]);
  const login={setProxy:async config=>calls.push(config)};
  await configureChromiumSession(login,env);assert.equal(calls.length,2);
});

test('原生 fetch 经环境代理传输，NO_PROXY 保留本地连接，CDN 请求不泄漏 Cookie', async t => {
  const requests=[];
  const server=http.createServer((req,res)=>{ requests.push({url:req.url,headers:req.headers}); res.end('代理测试'); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const port=server.address().port;
  const tunnels=[];
  const proxy=http.createServer();
  const sockets=new Set();
  proxy.on('connect',(req,socket,head)=>{
    tunnels.push(req.url);
    const upstream=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
    sockets.add(socket);sockets.add(upstream);
    socket.on('close',()=>{sockets.delete(socket);upstream.destroy();});
    upstream.on('close',()=>sockets.delete(upstream));
    upstream.on('error',()=>socket.destroy());
    socket.on('error',()=>upstream.destroy());
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();proxy.closeAllConnections();proxy.close();});
  const proxyPort=proxy.address().port;
  const code=`const {HttpClient}=require(${JSON.stringify(path.resolve(__dirname,'../src/main/core/http'))});
    (async()=>{const c=new HttpClient({getCookie:()=> '测试凭据',timeout:3000,retries:0});
      const a=await c.request({path:'http://cdn.example.test/data',absolute:true,direct:true,cookies:false,raw:true});await a.text();
      const b=await fetch('http://127.0.0.1:${port}/local');await b.text();})().catch(()=>process.exitCode=1);`;
  const env={...process.env,HTTP_PROXY:`http://127.0.0.1:${proxyPort}`,HTTPS_PROXY:`http://127.0.0.1:${proxyPort}`,NO_PROXY:'127.0.0.1'};
  for(const key of ['http_proxy','https_proxy','no_proxy'])delete env[key];
  const child=spawn(process.execPath,['-e',code],{env,stdio:'ignore'});
  const timer=setTimeout(()=>child.kill(),8000);
  const result=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timer);
  assert.equal(result,0);
  assert.deepEqual(tunnels,['cdn.example.test:80']);
  assert.equal(requests[0].url,'/data');
  assert.equal(requests[0].headers.cookie,undefined);
  assert.equal(requests[1].url,'/local');
});
