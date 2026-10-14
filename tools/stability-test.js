'use strict';
/**
 * 方案 B（原生精简版）稳定性专项测试。
 *
 * 覆盖场景：
 *   S1 冷启动   —— 全新启动，主窗口出现，隐藏注入成功
 *   S2 隐藏持久 —— 运行 30 秒内隐藏状态持续（对抗官方懒加载/重渲染）
 *   S3 页面导航 —— 切换到传输页再回主页，隐藏仍生效
 *   S4 刷新恢复 —— 模拟页面重载（Page.reload），注入脚本自动重放
 *   S5 稳定运行 —— 持续运行 90 秒无崩溃、内存无异常增长
 *
 * 通过标准：全部场景通过，且进程/内存与基线一致。
 *
 * 用法：node tools/stability-test.js [--full]
 *   默认只跑 S1/S2/S4（约 60 秒）；--full 加上 S3/S5（约 3 分钟）
 */
const { spawn } = require('child_process');

const QUARK = process.env.QUARK_EXE
  || 'C:\\Users\\USER\\AppData\\Local\\Programs\\Quark\\quark.exe';
const PORT = 9777;
const HIDE_ITEMS = ['备份', '快传', '工具'];
const KEEP_IDS = ['nav-item-首页', 'nav-item-传输'];
const FULL = process.argv.includes('--full');

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
})();
`;

class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();}
  static async connect(url){
    const ws=new WebSocket(url);
    await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'));});
    const c=new CDP(ws);
    ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id!==undefined){const p=c.pending.get(m.id);if(p){c.pending.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}}};
    return c;
  }
  send(m,p={}){const id=++this.id;this.ws.send(JSON.stringify({id,method:m,params:p}));return new Promise((res,rej)=>this.pending.set(id,{res,rej}));}
  async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:false});return r.result&&r.result.value;}
  close(){try{this.ws.close();}catch{}}
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

let pass=0, fail=0;
const failures=[];
function ok(n,d){pass++;console.log('  \x1b[32m✓\x1b[0m '+n+(d?'  \x1b[90m'+d+'\x1b[0m':''));}
function bad(n,d){fail++;failures.push({n,d});console.log('  \x1b[31m✗\x1b[0m '+n+(d?'\n      '+d:''));}
const expect=(c,n,d)=>(c?ok(n,d):bad(n,d));

let ownedChild=null;
function stopOwned(){
  if(!ownedChild)return;
  try{require('child_process').execFileSync('taskkill',['/PID',String(ownedChild.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
}

async function findMain(){
  try{
    const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list=await r.json();
    // 主窗口 URL: uccd://cloud.quark/clouddrive/renderer/index.html?name=main#/list/all
    // 注意必须匹配 index.html?name=main（此前漏了 .html 导致匹配失败）
    return list.find(t=>t.type==='page'&&/clouddrive\/renderer\/index\.html\?name=main/.test(t.url))||null;
  }catch{return null;}
}

/** 检查隐藏状态：返回 {hidden:[...成功隐藏的id], kept:[...可见的保留项]} */
async function checkHidden(cdp){
  return cdp.eval(`(()=>{
    var ids=${JSON.stringify(HIDE_ITEMS.map(n=>'nav-item-'+n))};
    var keep=${JSON.stringify(KEEP_IDS)};
    function vis(id){var e=document.getElementById(id);return e&&e.offsetParent!==null&&e.style.display!=='none';}
    return {
      hidden: ids.filter(function(id){return !vis(id);}),
      keptMissing: keep.filter(function(id){return !vis(id);})
    };
  })()`);
}

/** 进程与内存 */
function procStat(){
  try{
    const {execSync}=require('child_process');
    const c=Number(execSync('powershell -NoProfile -Command "(Get-Process quark -ErrorAction SilentlyContinue).Count"',{encoding:'utf8'}).trim())||0;
    const raw=execSync('powershell -NoProfile -Command "$p=Get-Process quark -ErrorAction SilentlyContinue; if($p){$p|Measure-Object WorkingSet64 -Sum|Select-Object -ExpandProperty Sum}"',{encoding:'utf8'}).trim();
    return {count:c, memMB:Math.round(Number(raw)/1024/1024)};
  }catch{return {count:0,memMB:0};}
}

(async()=>{
  console.log('\x1b[1m=== 方案 B 原生精简版 · 稳定性专项测试 ===\x1b[0m');
  console.log('场景: S1 冷启动 / S2 隐藏持久 / S3 导航往返 / S4 刷新恢复 / S5 稳定运行\n');

  // ---- 启动（与 quark-mini-native.js 相同的参数）----
  if(procStat().count>0)throw new Error('官方客户端正在运行，请先自行关闭再执行稳定性测试；测试不会强杀现有进程');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const args=[
    `--remote-debugging-port=${PORT}`,
    '--no-first-run','--no-default-browser-check',
    '--disable-apollo','--disable-apollo-web-audio',
    '--disable-apollo-memorybuffer-video-output','--disable-apollo-qmni-asr-provider',
    '--disable-quantum-node','--no-node',
    '--disable-background-networking','--disable-component-update','--no-pings',
  ];
  console.log('启动官方客户端（C2 精简参数）...');
  const child=spawn(QUARK,args,{env,stdio:'ignore'});
  ownedChild=child;
  child.on('error',e=>{console.error('官方客户端启动失败:',e.message);stopOwned();process.exit(1);});

  // ---- S1 冷启动 ----
  console.log('\n[S1 冷启动]');
  let mainPage=null;
  for(let i=0;i<80;i++){
    mainPage=await findMain();
    if(mainPage)break;
    await sleep(500);
  }
  expect(!!mainPage,'S1.1 主窗口出现（文件管理页）');
  if(!mainPage){ console.log('主窗口未出现，终止'); process.exit(1); }

  let cdp=await CDP.connect(mainPage.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:HIDE_SCRIPT});
  await cdp.send('Runtime.enable');
  await cdp.eval(HIDE_SCRIPT);
  await sleep(2500);
  let st=await checkHidden(cdp);
  expect(st.hidden.length===HIDE_ITEMS.length,'S1.2 三项无用导航已隐藏',JSON.stringify(st.hidden));
  expect(st.keptMissing.length===0,'S1.3 首页/传输保留可见',JSON.stringify(st.keptMissing));

  // ---- S2 隐藏持久（30 秒采样）----
  console.log('\n[S2 隐藏持久性（30 秒）]');
  let persistOk=true;
  const samples=[];
  for(let i=0;i<6;i++){
    await sleep(5000);
    st=await checkHidden(cdp);
    samples.push(st.hidden.length+'/'+st.keptMissing.length);
    if(st.hidden.length!==HIDE_ITEMS.length||st.keptMissing.length!==0){persistOk=false;break;}
  }
  expect(persistOk,'S2.1 30 秒内隐藏状态稳定',`采样(隐藏/缺失): ${samples.join(' ')}`);

  // ---- S3 导航往返（切到传输页再回来）----
  if(FULL){
    console.log('\n[S3 导航往返]');
    // 点击“传输”导航
    await cdp.eval(`(()=>{var e=document.getElementById('nav-item-传输');if(e)e.click();})()`);
    await sleep(3000);
    // 回主页
    await cdp.eval(`(()=>{var e=document.getElementById('nav-item-首页');if(e)e.click();})()`);
    await sleep(3000);
    st=await checkHidden(cdp);
    expect(st.hidden.length===HIDE_ITEMS.length,'S3.1 导航往返后隐藏仍生效',JSON.stringify(st.hidden));
    expect(st.keptMissing.length===0,'S3.2 首页/传输仍可用');
  } else {
    console.log('\n[S3 跳过（未加 --full）]');
  }

  // ---- S4 刷新恢复 ----
  console.log('\n[S4 刷新恢复]');
  await cdp.send('Page.reload',{ignoreCache:false});
  await sleep(6000);
  let mp2=await findMain();
  expect(!!mp2,'S4.1 刷新后主窗口仍在');
  if(mp2){
    let c2=await CDP.connect(mp2.webSocketDebuggerUrl);
    await c2.send('Page.enable');
    await c2.send('Runtime.enable');
    // 模拟精简启动器的保障逻辑：无条件重注入（新脚本幂等：hide 无条件执行、interval 防重复）
    await c2.send('Page.addScriptToEvaluateOnNewDocument',{source:HIDE_SCRIPT});
    await c2.eval(HIDE_SCRIPT);
    expect(true,'S4.2 已重注入隐藏脚本');
    // 等启动器兜底（4 秒周期）+ React 重渲染完成，再给 MutationObserver 生效时间
    await sleep(8000);
    st=await checkHidden(c2);
    expect(st.hidden.length===HIDE_ITEMS.length,'S4.3 刷新后隐藏自动恢复',JSON.stringify(st.hidden));
    expect(st.keptMissing.length===0,'S4.4 首页/传输刷新后仍可见');
    cdp.close();cdp=c2;
  }

  // ---- S5 稳定运行 ----
  if(FULL){
    console.log('\n[S5 稳定运行 90 秒]');
    const base=procStat();
    console.log('  基线: '+base.count+' 进程 / '+base.memMB+' MB');
    let crashed=false;
    for(let i=0;i<9;i++){
      await sleep(10000);
      const s=procStat();
      if(s.count===0){crashed=true;break;}
      if(i===3||i===6)console.log('  …运行中 '+s.count+' 进程 / '+s.memMB+' MB');
    }
    expect(!crashed,'S5.1 持续运行 90 秒无崩溃');
    const final=procStat();
    const growth=final.memMB-base.memMB;
    expect(growth<150,'S5.2 内存无明显泄漏','增长 '+growth+' MB（基线 '+base.memMB+' → 终态 '+final.memMB+'）');
    // 最终隐藏状态复查
    st=await checkHidden(cdp);
    expect(st.hidden.length===HIDE_ITEMS.length,'S5.3 长时间运行后隐藏仍生效');
  } else {
    console.log('\n[S5 跳过（未加 --full）]');
  }

  // ---- 汇总 ----
  const fin=procStat();
  console.log('\n\x1b[1m=== 稳定性结果：'+pass+' 通过 / '+fail+' 失败 ===\x1b[0m');
  console.log('  终态: '+fin.count+' 进程 / '+fin.memMB+' MB');
  if(fail){failures.forEach(f=>console.log('  · '+f.n+(f.d?': '+f.d:'')));}

  try{cdp.close();}catch{}
  stopOwned();
  process.exit(fail?1:0);
})().catch(e=>{console.error('测试异常:',e.message);stopOwned();process.exit(1);});
