'use strict';
/**
 * normalize.js 单元测试 —— 纯 Node，无外部依赖。
 *
 * 重点：**服务端字段类型未知时不得抛异常**（docs/API_NOTES.md §4.1 / §9 待确认项 6），
 * 因此这里大量使用"畸形输入"作为用例。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toFileItem,
  toFileItems,
  toPageResult,
  extOf,
  isDir,
  unescapeHtml,
} = require('../src/main/core/normalize');

// ───────────────────────────── HTML 实体反转义 ─────────────────────────────

test('unescapeHtml 覆盖 &amp; &lt; &gt; &quot; &#39;', () => {
  assert.equal(unescapeHtml('A&amp;B'), 'A&B');
  assert.equal(unescapeHtml('&lt;tag&gt;'), '<tag>');
  assert.equal(unescapeHtml('&quot;引号&quot;'), '"引号"');
  assert.equal(unescapeHtml('&#39;单引号&#39;'), "'单引号'");
  assert.equal(unescapeHtml('a&amp;b&lt;c&gt;d&quot;e&#39;f'), 'a&b<c>d"e\'f');
});

test('unescapeHtml 处理数字实体、十六进制实体与未知实体', () => {
  assert.equal(unescapeHtml('&#65;&#x42;&#X43;'), 'ABC');
  assert.equal(unescapeHtml('&#20013;&#25991;'), '中文');
  assert.equal(unescapeHtml('&unknownentity;'), '&unknownentity;');
  assert.equal(unescapeHtml('&amp'), '&amp'); // 无分号 → 保持原样，不误伤
  assert.equal(unescapeHtml('AT&T 与 R&D'), 'AT&T 与 R&D'); // 裸 & 不动
});

test('unescapeHtml 对 &amp;lt; 只解码一次（与 Go html.UnescapeString 一致）', () => {
  assert.equal(unescapeHtml('&amp;lt;'), '&lt;');
  assert.equal(unescapeHtml('&amp;amp;'), '&amp;');
});

test('unescapeHtml 对非字符串输入安全降级为空串', () => {
  for (const bad of [null, undefined, 123, {}, [], true, Symbol('x')]) {
    assert.equal(unescapeHtml(bad), '');
  }
});

test('unescapeHtml 不抛异常：随机畸形输入', () => {
  const cases = ['&', '&#', '&#;', '&#x;', '&#xZZ;', '&;', '&#999999999999;', '&\u0000;', '&#55296;'];
  for (const c of cases) {
    assert.doesNotThrow(() => unescapeHtml(c));
    assert.equal(typeof unescapeHtml(c), 'string');
  }
});

// ───────────────────────────── dir 宽松判定 ─────────────────────────────

test('isDir 宽松判定：true/1/"1"/"true" 都算目录', () => {
  for (const v of [true, 1, '1', 'true', 'TRUE', 'True', 'yes', 'on']) {
    assert.equal(isDir({ dir: v }), true, `dir=${JSON.stringify(v)} 应判为目录`);
  }
});

test('isDir 宽松判定：false/0/"0"/"false" 都不算目录', () => {
  for (const v of [false, 0, '0', 'false', 'FALSE', 'no', 'off', '', null]) {
    assert.equal(isDir({ dir: v }), false, `dir=${JSON.stringify(v)} 不应判为目录`);
  }
});

test('isDir 多信号：file_type=0 与 OpenList 的 file=false 也算目录', () => {
  assert.equal(isDir({ file_type: 0 }), true);
  assert.equal(isDir({ file_type: '0' }), true);
  assert.equal(isDir({ file_type: 1 }), false);
  assert.equal(isDir({ file: false }), true);   // OpenList: IsFolder = !File
  assert.equal(isDir({ file: true }), false);
  assert.equal(isDir({}), false);               // 字段缺失 → 不是目录（不猜）
});

test('isDir 优先级：dir 存在时权威，辅助信号不得推翻它', () => {
  // 真实记录里 file_type=0 常见于文件夹，但 dir 是主字段（API_NOTES §4.1）：
  // dir 明确为 false 时必须听 dir，否则会把文件误判成目录
  assert.equal(isDir({ dir: false, file_type: 0 }), false);
  assert.equal(isDir({ dir: 0, file_type: 0 }), false);
  assert.equal(isDir({ dir: 'false', file_type: 0 }), false);
  assert.equal(isDir({ dir: false, file: false }), false);
  // dir 为真时同样以 dir 为准
  assert.equal(isDir({ dir: true, file_type: 1 }), true);
  // dir 缺失时才由辅助信号接管
  assert.equal(isDir({ file_type: 0 }), true);
  assert.equal(isDir({ file: false }), true);
});

test('isDir 对畸形输入不抛异常', () => {
  for (const bad of [null, undefined, 0, '', 'abc', [], [1, 2], NaN, () => {}]) {
    assert.doesNotThrow(() => isDir(bad));
    assert.equal(isDir(bad), false);
  }
});

// ───────────────────────────── extOf ─────────────────────────────

test('extOf 返回小写扩展名，无扩展名返回空串', () => {
  assert.equal(extOf('video.MP4'), 'mp4');
  assert.equal(extOf('a.b.Tar.GZ'), 'gz');
  assert.equal(extOf('README'), '');
  assert.equal(extOf('trailing.'), '');
  assert.equal(extOf('.gitignore'), '');   // 隐藏文件不算扩展名
  assert.equal(extOf('dir/sub/name.JPG'), 'jpg');
  assert.equal(extOf('中文 文件.MKV'), 'mkv');
});

test('extOf 对非字符串输入返回空串', () => {
  for (const bad of [null, undefined, 1, {}, [], true]) {
    assert.equal(extOf(bad), '');
  }
});

// ───────────────────────────── toFileItem ─────────────────────────────

test('toFileItem 做 HTML 实体反转义并派生 ext', () => {
  const item = toFileItem({
    fid: 'f1', file_name: 'Rock &amp; Roll &#39;90.mp4', dir: false,
    size: 1024, category: 1, updated_at: 1700000000000, created_at: 1690000000000,
    pdir_fid: '0', file_type: 1,
  });
  assert.deepEqual(item, {
    fid: 'f1',
    name: "Rock & Roll '90.mp4",
    dir: false,
    size: 1024,
    updatedAt: 1700000000000,
    createdAt: 1690000000000,
    category: 1,
    ext: 'mp4',
    pdirFid: '0',
  });
});

test('toFileItem 对缺失字段一律给安全默认值', () => {
  assert.deepEqual(toFileItem({ fid: 'x' }), {
    fid: 'x', name: '未命名', dir: false, size: 0,
    updatedAt: 0, createdAt: 0, category: 0, ext: '', pdirFid: '',
  });
});

test('toFileItem 目录：size 归零、ext 为空', () => {
  const item = toFileItem({ fid: 'd1', file_name: 'Movies', dir: 1, size: 4096, category: 2 });
  assert.equal(item.dir, true);
  assert.equal(item.size, 0);
  assert.equal(item.ext, '');
});

test('toFileItem 宽松数字转换：字符串数字与非法值', () => {
  const item = toFileItem({
    fid: 'x', file_name: 'a.txt', size: '2048',
    updated_at: '1700000000000', created_at: 'bad', category: '3',
  });
  assert.equal(item.size, 2048);
  assert.equal(item.updatedAt, 1700000000000);
  assert.equal(item.createdAt, 0);   // 'bad' → 0
  assert.equal(item.category, 3);
});

test('toFileItem 对畸形输入**不抛异常**（核心健壮性要求）', () => {
  const badInputs = [
    null, undefined, 0, 1, '', 'str', true, false, [], [{}],
    NaN, Infinity, () => {}, Symbol('s'), new Map(),
    { file_name: {} }, { file_name: [] }, { file_name: null }, { file_name: 42 },
    { fid: {} }, { size: {} }, { category: [] }, { updated_at: {} }, { pdir_fid: null },
  ];
  for (const bad of badInputs) {
    let item;
    assert.doesNotThrow(() => { item = toFileItem(bad); }, `输入 ${String(bad)} 不应抛异常`);
    // 返回结构必须完整，字段类型必须稳定
    assert.equal(typeof item.fid, 'string');
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.dir, 'boolean');
    assert.equal(typeof item.size, 'number');
    assert.equal(typeof item.updatedAt, 'number');
    assert.equal(typeof item.createdAt, 'number');
    assert.equal(typeof item.category, 'number');
    assert.equal(typeof item.ext, 'string');
    assert.equal(typeof item.pdirFid, 'string');
    assert.ok(Number.isFinite(item.size));
    assert.ok(Number.isFinite(item.updatedAt));
    assert.ok(Number.isFinite(item.updatedAt));
  }
});

test('toFileItem 对数组/对象型输入返回空白条目而非异常', () => {
  assert.deepEqual(toFileItem([{ fid: 'a' }]), {
    fid: '', name: '未命名', dir: false, size: 0,
    updatedAt: 0, createdAt: 0, category: 0, ext: '', pdirFid: '',
  });
});

test('toFileItems 批量归一化，非数组返回空数组', () => {
  const out = toFileItems([{ fid: 'a', file_name: '1.txt' }, null, { fid: 'b', dir: true, file_name: 'D' }]);
  assert.equal(out.length, 3);
  assert.equal(out[0].name, '1.txt');
  assert.equal(out[2].dir, true);
  assert.deepEqual(toFileItems(null), []);
  assert.deepEqual(toFileItems('nope'), []);
  assert.deepEqual(toFileItems(undefined), []);
});

// ───────────────────────────── toPageResult ─────────────────────────────

test('toPageResult：标准包络 data.list + metadata._total（OpenList 字段名）', () => {
  const env = {
    status: 200, code: 0, message: 'ok',
    data: { list: [{ fid: '1', file_name: 'a.mp4', dir: false, size: 10 }] },
    metadata: { _total: 100, _page: 1, _size: 50 },
  };
  const r = toPageResult(env, { page: 1, size: 50 });
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].name, 'a.mp4');
  assert.equal(r.total, 100);
  assert.equal(r.page, 1);
  assert.equal(r.size, 50);
  assert.equal(r.hasMore, true);  // 1*50 < 100
});

test('toPageResult：分页 hasMore 边界（page*size < total）', () => {
  const mk = (total) => ({ status: 200, code: 0, data: { list: [] }, metadata: { _total: total } });
  assert.equal(toPageResult(mk(100), { page: 2, size: 50 }).hasMore, false); // 100 < 100 = false
  assert.equal(toPageResult(mk(101), { page: 2, size: 50 }).hasMore, true);  // 100 < 101
  assert.equal(toPageResult(mk(0), { page: 1, size: 50 }).hasMore, false); // 50 < 0 = false
  assert.equal(toPageResult(mk(1), { page: 1, size: 50 }).hasMore, false); // 50 < 1 = false（仅一页）
  assert.equal(toPageResult(mk(60), { page: 1, size: 50 }).hasMore, true);  // 50 < 60
  assert.equal(toPageResult(mk(60), { page: 2, size: 50 }).hasMore, false);
});

test('toPageResult：total 缺失设 -1，用 list.length === size 推断 hasMore', () => {
  const full = { status: 200, code: 0, data: { list: new Array(2).fill({ fid: 'x' }) } };
  const partial = { status: 200, code: 0, data: { list: [{ fid: 'x' }] } };
  assert.equal(toPageResult(full, { page: 1, size: 2 }).total, -1);
  assert.equal(toPageResult(full, { page: 1, size: 2 }).hasMore, true);   // 满页 → 可能还有
  assert.equal(toPageResult(partial, { page: 1, size: 2 }).hasMore, false); // 不满页 → 结束
});

test('toPageResult：兼容 metadata.total / 顶层 total / data._total', () => {
  assert.equal(toPageResult({ data: { list: [] }, metadata: { total: 7 } }, { page: 1, size: 50 }).total, 7);
  assert.equal(toPageResult({ data: { list: [] }, total: 8 }, { page: 1, size: 50 }).total, 8);
  assert.equal(toPageResult({ data: { list: [], _total: 9 } }, { page: 1, size: 50 }).total, 9);
});

test('toPageResult：兼容 data 直接是数组 / metadata.list', () => {
  const a = toPageResult({ status: 200, code: 0, data: [{ fid: '1', file_name: 'x' }] }, { page: 1, size: 50 });
  assert.equal(a.list.length, 1);
  const b = toPageResult({ metadata: { list: [{ fid: '2', file_name: 'y' }], _total: 1 } }, { page: 1, size: 50 });
  assert.equal(b.list.length, 1);
  assert.equal(b.total, 1);
});

test('toPageResult 对畸形输入不抛异常，且返回契约字段齐备', () => {
  const bads = [null, undefined, 0, '', 'str', [], [1], { data: null }, { data: { list: 'no' } },
    { data: { list: null } }, { metadata: null }, { metadata: { _total: 'abc' } }];
  for (const bad of bads) {
    let r;
    assert.doesNotThrow(() => { r = toPageResult(bad, { page: 1, size: 50 }); }, `输入 ${String(bad)} 不应抛异常`);
    assert.ok(Array.isArray(r.list));
    assert.equal(typeof r.total, 'number');
    assert.equal(typeof r.page, 'number');
    assert.equal(typeof r.size, 'number');
    assert.equal(typeof r.hasMore, 'boolean');
  }
});

test('toPageResult：page/size 非法或缺失时回落到默认值 1 / 50', () => {
  const env = { data: { list: [] }, metadata: { _total: 0 } };
  assert.equal(toPageResult(env, { page: 0, size: 0 }).page, 1);
  assert.equal(toPageResult(env, { page: 0, size: 0 }).size, 50);
  assert.equal(toPageResult(env, { page: -3, size: -1 }).size, 50);
  assert.equal(toPageResult(env, { page: -3, size: -1 }).page, 1);
  assert.equal(toPageResult(env, {}).page, 1);
  assert.equal(toPageResult(env, {}).size, 50);
  assert.equal(toPageResult(env, { page: 'abc', size: 'abc' }).page, 1);
  assert.equal(toPageResult(env, { page: 'abc', size: 'abc' }).size, 50);
  assert.equal(toPageResult(env, { page: '3', size: '20' }).page, 3);
  assert.equal(toPageResult(env, { page: '3', size: '20' }).size, 20);
});
