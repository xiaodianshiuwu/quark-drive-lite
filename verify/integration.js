'use strict';
/**
 * Lead 独立集成验证 —— 不依赖任何开发者自带的测试。
 *
 * 目的：用**真实形状的假响应**把四个并行工作流的接缝处跑通，验证：
 *   1. 各模块能被正确 require（导出签名与冻结契约一致）
 *   2. session → http → fs → transfer 的装配可用
 *   3. 请求真的打到了正确的路径与参数上
 *   4. 返回对象的形状严格符合 docs/IPC_CONTRACT.md
 *   5. 登录失效（401/31001）能被正确识别并冒泡为 NEED_LOGIN
 *
 * 全程不发真实网络请求：monkey-patch globalThis.fetch。
 *
 * 运行： node verify/integration.js
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'main');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, error: e });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, error: e });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function tryRequire(rel) {
  try {
    return { mod: require(path.join(SRC, rel)), error: null };
  } catch (e) {
    return { mod: null, error: e };
  }
}

// ---------------------------------------------------------------------------
// 假响应基础设施
// ---------------------------------------------------------------------------
const calls = [];

/** 构造夸克标准成功包络 */
function ok(data, metadata) {
  return JSON.stringify({ status: 200, code: 0, message: 'ok', data, metadata });
}

/** 构造未登录包络（与实测一致：HTTP 401 + code 31001） */
function needLogin() {
  return JSON.stringify({
    status: 401,
    code: 31001,
    message: 'require login [guest]',
  });
}

function fakeResponse(bodyText, httpStatus = 200) {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    headers: {
      get: () => null,
      getSetCookie: () => [],
    },
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
    arrayBuffer: async () => Buffer.from(bodyText),
  };
}

/** 一个可编程的假 Quark 后端 */
function installFakeFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const rec = {
      url: u.toString(),
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      method: (init.method || 'GET').toUpperCase(),
      body: init.body ? safeParse(init.body) : undefined,
      headers: init.headers || {},
    };
    calls.push(rec);
    const r = handler(rec);
    if (r === undefined) {
      return fakeResponse(JSON.stringify({ status: 404, code: 404, message: 'no handler' }), 404);
    }
    return r;
  };
  return () => {
    globalThis.fetch = original;
  };
}

function safeParse(b) {
  if (typeof b !== 'string') return b;
  try {
    return JSON.parse(b);
  } catch {
    return b;
  }
}

function findCall(pred) {
  return calls.filter(pred);
}

// ---------------------------------------------------------------------------
// 一个真实形状的文件记录
// ---------------------------------------------------------------------------
const FILE_RECORD = {
  fid: 'fid_file_1',
  file_name: 'a&amp;b.txt',
  dir: false,
  size: 1234,
  file_type: 1,
  category: 0,
  updated_at: 1700000000000,
  created_at: 1699999999000,
  pdir_fid: '0',
};

const DIR_RECORD = {
  fid: 'fid_dir_1',
  file_name: '文档',
  dir: true,
  size: 0,
  file_type: 0,
  category: 0,
  updated_at: 1700000000000,
  created_at: 1699999999000,
  pdir_fid: '0',
};

// ---------------------------------------------------------------------------
(async () => {
  console.log('\x1b[1m=== 夸克网盘客户端 · Lead 集成验证 ===\x1b[0m');

  // -------------------------------------------------------------------------
  section('1. 模块可加载性（导出签名）');
  // -------------------------------------------------------------------------
  const errorsMod = tryRequire('core/errors.js');
  const httpMod = tryRequire('core/http.js');
  const storeMod = tryRequire('core/secure-store.js');
  const sessionMod = tryRequire('core/session.js');
  const loginMod = tryRequire('core/login.js');
  const accountMod = tryRequire('modules/account.js');
  const normalizeMod = tryRequire('core/normalize.js');
  const apiFilesMod = tryRequire('core/api-files.js');
  const fsMod = tryRequire('modules/fs.js');
  const apiTransferMod = tryRequire('core/api-transfer.js');
  const downloadMod = tryRequire('core/download.js');
  const uploadMod = tryRequire('core/upload.js');
  const transferMod = tryRequire('modules/transfer.js');
  const settingsMod = tryRequire('modules/settings.js');

  const modules = {
    'core/errors.js': errorsMod,
    'core/http.js': httpMod,
    'core/secure-store.js': storeMod,
    'core/session.js': sessionMod,
    'core/login.js': loginMod,
    'modules/account.js': accountMod,
    'core/normalize.js': normalizeMod,
    'core/api-files.js': apiFilesMod,
    'modules/fs.js': fsMod,
    'core/api-transfer.js': apiTransferMod,
    'core/download.js': downloadMod,
    'core/upload.js': uploadMod,
    'modules/transfer.js': transferMod,
    'modules/settings.js': settingsMod,
  };

  let allLoaded = true;
  for (const [name, r] of Object.entries(modules)) {
    if (r.error) {
      allLoaded = false;
      console.log(`  \x1b[31m✗\x1b[0m ${name} — 加载失败: ${r.error.message}`);
      fail += 1;
      failures.push({ name, error: r.error });
    } else {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      pass += 1;
    }
  }

  if (!allLoaded) {
    console.log('\n\x1b[33m部分模块缺失，跳过后续集成检查。\x1b[0m');
    summarize();
    return;
  }

  const { ErrCode, isNeedLogin } = errorsMod.mod;
  const { HttpClient } = httpMod.mod;

  // -------------------------------------------------------------------------
  section('2. 导出签名一致性');
  // -------------------------------------------------------------------------
  check('secure-store 导出 createSecureStore', () => {
    assert.strictEqual(typeof storeMod.mod.createSecureStore, 'function');
  });
  check('session 导出 createSession', () => {
    assert.strictEqual(typeof sessionMod.mod.createSession, 'function');
  });
  check('account 导出 createAccountModule', () => {
    assert.strictEqual(typeof accountMod.mod.createAccountModule, 'function');
  });
  check('normalize 导出 toFileItem/toPageResult/extOf', () => {
    assert.strictEqual(typeof normalizeMod.mod.toFileItem, 'function');
    assert.strictEqual(typeof normalizeMod.mod.toPageResult, 'function');
    assert.strictEqual(typeof normalizeMod.mod.extOf, 'function');
  });
  check('api-files 导出 createFilesApi', () => {
    assert.strictEqual(typeof apiFilesMod.mod.createFilesApi, 'function');
  });
  check('fs 导出 createFsModule', () => {
    assert.strictEqual(typeof fsMod.mod.createFsModule, 'function');
  });
  check('api-transfer 导出 createTransferApi/buildAuthMetaPut/buildAuthMetaComplete', () => {
    assert.strictEqual(typeof apiTransferMod.mod.createTransferApi, 'function');
    assert.strictEqual(typeof apiTransferMod.mod.buildAuthMetaPut, 'function');
    assert.strictEqual(typeof apiTransferMod.mod.buildAuthMetaComplete, 'function');
  });
  check('transfer 导出 createTransferModule', () => {
    assert.strictEqual(typeof transferMod.mod.createTransferModule, 'function');
  });

  // -------------------------------------------------------------------------
  section('3. 归一化（真实响应形状）');
  // -------------------------------------------------------------------------
  const { toFileItem, toPageResult, extOf } = normalizeMod.mod;

  check('HTML 实体反转义', () => {
    const item = toFileItem(FILE_RECORD);
    assert.strictEqual(item.name, 'a&b.txt', `实际: ${item.name}`);
  });
  check('目录宽松判定（true）', () => {
    assert.strictEqual(toFileItem(DIR_RECORD).dir, true);
  });
  check('目录宽松判定（1 与 "1"）', () => {
    assert.strictEqual(toFileItem({ ...DIR_RECORD, dir: 1 }).dir, true);
    assert.strictEqual(toFileItem({ ...DIR_RECORD, dir: '1' }).dir, true);
    assert.strictEqual(toFileItem({ ...DIR_RECORD, dir: false }).dir, false);
  });
  check('字段缺失不抛异常', () => {
    const item = toFileItem({});
    assert.strictEqual(typeof item.fid, 'string');
    assert.strictEqual(typeof item.size, 'number');
  });
  check('extOf 正确', () => {
    assert.strictEqual(extOf('a.TXT'), 'txt');
    assert.strictEqual(extOf('noext'), '');
  });
  check('toPageResult 分页 hasMore（total 已知）', () => {
    const env = { status: 200, code: 0, data: { list: [FILE_RECORD, DIR_RECORD] }, metadata: { total: 10 } };
    const p1 = toPageResult(env, { page: 1, size: 2 });
    assert.strictEqual(p1.list.length, 2);
    assert.strictEqual(p1.total, 10);
    assert.strictEqual(p1.hasMore, true);
    const p5 = toPageResult(env, { page: 5, size: 2 });
    assert.strictEqual(p5.hasMore, false);
  });

  // -------------------------------------------------------------------------
  section('4. 会话 + HTTP 装配');
  // -------------------------------------------------------------------------
  const os = require('os');
  const fsNode = require('fs');
  const tmpDir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'qk-verify-'));

  const store = storeMod.mod.createSecureStore({ userDataDir: tmpDir });
  const session = sessionMod.mod.createSession({ store }).load();

  // 注意：必须在 new HttpClient 之前装好假 fetch。
  // 虽然 http.js 已改为每次请求惰性解析 globalThis.fetch（不再在构造时 bind），
  // 但显式把打桩放在前面更能表达意图，也避免回归。
  let restore = installFakeFetch((rec) => {
    if (rec.path.endsWith('/file/sort')) {
      return fakeResponse(ok({ list: [FILE_RECORD, DIR_RECORD] }, { total: 2 }));
    }
    if (rec.path.endsWith('/file/search')) {
      // 只有参数名正确时才返回结果，用于验证搜索参数探测
      if (rec.query.q === 'hello') {
        return fakeResponse(ok({ list: [FILE_RECORD] }, { total: 1 }));
      }
      return fakeResponse(JSON.stringify({ status: 400, code: 14001, message: '缺少参数 q' }), 400);
    }
    if (rec.path.endsWith('/file/info/path_list')) {
      return fakeResponse(ok({ list: [{ fid: '0', file_name: '全部文件' }, { fid: 'fid_dir_1', file_name: '文档' }] }));
    }
    if (rec.path.endsWith('/file/info')) {
      return fakeResponse(ok(FILE_RECORD));
    }
    if (rec.path.endsWith('/file/rename')) {
      return fakeResponse(ok({}));
    }
    if (rec.path.endsWith('/file/move')) {
      return fakeResponse(ok({ task_id: 'task_move_1' }));
    }
    if (rec.path.endsWith('/file/copy')) {
      return fakeResponse(ok({ task_id: 'task_copy_1' }));
    }
    if (rec.path.endsWith('/file/delete')) {
      return fakeResponse(ok({ task_id: 'task_del_1' }));
    }
    if (rec.path.endsWith('/file') && rec.method === 'POST') {
      return fakeResponse(ok({ fid: 'fid_new_dir' }));
    }
    if (rec.path.endsWith('/task/status')) {
      return fakeResponse(ok({ list: [{ task_id: 'task_del_1', status: 2 }] }));
    }
    return undefined;
  });

  check('session 初始未登录', () => {
    assert.strictEqual(session.isLoggedIn(), false);
  });

  check('applySetCookie 合并且能删除过期项', () => {
    session.applySetCookie([
      'aaa=1; Path=/; Domain=.quark.cn',
      'bbb=2; Path=/; Max-Age=0',
      'ccc=3; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT',
    ]);
    const jar = session.getCookie();
    assert.ok(jar.includes('aaa=1'), `jar=${jar}`);
    assert.ok(!jar.includes('bbb='), `过期未删除: ${jar}`);
    assert.ok(!jar.includes('ccc='), `过期未删除: ${jar}`);
  });

  check('setCookies 覆盖（CDP 格式）能置为已登录', () => {
    session.setCookies([
      { name: '__puus', value: 'puus-token-1', domain: '.quark.cn' },
      { name: '__pus', value: 'pus-token-1', domain: '.quark.cn' },
    ]);
    assert.strictEqual(session.isLoggedIn(), true);
    assert.ok(session.getCookie().includes('__puus=puus-token-1'));
  });

  const http = new HttpClient({
    getCookie: () => session.getCookie(),
    onSetCookie: (sc) => session.applySetCookie(sc),
  });

  check('HttpClient 能构造且带 Cookie', () => {
    assert.strictEqual(typeof http.request, 'function');
  });

  // -------------------------------------------------------------------------
  section('5. 文件接口请求正确性（假 fetch）');
  // -------------------------------------------------------------------------
  const fsModule = fsMod.mod.createFsModule({ http });
  const api = apiFilesMod.mod.createFilesApi({ http });

  try {
    await checkAsync('list 返回 PageResult 且参数正确', async () => {
      calls.length = 0;
      const r = await fsModule.list({ pdirFid: '0', page: 1, size: 50 });
      assert.ok(Array.isArray(r.list), 'list 应为数组');
      assert.strictEqual(r.list.length, 2);
      assert.strictEqual(r.page, 1);
      assert.strictEqual(r.size, 50);
      assert.strictEqual(typeof r.hasMore, 'boolean');
      const c = findCall((x) => x.path.endsWith('/file/sort'));
      assert.strictEqual(c.length, 1, '应只发出一次 file/sort');
      assert.strictEqual(c[0].query.pdir_fid, '0');
      assert.strictEqual(c[0].query._page, '1');
      assert.strictEqual(c[0].query._size, '50');
      assert.strictEqual(c[0].query._fetch_total, '1');
      assert.ok(c[0].query._sort, '_sort 应存在');
      // 文件记录被归一化
      assert.strictEqual(r.list[0].name, 'a&b.txt');
    });

    await checkAsync('list 归一化出 dir 字段', async () => {
      const r = await fsModule.list({ pdirFid: '0', page: 1, size: 50 });
      const dir = r.list.find((x) => x.fid === 'fid_dir_1');
      assert.ok(dir, '应找到目录记录');
      assert.strictEqual(dir.dir, true);
    });

    await checkAsync('search 使用 q 参数并成功', async () => {
      calls.length = 0;
      const r = await fsModule.search({ keyword: 'hello', page: 1, size: 20 });
      assert.strictEqual(r.list.length, 1);
      const c = findCall((x) => x.path.endsWith('/file/search'));
      assert.ok(c.length >= 1, '应发出 file/search');
      assert.strictEqual(c[0].query.q, 'hello', '关键字参数名必须为 q');
    });

    await checkAsync('mkdir 请求体正确', async () => {
      calls.length = 0;
      await fsModule.mkdir({ pdirFid: '0', name: '新文件夹' });
      const c = findCall((x) => x.path.endsWith('/file') && x.method === 'POST');
      assert.strictEqual(c.length, 1);
      assert.strictEqual(c[0].body.pdir_fid, '0');
      assert.strictEqual(c[0].body.file_name, '新文件夹');
      assert.strictEqual(c[0].body.dir_path, '');
    });

    await checkAsync('rename 请求体正确', async () => {
      calls.length = 0;
      await fsModule.rename({ fid: 'fid_file_1', name: 'new.txt' });
      const c = findCall((x) => x.path.endsWith('/file/rename'));
      assert.strictEqual(c[0].body.fid, 'fid_file_1');
      assert.strictEqual(c[0].body.file_name, 'new.txt');
    });

    await checkAsync('move 使用 action_type=1(SYNC)', async () => {
      calls.length = 0;
      await fsModule.move({ fids: ['fid_file_1'], toFid: 'fid_dir_1' });
      const c = findCall((x) => x.path.endsWith('/file/move'));
      assert.strictEqual(c[0].body.action_type, 1, 'move 必须用 SYNC=1');
      assert.strictEqual(c[0].body.to_pdir_fid, 'fid_dir_1');
      assert.deepStrictEqual(c[0].body.filelist, ['fid_file_1']);
      assert.ok(!('lock_concurr_op' in c[0].body), '未确认的 lock_concurr_op 不应出现');
    });

    await checkAsync('copy 使用 action_type=2(ASYNC)', async () => {
      calls.length = 0;
      await fsModule.copy({ fids: ['fid_file_1'], toFid: 'fid_dir_1' });
      const c = findCall((x) => x.path.endsWith('/file/copy'));
      assert.strictEqual(c[0].body.action_type, 2, 'copy 必须用 ASYNC=2');
      assert.strictEqual(c[0].body.copy_source, 1);
    });

    await checkAsync('remove 使用 action_type=2(ASYNC) 且为批量', async () => {
      calls.length = 0;
      await fsModule.remove({ fids: ['a', 'b', 'c'] });
      const c = findCall((x) => x.path.endsWith('/file/delete'));
      assert.strictEqual(c[0].body.action_type, 2, 'delete 必须用 ASYNC=2');
      assert.deepStrictEqual(c[0].body.filelist, ['a', 'b', 'c'], '批量删除必须一次传全部 fid');
    });

    await checkAsync('taskStatus 请求体正确', async () => {
      calls.length = 0;
      await fsModule.taskStatus({ taskIds: ['task_del_1'] });
      const c = findCall((x) => x.path.endsWith('/task/status'));
      assert.deepStrictEqual(c[0].body.task_ids, ['task_del_1']);
    });

    await checkAsync('crumbs 可用', async () => {
      const crumbs = await fsModule.crumbs('fid_dir_1');
      assert.ok(Array.isArray(crumbs));
      assert.ok(crumbs.length >= 1);
      assert.strictEqual(typeof crumbs[0].fid, 'string');
      assert.strictEqual(typeof crumbs[0].name, 'string');
    });

    // -----------------------------------------------------------------------
    section('6. 登录失效识别（401 / 31001）');
    // -----------------------------------------------------------------------
    const restore2 = installFakeFetch(() => fakeResponse(needLogin(), 401));
    try {
      await checkAsync('list 在未登录时抛 NEED_LOGIN', async () => {
        let threw = null;
        try {
          await fsModule.list({ pdirFid: '0', page: 1, size: 10 });
        } catch (e) {
          threw = e;
        }
        assert.ok(threw, '应当抛出错误');
        assert.strictEqual(threw.code, ErrCode.NEED_LOGIN, `实际 code=${threw.code}`);
        assert.ok(isNeedLogin(threw), 'isNeedLogin 应识别');
        assert.ok(/登录/.test(threw.message), `错误信息应为中文且提及登录: ${threw.message}`);
      });
    } finally {
      restore2();
    }
  } finally {
    restore();
  }

  // -------------------------------------------------------------------------
  section('7. 上传签名 auth_meta 逐字节校验（对照参考实现）');
  // -------------------------------------------------------------------------
  const { buildAuthMetaPut } = apiTransferMod.mod;
  check('buildAuthMetaPut 与 OpenList 参考实现逐字节一致', () => {
    const mime = 'application/octet-stream';
    const ossDate = 'Wed, 01 Jan 2025 00:00:00 GMT';
    const bucket = 'test-bucket';
    const objKey = 'path/to/file.bin';
    const partNumber = 3;
    const uploadId = 'UPLOADID123';

    // 参考实现（reference/openlist_quark_uc_util.go L209-216）：
    //   `PUT\n\n{mime}\n{timeStr}\nx-oss-date:{timeStr}\nx-oss-user-agent:...\n/{bucket}/{objKey}?partNumber={n}&uploadId={id}`
    const expected =
      'PUT\n' +
      '\n' +
      `${mime}\n` +
      `${ossDate}\n` +
      `x-oss-date:${ossDate}\n` +
      'x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit\n' +
      `/${bucket}/${objKey}?partNumber=${partNumber}&uploadId=${uploadId}`;

    const actual = buildAuthMetaPut({ mime, ossDate, bucket, objKey, partNumber, uploadId });
    assert.strictEqual(actual, expected, `\n实际:\n${JSON.stringify(actual)}\n期望:\n${JSON.stringify(expected)}`);
  });

  const { buildAuthMetaComplete } = apiTransferMod.mod;
  check('buildAuthMetaComplete 与参考实现逐字节一致', () => {
    const contentMd5 = 'BASE64MD5==';
    const ossDate = 'Wed, 01 Jan 2025 00:00:00 GMT';
    const callbackBase64 = 'BASE64CALLBACK';
    const bucket = 'test-bucket';
    const objKey = 'path/to/file.bin';
    const uploadId = 'UPLOADID123';

    // 参考实现（L288-297）：
    //   `POST\n{md5}\napplication/xml\n{timeStr}\nx-oss-callback:{cb}\nx-oss-date:{timeStr}\nx-oss-user-agent:...\n/{bucket}/{objKey}?uploadId={id}`
    const expected =
      'POST\n' +
      `${contentMd5}\n` +
      'application/xml\n' +
      `${ossDate}\n` +
      `x-oss-callback:${callbackBase64}\n` +
      `x-oss-date:${ossDate}\n` +
      'x-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit\n' +
      `/${bucket}/${objKey}?uploadId=${uploadId}`;

    const actual = buildAuthMetaComplete({ contentMd5, ossDate, callbackBase64, bucket, objKey, uploadId });
    assert.strictEqual(actual, expected, `\n实际:\n${JSON.stringify(actual)}\n期望:\n${JSON.stringify(expected)}`);
  });

  // -------------------------------------------------------------------------
  section('8. 传输模块装配与异步不阻塞');
  // -------------------------------------------------------------------------
  const cfg = settingsMod.mod.createSettingsModule({ store });
  check('settings 默认值与范围钳制', () => {
    const s = cfg.get();
    assert.ok(typeof s.downloadDir === 'string' && s.downloadDir.length > 0);
    const clamped = cfg.set({ uploadConcurrency: 999, downloadConcurrency: -5, theme: 'dark' });
    assert.strictEqual(clamped.uploadConcurrency, 8);
    assert.strictEqual(clamped.downloadConcurrency, 1);
    assert.strictEqual(clamped.theme, 'dark');
  });

  await checkAsync('transfer.upload 立即返回（不阻塞）', async () => {
    const updates = [];
    const transfer = transferMod.mod.createTransferModule({
      http,
      fsModule,
      getDownloadDir: () => tmpDir,
      getConcurrency: () => ({ upload: 1, download: 1 }),
      onUpdate: (t) => updates.push(t),
      onError: () => {},
    });

    const t0 = Date.now();
    // 指向一个不存在的本地文件：入队仍须立即返回 id，错误稍后异步体现
    const ids = transfer.upload({ localPaths: [path.join(tmpDir, 'not-exist.bin')], pdirFid: '0' });
    const elapsed = Date.now() - t0;

    assert.ok(Array.isArray(ids), 'upload 应返回任务 id 数组');
    assert.strictEqual(ids.length, 1);
    assert.ok(elapsed < 500, `upload 不应阻塞（耗时 ${elapsed}ms）`);

    const list = transfer.list();
    assert.ok(Array.isArray(list), 'list 应返回数组');
    const task = list.find((t) => t.id === ids[0]);
    assert.ok(task, '任务应出现在列表中');
    for (const k of ['id', 'kind', 'name', 'size', 'transferred', 'status', 'attempts', 'createdAt', 'updatedAt']) {
      assert.ok(k in task, `TransferTask 缺少字段 ${k}`);
    }
    assert.strictEqual(task.kind, 'upload');

    await transfer.cancel(ids[0]).catch(() => {});
  });

  // -------------------------------------------------------------------------
  section('9. 清理');
  // -------------------------------------------------------------------------
  try {
    fsNode.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`  \x1b[32m✓\x1b[0m 临时目录已清理`);
    pass += 1;
  } catch (e) {
    console.log(`  \x1b[33m!\x1b[0m 临时目录清理失败: ${e.message}`);
  }

  summarize();

  function summarize() {
    console.log(`\n\x1b[1m=== 集成验证结果：${pass} 通过 / ${fail} 失败 ===\x1b[0m`);
    if (fail > 0) {
      console.log('\n\x1b[31m失败详情：\x1b[0m');
      for (const f of failures) {
        console.log(`  · ${f.name}: ${f.error.message}`);
      }
      process.exitCode = 1;
    }
  }
})().catch((e) => {
  console.error('\x1b[31m集成验证异常终止：\x1b[0m', e);
  process.exitCode = 1;
});
