'use strict';
/** 诊断 S4：刷新后隐藏脚本在页面里的真实状态 */
const PORT=9777;
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();}
static async connect(url){const ws=new WebSocket(url);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'));});const c=new CDP(ws);ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id!==undefined){const p=c.pending.get(m.id);if(p){c.pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}}};return c;}
send(m,p={}){const id=++this.id;this.ws.send(JSON.stringify({id,method:m,params:p}));return new Promise((res,rej)=>this.pending.set(id,{res,rej}));}
async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true});return r.result&&r.result.value;}
close(){try{this.ws.close();}catch{}}}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function findMain(){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const l=await r.json();return l.find(t=>t.type==='page'&&/index\.html\?name=main/.test(t.url))||null;}catch{return null;}}
(async()=>{
  const mp=await findMain();
  if(!mp){console.log('无主窗口');process.exit(1);}
  const c=await CDP.connect(mp.webSocketDebuggerUrl);
  const st=await c.eval(`(()=>{
    var out={marker:!!window.__qkMiniHide};
    var ids=['nav-item-备份','nav-item-快传','nav-item-工具','nav-item-首页','nav-item-传输'];
    out.items=ids.map(function(id){
      var e=document.getElementById(id);
      return {id:id, exists:!!e, display:e?e.style.display:'(无元素)', visible:e?!!e.offsetParent:false};
    });
    out.observerActive = typeof MutationObserver!=='undefined';
    return out;
  })()`);
  console.log(JSON.stringify(st,null,2));
  c.close();process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
