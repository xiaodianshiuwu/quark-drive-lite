'use strict';
/**
 * api-files.js / modules/fs.js 集成测试 —— 纯 Node，无外部依赖。
 *
 * 测试手法：monkey-patch `globalThis.fetch`。
 * 依据 `core/http.js` 的 `pickTransport()`：非 Electron 环境下回退到 `globalThis.fetch`，
 * 因此这里打桩即可完整驱动真实的 HttpClient（含包络解析、错误映射、重试逻辑）。
 *
 * 注意：HttpClient 构造时会**绑定**当时的 `globalThis.fetch`（`bind`），
 * 所以每个用例都必须在构造 HttpClient **之前**完成打桩。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { HttpClient } = require('../src/main/core/http');
const { ErrCode, QuarkError } = require('../src/main/core/errors');
const { createFilesApi, PATH } = require('../src/main/core/api-files');
const { createFsModule } = require('../src/main/modules/fs');

const BASE = 'https://drive-pc.quark.cn';

// ───────────────────────────── 测试脚手架 ─────────────────────────────

const realFetch = globalThis.fetch;

/**
 * 安装假 fetch。
 * @param {(url:string, init:object)=>{status?:number, body?:any}} handler
 * @returns {{calls: Array<{url:string, method:string, headers:object, body:any, path:string, query:Record<string,string>}>}}
 */
function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const query = {};
    for (const [k, v] of u.searchParams.entries()) query[k] = v;
    let parsedBody;
    if (typeof init.body === 'string') {
      try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
    }
    calls.push({
      url: String(url),
      path: u.pathname,
      query,
      method: (init.method || 'GET').toUpperCase(),
      headers: init.headers || {},
      body: parsedBody,
    });

    const out = handler(String(url), init) || {};
    const status = out.status === undefined ? 200 : out.status;
    const payload = out.body === undefined ? { status: 200, code: 0, message: 'ok', data: {}, metadata: {} } : out.body;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return { calls };
}

/** 构造被测对象；必须在 installFetch 之后调用。 */
function makeApi(handler, opts = {}) {
  const stub = installFetch(handler);
  const http = new HttpClient({ getCookie: () => 'stub=1', retries: 0, ...opts });
  return { api: createFilesApi({ http }), calls: stub.calls, http };
}

function makeFs(handler, opts = {}) {
  const stub = installFetch(handler);
  const http = new HttpClient({ getCookie: () => 'stub=1', retries: 0, ...opts });
  return { fs: createFsModule({ http }), calls: stub.calls, http };
}

/** 列表响应包络（字段名取自 OpenList SortResp：data.list + metadata._total）。 */
function listEnvelope(list, total) {
  return { status: 200, code: 0, message: 'ok', data: { list }, metadata: { _total: total } };
}

test.after(() => { globalThis.fetch = realFetch; });

// ───────────────────────────── 导出签名 ─────────────────────────────

test('createFilesApi 导出契约方法齐全', () => {
  const { api } = makeApi(() => ({}));
  for (const m of ['list', 'search', 'info', 'crumbs', 'mkdir', 'rename', 'move', 'copy', 'remove', 'taskStatus', 'queryTask']) {
    assert.equal(typeof api[m], 'function', `缺少方法 ${m}`);
  }
});

test('createFsModule 导出契约方法齐全（含 waitTask / listAll）', () => {
  const { fs } = makeFs(() => ({}));
  for (const m of ['list', 'search', 'info', 'crumbs', 'mkdir', 'rename', 'move', 'copy', 'remove', 'taskStatus', 'waitTask', 'listAll']) {
    assert.equal(typeof fs[m], 'function', `缺少方法 ${m}`);
  }
});

// ───────────────────────────── list ─────────────────────────────

test('list：请求路径与全部查询参数正确，响应归一化为 PageResult', async () => {
  const { api, calls } = makeApi(() => ({
    body: listEnvelope([{ fid: 'f1', file_name: 'A.mp4', dir: false, size: 10, category: 1, updated_at: 5, pdir_fid: '0' }], 120),
  }));

  const r = await api.list({ pdirFid: '0', page: 1, size: 50 });

  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.path, PATH.list);
  assert.equal(c.path, '/1/clouddrive/file/sort');
  assert.equal(c.method, 'GET');
  assert.equal(c.query.pdir_fid, '0');
  assert.equal(c.query._page, '1');
  assert.equal(c.query._size, '50');
  assert.equal(c.query._fetch_total, '1');
  assert.equal(c.query.fetch_all_file, '1');
  assert.equal(c.query.fetch_risk_file_name, '1');
  assert.equal(c.query._sort, 'file_type:asc,updated_at:desc');
  assert.equal(c.query.pr, 'ucpro');
  assert.equal(c.query.fr, 'pc');
  // uc_param_str 必须是官方客户端的字面常量，而不是空串
  // （曾误传空串：当时只观察到匿名请求；取证官方 axios 拦截器后纠正）
  const { COMMON_QUERY } = require('../src/main/core/http.js');
  assert.equal(c.query.uc_param_str, COMMON_QUERY.uc_param_str);
  assert.ok(c.query.uc_param_str.length > 0, 'uc_param_str 不得为空');
  assert.equal(c.query.device_model, COMMON_QUERY.device_model);
  assert.ok(c.query.device_model, '应携带 device_model（官方每个请求都带）');

  assert.deepEqual(Object.keys(r).sort(), ['hasMore', 'list', 'page', 'size', 'total']);
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].name, 'A.mp4');
  assert.equal(r.list[0].ext, 'mp4');
  assert.equal(r.total, 120);
  assert.equal(r.page, 1);
  assert.equal(r.size, 50);
  assert.equal(r.hasMore, true);
});

test('list：自定义 sort 与 cat 被透传；未传 fid 默认根目录 "0"', async () => {
  const { api, calls } = makeApi(() => ({ body: listEnvelope([], 0) }));
  await api.list({ page: 2, size: 20, sort: 'file_name:asc', cat: 'video' });

  const c = calls[0];
  assert.equal(c.query.pdir_fid, '0');
  assert.equal(c.query._page, '2');
  assert.equal(c.query._size, '20');
  assert.equal(c.query._sort, 'file_name:asc');
  assert.equal(c.query.cat, 'video');
});

test('list：size 被原样透传为 _size（不固定成 100）', async () => {
  const { api, calls } = makeApi(() => ({ body: listEnvelope([], 0) }));
  await api.list({ pdirFid: '0', page: 1, size: 50 });
  assert.equal(calls[0].query._size, '50');
});

// ───────────────────────────── search（含运行时探测） ─────────────────────────────

test('search：首用 q 参数（源码取证的主参数名）', async () => {
  const { api, calls } = makeApi(() => ({
    body: listEnvelope([{ fid: 's1', file_name: '关键字.mp4', dir: false, size: 1 }], 1),
  }));

  const r = await api.search({ keyword: '关键字', page: 1, size: 50 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/1/clouddrive/file/search');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].query.q, '关键字');
  assert.equal(calls[0].query.keyword, undefined);
  assert.equal(calls[0].query._page, '1');
  assert.equal(calls[0].query._size, '50');
  assert.equal(r.list[0].name, '关键字.mp4');
});

test('search：q 失败时保留错误，不使用已经证伪的 keyword 参数', async () => {
  const { api, calls } = makeApi(() => ({ status: 400, body: { status: 400, code: 14001, message: '参数错误' } }));
  await assert.rejects(() => api.search({ keyword: 'x' }), e => e.code === ErrCode.INVALID_ARG && !!e.raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.q, 'x');
});

test('search：连续搜索始终使用真实确认的 q', async () => {
  const { api, calls } = makeApi(() => ({ body: listEnvelope([], 0) }));
  await api.search({ keyword: 'a' });
  await api.search({ keyword: 'b' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.q, 'a');
  assert.equal(calls[1].query.q, 'b');
  assert.equal(calls[1].query.keyword, undefined);
});

test('search：成功包络缺少列表时明确报错', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));
  await assert.rejects(() => api.search({ keyword: 'x' }), e => e.code === ErrCode.SERVER && !!e.raw);
  assert.equal(calls.length, 1);
});

test('search：空关键字直接以 INVALID_ARG 拒绝，不发请求', async () => {
  const { api, calls } = makeApi(() => ({}));
  await assert.rejects(() => api.search({ keyword: '   ' }), (e) => e.code === ErrCode.INVALID_ARG);
  await assert.rejects(() => api.search({}), (e) => e.code === ErrCode.INVALID_ARG);
  assert.equal(calls.length, 0);
});

test('search：未登录（31001）不触发换参重试，直接上抛 NEED_LOGIN', async () => {
  const { api, calls } = makeApi(() => ({
    status: 401, body: { status: 401, code: 31001, message: 'require login [guest]' },
  }));

  await assert.rejects(() => api.search({ keyword: 'x' }), (e) => {
    assert.equal(e.code, ErrCode.NEED_LOGIN);
    assert.equal(e.bizCode, 31001);
    return true;
  });
  assert.equal(calls.length, 1, '未登录不应重复请求');
});

// ───────────────────────────── info / crumbs ─────────────────────────────

test('info：路径与参数正确，返回单个 FileItem 并做实体反转义', async () => {
  const { api, calls } = makeApi(() => ({
    body: { status: 200, code: 0, data: { fid: 'f9', file_name: 'T &amp; U.txt', dir: 0, size: '5', pdir_fid: '0' } },
  }));

  const item = await api.info('f9');
  assert.equal(calls[0].path, '/1/clouddrive/file/info');
  assert.equal(calls[0].query.fid, 'f9');
  assert.equal(calls[0].query._fetch_full_path, '1');
  assert.equal(calls[0].query.need_profile_tags, '1');
  assert.equal(calls[0].query.kkkk, '1');
  assert.equal(item.name, 'T & U.txt');
  assert.equal(item.size, 5);
  assert.equal(item.ext, 'txt');
  assert.equal(item.dir, false);
});

test('info：data 为数组时取首条；缺失时抛 NOT_FOUND', async () => {
  const { api: api1 } = makeApi(() => ({
    body: { status: 200, code: 0, data: [{ fid: 'a', file_name: 'x' }] },
  }));
  assert.equal((await api1.info('a')).fid, 'a');

  const { api: api2 } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));
  await assert.rejects(() => api2.info('nope'), (e) => e.code === ErrCode.NOT_FOUND);
});

test('crumbs：解析 data.list 为 Crumb[]', async () => {
  const { api, calls } = makeApi(() => ({
    body: {
      status: 200, code: 0,
      data: { list: [{ fid: '0', file_name: '全部文件' }, { fid: 'd1', file_name: '电影' }] },
    },
  }));

  const crumbs = await api.crumbs('d2');
  assert.equal(calls[0].path, '/1/clouddrive/file/info/path_list');
  assert.equal(calls[0].query.fid, 'd2');
  assert.deepEqual(crumbs, [{ fid: '0', name: '全部文件' }, { fid: 'd1', name: '电影' }]);
});

test('crumbs：fid 为 "0" 直接返回根面包屑，不发请求', async () => {
  const { api, calls } = makeApi(() => ({}));
  assert.deepEqual(await api.crumbs('0'), [{ fid: '0', name: '全部文件' }]);
  assert.equal(calls.length, 0);
});

test('crumbs：解析失败一律降级为根面包屑，不抛错', async () => {
  const bads = [
    () => ({ body: { status: 200, code: 0, data: {} } }),
    () => ({ body: { status: 200, code: 0, data: { list: [] } } }),
    () => ({ body: { status: 200, code: 0, data: { list: [null, 'x', {}, { file_name: 'no-fid' }] } } }),
    () => ({ status: 500, body: { status: 500, code: 500, message: 'boom' } }),
  ];
  for (const h of bads) {
    const { api } = makeApi(h);
    const r = await api.crumbs('d1');
    assert.deepEqual(r, [{ fid: '0', name: '全部文件' }]);
  }
});

test('crumbs：NEED_LOGIN 例外上抛（UI 需据此提示重新登录）', async () => {
  const { api } = makeApi(() => ({
    status: 401, body: { status: 401, code: 31001, message: 'require login [guest]' },
  }));
  await assert.rejects(() => api.crumbs('d1'), (e) => e.code === ErrCode.NEED_LOGIN);
});

// ───────────────────────────── mkdir / rename ─────────────────────────────

test('mkdir：路径与 body 字段正确，返回 TaskAccepted{done:true}', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));

  const r = await api.mkdir({ pdirFid: '0', name: '新建文件夹' });

  assert.equal(calls[0].path, '/1/clouddrive/file');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    pdir_fid: '0', file_name: '新建文件夹', dir_path: '', dir_init_lock: false,
  });
  assert.equal(r.done, true);
  assert.equal(Object.hasOwn(r, 'taskId'), false, 'TaskAccepted 只应含契约字段');
});

test('mkdir：未传 pdirFid 时默认根目录 "0"', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));
  await api.mkdir({ name: 'D' });
  assert.equal(calls[0].body.pdir_fid, '0');
});

test('rename：路径与 body 正确，无 task_id 时 done:true（不抛错）', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));

  const r = await api.rename({ fid: 'f1', name: '新名字.txt' });

  assert.equal(calls[0].path, '/1/clouddrive/file/rename');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { fid: 'f1', file_name: '新名字.txt' });
  assert.deepEqual(r, { done: true });
});

test('rename：用户输入的首尾空格被保留（不 trim 名称）', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));
  await api.rename({ fid: 'f1', name: ' 带空格 ' });
  assert.equal(calls[0].body.file_name, ' 带空格 ');
});

// ───────────────────────────── move / copy / remove（action_type 关键） ─────────────────────────────

test('move：body 为 action_type:1(SYNC)，且不含 lock_concurr_op', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));

  const r = await api.move({ fids: ['f1', 'f2'], toFid: 'd9' });

  assert.equal(calls[0].path, '/1/clouddrive/file/move');
  assert.equal(calls[0].body.action_type, 1);
  assert.equal(calls[0].body.to_pdir_fid, 'd9');
  assert.deepEqual(calls[0].body.filelist, ['f1', 'f2']);
  assert.deepEqual(calls[0].body.exclude_fids, []);
  assert.equal(calls[0].body.lock_concurr_op, undefined, '不得携带 lock_concurr_op（待确认项 4）');
  assert.equal(r.done, true);
});

test('copy：body 为 action_type:2(ASYNC) + copy_source:1，且不含 lock_concurr_op', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));

  await api.copy({ fids: ['f1'], toFid: 'd9' });

  assert.equal(calls[0].path, '/1/clouddrive/file/copy');
  assert.equal(calls[0].body.action_type, 2);
  assert.equal(calls[0].body.copy_source, 1);
  assert.equal(calls[0].body.to_pdir_fid, 'd9');
  assert.deepEqual(calls[0].body.filelist, ['f1']);
  assert.equal(calls[0].body.lock_concurr_op, undefined);
});

test('remove：body 为 action_type:2(ASYNC)，且不含 lock_concurr_op', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));

  await api.remove({ fids: ['f1', 'f2', 'f3'] });

  assert.equal(calls[0].path, '/1/clouddrive/file/delete');
  assert.equal(calls[0].body.action_type, 2);
  assert.deepEqual(calls[0].body.filelist, ['f1', 'f2', 'f3']);
  assert.deepEqual(calls[0].body.exclude_fids, []);
  assert.equal(calls[0].body.lock_concurr_op, undefined);
});

test('move/copy/remove：请求不得携带 X-U-Drive-Secret-Auth（隐私空间专用）', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: {} } }));
  await api.move({ fids: ['a'], toFid: 'b' });
  await api.copy({ fids: ['a'], toFid: 'b' });
  await api.remove({ fids: ['a'] });

  for (const c of calls) {
    const keys = Object.keys(c.headers).map((k) => k.toLowerCase());
    assert.equal(keys.includes('x-u-drive-secret-auth'), false, `${c.path} 不应携带隐私空间鉴权头`);
  }
});

test('移动/复制/删除：响应出现 task_id 时返回 {taskId, done:false}', async () => {
  const { api } = makeApi(() => ({
    body: { status: 200, code: 0, data: { task_id: 'task-abc' } },
  }));
  assert.deepEqual(await api.move({ fids: ['a'], toFid: 'b' }), { taskId: 'task-abc', done: false });
  assert.deepEqual(await api.copy({ fids: ['a'], toFid: 'b' }), { taskId: 'task-abc', done: false });
  assert.deepEqual(await api.remove({ fids: ['a'] }), { taskId: 'task-abc', done: false });
});

test('写操作参数校验：空 fids / 空 fid / 空 name 以 INVALID_ARG 拒绝且不发请求', async () => {
  const { api, calls } = makeApi(() => ({}));
  await assert.rejects(() => api.remove({ fids: [] }), (e) => e.code === ErrCode.INVALID_ARG);
  await assert.rejects(() => api.move({ fids: [], toFid: 'd' }), (e) => e.code === ErrCode.INVALID_ARG);
  await assert.rejects(() => api.copy({ fids: ['a'], toFid: '' }), (e) => e.code === ErrCode.INVALID_ARG);
  await assert.rejects(() => api.rename({ fid: '', name: 'x' }), (e) => e.code === ErrCode.INVALID_ARG);
  await assert.rejects(() => api.mkdir({ pdirFid: '0', name: '' }), (e) => e.code === ErrCode.INVALID_ARG);
  assert.equal(calls.length, 0);
});

// ───────────────────────────── 任务接口 ─────────────────────────────

test('taskStatus：body 为 {task_ids, op_type}，opType 默认 1', async () => {
  const { api, calls } = makeApi(() => ({
    body: { status: 200, code: 0, data: { list: [{ task_id: 't1', status: 2 }] } },
  }));

  const r = await api.taskStatus({ taskIds: ['t1'] });

  assert.equal(calls[0].path, '/1/clouddrive/task/status');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { task_ids: ['t1'], op_type: 1 });
  assert.equal(r.length, 1);
  assert.equal(r[0].taskId, 't1');
  assert.equal(r[0].status, 2);
  assert.equal(r[0].done, false, '数值 status 不得被硬编码判定为完成（待确认项 3）');
});

test('taskStatus：显式 opType 透传；空 taskIds 拒绝', async () => {
  const { api, calls } = makeApi(() => ({ body: { status: 200, code: 0, data: { list: [] } } }));
  await api.taskStatus({ taskIds: ['t1'], opType: 7 });
  assert.equal(calls[0].body.op_type, 7);
  await assert.rejects(() => api.taskStatus({ taskIds: [] }), (e) => e.code === ErrCode.INVALID_ARG);
});

test('taskStatus：仅布尔 finish / done / success 或字符串 "finish" 才算完成', async () => {
  const { api } = makeApi(() => ({
    body: {
      status: 200, code: 0,
      data: {
        list: [
          { task_id: 'a', status: 0, finish: true },
          { task_id: 'b', status: 1, done: true },
          { task_id: 'c', status: 2, success: true },
          { task_id: 'd', status: 'finish' },
          { task_id: 'e', status: 3 },              // 数值 → 未确认 → 视为未完成
          { task_id: 'f', status: 'running' },
        ],
      },
    },
  }));

  const r = await api.taskStatus({ taskIds: ['a'] });
  const byId = Object.fromEntries(r.map((x) => [x.taskId, x]));
  assert.equal(byId.a.done, true);
  assert.equal(byId.b.done, true);
  assert.equal(byId.c.done, true);
  assert.equal(byId.d.done, true);
  assert.equal(byId.e.done, false);
  assert.equal(byId.f.done, false);
});

test('queryTask：GET /1/clouddrive/task，参数 task_id', async () => {
  const { api, calls } = makeApi(() => ({
    body: { status: 200, code: 0, data: { task_id: 't1', status: 'finish' } },
  }));

  const r = await api.queryTask('t1');
  assert.equal(calls[0].path, '/1/clouddrive/task');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].query.task_id, 't1');
  assert.equal(r.taskId, 't1');
  assert.equal(r.done, true);
});

// ───────────────────────────── 错误映射（冻结层） ─────────────────────────────

test('401 / 31001 被转为 NEED_LOGIN（api 层：code 与 bizCode 正确）', async () => {
  const { api } = makeApi(() => ({
    status: 401, body: { status: 401, code: 31001, message: 'require login [guest]' },
  }));

  const cases = [
    () => api.list({ pdirFid: '0' }),
    () => api.info('f1'),
    () => api.mkdir({ pdirFid: '0', name: 'd' }),
    () => api.rename({ fid: 'f', name: 'n' }),
    () => api.move({ fids: ['f'], toFid: 'd' }),
    () => api.copy({ fids: ['f'], toFid: 'd' }),
    () => api.remove({ fids: ['f'] }),
    () => api.taskStatus({ taskIds: ['t'] }),
    () => api.queryTask('t'),
  ];
  for (const fn of cases) {
    await assert.rejects(fn, (e) => {
      assert.ok(e instanceof QuarkError);
      assert.equal(e.code, ErrCode.NEED_LOGIN, '应为 NEED_LOGIN');
      assert.equal(e.bizCode, 31001);
      return true;
    });
  }
});

test('401 / 31001 经 IPC 表面（fs 层）上抛 NEED_LOGIN，且文案为中文', async () => {
  const { fs } = makeFs(() => ({
    status: 401, body: { status: 401, code: 31001, message: 'require login [guest]' },
  }));

  const cases = [
    () => fs.list({ pdirFid: '0' }),
    () => fs.info('f1'),
    () => fs.mkdir({ pdirFid: '0', name: 'd' }),
    () => fs.rename({ fid: 'f', name: 'n' }),
    () => fs.move({ fids: ['f'], toFid: 'd' }),
    () => fs.copy({ fids: ['f'], toFid: 'd' }),
    () => fs.remove({ fids: ['f'] }),
    () => fs.taskStatus({ taskIds: ['t'] }),
  ];
  for (const fn of cases) {
    await assert.rejects(fn, (e) => {
      assert.ok(e instanceof QuarkError);
      assert.equal(e.code, ErrCode.NEED_LOGIN, '应为 NEED_LOGIN');
      assert.equal(e.bizCode, 31001, 'bizCode 必须保留');
      assert.equal(e.raw.code, 31001, 'raw 必须保留原始响应');
      assert.match(e.message, /重新登录/, 'UI 文案必须为中文');
      return true;
    });
  }
});

test('服务端返回英文 message 时，IPC 表面必须改写为中文（code/raw 不变）', async () => {
  const { fs } = makeFs(() => ({
    status: 403, body: { status: 403, code: 31002, message: 'forbidden by policy' },
  }));
  await assert.rejects(() => fs.list({ pdirFid: '0' }), (e) => {
    assert.equal(e.code, ErrCode.FORBIDDEN);
    assert.equal(e.bizCode, 31002);
    assert.match(e.message, /[\u4e00-\u9fa5]/);
    assert.ok(!/forbidden/i.test(e.message), '不得把英文原文暴露给用户');
    assert.equal(e.raw.code, 31002);
    return true;
  });
});

test('服务端已返回中文 message 时保持原样（不覆盖更具体的提示）', async () => {
  const { fs } = makeFs(() => ({
    status: 400, body: { status: 400, code: 14001, message: '缺少参数 pdir_fid' },
  }));
  await assert.rejects(() => fs.list({ pdirFid: '0' }), (e) => {
    assert.equal(e.code, ErrCode.INVALID_ARG);
    assert.equal(e.message, '缺少参数 pdir_fid');
    return true;
  });
});

test('HTTP 401 无业务码时也判为 NEED_LOGIN', async () => {
  const { api } = makeApi(() => ({ status: 401, body: { message: 'unauthorized' } }));
  await assert.rejects(() => api.list({ pdirFid: '0' }), (e) => e.code === ErrCode.NEED_LOGIN);
});

test('业务码 31002/21001/14001/32003/500 由冻结层映射为语义化错误', async () => {
  const map = [
    [31002, 403, ErrCode.FORBIDDEN],
    [21001, 404, ErrCode.NOT_FOUND],
    [14001, 400, ErrCode.INVALID_ARG],
    [32003, 429, ErrCode.RATE_LIMIT],
    [32003, 409, ErrCode.CONFLICT],
    [500, 500, ErrCode.SERVER],
  ];
  for (const [bizCode, httpStatus, expected] of map) {
    const { api } = makeApi(() => ({
      status: httpStatus, body: { status: httpStatus, code: bizCode, message: '业务错误' },
    }));
    await assert.rejects(() => api.list({ pdirFid: '0' }), (e) => {
      assert.equal(e.code, expected, `code=${bizCode} http=${httpStatus} 应映射为 ${expected}`);
      assert.equal(e.raw.code, bizCode, 'err.raw 必须保留原始响应');
      return true;
    });
  }
});

test('错误信息为中文且带 code', async () => {
  const { api } = makeApi(() => ({ status: 500, body: { status: 500, code: 500, message: '' } }));
  await assert.rejects(() => api.list({ pdirFid: '0' }), (e) => {
    assert.equal(typeof e.code, 'string');
    assert.match(e.message, /[\u4e00-\u9fa5]/, '错误信息应包含中文');
    return true;
  });
});

// ───────────────────────────── modules/fs.js ─────────────────────────────

test('fs.list 透传 PageResult', async () => {
  const { fs } = makeFs(() => ({
    body: listEnvelope([{ fid: '1', file_name: 'a.txt', dir: 0, size: 1 }], 1),
  }));
  const r = await fs.list({ pdirFid: '0', page: 1, size: 50 });
  assert.deepEqual(Object.keys(r).sort(), ['hasMore', 'list', 'page', 'size', 'total']);
  assert.equal(r.list[0].name, 'a.txt');
});

test('fs 写操作返回 TaskAccepted（done 默认 true，不因缺 task_id 抛错）', async () => {
  const { fs } = makeFs(() => ({ body: { status: 200, code: 0, data: {} } }));
  assert.deepEqual(await fs.mkdir({ pdirFid: '0', name: 'd' }), { done: true });
  assert.deepEqual(await fs.rename({ fid: 'f', name: 'n' }), { done: true });
  assert.deepEqual(await fs.move({ fids: ['f'], toFid: 'd' }), { done: true });
  assert.deepEqual(await fs.copy({ fids: ['f'], toFid: 'd' }), { done: true });
  assert.deepEqual(await fs.remove({ fids: ['f'] }), { done: true });
});

test('fs.waitTask：全部完成后返回 done', async () => {
  const { fs, calls } = makeFs(() => ({
    body: { status: 200, code: 0, data: { list: [{ task_id: 't1', status: 'finish' }] } },
  }));

  const progress = [];
  const r = await fs.waitTask(['t1'], {
    interval: 1, timeout: 2000, onProgress: (p) => progress.push(p),
  });

  assert.equal(r.done, true);
  assert.deepEqual(r.pending, []);
  assert.ok(progress.length >= 1);
  assert.equal(progress[0].entries[0].status, 'finish', 'onProgress 应暴露原始 status');
  assert.equal(calls[0].path, '/1/clouddrive/task/status');
});

test('fs.waitTask：状态一直未确认 → 超时抛 TASK_FAILED 并附带原始响应', async () => {
  const { fs } = makeFs(() => ({
    body: { status: 200, code: 0, data: { list: [{ task_id: 't1', status: 42 }] } },
  }));

  await assert.rejects(
    () => fs.waitTask(['t1'], { interval: 1, timeout: 30 }),
    (e) => {
      assert.equal(e.code, ErrCode.TASK_FAILED);
      assert.match(e.message, /超时/);
      assert.match(e.message, /[\u4e00-\u9fa5]/);
      assert.ok(e.raw && Array.isArray(e.raw.lastResponse), 'err.raw 应带最后一次原始响应');
      assert.deepEqual(e.raw.pending, ['t1']);
      return true;
    }
  );
});

test('fs.waitTask：多任务部分完成时继续轮询，直到全部完成', async () => {
  let round = 0;
  const { fs } = makeFs(() => {
    round += 1;
    const list = round === 1
      ? [{ task_id: 't1', status: 'finish' }, { task_id: 't2', status: 3 }]
      : [{ task_id: 't2', status: 'finish' }];
    return { body: { status: 200, code: 0, data: { list } } };
  });

  const r = await fs.waitTask(['t1', 't2'], { interval: 1, timeout: 2000 });
  assert.equal(r.done, true);
  assert.deepEqual(r.pending, []);
  assert.ok(round >= 2, '第一轮只完成一个任务时应继续轮询');
});

test('fs.waitTask：NEED_LOGIN 直接上抛（不得被降级为 TASK_FAILED）', async () => {
  const { fs } = makeFs(() => ({
    status: 401, body: { status: 401, code: 31001, message: 'require login [guest]' },
  }));
  await assert.rejects(() => fs.waitTask(['t1'], { interval: 1, timeout: 500 }), (e) => {
    assert.equal(e.code, ErrCode.NEED_LOGIN);
    return true;
  });
});

test('fs.waitTask：空 taskIds 拒绝；已中止的 signal 立即 ABORTED', async () => {
  const { fs } = makeFs(() => ({}));
  await assert.rejects(() => fs.waitTask([]), (e) => e.code === ErrCode.INVALID_ARG);

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => fs.waitTask(['t1'], { signal: ac.signal, interval: 1, timeout: 100 }),
    (e) => e.code === ErrCode.ABORTED
  );
});

test('fs.waitTask：轮询途中 abort 能及时中断（不会等到超时）', async () => {
  const { fs } = makeFs(() => ({
    body: { status: 200, code: 0, data: { list: [{ task_id: 't1', status: 9 }] } },
  }));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const started = Date.now();
  await assert.rejects(
    () => fs.waitTask(['t1'], { signal: ac.signal, interval: 50, timeout: 10000 }),
    (e) => e.code === ErrCode.ABORTED
  );
  assert.ok(Date.now() - started < 3000, 'abort 后应迅速结束');
});

test('fs.listAll：内部翻页取全量并去重分页参数', async () => {
  const pages = {
    1: listEnvelope(new Array(2).fill(0).map((_, i) => ({ fid: `p1-${i}`, file_name: `f${i}.txt` })), 3),
    2: listEnvelope([{ fid: 'p2-0', file_name: 'f2.txt' }], 3),
  };
  const { fs, calls } = makeFs((url) => {
    const p = new URL(url).searchParams.get('_page');
    return { body: pages[p] || listEnvelope([], 3) };
  });

  const r = await fs.listAll({ pdirFid: '0', pageSize: 2 });

  assert.equal(r.list.length, 3);
  assert.equal(r.total, 3);
  assert.equal(r.hasMore, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query._page, '1');
  assert.equal(calls[0].query._size, '2');
  assert.equal(calls[1].query._page, '2');
});

test('fs.listAll：total 未知时空页终止（不死循环）', async () => {
  let n = 0;
  const { fs } = makeFs(() => {
    n += 1;
    return { body: { status: 200, code: 0, data: { list: n === 1 ? [{ fid: 'a', file_name: 'a' }] : [] }, metadata: {} } };
  });
  const r = await fs.listAll({ pdirFid: '0', pageSize: 1 });
  assert.equal(r.list.length, 1);
  assert.equal(r.hasMore, false);
  assert.equal(n, 2, '第二页空列表即终止');
});

test('fs 层：非 QuarkError 异常被包装为中文 QuarkError', async () => {
  const { fs } = makeFs(() => { throw new TypeError('boom'); });
  await assert.rejects(() => fs.list({ pdirFid: '0' }), (e) => {
    assert.ok(e instanceof QuarkError);
    assert.match(e.message, /[\u4e00-\u9fa5]/);
    assert.equal(typeof e.code, 'string');
    return true;
  });
});
