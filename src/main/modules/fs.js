'use strict';
/**
 * 文件业务层（docs/IPC_CONTRACT.md §3 `window.qk.fs` 的主进程实现）。
 *
 * 职责：
 *   1. 透传 `core/api-files.js` 的接口封装（返回已归一化的 PageResult / FileItem / TaskAccepted）；
 *   2. 保证**任何异常都以 QuarkError 形式抛出**（中文 message + `code` + `raw`），
 *      且 `NEED_LOGIN` 一定向上冒泡 —— UI 依赖它展示"Cookie 已失效，请重新登录"提示条
 *      （IPC_CONTRACT §3 错误约定），因此**绝不能在此层吞掉**；
 *   3. 提供异步任务轮询 `waitTask` 与全量翻页 `listAll`（后者仅供内部/导出使用，
 *      UI 默认走分页 `list()`）。
 *
 * 冻结约束：不修改 core/http.js、core/errors.js；不新增 npm 依赖。
 */

const { QuarkError, ErrCode, BIZ_CODE_MAP } = require('../core/errors');
const { createFilesApi } = require('../core/api-files');
const { toNum } = require('../core/normalize');

/** 判断文本是否含中日韩表意文字。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 按 HTTP 状态码兜底的中文文案（仅当服务端 message 为英文时使用）。
 * 与冻结层 `errors.js` 的 HTTP 分支一一对应，**只换文案，不改 `code`**。
 */
const HTTP_STATUS_ZH = Object.freeze({
  401: '登录状态已失效，请重新登录',
  403: '没有权限执行该操作',
  404: '资源不存在',
  409: '目标位置已存在同名文件或目录',
  429: '请求过于频繁，请稍后再试',
  500: '服务端暂时不可用，请稍后重试',
});

/** 按规范化错误码兜底的中文文案。 */
const ERR_CODE_ZH = Object.freeze({
  [ErrCode.NEED_LOGIN]: '登录状态已失效，请重新登录',
  [ErrCode.FORBIDDEN]: '没有权限执行该操作',
  [ErrCode.NOT_FOUND]: '文件或目录不存在',
  [ErrCode.CONFLICT]: '目标位置已存在同名文件或目录',
  [ErrCode.INVALID_ARG]: '请求参数有误',
  [ErrCode.RATE_LIMIT]: '请求过于频繁，请稍后再试',
  [ErrCode.NETWORK]: '网络请求失败，请检查网络连接',
  [ErrCode.TIMEOUT]: '请求超时，请检查网络',
  [ErrCode.ABORTED]: '操作已取消',
  [ErrCode.TASK_FAILED]: '任务执行失败，请稍后重试',
  [ErrCode.SERVER]: '服务端暂时不可用，请稍后重试',
  [ErrCode.UNKNOWN]: '操作失败，请稍后重试',
});

/**
 * 保证面向用户的错误文案为中文。
 *
 * ⚠️ 这不是"错误码 refine"：`code` / `bizCode` / `httpStatus` / `raw` **原样保留**，
 * 只在服务端返回了**非中文** message（如 `require login [guest]`）时替换文案。
 *
 * 为什么必须做：IPC_CONTRACT §3 要求 `err.message` 是"中文可读文案"，
 * 而冻结层 `fromEnvelope()` 的设计是"服务端给了具体 message 就优先采用"，
 * 这在服务端返回英文时会直接把英文暴露到 UI。中文文案**取自冻结层的 `BIZ_CODE_MAP`**
 * （单一事实来源，不重复维护码表），HTTP 状态码与规范化码仅作兜底。
 *
 * @param {unknown} err
 * @returns {unknown}
 */
function localizeMessage(err) {
  if (!(err instanceof QuarkError)) return err;
  if (CJK_RE.test(err.message || '')) return err;

  let zh;
  if (err.bizCode === 32003 && err.httpStatus === 409) {
    // 32003 需按 HTTP 状态消歧（与冻结层一致），此时不能直接用 BIZ_CODE_MAP 的限流文案
    zh = HTTP_STATUS_ZH[409];
  }
  const mapped = err.bizCode !== undefined && err.bizCode !== null ? BIZ_CODE_MAP[err.bizCode] : undefined;
  if (!zh) zh = (mapped && mapped.message) || HTTP_STATUS_ZH[err.httpStatus] || ERR_CODE_ZH[err.code];
  if (!zh) return err;

  const out = new QuarkError(zh, {
    code: err.code, bizCode: err.bizCode, httpStatus: err.httpStatus, raw: err.raw,
  });
  if (err.cause) out.cause = err.cause;
  return out;
}

/** waitTask 默认轮询参数。 */
const DEFAULT_INTERVAL = 1000;    // 1s
const DEFAULT_TIMEOUT = 180000;   // 180s（task-2 规格）
/** 单次 sleep 上限，避免 interval 被传成超大值导致无法响应 abort。 */
const MAX_SLEEP_SLICE = 5000;
/** listAll 的安全上限：最多翻多少页，防止服务端 hasMore 恒为 true 造成死循环。 */
const LIST_ALL_MAX_PAGES = 500;

/** 可中止的 sleep。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new QuarkError('操作已取消', { code: ErrCode.ABORTED }));
      return;
    }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new QuarkError('操作已取消', { code: ErrCode.ABORTED }));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 创建文件业务模块。
 *
 * @param {{http: {get:Function, post:Function}}} deps
 *   `http` 为 core/http.js 的 `HttpClient` 实例（Lead 冻结）。
 * @returns {{
 *   list:Function, search:Function, info:Function, crumbs:Function,
 *   mkdir:Function, rename:Function, move:Function, copy:Function, remove:Function,
 *   taskStatus:Function, queryTask:Function, waitTask:Function, listAll:Function
 * }}
 */
function createFsModule({ http } = {}) {
  const api = createFilesApi({ http });

  /** 兜底包装：非 QuarkError 也转成中文 QuarkError；QuarkError（含 NEED_LOGIN）原样上抛。 */
  function wrap(fn) {
    return async function wrapped(...args) {
      try {
        return await fn(...args);
      } catch (e) {
        if (e instanceof QuarkError) {
          // NEED_LOGIN / ABORTED / ... 一律透传；仅确保文案为中文（code/raw 不变）
          throw localizeMessage(e);
        }
        throw new QuarkError('操作失败，请稍后重试', { code: ErrCode.UNKNOWN, raw: e });
      }
    };
  }

  /**
   * 轮询异步任务直到全部完成或超时。
   *
   * ⚠️⚠️ 降级原因（docs/API_NOTES.md §9 待确认项 3 —— 必须在代码中留痕）：
   *   `task/status` 返回的 `status` 数值枚举**从未在真实账号下观测过**
   *   （API_NOTES §5 L108-109 明确写着"实现须以'未知状态 → 继续轮询并设超时'的保守策略处理"）。
   *   因此本函数**不硬编码任何"成功 = 某个数字"的判定**，只承认两类语义无歧义的信号
   *   （见 api-files.js `isTaskDone`）：
   *     ① 布尔字段 `finish` / `done` / `success` 为 true；
   *     ② 字符串状态等于客户端常量 `finish`（API_NOTES §5 L106）。
   *   数值 status 一律**原样**通过 `onProgress` 暴露给调用方/界面展示，不做任何翻译。
   *   若服务端只给数值而不给上述信号，本函数不会误判成功，而是**一直轮询到超时**，
   *   并抛出 TASK_FAILED，`err.raw` 附带最后一次原始响应，便于排错与后续补录枚举。
   *
   * @param {string|string[]} taskIds 一个或多个任务 id
   * @param {object} [opts]
   * @param {number} [opts.interval=1000]  轮询间隔（毫秒）
   * @param {number} [opts.timeout=180000] 总超时（毫秒）
   * @param {AbortSignal} [opts.signal]    取消信号
   * @param {(p:{taskIds:string[],pending:string[],entries:Array,elapsed:number})=>void} [opts.onProgress]
   *        每轮回调；`entries[].status` 为**原始**状态值（数字或字符串）
   * @param {number} [opts.opType]         透传给 task/status 的 op_type（默认 1）
   * @returns {Promise<{done:true, entries:Array, pending:string[], elapsed:number}>}
   */
  async function waitTask(taskIds, opts = {}) {
    const ids = (Array.isArray(taskIds) ? taskIds : [taskIds])
      .filter((x) => typeof x === 'string' && x.trim() !== '');
    if (ids.length === 0) {
      throw new QuarkError('缺少要等待的任务 id', { code: ErrCode.INVALID_ARG });
    }

    // 显式传 0 表示"不等待"（interval）/ "立即超时"（timeout），必须与"未传"区分开
    const interval = Math.max(0, toNum(opts.interval, DEFAULT_INTERVAL));
    const timeout = Math.max(0, toNum(opts.timeout, DEFAULT_TIMEOUT));
    const signal = opts.signal;
    const opType = opts.opType;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    const startedAt = Date.now();
    const pending = new Set(ids);
    let lastEntries = [];

    for (;;) {
      if (signal && signal.aborted) {
        throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
      }

      // 冻结层已把网络/登录错误映射成 QuarkError，这里直接透传（NEED_LOGIN 必须冒泡）
      lastEntries = await api.taskStatus({ taskIds: [...pending], opType, signal });

      for (const entry of lastEntries) {
        if (entry && entry.done && entry.taskId) pending.delete(entry.taskId);
      }

      const elapsed = Date.now() - startedAt;
      if (onProgress) {
        try {
          onProgress({
            taskIds: ids,
            pending: [...pending],
            entries: lastEntries, // status 为原始值，未做任何枚举翻译
            elapsed,
          });
        } catch {
          /* 回调异常不得影响轮询主流程 */
        }
      }

      if (pending.size === 0) {
        return { done: true, entries: lastEntries, pending: [], elapsed };
      }

      if (elapsed >= timeout) {
        throw new QuarkError(
          `操作超时（已等待 ${Math.round(elapsed / 1000)} 秒），任务可能仍在后台执行，请稍后刷新查看`,
          { code: ErrCode.TASK_FAILED, raw: { lastResponse: lastEntries, pending: [...pending] } }
        );
      }
      // 单次 sleep 不超过剩余时间，且切片以便及时响应 abort
      const remaining = timeout - elapsed;
      const slice = Math.max(1, Math.min(interval, remaining, MAX_SLEEP_SLICE));
      await sleep(slice, signal);
    }
  }

  /**
   * 一次性取全量（内部翻页）。UI 默认走分页 `list()`，仅在需要"导出全部"等场景使用。
   *
   * @param {object} p 与 `list()` 同参，另支持：
   *   - `pageSize`（默认 100，注意服务端对 `_size` 有上限，客户端典型值 100）
   *   - `maxPages`（安全上限，默认 500，防止 hasMore 恒真导致死循环）
   *   - `onPage`（每页回调，可用于进度展示）
   * @returns {Promise<{list:Array, total:number, page:number, size:number, hasMore:boolean}>}
   *   PageResult；`pages`（实际翻页数）与 `truncated`（是否因安全上限提前结束）为
   *   **不可枚举**的附加字段，不影响契约字段的序列化与比较。
   */
  async function listAll(p = {}) {
    const size = Math.max(1, Math.floor(toNum(p.pageSize, 100)) || 100);
    const maxPages = Math.max(1, Math.floor(toNum(p.maxPages, LIST_ALL_MAX_PAGES)) || LIST_ALL_MAX_PAGES);
    const signal = p.signal;
    const onPage = typeof p.onPage === 'function' ? p.onPage : null;

    const all = [];
    let page = 1;
    let pages = 0;
    let total = -1;
    let hasMore = true;
    let truncated = false;

    while (hasMore) {
      if (signal && signal.aborted) {
        throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
      }
      const result = await api.list({
        pdirFid: p.pdirFid, page, size, sort: p.sort, cat: p.cat, signal,
      });
      total = result.total;
      pages += 1;
      for (const item of result.list) all.push(item);
      if (onPage) {
        try {
          onPage(result);
        } catch {
          /* 回调异常不影响翻页 */
        }
      }

      // 空页 = 结束（即使 total 未知）
      if (result.list.length === 0) {
        hasMore = false;
        break;
      }
      // total 已知且已取满 = 结束
      if (total >= 0 && all.length >= total) {
        hasMore = false;
        break;
      }
      if (pages >= maxPages) {
        truncated = true;
        hasMore = result.hasMore;
        break;
      }
      hasMore = result.hasMore;
      page += 1;
    }

    const out = {
      list: all,
      total: total >= 0 ? total : all.length,
      page: 1,
      size,
      hasMore: false,
    };
    Object.defineProperty(out, 'pages', { value: pages, enumerable: false });
    Object.defineProperty(out, 'truncated', { value: truncated, enumerable: false });
    return out;
  }

  return {
    // ── 与 docs/IPC_CONTRACT.md §3 一一对应的透传方法 ──
    /** @returns {Promise<{list:Array,total:number,page:number,size:number,hasMore:boolean}>} PageResult */
    list: wrap((p) => api.list(p)),
    /** @returns {Promise<{list:Array,total:number,page:number,size:number,hasMore:boolean}>} PageResult */
    search: wrap((p) => api.search(p)),
    /** @returns {Promise<object>} FileItem */
    info: wrap((fid) => api.info(fid)),
    /** @returns {Promise<Array<{fid:string,name:string}>>} Crumb[]（解析失败降级为根目录，不抛错） */
    crumbs: wrap((fid) => api.crumbs(fid)),
    /** @returns {Promise<{done:boolean,taskId?:string}>} TaskAccepted */
    mkdir: wrap((p) => api.mkdir(p)),
    /** @returns {Promise<{done:boolean,taskId?:string}>} TaskAccepted */
    rename: wrap((p) => api.rename(p)),
    /** @returns {Promise<{done:boolean,taskId?:string}>} TaskAccepted */
    move: wrap((p) => api.move(p)),
    /** @returns {Promise<{done:boolean,taskId?:string}>} TaskAccepted */
    copy: wrap((p) => api.copy(p)),
    /** @returns {Promise<{done:boolean,taskId?:string}>} TaskAccepted */
    remove: wrap((p) => api.remove(p)),
    /** @returns {Promise<Array<{taskId:string,status:number|string,done:boolean,raw:object}>>} */
    taskStatus: wrap((p) => api.taskStatus(p)),

    // ── 主进程内部/扩展能力（不属于 IPC 契约表面，但对外安全） ──
    /** 单任务查询（GET /1/clouddrive/task，API_NOTES §5）。 */
    queryTask: wrap((taskId) => api.queryTask(taskId)),
    waitTask,
    listAll,
  };
}

module.exports = { createFsModule, DEFAULT_INTERVAL, DEFAULT_TIMEOUT };
