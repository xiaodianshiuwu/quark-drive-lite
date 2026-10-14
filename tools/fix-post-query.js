'use strict';
/** 修复 api-files.js：所有 POST 调用都必须带上公共查询参数 pr=ucpro&fr=pc&uc_param_str= */
const fs = require('fs');
const f = require('path').join(__dirname, '..', 'src', 'main', 'core', 'api-files.js');
let s = fs.readFileSync(f, 'utf8');

// 1) rename / taskStatus：单行写法 `... }));` → 补 query
s = s.replace(
  "http.post(PATH.rename, { fid: id, file_name: newName })",
  "http.post(PATH.rename, { fid: id, file_name: newName }, { query: COMMON_QUERY })"
);
s = s.replace(
  "http.post(PATH.taskStatus, { task_ids: ids, op_type: op })",
  "http.post(PATH.taskStatus, { task_ids: ids, op_type: op }, { query: COMMON_QUERY })"
);

// 2) mkdir/move/copy/delete：多行写法，形如 `... },\n    }, {}));` 或 `... },\n    }));`
//    统一把「post(...) 的第 3 个参数缺失」补成 { query: COMMON_QUERY }
s = s.replace(/(http\.post\(\s*PATH\.\w+,\s*\{[\s\S]*?\n(\s*)\}),\s*\{\s*\}\)\)/g,
  (m, head, indent) => `${head}, { query: COMMON_QUERY }))`);
s = s.replace(/(http\.post\(\s*PATH\.\w+,\s*\{[\s\S]*?\n(\s*)\})\)\)/g,
  (m, head, indent) => `${head}, { query: COMMON_QUERY }))`);

fs.writeFileSync(f, s, 'utf8');

// 校验：每个 http.post 都应带 query
const lines = s.split('\n');
let inPost = false;
let bad = 0;
let posts = 0;
lines.forEach((l, i) => {
  if (/http\.post\(/.test(l)) {
    inPost = true;
    posts += 1;
  }
  if (inPost && /query:\s*COMMON_QUERY/.test(l)) inPost = false;
  if (inPost && /^\s*\}\)\);?\s*$/.test(l)) {
    // 该 post 调用结束但没找到 query
    console.log(`  ✗ L${i + 1} 缺少 query: ${l.trim()}`);
    bad += 1;
    inPost = false;
  }
});
console.log(`共 ${posts} 个 POST 调用，缺少公共查询参数的: ${bad}`);
console.log('\n各 POST 调用现状：');
lines.forEach((l, i) => {
  if (/http\.post\(|query:\s*COMMON_QUERY/.test(l)) {
    console.log(`  L${String(i + 1).padStart(4)}: ${l.trim().slice(0, 100)}`);
  }
});
