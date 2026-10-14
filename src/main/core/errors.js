'use strict';
/**
 * 统一错误模型。
 *
 * 重要：夸克接口返回的业务码中，**只有在官方客户端代码或实测中确认过的**才会被
 * 映射为语义化错误码；其余一律归入 UNKNOWN 并保留原始 payload，绝不猜测。
 * 见 docs/API_NOTES.md 的“已确认 / 待确认”清单。
 */

/** 已确认：未登录 / Cookie 失效。实测 GET /1/clouddrive/config 未带 Cookie 时返回。 */
const CODE_NEED_LOGIN = 31001;

/**
 * 规范化错误码。key 为 'err.code' 的取值，UI 依赖这些字符串。
 */
const ErrCode = Object.freeze({
  NEED_LOGIN: 'NEED_LOGIN',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMIT: 'RATE_LIMIT',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_ARG: 'INVALID_ARG',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  TASK_FAILED: 'TASK_FAILED',
  LINK_EXPIRED: 'LINK_EXPIRED',
  /** 服务端未按 Range 返回分片数据（并行下载不可用，需降级为单流）。 */
  RANGE_UNSUPPORTED: 'RANGE_UNSUPPORTED',
  /** 网盘容量/配额不足（不是限流！见 BIZ_CODE_MAP 中 32003 的实测说明）。 */
  NO_SPACE: 'NO_SPACE',
  SERVER: 'SERVER',
  UNKNOWN: 'UNKNOWN',
});

/**
 * 已确认的业务错误码 → 规范化错误码。
 *
 * 证据来源：alist/OpenList Quark 驱动源码 + 官方客户端，详见 docs/API_NOTES.md 第 2 节。
 * **只收录已确认的码**；未确认的一律落到 UNKNOWN 并保留 raw，绝不猜测。
 */
const BIZ_CODE_MAP = Object.freeze({
  31001: { code: ErrCode.NEED_LOGIN, message: '登录状态已失效，请重新登录' },
  31002: { code: ErrCode.FORBIDDEN, message: '没有权限执行该操作' },
  14001: { code: ErrCode.INVALID_ARG, message: '请求参数有误' },
  21001: { code: ErrCode.NOT_FOUND, message: '文件或目录不存在' },
  22001: { code: ErrCode.UNKNOWN, message: '操作失败，请重试' },
  // 32003 语义依赖 HTTP 状态码：429=限流、409=冲突。此处仅给兜底文案。
  32003: { code: ErrCode.RATE_LIMIT, message: '请求过于频繁，请稍后再试' },
  500: { code: ErrCode.SERVER, message: '服务端暂时不可用，请稍后重试' },
});

/** 业务错误对象。message 直接面向用户（中文）。 */
class QuarkError extends Error {
  constructor(message, { code = ErrCode.UNKNOWN, bizCode, httpStatus, raw, cause } = {}) {
    super(message);
    this.name = 'QuarkError';
    this.code = code;
    this.bizCode = bizCode;     // 服务端原始 code
    this.httpStatus = httpStatus;
    this.raw = raw;             // 原始响应体，便于排错
    if (cause) this.cause = cause;
  }
}

/** 判断某个错误是否属于“必须重新登录”的类别。 */
function isNeedLogin(err) {
  return !!err && (err.code === ErrCode.NEED_LOGIN || err.bizCode === CODE_NEED_LOGIN);
}

/** 判断是否为可重试的瞬时错误（网络/超时/5xx/限流）。 */
function isRetryable(err) {
  if (!err) return false;
  if (err.code === ErrCode.NEED_LOGIN || err.code === ErrCode.ABORTED) return false;
  if (err.code === ErrCode.FORBIDDEN || err.code === ErrCode.NOT_FOUND) return false;
  if (err.code === ErrCode.INVALID_ARG || err.code === ErrCode.CONFLICT) return false;
  return (
    err.code === ErrCode.NETWORK ||
    err.code === ErrCode.TIMEOUT ||
    err.code === ErrCode.SERVER ||
    err.code === ErrCode.RATE_LIMIT
  );
}

/** 把字节数格式化成人类可读的中文单位。 */
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * 选择面向用户展示的文案。
 *
 * 背景（dev-session 实测复现）：31001 时服务端 message 是英文 `require login [guest]`，
 * 若直接透传会漏到中文界面上。但某些场景服务端会给出**更有信息量的中文提示**
 * （如 14001 会点名缺失的参数，形如「缺少参数 q」），这种应当保留。
 *
 * 策略：服务端 message 含中日韩字符 → 认为是已本地化的有效提示，优先采用；
 *       否则一律回退到我们自己的中文文案。
 *
 * @param {unknown} serverMessage 服务端原始 message
 * @param {string} fallback 我方中文文案
 * @returns {string}
 */
function preferredMessage(serverMessage, fallback) {
  if (typeof serverMessage !== 'string') return fallback;
  const m = serverMessage.trim();
  if (!m) return fallback;
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(m)) return m;
  return fallback;
}

/**
 * 把服务端响应包络翻译为 QuarkError。
 * 夸克包络形如：{ status, code, message, data, metadata }
 * 成功判定：status === 200 且 code === 0。
 *
 * 优先级：先按已确认的业务码映射（BIZ_CODE_MAP），再按 HTTP 状态码兜底。
 *
 * ⚠️ 32003 的实测结论（真实账号验证，2026-10）：
 *   原始响应为 {"status":400,"code":32003,"message":"capacity limit[{0}]",
 *               "metadata":{"missing_capacity":187622974108,"suggest_member_type":"SUPER_VIP"}}
 *   即 **网盘容量不足**，而非"请求过于频繁"。
 *   曾经把它一律映射为 RATE_LIMIT，会把用户引导到"稍后再试"这个错误方向，
 *   因此这里按 message / metadata 进一步区分；HTTP 429 才视为限流。
 */
function fromEnvelope(envelope, httpStatus) {
  const status = envelope && typeof envelope === 'object' ? envelope.status : undefined;
  const bizCode = envelope && typeof envelope === 'object' ? envelope.code : undefined;
  const message = (envelope && envelope.message) || '';
  const metadata = (envelope && typeof envelope === 'object' && envelope.metadata) || null;
  const raw = envelope;

  // ---- 32003 专判：容量不足 / 限流 需按 message 与 metadata 区分 ----
  if (bizCode === 32003) {
    const looksCapacity =
      /capacity/i.test(message) ||
      (metadata && typeof metadata === 'object' && metadata.missing_capacity !== undefined);
    if (looksCapacity) {
      const missing = Number(metadata && metadata.missing_capacity);
      const mb = Number.isFinite(missing) && missing > 0
        ? `还需约 ${formatBytes(missing)}`
        : '';
      const vip = metadata && metadata.suggest_member_type === 'SUPER_VIP' ? '，可考虑开通 SVIP 扩容' : '';
      return new QuarkError(
        `网盘容量不足${mb ? `（${mb}）` : ''}${vip}`,
        { code: ErrCode.NO_SPACE, bizCode, httpStatus, raw }
      );
    }
    if (httpStatus === 429) {
      return new QuarkError('请求过于频繁，请稍后再试', {
        code: ErrCode.RATE_LIMIT, bizCode, httpStatus, raw,
      });
    }
    // 其余 32003（409 等）按冲突处理
    if (httpStatus === 409) {
      return new QuarkError(preferredMessage(message, '目标位置已存在同名文件或目录'), {
        code: ErrCode.CONFLICT, bizCode, httpStatus, raw,
      });
    }
    return new QuarkError(preferredMessage(message, '操作未能完成，请稍后重试'), {
      code: ErrCode.UNKNOWN, bizCode, httpStatus, raw,
    });
  }

  // 1) 业务码优先（已确认的映射）
  const mapped = bizCode !== undefined ? BIZ_CODE_MAP[bizCode] : undefined;
  if (mapped) {
    return new QuarkError(preferredMessage(message, mapped.message), {
      code: mapped.code, bizCode, httpStatus, raw,
    });
  }

  // 2) HTTP 状态码兜底
  if (status === 401 || httpStatus === 401) {
    return new QuarkError(preferredMessage(message, '登录状态已失效，请重新登录'), {
      code: ErrCode.NEED_LOGIN, bizCode, httpStatus, raw,
    });
  }
  if (httpStatus === 403) {
    return new QuarkError(preferredMessage(message, '没有权限执行该操作'), {
      code: ErrCode.FORBIDDEN, bizCode, httpStatus, raw,
    });
  }
  if (httpStatus === 429) {
    return new QuarkError(preferredMessage(message, '请求过于频繁，请稍后再试'), {
      code: ErrCode.RATE_LIMIT, bizCode, httpStatus, raw,
    });
  }
  if (httpStatus === 409) {
    return new QuarkError(preferredMessage(message, '目标位置已存在同名文件或目录'), {
      code: ErrCode.CONFLICT, bizCode, httpStatus, raw,
    });
  }
  if (httpStatus === 404) {
    return new QuarkError(preferredMessage(message, '资源不存在'), {
      code: ErrCode.NOT_FOUND, bizCode, httpStatus, raw,
    });
  }
  if (httpStatus === 400) {
    return new QuarkError(preferredMessage(message, '请求参数有误'), {
      code: ErrCode.INVALID_ARG, bizCode, httpStatus, raw,
    });
  }
  if (httpStatus >= 500) {
    return new QuarkError(preferredMessage(message, '服务端暂时不可用'), {
      code: ErrCode.SERVER, bizCode, httpStatus, raw,
    });
  }
  return new QuarkError(preferredMessage(message, '操作失败'), {
    code: ErrCode.UNKNOWN, bizCode, httpStatus, raw,
  });
}

/** 包装网络层异常。 */
function asNetworkError(cause) {
  const aborted = cause && (cause.name === 'AbortError' || cause.code === 'ABORT_ERR');
  if (aborted) {
    return new QuarkError('操作已取消', { code: ErrCode.ABORTED, cause });
  }
  const timedOut = cause && (cause.name === 'TimeoutError' || cause.code === 'ETIMEDOUT');
  return new QuarkError(
    timedOut ? '请求超时，请检查网络' : '网络请求失败，请检查网络连接',
    { code: timedOut ? ErrCode.TIMEOUT : ErrCode.NETWORK, cause }
  );
}

module.exports = {
  ErrCode,
  QuarkError,
  CODE_NEED_LOGIN,
  BIZ_CODE_MAP,
  isNeedLogin,
  isRetryable,
  fromEnvelope,
  asNetworkError,
};
