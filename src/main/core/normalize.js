'use strict';
/**
 * 响应归一化层 —— 把夸克服务端返回的原始记录翻译成 IPC_CONTRACT v1 的数据类型。
 *
 * 设计原则（对应 docs/API_NOTES.md 第 9 节"待确认清单"）：
 *   - 服务端字段的**类型与存在性均不可信**（`dir` 可能是 bool 也可能是 0/1，
 *     `category` 枚举未确认，`_total` 可能缺失）。因此本文件所有函数
 *     **永不抛异常**：任何异常输入一律降级为安全默认值。
 *   - 不做任何"猜测式"字段发明：只读 API_NOTES / OpenList 结构体中确认出现过的字段名。
 *
 * 证据：
 *   - OpenList `reference/openlist_quark_uc_util.go` L93 `file.FileName = html.UnescapeString(file.FileName)`
 *   - OpenList `reference/openlist_quark_uc_util.go` L96 `file.Category == 1`（视频）
 *   - OpenList `reference/openlist_quark_uc_types.go` L90-102 `SortResp`（data.list / metadata._total）
 *   - API_NOTES §4.1 文件记录字段清单
 */

/** HTML 实体反转义表。覆盖 OpenList `html.UnescapeString` 会处理的高频实体。 */
const HTML_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  times: '\u00d7',
  divide: '\u00f7',
  middot: '\u00b7',
});

/**
 * HTML 实体反转义。
 *
 * 为什么必须做：服务端把文件名中的 `&`、`'` 等字符以 HTML 实体形式下发
 * （如 `A&amp;B.mp4`），OpenList 在 L93 显式调用 `html.UnescapeString`。
 * 这里实现等价能力，且**不引入任何依赖**（不新增 npm 包）。
 *
 * 二次反转义（`&amp;lt;` → `&lt;`）的处理依据：
 *   `&amp;` 解码后得到的 `&` 属于原文本内容，不构成新实体，因此单趟扫描时
 *   已消费的片段不再回看 —— 这与 Go 的 `html.UnescapeString` 语义一致，
 *   避免 `&amp;lt;` 被错误地解成 `<`。
 *
 * @param {unknown} input
 * @returns {string}
 */
function unescapeHtml(input) {
  if (typeof input !== 'string' || input.indexOf('&') === -1) {
    return typeof input === 'string' ? input : '';
  }
  return input.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body) => {
    // 无分号结尾的实体（浏览器宽松解析）只对已知具名实体生效，避免误伤 "AT&T" 这类文本
    const hasSemicolon = whole.charAt(whole.length - 1) === ';';
    if (body.charAt(0) === '#') {
      if (!hasSemicolon) return whole;
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      // 代理区码点无法用 fromCodePoint 表达为单字符，直接放弃替换
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = HTML_ENTITIES[body];
    if (named !== undefined && hasSemicolon) return named;
    // ASCII 字母数字之外的具名实体（如 &nbsp 无分号）不处理，保持原样
    return whole;
  });
}

/** 宽松转字符串；对象/数组等一律降级为空串，避免 '[object Object]' 污染 UI。 */
function toStr(v, fallback = '') {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  return fallback;
}

/** 宽松转数字；`'123'`/`123`/`123n` 均可，其余（含 NaN/Infinity）归一到 fallback。 */
function toNum(v, fallback = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return fallback;
    const n = Number(t);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** 宽松布尔：true/1/'1'/'true'/'TRUE'/'yes'/'on' 均视为真。 */
function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : fallback;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === '') return fallback;
    if (t === 'true' || t === 'yes' || t === 'on') return true;
    if (t === 'false' || t === 'no' || t === 'off') return false;
    const n = Number(t);
    if (Number.isFinite(n)) return n !== 0;
    return fallback;
  }
  return fallback;
}

/**
 * 目录判定（宽松）。
 *
 * ⚠️ 待确认项 6：`dir` 究竟是布尔还是数字**未经真实账号实测**（API_NOTES §4.1）。
 * 因此做**分层判定，`dir` 存在时具有权威性**：
 *
 *   1. `dir` 存在且非 null → 宽松解析（true/1/'1'/'true'/'yes'/'on' 为真；
 *      false/0/'0'/'false'/'' 为假）并**直接返回该结果**。
 *      —— API_NOTES §4.1 把 `dir` 列为目录语义的主字段，客户端两份驱动也都以它为准。
 *   2. `dir` 缺失（undefined/null）时才使用辅助信号：
 *      - `file_type === 0` → 目录（OpenList 之外的两份第三方驱动一致观察）
 *      - OpenList 结构体 `File.File` 为 `false` → "不是文件" → 目录
 *        （注意方向：仅 `file === false` 才判目录，缺失时**不**参与判定）
 *
 * 该优先级很关键：若 `dir` 明确为 false 而 `file_type` 恰为 0，**以 `dir` 为准**，
 * 避免一个未确认的辅助信号推翻主字段。
 * 绝不使用 `!file` 这种"字段缺失即目录"的写法，也不读取无证据支撑的拼写变体（如 `is_dir`）。
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function isDir(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  if (!r) return false;

  // 1) 主信号：dir 存在即权威
  if (r.dir !== undefined && r.dir !== null) return toBool(r.dir, false);
  // 2) 辅助信号：file_type === 0 → 文件夹
  if (r.file_type !== undefined && r.file_type !== null && r.file_type !== '') {
    if (toNum(r.file_type, NaN) === 0) return true;
  }
  // 3) 辅助信号：OpenList 的 File.File（bool），false 表示目录
  if (typeof r.file === 'boolean' && r.file === false) return true;

  return false;
}

/**
 * 扩展名（小写，不含点）。无扩展名 / 非字符串 / 纯点文件名均返回 ''。
 * 规则：取最后一个 '.' 之后的部分；'.gitignore' 这类隐藏文件返回 ''（与常见约定一致）。
 * @param {unknown} name
 * @returns {string}
 */
function extOf(name) {
  const s = typeof name === 'string' ? name : '';
  if (!s) return '';
  const base = s.slice(s.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 把单条服务端记录归一化为 FileItem（docs/IPC_CONTRACT.md §1）。
 *
 * 容错要点：`raw` 为 null/undefined/数字/字符串/数组时返回一个字段齐备的空条目，
 * **绝不抛异常** —— 上层（分页、搜索、面包屑）因此无需 try/catch。
 *
 * @param {unknown} raw
 * @returns {{fid:string,name:string,dir:boolean,size:number,updatedAt:number,createdAt:number,category:number,ext:string,pdirFid:string}}
 */
function toFileItem(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  let name = unescapeHtml(r.file_name !== undefined ? r.file_name : r.name);
  if (!name) {
    // 兜底：服务端偶发只给 fid，缺名字时给一个明确占位符，避免 UI 出现空白行
    name = toStr(r.fid, '') ? '未命名' : '未命名';
  }

  const dir = isDir(r);
  const fid = toStr(r.fid, '');
  const pdirFid = toStr(r.pdir_fid !== undefined ? r.pdir_fid : r.pdirFid, '');
  return {
    fid,
    name,
    dir,
    // 目录的 size 语义无意义，统一为 0；待确认项 6 的降级方向
    size: dir ? 0 : Math.max(0, toNum(r.size, 0)),
    updatedAt: toNum(r.updated_at !== undefined ? r.updated_at : r.updatedAt, 0),
    createdAt: toNum(r.created_at !== undefined ? r.created_at : r.createdAt, 0),
    // category 枚举未确认（1=视频 已确认），缺失/非法一律 0=未知
    category: toNum(r.category, 0),
    ext: dir ? '' : extOf(name),
    pdirFid,
  };
}

/**
 * 批量归一化；非数组输入返回 `[]`。
 * @param {unknown} rawList
 * @returns {Array<ReturnType<typeof toFileItem>>}
 */
function toFileItems(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) out.push(toFileItem(item));
  return out;
}

/**
 * 宽松取"正整数"，非法（0、负数、NaN、不可解析）一律回落 fallback。
 * @param {unknown} v
 * @param {number} fallback
 */
function positiveInt(v, fallback) {
  const n = Math.floor(toNum(v, NaN));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * 从响应包络构造 PageResult（docs/IPC_CONTRACT.md §1）。
 *
 * 兼容三种 list 位置（均已在本机客户端/OpenList 中出现过）：
 *   1. `data.list`（首选；OpenList `SortResp.Data.List`）
 *   2. `data` 直接就是数组（部分老接口）
 *   3. `metadata.list`
 *
 * total：优先 `metadata._total`（OpenList `SortResp.Metadata.Total`），
 * 其次 `metadata.total` / 顶层 `total` / `data._total`；全部缺失 → -1（未知）。
 *
 * hasMore：total 已知时 `page * size < total`；total 未知时用"本页是否满页"推断
 * （`list.length === size`，且 size>0）。这是 task-2 规定的判定口径。
 *
 * @param {unknown} envelope 服务端包络，或已经是 { data:{list}, metadata } 形态的对象
 * @param {{page?:number,size?:number}} [opts]
 * @returns {{list:Array<object>,total:number,page:number,size:number,hasMore:boolean}}
 */
function toPageResult(envelope, opts = {}) {
  const page = positiveInt(opts.page, 1);
  const size = positiveInt(opts.size, 50);

  const env = envelope && typeof envelope === 'object' ? envelope : {};
  const data = env.data;

  let rawList = [];
  if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.list)) {
    rawList = data.list;
  } else if (Array.isArray(data)) {
    rawList = data;
  } else if (env.metadata && typeof env.metadata === 'object' && Array.isArray(env.metadata.list)) {
    rawList = env.metadata.list;
  } else if (Array.isArray(env.list)) {
    rawList = env.list;
  }

  const list = toFileItems(rawList);

  const meta = env.metadata && typeof env.metadata === 'object' ? env.metadata : {};
  const dataObj = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  let total = -1;
  for (const candidate of [meta._total, meta.total, env.total, dataObj._total]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const n = toNum(candidate, NaN);
    if (Number.isFinite(n)) {
      total = n;
      break;
    }
  }

  const hasMore = total >= 0 ? page * size < total : list.length === size;

  return { list, total, page, size, hasMore };
}

module.exports = {
  toFileItem,
  toFileItems,
  toPageResult,
  extOf,
  isDir,
  // 供 api-files / 测试复用的底层工具（不影响冻结契约）
  unescapeHtml,
  toNum,
  toStr,
  toBool,
  HTML_ENTITIES,
};
