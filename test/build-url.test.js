'use strict';
/**
 * 回归测试：buildUrl 必须完整保留绝对 URL 的路径与查询串。
 *
 * 真实账号实测暴露的严重 bug：对 CDN 直链（完整 URL）曾用 `new URL(path, '/')` 构造，
 * 导致路径与查询串被丢弃，请求打到 CDN 根路径 → 403 Forbidden。
 * 该错误极具误导性（Cookie/Range 都正确，却像"直链过期"），因此专门固化。
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildUrl, buildAbsoluteUrl } = require('../src/main/core/http.js');

const CDN =
  'https://cdn.example.test/fixture/user/file/source' +
  '?abt=8_0_&auth_key=fixture-key&token=fixture-token';

test('绝对 URL：路径必须完整保留（不得被截成根路径）', () => {
  const out = buildAbsoluteUrl(CDN, undefined);
  const u = new URL(out);
  assert.equal(u.host, 'cdn.example.test');
  assert.ok(
    u.pathname.startsWith('/fixture/user/'),
    `路径被丢弃了！实际 pathname=${u.pathname}`
  );
  assert.ok(u.pathname.endsWith('source'));
});

test('绝对 URL：原有查询串必须保留（abt / auth_key / token）', () => {
  const out = buildAbsoluteUrl(CDN, undefined);
  const u = new URL(out);
  assert.equal(u.searchParams.get('abt'), '8_0_');
  assert.equal(u.searchParams.get('auth_key'), 'fixture-key');
  assert.ok(u.searchParams.get('token'), 'token 必须保留');
});

test('绝对 URL：额外 query 应追加而非覆盖原有参数', () => {
  const out = buildAbsoluteUrl(CDN, { uploadId: 'U1', partNumber: 3 });
  const u = new URL(out);
  assert.equal(u.searchParams.get('uploadId'), 'U1');
  assert.equal(u.searchParams.get('partNumber'), '3');
  // 原有参数仍在
  assert.equal(u.searchParams.get('abt'), '8_0_');
  assert.ok(u.pathname.startsWith('/fixture/'));
});

test('相对路径：仍按 base 正常拼接', () => {
  const out = buildUrl('https://drive-pc.quark.cn', '/1/clouddrive/config', { pr: 'ucpro' });
  const u = new URL(out);
  assert.equal(u.host, 'drive-pc.quark.cn');
  assert.equal(u.pathname, '/1/clouddrive/config');
  assert.equal(u.searchParams.get('pr'), 'ucpro');
});

test('回归：绝对 URL 不得退化为仅 origin', () => {
  const out = buildAbsoluteUrl(CDN, undefined);
  const u = new URL(out);
  // 这正是曾经出错的表现：pathname === '/' 且查询串为空
  assert.notEqual(u.pathname, '/', 'pathname 退化为根路径 → 又会打到 CDN 根并 403');
  assert.ok(u.search, '查询串不得为空');
});

test('回归：曾把「完整URL当base、/ 当path」——该错误调用必须被杜绝', () => {
  // 记录这个反例：new URL('/', 完整URL) 只保留 origin。
  // 保留断言是为了让后来者一眼看懂这个坑，而不是为了测试 Node 本身。
  const wrong = new URL('/', CDN).toString();
  assert.equal(new URL(wrong).pathname, '/');
  assert.equal(new URL(wrong).search, '');
  // 正确实现绝不能产生这种结果
  const right = buildAbsoluteUrl(CDN, undefined);
  assert.notEqual(right, wrong);
});
