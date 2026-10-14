'use strict';
/**
 * 夸克云盘「文件与目录 + 异步任务」接口封装。
 *
 * 铁律（docs/API_NOTES.md 开头）：**未在"官方客户端挖掘 / 本机实测 / OpenList 源码"
 * 三类来源中出现过的端点与参数，一律不得写进实现。** 因此本文件每个常量旁都标注了出处。
 *
 * 端点出处（API_NOTES §4）：
 *   /1/clouddrive/file/sort             列表分页   —— 客户端 sortableList；OpenList util L69-108
 *   /1/clouddrive/file/search           搜索       —— MINED_ENDPOINTS；关键字参数见下方说明
 *   /1/clouddrive/file/info             单文件详情 —— 客户端
 *   /1/clouddrive/file/info/path_list   路径链     —— 客户端
 *   /1/clouddrive/file                  新建文件夹 —— 客户端 createFolder
 *   /1/clouddrive/file/rename           重命名     —— 客户端 rename
 *   /1/clouddrive/file/move             移动       —— 客户端 move
 *   /1/clouddrive/file/copy             复制       —— 客户端 copy
 *   /1/clouddrive/file/delete           删除       —— 客户端 del
 * 端点出处（API_NOTES §5）：
 *   /1/clouddrive/task/status           批量查任务状态 —— 客户端 batchOperTaskStatus
 *   /1/clouddrive/task                  查单任务       —— 客户端 queryTask
 *
 * 冻结约束：
 *   - **不携带** `X-U-Drive-Secret-Auth`（那是隐私空间 secret 模块专用，API_NOTES §4）。
 *   - **不携带** `lock_concurr_op`（取值未经实测，API_NOTES 待确认项 4 → 省略，服务端有默认值）。
 *   - 不修改 core/http.js / core/errors.js（Lead 冻结）。
 */

const { QuarkError, ErrCode, isNeedLogin } = require('./errors');
const { toFileItem, toPageResult, toStr, toNum, toBool } = require('./normalize');

// ───────────────────────────── 端点常量 ─────────────────────────────

const PATH = Object.freeze({
  list: '/1/clouddrive/file/sort',
  search: '/1/clouddrive/file/search',
  info: '/1/clouddrive/file/info',
  pathList: '/1/clouddrive/file/info/path_list',
  createDir: '/1/clouddrive/file',
  rename: '/1/clouddrive/file/rename',
  move: '/1/clouddrive/file/move',
  copy: '/1/clouddrive/file/copy',
  delete: '/1/clouddrive/file/delete',
  taskStatus: '/1/clouddrive/task/status',
  task: '/1/clouddrive/task',
});

/**
 * 客户端要求的公共查询参数（`pr` / `fr` / `uc_param_str` / `device_model`）。
 *
 * ⚠️ 此处曾写死 `{pr:'ucpro', fr:'pc', uc_param_str:''}` 并断言"uc_param_str 必须传空串"——
 *   那是我只观察到匿名请求（未登录页面顺便发起的那几次）就下的结论，**是错的**。
 *   后续取证官方客户端 axios 拦截器后确认，真实客户端每个请求都携带：
 *     uc_param_str = 'dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt'
 *     device_model = getDeviceNameSync()
 *   因此改为统一复用 http.js 中按官方形态定义的 COMMON_QUERY，避免各模块各写一份而不一致。
 */
const { COMMON_QUERY } = require('./http');

/**
 * 移动用 SYNC(1)、删除/复制用 ASYNC(2)。
 *
 * 裁决理由（Lead 2026-10-11 裁决 + API_NOTES §4 L84-85）：
 *   第三方驱动之间对 `file/delete` 的 action_type 存在 1/2 两种写法
 *   （OpenList `quark_uc__driver.go` L122 用 1；`sjas_file.cs` L133 与 qp_svc_file.py L142 用 2），
 *   **以本机官方客户端实际代码为准**：客户端用 ASYNC(2) 做删除/复制、用 SYNC(1) 做移动。
 */
const ACTION_TYPE = Object.freeze({ SYNC: 1, ASYNC: 2 });

/** 列表默认排序（task-2 规格指定）。 */
const DEFAULT_SORT = 'file_type:asc,updated_at:desc';

/** 搜索分页默认值。 */
const DEFAULT_PAGE = 1;
const DEFAULT_SIZE = 50;

/**
 * 搜索只使用真实确认的 q 参数；keyword 已被 API_NOTES 第 4.2 节证伪。
 */
const SEARCH_KEY_CANDIDATES = Object.freeze(['q']);

// ───────────────────────────── 错误处理约定 ─────────────────────────────

/**
 * 错误一律由**冻结层** `core/errors.js` 统一映射，本文件不做任何"错误码 refine"。
 *
 * 依据（Lead 2026-10-11 裁决）：`errors.js` 已内建 `BIZ_CODE_MAP`
 *   （31001→NEED_LOGIN、31002→FORBIDDEN、14001→INVALID_ARG、21001→NOT_FOUND、
 *    32003 按 HTTP 409/429 消歧为 CONFLICT/RATE_LIMIT、500→SERVER）
 * 以及 HTTP 状态码兜底（401/403/404/409/429/400/5xx）。
 * 因此本层**只保证 QuarkError 原样冒泡、绝不被吞掉**；需要额外语义时由调用方按
 * `err.code` / `err.bizCode` / `err.httpStatus` 判断，`err.raw` 始终保留原始响应。
 */

// ───────────────────────────── 包络解析工具 ─────────────────────────────

/** 在包络中定位"记录数组"。兼容 data.list / data[] / metadata.list / list 四种形态。 */
function findListArray(env) {
  if (!env || typeof env !== 'object') return null;
  const data = env.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.list)) return data.list;
  if (env.metadata && typeof env.metadata === 'object' && Array.isArray(env.metadata.list)) {
    return env.metadata.list;
  }
  if (Array.isArray(env.list)) return env.list;
  return null;
}

/**
 * 归一化响应是否可用于搜索。
 *
 * 判据刻意保持**宽松**：只要包络没有明确报错、且能定位到记录数组，就认为该参数名可用。
 * 理由：搜索"无结果"本身也可能是合法的空列表；若把空列表当作"参数名错误"，
 * 会导致完全正常的空搜索结果被误判并触发多余的第二次请求。
 * 参数名真错时，服务端会返回非 0 的 code（或 HTTP 4xx，由冻结层抛错），不会返回空 list。
 */
function isUsableSearchEnvelope(env) {
  if (!env || typeof env !== 'object') return false;
  const code = env.code;
  if (code !== undefined && code !== null && toNum(code, NaN) !== 0) return false;
  const status = env.status;
  if (status !== undefined && status !== null && toNum(status, NaN) >= 400) return false;
  return findListArray(env) !== null;
}

/** 在包络中定位"单条记录对象"（info / queryTask 使用）。 */
function findRecordObject(env) {
  if (!env || typeof env !== 'object') return null;
  const data = env.data;
  if (Array.isArray(data)) return data.length ? data[0] : null;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.list)) return data.list.length ? data.list[0] : null;
    // data 自身即记录（含 task_id / fid / status 等字段）；
    // 空对象 `{}` 说明服务端未给记录 → 返回 null，交由调用方抛 NOT_FOUND，
    // 避免把空包络归一化成一条"空文件"污染 UI（这是实测中 404 场景的真实形态）。
    return Object.keys(data).length > 0 ? data : null;
  }
  if (env.metadata && typeof env.metadata === 'object' && Array.isArray(env.metadata.list)) {
    return env.metadata.list.length ? env.metadata.list[0] : null;
  }
  return null;
}

/** 从任意记录中取出 task id（兼容 task_id / taskId / task_ids[0]）。 */
function pickTaskId(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const direct = toStr(rec.task_id !== undefined ? rec.task_id : rec.taskId, '');
  if (direct) return direct;
  if (Array.isArray(rec.task_ids) && rec.task_ids.length) return toStr(rec.task_ids[0], '');
  return '';
}

/**
 * 由响应包络构造 TaskAccepted（docs/IPC_CONTRACT.md §1）。
 *
 * 关键事实（Lead 2026-10-11 修正，第三方驱动一致观察）：
 *   `mkdir` / `rename` / `move` / `delete` 的响应**不包含 task_id**。
 *   因此默认 `done: true`（= 已受理且无需轮询）；只有响应里确实出现 task_id 时才
 *   返回 `{ taskId, done: false }`。**绝不因为拿不到 task_id 而抛错。**
 *
 * 返回对象保持契约字段最少集：`{ done }` 或 `{ taskId, done }`。
 */
function toTaskAccepted(env) {
  const rec = findRecordObject(env) || {};
  const taskId = pickTaskId(rec) || toStr(env && env.task_id, '');
  if (taskId) return { taskId, done: false };
  return { done: true };
}

// ───────────────────────────── 参数校验 ─────────────────────────────

/**
 * 校验必填字符串。
 * @param {unknown} value
 * @param {string} label 中文标签，用于组装面向用户的错误文案
 * @param {{trim?: boolean}} [opts] 名称类字段用 `trim:false`，保留用户输入的首尾空格
 */
function requireString(value, label, opts = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QuarkError(`${label}不能为空`, { code: ErrCode.INVALID_ARG });
  }
  return opts.trim === false ? value : value.trim();
}

function requireFids(fids) {
  if (!Array.isArray(fids) || fids.length === 0) {
    throw new QuarkError('请先选择要操作的文件', { code: ErrCode.INVALID_ARG });
  }
  const out = [];
  for (const f of fids) {
    if (typeof f === 'string' && f.trim() !== '') out.push(f.trim());
  }
  if (out.length === 0) {
    throw new QuarkError('请先选择要操作的文件', { code: ErrCode.INVALID_ARG });
  }
  return out;
}

function normalizePageOpts(page, size) {
  const p = Number.isFinite(Number(page)) && Number(page) >= 1 ? Math.floor(Number(page)) : DEFAULT_PAGE;
  const s = Number.isFinite(Number(size)) && Number(size) >= 1 ? Math.floor(Number(size)) : DEFAULT_SIZE;
  return { page: p, size: s };
}

/** 把可选的 `cat` 过滤条件写入查询对象（空值一律省略）。 */
function setCat(query, cat) {
  if (cat === undefined || cat === null || cat === '') return query;
  query.cat = typeof cat === 'string' ? cat : String(cat);
  return query;
}

// ───────────────────────────── 主体 ─────────────────────────────

/**
 * 创建文件接口封装。
 *
 * @param {{http: {get:Function, post:Function}}} deps
 *   `http` 为 core/http.js 的 HttpClient 实例（Lead 冻结，直接复用）。
 * @returns {object} 见文件末尾 module.exports 上方的返回形状说明
 */
function createFilesApi({ http } = {}) {
  if (!http || typeof http.get !== 'function' || typeof http.post !== 'function') {
    throw new QuarkError('内部错误：缺少可用的 HTTP 客户端', { code: ErrCode.INVALID_ARG });
  }

  /** 搜索关键字参数的运行时探测结果（进程内缓存，避免每次搜索都试错）。 */
  let resolvedSearchKey = null;

  /**
   * 统一的调用包装：**只做兜底转换，不做语义 refine**。
   * 非 QuarkError 的异常（例如依赖注入被换成普通函数后抛出的 TypeError）统一包装成中文
   * QuarkError，避免把英文堆栈泄漏到 UI；QuarkError 一律原样上抛（保持 code/raw 不变）。
   */
  async function call(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof QuarkError) throw e;
      throw new QuarkError('操作失败，请稍后重试', { code: ErrCode.UNKNOWN, raw: e });
    }
  }

  // ── 列表（目录分页加载） ────────────────────────────────────────────
  /**
   * GET /1/clouddrive/file/sort
   * 参数：pdir_fid、_page、_size、_fetch_total=1、_sort、cat、fetch_all_file=1、fetch_risk_file_name=1
   * 出处：API_NOTES §4 表格首行（客户端 sortableList；OpenList util L73-79）。
   * @returns {Promise<{list:Array, total:number, page:number, size:number, hasMore:boolean}>} PageResult
   */
  async function list({ pdirFid, page, size, sort, cat, signal } = {}) {
    const { page: p, size: s } = normalizePageOpts(page, size);
    // 根目录 fid 为 "0"（IPC_CONTRACT §1），未传时按根目录处理
    const parent = pdirFid === undefined || pdirFid === null || pdirFid === '' ? '0' : requireString(pdirFid, '目录 fid');

    const query = {
      ...COMMON_QUERY,
      pdir_fid: parent,
      _page: p,
      _size: s,
      _fetch_total: 1,
      _sort: typeof sort === 'string' && sort.trim() !== '' ? sort.trim() : DEFAULT_SORT,
      fetch_all_file: 1,
      fetch_risk_file_name: 1,
    };
    setCat(query, cat);

    const env = await call(() => http.get(PATH.list, query, { signal }));
    return toPageResult(env, { page: p, size: s });
  }

  // ── 搜索 ────────────────────────────────────────────────────────────
  /**
   * GET /1/clouddrive/file/search
   *
   * 仅使用真实确认的 q 参数。网络或响应异常明确报错，不改用已证伪参数。
   * @returns {Promise<{list:Array, total:number, page:number, size:number, hasMore:boolean}>} PageResult
   *   另挂一个**不可枚举**的 `searchParam` 字段（记录本次实际生效的参数名，供排错/上报），
   *   不影响 JSON 序列化与 deepStrictEqual 比较。
   */
  async function search({ keyword, page, size, cat, signal } = {}) {
    const kw = requireString(keyword, '搜索关键字');
    const { page: p, size: s } = normalizePageOpts(page, size);
    const query = { ...COMMON_QUERY, q: kw, _page: p, _size: s, _fetch_total: 1 };
    setCat(query, cat);
    const env = await call(() => http.get(PATH.search, query, { signal }));
    if (!isUsableSearchEnvelope(env)) {
      throw new QuarkError('搜索响应缺少文件列表，暂时无法确认搜索结果', { code: ErrCode.SERVER, raw: env });
    }
    resolvedSearchKey = 'q';
    const result = toPageResult(env, { page: p, size: s });
    Object.defineProperty(result, 'searchParam', { value: 'q', enumerable: false });
    return result;
  }

  // ── 单文件详情 ──────────────────────────────────────────────────────
  /**
   * GET /1/clouddrive/file/info
   * 参数：fid、_fetch_full_path、need_profile_tags、kkkk=1
   * 出处：API_NOTES §4（客户端）；`kkkk` 为客户端同款的缓存击穿参数（取值恒为 1）。
   * @returns {Promise<object>} FileItem
   */
  async function info(fid, opts = {}) {
    const id = requireString(fid, '文件 fid');
    const env = await call(() => http.get(PATH.info, {
      ...COMMON_QUERY,
      fid: id,
      _fetch_full_path: 1,
      need_profile_tags: 1,
      kkkk: 1,
    }, { signal: opts.signal }));

    const rec = findRecordObject(env);
    if (!rec || typeof rec !== 'object') {
      throw new QuarkError('未找到该文件，可能已被删除或移动', {
        code: ErrCode.NOT_FOUND, raw: env,
      });
    }
    return toFileItem(rec);
  }

  // ── 路径链（面包屑） ────────────────────────────────────────────────
  /** 兜底面包屑：仅根目录。 */
  function rootCrumb() {
    return [{ fid: '0', name: '全部文件' }];
  }

  /**
   * GET /1/clouddrive/file/info/path_list
   * 参数：fid
   * 出处：API_NOTES §4（客户端）。
   *
   * 降级策略：**解析失败一律返回 [{fid:'0',name:'全部文件'}]，不抛错**（task-2 规格）。
   * 例外：NEED_LOGIN 与 ABORTED 仍然上抛 —— 前者用于触发"重新登录"提示条
   * （IPC_CONTRACT §3），若在此吞掉会导致登录态失效时 UI 无感知；后者是调用方主动取消。
   * @returns {Promise<Array<{fid:string,name:string}>>} Crumb[]
   */
  async function crumbs(fid) {
    const target = fid === undefined || fid === null || fid === '' ? '0' : toStr(fid, '0');
    if (target === '0') return rootCrumb(); // 根目录无需请求

    try {
      const env = await http.get(PATH.pathList, { ...COMMON_QUERY, fid: target });
      const rawList = findListArray(env);
      if (!Array.isArray(rawList) || rawList.length === 0) return rootCrumb();

      const out = [];
      for (const item of rawList) {
        if (!item || typeof item !== 'object') continue;
        const cfid = toStr(item.fid !== undefined ? item.fid : item.id, '');
        if (!cfid) continue;
        const name = toStr(item.file_name !== undefined ? item.file_name : item.name, '') || '全部文件';
        out.push({ fid: cfid, name });
      }
      return out.length ? out : rootCrumb();
    } catch (e) {
      if (e instanceof QuarkError) {
        if (isNeedLogin(e) || e.code === ErrCode.ABORTED) throw e;
      }
      return rootCrumb();
    }
  }

  // ── 新建文件夹 ──────────────────────────────────────────────────────
  /**
   * POST /1/clouddrive/file
   * body：{ pdir_fid, file_name, dir_path:'', dir_init_lock:false }
   * 出处：API_NOTES §4（客户端 createFolder；OpenList driver L74-79 同形）。
   * @returns {Promise<{done:boolean, taskId?:string}>} TaskAccepted
   */
  async function mkdir({ pdirFid, name } = {}) {
    const parent = pdirFid === undefined || pdirFid === null || pdirFid === '' ? '0' : requireString(pdirFid, '父目录 fid');
    const dirName = requireString(name, '文件夹名称');
    const env = await call(() => http.post(PATH.createDir, {
      pdir_fid: parent,
      file_name: dirName,
      dir_path: '',
      dir_init_lock: false,
    }, { query: COMMON_QUERY }));
    return toTaskAccepted(env);
  }

  // ── 重命名 ──────────────────────────────────────────────────────────
  /**
   * POST /1/clouddrive/file/rename
   * body：{ fid, file_name }
   * 出处：API_NOTES §4（客户端 rename；OpenList driver L106-109 同形）。
   *
   * 返回形状说明：docs/IPC_CONTRACT.md §3 标注 `Promise<void>`，而 Lead 2026-10-11 的
   * 集成契约要求 rename 返回 TaskAccepted（且响应无 task_id → `{done:true}`）。
   * 本实现返回 TaskAccepted —— `await fs.rename(...)` 的调用方不受影响（丢弃返回值即可）。
   * @returns {Promise<{done:boolean, taskId?:string}>} TaskAccepted
   */
  async function rename({ fid, name } = {}) {
    const id = requireString(fid, '文件 fid');
    // 名称保留原样（不 trim）：用户可能有意保留首尾空格，且服务端会做重名校验
    const newName = requireString(name, '新名称', { trim: false });
    const env = await call(() => http.post(PATH.rename, { fid: id, file_name: newName }, { query: COMMON_QUERY }));
    return toTaskAccepted(env);
  }

  // ── 移动 ────────────────────────────────────────────────────────────
  /**
   * POST /1/clouddrive/file/move
   * body：{ action_type: 1(SYNC), to_pdir_fid, filelist, exclude_fids: [] }
   * 出处：API_NOTES §4 + §4 L84-85（客户端用 SYNC(1) 做移动）。
   * 不携带 lock_concurr_op（待确认项 4）。
   * @returns {Promise<{done:boolean, taskId?:string}>} TaskAccepted
   */
  async function move({ fids, toFid } = {}) {
    const list_ = requireFids(fids);
    const to = requireString(toFid, '目标目录 fid');
    const env = await call(() => http.post(PATH.move, {
      action_type: ACTION_TYPE.SYNC,
      to_pdir_fid: to,
      filelist: list_,
      exclude_fids: [],
    }, { query: COMMON_QUERY }));
    return toTaskAccepted(env);
  }

  // ── 复制 ────────────────────────────────────────────────────────────
  /**
   * POST /1/clouddrive/file/copy
   * body：{ to_pdir_fid, filelist, action_type: 2(ASYNC), copy_source: 1 }
   * 出处：API_NOTES §4 + L84-85（客户端用 ASYNC(2) 做复制）。
   * @returns {Promise<{done:boolean, taskId?:string}>} TaskAccepted
   */
  async function copy({ fids, toFid } = {}) {
    const list_ = requireFids(fids);
    const to = requireString(toFid, '目标目录 fid');
    const env = await call(() => http.post(PATH.copy, {
      to_pdir_fid: to,
      filelist: list_,
      action_type: ACTION_TYPE.ASYNC,
      copy_source: 1,
    }, { query: COMMON_QUERY }));
    return toTaskAccepted(env);
  }

  // ── 删除 ────────────────────────────────────────────────────────────
  /**
   * POST /1/clouddrive/file/delete
   * body：{ action_type: 2(ASYNC), filelist, exclude_fids: [] }
   * 出处：API_NOTES §4 + L84-85（客户端用 ASYNC(2) 做删除）。
   * 不携带 lock_concurr_op（待确认项 4）；不携带 X-U-Drive-Secret-Auth（隐私空间专用）。
   * @returns {Promise<{done:boolean, taskId?:string}>} TaskAccepted
   */
  async function remove({ fids } = {}) {
    const list_ = requireFids(fids);
    const env = await call(() => http.post(PATH.delete, {
      action_type: ACTION_TYPE.ASYNC,
      filelist: list_,
      exclude_fids: [],
    }, { query: COMMON_QUERY }));
    return toTaskAccepted(env);
  }

  /**
   * 任务状态记录的"完成"判定。
   *
   * ⚠️ 待确认项 3：`status` / `op_type` 数值枚举**未经真实账号实测**，因此这里
   *   **不硬编码任何"成功=某个数字"的映射**，只承认两类语义无歧义的显式信号：
   *     1. 布尔字段 `finish === true` / `done === true` / `success === true`；
   *     2. 字符串状态等于客户端常量 `finish`（API_NOTES §5 L106：「状态常量 finish」）。
   *   数值 status 一律原样透出，交由调用方/界面展示（未知状态 → 继续轮询 + 超时）。
   */
  function isTaskDone(rec) {
    if (!rec || typeof rec !== 'object') return false;
    if (toBool(rec.finish, false) || toBool(rec.done, false) || toBool(rec.success, false)) return true;
    const st = rec.status;
    if (typeof st === 'string' && st.trim().toLowerCase() === 'finish') return true;
    return false;
  }

  /** 归一化单条任务记录 → { taskId, status, done, raw }。 */
  function toTaskEntry(rec) {
    const r = rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : {};
    return {
      taskId: pickTaskId(r),
      // status 原样透出：可能是数字也可能是字符串，枚举未确认前不做任何翻译
      status: r.status !== undefined && r.status !== null ? r.status : -1,
      done: isTaskDone(r),
      raw: r,
    };
  }

  // ── 批量查任务状态 ──────────────────────────────────────────────────
  /**
   * POST /1/clouddrive/task/status
   * body：{ task_ids, op_type }
   * 出处：API_NOTES §5（客户端 batchOperTaskStatus）。
   * opType 默认 1（API_NOTES §5 L107：客户端默认取 1；全枚举待确认项 3）。
   * @returns {Promise<Array<{taskId:string,status:number|string,done:boolean,raw:object}>>}
   */
  async function taskStatus({ taskIds, opType, signal } = {}) {
    const ids = Array.isArray(taskIds) ? taskIds.filter((x) => typeof x === 'string' && x.trim() !== '') : [];
    if (ids.length === 0) {
      throw new QuarkError('缺少要查询的任务 id', { code: ErrCode.INVALID_ARG });
    }
    const op = opType === undefined || opType === null ? 1 : toNum(opType, 1);

    const env = await call(() => http.post(PATH.taskStatus, { task_ids: ids, op_type: op }, { query: COMMON_QUERY, signal }));
    const rawList = findListArray(env);
    if (Array.isArray(rawList)) return rawList.map(toTaskEntry);

    const rec = findRecordObject(env);
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
      // 兼容 data 直接是 { task_id, status } 单条形态
      if (rec.task_id !== undefined || rec.status !== undefined) return [toTaskEntry(rec)];
    }
    return [];
  }

  // ── 查单任务 ────────────────────────────────────────────────────────
  /**
   * GET /1/clouddrive/task
   * 参数：task_id
   * 出处：API_NOTES §5（客户端 queryTask；轮询间隔默认 500ms）。
   * @returns {Promise<{taskId:string,status:number|string,done:boolean,raw:object}>}
   */
  async function queryTask(taskId) {
    const id = requireString(taskId, '任务 id');
    const env = await call(() => http.get(PATH.task, { ...COMMON_QUERY, task_id: id }));
    const rec = findRecordObject(env);
    if (!rec || typeof rec !== 'object') {
      throw new QuarkError('未找到该任务，可能已结束或被清理', { code: ErrCode.NOT_FOUND, raw: env });
    }
    return toTaskEntry(rec);
  }

  return {
    list,
    search,
    info,
    crumbs,
    mkdir,
    rename,
    move,
    copy,
    remove,
    taskStatus,
    queryTask,
    // 供 fs.js 与测试复用的内部工具 / 常量（不是 IPC 契约方法）
    _internals: {
      PATH, COMMON_QUERY, ACTION_TYPE, DEFAULT_SORT, SEARCH_KEY_CANDIDATES,
      toTaskAccepted, isTaskDone, toTaskEntry, findListArray, isUsableSearchEnvelope,
      /** 当前已探测到的搜索参数名（null = 尚未探测）；测试用 */
      getResolvedSearchKey: () => resolvedSearchKey,
      /** 重置探测缓存；测试用 */
      resetSearchKey: () => { resolvedSearchKey = null; },
    },
  };
}

module.exports = { createFilesApi, PATH, COMMON_QUERY, ACTION_TYPE, DEFAULT_SORT };
