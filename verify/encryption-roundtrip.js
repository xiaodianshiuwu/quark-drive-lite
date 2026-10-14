'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {resolveElectron,electronEnvironment,createElectronHostApp}=require('../src/main/core/platform');
const root=path.join(__dirname,'..');
const current=resolveElectron(root);
const legacy=process.env.QCK_LEGACY_ELECTRON || (process.argv.includes('--legacy') ? JSON.parse(fs.readFileSync(path.join(root,'.work','legacy-runtime.json'),'utf8')).executable : undefined);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qck-storage-check-'));
const host=createElectronHostApp(path.join(__dirname,'storage-fixture.js'));
const timeoutMs=Math.min(300000,Math.max(30000,Number(process.env.QCK_STORAGE_TIMEOUT_MS)||30000));
function run(executable,action){
  const env={...electronEnvironment(),QCK_STORAGE_TEST_DIR:directory,QCK_STORAGE_TEST_ACTION:action,...(legacy&&action==='write'?{QCK_STORAGE_TEST_BACKEND:'system'}:{})};
  const result=spawnSync(executable,[host.directory],{env,encoding:'utf8',timeout:timeoutMs,killSignal:'SIGKILL'});
  if(result.status!==0) {
    if(result.stderr)process.stderr.write(result.stderr);
    throw Error(`系统密钥环或加密兼容验证失败：${action}${result.error?.code==='ETIMEDOUT'?'（超时）':''}`);
  }
  return JSON.parse(result.stdout);
}
try{
  if(!current)throw Error('未安装 Electron');
  const written=run(legacy||current,'write');
  // 旧系统密文先通过显式迁移入口转为本地密钥格式，正常应用不再触碰系统密钥环。
  if(legacy)require('../src/main/core/secure-store').createSecureStore({userDataDir:directory,migrationRuntime:legacy}).snapshot();
  const read=run(current,'read');
  console.log(JSON.stringify({encrypted:true,source:written.electron,target:read.electron,legacyMigrationTested:!!legacy}));
}catch(error){console.error(error.message);process.exitCode=1;}
finally{host.cleanup();fs.rmSync(directory,{recursive:true,force:true});}
