'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
let executable=process.env.QCK_PACKAGED_EXECUTABLE;
if(executable){}
else if(process.platform==='win32')executable=path.join(root,'dist/win-unpacked/夸克网盘极简版.exe');
else if(process.platform==='linux')executable=path.join(root,'dist/linux-unpacked/quark-mini');
else{
  const manifest=path.join(root,'.work','macos-build.json');
  if(fs.existsSync(manifest))executable=JSON.parse(fs.readFileSync(manifest,'utf8')).executable;
  else{
  const directory=path.join(root,'dist',process.arch==='arm64'?'mac-arm64':'mac');
  const app=fs.readdirSync(directory).find(name=>name.endsWith('.app'));
  if(!app)throw Error('未找到 macOS 应用包');
  const binaries=path.join(directory,app,'Contents/MacOS');
  executable=path.join(binaries,fs.readdirSync(binaries).find(name=>fs.statSync(path.join(binaries,name)).isFile()));
  }
}
if(!fs.existsSync(executable))throw Error('未找到当前平台构建产物');
const result=spawnSync(process.execPath,[path.join(__dirname,'smoke-electron.js')],{
  env:{...process.env,QCK_SMOKE_EXECUTABLE:executable,QCK_SMOKE_PORT:'9780'},stdio:'inherit',timeout:Math.max(90000,(Number(process.env.QCK_SMOKE_TIMEOUT_MS)||30000)+60000),
});
process.exitCode=result.status===0?0:1;
