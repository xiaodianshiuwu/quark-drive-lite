'use strict';
/**
 * 传输相关接口封装（上传 / 下载）。
 *
 * 所有端点均取自 docs/API_NOTES.md 第 6/7 节，证据来源为官方 PC 客户端 app.asar 与
 * OpenList `reference/openlist_quark_uc_util.go`（含行号）。**不包含任何臆造的端点或字段。**
 *
 * 本文件导出的 `buildAuthMetaPut` / `buildAuthMetaComplete` / `resolveOssUrl` 是纯函数，
 * 便于逐字节回归测试 —— OSS 签名串对换行与字段顺序极其敏感，错一个字节即 403。
 */

const { QuarkError, ErrCode } = require('./errors');

/** OSS 分片大小必须是 65536 的整数倍（官方客户端校验，见 renderer/index.js PART_SIZE_WRONG）。 */
const PART_SIZE_ALIGN = 65536;

/** OSS SDK 标识，必须与参考实现逐字一致，否则签名不匹配。 */
const OSS_USER_AGENT =
  'aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit';

const DEFAULT_PART_SIZE = 4 * 1024 * 1024; // 后续会被服务端返回的 part_size 覆盖

function zh(message, code, extra) {
  return new QuarkError(message, { code: code || ErrCode.UNKNOWN, ...(extra || {}) });
}

/**
 * 构造 OSS **PUT 分片** 的待签字符串（auth_meta）。
 *
 * 逐字节对应 reference/openlist_quark_uc_util.go L209-216：
 *   `PUT\n\n{mime}\n{timeStr}\nx-oss-date:{timeStr}\nx-oss-user-agent:{UA}\n/{bucket}/{objKey}?partNumber={n}&uploadId={id}`
 *
 * 注意第二行为**空行**（PUT 后面紧跟一个 \n\n），不可省略。
 */
function buildAuthMetaPut({ mime, ossDate, bucket, objKey, partNumber, uploadId }) {
  const m = mime || 'application/octet-stream';
  return (
    'PUT\n' +
    '\n' +
    `${m}\n` +
    `${ossDate}\n` +
    `x-oss-date:${ossDate}\n` +
    `x-oss-user-agent:${OSS_USER_AGENT}\n` +
    `/${bucket}/${objKey}?partNumber=${partNumber}&uploadId=${uploadId}`
  );
}

/**
 * 构造 OSS **POST 完成分片** 的待签字符串（auth_meta）。
 *
 * 逐字节对应 reference/openlist_quark_uc_util.go L288-297：
 *   `POST\n{contentMd5}\napplication/xml\n{timeStr}\nx-oss-callback:{cb}\nx-oss-date:{timeStr}\nx-oss-user-agent:{UA}\n/{bucket}/{objKey}?uploadId={id}`
 */
function buildAuthMetaComplete({ contentMd5, ossDate, callbackBase64, bucket, objKey, uploadId }) {
  return (
    'POST\n' +
    `${contentMd5}\n` +
    'application/xml\n' +
    `${ossDate}\n` +
    `x-oss-callback:${callbackBase64}\n` +
    `x-oss-date:${ossDate}\n` +
    `x-oss-user-agent:${OSS_USER_AGENT}\n` +
    `/${bucket}/${objKey}?uploadId=${uploadId}`
  );
}

/**
 * 健壮构造 OSS 直传 URL。
 *
 * 参考实现用 `pre.Data.UploadUrl[7:]` 硬切（假设以 `http://` 开头）。
 * 这里不照抄硬切，而是兼容 `http://`、`https://`、无协议三种形态，
 * 因为 upload_url 的形态未经真实账号实测（docs/API_NOTES.md 待确认项）。
 *
 * @returns {string} 形如 https://{bucket}.{host}/{objKey}
 */
function resolveOssUrl(uploadUrl, bucket, objKey) {
  if (typeof uploadUrl !== 'string' || !uploadUrl.trim()) {
    throw zh('服务端未返回上传地址，无法继续上传', ErrCode.SERVER);
  }
  let rest = uploadUrl.trim().replace(/\/+$/, '');
  // 去掉协议前缀
  rest = rest.replace(/^https?:\/\//i, '');
  if (!rest) throw zh('服务端返回的上传地址无效', ErrCode.SERVER);
  if (!bucket) throw zh('服务端未返回存储桶信息，无法继续上传', ErrCode.SERVER);
  if (!objKey) throw zh('服务端未返回对象路径，无法继续上传', ErrCode.SERVER);
  // objKey 可能已带前导斜杠，去掉以免拼出 `//`
  const key = String(objKey).replace(/^\/+/, '');
  return `https://${bucket}.${rest}/${key}`;
}

/** 把分片数据拼成 OSS CompleteMultipartUpload XML（参考实现 L266-279）。 */
function buildCompleteXml(parts) {
  let s = '<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n';
  for (const p of parts) {
    s += `<Part>\n<PartNumber>${p.partNumber}</PartNumber>\n<ETag>${p.etag}</ETag>\n</Part>\n`;
  }
  s += '</CompleteMultipartUpload>';
  return s;
}

/** 按 partSize 切分片区间，partNumber 从 1 开始（参考实现 L207-216 / L256-266）。 */
function divideParts(totalSize, partSize) {
  if (!(partSize > 0) || !(totalSize >= 0)) return [];
  const count = Math.ceil(totalSize / partSize);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * partSize;
    out.push({ partNumber: i + 1, start, end: Math.min(start + partSize, totalSize) });
  }
  return out;
}

/** OSS 请求使用的 UTC 时间格式：`Wed, 01 Jan 2025 00:00:00 GMT`。 */
function ossDateNow(d) {
  return (d || new Date()).toUTCString();
}

function createTransferApi({ http }) {
  if (!http) throw new Error('createTransferApi 需要 http 实例');

  // 复用 http.js 中按官方形态定义的公共查询参数（含 uc_param_str 与 device_model），
  // 保证上传/下载请求与官方一致（曾在此写死空 uc_param_str，与官方不符）。
  const COMMON = require('./http').COMMON_QUERY;

  return {
    // -----------------------------------------------------------------------
    // 下载
    // -----------------------------------------------------------------------
    /**
     * 取下载直链。POST /1/clouddrive/file/download，body {fids}。
     * 注意：响应 `data` 是**数组**（OpenList L113-137 / API_NOTES 第 7 节），
     * 取 `data[i].download_url`，不是 `data.download_url`。
     * @returns {Promise<Array<{fid:string,url:string}>>}
     */
    async downloadUrl(fids, opts = {}) {
      const list = Array.isArray(fids) ? fids.filter(Boolean) : [fids].filter(Boolean);
      if (!list.length) throw zh('没有需要下载的文件', ErrCode.INVALID_ARG);
      const env = await http.post('/1/clouddrive/file/download', { fids: list }, {
        query: COMMON,
        signal: opts.signal,
      });
      const data = env && env.data;
      const arr = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
      const out = [];
      for (let i = 0; i < arr.length; i += 1) {
        const rec = arr[i] || {};
        const url = rec.download_url || rec.url || '';
        if (url) out.push({ fid: list[i] || rec.fid || '', url });
      }
      if (!out.length) {
        throw zh('未能获取下载链接，请稍后重试', ErrCode.SERVER, { raw: env });
      }
      return out;
    },

    // -----------------------------------------------------------------------
    // 上传
    // -----------------------------------------------------------------------
    /**
     * 预登记。POST /1/clouddrive/file/upload/pre
     * body 依据 OpenList L170-188 与官方客户端：
     *   {ccp_hash_update, dir_name, file_name, format_type, l_created_at, l_updated_at, pdir_fid, size}
     */
    async uploadPre({ fileName, size, pdirFid, formatType, dirName }, opts = {}) {
      const now = Date.now();
      const env = await http.post(
        '/1/clouddrive/file/upload/pre',
        {
          ccp_hash_update: true,
          dir_name: dirName || '',
          file_name: fileName,
          format_type: formatType || 'application/octet-stream',
          l_created_at: now,
          l_updated_at: now,
          pdir_fid: pdirFid || '0',
          size: Number(size) || 0,
        },
        { query: COMMON, signal: opts.signal }
      );
      const d = (env && env.data) || {};
      const metadata = (env && env.metadata) || {};

      // 秒传：服务端直接说完成了
      if (d.finish === true) {
        return { finish: true, taskId: d.task_id || '', objKey: d.obj_key || '' };
      }

      const rawPartSize = metadata.part_size !== undefined ? metadata.part_size : d.part_size;
      const partSize = Number(rawPartSize);
      if (!Number.isFinite(partSize) || partSize <= 0) {
        // 官方客户端行为：PART_SIZE_NULL
        throw zh('服务端未返回分片大小，无法上传', ErrCode.SERVER, { raw: env });
      }
      if (partSize % PART_SIZE_ALIGN !== 0) {
        // 官方客户端行为：PART_SIZE_WRONG
        throw zh(
          `服务端返回的分片大小不合法（${partSize}，必须是 ${PART_SIZE_ALIGN} 的整数倍）`,
          ErrCode.SERVER,
          { raw: env }
        );
      }

      return {
        finish: false,
        taskId: d.task_id || '',
        objKey: d.obj_key || '',
        bucket: d.bucket || '',
        uploadId: d.upload_id || '',
        uploadUrl: d.upload_url || '',
        authInfo: d.auth_info,
        callback: d.callback,
        partSize,
      };
    },

    /** 秒传校验。POST /1/clouddrive/file/update/hash（OpenList L190-202）。返回 true 表示秒传成功。 */
    async updateHash({ md5, sha1, taskId }, opts = {}) {
      const env = await http.post(
        '/1/clouddrive/file/update/hash',
        { md5, sha1, task_id: taskId },
        { query: COMMON, signal: opts.signal }
      );
      return !!(env && env.data && env.data.finish);
    },

    /** 取 OSS 签名。POST /1/clouddrive/file/upload/auth（OpenList L204-225）。返回 auth_key。 */
    async uploadAuth({ taskId, authInfo, authMeta }, opts = {}) {
      const env = await http.post(
        '/1/clouddrive/file/upload/auth',
        { task_id: taskId, auth_info: authInfo, auth_meta: authMeta },
        { query: COMMON, signal: opts.signal }
      );
      const key = env && env.data && env.data.auth_key;
      if (!key) throw zh('未能获取上传签名，请重试', ErrCode.SERVER, { raw: env });
      return key;
    },

    /** 上传收尾。POST /1/clouddrive/file/upload/finish（OpenList L332-345 / 官方客户端）。 */
    async uploadFinish({ objKey, taskId }, opts = {}) {
      return http.post(
        '/1/clouddrive/file/upload/finish',
        { obj_key: objKey, task_id: taskId },
        { query: COMMON, signal: opts.signal }
      );
    },

    /**
     * OSS 直传 PUT 一个分片（OpenList L236-259）。
     * 返回该分片的 ETag。
     *
     * 重要：`cookies: false` —— OSS 不是夸克域，绝不能带上云盘 Cookie，
     * 同时避免注入 Referer/Origin 干扰 OSS 的签名与安全检查。
     */
    async ossPutPart({ url, authKey, mime, ossDate, body, signal, contentLength }) {
      const headers = {
        authorization: authKey,
        'content-type': mime || 'application/octet-stream',
        'x-oss-date': ossDate,
        'x-oss-user-agent': OSS_USER_AGENT,
      };
      if (Number.isFinite(contentLength) && contentLength >= 0) {
        headers['content-length'] = String(contentLength);
      }
      const res = await http.request({
        path: url,
        absolute: true,
        method: 'PUT',
        raw: true,
        cookies: false,
        headers,
        body,
        signal,
        retries: 0, // 分片级重试由上传引擎控制，避免叠加放大
        timeout: 180000,
      });
      const etag = res.headers.get('etag') || res.headers.get('ETag');
      if (typeof res.arrayBuffer === 'function') await res.arrayBuffer();
      if (!etag) throw zh('上传分片未返回 ETag', ErrCode.SERVER);
      return etag.replace(/^"|"$/g, '');
    },

    /**
     * OSS 完成分片 POST（OpenList L309-329）。
     * 必须带 Content-MD5、x-oss-callback、Content-Type: application/xml。
     */
    async ossComplete({ url, authKey, contentMd5, ossDate, callbackBase64, xml, signal }) {
      const res = await http.request({
        path: url,
        absolute: true,
        method: 'POST',
        raw: true,
        cookies: false,
        headers: {
          authorization: authKey,
          'content-md5': contentMd5,
          'content-type': 'application/xml',
          'x-oss-callback': callbackBase64,
          'x-oss-date': ossDate,
          'x-oss-user-agent': OSS_USER_AGENT,
        },
        body: xml,
        signal,
        retries: 0,
        timeout: 300000,
      });
      const text = typeof res.text === 'function' ? await res.text() : '';
      if (/<Error(?:\s|>)/i.test(text)) {
        throw zh('对象存储未能完成上传，请重试', ErrCode.SERVER, { raw: text });
      }
      return true;
    },
  };
}

module.exports = {
  createTransferApi,
  buildAuthMetaPut,
  buildAuthMetaComplete,
  buildCompleteXml,
  divideParts,
  resolveOssUrl,
  ossDateNow,
  PART_SIZE_ALIGN,
  OSS_USER_AGENT,
  DEFAULT_PART_SIZE,
};
