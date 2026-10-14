'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
let checked=0;
function walk(directory) {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())walk(file);
    else if(/\.(?:js|cjs|mjs)$/.test(entry.name)) {
      const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
      if(result.status!==0)process.exit(result.status||1);
      checked++;
    }
  }
}
for(const folder of ['src','scripts','test','verify','tools'])walk(path.join(root,folder));
for(const file of ['package.json','builder.config.json'])JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const base=path.dirname(require.resolve('app-builder-lib',{paths:[path.dirname(require.resolve('electron-builder'))]}));
require(path.join(base,'util/config/config.js')).validateConfiguration(require('../builder.config.json'),{isEnabled:false})
  .then(()=>console.log(`语法检查通过：${checked} 个 JavaScript 文件；JSON 与打包配置有效。`))
  .catch(error=>{console.error(error.message);process.exitCode=1;});
