'use strict';
// 旧运行时仅用于生成加密兼容样本，绝不进入产品构建或访问账号接口。
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
process.env.ELECTRON_GET_USE_PROXY='1';
process.env.GLOBAL_AGENT_HTTP_PROXY=process.env.HTTP_PROXY||process.env.http_proxy||'';
process.env.GLOBAL_AGENT_HTTPS_PROXY=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.GLOBAL_AGENT_HTTP_PROXY;
const packageDirectory=path.dirname(require.resolve('electron/package.json'));
const {downloadArtifact}=require(require.resolve('@electron/get',{paths:[packageDirectory]}));
const {extract}=require(require.resolve('@electron-internal/extract-zip',{paths:[packageDirectory]}));
const {electronRelativePath}=require('../src/main/core/platform');
(async()=>{
  const directory=path.join(root,'.work',`legacy-electron-33.4.11-${process.platform}-${process.arch}`);
  const executable=path.join(directory,electronRelativePath());
  if(!fs.existsSync(executable)){
    const zip=await downloadArtifact({version:'33.4.11',artifactName:'electron',platform:process.platform,arch:process.arch});
    await extract(zip,{dir:directory});
  }
  if(fs.readFileSync(path.join(directory,'version'),'utf8').trim().replace(/^v/,'')!=='33.4.11')throw Error('旧版验收运行时版本不一致');
  // 仅临时 CI 的旧样本生成器重签为 ad-hoc；避免旧签名身份触发系统授权弹窗。
  // 下载时的官方 SHA256 校验仍先执行；该目录不进入产品构建。
  if(process.platform==='darwin'&&process.env.CI==='true'&&process.env.RUNNER_TEMP){
    const result=require('node:child_process').spawnSync('codesign',['--force','--deep','--sign','-',path.join(directory,'Electron.app')],{encoding:'utf8',timeout:60000,killSignal:'SIGKILL'});
    if(result.status!==0)throw Error('旧版验收运行时的本地 ad-hoc 签名失败');
    console.log('已为 macOS 临时旧样本生成器设置 ad-hoc 签名。');
  }
  fs.mkdirSync(path.join(root,'.work'),{recursive:true});
  fs.writeFileSync(path.join(root,'.work','legacy-runtime.json'),JSON.stringify({executable}));
  console.log('已准备独立的 Electron 33.4.11 加密兼容验收运行时。');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
