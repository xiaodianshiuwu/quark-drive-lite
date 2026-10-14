'use strict';
/**
 * 回归测试：所有 POST 请求必须携带公共查询参数 pr=ucpro&fr=pc&uc_param_str=
 *
 * 为什么必须有这个测试
 * -------------------
 * 真实账号实测发现：`/1/clouddrive/file` 等 POST 接口若**不带** pr/fr 参数，
 * 服务端会直接返回 `401 / code 31001 require login [guest]`——
 * 而 GET（file/sort）不带也能通。也就是说，这个疏漏只会让「写操作」全部失败，
 * 且错误信息是「未登录」，极具误导性（会让人误以为是 Cookie 失效）。
 *
 * 此前的测试只断言了请求体字段，没有断言 POST 也带查询参数，因此漏掉了它。
 * 本文件专门把这个契约固化下来。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const files = require('../src/main/core/api-files.js');
const { HttpClient } = require('../src/main/core/http.js');

// ---------------------------------------------------------------------------
// 拦截式假 fetch：记录每次请求的 URL 与 body
// ---------------------------------------------------------------------------
/**
 * @param {Array<{match:(call:any)=>boolean, body:any}>} [routes] 可按路径定制响应体
 */
function makeRecorder(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = {
      url: u.toString(),
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      method: (init.method || 'GET').toUpperCase(),
      body: init.body ? JSON.parse(init.body) : undefined,
      cookie: (init.headers && init.headers.cookie) || '',
    };
    calls.push(call);

    let payload = { status: 200, code: 0, message: 'ok', data: {}, metadata: {} };
    if (Array.isArray(routes)) {
      const hit = routes.find((r) => r.match(call));
      if (hit) payload = hit.body;
    }
    const text = JSON.stringify(payload);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => text,
      json: async () => payload,
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 断言某个调用带齐了三个公共查询参数。 */
function assertCommonQuery(call, label) {
  assert.strictEqual(call.query.pr, 'ucpro', `${label}: 缺少 pr=ucpro（服务端会当作未登录 guest）`);
  assert.strictEqual(call.query.fr, 'pc', `${label}: 缺少 fr=pc`);
  assert.ok('uc_param_str' in call.query, `${label}: 缺少 uc_param_str`);
}

function setup() {
  const rec = makeRecorder();
  const http = new HttpClient({ getCookie: () => 'k=v' });
  const api = files.createFilesApi({ http });
  return { rec, api };
}

// ---------------------------------------------------------------------------
// 写操作类 POST —— 这些是真机上最容易被 401 的接口
// ---------------------------------------------------------------------------

test('POST /file（新建文件夹）必须带公共查询参数', async () => {
  const { rec, api } = setup();
  try {
    await api.mkdir({ pdirFid: '0', name: '新文件夹' });
    const c = rec.calls.find((x) => x.path.endsWith('/clouddrive/file'));
    assert.ok(c, '应发出 POST /1/clouddrive/file');
    assert.strictEqual(c.method, 'POST');
    assertCommonQuery(c, 'mkdir');
    assert.strictEqual(c.body.pdir_fid, '0');
    assert.strictEqual(c.body.file_name, '新文件夹');
  } finally {
    rec.restore();
  }
});

test('POST /file/rename（重命名）必须带公共查询参数', async () => {
  const { rec, api } = setup();
  try {
    await api.rename({ fid: 'f1', name: 'n.txt' });
    const c = rec.calls.find((x) => x.path.endsWith('/file/rename'));
    assert.ok(c, '应发出 rename 请求');
    assertCommonQuery(c, 'rename');
    assert.strictEqual(c.body.fid, 'f1');
    assert.strictEqual(c.body.file_name, 'n.txt');
  } finally {
    rec.restore();
  }
});

test('POST /file/move（移动）必须带公共查询参数', async () => {
  const { rec, api } = setup();
  try {
    await api.move({ fids: ['f1'], toFid: 'd1' });
    const c = rec.calls.find((x) => x.path.endsWith('/file/move'));
    assert.ok(c, '应发出 move 请求');
    assertCommonQuery(c, 'move');
    assert.strictEqual(c.body.action_type, 1, 'move 应为 SYNC=1');
  } finally {
    rec.restore();
  }
});

test('POST /file/copy（复制）必须带公共查询参数', async () => {
  const { rec, api } = setup();
  try {
    await api.copy({ fids: ['f1'], toFid: 'd1' });
    const c = rec.calls.find((x) => x.path.endsWith('/file/copy'));
    assert.ok(c, '应发出 copy 请求');
    assertCommonQuery(c, 'copy');
    assert.strictEqual(c.body.action_type, 2, 'copy 应为 ASYNC=2');
  } finally {
    rec.restore();
  }
});

test('POST /file/delete（批量删除）必须带公共查询参数', async () => {
  const { rec, api } = setup();
  try {
    await api.remove({ fids: ['a', 'b'] });
    const c = rec.calls.find((x) => x.path.endsWith('/file/delete'));
    assert.ok(c, '应发出 delete 请求');
    assertCommonQuery(c, 'delete');
    assert.strictEqual(c.body.action_type, 2, 'delete 应为 ASYNC=2');
    assert.deepStrictEqual(c.body.filelist, ['a', 'b'], '批量删除应一次传全部 fid');
  } finally {
    rec.restore();
  }
});

test('POST /task/status（任务状态）必须带公共查询参数', async () => {
  const { rec, api } = setup();
  try {
    await api.taskStatus({ taskIds: ['t1'] });
    const c = rec.calls.find((x) => x.path.endsWith('/task/status'));
    assert.ok(c, '应发出 task/status 请求');
    assertCommonQuery(c, 'taskStatus');
    assert.deepStrictEqual(c.body.task_ids, ['t1']);
  } finally {
    rec.restore();
  }
});

// ---------------------------------------------------------------------------
// 只读类 GET —— 一并固化，避免将来被改坏
// ---------------------------------------------------------------------------

test('GET /file/sort（列目录）必须带公共查询参数', async () => {
  const { rec, api } = setup();
  try {
    await api.list({ pdirFid: '0', page: 1, size: 20 });
    const c = rec.calls.find((x) => x.path.endsWith('/file/sort'));
    assert.ok(c);
    assertCommonQuery(c, 'list');
    assert.strictEqual(c.query.pdir_fid, '0');
    assert.strictEqual(c.query._page, '1');
    assert.strictEqual(c.query._size, '20');
    assert.strictEqual(c.query._fetch_total, '1');
    assert.ok(c.query._sort, '应带排序参数');
  } finally {
    rec.restore();
  }
});

test('GET /file/info（文件详情）必须带公共查询参数', async () => {
  // info 需要真实形状的记录，否则会被正确地判定为「未找到」，掩盖我们要测的查询参数问题
  const rec = makeRecorder([
    {
      match: (c) => /\/file\/info$/.test(c.path),
      body: {
        status: 200, code: 0, message: 'ok',
        data: { fid: 'f1', file_name: 'a.txt', dir: false, size: 1, pdir_fid: '0' },
        metadata: {},
      },
    },
  ]);
  const http = new HttpClient({ getCookie: () => 'k=v' });
  const api = files.createFilesApi({ http });
  try {
    await api.info('f1');
    const c = rec.calls.find((x) => /\/file\/info$/.test(x.path));
    assert.ok(c, '应发出 file/info 请求');
    assertCommonQuery(c, 'info');
    assert.strictEqual(c.query.fid, 'f1');
  } finally {
    rec.restore();
  }
});

// ---------------------------------------------------------------------------
// 兜底：任何发往 clouddrive 的请求都必须带 pr/fr
// ---------------------------------------------------------------------------

test('兜底：所有发往 /1/clouddrive/ 的请求都必须带 pr 与 fr（无例外）', async () => {
  const { rec, api } = setup();
  try {
    await api.list({ pdirFid: '0', page: 1, size: 10 }).catch(() => {});
    await api.mkdir({ pdirFid: '0', name: 'x' }).catch(() => {});
    await api.rename({ fid: 'f1', name: 'y' }).catch(() => {});
    await api.move({ fids: ['f1'], toFid: 'd1' }).catch(() => {});
    await api.copy({ fids: ['f1'], toFid: 'd1' }).catch(() => {});
    await api.remove({ fids: ['f1'] }).catch(() => {});
    await api.taskStatus({ taskIds: ['t1'] }).catch(() => {});

    const cd = rec.calls.filter((x) => x.path.includes('/clouddrive/'));
    assert.ok(cd.length >= 7, `应捕获多个 clouddrive 请求（实际 ${cd.length}）`);

    const offenders = cd.filter((x) => x.query.pr !== 'ucpro' || x.query.fr !== 'pc');
    assert.deepStrictEqual(
      offenders.map((x) => `${x.method} ${x.path} query=${JSON.stringify(x.query)}`),
      [],
      '以下请求缺少 pr/fr，服务端会当未登录 guest 处理（真机上表现为 401/31001）'
    );
  } finally {
    rec.restore();
  }
});
