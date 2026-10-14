'use strict';
/**
 * 夸克网盘原生精简版（复用官方客户端 + 隐藏无用功能 + 后台减负提速）
 *
 * 目标：体验与官方完全一致（文件管理/搜索/上传/下载/传输 = 官方原生实现），
 *       但 ① 侧边栏只留「首页/传输」，隐藏「备份/快传/工具」等无用项；
 *           ② 用启动参数禁用 GPU 加速、P2P 加速、AI 等后台组件，减少进程与内存。
 *
 * 请求行为：全部为官方原生代码发出的请求，使用官方网络栈；不能保证风控结果。
 * 不修改官方任何文件（已验证官方无 asar 完整性校验，但本方案连文件都不动，最稳）。
 *
 * 用法：node tools/quark-mini-native.js
 */
const { spawn } = require('child_process');

const QUARK_EXE = process.env.QUARK_EXE
  || 'C:\\Users\\USER\\AppData\\Local\\Programs\\Quark\\quark.exe';
const PORT = 9777;
const HIDE_ITEMS = ['备份', '快传', '工具'];

// 隐藏脚本：按官方导航项的 id（nav-item-<名>）精确隐藏。
// ⚠️ 不能用「window.__qkMiniHide 存在即 return」的幂等短路：
//    实测 Page.reload 后新文档复用上下文时该标记残留为 true，
//    会导致 hide()/MutationObserver/setInterval 全部跳过 → 隐藏失效（稳定性测试 S4 曾暴露）。
//    正确做法：hide() 无条件执行；用挂载在 window 上的函数引用防止 interval 重复堆积。
const HIDE_SCRIPT = `
(function(){
  var IDS=${JSON.stringify(HIDE_ITEMS.map(n=>'nav-item-'+n))};
  function hide(){
    try{
      IDS.forEach(function(id){
        var el=document.getElementById(id);
        if(el&&el.style)el.style.display='none';
      });
    }catch(e){}
  }
  try{
    if(window.__qkMiniHideInterval){clearInterval(window.__qkMiniHideInterval);}
    window.__qkMiniHideInterval=setInterval(hide,1000);
    if(window.__qkMiniHideObserver&&window.__qkMiniHideObserver.disconnect){window.__qkMiniHideObserver.disconnect();}
    window.__qkMiniHideObserver=new MutationObserver(hide);
    window.__qkMiniHideObserver.observe(document.documentElement,{childList:true,subtree:true});
  }catch(e){}
  hide();
  window.__qkMiniHide=true;
})();
`;

class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();}
  static async connect(url){const ws=new WebSocket(url);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'));});const c=new CDP(ws);ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id!==undefined){const p=c.pending.get(m.id);if(p){c.pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}}};return c;}
  send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{
    const timer=setTimeout(()=>{this.pending.delete(id);rej(new Error('调试接口请求超时'));},8000);
    this.pending.set(id,{res:r=>{clearTimeout(timer);res(r);},rej:e=>{clearTimeout(timer);rej(e);}});
    try{this.ws.send(JSON.stringify({id,method:m,params:p}));}catch(e){clearTimeout(timer);this.pending.delete(id);rej(e);}
  });}
  async eval(expr){const r=await this.send('Runtime.evaluate',{expression:expr,returnByValue:true});return r.result&&r.result.value;}
  close(){try{this.ws.close();}catch{}}
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function findMainWindow(){
  const r=await fetch(`http://127.0.0.1:${PORT}/json/list`,{signal:AbortSignal.timeout(2500)});
  const list=await r.json();
  return list.find(t=>t.type==='page'&&/clouddrive\/renderer\/index\.html\?name=main/.test(t.url));
}

(async()=>{
  console.log('\x1b[1m=== 夸克网盘原生精简版 ===\x1b[0m');
  console.log('复用官方客户端（原生代码，使用官方网络实现）');
  console.log('精简：隐藏侧边栏 [备份/快传/工具]，仅保留 [首页/传输]\n');

  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;

  // 启动官方客户端：使用 DLL 逆向取证得到的官方内部开关
  // （实测：播放器进程消失、量子进程少一个，内存 1875→1341MB，-28%）
  const args=[
    `--remote-debugging-port=${PORT}`,
    '--no-first-run','--no-default-browser-check',
    // —— 官方内部禁用开关（从 quark.dll .rdata 取证）——
    '--disable-apollo',                                // 播放器 Apollo（-32MB 进程）
    '--disable-apollo-web-audio',
    '--disable-apollo-memorybuffer-video-output',
    '--disable-apollo-qmni-asr-provider',
    '--disable-quantum-node','--no-node',              // 量子桥第二实例（-135MB 进程）
    // —— 标准减负 ——
    '--disable-background-networking',
    '--disable-component-update',
    '--no-pings',
  ];
  const child=spawn(QUARK_EXE,args,{env,stdio:'ignore'});
  child.on('error',e=>{console.error('官方客户端启动失败:',e.message);process.exit(1);});
  console.log('已启动官方客户端（带减负参数）');

  // 等主窗口
  let page=null;
  for(let i=0;i<80;i++){
    page=await findMainWindow().catch(()=>null);
    if(page)break;
    await sleep(500);
  }
  if(!page){console.error('未找到主窗口');process.exit(1);}
  console.log('主窗口已就绪');

  // 注入隐藏脚本（当前 + 后续新文档）
  try{
    const cdp=await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:HIDE_SCRIPT});
    await cdp.send('Runtime.enable');
    await cdp.eval(HIDE_SCRIPT);
    cdp.close();
    console.log('已注入精简脚本（隐藏无用项）');
  }catch(e){
    console.error('注入失败:',e.message);
  }

  await sleep(2500);

  // 验证隐藏结果
  let remaining=null;
  try{
    const cdp2=await CDP.connect(page.webSocketDebuggerUrl);
    remaining=await cdp2.eval(`(()=>{
      var ids=${JSON.stringify(HIDE_ITEMS.map(n=>'nav-item-'+n))};
      var keep=${JSON.stringify(['nav-item-首页','nav-item-传输'])};
      function visible(id){var e=document.getElementById(id);return e&&e.offsetParent!==null&&e.style.display!=='none';}
      return {
        hidden: ids.filter(function(id){return !!document.getElementById(id)&&!visible(id);}),
        kept: keep.filter(function(id){return visible(id);})
      };
    })()`);
    cdp2.close();
  }catch{}

  console.log('隐藏结果:',JSON.stringify(remaining));
  if(remaining){
    const okHide=remaining.hidden&&remaining.hidden.length===HIDE_ITEMS.length;
    const okKeep=remaining.kept&&remaining.kept.length===2;
    console.log(okHide&&okKeep
      ?'\x1b[32m✓ 精简成功：已隐藏 [备份/快传/工具]，保留 [首页/传输]\x1b[0m'
      :'\x1b[33m! 部分生效：hidden='+JSON.stringify(remaining.hidden)+' kept='+JSON.stringify(remaining.kept)+'\x1b[0m');
  }

  // 统计精简后进程/内存（MB）
  await sleep(3000);
  let total=0,memMB=0;
  try{
    const {execSync}=require('child_process');
    const ps=execSync('powershell -NoProfile -Command "Get-Process quark -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum"').toString().trim();
    memMB=Math.round(Number(ps)/1024/1024);
    total=Number(execSync('powershell -NoProfile -Command "(Get-Process quark -ErrorAction SilentlyContinue).Count"').toString().trim());
  }catch{}
  console.log(`\n精简后：quark 进程 ${total} 个，合计内存约 ${memMB} MB`);

  console.log('\n官方客户端现为「极简版」：文件管理 + 传输，体验一致、更轻快。');
  console.log('关闭窗口即退出。\n');

  process.on('SIGINT',()=>{try{child.kill();}catch{}process.exit(0);});
  child.on('exit',()=>process.exit(0));
  // 兜底：定期检查每个主窗口的隐藏标记，丢失（页面刷新/重渲染）则立即重注入。
  // 实测依据：Page.addScriptToEvaluateOnNewDocument 在 Page.reload 后可能不自动重放，
  // 稳定性测试 S4 曾暴露刷新后隐藏失效；此处"标记检测+重注入"是已验证的修复。
  const injectedTargets=new Set([page.id]);
  let checking=false;
  setInterval(async()=>{
    if(checking)return;
    checking=true;
    let c=null;
    try{
      const pg=await findMainWindow().catch(()=>null);
      if(!pg)return;
      c=await CDP.connect(pg.webSocketDebuggerUrl);
      await c.send('Runtime.enable');
      const marker=await c.eval(`!!window.__qkMiniHide&&${JSON.stringify(HIDE_ITEMS.map(n=>'nav-item-'+n))}.every(function(id){var e=document.getElementById(id);return !!e&&e.style.display==='none';})`);
      if(!marker){
        await c.send('Page.enable');
        if(!injectedTargets.has(pg.id)){
          await c.send('Page.addScriptToEvaluateOnNewDocument',{source:HIDE_SCRIPT});
          injectedTargets.add(pg.id);
        }
        await c.eval(HIDE_SCRIPT);
      }
      c.close();
    }catch{}finally{if(c)c.close();checking=false;}
  },4000);
})();
