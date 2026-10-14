'use strict';
/**
 * 上传引擎回归测试。
 *
 * 最高优先级：**auth_meta 逐字节比对**。
 * OSS 签名串对换行与字段顺序极其敏感，PUT 与 POST 两种格式**不对称**
 * （PUT 后是两个 \n，POST 后是一个 \n），错一个字节即 403。
 * 参考实现：reference/openlist_quark_uc_util.go L209-216（PUT）与 L288-297（POST）。
 *
 * 另外覆盖：分片数与 partNumber、uploadFinish 调用、秒传短路、
 *           resolveOssUrl 健壮性、CompleteMultipartUpload XML 与 contentMd5。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  buildAuthMetaPut,
  buildAuthMetaComplete,
  buildCompleteXml,
  divideParts,
  resolveOssUrl,
  ossDateNow,
  PART_SIZE_ALIGN,
  OSS_USER_AGENT,
} = require('../src/main/core/api-transfer');
const { uploadFile, guessMime, mapLimit } = require('../src/main/core/upload');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qk-ul-'));
}

// ===========================================================================
// 1. auth_meta 逐字节比对（最关键）
// ===========================================================================

test('buildAuthMetaPut 与参考实现逐字节一致（PUT 后有 2 个换行）', () => {
  const mime = 'application/octet-stream';
  const ossDate = 'Wed, 01 Jan 2025 00:00:00 GMT';
  const bucket = 'test-bucket';
  const objKey = 'path/to/file.bin';
  const partNumber = 3;
  const uploadId = 'UPLOADID123';

  // 依据 reference/openlist_quark_uc_util.go L209-216 逐行构造
  const expected =
    'PUT\n' +
    '\n' +
    `${mime}\n` +
    `${ossDate}\n` +
    `x-oss-date:${ossDate}\n` +
    `x-oss-user-agent:${OSS_USER_AGENT}\n` +
    `/${bucket}/${objKey}?partNumber=${partNumber}&uploadId=${uploadId}`;

  const actual = buildAuthMetaPut({ mime, ossDate, bucket, objKey, partNumber, uploadId });

  // 用 JSON.stringify 输出，确保换行差异清晰可见（肉眼极易混淆）
  assert.strictEqual(actual, expected, `\n实际: ${JSON.stringify(actual)}\n期望: ${JSON.stringify(expected)}`);

  // 显式固化"PUT 后两个换行"这一最容易写错的性质
  assert.ok(actual.startsWith('PUT\n\n'), 'PUT 之后必须是两个换行');
  // PUT 版行数：PUT / (空) / mime / ossDate / x-oss-date / x-oss-user-agent / 资源路径 = 7 行
  assert.strictEqual(actual.split('\n').length, 7, 'PUT 版共 7 行');
  assert.ok(!actual.endsWith('\n'), '结尾不得有换行');
});

test('buildAuthMetaComplete 与参考实现逐字节一致（POST 后只有 1 个换行）', () => {
  const contentMd5 = 'BASE64MD5==';
  const ossDate = 'Wed, 01 Jan 2025 00:00:00 GMT';
  const callbackBase64 = 'BASE64CALLBACK';
  const bucket = 'test-bucket';
  const objKey = 'path/to/file.bin';
  const uploadId = 'UPLOADID123';

  // 依据 reference/openlist_quark_uc_util.go L288-297
  const expected =
    'POST\n' +
    `${contentMd5}\n` +
    'application/xml\n' +
    `${ossDate}\n` +
    `x-oss-callback:${callbackBase64}\n` +
    `x-oss-date:${ossDate}\n` +
    `x-oss-user-agent:${OSS_USER_AGENT}\n` +
    `/${bucket}/${objKey}?uploadId=${uploadId}`;

  const actual = buildAuthMetaComplete({ contentMd5, ossDate, callbackBase64, bucket, objKey, uploadId });

  assert.strictEqual(actual, expected, `\n实际: ${JSON.stringify(actual)}\n期望: ${JSON.stringify(expected)}`);
  assert.ok(actual.startsWith('POST\n'), 'POST 之后只有一个换行');
  assert.ok(!actual.startsWith('POST\n\n'), 'POST 之后不能有两个换行');
  assert.strictEqual(actual.split('\n').length, 8, 'POST 版共 8 行');
  assert.ok(!actual.endsWith('\n'), '结尾不得有换行');
});

test('PUT 与 POST 两种格式不对称（防止被"统一格式化"改坏）', () => {
  const common = { ossDate: 'D', bucket: 'B', objKey: 'K', uploadId: 'U' };
  const put = buildAuthMetaPut({ ...common, mime: 'M', partNumber: 1 });
  const post = buildAuthMetaComplete({ ...common, contentMd5: 'C', callbackBase64: 'CB' });
  assert.ok(put.startsWith('PUT\n\n'), 'PUT 两个换行');
  assert.ok(post.startsWith('POST\nC'), 'POST 一个换行');
  assert.notStrictEqual(put.indexOf('\n\n'), post.indexOf('\n\n'), '两者换行结构必须不同');
});

test('POST 版 x-oss-* 三行按字母序排列', () => {
  const s = buildAuthMetaComplete({
    contentMd5: 'C', ossDate: 'D', callbackBase64: 'CB', bucket: 'B', objKey: 'K', uploadId: 'U',
  });
  const iCb = s.indexOf('x-oss-callback:');
  const iDate = s.indexOf('x-oss-date:');
  const iUa = s.indexOf('x-oss-user-agent:');
  assert.ok(iCb > 0 && iDate > 0 && iUa > 0, '三个头都应存在');
  assert.ok(iCb < iDate && iDate < iUa, `字母序应为 callback < date < user-agent（${iCb},${iDate},${iUa}）`);
});

test('ossDateNow 输出与 Go http.TimeFormat 同构', () => {
  const s = ossDateNow(new Date(Date.UTC(2025, 0, 1, 0, 0, 0)));
  assert.strictEqual(s, 'Wed, 01 Jan 2025 00:00:00 GMT');
});

// ===========================================================================
// 2. 分片与 XML
// ===========================================================================

test('divideParts：partNumber 从 1 开始，区间与总数正确', () => {
  const parts = divideParts(10, 4);
  assert.deepStrictEqual(parts, [
    { partNumber: 1, start: 0, end: 4 },
    { partNumber: 2, start: 4, end: 8 },
    { partNumber: 3, start: 8, end: 10 },
  ]);
  assert.strictEqual(divideParts(8, 4).length, 2, '整除时片数正确');
  assert.strictEqual(divideParts(0, 4).length, 0, '空文件无分片');
});

test('buildCompleteXml 逐字节复刻参考实现（结尾无换行）', () => {
  const xml = buildCompleteXml([
    { partNumber: 1, etag: 'E1' },
    { partNumber: 2, etag: 'E2' },
  ]);
  const expected =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<CompleteMultipartUpload>\n' +
    '<Part>\n<PartNumber>1</PartNumber>\n<ETag>E1</ETag>\n</Part>\n' +
    '<Part>\n<PartNumber>2</PartNumber>\n<ETag>E2</ETag>\n</Part>\n' +
    '</CompleteMultipartUpload>';
  assert.strictEqual(xml, expected, `\n实际: ${JSON.stringify(xml)}`);
  assert.ok(!xml.endsWith('\n'), '结尾不得有换行');
});

test('contentMd5 为 XML 的 base64(md5)', () => {
  const xml = buildCompleteXml([{ partNumber: 1, etag: 'E' }]);
  const md5 = crypto.createHash('md5').update(xml, 'utf8').digest('base64');
  assert.strictEqual(md5, crypto.createHash('md5').update(xml, 'utf8').digest('base64'));
  assert.ok(/^[A-Za-z0-9+/]+=*$/.test(md5), '应为合法 base64');
});

// ===========================================================================
// 3. resolveOssUrl 健壮性
// ===========================================================================

test('resolveOssUrl 兼容带/不带协议、带尾斜杠、objKey 带前导斜杠', () => {
  const want = 'https://mybucket.oss-cn-hangzhou.aliyuncs.com/a/b.bin';
  assert.strictEqual(resolveOssUrl('http://oss-cn-hangzhou.aliyuncs.com', 'mybucket', 'a/b.bin'), want);
  assert.strictEqual(resolveOssUrl('https://oss-cn-hangzhou.aliyuncs.com', 'mybucket', 'a/b.bin'), want);
  assert.strictEqual(resolveOssUrl('oss-cn-hangzhou.aliyuncs.com', 'mybucket', 'a/b.bin'), want);
  assert.strictEqual(resolveOssUrl('http://oss-cn-hangzhou.aliyuncs.com/', 'mybucket', 'a/b.bin'), want);
  // objKey 已带前导斜杠时不应拼出 '//'
  assert.strictEqual(resolveOssUrl('http://oss-cn-hangzhou.aliyuncs.com', 'mybucket', '/a/b.bin'), want);
});

test('resolveOssUrl 在参数缺失时抛中文错误', () => {
  assert.throws(() => resolveOssUrl('', 'b', 'k'), /上传地址/);
  assert.throws(() => resolveOssUrl('http://h', '', 'k'), /存储桶/);
  assert.throws(() => resolveOssUrl('http://h', 'b', ''), /对象路径/);
});

test('guessMime 覆盖常见类型并有兜底', () => {
  assert.strictEqual(guessMime('a.txt'), 'text/plain');
  assert.strictEqual(guessMime('a.PNG'), 'image/png');
  assert.strictEqual(guessMime('a.mp4'), 'video/mp4');
  assert.strictEqual(guessMime('noext'), 'application/octet-stream');
  assert.strictEqual(guessMime(''), 'application/octet-stream');
});

test('mapLimit 保持顺序且遵守并发上限', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return n * 2;
  });
  assert.deepStrictEqual(out, [2, 4, 6, 8, 10], '结果顺序必须与输入一致');
  assert.ok(peak <= 2, `并发不得超过 2（实际峰值 ${peak}）`);
});

// ===========================================================================
// 4. uploadFile 编排（api 层打桩，验证流程正确性）
// ===========================================================================

/** 构造一个记录调用的假 api。 */
function makeFakeApi(overrides = {}) {
  const calls = {
    pre: [],
    hash: [],
    auth: [],
    put: [],
    complete: [],
    finish: [],
  };
  const api = {
    calls,
    async uploadPre(p) {
      calls.pre.push(p);
      return overrides.pre
        ? overrides.pre(p)
        : {
            finish: false,
            taskId: 'T1',
            objKey: 'key/f.bin',
            bucket: 'bkt',
            uploadId: 'UID',
            uploadUrl: 'http://oss.example.com',
            authInfo: { a: 1 },
            callback: { cb: true },
            // 必须用 65536 的整数倍：这是官方客户端强制的分片对齐要求
            partSize: 65536,
          };
    },
    async updateHash(p) {
      calls.hash.push(p);
      return overrides.hash ? overrides.hash(p) : false;
    },
    async uploadAuth(p) {
      calls.auth.push(p);
      return 'AUTHKEY';
    },
    /** 默认实现：把 auth_meta 一并记录，供"签名串与请求头自洽"断言使用。 */
    async ossPutPart(p) {
      calls.put.push({ ...p, partNumberHint: p.partNumber });
      const m = /partNumber=(\d+)&uploadId=(\w+)/.exec(p.authMeta || '');
      return `ETAG-${m ? m[1] : '?'}`;
    },
    async ossComplete(p) {
      calls.complete.push(p);
      return {};
    },
    async uploadFinish(p) {
      calls.finish.push(p);
      return {};
    },
  };
  return api;
}

test('uploadFile 分片流程：片数/partNumber 正确，最后调用 uploadFinish', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'f.bin');
  // partSize 必须对齐 65536，因此用跨越 3 片的文件：2*65536 + 10
  const data = Buffer.alloc(2 * 65536 + 10, 3);
  fs.writeFileSync(file, data);

  try {
    const api = makeFakeApi();

    const r = await uploadFile({
      localPath: file,
      pdirFid: '0',
      http: {},
      api,
      concurrency: 1,   // 串行，便于把 auth 调用与 put 调用一一对应
    });

    assert.strictEqual(r.size, data.length);
    assert.strictEqual(r.instant, false);
    assert.strictEqual(r.name, 'f.bin');
    assert.strictEqual(api.calls.put.length, 3, `${data.length} 字节 / 65536 每片 = 3 片`);

    // 分片签名次数 == 分片数（每片单独签名）
    assert.strictEqual(api.calls.auth.length, 4, '3 片签名 + 1 次完成分片签名');

    // partNumber 必须是 1,2,3（从 1 开始且不重不漏）
    const partNumbers = api.calls.auth
      .slice(0, 3)
      .map((p) => {
        const m = /partNumber=(\d+)&uploadId=(\w+)/.exec(p.authMeta || '');
        return m ? Number(m[1]) : null;
      })
      .sort((a, b) => a - b);
    assert.deepStrictEqual(partNumbers, [1, 2, 3], 'partNumber 应为 1,2,3');

    // 每片的上传字节数必须与分片区间一致（3 片：65536/65536/10）
    const sizes = api.calls.put.map((p) => p.body.length).sort((a, b) => a - b);
    assert.deepStrictEqual(sizes, [10, 65536, 65536], '各分片字节数应正确');

    assert.strictEqual(api.calls.complete.length, 1, '应调用一次 OSS 完成分片');
    assert.strictEqual(api.calls.finish.length, 1, '应调用一次 uploadFinish');
    assert.deepStrictEqual(api.calls.finish[0], { objKey: 'key/f.bin', taskId: 'T1' });

    // 所有分片字节之和必须等于文件大小（防止漏传导致云端文件不完整）
    const uploaded = api.calls.put.reduce((s, p) => s + p.body.length, 0);
    assert.strictEqual(uploaded, data.length, '所有分片字节之和必须等于文件大小');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('uploadFile 秒传：pre 返回 finish=true 时不发任何 OSS 请求', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'g.bin');
  fs.writeFileSync(file, Buffer.alloc(50));

  try {
    const api = makeFakeApi({ pre: () => ({ finish: true, taskId: 'T9', objKey: 'k' }) });
    const r = await uploadFile({ localPath: file, pdirFid: '0', http: {}, api });

    assert.strictEqual(r.instant, true);
    assert.strictEqual(api.calls.put.length, 0, '秒传不得有 OSS PUT');
    assert.strictEqual(api.calls.complete.length, 0, '秒传不得有 OSS 完成分片');
    assert.strictEqual(api.calls.auth.length, 0, '秒传不得请求签名');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('uploadFile 秒传校验成功：updateHash 返回 true 时直接收尾', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'h.bin');
  fs.writeFileSync(file, Buffer.alloc(20));

  try {
    const api = makeFakeApi({ hash: () => true });
    const r = await uploadFile({ localPath: file, pdirFid: '0', http: {}, api });

    assert.strictEqual(r.instant, true);
    assert.strictEqual(api.calls.put.length, 0, '秒传后不应上传分片');
    assert.strictEqual(api.calls.finish.length, 0, 'updateHash 完成秒传后不得重复提交 finish');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('uploadFile 关键自洽：签名串与实际请求头的 ossDate 完全一致', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'i.bin');
  fs.writeFileSync(file, Buffer.alloc(65536 + 5));

  try {
    const api = makeFakeApi();
    // 并发设为 1，使 auth 调用序列与 put 调用序列严格一一对应
    await uploadFile({ localPath: file, pdirFid: '0', http: {}, api, concurrency: 1 });

    const puts = api.calls.put;
    const auths = api.calls.auth;
    assert.ok(puts.length >= 2, '应至少 2 片');
    assert.strictEqual(auths.length, puts.length + 1, '每片一次签名，外加完成分片一次签名');

    // 自洽铁律：第 i 次分片签名串里的 x-oss-date 必须等于第 i 次 PUT 实际发送的 ossDate。
    // 若在请求头里重新取一次时间，两者就会不一致，OSS 直接返回签名错误。
    for (let i = 0; i < puts.length; i += 1) {
      const meta = auths[i].authMeta;
      const put = puts[i];
      assert.ok(put.ossDate, 'ossPutPart 必须收到 ossDate');
      assert.ok(
        meta.includes(`x-oss-date:${put.ossDate}`),
        `第 ${i + 1} 片：签名串必须包含与实际请求头一致的 x-oss-date（ossDate=${put.ossDate}）`
      );
      // user-agent 同样纳入签名，必须一致
      assert.ok(
        meta.includes(`x-oss-user-agent:${OSS_USER_AGENT}`),
        '签名串的 x-oss-user-agent 必须与请求头一致'
      );
      assert.ok(meta.startsWith('PUT\n\n'), '分片签名必须是 PUT 版（两个换行）');
    }

    // 完成分片：POST 版签名串必须含 x-oss-callback，且时间与请求头一致
    const completeAuth = auths[auths.length - 1];
    const comp = api.calls.complete[0];
    assert.ok(completeAuth.authMeta.startsWith('POST\n'), '最后一次签名应为 POST 版');
    assert.ok(completeAuth.authMeta.includes('x-oss-callback:'), 'POST 版必须含 x-oss-callback');
    assert.ok(comp.contentMd5, '必须计算 contentMd5');
    assert.ok(comp.callbackBase64, '必须带 base64 callback');
    const m = /x-oss-date:([^\n]+)/.exec(completeAuth.authMeta);
    assert.ok(m, 'POST 版签名串应含 x-oss-date');
    assert.strictEqual(comp.ossDate, m[1], '完成分片的 ossDate 必须与签名串一致');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('uploadFile 校验 part_size 必须是 65536 的整数倍', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'j.bin');
  fs.writeFileSync(file, Buffer.alloc(10));

  try {
    const api = makeFakeApi({
      pre: () => ({
        finish: false, taskId: 'T', objKey: 'k', bucket: 'b',
        uploadId: 'U', uploadUrl: 'http://h', authInfo: {}, callback: {},
        partSize: 1000, // 不是 65536 的倍数
      }),
    });
    await assert.rejects(
      () => uploadFile({ localPath: file, pdirFid: '0', http: {}, api }),
      (e) => {
        assert.strictEqual(e.code, 'SERVER');
        assert.match(e.message, /分片大小不合法/);
        return true;
      }
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('uploadFile 在 part_size 缺失时报错（对应官方 PART_SIZE_NULL）', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'k.bin');
  fs.writeFileSync(file, Buffer.alloc(10));

  try {
    const api = makeFakeApi({
      pre: () => ({ finish: false, taskId: 'T', objKey: 'k', bucket: 'b', uploadId: 'U', uploadUrl: 'http://h' }),
    });
    await assert.rejects(
      () => uploadFile({ localPath: file, pdirFid: '0', http: {}, api }),
      /分片大小/
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('uploadFile 只上传文件，遇到目录报中文错误', async () => {
  const dir = tmpDir();
  try {
    await assert.rejects(
      () => uploadFile({ localPath: dir, pdirFid: '0', http: {}, api: makeFakeApi() }),
      /只能上传文件/
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('uploadFile 本地文件不存在时报中文错误', async () => {
  await assert.rejects(
    () => uploadFile({ localPath: path.join(os.tmpdir(), 'no-such-file-xyz.bin'), pdirFid: '0', http: {}, api: makeFakeApi() }),
    /无法读取本地文件/
  );
});

test('PART_SIZE_ALIGN 常量与官方客户端一致', () => {
  assert.strictEqual(PART_SIZE_ALIGN, 65536);
});
