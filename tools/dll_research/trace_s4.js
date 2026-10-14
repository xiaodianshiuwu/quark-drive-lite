'use strict';
/** 完整复现稳定测试流程：启动→注入→刷新→逐秒观察隐藏状态（找失效时间点） */
const { spawn } = require('child_process');
const QUARK='C:\\Users\\USER\\AppData\\Local\\Programs\\Quark\\quark.exe';
const PORT=9777;
const HIDE_SCRIPT=`(function(){if(window.__qkMiniHide)return;window.__qkMiniHide=true;var IDS=["nav-item-备份","nav-item-快传","nav-item-工具"];function hide(){try{IDS.forEach(function(id){var el=document.getElementById(id);if(el&&el.style)el.style.display='none';});}catch(e){}}hide();new MutationObserver(hide).observe(document.documentElement,{childList:true,subtree:true});setInterval(hide,1000);})();`;
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();}
static async connect(url){const ws=new WebSocket(url);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'));});const c=new CDP(ws);ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id!==undefined){const p=c.pending.get(m.id);if(p){c.pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}}};return c;}
send(m,p={}){const id=++this.id;this.ws.send(JSON.stringify({id,method:m,params:p}));return new Promise((res,rej)=>this.pending.set(id,{res,rej}));}
async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true});return r.result&&r.result.value;}
close(){try{this.ws.close();}catch{}}}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function findMain(){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const l=await r.json();return l.find(t=>t.type==='page'&&/index\.html\?name=main/.test(t.url))||null;}catch{return null;}}
function stat(){try{const c=Number(require('child_process').execSync('powershell -NoProfile -Command "(Get-Process quark -ErrorAction SilentlyContinue).Count"',{encoding:'utf8'}).trim())||0;return c;}catch{return 0;}}
(async()=>{
  try{require('child_process').execSync('powershell -NoProfile -Command "Get-Process quark -ErrorAction SilentlyContinue|Stop-Process -Force"');}catch{}
  await sleep(3000);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const args=['--remote-debugging-port='+PORT,'--no-first-run','--no-default-browser-check','--disable-apollo','--disable-quantum-node','--no-node','--disable-background-networking','--disable-component-update','--no-pings'];
  const child=spawn(QUARK,args,{env,stdio:'ignore'});
  let mp=null;
  for(let i=0;i<60;i++){mp=await findMain();if(mp)break;await sleep(500);}
  if(!mp){console.log('无主窗口');process.exit(1);}
  console.log('主窗口出现');
  let c=await CDP.connect(mp.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument',{source:HIDE_SCRIPT});
  await c.send('Runtime.enable');
  await c.eval(HIDE_SCRIPT);
  await sleep(3000);
  let s=await c.eval(`JSON.stringify(['nav-item-备份','nav-item-快传','nav-item-工具'].map(id=>{var e=document.getElementById(id);return e?e.style.display:'无元素';}))`);
  console.log('注入后隐藏状态:',s);
  console.log('\n--- 执行 Page.reload ---');
  await c.send('Page.reload',{ignoreCache:false});
  // 逐秒观察 15 秒
  for(let i=1;i<=15;i++){
    await sleep(1000);
    // 每秒重连（reload 后 ws 会断）
    let ok=false, marker=null, disp=null;
    try{
      const mp2=await findMain();
      if(mp2){
        const c2=await CDP.connect(mp2.webSocketDebuggerUrl);
        const r=await c2.eval(`(()=>{var m=!!window.__qkMiniHide;var e=document.getElementById('nav-item-备份');return JSON.stringify({m:m,d:e?e.style.display:'无元素'});})()`);
        const j=JSON.parse(r);
        marker=j.m; disp=j.d; ok=true;
        // 若标记在但没隐藏且已过 5 秒，重注入（模拟启动器兜底）
        if(i>5&&marker&&disp!=='none'){
          await c2.eval(HIDE_SCRIPT);
        }
        c2.close();
      }
    }catch(e){}
    console.log(`  T+${i}s  连接:${ok?'ok':'断'}  标记:${marker}  备份项display:${disp}`);
  }
  try{child.kill();}catch{}
  try{require('child_process').execSync('powershell -NoProfile -Command "Get-Process quark -ErrorAction SilentlyContinue|Stop-Process -Force"');}catch{}
  process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
