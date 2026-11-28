'use strict';
/**
 * src/renderer/app.js —— 视图层（纯原生 DOM，无框架）
 *
 * 依赖：window.QKAPI（api.js 提供），绝不直接访问 window.qk。
 * 只负责渲染与交互；所有网络/磁盘操作都交给桥接层。
 */

(function () {
  var API = window.QKAPI;

  /* ================================================================== *
   * 常量与状态
   * ================================================================== */

  var PAGE_SIZE = 100;
  var VIRTUAL_OVERSCAN = 8;      // 只挂载可见行及前后缓冲行
  var ROOT_FID = '0';
  var TASK_POLL_MS = 600;
  var TASK_POLL_MAX = 40;       // 最多轮询 40 次（约 24s）
  var DIR_CACHE_TTL = 45000;    // 目录 SWR 内存缓存 45 秒
  var DIR_CACHE_MAX = 30;       // 最多缓存 30 个目录
  var AUTO_REFRESH_MS = 60000;  // 文件列表每 60 秒后台静默刷新
  var QUOTA_REFRESH_MS = 90000; // 账号状态与剩余空间每 90 秒（1~2 分钟）后台同步一次
  var BULK_REFRESH_MS = 15000;  // 传输任务 >= 10 个时按 15 秒节流刷新
  var HUB_POLL_MS = 15 * 60 * 1000; // 开启作者服务器后每 15 分钟静默检测更新与作者新回复
  var DEFAULT_SORT = 'file_type:asc,updated_at:desc';

  var STATUS_TEXT = {
    pending: '等待中', running: '进行中', paused: '已暂停',
    error: '失败', done: '已完成', canceled: '已取消'
  };

  var state = {
    view: 'files',                 // files | recycle | transfers | chat | settings | feedback
    fid: ROOT_FID,                 // 当前目录
    crumbs: [{ fid: ROOT_FID, name: '全部文件' }],
    history: [],                   // 前进/后退导航栈
    historyIndex: -1,
    mode: 'browse',                // browse | search
    keyword: '',
    filter: 'all',                 // all | dir | image | video | doc | audio | archive
    sortBy: DEFAULT_SORT,
    viewMode: 'list',              // list | grid
    inspectorOpen: false,
    inspectorFid: '',
    focusIndex: -1,
    items: [],                     // 已加载的条目（按顺序）
    itemMap: {},                   // fid -> FileItem
    page: 0,
    hasMore: false,
    total: -1,
    loading: false,
    loadedOnce: false,
    selected: new Set(),
    lastIndex: -1,
    account: null,
    quota: null,
    appInfo: null,
    settings: {
      downloadDir: '',
      askDownloadDir: false,
      uploadConcurrency: 2,
      downloadConcurrency: 2,
      downloadParallel: 16,
      downloadStrategy: 'auto',
      uploadPartConcurrency: 3,
      theme: 'light',
      aiBetaEnabled: false,
      serverOptIn: false,
      serverPrompted: false,
      tutorialSeen: false,
      viewMode: 'list',
      sortBy: DEFAULT_SORT
    },
    hub: {
      config: null,
      checking: false,
      downloading: false,
      latest: null,
      downloadedPath: '',
      submittingFeedback: false,
      telemetrySent: false,
      feedbackItems: [],
      feedbackLoading: false,
      feedbackLoaded: false,
      feedbackError: '',
      replyingId: null,
      unreadReplies: 0,
      lastUpdateCheckAt: 0,
      dismissedUpdateVersion: '',
      dismissedNotice: ''
    },
    transfers: [],
    transfersLoaded: false,
    transferFilter: 'all',         // all | active | paused | done | error
    transfersDirty: false,
    recycle: {
      items: [],
      selected: new Set(),
      page: 0,
      hasMore: false,
      total: 0,
      loading: false,
      loadedOnce: false
    },
    expired: false,
    uploading: false,
    // Agent 接入面板状态（lastError 只保存文本，凭据文件内容一律不进渲染层）
    agent: {
      loaded: false,      // journal 是否拉过
      loading: false,     // status 加载互斥
      status: null,       // AgentStatus 对象或 null
      statusError: '',    // status 读取错误文案
      journal: [],        // JournalRecord[]（后端按时间正序返回）
      journalError: '',
      mcpText: '',        // stringify 后的 MCP 配置 JSON
      mcpError: ''
    },
    // 对话视图状态（status 不含 Key，只有 hasKey 布尔值）
    chat: {
      loaded: false, loading: false, status: null, statusError: '',
      history: [], historyError: '',
      sending: false, testing: false, saving: false, loadingModels: false,
      modelOptions: [],     // 「获取列表」拉到的模型名（填进 datalist）
      expanded: false,      // 已配置时用户是否手动展开了配置表单
      formError: '',
      round: null,          // 进行中的一轮：{ bubble, note, toolBox, tools, done }
      phase: 'idle',        // idle | busy | done | error
      curRound: 0, maxRounds: 0, runningTool: '',
      errorText: '', doneText: ''
    }
  };

  var el = {};
  var rowMap = new Map();          // fid -> row element (currently mounted)
  var rowPool = [];                // 离屏行节点复用池（减少快速滚动 GC）
  var transferMap = new Map();     // id  -> element
  var transferSigs = new Map();    // id  -> last render signature
  var dirCache = new Map();        // cacheKey -> { items, total, page, hasMore, ts }
  var dirDetailCache = new Map();  // fid -> { size, items, finished, ts }
  var dirDetailInflight = new Map(); // fid -> Promise
  var scrollPosMap = new Map();    // fid -> scrollTop
  var recentToasts = new Map();    // key -> timestamp (去重)
  var unsubs = [];
  var toastSeq = 0;
  var listSeq = 0;
  var recycleSeq = 0;
  var bulkDockTimer = null;
  var deferBulkDockOnce = false;
  var listVersion = 0;
  var lastRenderKey = '';
  var cachedRowHeight = 46;
  var listFrame = null;
  var transferSeq = 0;
  var prevTaskStatus = new Map();  // id -> previous status (驱动下载/上传完成自动刷新)
  var autoRefreshTimer = null;
  var quotaRefreshTimer = null;
  var hubPollTimer = null;
  var lastQuotaRefreshAt = 0;
  var quotaRefreshing = false;
  var quotaRefreshTicks = 0;
  var transferRefreshTimer = null;
  var transferRefreshLastAt = 0;
  var transferBatchWasBulk = false;
  var pendingFilesRefresh = false;
  var crumbEllipsisBtn = null;
  var topSpacer = null;
  var bottomSpacer = null;
  var inspectorSeq = 0;

  function $(id) { return document.getElementById(id); }

  /* ================================================================== *
   * 工具函数
   * ================================================================== */

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function icon(name, cls) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }

  function fmtSize(bytes) {
    var b = Number(bytes);
    if (!isFinite(b) || b < 0) return '—';
    if (b === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    var i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i += 1; }
    var v = i === 0 ? b : b.toFixed(b >= 100 ? 0 : (b >= 10 ? 1 : 2));
    return v + ' ' + units[i];
  }

  function fmtTime(ts) {
    var t = Number(ts);
    if (!isFinite(t) || t <= 0) return '—';
    var d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtSpeed(bps) {
    var v = Number(bps);
    if (!isFinite(v) || v <= 0) return '';
    return fmtSize(v) + '/s';
  }

  function fmtEta(sec) {
    var s = Number(sec);
    if (!isFinite(s) || s < 0) return '';
    if (s < 60) return '剩余 ' + Math.max(1, Math.round(s)) + ' 秒';
    if (s < 3600) return '剩余 ' + Math.round(s / 60) + ' 分钟';
    return '剩余 ' + (s / 3600).toFixed(1) + ' 小时';
  }

  /** 根据扩展名/分类选择图标。分类见契约：1 视频 2 图片 3 文档 4 音频 5 压缩包。 */
  function iconFor(item) {
    if (item.dir) return 'folder';
    var ext = String(item.ext || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff'].indexOf(ext) >= 0) return 'file-image';
    if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].indexOf(ext) >= 0) return 'file-video';
    if (ext === 'ts' && item.category === 1) return 'file-video';
    if (['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma'].indexOf(ext) >= 0) return 'file-audio';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'].indexOf(ext) >= 0) return 'file-archive';
    if (['js', 'ts', 'json', 'html', 'css', 'py', 'java', 'go', 'c', 'cpp', 'cs', 'sh', 'xml', 'yml', 'yaml', 'sql'].indexOf(ext) >= 0) return 'file-code';
    if (['txt', 'md', 'doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf'].indexOf(ext) >= 0) return 'file-doc';
    if (item.category === 1) return 'file-video';
    if (item.category === 2) return 'file-image';
    if (item.category === 3) return 'file-doc';
    if (item.category === 4) return 'file-audio';
    if (item.category === 5) return 'file-archive';
    return 'file';
  }

  function catClass(item) {
    if (item.dir) return 'cat-dir';
    var ic = iconFor(item);
    return 'cat-' + ic.replace('file-', '') || 'cat-other';
  }

  function itemFilterKey(item) {
    if (!item) return 'other';
    if (item.dir) return 'dir';
    var ic = iconFor(item);
    if (ic === 'file-image') return 'image';
    if (ic === 'file-video') return 'video';
    if (ic === 'file-audio') return 'audio';
    if (ic === 'file-archive') return 'archive';
    if (ic === 'file-doc' || ic === 'file-code') return 'doc';
    return 'other';
  }

  function displayItems() {
    if (state.filter === 'all') return state.items;
    return state.items.filter(function (it) { return itemFilterKey(it) === state.filter; });
  }

  function needsLoginState() {
    if (!API.injected) return false;
    var a = state.account;
    return !!(state.expired || !a || !a.loggedIn || a.expired);
  }

  function hasActiveOverlay() {
    if (!el.overlayRoot) return false;
    var kids = el.overlayRoot.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] && kids[i].classList && !kids[i].classList.contains('overlay-out')) return true;
    }
    return false;
  }

  async function copyText(text, label) {
    var value = String(text || '');
    if (!value) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        toast('ok', '已复制' + (label || '内容'));
        return;
      }
    } catch (_) { /* fallback below */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('ok', '已复制' + (label || '内容'));
    } catch (_) {
      toast('warn', '无法写入剪贴板，请手动复制');
    }
  }

  function dirCacheKey(fid, sortBy) {
    var uid = (state.account && state.account.userId) ? String(state.account.userId) : 'anon';
    return uid + '|' + String(fid) + '|' + String(sortBy || state.sortBy || DEFAULT_SORT);
  }

  function getCachedDir(fid, sortBy) {
    var key = dirCacheKey(fid, sortBy);
    var entry = dirCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > DIR_CACHE_TTL) {
      dirCache.delete(key);
      return null;
    }
    // LRU touch
    dirCache.delete(key);
    dirCache.set(key, entry);
    return entry;
  }

  function putCachedDir(fid, sortBy, data) {
    var key = dirCacheKey(fid, sortBy);
    if (dirCache.has(key)) dirCache.delete(key);
    while (dirCache.size >= DIR_CACHE_MAX) {
      var oldest = dirCache.keys().next().value;
      dirCache.delete(oldest);
    }
    dirCache.set(key, {
      items: data.items.slice(),
      total: data.total,
      page: data.page,
      hasMore: data.hasMore,
      ts: Date.now()
    });
  }

  function isArchiveItem(item) {
    if (!item || item.dir) return false;
    var ext = String(item.ext || '').toLowerCase();
    if (!ext && item.name) {
      var dot = String(item.name).lastIndexOf('.');
      if (dot > 0 && dot < item.name.length - 1) ext = item.name.slice(dot + 1).toLowerCase();
    }
    if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cbz', 'cbr'].indexOf(ext) >= 0) return true;
    return item.category === 5;
  }

  function fmtDuration(sec) {
    var s = Math.round(Number(sec) || 0);
    if (!isFinite(s) || s <= 0) return '';
    var hPart = Math.floor(s / 3600);
    var mPart = Math.floor((s % 3600) / 60);
    var sPart = s % 60;
    return hPart > 0
      ? (hPart + ':' + pad2(mPart) + ':' + pad2(sPart))
      : (pad2(mPart) + ':' + pad2(sPart));
  }

  function fmtSource(src) {
    var raw = String(src || '').trim();
    if (!raw) return '';
    var map = {
      UPLOAD: '手动上传',
      SAVE_AS: '分享转存',
      SAVE_AS_ALL: '分享转存',
      UNARCHIVE: '云端解压',
      BACKUP: '自动备份',
      BACKUP_ALL: '自动备份',
      SAVE_TO: '网盘收藏',
      AUTO: '自动归档',
      PC: '桌面端上传',
      WEB: '网页端上传',
      ANDROID: 'Android 上传',
      IOS: 'iOS 上传'
    };
    return map[raw.toUpperCase()] || raw;
  }

  var STORAGE_SRC_META = {
    UPLOAD: { label: '手动上传', color: '#336DF4' },
    SAVE_AS_ALL: { label: '分享转存', color: '#199E63' },
    BACKUP_ALL: { label: '设备备份', color: '#E08B19' },
    UNARCHIVE: { label: '云端解压', color: '#7B61FF' },
    SAVE_TO: { label: '收藏与保存', color: '#0EA5E9' },
    AUTO: { label: '自动保存', color: '#14B8A6' },
    SECRET_SPACE: { label: '私密空间', color: '#EC4899' },
    SHARED_ALBUM: { label: '共享相册', color: '#F97316' },
    OTHER: { label: '其他文件', color: '#64748B' }
  };

  function invalidateDirCache(fid) {
    if (fid === undefined || fid === null) {
      dirCache.clear();
      dirDetailCache.clear();
      dirDetailInflight.clear();
      return;
    }
    var keyStr = String(fid);
    dirDetailCache.delete(keyStr);
    dirDetailInflight.delete(keyStr);
    var needle = '|' + keyStr + '|';
    Array.from(dirCache.keys()).forEach(function (k) {
      if (k.indexOf(needle) >= 0) dirCache.delete(k);
    });
  }

  /* ================================================================== *
   * toast
   * ================================================================== */

  function toast(level, message, ms) {
    if (!message || !el.toasts) return;
    var lv = (level === 'warn' || level === 'error' || level === 'ok') ? level : 'info';
    var msgStr = String(message);
    var dedupKey = lv + '|' + msgStr;
    var nowTs = Date.now();
    if (recentToasts.has(dedupKey) && nowTs - recentToasts.get(dedupKey) < 1200) return;
    recentToasts.set(dedupKey, nowTs);
    if (recentToasts.size > 24) {
      recentToasts.forEach(function (t, k) { if (nowTs - t > 5000) recentToasts.delete(k); });
    }

    if (el.toasts.childElementCount >= 3) el.toasts.removeChild(el.toasts.firstChild);
    var node = h('div', 'toast toast-' + lv);
    var icName = lv === 'error' ? 'error' : (lv === 'warn' ? 'warn' : (lv === 'ok' ? 'check' : 'info'));
    var titleText = lv === 'error' ? '出错了' : (lv === 'warn' ? '注意' : (lv === 'ok' ? '已完成' : '提示'));
    node.appendChild(icon(icName, 'toast-ic'));
    var body = h('div', 'toast-body');
    body.appendChild(h('div', 'toast-title', titleText));
    body.appendChild(h('div', 'toast-msg', msgStr));
    node.appendChild(body);
    var close = h('button', 'toast-close');
    close.type = 'button';
    close.title = '关闭';
    close.appendChild(icon('close'));
    close.addEventListener('click', function () { remove(); });
    node.appendChild(close);
    el.toasts.appendChild(node);
    var id = ++toastSeq;
    node.dataset.toastId = String(id);
    var duration = ms || (lv === 'error' ? 5600 : 3000);
    var timer = setTimeout(remove, duration);
    node.addEventListener('mouseenter', function () { clearTimeout(timer); });
    node.addEventListener('mouseleave', function () {
      clearTimeout(timer);
      timer = setTimeout(remove, 1500);
    });
    function remove() {
      clearTimeout(timer);
      if (!node.parentNode) return;
      node.classList.add('toast-out');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 160);
    }
  }

  function recordDiag(level, category, code, msg, extra) {
    try {
      if (API.injected && API.has('hub', 'recordEvent')) {
        var payload = {
          level: level || 'info',
          category: category || 'ui',
          code: code || undefined,
          msg: String(msg || '').slice(0, 280)
        };
        if (extra && typeof extra === 'object') {
          if (extra.httpStatus) payload.httpStatus = extra.httpStatus;
          if (extra.bizCode !== undefined && extra.bizCode !== null) payload.bizCode = extra.bizCode;
          if (extra.durationMs !== undefined && extra.durationMs !== null) payload.durationMs = extra.durationMs;
          if (extra.meta && typeof extra.meta === 'object') payload.meta = extra.meta;
        }
        API.hub.recordEvent(payload).catch(function () {});
      }
    } catch (_) {}
  }

  /** 将底层技术错误转译为用户易懂的中文原因与操作建议（保留原有明确中文提示，仅兜底生硬报错）。 */
  function friendlyErrorMessage(err, fallback) {
    var code = (err && err.code) ? String(err.code) : '';
    var rawMsg = (err && err.message) ? String(err.message).trim() : '';
    var biz = err && err.bizCode;
    var hasReadableZh = /[\u4e00-\u9fa5]{4,}/.test(rawMsg)
      && !/^(请求失败|操作失败|服务异常|未知错误|HTTP \d+|SERVER|NETWORK|TIMEOUT|LOCAL_IO|PARSE|CONFLICT)$/i.test(rawMsg);

    if (API.isNeedLogin(err) || code === 'NEED_LOGIN') {
      return '登录状态已失效，请重新扫码登录';
    }
    if (biz === 15000 || (code === 'SERVER' && /15000/.test(rawMsg))) {
      return '夸克云端处理超时（该目录内容较多时可能出现），请稍后再试';
    }
    if (code === 'RATE_LIMIT') {
      return '操作稍微有点快，夸克服务器暂时限流，请等几秒再试';
    }
    if (code === 'NO_SPACE') {
      return '云盘剩余空间不足，请清理文件或清空回收站后再试';
    }
    if (code === 'ARCHIVE_DAMAGED') {
      return '这个压缩包可能已损坏，暂时无法在线解压';
    }
    if (code === 'ARCHIVE_NEED_PWD' || code === 'ARCHIVE_PASSWORD') {
      return '这个压缩包已加密，请输入解压密码后再试';
    }
    if (code === 'ARCHIVE_PWD_ERROR') {
      return '解压密码不对，请核对后重新输入';
    }
    if (code === 'ARCHIVE_TOO_LARGE' || code === 'ARCHIVE_LIMIT') {
      return '压缩包体积或解压次数已超出当前账号云解压上限';
    }
    if (code === 'ARCHIVE_UNSUPPORTED') {
      return '暂不支持在线云解压该压缩格式，建议下载到本地解压';
    }
    if (code === 'ARCHIVE_TOO_MANY_FILES') {
      return '压缩包内文件数量过多，超出了云端在线解压限制';
    }
    if (code === 'STALL_TIMEOUT') {
      return '下载连接长时间无响应，系统正在自动重连，请稍候';
    }
    if (code === 'LINK_EXPIRED') {
      return '下载链接已过期，点击重试即可重新获取继续下载';
    }
    if (code === 'ACCOUNT_MISMATCH') {
      return '当前登录账号与创建任务时不一致，请切回原账号或重新创建任务';
    }
    if (code === 'CHECKPOINT_VERSION') {
      return '旧版断点记录不兼容，请取消该任务后重新下载（原文件已保留）';
    }
    if (code === 'COMMIT_UNCERTAIN') {
      return '上次上传结果未确认，请先检查云盘目录是否已有该文件，再决定是否重新上传';
    }
    if (code === 'SIGNATURE_INVALID' || code === 'CHECKSUM_MISMATCH') {
      return '安装包完整性校验未通过，为保障安全已拦截，请稍后重试下载';
    }
    if (code === 'OPT_IN_REQUIRED') {
      return '当前未开启「连接作者服务器」，如需使用请在设置中手动开启';
    }
    if (hasReadableZh) return rawMsg;
    if (err && Number(err.httpStatus) === 426) return '当前版本已停止在线接口支持，请升级到最新版本后重试';
    if (code === 'TIMEOUT') return '网络请求超时，请检查网络连接或代理设置后再试';
    if (code === 'NETWORK') return '网络连接不稳定，请检查网络或代理后重试';
    if (code === 'LOCAL_IO') return '本地文件读写失败，请检查保存目录权限和磁盘剩余空间';
    if (code === 'PARSE') return '服务器返回的数据格式异常，请稍后重试';
    if (code === 'CONFLICT') return '目标位置已存在同名文件或状态已变化，请刷新后重试';
    if (code === 'NOT_FOUND') return '目标文件或文件夹已不存在，请刷新目录后重试';
    if (code === 'FORBIDDEN') return '当前操作没有权限，请检查账号权益或目录权限';
    if (code === 'SERVER') return '夸克云端服务暂时繁忙，请稍后再试';
    if (code === 'CONTENT_MISMATCH') return '文件内容校验不一致，原文件已保留，请重试';
    if (code === 'INVALID_ARG') return '输入的参数格式有误，请检查后重试';
    return rawMsg || fallback || '操作暂时未能完成，请稍后重试';
  }

  /** 统一错误上报：NEED_LOGIN 由 QKAPI.onNeedLogin 统一驱动提示条，这里只负责文案。 */
  function reportError(err, fallback) {
    var e = API.normalizeError(err, fallback);
    if (API.isNeedLogin(e)) {
      toast('error', '登录状态已失效，请重新扫码登录');
      return e;
    }
    if (e.code !== 'ABORTED' && e.code !== 'OPT_IN_REQUIRED') {
      recordDiag(
        'error',
        'ui',
        e.code || 'UI_ERROR',
        (fallback ? fallback + ': ' : '') + (e.message || ''),
        {
          httpStatus: e.httpStatus,
          bizCode: e.bizCode,
          meta: { view: state.view, fallback: fallback || '' }
        }
      );
    }
    toast('error', friendlyErrorMessage(e, fallback));
    return e;
  }

  /* ================================================================== *
   * 顶部提示条
   * ================================================================== */

  function banner(key, level, text, actions) {
    var old = el.banners.querySelector('[data-banner="' + key + '"]');
    if (old) old.parentNode.removeChild(old);
    var node = h('div', 'banner banner-' + level);
    node.setAttribute('data-banner', key);
    node.appendChild(icon(level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'info'), 'banner-ic'));
    node.appendChild(h('div', 'banner-text', text));
    (actions || []).forEach(function (a) {
      var b = h('button', 'btn btn-sm ' + (a.primary ? 'btn-primary' : ''));
      b.type = 'button';
      b.textContent = a.label;
      var handler = typeof a.onClick === 'function' ? a.onClick : a.run;
      if (typeof handler === 'function') b.addEventListener('click', handler);
      node.appendChild(b);
    });
    var close = h('button', 'banner-close');
    close.type = 'button';
    close.title = '关闭';
    close.appendChild(icon('close'));
    close.addEventListener('click', function () { if (node.parentNode) node.parentNode.removeChild(node); });
    node.appendChild(close);
    el.banners.appendChild(node);
  }

  function clearBanner(key) {
    var old = el.banners.querySelector('[data-banner="' + key + '"]');
    if (old) old.parentNode.removeChild(old);
  }

  function showNoBridgeBanner(info) {
    banner('bridge', 'warn', '未注入桥接层（window.qk 不存在）：当前只能查看界面，文件与传输功能不可用。' +
      '请通过 npm start 启动桌面端后再试。', [
      { label: '重新检测', onClick: function () { location.reload(); } }
    ]);
  }

  function showExpiredBanner() {
    state.expired = true;
    renderAccount();
    banner('auth', 'error', '登录状态已失效，请重新登录', [
      {
        label: '重新登录', primary: true, onClick: function () {
          doLogin();
        }
      }
    ]);
  }

  function clearExpiredBanner() {
    state.expired = false;
    clearBanner('auth');
  }

  async function doLogin() {
    try {
      var s = await API.auth.login();
      invalidateDirCache();
      applyAccount(s);
      clearExpiredBanner();
      toast('ok', '登录成功');
      refreshQuota();
      reloadCurrent();
    } catch (err) {
      reportError(err, '登录失败');
    }
  }

  async function doLogout() {
    var ok = await confirmDialog({
      title: '退出登录',
      message: '确定要退出当前账号吗？',
      detail: '退出后本地保存的登录凭证会被清除，需要重新登录才能继续使用。',
      confirmText: '退出登录'
    });
    if (!ok) return;
    try {
      await API.auth.logout();
      invalidateDirCache();
      scrollPosMap.clear();
      state.history = [];
      state.historyIndex = -1;
      resetSessionViews();
      applyAccount({ loggedIn: false, expired: false });
      clearExpiredBanner();
      toast('info', '已退出登录');
    } catch (err) {
      reportError(err, '退出登录失败');
    }
  }

  /** 登出或切换账号时清空对话视图、传输队列与回收站中的上个账号状态（保留大模型连接配置）。 */
  function resetSessionViews() {
    prevTaskStatus.clear();
    transferBatchWasBulk = false;
    pendingFilesRefresh = false;
    state.transfers = [];
    state.transfersLoaded = false;
    renderTransfers(true);
    dirDetailCache.clear();
    dirDetailInflight.clear();
    state.recycle.items = [];
    state.recycle.selected.clear();
    state.recycle.page = 0;
    state.recycle.hasMore = false;
    state.recycle.total = 0;
    state.recycle.loading = false;
    state.recycle.loadedOnce = false;
    recycleSeq += 1;
    if (el.recycleList) renderRecycle();
    var cg = chatOf();
    cg.history = [];
    cg.historyError = '';
    cg.loaded = true;
    cg.sending = false;
    cg.round = null;
    cg.phase = 'idle';
    cg.curRound = 0;
    cg.runningTool = '';
    cg.errorText = '';
    cg.doneText = '';
    renderChat();
    renderChatHistory();
  }

  /* ================================================================== *
   * 账号区
   * ================================================================== */

  function applyAccount(s) {
    if (!s || typeof s !== 'object') return;
    var previous = state.account;
    state.account = s;
    if (previous && previous.loggedIn && (!s.loggedIn || s.expired ||
        (previous.userId && s.userId && previous.userId !== s.userId))) {
      // Invalidate cache, history and in-flight pages on account changes.
      invalidateDirCache();
      scrollPosMap.clear();
      state.history = [];
      state.historyIndex = -1;
      state.quota = null;
      state.fid = ROOT_FID;
      state.mode = 'browse';
      state.keyword = '';
      state.filter = 'all';
      state.crumbs = [{ fid: ROOT_FID, name: '全部文件' }];
      if (el.searchInput) el.searchInput.value = '';
      if (el.searchClear) el.searchClear.hidden = true;
      if (el.searchKbd) el.searchKbd.hidden = false;
      resetList();
      renderCrumbs();
      updateFilterPills();
      renderEmpty(s.expired ? '登录状态已失效，请重新登录' : '登录夸克账号后即可浏览、上传和下载你的网盘文件', false, { login: true });
      resetSessionViews();
    } else if ((!previous || !previous.loggedIn) && s.loggedIn) {
      invalidateDirCache();
      chatOf().loaded = false;
    }
    if (s.expired === true) showExpiredBanner();
    else if (s.loggedIn === true) clearExpiredBanner();
    renderAccount();
    renderSettings();
    if (s.loggedIn && !s.expired && (!state.quota || !(state.quota.total > 0))) {
      refreshQuota();
    }
  }

  function sameAccountSession(snapshot) {
    var cur = state.account;
    if (!cur || !cur.loggedIn || cur.expired) return false;
    if (!snapshot || !snapshot.loggedIn) return false;
    if (snapshot.userId && cur.userId && String(snapshot.userId) !== String(cur.userId)) return false;
    return true;
  }

  function freeBytesOf(q) {
    if (!q || !(q.total > 0)) return 0;
    if (typeof q.free === 'number' && isFinite(q.free) && q.free >= 0) return q.free;
    return Math.max(0, q.total - (Number(q.used) || 0));
  }

  function renderSidebarQuota() {
    if (!el.sidebarQuota) return;
    var a = state.account;
    var q = state.quota;
    if (!API.injected || !a || !a.loggedIn || a.expired || !q || !(q.total > 0)) {
      el.sidebarQuota.hidden = true;
      return;
    }
    el.sidebarQuota.hidden = false;
    var usedSpace = Math.max(0, Number(q.used) || 0);
    var freeSpace = freeBytesOf(q);
    var pct = Math.min(100, Math.max(0, (usedSpace / q.total) * 100));
    var isWarn = pct >= 80 && pct < 95;
    var isDanger = pct >= 95;
    el.sidebarQuota.classList.toggle('warn', isWarn);
    el.sidebarQuota.classList.toggle('danger', isDanger);
    el.sidebarQuota.title = '剩余可用 ' + fmtSize(freeSpace) + ' · 已用 ' + fmtSize(usedSpace) + ' / 共 ' + fmtSize(q.total) + '（点击查看空间明细）';
    if (el.sidebarQuotaFree) el.sidebarQuotaFree.textContent = fmtSize(freeSpace);
    if (el.sidebarQuotaPct) el.sidebarQuotaPct.textContent = pct.toFixed(pct >= 10 ? 0 : 1) + '%';
    if (el.sidebarQuotaFill) {
      el.sidebarQuotaFill.style.width = (pct > 0 && pct < 1 ? 1 : pct).toFixed(2) + '%';
      var bar = el.sidebarQuotaFill.parentNode;
      if (bar && bar.classList) {
        bar.classList.toggle('warn', isWarn);
        bar.classList.toggle('danger', isDanger);
      }
    }
    if (el.sidebarQuotaText) {
      el.sidebarQuotaText.textContent = '已用 ' + fmtSize(usedSpace) + ' / ' + fmtSize(q.total);
    }
  }

  function renderSettingsAccountHint() {
    if (!el.setAccountHint) return;
    var a = state.account;
    var q = state.quota;
    var quotaSuffix = (q && q.total > 0)
      ? (' · 剩余可用 ' + fmtSize(freeBytesOf(q)) + '（已用 ' + fmtSize(Math.max(0, Number(q.used) || 0)) + ' / 共 ' + fmtSize(q.total) + '）')
      : '';
    el.setAccountHint.textContent = !API.injected
      ? '未注入桥接层，无法读取登录状态。'
      : (a && a.expired ? '登录状态已失效，请点击「重新登录」。'
        : (a && a.loggedIn ? '当前已登录：' + (a.nickname || '未知账号') + '（' + (a.memberLabel || '普通用户') + '）' + quotaSuffix
          : '当前未登录。'));
  }

  function renderAccount() {
    // 登录态变化时顺带刷新 Agent 面板（仅在已开启 AI Beta 时渲染）
    renderAgent();
    renderSidebarQuota();
    renderSettingsAccountHint();
    var box = el.account;
    box.textContent = '';
    var a = state.account;

    if (!API.injected) {
      box.appendChild(h('span', 'acct-hint', '未连接后端'));
      return;
    }
    if (!a || (!a.loggedIn && !a.expired)) {
      box.appendChild(h('span', 'acct-hint', a && a.expired ? '登录已失效' : '未登录'));
      var lb = h('button', 'btn btn-sm btn-primary');
      lb.type = 'button';
      lb.textContent = '登录';
      lb.addEventListener('click', doLogin);
      box.appendChild(lb);
      return;
    }
    if (a.expired) {
      box.appendChild(h('span', 'acct-hint', '登录已失效'));
      var rb = h('button', 'btn btn-sm btn-primary');
      rb.type = 'button';
      rb.textContent = '重新登录';
      rb.addEventListener('click', doLogin);
      box.appendChild(rb);
      return;
    }

    // 头像：仅接受 data: 内联图，避免任何外部网络请求
    var av = h('span', 'avatar');
    if (a.avatar && /^data:image\//i.test(a.avatar)) {
      var img = h('img');
      img.src = a.avatar;
      img.alt = '';
      av.appendChild(img);
    } else {
      var ch = (a.nickname || '用').trim().charAt(0) || '用';
      av.appendChild(h('span', 'avatar-text', ch));
    }
    box.appendChild(av);

    var meta = h('div', 'acct-meta');
    meta.appendChild(h('div', 'acct-name', a.nickname || '已登录'));
    var sub = h('div', 'acct-sub');
    sub.appendChild(h('span', 'acct-tag', a.memberLabel || '普通用户'));
    var q = state.quota;
    if (q && q.total > 0) {
      var freeTop = freeBytesOf(q);
      var usedTop = Math.max(0, Number(q.used) || 0);
      var pctTop = Math.min(100, Math.max(0, (usedTop / q.total) * 100));
      var topCls = 'acct-quota-text' + (pctTop >= 95 ? ' danger' : (pctTop >= 80 ? ' warn' : ''));
      var qt = h('span', topCls, '可用 ' + fmtSize(freeTop));
      qt.title = '剩余可用 ' + fmtSize(freeTop) + ' · 已用 ' + fmtSize(usedTop) + ' / 共 ' + fmtSize(q.total);
      sub.appendChild(qt);
    }
    meta.appendChild(sub);
    if (q && q.total > 0) {
      var usedBar = Math.max(0, Number(q.used) || 0);
      var pct = Math.min(100, Math.max(0, (usedBar / q.total) * 100));
      var bar = h('div', 'quota-bar' + (pct >= 95 ? ' danger' : (pct >= 80 ? ' warn' : '')));
      bar.title = '已用 ' + pct.toFixed(pct >= 10 ? 0 : 1) + '%（剩余可用 ' + fmtSize(freeBytesOf(q)) + '）';
      var fill = h('i');
      fill.style.width = (pct < 0.6 && pct > 0 ? 0.6 : pct) + '%';
      bar.appendChild(fill);
      meta.appendChild(bar);
    }
    box.appendChild(meta);

    var out = h('button', 'btn btn-icon btn-ghost');
    out.type = 'button';
    out.title = '退出登录';
    out.setAttribute('aria-label', '退出登录');
    out.appendChild(icon('logout'));
    out.addEventListener('click', doLogout);
    box.appendChild(out);
  }

  async function refreshQuota() {
    var account = state.account;
    if (!API.injected || !account || !account.loggedIn || account.expired) return;
    try {
      var q = await API.auth.quota();
      if (!sameAccountSession(account)) return;
      if (q && typeof q.total === 'number' && q.total > 0) {
        state.quota = q;
        lastQuotaRefreshAt = Date.now();
        renderAccount();
        if (state.view === 'settings') renderSettings();
      }
    } catch (e) { /* 容量信息失败不打扰用户 */ }
  }

  /**
   * 后台静默同步账号状态与剩余空间（每 90 秒一次，及上传/删除完成或恢复可见时按需触发）。
   * 仅在已登录且页面可见时运行，避免无意义请求与界面闪动。
   */
  async function silentRefreshAccountAndQuota(opts) {
    var o = opts || {};
    if (!API.injected || needsLoginState() || quotaRefreshing) return;
    if (!o.force && typeof document !== 'undefined' && document.hidden) return;
    var account = state.account;
    if (!account || !account.loggedIn || account.expired) return;
    quotaRefreshing = true;
    quotaRefreshTicks += 1;
    try {
      var tasks = [API.auth.quota().catch(function () { return null; })];
      var syncProfile = !!o.withAccount || (quotaRefreshTicks % 2 === 1);
      if (syncProfile && API.has('auth', 'getUserInfo')) {
        tasks.push(API.auth.getUserInfo().catch(function () { return null; }));
      }
      var res = await Promise.all(tasks);
      if (!sameAccountSession(account)) return;
      var q = res[0];
      var info = res[1];
      var changed = false;
      if (q && typeof q.total === 'number' && q.total > 0) {
        state.quota = q;
        lastQuotaRefreshAt = Date.now();
        changed = true;
      }
      if (info && typeof info === 'object') {
        ['nickname', 'memberLabel', 'avatar'].forEach(function (k) {
          if (info[k] && info[k] !== state.account[k]) {
            state.account[k] = info[k];
            changed = true;
          }
        });
      }
      if (changed) {
        renderAccount();
        if (state.view === 'settings') renderSettings();
      }
    } catch (_) {
      /* 静默容错，不打扰用户 */
    } finally {
      quotaRefreshing = false;
    }
  }

  /* ================================================================== *
   * 自绘对话框
   * ================================================================== */

  function closeOverlay(node) {
    if (!node || !node.parentNode) return;
    node.classList.add('overlay-out');
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 140);
  }

  var overlayStack = [];

  function openOverlay(build) {
    var prevFocus = document.activeElement;
    var wrap = h('div', 'overlay');
    var panel = h('div', 'dlg');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    wrap.appendChild(panel);
    el.overlayRoot.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('overlay-in'); });
    var closed = false;
    var resolveFn = null;
    var api = { wrap: wrap, panel: panel, close: close, setResolve: function (fn) { resolveFn = fn; } };
    overlayStack.push(api);
    function close(result) {
      if (closed) return;
      closed = true;
      var sIdx = overlayStack.indexOf(api);
      if (sIdx >= 0) overlayStack.splice(sIdx, 1);
      document.removeEventListener('keydown', onKey, true);
      closeOverlay(wrap);
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (_) {}
      }
      if (resolveFn) resolveFn(result);
    }
    wrap.addEventListener('mousedown', function (e) {
      if (e.target === wrap && overlayStack[overlayStack.length - 1] === api) close(null);
    });
    function onKey(e) {
      if (overlayStack[overlayStack.length - 1] !== api) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
      if (e.key === 'Tab' && typeof panel.querySelectorAll === 'function') {
        var all = Array.prototype.slice.call(
          panel.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')
        ).filter(function (n) { return !n.disabled && !n.hidden && n.offsetParent !== null; });
        if (all.length > 1) {
          var idx = all.indexOf(document.activeElement);
          if (e.shiftKey && idx <= 0) { e.preventDefault(); all[all.length - 1].focus(); }
          else if (!e.shiftKey && idx === all.length - 1) { e.preventDefault(); all[0].focus(); }
        }
      }
    }
    document.addEventListener('keydown', onKey, true);
    build(api);
    var focusable = panel.querySelector('[data-autofocus="1"]') || panel.querySelector('input, textarea, select') || panel.querySelector('button');
    if (focusable && typeof focusable.focus === 'function') {
      setTimeout(function () { try { focusable.focus(); } catch (e) {} }, 30);
    }
    return api;
  }

  /** 二次确认对话框。danger=true 时确认按钮为红色，且默认焦点停在「取消」防止误按 Enter 删除。 */
  function confirmDialog(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var api = openOverlay(function (ui) {
        ui.setResolve(resolve);
        ui.panel.classList.add('dlg-confirm');
        var head = h('div', 'dlg-head');
        head.appendChild(icon(o.danger ? 'warn' : 'info', 'dlg-ic' + (o.danger ? ' danger' : '')));
        head.appendChild(h('h3', 'dlg-title', o.title || '请确认'));
        ui.panel.appendChild(head);

        var body = h('div', 'dlg-body');
        body.appendChild(h('p', 'dlg-msg', o.message || ''));
        if (o.detail) body.appendChild(h('p', 'dlg-detail', o.detail));
        if (o.list && o.list.length) {
          var ul = h('ul', 'dlg-list');
          o.list.slice(0, 12).forEach(function (t) { ul.appendChild(h('li', null, t)); });
          if (o.list.length > 12) ul.appendChild(h('li', 'muted', '…等共 ' + o.list.length + ' 项'));
          body.appendChild(ul);
        }
        ui.panel.appendChild(body);

        var foot = h('div', 'dlg-foot');
        var cancel = h('button', 'btn');
        cancel.type = 'button';
        cancel.textContent = o.cancelText || '取消';
        cancel.addEventListener('click', function () { ui.close(false); });
        var ok = h('button', 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'));
        ok.type = 'button';
        ok.textContent = o.confirmText || '确定';
        ok.addEventListener('click', function () { ui.close(true); });
        foot.appendChild(cancel);
        foot.appendChild(ok);
        ui.panel.appendChild(foot);
        if (o.danger) cancel.dataset.autofocus = '1';
        else ok.dataset.autofocus = '1';
      });
      api.wrap.addEventListener('keydown', function (e) {
        // 绝不拦截按钮自身的原生 Enter（否则危险操作焦点在「取消」时按 Enter 会误删！）
        if (e.key === 'Enter' && !e.isComposing && !o.danger) {
          var tag = (e.target && e.target.tagName) || '';
          if (tag === 'BUTTON') return;
          var ok = api.panel.querySelector('.dlg-foot .btn:last-child');
          if (ok) ok.click();
        }
      });
    });
  }

  /** 文本输入对话框（新建文件夹 / 重命名）。validate 返回错误文案或 null。 */
  function promptDialog(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var api = openOverlay(function (ui) {
        ui.setResolve(resolve);
        ui.panel.classList.add('dlg-prompt');
        var head = h('div', 'dlg-head');
        head.appendChild(icon(o.icon || 'rename', 'dlg-ic'));
        head.appendChild(h('h3', 'dlg-title', o.title || '请输入'));
        ui.panel.appendChild(head);

        var body = h('div', 'dlg-body');
        if (o.message) body.appendChild(h('p', 'dlg-msg', o.message));
        var input = h('input', 'input dlg-input');
        input.type = 'text';
        input.value = o.value || '';
        input.placeholder = o.placeholder || '';
        input.spellcheck = false;
        input.autocomplete = 'off';
        body.appendChild(input);
        var err = h('p', 'dlg-error');
        err.hidden = true;
        body.appendChild(err);
        ui.panel.appendChild(body);

        var foot = h('div', 'dlg-foot');
        var cancel = h('button', 'btn');
        cancel.type = 'button';
        cancel.textContent = '取消';
        cancel.addEventListener('click', function () { ui.close(null); });
        var ok = h('button', 'btn btn-primary');
        ok.type = 'button';
        ok.textContent = o.confirmText || '确定';
        ok.addEventListener('click', submit);
        foot.appendChild(cancel);
        foot.appendChild(ok);
        ui.panel.appendChild(foot);

        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
        });
        input.addEventListener('input', function () { err.hidden = true; });

        function submit() {
          var v = input.value.trim();
          if (!v) { err.textContent = '不能为空'; err.hidden = false; input.focus(); return; }
          if (o.validate) {
            var msg = o.validate(v);
            if (msg) { err.textContent = msg; err.hidden = false; input.focus(); return; }
          }
          ui.close(v);
        }
        setTimeout(function () {
          input.focus();
          var dot = input.value.lastIndexOf('.');
          if (dot > 0 && !o.selectAll) input.setSelectionRange(0, dot); else input.select();
        }, 30);
      });
    });
  }

  /**
   * 目录选择器：支持独立「上一级」按钮、面包屑、新建文件夹与键盘浏览，根目录 fid 恒为 '0'。
   * 返回选中的目标目录 fid，取消返回 null。
   */
  function pickDirDialog(opts) {
    var o = opts || {};
    var cur = { fid: ROOT_FID, name: '全部文件' };
    var crumbs = [{ fid: ROOT_FID, name: '全部文件' }];
    var exclude = o.excludeFids || [];
    var chosen = null;
    var chosenName = '';
    var listBox, crumbBox, confirmBtn, upBtn, mkdirBtn, hintEl, loadSeq = 0, loadingMore = false;

    return new Promise(function (resolve) {
      var api = openOverlay(function (ui) {
        ui.setResolve(resolve);
        ui.panel.classList.add('dlg-picker');

        var head = h('div', 'dlg-head');
        head.appendChild(icon('move', 'dlg-ic'));
        head.appendChild(h('h3', 'dlg-title', o.title || '选择目标目录'));
        ui.panel.appendChild(head);

        var toolbar = h('div', 'picker-toolbar');
        upBtn = h('button', 'btn btn-sm');
        upBtn.type = 'button';
        upBtn.title = '返回上一级（Alt+↑ / Backspace）';
        upBtn.appendChild(icon('arrow-up'));
        upBtn.appendChild(h('span', null, '上一级'));
        upBtn.disabled = true;
        upBtn.addEventListener('click', pickerGoUp);
        toolbar.appendChild(upBtn);

        crumbBox = h('div', 'picker-crumbs');
        toolbar.appendChild(crumbBox);

        mkdirBtn = h('button', 'btn btn-sm btn-ghost');
        mkdirBtn.type = 'button';
        mkdirBtn.title = '在此处新建文件夹';
        mkdirBtn.appendChild(icon('folder-plus'));
        mkdirBtn.appendChild(h('span', null, '新建'));
        mkdirBtn.addEventListener('click', pickerMkdir);
        toolbar.appendChild(mkdirBtn);
        ui.panel.appendChild(toolbar);

        listBox = h('div', 'picker-list');
        var loading = h('div', 'picker-loading', '加载中…');
        listBox.appendChild(loading);
        ui.panel.appendChild(listBox);

        hintEl = h('div', 'picker-hint', '目标目录：全部文件');
        ui.panel.appendChild(hintEl);

        var foot = h('div', 'dlg-foot');
        var cancel = h('button', 'btn');
        cancel.type = 'button';
        cancel.textContent = '取消';
        cancel.addEventListener('click', function () { ui.close(null); });
        confirmBtn = h('button', 'btn btn-primary');
        confirmBtn.type = 'button';
        confirmBtn.textContent = o.confirmText || '移动到此处';
        confirmBtn.addEventListener('click', function () {
          ui.close(chosen === null ? cur.fid : chosen);
        });
        foot.appendChild(cancel);
        foot.appendChild(confirmBtn);
        ui.panel.appendChild(foot);

        ui.wrap.addEventListener('keydown', function (e) {
          var tag = (e.target && e.target.tagName) || '';
          if (tag === 'INPUT' || tag === 'TEXTAREA') return;
          if ((e.altKey && e.key === 'ArrowUp') || (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey)) {
            e.preventDefault();
            pickerGoUp();
          }
        });

        loadDir(ROOT_FID);
      });

      function updateHint() {
        if (!hintEl) return;
        hintEl.textContent = chosen !== null
          ? ('已选目标：' + (chosenName || cur.name))
          : ('目标目录：' + cur.name);
      }

      function pickerGoUp() {
        if (crumbs.length <= 1) return;
        crumbs = crumbs.slice(0, crumbs.length - 1);
        var target = crumbs[crumbs.length - 1];
        cur = { fid: target.fid, name: target.name };
        chosen = null;
        chosenName = '';
        loadDir(target.fid);
      }

      async function pickerMkdir() {
        var name = await promptDialog({
          title: '新建文件夹',
          message: '将在「' + cur.name + '」下创建文件夹。',
          placeholder: '请输入文件夹名称',
          confirmText: '创建',
          icon: 'folder-plus',
          validate: validateName
        });
        if (name === null) return;
        try {
          var accepted = await API.fs.mkdir({ pdirFid: cur.fid, name: name });
          await waitAcceptedTask(accepted);
          invalidateDirCache(cur.fid);
          toast('ok', '已创建「' + name + '」');
          loadDir(cur.fid);
        } catch (err) {
          reportError(err, '新建文件夹失败');
        }
      }

      function renderPickerCrumbs() {
        if (upBtn) upBtn.disabled = crumbs.length <= 1;
        crumbBox.textContent = '';
        crumbs.forEach(function (c, i) {
          if (i > 0) crumbBox.appendChild(icon('chevron', 'crumb-sep'));
          var b = h('button', 'crumb-item');
          b.type = 'button';
          b.textContent = c.name;
          b.disabled = i === crumbs.length - 1;
          b.addEventListener('click', function () {
            crumbs = crumbs.slice(0, i + 1);
            cur = { fid: c.fid, name: c.name };
            chosen = null;
            chosenName = '';
            loadDir(c.fid);
          });
          crumbBox.appendChild(b);
        });
        crumbBox.scrollLeft = crumbBox.scrollWidth;
        updateHint();
      }

      async function loadDir(fid, page, append) {
        if (append && loadingMore) return;
        page = page || 1;
        var seq = append ? loadSeq : ++loadSeq;
        loadingMore = !!append;
        var more = listBox.querySelector('.picker-more');
        if (more && more.parentNode) more.parentNode.removeChild(more);
        if (!append) listBox.textContent = '';
        var indicator = h('div', 'picker-loading', '加载中…');
        listBox.appendChild(indicator);
        renderPickerCrumbs();
        try {
          var res = await API.fs.list({ pdirFid: fid, page: page, size: 100, sort: 'file_type:asc,file_name:asc' });
          if (seq !== loadSeq) return;
          loadingMore = false;
          var dirs = (res && res.list ? res.list : []).filter(function (it) { return it && it.dir; });
          if (indicator.parentNode) indicator.parentNode.removeChild(indicator);
          if (dirs.length) {
            var oldEmpty = listBox.querySelector('.picker-empty');
            if (oldEmpty && oldEmpty.parentNode) oldEmpty.parentNode.removeChild(oldEmpty);
          }
          if (!dirs.length && !append && !listBox.querySelector('.picker-row')) {
            listBox.appendChild(h('div', 'picker-empty', '当前目录下没有子文件夹'));
          } else {
            dirs.forEach(function (d) {
              var row = h('button', 'picker-row');
              row.type = 'button';
              row.dataset.fid = d.fid;
              var disabled = exclude.indexOf(String(d.fid)) >= 0;
              if (disabled) { row.disabled = true; row.title = '不能选择该项自身'; }
              row.appendChild(icon('folder', 'picker-ic'));
              var nameSpan = h('span', 'picker-name', d.name);
              nameSpan.title = d.name;
              row.appendChild(nameSpan);
              var enter = h('span', 'picker-enter', '进入');
              row.appendChild(enter);
              row.addEventListener('click', function (e) {
                if (e.target && e.target.classList && e.target.classList.contains('picker-enter')) return;
                if (disabled) return;
                if (chosen === d.fid) { chosen = null; chosenName = ''; }
                else { chosen = d.fid; chosenName = d.name; }
                Array.prototype.forEach.call(listBox.querySelectorAll('.picker-row'), function (r) {
                  r.classList.toggle('selected', r.dataset.fid === chosen);
                });
                updateHint();
              });
              function enterSubdir() {
                if (disabled) return;
                crumbs = crumbs.concat([{ fid: d.fid, name: d.name }]);
                cur = { fid: d.fid, name: d.name };
                chosen = null;
                chosenName = '';
                loadDir(d.fid);
              }
              row.addEventListener('dblclick', enterSubdir);
              enter.addEventListener('click', function (e) {
                e.stopPropagation();
                enterSubdir();
              });
              listBox.appendChild(row);
            });
          }
          if (res && res.hasMore) {
            var next = h('button', 'btn picker-more', '加载更多目录');
            next.type = 'button';
            next.addEventListener('click', function () { loadDir(fid, page + 1, true); });
            listBox.appendChild(next);
          }
        } catch (err) {
          if (seq !== loadSeq) return;
          loadingMore = false;
          listBox.textContent = '';
          var e2 = reportError(err, '读取目录失败');
          listBox.appendChild(h('div', 'picker-empty', e2.message || '读取目录失败'));
        }
      }
    });
  }

  /* ================================================================== *
   * 右键菜单
   * ================================================================== */

  function closeCtx() { el.ctx.hidden = true; el.ctx.textContent = ''; }

  function openCtx(x, y, entries) {
    el.ctx.textContent = '';
    entries.forEach(function (en) {
      if (en.sep) { el.ctx.appendChild(h('div', 'ctx-sep')); return; }
      var b = h('button', 'ctx-item' + (en.danger ? ' danger' : ''));
      b.type = 'button';
      b.appendChild(icon(en.icon || 'file'));
      b.appendChild(h('span', null, en.label));
      b.disabled = !!en.disabled;
      b.addEventListener('click', function () { closeCtx(); en.run(); });
      el.ctx.appendChild(b);
    });
    el.ctx.hidden = false;
    var r = el.ctx.getBoundingClientRect();
    var left = Math.min(x, window.innerWidth - r.width - 8);
    var top = Math.min(y, window.innerHeight - r.height - 8);
    el.ctx.style.left = Math.max(8, left) + 'px';
    el.ctx.style.top = Math.max(8, top) + 'px';
  }

  /* ================================================================== *
   * 顶部栏：导航历史 / 返回上一级 / 面包屑 / 搜索 / 账号
   * ================================================================== */

  function cloneCrumbs(cs) {
    return (cs || []).map(function (c) { return { fid: String(c.fid), name: String(c.name || '') }; });
  }

  function pushHistoryEntry(entry) {
    var cur = state.history[state.historyIndex];
    if (cur && cur.mode === entry.mode) {
      if (entry.mode === 'browse' && cur.fid === entry.fid) {
        cur.crumbs = cloneCrumbs(entry.crumbs);
        return;
      }
      if (entry.mode === 'search' && cur.keyword === entry.keyword) return;
    }
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(entry);
    if (state.history.length > 60) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    if (el.btnBack) el.btnBack.disabled = state.historyIndex <= 0;
    if (el.btnForward) el.btnForward.disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
  }

  function applyHistoryEntry(entry) {
    if (!entry) return;
    if (entry.mode === 'search') {
      el.searchInput.value = entry.keyword;
      runSearch(entry.keyword, { fromHistory: true });
      return;
    }
    if (Array.isArray(entry.crumbs) && entry.crumbs.length) {
      state.crumbs = cloneCrumbs(entry.crumbs);
    }
    navigate(entry.fid, entry.name, undefined, { fromHistory: true, restoreScroll: true });
  }

  function goBack() {
    if (state.view !== 'files') return;
    if (state.historyIndex <= 0) return;
    state.historyIndex -= 1;
    updateHistoryButtons();
    applyHistoryEntry(state.history[state.historyIndex]);
  }

  function goForward() {
    if (state.view !== 'files') return;
    if (state.historyIndex < 0 || state.historyIndex >= state.history.length - 1) return;
    state.historyIndex += 1;
    updateHistoryButtons();
    applyHistoryEntry(state.history[state.historyIndex]);
  }

  function closeCrumbMenu() {
    if (el.crumbMenu) {
      el.crumbMenu.hidden = true;
      el.crumbMenu.textContent = '';
    }
    if (crumbEllipsisBtn) {
      crumbEllipsisBtn.setAttribute('aria-expanded', 'false');
      crumbEllipsisBtn = null;
    }
  }

  function openCrumbMenu(anchorBtn, hiddenCrumbs) {
    if (!el.crumbMenu || !hiddenCrumbs || !hiddenCrumbs.length) return;
    if (!el.crumbMenu.hidden && crumbEllipsisBtn === anchorBtn) {
      closeCrumbMenu();
      return;
    }
    closeCtx();
    el.crumbMenu.textContent = '';
    hiddenCrumbs.forEach(function (entry) {
      var b = h('button', 'ctx-item');
      b.type = 'button';
      b.appendChild(icon('folder'));
      b.appendChild(h('span', 'crumb-depth', 'L' + entry.depth));
      b.appendChild(h('span', 'crumb-pop-name', entry.crumb.name));
      b.title = '跳转到 ' + entry.crumb.name;
      b.addEventListener('click', function () {
        closeCrumbMenu();
        navigate(entry.crumb.fid, entry.crumb.name, undefined, { restoreScroll: true });
      });
      el.crumbMenu.appendChild(b);
    });
    el.crumbMenu.hidden = false;
    crumbEllipsisBtn = anchorBtn;
    anchorBtn.setAttribute('aria-expanded', 'true');
    var ar = anchorBtn.getBoundingClientRect();
    var mr = el.crumbMenu.getBoundingClientRect();
    var left = Math.min(ar.left, window.innerWidth - mr.width - 8);
    var top = Math.min(ar.bottom + 6, window.innerHeight - mr.height - 8);
    el.crumbMenu.style.left = Math.max(8, left) + 'px';
    el.crumbMenu.style.top = Math.max(8, top) + 'px';
  }

  function updateCrumbScrollBtns() {
    if (!el.crumbs || !el.btnCrumbsPrev || !el.btnCrumbsNext) return;
    var overflow = el.crumbs.scrollWidth - el.crumbs.clientWidth > 4;
    if (!overflow) {
      el.btnCrumbsPrev.hidden = true;
      el.btnCrumbsNext.hidden = true;
      return;
    }
    el.btnCrumbsPrev.hidden = el.crumbs.scrollLeft <= 2;
    el.btnCrumbsNext.hidden = el.crumbs.scrollLeft + el.crumbs.clientWidth >= el.crumbs.scrollWidth - 2;
  }

  function makeCrumbBtn(c, last, extraClass) {
    var b = h('button', 'crumb-item' + (last ? ' current' : '') + (extraClass ? ' ' + extraClass : ''));
    b.type = 'button';
    b.textContent = c.name;
    b.title = last ? c.name : ('返回 ' + c.name);
    b.disabled = last;
    if (!last) {
      b.addEventListener('click', function () {
        closeCrumbMenu();
        navigate(c.fid, c.name, undefined, { restoreScroll: true });
      });
    }
    return b;
  }

  function renderCrumbs() {
    closeCrumbMenu();
    var box = el.crumbs;
    box.textContent = '';
    var searching = state.mode === 'search';
    el.btnUp.disabled = !searching && state.fid === ROOT_FID;
    el.btnUpLabel.textContent = searching ? '返回目录' : '上一级';
    el.btnUp.title = searching ? '返回搜索前的目录（Alt+↑ / Esc）' : '返回上一级目录（Alt+↑ / Backspace）';
    el.btnUp.setAttribute('aria-label', searching ? '返回搜索前的目录' : '返回上一级目录');
    updateHistoryButtons();
    if (state.mode === 'search') {
      box.appendChild(h('span', 'crumb-search-label', '搜索结果：'));
      box.appendChild(h('span', 'crumb-current', state.keyword));
      updateCrumbScrollBtns();
      return;
    }
    var list = state.crumbs;
    box.classList.toggle('crumbs-deep', list.length >= 4);
    // 深层目录（>= 4 级）常驻「全部文件 › ··· › 当前目录」，中间所有祖先收纳到「···」下拉菜单；
    // 兼顾窄顶栏零遮挡与 Windows/Mac 鼠标用户一键直达任意层级
    if (list.length >= 4) {
      box.appendChild(makeCrumbBtn(list[0], false, 'crumb-root'));
      box.appendChild(icon('chevron', 'crumb-sep'));
      var hiddenCrumbs = [];
      for (var k = 1; k <= list.length - 2; k++) {
        hiddenCrumbs.push({ depth: k, crumb: list[k] });
      }
      var ell = h('button', 'crumb-ellipsis', '···');
      ell.type = 'button';
      ell.setAttribute('aria-haspopup', 'menu');
      ell.setAttribute('aria-expanded', 'false');
      ell.setAttribute('aria-label', '展开已折叠的上级目录');
      ell.title = '点击展开全部上级路径：' + hiddenCrumbs.map(function (x) { return x.crumb.name; }).join(' › ');
      ell.addEventListener('click', function (e) {
        e.stopPropagation();
        openCrumbMenu(ell, hiddenCrumbs);
      });
      box.appendChild(ell);
      box.appendChild(icon('chevron', 'crumb-sep'));
      box.appendChild(makeCrumbBtn(list[list.length - 1], true, ''));
    } else {
      list.forEach(function (c, i) {
        if (i > 0) box.appendChild(icon('chevron', 'crumb-sep'));
        box.appendChild(makeCrumbBtn(c, i === list.length - 1, i === 0 ? 'crumb-root' : ''));
      });
    }
    box.scrollLeft = box.scrollWidth;
    updateCrumbScrollBtns();
  }

  function normalizeCrumbPath(cs, fid) {
    var seen = new Set();
    var out = [];
    (cs || []).forEach(function (c, i) {
      if (!c || c.fid === undefined || c.fid === null) return;
      var id = String(c.fid).trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ fid: id, name: c.name || (id === ROOT_FID ? '全部文件' : (i === 0 ? '全部文件' : '未命名')) });
    });
    // 若后端按子→父逆序返回（如末尾是根），反转回 根→子
    if (out.length > 1 && out[out.length - 1].fid === ROOT_FID && out[0].fid !== ROOT_FID) {
      out.reverse();
    }
    if (out.length && out[0].fid !== ROOT_FID) {
      out.unshift({ fid: ROOT_FID, name: '全部文件' });
    }
    return out;
  }

  async function resolvePlaceholderCrumb(seq, fid) {
    if (!API.has('fs', 'info')) return;
    var idx = state.crumbs.findIndex(function (c) { return c.name === '上级目录' && c.fid !== ROOT_FID; });
    if (idx < 0) return;
    var targetFid = state.crumbs[idx].fid;
    try {
      var info = await API.fs.info(targetFid);
      if (seq !== listSeq || state.mode !== 'browse' || String(fid) !== state.fid) return;
      if (info && info.name) {
        var nowIdx = state.crumbs.findIndex(function (c) { return c.fid === targetFid; });
        if (nowIdx >= 0) {
          state.crumbs[nowIdx].name = info.name;
          renderCrumbs();
        }
      }
    } catch (_) { /* 静默兜底 */ }
  }

  async function loadCrumbs(fid) {
    var seq = listSeq;
    var id = String(fid);
    if (id === ROOT_FID) {
      state.crumbs = [{ fid: ROOT_FID, name: '全部文件' }];
      renderCrumbs();
      return;
    }
    try {
      var cs = await API.fs.crumbs(id);
      if (seq !== listSeq || state.mode !== 'browse' || id !== state.fid) return;
      if (Array.isArray(cs) && cs.length) {
        var path = normalizeCrumbPath(cs, id);
        var currentIndex = path.findIndex(function (c) { return c.fid === id; });
        var localHasPlaceholder = state.crumbs.some(function (c) { return c.name === '上级目录'; });
        if (currentIndex >= 0) {
          var candidate = path.slice(0, currentIndex + 1);
          // 绝不让残缺的 [root, cur] 抹掉已有的更深层合法本地父链
          if (candidate.length < state.crumbs.length && state.crumbs[state.crumbs.length - 1].fid === id && !localHasPlaceholder) {
            state.crumbs[state.crumbs.length - 1].name = candidate[candidate.length - 1].name || state.crumbs[state.crumbs.length - 1].name;
          } else {
            state.crumbs = candidate;
          }
        } else if (path.length > 1) {
          // 仅返回祖先链时保留当前目录节点，同时用更丰富的祖先链补全本地路径
          var current = state.crumbs[state.crumbs.length - 1] || { fid: id, name: '未命名' };
          state.crumbs = path.concat([current]);
        }
      }
    } catch (err) {
      if (seq !== listSeq) return;
      // 本地已有可用路径链时不弹红色错误提示打扰用户；NEED_LOGIN 仍由 QKAPI 统一触发
      if (API.isNeedLogin(err)) reportError(err, '读取路径失败');
    }
    if (seq !== listSeq || state.mode !== 'browse' || id !== state.fid) return;
    renderCrumbs();
    resolvePlaceholderCrumb(seq, id);
  }

  function setTopbarForView() {
    var filesView = state.view === 'files';
    [el.directoryNav, el.searchBox, el.btnMkdir, el.btnUpload, el.btnRefresh].forEach(function (n) {
      if (n) n.hidden = !filesView;
    });
  }

  /* ================================================================== *
   * 文件列表：导航 / 缓存 / 排序 / 筛选 / 虚拟滚动 / 详情面板
   * ================================================================== */

  function updateFilterPills() {
    if (!el.filterPills) return;
    Array.prototype.forEach.call(el.filterPills.querySelectorAll('.pill'), function (b) {
      var on = b.dataset.filter === state.filter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function setFilter(filter) {
    var next = filter || 'all';
    if (state.filter === next) return;
    state.filter = next;
    state.focusIndex = -1;
    state.lastIndex = -1;
    updateFilterPills();
    el.listwrap.scrollTop = 0;
    listVersion += 1;
    renderRows(listSeq, true);
    renderStatusBar();
    maybeAutoFill();
  }

  function updateSortIndicators() {
    if (el.sortSelect && el.sortSelect.value !== state.sortBy) {
      el.sortSelect.value = state.sortBy;
    }
    if (!el.listhead) return;
    var parts = String(state.sortBy || DEFAULT_SORT).split(',');
    var last = parts[parts.length - 1] || 'updated_at:desc';
    var pair = last.split(':');
    var activeCol = pair[0];
    var activeDir = pair[1] === 'asc' ? 'asc' : 'desc';
    Array.prototype.forEach.call(el.listhead.querySelectorAll('.sort-btn'), function (b) {
      var col = b.dataset.sortCol;
      var active = col === activeCol;
      b.classList.toggle('sort-active', active);
      var ind = b.querySelector('.sort-ind');
      if (ind) ind.textContent = active ? (activeDir === 'asc' ? '▲' : '▼') : '';
    });
  }

  function sortItemsLocally(items) {
    var parts = String(state.sortBy || DEFAULT_SORT).split(',');
    var pair = (parts[parts.length - 1] || 'updated_at:desc').split(':');
    var col = pair[0];
    var mul = pair[1] === 'asc' ? 1 : -1;
    items.sort(function (a, b) {
      if (!!a.dir !== !!b.dir) return a.dir ? -1 : 1;
      if (col === 'file_name') {
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN') * mul;
      }
      if (col === 'size') {
        return ((Number(a.size) || 0) - (Number(b.size) || 0)) * mul;
      }
      var ta = Number(a.updatedAt || a.createdAt) || 0;
      var tb = Number(b.updatedAt || b.createdAt) || 0;
      return (ta - tb) * mul;
    });
  }

  function setSortBy(sortBy, persist) {
    if (!sortBy || sortBy === state.sortBy) {
      updateSortIndicators();
      return;
    }
    state.sortBy = sortBy;
    state.focusIndex = -1;
    state.lastIndex = -1;
    updateSortIndicators();
    if (persist) saveSettings({ sortBy: sortBy });
    if (state.mode === 'search') {
      sortItemsLocally(state.items);
      listVersion += 1;
      renderRows(listSeq, true);
      return;
    }
    resetList();
    loadPage({ reset: true });
  }

  function toggleSortColumn(col) {
    var parts = String(state.sortBy || DEFAULT_SORT).split(',');
    var pair = (parts[parts.length - 1] || 'updated_at:desc').split(':');
    var nextDir = (pair[0] === col && pair[1] === 'asc') ? 'desc' : (pair[0] === col ? 'asc' : (col === 'file_name' ? 'asc' : 'desc'));
    setSortBy('file_type:asc,' + col + ':' + nextDir, true);
  }

  function applyViewMode(mode, persist) {
    var m = mode === 'grid' ? 'grid' : 'list';
    state.viewMode = m;
    if (el.list) el.list.classList.toggle('view-grid', m === 'grid');
    if (el.listhead) el.listhead.hidden = m === 'grid';
    if (el.viewModeSeg) {
      Array.prototype.forEach.call(el.viewModeSeg.querySelectorAll('.seg'), function (b) {
        var on = b.dataset.mode === m;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    if (persist) saveSettings({ viewMode: m });
    listVersion += 1;
    renderRows(listSeq, true);
  }

  async function navigate(fid, name, parentFid, navOpts) {
    var opts = navOpts || {};
    var id = String(fid);
    if (state.mode === 'browse' && state.fid) {
      scrollPosMap.set(state.fid, el.listwrap ? el.listwrap.scrollTop : 0);
    }
    var knownIndex = state.crumbs.findIndex(function (c) { return c.fid === id; });
    if (id === ROOT_FID) {
      state.crumbs = [{ fid: ROOT_FID, name: '全部文件' }];
    } else if (knownIndex >= 0) {
      state.crumbs = state.crumbs.slice(0, knownIndex + 1);
    } else {
      var parent = parentFid == null || String(parentFid).trim() === ''
        ? (state.mode === 'browse' ? state.fid : ROOT_FID) : String(parentFid);
      var parentIndex = state.crumbs.findIndex(function (c) { return c.fid === parent; });
      state.crumbs = parentIndex >= 0 ? state.crumbs.slice(0, parentIndex + 1) : [{ fid: ROOT_FID, name: '全部文件' }];
      if (parent !== ROOT_FID && parentIndex < 0) state.crumbs.push({ fid: parent, name: '上级目录' });
      state.crumbs.push({ fid: id, name: name || '未命名' });
    }
    state.mode = 'browse';
    state.keyword = '';
    state.fid = id;
    state.filter = 'all';
    state.focusIndex = -1;
    state.selected.clear();
    state.lastIndex = -1;
    if (el.searchInput) el.searchInput.value = '';
    if (el.searchClear) el.searchClear.hidden = true;
    if (el.searchKbd) el.searchKbd.hidden = false;
    updateFilterPills();
    if (!opts.fromHistory) {
      pushHistoryEntry({ mode: 'browse', fid: id, name: currentDirName(), crumbs: cloneCrumbs(state.crumbs) });
    }
    var seq = resetList();
    renderCrumbs();
    loadCrumbs(state.fid);

    var targetScroll = opts.restoreScroll ? (scrollPosMap.get(id) || 0) : 0;
    var cached = !opts.skipCache ? getCachedDir(id, state.sortBy) : null;
    if (cached) {
      applyLoadedList(cached.items, cached.total, cached.page, cached.hasMore);
      renderRows(seq, true);
      if (el.listwrap) el.listwrap.scrollTop = targetScroll;
      renderRows(seq, true);
      renderListFoot();
      updateSelectAll();
      renderStatusBar();
      // SWR：后台静默拉取最新列表，无闪屏且保留用户刚刚做出的勾选
      loadPage({ reset: true, silent: true, preserveSelection: true, restoreScroll: targetScroll });
      return;
    }

    await loadPage({ reset: true });
    if (seq === listSeq && el.listwrap) {
      el.listwrap.scrollTop = targetScroll;
      if (targetScroll > 0) renderRows(seq, true);
    }
  }

  async function goUp() {
    if (state.view !== 'files') return;
    if (state.mode === 'search') { leaveSearch(); return; }
    if (state.fid === ROOT_FID) return;
    if (state.crumbs.length > 1) {
      var parent = state.crumbs[state.crumbs.length - 2];
      if (parent && parent.fid !== undefined && parent.fid !== null) {
        navigate(parent.fid, parent.name, undefined, { restoreScroll: true });
        return;
      }
    }
    // 兜底：若本地面包屑缺失父级，向服务端查当前目录的 pdirFid
    if (API.has('fs', 'info')) {
      try {
        var info = await API.fs.info(state.fid);
        var pdir = info && info.pdirFid !== undefined && info.pdirFid !== null ? String(info.pdirFid).trim() : '';
        if (pdir && pdir !== String(state.fid)) {
          navigate(pdir, pdir === ROOT_FID ? '全部文件' : '', undefined, { restoreScroll: true });
          return;
        }
      } catch (_) { /* 回落到根目录 */ }
    }
    navigate(ROOT_FID, '全部文件', undefined, { restoreScroll: true });
  }

  function reloadCurrent() {
    if (state.view !== 'files') return;
    if (state.mode === 'search') { runSearch(state.keyword, { fromHistory: true }); return; }
    invalidateDirCache(state.fid);
    if (el.btnRefresh) {
      el.btnRefresh.classList.add('btn-spinning');
      setTimeout(function () { if (el.btnRefresh) el.btnRefresh.classList.remove('btn-spinning'); }, 520);
    }
    resetList();
    loadCrumbs(state.fid);
    loadPage({ reset: true });
  }

  function recycleRow(row) {
    if (row.parentNode) row.parentNode.removeChild(row);
    if (rowPool.length < 48) rowPool.push(row);
  }

  function resetList() {
    listSeq += 1;
    listVersion += 1;
    lastRenderKey = '';
    state.selected.clear();
    state.lastIndex = -1;
    state.focusIndex = -1;
    rowMap.forEach(function (n) { recycleRow(n); });
    rowMap.clear();
    state.items = [];
    state.itemMap = {};
    state.page = 0;
    state.hasMore = false;
    state.total = -1;
    state.loading = false;
    state.loadedOnce = false;
    el.list.textContent = '';
    topSpacer = null;
    bottomSpacer = null;
    el.listwrap.scrollTop = 0;
    clearEmpty();
    renderListFoot();
    updateSelectAll();
    renderStatusBar();
    renderInspector();
    return listSeq;
  }

  function applyLoadedList(items, total, page, hasMore) {
    state.items = [];
    state.itemMap = {};
    items.forEach(function (it) {
      if (!it || !it.fid) return;
      var key = String(it.fid);
      if (state.itemMap[key]) return;
      state.itemMap[key] = it;
      state.items.push(it);
    });
    state.page = page;
    state.total = total;
    state.hasMore = hasMore;
    state.loadedOnce = true;
    listVersion += 1;
  }

  function findItem(fid) { return state.itemMap[String(fid)] || null; }

  function selectedItems() {
    var out = [];
    state.selected.forEach(function (fid) { var it = findItem(fid); if (it) out.push(it); });
    return out;
  }

  function renderSkeleton() {
    if (state.items.length || !el.list) return;
    if ($('list-skel')) return;
    clearEmpty();
    var wrap = h('div', 'skel-wrap');
    wrap.id = 'list-skel';
    wrap.setAttribute('aria-hidden', 'true');
    var widths = ['42%', '56%', '34%', '62%', '48%', '38%', '52%'];
    for (var i = 0; i < widths.length; i++) {
      var r = h('div', 'skel-row');
      r.appendChild(h('span', 'skel-bar skel-cb'));
      r.appendChild(h('span', 'skel-bar skel-ic'));
      var nameBar = h('span', 'skel-bar');
      nameBar.style.width = widths[i];
      r.appendChild(nameBar);
      var sizeBar = h('span', 'skel-bar');
      sizeBar.style.width = '64%';
      r.appendChild(sizeBar);
      var timeBar = h('span', 'skel-bar');
      timeBar.style.width = '78%';
      r.appendChild(timeBar);
      wrap.appendChild(r);
    }
    el.list.appendChild(wrap);
  }

  function clearSkeleton() {
    var n = $('list-skel');
    if (n && n.parentNode) n.parentNode.removeChild(n);
  }

  async function loadPage(opts) {
    var o = opts || {};
    if (state.loading && !o.silent) return;
    if (!o.reset && !state.hasMore) return;
    var seq = listSeq;
    var silent = !!o.silent;
    if (!silent) {
      state.loading = true;
      if (o.reset && !state.items.length) renderSkeleton();
      renderListFoot();
    }
    var nextPage = o.reset ? 1 : state.page + 1;
    var targetFid = state.fid;
    var reqSort = state.sortBy || DEFAULT_SORT;
    try {
      var params = { page: nextPage, size: PAGE_SIZE };
      var res;
      if (state.mode === 'search') {
        params.keyword = state.keyword;
        res = await API.fs.search(params);
      } else {
        params.pdirFid = targetFid;
        params.sort = reqSort;
        res = await API.fs.list(params);
      }
      if (seq !== listSeq) return;
      clearSkeleton();
      var list = (res && Array.isArray(res.list)) ? res.list.filter(function (x) { return x && x.fid; }) : [];
      if (o.reset) {
        state.items = [];
        state.itemMap = {};
        state.page = 0;
      }
      state.page = Number(res && res.page) > 0 ? Number(res.page) : nextPage;
      state.total = res && typeof res.total === 'number' ? res.total : -1;
      state.hasMore = !!(res && res.hasMore);
      list.forEach(function (it) {
        var key = String(it.fid);
        if (state.itemMap[key]) return;
        state.itemMap[key] = it;
        state.items.push(it);
      });
      if (o.preserveSelection && state.selected.size) {
        Array.from(state.selected).forEach(function (fid) {
          if (!state.itemMap[fid]) state.selected.delete(fid);
        });
      }
      if (state.mode === 'search' && state.sortBy !== DEFAULT_SORT) {
        sortItemsLocally(state.items);
      }
      if (!state.hasMore && list.length >= PAGE_SIZE && (state.total < 0 || state.items.length < state.total)) {
        state.hasMore = true;
      }
      state.loadedOnce = true;
      listVersion += 1;
      if (state.mode === 'browse' && state.page === 1) {
        putCachedDir(targetFid, reqSort, {
          items: state.items,
          total: state.total,
          page: state.page,
          hasMore: state.hasMore
        });
      }
      renderRows(seq, true);
      if (typeof o.restoreScroll === 'number' && isFinite(o.restoreScroll) && el.listwrap) {
        el.listwrap.scrollTop = o.restoreScroll;
        renderRows(seq, true);
      }
      updateSelectAll();
      renderStatusBar();
      renderInspector();
    } catch (err) {
      if (seq !== listSeq) return;
      clearSkeleton();
      if (silent) return;
      state.loadedOnce = true;
      var e = reportError(err, '读取目录失败');
      if (state.items.length === 0) {
        renderEmpty(e.message || '读取目录失败', true, { login: API.isNeedLogin(e) });
      }
    } finally {
      if (seq !== listSeq) return;
      if (!silent) {
        state.loading = false;
        renderListFoot();
        updateSelectAll();
        renderStatusBar();
        maybeAutoFill();
      }
    }
  }

  /**
   * 后台静默刷新当前目录（不闪屏、保留选中与滚动位置）。
   * 若用户正处于弹窗/右键菜单/非文件视图/后台标签页中，则延后至回到文件视图再刷新。
   */
  function silentRefreshFiles() {
    if (!API.injected || needsLoginState() || !state.loadedOnce || state.loading) return;
    if (state.view !== 'files' || state.mode !== 'browse') {
      pendingFilesRefresh = true;
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) return;
    if (hasActiveOverlay()) return;
    if ((el.ctx && !el.ctx.hidden) || (el.crumbMenu && !el.crumbMenu.hidden)) return;
    var savedScroll = el.listwrap ? el.listwrap.scrollTop : 0;
    // 用户已经翻到第 2 页以后且不在顶部时，避免静默重置打断深度浏览
    if (state.page > 1 && savedScroll > 160) return;
    pendingFilesRefresh = false;
    invalidateDirCache(state.fid);
    loadPage({ reset: true, silent: true, preserveSelection: true, restoreScroll: savedScroll });
  }

  function startAutoRefreshLoop() {
    stopAutoRefreshLoop();
    if (!API.injected) return;
    autoRefreshTimer = setInterval(function () {
      silentRefreshFiles();
    }, AUTO_REFRESH_MS);
    quotaRefreshTimer = setInterval(function () {
      silentRefreshAccountAndQuota();
    }, QUOTA_REFRESH_MS);
  }

  function stopAutoRefreshLoop() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (quotaRefreshTimer) {
      clearInterval(quotaRefreshTimer);
      quotaRefreshTimer = null;
    }
    if (transferRefreshTimer) {
      clearTimeout(transferRefreshTimer);
      transferRefreshTimer = null;
    }
    stopHubPollLoop();
  }

  function startHubPollLoop() {
    stopHubPollLoop();
    if (!hubBridgeReady() || !state.settings.serverOptIn) return;
    hubPollTimer = setInterval(function () {
      if (!state.settings.serverOptIn) { stopHubPollLoop(); return; }
      if (typeof document !== 'undefined' && document.hidden) return;
      checkHubUpdate({ silent: true });
      loadMyFeedback({ silent: true, background: true });
    }, HUB_POLL_MS);
  }

  function stopHubPollLoop() {
    if (hubPollTimer) {
      clearInterval(hubPollTimer);
      hubPollTimer = null;
    }
  }

  /**
   * 按下载/上传任务完成节奏触发文件管理自动刷新：
   * - 活跃队列 < 10 个：每个任务完成（status -> 'done'）后自动静默刷新；
   * - 活跃队列 >= 10 个：每 15 秒节流刷新一次，批次全部结束后补一次最终刷新。
   */
  function handleTransferCompletionRefresh(tasks) {
    var list = Array.isArray(tasks) ? tasks : [];
    var newlyDone = 0;
    var newlyUploaded = 0;
    var activeNow = 0;
    var activeIds = new Set();
    var hadPrev = prevTaskStatus.size > 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || !t.id) continue;
      activeIds.add(t.id);
      var prev = prevTaskStatus.get(t.id);
      if (t.status === 'running' || t.status === 'pending') activeNow += 1;
      if (hadPrev && prev && prev !== 'done' && t.status === 'done') {
        newlyDone += 1;
        if (t.kind === 'upload') newlyUploaded += 1;
      }
      prevTaskStatus.set(t.id, t.status);
    }
    if (newlyUploaded > 0) {
      silentRefreshAccountAndQuota({ force: true });
    }
    prevTaskStatus.forEach(function (_st, id) {
      if (!activeIds.has(id)) prevTaskStatus.delete(id);
    });

    var batchSize = activeNow + newlyDone;
    if (batchSize >= 10) transferBatchWasBulk = true;
    if (!newlyDone) {
      if (activeNow === 0 && transferBatchWasBulk) {
        transferBatchWasBulk = false;
        silentRefreshFiles();
      }
      return;
    }

    var useBulkThrottle = transferBatchWasBulk || batchSize >= 10;
    if (!useBulkThrottle) {
      // 小于 10 个任务：每个下载/上传完成后自动刷新（300ms 合并同一帧内并发完成）
      if (transferRefreshTimer) clearTimeout(transferRefreshTimer);
      transferRefreshTimer = setTimeout(function () {
        transferRefreshTimer = null;
        transferRefreshLastAt = Date.now();
        silentRefreshFiles();
      }, 300);
      return;
    }

    // 大于等于 10 个任务：15 秒节流刷新；全部结束后立即补一次收尾刷新
    if (activeNow === 0) {
      transferBatchWasBulk = false;
      if (transferRefreshTimer) { clearTimeout(transferRefreshTimer); transferRefreshTimer = null; }
      transferRefreshLastAt = Date.now();
      silentRefreshFiles();
      return;
    }
    var elapsed = Date.now() - transferRefreshLastAt;
    if (elapsed >= BULK_REFRESH_MS) {
      if (transferRefreshTimer) { clearTimeout(transferRefreshTimer); transferRefreshTimer = null; }
      transferRefreshLastAt = Date.now();
      silentRefreshFiles();
    } else if (!transferRefreshTimer) {
      transferRefreshTimer = setTimeout(function () {
        transferRefreshTimer = null;
        transferRefreshLastAt = Date.now();
        silentRefreshFiles();
      }, BULK_REFRESH_MS - elapsed);
    }
  }

  /** 首屏不足一屏且仍有下一页时继续拉取，保证滚动容器可滚动。 */
  function maybeAutoFill() {
    if (!state.hasMore || state.loading) return;
    if (el.listwrap.scrollHeight <= el.listwrap.clientHeight + 8) {
      loadPage({});
    }
  }

  function acquireRow(item) {
    var row = rowPool.pop();
    if (!row) {
      row = h('div', 'row');
      row.setAttribute('role', 'listitem');

      var cbCell = h('span', 'cb-cell');
      var label = h('label', 'cb');
      var input = h('input');
      input.type = 'checkbox';
      label.appendChild(input);
      label.appendChild(h('i'));
      cbCell.appendChild(label);
      row.appendChild(cbCell);

      var nameCell = h('span', 'col-name');
      var ic = h('span', 'fileicon');
      nameCell.appendChild(ic);
      var fname = h('span', 'fname');
      nameCell.appendChild(fname);
      row.appendChild(nameCell);

      var sizeEl = h('span', 'col-size');
      var timeEl = h('span', 'col-time');
      row.appendChild(sizeEl);
      row.appendChild(timeEl);

      var ops = h('span', 'col-ops');
      var opButtons = {};
      OPS.forEach(function (op) {
        var b = h('button', 'op' + (op.danger ? ' danger' : ''));
        b.type = 'button';
        b.dataset.op = op.key;
        b.title = op.title;
        b.setAttribute('aria-label', op.title);
        b.appendChild(icon(op.icon));
        ops.appendChild(b);
        opButtons[op.key] = b;
      });
      row.appendChild(ops);

      row._refs = {
        cb: input,
        icWrap: ic,
        icName: '',
        fname: fname,
        sizeEl: sizeEl,
        timeEl: timeEl,
        opButtons: opButtons
      };
    }
    row.dataset.fid = String(item.fid);
    updateRow(row, item);
    return row;
  }

  function updateRow(row, item) {
    var r = row._refs;
    if (!r) return;
    var fid = String(item.fid);
    if (row.dataset.fid !== fid) row.dataset.fid = fid;
    if (r.fname.textContent !== item.name) {
      r.fname.textContent = item.name;
      r.fname.title = item.name;
      r.cb.setAttribute('aria-label', '选择 ' + item.name);
    }
    var cachedDir = item.dir ? dirDetailCache.get(fid) : null;
    var sizeText = item.dir
      ? (cachedDir ? (cachedDir.size > 0 ? fmtSize(cachedDir.size) : '0 B') : '—')
      : fmtSize(item.size);
    if (r.sizeEl.textContent !== sizeText) r.sizeEl.textContent = sizeText;
    var sizeTitle = (item.dir && cachedDir) ? ('共 ' + fmtInt(cachedDir.items) + ' 项' + (cachedDir.finished ? '' : '（统计中）')) : '';
    if (r.sizeEl.title !== sizeTitle) r.sizeEl.title = sizeTitle;
    var timeText = fmtTime(item.updatedAt || item.createdAt);
    if (r.timeEl.textContent !== timeText) r.timeEl.textContent = timeText;
    var wantCls = 'fileicon ' + catClass(item);
    var wantIcon = iconFor(item);
    if (r.icWrap.className !== wantCls || r.icName !== wantIcon) {
      r.icWrap.className = wantCls;
      r.icName = wantIcon;
      r.icWrap.textContent = '';
      r.icWrap.appendChild(icon(wantIcon));
    }
    if (r.opButtons.download) {
      r.opButtons.download.hidden = false;
      var dlTitle = item.dir ? '下载文件夹' : '下载';
      if (r.opButtons.download.title !== dlTitle) {
        r.opButtons.download.title = dlTitle;
        r.opButtons.download.setAttribute('aria-label', dlTitle);
      }
    }
    if (r.opButtons.unarchive) {
      r.opButtons.unarchive.hidden = !isArchiveItem(item);
    }
    var sel = state.selected.has(fid);
    if (r.cb.checked !== sel) r.cb.checked = sel;
    if (row.classList.contains('selected') !== sel) row.classList.toggle('selected', sel);
  }

  function refreshCachedRowHeight() {
    if (typeof getComputedStyle === 'function' && el.list) {
      var parsed = parseFloat(getComputedStyle(el.list).getPropertyValue('--row-h'));
      if (isFinite(parsed) && parsed > 0) cachedRowHeight = parsed;
    }
  }

  /** 可见行虚拟挂载：不销毁业务状态，缓存行节点引用与行高，60fps 零回流。 */
  function renderRows(seq, force) {
    if (seq !== listSeq) return;
    var items = displayItems();
    var count = items.length;
    var isGrid = state.viewMode === 'grid';

    if (!count) {
      rowMap.forEach(function (row) { recycleRow(row); });
      rowMap.clear();
      if (topSpacer && topSpacer.parentNode) { topSpacer.parentNode.removeChild(topSpacer); topSpacer = null; }
      if (bottomSpacer && bottomSpacer.parentNode) { bottomSpacer.parentNode.removeChild(bottomSpacer); bottomSpacer = null; }
      lastRenderKey = '';
      if (state.loadedOnce && !state.loading) {
        if (state.filter !== 'all' && state.items.length > 0) {
          renderEmpty('当前分类下没有匹配的项目', false, { clearFilter: true });
        } else if (needsLoginState()) {
          renderEmpty(state.expired ? '登录状态已失效，请重新登录' : '登录夸克账号后即可浏览、上传和下载你的网盘文件', false, { login: true });
        } else {
          renderEmpty(state.mode === 'search' ? '没有找到匹配的文件' : '这个文件夹是空的', false);
        }
      }
      return;
    }
    clearEmpty();
    clearSkeleton();

    if (!topSpacer) {
      topSpacer = h('div', 'list-spacer');
      bottomSpacer = h('div', 'list-spacer');
      topSpacer.setAttribute('aria-hidden', 'true');
      bottomSpacer.setAttribute('aria-hidden', 'true');
      el.list.appendChild(topSpacer);
      el.list.appendChild(bottomSpacer);
    }

    var range;
    if (isGrid) {
      var listW = (el.list && el.list.clientWidth) || (el.listwrap && el.listwrap.clientWidth) || 800;
      var gridCols = Math.max(1, Math.floor((listW - 28 + 10) / (178 + 10)));
      var gridRowH = 152;
      var totalRows = Math.ceil(count / gridCols);
      var rowRange = window.QKVirtualList.range(totalRows, el.listwrap.scrollTop,
        el.listwrap.clientHeight || 600, gridRowH, 3);
      range = {
        start: Math.min(count, rowRange.start * gridCols),
        end: Math.min(count, rowRange.end * gridCols),
        before: rowRange.before,
        after: rowRange.after
      };
      topSpacer.style.gridColumn = '1 / -1';
      bottomSpacer.style.gridColumn = '1 / -1';
      topSpacer.style.display = range.before > 0 ? 'block' : 'none';
      bottomSpacer.style.display = range.after > 0 ? 'block' : 'none';
    } else {
      topSpacer.style.gridColumn = '';
      bottomSpacer.style.gridColumn = '';
      topSpacer.style.display = '';
      bottomSpacer.style.display = '';
      range = window.QKVirtualList.range(count, el.listwrap.scrollTop,
        el.listwrap.clientHeight || 600, cachedRowHeight, VIRTUAL_OVERSCAN);
    }

    var renderKey = range.start + ':' + range.end + ':' + count + ':' + listVersion + ':' + state.viewMode + ':' + state.focusIndex;
    if (!force && renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;

    var visible = new Set();
    for (var i = range.start; i < range.end; i++) visible.add(String(items[i].fid));
    rowMap.forEach(function (row, fid) {
      if (!visible.has(fid)) {
        recycleRow(row);
        rowMap.delete(fid);
      }
    });

    topSpacer.style.height = range.before + 'px';
    bottomSpacer.style.height = range.after + 'px';
    var ref = topSpacer.nextSibling;
    var setSize = String(state.filter === 'all' && state.total >= 0 ? state.total : count);
    var visibleDirs = [];
    for (var j = range.start; j < range.end; j++) {
      var item = items[j];
      var key = String(item.fid);
      var row = rowMap.get(key);
      if (!row) {
        row = acquireRow(item);
        rowMap.set(key, row);
      } else {
        updateRow(row, item);
      }
      if (item.dir) visibleDirs.push(item);
      row.dataset.index = String(j);
      row.classList.toggle('focused', j === state.focusIndex);
      row.setAttribute('aria-posinset', String(j + 1));
      row.setAttribute('aria-setsize', setSize);
      if (row === ref) ref = ref.nextSibling;
      else el.list.insertBefore(row, ref || bottomSpacer);
    }
    if (visibleDirs.length) {
      prefetchFolderSizes(visibleDirs, seq);
    }
  }

  var listFrameTimer = null;
  function scheduleRows() {
    if (listFrame !== null || listFrameTimer !== null) return;
    var flush = function () {
      if (listFrame !== null) { cancelAnimationFrame(listFrame); listFrame = null; }
      if (listFrameTimer !== null) { clearTimeout(listFrameTimer); listFrameTimer = null; }
      if (state.view === 'files') renderRows(listSeq, false);
    };
    listFrame = requestAnimationFrame(flush);
    listFrameTimer = setTimeout(flush, 60);
  }

  function renderEmpty(message, isError, opts) {
    clearEmpty();
    clearSkeleton();
    var o = opts || {};
    var showLogin = o.login === true || (!o.clearFilter && needsLoginState());
    var box = h('div', 'empty' + (isError ? ' empty-error' : ''));
    box.id = 'list-empty';
    box.appendChild(icon(isError ? 'error' : (showLogin ? 'cloud' : 'folder-open'), 'empty-ic'));
    box.appendChild(h('div', 'empty-title', message));
    if (o.clearFilter) {
      box.appendChild(h('div', 'empty-sub', '当前目录共有 ' + state.items.length + ' 项，可切回「全部」查看。'));
      var resetBtn = h('button', 'btn btn-sm empty-action', '查看全部文件');
      resetBtn.type = 'button';
      resetBtn.addEventListener('click', function () { setFilter('all'); });
      box.appendChild(resetBtn);
    } else if (showLogin) {
      var loginBtn = h('button', 'btn btn-primary empty-action', state.expired ? '重新登录夸克账号' : '登录夸克账号');
      loginBtn.type = 'button';
      loginBtn.addEventListener('click', doLogin);
      box.appendChild(loginBtn);
      var msgStr = String(message || '');
      if (msgStr.indexOf('登录后即可') < 0 && msgStr.indexOf('登录夸克账号后即可') < 0) {
        box.appendChild(h('div', 'empty-sub', '扫码登录后即可高速浏览、上传、下载与增量备份。'));
      }
    } else if (isError) {
      var retryBtn = h('button', 'btn btn-sm btn-primary empty-action', '重新加载');
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', function () { reloadCurrent(); });
      box.appendChild(retryBtn);
    } else {
      box.appendChild(h('div', 'empty-sub', state.mode === 'search'
        ? '换个关键词试试，或点击「返回目录」恢复浏览。'
        : '把文件拖拽到窗口，或点击下方快捷操作开始使用。'));
      if (state.mode === 'browse') {
        var emptyBtns = h('div', 'empty-actions');
        emptyBtns.style.display = 'inline-flex';
        emptyBtns.style.gap = '8px';
        emptyBtns.style.marginTop = '10px';
        var upBtn = h('button', 'btn btn-sm btn-primary', '上传文件');
        upBtn.type = 'button';
        upBtn.addEventListener('click', onUploadClick);
        var mkBtn = h('button', 'btn btn-sm', '新建文件夹');
        mkBtn.type = 'button';
        mkBtn.addEventListener('click', onMkdirClick);
        emptyBtns.appendChild(upBtn);
        emptyBtns.appendChild(mkBtn);
        box.appendChild(emptyBtns);
      }
    }
    // 关键：挂载在 #list 内部，确保空态/登录引导始终居中显示在可视区
    el.list.appendChild(box);
  }

  function clearEmpty() {
    var n = $('list-empty');
    if (n && n.parentNode) n.parentNode.removeChild(n);
  }

  function renderListFoot() {
    var foot = el.listfoot;
    foot.textContent = '';
    if (state.loading && state.items.length) {
      var l = h('div', 'foot-line');
      l.appendChild(h('span', 'spinner'));
      l.appendChild(h('span', null, '加载中…'));
      foot.appendChild(l);
      return;
    }
    if (!state.loadedOnce) return;
    if (state.hasMore) {
      var moreWrap = h('div', 'foot-line muted');
      var moreBtn = h('button', 'btn btn-sm btn-ghost', '加载更多');
      moreBtn.type = 'button';
      moreBtn.addEventListener('click', function () { loadPage({}); });
      moreWrap.appendChild(moreBtn);
      foot.appendChild(moreWrap);
      return;
    }
    var visibleCount = displayItems().length;
    if (!visibleCount) return;
    var totalText = state.filter !== 'all'
      ? ('当前筛选显示 ' + visibleCount + ' / ' + state.items.length + ' 项')
      : (state.total >= 0 ? ('已全部加载，共 ' + state.total + ' 项') : '没有更多了');
    foot.appendChild(h('div', 'foot-line muted', totalText));
  }

  function renderStatusBar() {
    if (!el.statusbarSummary) return;
    if (!API.injected) {
      el.statusbarSummary.textContent = '未连接客户端后端';
      return;
    }
    if (needsLoginState()) {
      el.statusbarSummary.textContent = state.expired ? '登录态已失效' : '未登录';
      return;
    }
    var visible = displayItems();
    var dirs = 0;
    var files = 0;
    for (var i = 0; i < visible.length; i++) {
      if (visible[i].dir) dirs += 1; else files += 1;
    }
    var parts = [];
    if (state.mode === 'search') parts.push('搜索「' + state.keyword + '」');
    if (state.total >= 0 && state.filter === 'all') {
      parts.push('共 ' + state.total + ' 项（已加载 ' + visible.length + ' 项：' + dirs + ' 文件夹 · ' + files + ' 文件）');
    } else if (state.filter !== 'all') {
      var filterNames = { dir: '文件夹', image: '图片', video: '视频', doc: '文档', audio: '音频', archive: '压缩包' };
      parts.push('已筛选「' + (filterNames[state.filter] || state.filter) + '」：' + visible.length + ' / ' + state.items.length + ' 项');
    } else {
      parts.push('当前显示 ' + visible.length + ' 项（' + dirs + ' 文件夹 · ' + files + ' 文件）');
    }
    if (state.selected.size > 0) {
      var selBytes = 0;
      state.selected.forEach(function (fid) {
        var it = state.itemMap[fid];
        if (it && !it.dir && it.size > 0) selBytes += Number(it.size) || 0;
      });
      parts.push('已选 ' + state.selected.size + ' 项' + (selBytes > 0 ? ' · ' + fmtSize(selBytes) : ''));
    }
    el.statusbarSummary.textContent = parts.join('  |  ');
  }

  function updateSelectAll() {
    var box = el.checkAll;
    var items = displayItems();
    var loaded = items.length;
    var visibleSet = new Set();
    for (var i = 0; i < loaded; i++) visibleSet.add(String(items[i].fid));
    var visibleSelCount = 0;
    var totalSelCount = 0;
    var selBytes = 0;
    var singleSelectedItem = null;
    state.selected.forEach(function (fid) {
      var it = state.itemMap[fid];
      if (it) {
        totalSelCount += 1;
        singleSelectedItem = it;
        if (visibleSet.has(fid)) visibleSelCount += 1;
        if (!it.dir && it.size > 0) selBytes += Number(it.size) || 0;
      }
    });
    box.checked = loaded > 0 && visibleSelCount >= loaded;
    box.indeterminate = visibleSelCount > 0 && visibleSelCount < loaded;
    box.disabled = loaded === 0;

    if (el.bulkUnarchive) {
      var showBulkUnarchive = totalSelCount === 1
        && !!singleSelectedItem
        && isArchiveItem(singleSelectedItem)
        && API.has('archive', 'preview');
      el.bulkUnarchive.hidden = !showBulkUnarchive;
    }

    var hiddenSel = Math.max(0, totalSelCount - visibleSelCount);
    if (el.fileCard) el.fileCard.classList.toggle('has-selection', totalSelCount > 0);
    if (totalSelCount > 0) {
      el.bulkCount.textContent = '已选 ' + totalSelCount + ' 项'
        + (selBytes > 0 ? ' · ' + fmtSize(selBytes) : '')
        + (hiddenSel > 0 ? ('（含 ' + hiddenSel + ' 个已筛选隐藏项）') : '');
      var shouldDefer = deferBulkDockOnce && el.bulkbar.hidden;
      deferBulkDockOnce = false;
      if (shouldDefer) {
        if (bulkDockTimer) { clearTimeout(bulkDockTimer); bulkDockTimer = null; }
        el.bulkbar.classList.add('bulk-dock-delay');
        el.bulkbar.hidden = false;
        bulkDockTimer = setTimeout(function () {
          bulkDockTimer = null;
          if (!el.bulkbar.hidden) el.bulkbar.classList.remove('bulk-dock-delay');
        }, 180);
      } else {
        if (bulkDockTimer) { clearTimeout(bulkDockTimer); bulkDockTimer = null; }
        el.bulkbar.classList.remove('bulk-dock-delay');
        el.bulkbar.hidden = false;
      }
    } else {
      deferBulkDockOnce = false;
      if (bulkDockTimer) { clearTimeout(bulkDockTimer); bulkDockTimer = null; }
      el.bulkbar.classList.remove('bulk-dock-delay');
      el.bulkbar.hidden = true;
    }
    renderStatusBar();
    if (state.inspectorOpen) renderInspector();
  }

  function setSelected(fid, on) {
    fid = String(fid);
    if (on) state.selected.add(fid); else state.selected.delete(fid);
    var row = rowMap.get(fid);
    if (row) {
      row.classList.toggle('selected', on);
      var cb = row._refs ? row._refs.cb : row.querySelector('input[type=checkbox]');
      if (cb) cb.checked = on;
    }
    listVersion += 1;
    updateSelectAll();
  }

  function clearSelection() {
    var fids = Array.from(state.selected);
    state.selected.clear();
    fids.forEach(function (fid) {
      var row = rowMap.get(fid);
      if (row) {
        row.classList.remove('selected');
        var cb = row._refs ? row._refs.cb : row.querySelector('input[type=checkbox]');
        if (cb) cb.checked = false;
      }
    });
    state.lastIndex = -1;
    listVersion += 1;
    updateSelectAll();
  }

  /**
   * 切换选中态：
   * - 勾选复选框始终为增量多选（不清空其他已选项）；Ctrl/Cmd 点击同理；
   * - Shift 支持连续区间选中；
   * - 绝不对复选框 click 调用 preventDefault，以原生 checked 为准同步 state。
   */
  function toggleSelect(fid, index, e) {
    fid = String(fid);
    var shift = e && e.shiftKey;
    var ctrl = e && (e.ctrlKey || e.metaKey);
    var row = rowMap.get(fid);
    var box = row ? (row._refs ? row._refs.cb : row.querySelector('input[type=checkbox]')) : null;
    var checkboxClick = e && e.target && e.target.type === 'checkbox';
    var on = checkboxClick && box ? !!box.checked : !state.selected.has(fid);
    var items = displayItems();

    if (shift && state.lastIndex >= 0) {
      var a = Math.min(state.lastIndex, index);
      var b = Math.max(state.lastIndex, index);
      for (var i = a; i <= b; i++) {
        var it = items[i];
        if (it) {
          if (on) state.selected.add(String(it.fid)); else state.selected.delete(String(it.fid));
        }
      }
      listVersion += 1;
      renderRows(listSeq, true);
      updateSelectAll();
      state.lastIndex = index;
      return;
    }
    if (ctrl || checkboxClick) {
      setSelected(fid, on);
      state.lastIndex = index;
      return;
    }
    clearSelection();
    if (on) setSelected(fid, true);
    state.lastIndex = index;
  }

  /* ================================================================== *
   * 文件详情侧栏（Inspector）+ 文件夹大小自动回填 + 历史版本
   * ================================================================== */

  function formatFullPath(fp) {
    if (!fp) return '';
    if (Array.isArray(fp)) {
      var names = fp.map(function (c) { return c && c.name ? String(c.name) : ''; }).filter(Boolean);
      return names.length ? ('/' + names.join('/')) : '';
    }
    return String(fp);
  }

  var runtimeTuning = {
    version: 0,
    dirDetailNegCacheMs: 300000,
    dirDetailConcurrency: 2
  };
  function applyRuntimeTuning(t) {
    if (!t || typeof t !== 'object') return;
    if (typeof t.version === 'number' && isFinite(t.version)) runtimeTuning.version = t.version;
    if (typeof t.dirDetailNegCacheMs === 'number' && isFinite(t.dirDetailNegCacheMs)) {
      runtimeTuning.dirDetailNegCacheMs = Math.max(10000, Math.min(3600000, t.dirDetailNegCacheMs));
    }
    if (typeof t.dirDetailConcurrency === 'number' && isFinite(t.dirDetailConcurrency)) {
      runtimeTuning.dirDetailConcurrency = Math.max(1, Math.min(4, Math.round(t.dirDetailConcurrency)));
    }
  }

  async function fetchDirDetail(fid, opts) {
    var key = String(fid || '');
    var o = opts || {};
    if (!key || !API.has('fs', 'dirDetail')) return null;
    var cached = dirDetailCache.get(key);
    var now = Date.now();
    if (!o.force && cached && cached.failed && (now - cached.ts) < runtimeTuning.dirDetailNegCacheMs) {
      return null;
    }
    if (!o.force && cached && !cached.failed && cached.finished && (now - cached.ts) < 60000) {
      return cached;
    }
    if (!o.force && dirDetailInflight.has(key)) {
      return dirDetailInflight.get(key);
    }
    var p = (async function () {
      try {
        var res = await API.fs.dirDetail(key);
        if (!res || typeof res !== 'object') {
          dirDetailCache.set(key, { fid: key, failed: true, ts: Date.now() });
          return null;
        }
        var entry = {
          fid: key,
          size: Math.max(0, Number(res.size) || 0),
          items: Math.max(0, Number(res.items) || 0),
          finished: res.finished !== false,
          failed: false,
          ts: Date.now()
        };
        dirDetailCache.set(key, entry);
        var row = rowMap.get(key);
        var it = findItem(key);
        if (row && it) updateRow(row, it);
        if (state.inspectorOpen && state.inspectorFid === key && it) {
          renderInspector(it);
        }
        return entry;
      } catch (_) {
        dirDetailCache.set(key, { fid: key, failed: true, ts: Date.now() });
        return null;
      } finally {
        dirDetailInflight.delete(key);
      }
    })();
    dirDetailInflight.set(key, p);
    return p;
  }

  /**
   * 自动后台统计当前可视区内的文件夹真实大小并即时回填列表「大小」列，
   * 无需点开详情抽屉；并发受远端热配置控制（默认 2），对 500/超时目录自动负缓存冷却。
   */
  function prefetchFolderSizes(dirs, seq) {
    if (!API.injected || needsLoginState() || !API.has('fs', 'dirDetail')) return;
    var queue = [];
    var now = Date.now();
    for (var i = 0; i < dirs.length; i++) {
      var d = dirs[i];
      if (!d || !d.dir || !d.fid) continue;
      var fid = String(d.fid);
      var cached = dirDetailCache.get(fid);
      if (cached && cached.failed && (now - cached.ts) < runtimeTuning.dirDetailNegCacheMs) continue;
      if (cached && !cached.failed && cached.finished && (now - cached.ts) < 60000) continue;
      if (cached && !cached.failed && !cached.finished && cached.nextRetryAt && now < cached.nextRetryAt) continue;
      if (dirDetailInflight.has(fid)) continue;
      queue.push(fid);
    }
    if (!queue.length) return;
    var concurrency = Math.min(runtimeTuning.dirDetailConcurrency || 2, queue.length);
    for (var w = 0; w < concurrency; w++) {
      (async function () {
        while (queue.length) {
          if (seq !== listSeq || state.view !== 'files' || needsLoginState()) return;
          var nextFid = queue.shift();
          if (!nextFid) continue;
          var entry = await fetchDirDetail(nextFid);
          if (entry && !entry.finished && seq === listSeq && state.view === 'files') {
            entry.nextRetryAt = Date.now() + 8000;
            (function (retryFid) {
              setTimeout(function () {
                if (seq !== listSeq || state.view !== 'files' || needsLoginState()) return;
                fetchDirDetail(retryFid, { force: true });
              }, 2000);
            })(nextFid);
          }
        }
      })();
    }
  }

  function setInspectorOpen(open) {
    state.inspectorOpen = !!open;
    if (el.fileInspector) el.fileInspector.hidden = !state.inspectorOpen;
    if (el.btnInspector) {
      el.btnInspector.classList.toggle('active', state.inspectorOpen);
      el.btnInspector.setAttribute('aria-pressed', state.inspectorOpen ? 'true' : 'false');
    }
    if (state.inspectorOpen) renderInspector();
  }

  function renderInspector(detailedItem) {
    if (!state.inspectorOpen || !el.inspectorBody) return;
    var body = el.inspectorBody;
    body.textContent = '';
    var sel = selectedItems();
    if (!detailedItem && sel.length > 1) {
      state.inspectorFid = null;
      var selDirs = sel.filter(function (x) { return x.dir; });
      var selFiles = sel.filter(function (x) { return !x.dir; });
      var fileBytes = selFiles.reduce(function (acc, x) { return acc + (Number(x.size) || 0); }, 0);
      var dirs = selDirs.length;
      var files = selFiles.length;
      var multiHero = h('div', 'inspector-hero');
      var mic = h('span', 'fileicon cat-dir');
      mic.appendChild(icon('folder'));
      multiHero.appendChild(mic);
      multiHero.appendChild(h('div', 'inspector-name', '已选中 ' + sel.length + ' 个项目'));
      body.appendChild(multiHero);

      var multiMeta = h('div', 'inspector-meta');
      function addMultiKv(k, v) {
        var row = h('div', 'inspector-kv');
        row.appendChild(h('span', 'inspector-k', k));
        row.appendChild(h('span', 'inspector-v', v));
        multiMeta.appendChild(row);
      }
      addMultiKv('文件夹', dirs + ' 个');
      addMultiKv('文件', files + ' 个');
      if (files > 0) addMultiKv('已选文件大小', fmtSize(fileBytes));

      if (dirs > 0 && API.has('fs', 'dirDetail')) {
        var allCached = selDirs.every(function (d) { return dirDetailCache.has(String(d.fid)); });
        if (allCached) {
          var dirBytes = 0;
          var dirItems = 0;
          selDirs.forEach(function (d) {
            var c = dirDetailCache.get(String(d.fid));
            if (c) { dirBytes += c.size; dirItems += c.items; }
          });
          addMultiKv('含文件夹总大小', fmtSize(fileBytes + dirBytes));
          addMultiKv('文件夹内含项数', fmtInt(dirItems) + ' 项');
        }
        var calcBtn = h('button', 'btn btn-sm inspector-calc-btn');
        calcBtn.type = 'button';
        calcBtn.id = 'btn-inspector-calc-multi';
        calcBtn.appendChild(icon('refresh'));
        calcBtn.appendChild(h('span', null, allCached ? '重新统计含文件夹大小' : '统计含文件夹的总大小'));
        calcBtn.addEventListener('click', async function () {
          calcBtn.disabled = true;
          calcBtn.lastChild.textContent = '正在统计文件夹大小…';
          var queue = selDirs.slice();
          var workers = [];
          var concurrency = Math.min(4, queue.length);
          for (var w = 0; w < concurrency; w++) {
            workers.push((async function () {
              while (queue.length) {
                var next = queue.shift();
                if (next) await fetchDirDetail(next.fid, { force: true });
              }
            })());
          }
          await Promise.all(workers);
          if (state.inspectorOpen) renderInspector();
        });
        multiMeta.appendChild(calcBtn);
      }
      body.appendChild(multiMeta);

      var mActs = h('div', 'inspector-actions');
      if (sel.length > 0) {
        var dlAll = h('button', 'btn btn-sm btn-primary');
        dlAll.type = 'button';
        dlAll.appendChild(icon('download'));
        dlAll.appendChild(h('span', null, dirs > 0 ? ('下载已选项目 (' + sel.length + ')') : ('下载已选文件 (' + selFiles.length + ')')));
        dlAll.addEventListener('click', function () { downloadItems(sel); });
        mActs.appendChild(dlAll);

        var dlAllPick = h('button', 'btn btn-sm');
        dlAllPick.type = 'button';
        dlAllPick.appendChild(icon('folder-open'));
        dlAllPick.appendChild(h('span', null, '下载到指定位置…'));
        dlAllPick.addEventListener('click', function () { downloadItems(sel, { pickDir: true }); });
        mActs.appendChild(dlAllPick);
      }
      var mvAll = h('button', 'btn btn-sm');
      mvAll.type = 'button';
      mvAll.appendChild(icon('move'));
      mvAll.appendChild(h('span', null, '移动到…'));
      mvAll.addEventListener('click', function () { doTransferOp('move', sel); });
      mActs.appendChild(mvAll);

      var cpAll = h('button', 'btn btn-sm');
      cpAll.type = 'button';
      cpAll.appendChild(icon('copy'));
      cpAll.appendChild(h('span', null, '复制到…'));
      cpAll.addEventListener('click', function () { doTransferOp('copy', sel); });
      mActs.appendChild(cpAll);

      var rmAll = h('button', 'btn btn-sm btn-danger');
      rmAll.type = 'button';
      rmAll.appendChild(icon('trash'));
      rmAll.appendChild(h('span', null, '删除已选'));
      rmAll.addEventListener('click', function () { doRemove(sel, { bulk: true }); });
      mActs.appendChild(rmAll);

      body.appendChild(mActs);
      return;
    }
    var item = detailedItem || (sel.length === 1 ? sel[0] : (state.inspectorFid ? findItem(state.inspectorFid) : null));
    if (!item) {
      body.appendChild(h('div', 'inspector-empty', '单击任意文件或文件夹可在此查看详细信息与快捷操作。'));
      return;
    }
    var fidStr = String(item.fid);
    state.inspectorFid = fidStr;
    var hero = h('div', 'inspector-hero');
    var ic = h('span', 'fileicon ' + catClass(item));
    ic.appendChild(icon(iconFor(item)));
    hero.appendChild(ic);
    hero.appendChild(h('div', 'inspector-name', item.name));
    body.appendChild(hero);

    var meta = h('div', 'inspector-meta');
    function addKv(k, v, opts) {
      if (v === undefined || v === null || v === '') return;
      var o = typeof opts === 'boolean' ? { mono: opts } : (opts || {});
      var row = h('div', 'inspector-kv');
      row.appendChild(h('span', 'inspector-k', k));
      if (o.copyLabel || o.actionBtn) {
        var line = h('div', 'inspector-kv-line');
        line.appendChild(h('span', 'inspector-v' + (o.mono ? ' mono' : ''), String(v)));
        if (o.copyLabel) {
          var cb = h('button', 'inspector-mini-btn');
          cb.type = 'button';
          cb.title = '复制' + o.copyLabel;
          cb.setAttribute('aria-label', '复制' + o.copyLabel);
          cb.appendChild(icon('copy'));
          cb.addEventListener('click', function () { copyText(String(v), o.copyLabel); });
          line.appendChild(cb);
        }
        if (o.actionBtn) line.appendChild(o.actionBtn);
        row.appendChild(line);
      } else {
        row.appendChild(h('span', 'inspector-v' + (o.mono ? ' mono' : ''), String(v)));
      }
      meta.appendChild(row);
    }

    var typeDesc = item.dir
      ? '文件夹'
      : ((item.ext ? item.ext.toUpperCase() + ' 文件' : '文件') + (item.formatType ? ' · ' + item.formatType : ''));
    addKv('类型', typeDesc);

    if (item.dir) {
      var dInfo = dirDetailCache.get(fidStr);
      var refreshDirBtn = h('button', 'inspector-mini-btn');
      refreshDirBtn.type = 'button';
      refreshDirBtn.id = 'btn-inspector-dir-refresh';
      refreshDirBtn.title = '重新统计文件夹大小';
      refreshDirBtn.setAttribute('aria-label', '重新统计文件夹大小');
      refreshDirBtn.appendChild(icon('refresh'));
      refreshDirBtn.addEventListener('click', function () {
        dirDetailCache.delete(fidStr);
        renderInspector(item);
        fetchDirDetail(fidStr, { force: true }).then(function () {
          if (state.inspectorOpen && state.inspectorFid === fidStr) renderInspector(item);
        });
      });
      if (dInfo) {
        var sizeStr = (dInfo.size > 0 ? fmtSize(dInfo.size) : '0 B') + '（' + fmtInt(dInfo.size) + ' 字节）';
        addKv('文件夹大小', dInfo.finished ? sizeStr : ('统计中 · 当前 ' + fmtSize(dInfo.size)), { actionBtn: refreshDirBtn });
        addKv('内含项目', fmtInt(dInfo.items) + ' 项' + (dInfo.finished ? '' : '（扫描中…）'));
      } else if (API.has('fs', 'dirDetail')) {
        addKv('文件夹大小', '正在统计…', { actionBtn: refreshDirBtn });
        if (item.includeItems > 0) addKv('直接子项', fmtInt(item.includeItems) + ' 项');
      } else if (item.includeItems > 0) {
        addKv('直接子项', fmtInt(item.includeItems) + ' 项');
      }
    } else {
      addKv('大小', fmtSize(item.size) + '（' + fmtInt(item.size) + ' 字节）');
    }

    var fullPathText = formatFullPath(item.fullPath);
    if (fullPathText) {
      var pathRow = h('div', 'inspector-kv');
      pathRow.appendChild(h('span', 'inspector-k', '云端位置'));
      if (item.pdirFid && (state.mode === 'search' || String(item.pdirFid) !== String(state.fid))) {
        var pathBtn = h('button', 'inspector-path-link', fullPathText);
        pathBtn.type = 'button';
        pathBtn.title = '前往所在目录';
        pathBtn.addEventListener('click', function () {
          navigate(item.pdirFid, item.pdirFid === ROOT_FID ? '全部文件' : '上级目录');
        });
        pathRow.appendChild(pathBtn);
      } else {
        pathRow.appendChild(h('span', 'inspector-v', fullPathText));
      }
      meta.appendChild(pathRow);
    }

    var durText = fmtDuration(item.duration);
    if (durText || (item.fps && item.fps > 0)) {
      var mediaParts = [];
      if (durText) mediaParts.push('时长 ' + durText);
      if (item.fps && item.fps > 0) mediaParts.push(Math.round(item.fps * 10) / 10 + ' fps');
      addKv('媒体参数', mediaParts.join(' · '));
    }
    var srcText = fmtSource(item.source);
    if (srcText) addKv('文件来源', srcText);
    addKv('修改时间', fmtTime(item.updatedAt || item.createdAt));
    if (item.createdAt) addKv('创建时间', fmtTime(item.createdAt));
    if (item.operatedAt && item.operatedAt !== item.updatedAt) addKv('最近操作', fmtTime(item.operatedAt));
    addKv('云端 ID (fid)', fidStr, { mono: true, copyLabel: '云端 ID' });
    if (item.md5) addKv('MD5', String(item.md5), { mono: true, copyLabel: 'MD5' });
    if (item.sha1) addKv('SHA-1', String(item.sha1), { mono: true, copyLabel: 'SHA-1' });
    body.appendChild(meta);

    var acts = h('div', 'inspector-actions');
    var primary = h('button', 'btn btn-sm btn-primary');
    primary.type = 'button';
    primary.appendChild(icon(item.dir ? 'folder-open' : 'download'));
    primary.appendChild(h('span', null, item.dir ? '打开文件夹' : '下载到本地'));
    primary.addEventListener('click', function () { openItem(item); });
    acts.appendChild(primary);

    if (isArchiveItem(item) && API.has('archive', 'preview')) {
      var unzipBtn = h('button', 'btn btn-sm');
      unzipBtn.type = 'button';
      unzipBtn.id = 'btn-inspector-unarchive';
      unzipBtn.appendChild(icon('file-archive'));
      unzipBtn.appendChild(h('span', null, '云解压 / 浏览内容'));
      unzipBtn.addEventListener('click', function () { openArchiveModal(item); });
      acts.appendChild(unzipBtn);
    }

    if (item.dir) {
      var dlDirBtn = h('button', 'btn btn-sm');
      dlDirBtn.type = 'button';
      dlDirBtn.appendChild(icon('download'));
      dlDirBtn.appendChild(h('span', null, '下载文件夹'));
      dlDirBtn.addEventListener('click', function () { downloadItems([item]); });
      acts.appendChild(dlDirBtn);
    }

    var dlAsBtn = h('button', 'btn btn-sm');
    dlAsBtn.type = 'button';
    dlAsBtn.appendChild(icon('folder-open'));
    dlAsBtn.appendChild(h('span', null, '下载到指定位置…'));
    dlAsBtn.addEventListener('click', function () { downloadItems([item], { pickDir: true }); });
    acts.appendChild(dlAsBtn);

    var renameBtn = h('button', 'btn btn-sm');
    renameBtn.type = 'button';
    renameBtn.appendChild(icon('rename'));
    renameBtn.appendChild(h('span', null, '重命名'));
    renameBtn.addEventListener('click', function () { onRename(item); });
    acts.appendChild(renameBtn);

    var copyNameBtn = h('button', 'btn btn-sm');
    copyNameBtn.type = 'button';
    copyNameBtn.appendChild(icon('copy'));
    copyNameBtn.appendChild(h('span', null, '复制名称'));
    copyNameBtn.addEventListener('click', function () { copyText(item.name, '文件名'); });
    acts.appendChild(copyNameBtn);

    var delBtn = h('button', 'btn btn-sm btn-ghost');
    delBtn.type = 'button';
    delBtn.appendChild(icon('trash'));
    delBtn.appendChild(h('span', null, '删除'));
    delBtn.addEventListener('click', function () { doRemove([item]); });
    acts.appendChild(delBtn);
    body.appendChild(acts);

    // 历史版本（仅普通文件，按需展开查询）
    if (!item.dir && API.has('fs', 'revisions')) {
      var revSec = h('div', 'inspector-rev-section');
      var revBtn = h('button', 'btn btn-sm btn-ghost inspector-rev-toggle');
      revBtn.type = 'button';
      revBtn.id = 'btn-inspector-revisions';
      var revLeft = h('span', null);
      revLeft.style.display = 'inline-flex';
      revLeft.style.alignItems = 'center';
      revLeft.style.gap = '6px';
      revLeft.appendChild(icon('history'));
      revLeft.appendChild(h('span', null, '历史版本'));
      revBtn.appendChild(revLeft);
      var revChevron = h('span', 'muted', '展开');
      revBtn.appendChild(revChevron);
      var revBox = h('div', 'inspector-rev-box');
      revBox.hidden = true;
      var revLoaded = false;

      revBtn.addEventListener('click', async function () {
        if (!revBox.hidden) {
          revBox.hidden = true;
          revChevron.textContent = '展开';
          return;
        }
        revBox.hidden = false;
        revChevron.textContent = '收起';
        if (revLoaded) return;
        revBox.textContent = '';
        revBox.appendChild(h('div', 'inspector-rev-empty', '正在读取历史版本…'));
        try {
          var res = await API.fs.revisions(fidStr);
          var list = (res && Array.isArray(res.list)) ? res.list : [];
          revLoaded = true;
          revBox.textContent = '';
          if (!list.length) {
            revBox.appendChild(h('div', 'inspector-rev-empty', '暂无可用的历史版本记录'));
            return;
          }
          list.forEach(function (rv) {
            var row = h('div', 'inspector-rev-item');
            var left = h('div', 'inspector-rev-meta');
            left.appendChild(h('div', 'inspector-rev-time', fmtTime(rv.updatedAt) || ('版本 #' + rv.version)));
            var sub = h('div', 'inspector-rev-sub');
            sub.appendChild(h('span', null, fmtSize(rv.size)));
            if (rv.version) sub.appendChild(h('span', null, 'v' + rv.version));
            if (rv.current) sub.appendChild(h('span', 'inspector-rev-tag', '当前'));
            left.appendChild(sub);
            row.appendChild(left);
            if (!rv.current && API.has('fs', 'revertRevision')) {
              var rb = h('button', 'btn btn-sm', '恢复');
              rb.type = 'button';
              rb.addEventListener('click', async function () {
                var ok = await confirmDialog({
                  title: '恢复历史版本',
                  message: '确认将「' + item.name + '」恢复到 ' + (fmtTime(rv.updatedAt) || ('版本 v' + rv.version)) + '？',
                  detail: '恢复后当前版本内容会被替换为该历史版本。',
                  confirmText: '恢复此版本'
                });
                if (!ok) return;
                try {
                  await API.fs.revertRevision({ fid: fidStr, version: rv.version });
                  toast('ok', '已恢复到所选历史版本');
                  invalidateDirCache(state.fid);
                  item._infoLoaded = false;
                  reloadCurrent();
                  revLoaded = false;
                  revBox.hidden = true;
                  revChevron.textContent = '展开';
                } catch (err) {
                  reportError(err, '恢复历史版本失败');
                }
              });
              row.appendChild(rb);
            }
            revBox.appendChild(row);
          });
        } catch (err) {
          revBox.textContent = '';
          var e2 = API.normalizeError(err, '读取历史版本失败');
          revBox.appendChild(h('div', 'inspector-rev-empty', e2.message));
        }
      });
      revSec.appendChild(revBtn);
      revSec.appendChild(revBox);
      body.appendChild(revSec);
    }

    // 后台自动补齐文件夹真实大小 + 完整元信息（fs.info），同 fid 重复渲染不取消在途请求
    if (item.dir && API.has('fs', 'dirDetail') && !item._dirDetailPending) {
      var curDir = dirDetailCache.get(fidStr);
      if (!curDir) {
        item._dirDetailPending = true;
        var dirSeq = ++inspectorSeq;
        fetchDirDetail(fidStr).then(function (d) {
          item._dirDetailPending = false;
          if (!state.inspectorOpen || state.inspectorFid !== fidStr) return;
          if (d) {
            renderInspector(item);
            if (!d.finished) {
              setTimeout(function () {
                if (dirSeq !== inspectorSeq || !state.inspectorOpen || state.inspectorFid !== fidStr) return;
                fetchDirDetail(fidStr, { force: true }).then(function (d2) {
                  if (!state.inspectorOpen || state.inspectorFid !== fidStr) return;
                  if (d2) renderInspector(item);
                });
              }, 1200);
            }
          }
        }).catch(function () { item._dirDetailPending = false; });
      }
    }
    if (!item._infoLoaded && !item._infoPending && API.has('fs', 'info')) {
      item._infoPending = true;
      API.fs.info(fidStr).then(function (full) {
        item._infoPending = false;
        item._infoLoaded = true;
        if (full && typeof full === 'object') {
          Object.assign(item, full);
          item._infoLoaded = true;
          if (state.inspectorOpen && state.inspectorFid === fidStr) {
            renderInspector(item);
          }
        }
      }).catch(function () { item._infoPending = false; });
    }
  }

  /* ================================================================== *
   * 云解压 / 在线浏览压缩包（支持目录钻取、密码解锁、勾选解压与同名覆盖）
   * ================================================================== */

  function openArchiveModal(item) {
    if (!item || !ensureLoggedInForWrite('云解压')) return;
    if (!API.has('archive', 'preview')) {
      toast('warn', '当前桥接层暂不支持云解压接口');
      return;
    }
    var fid = String(item.fid);
    var alive = true;
    var previewSeq = 0;
    var currentPathNo = '';
    var crumbs = [{ pathNo: '', name: item.name }];
    var currentEntries = [];
    var checkedPaths = new Set();
    var password = '';
    var extracting = false;
    var finishedToFid = '';
    var userPickedTarget = false;
    var target = {
      fid: (item.pdirFid !== undefined && item.pdirFid !== null && String(item.pdirFid) !== '')
        ? String(item.pdirFid)
        : String(state.fid || ROOT_FID),
      name: currentDirName()
    };

    openOverlay(function (ui) {
      ui.setResolve(function () { alive = false; });
      ui.panel.classList.add('dlg-archive');

      var head = h('div', 'dlg-head');
      head.appendChild(icon('file-archive', 'dlg-ic'));
      head.appendChild(h('h3', 'dlg-title', '云解压 · ' + item.name));
      ui.panel.appendChild(head);

      var headMeta = h('div', 'archive-head-meta');
      var sizeSpan = h('span', null, '压缩包大小：' + fmtSize(item.size));
      var countSpan = h('span', null, '');
      var rightPill = h('span', 'archive-right-pill');
      rightPill.hidden = true;
      headMeta.appendChild(sizeSpan);
      headMeta.appendChild(countSpan);
      headMeta.appendChild(rightPill);
      ui.panel.appendChild(headMeta);

      // 密码输入条（默认隐藏，遇到 27001 / 27002 时自动展开）
      var pwdBar = h('div', 'archive-pwd-bar');
      pwdBar.hidden = true;
      pwdBar.appendChild(icon('lock'));
      var pwdInput = h('input', 'input');
      pwdInput.type = 'password';
      pwdInput.id = 'archive-pwd-input';
      pwdInput.placeholder = '输入压缩包解压密码';
      pwdInput.autocomplete = 'off';
      var pwdSubmit = h('button', 'btn btn-sm btn-primary', '解锁');
      pwdSubmit.type = 'button';
      pwdSubmit.id = 'archive-pwd-submit';
      var pwdMsg = h('div', 'archive-pwd-msg', '该压缩包已加密，请输入解压密码后浏览或解压。');
      pwdBar.appendChild(pwdInput);
      pwdBar.appendChild(pwdSubmit);
      pwdBar.appendChild(pwdMsg);
      ui.panel.appendChild(pwdBar);

      // 目录面包屑工具栏
      var toolbar = h('div', 'picker-toolbar');
      var upBtn = h('button', 'btn btn-sm btn-ghost');
      upBtn.type = 'button';
      upBtn.title = '返回上一级';
      upBtn.disabled = true;
      upBtn.appendChild(icon('arrow-up'));
      upBtn.appendChild(h('span', null, '上一级'));
      var crumbBox = h('div', 'picker-crumbs');
      var refBtn = h('button', 'btn btn-sm btn-ghost');
      refBtn.type = 'button';
      refBtn.title = '刷新当前目录';
      refBtn.appendChild(icon('refresh'));
      toolbar.appendChild(upBtn);
      toolbar.appendChild(crumbBox);
      toolbar.appendChild(refBtn);
      ui.panel.appendChild(toolbar);

      var listBox = h('div', 'archive-list');
      ui.panel.appendChild(listBox);

      // 目标目录栏
      var targetBar = h('div', 'archive-target');
      var targetText = h('div', 'archive-target-path');
      targetText.appendChild(document.createTextNode('解压到：'));
      var targetStrong = h('strong', null, target.name);
      targetText.appendChild(targetStrong);
      var pickBtn = h('button', 'btn btn-sm', '更改目录…');
      pickBtn.type = 'button';
      pickBtn.id = 'archive-btn-pick-target';
      targetBar.appendChild(targetText);
      targetBar.appendChild(pickBtn);
      ui.panel.appendChild(targetBar);

      // 解压进度条
      var progBox = h('div', 'archive-progress');
      progBox.hidden = true;
      var progHead = h('div', 'archive-progress-head');
      var progLabel = h('span', null, '正在提交云解压任务…');
      var progPct = h('span', null, '0%');
      progHead.appendChild(progLabel);
      progHead.appendChild(progPct);
      var progBar = h('div', 'archive-progress-bar');
      var progFill = h('i');
      progBar.appendChild(progFill);
      progBox.appendChild(progHead);
      progBox.appendChild(progBar);
      ui.panel.appendChild(progBox);

      // 底部操作栏
      var foot = h('div', 'dlg-foot');
      var closeBtn = h('button', 'btn', '关闭');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', function () { ui.close(null); });

      var extractSelBtn = h('button', 'btn', '解压选中');
      extractSelBtn.type = 'button';
      extractSelBtn.id = 'archive-btn-extract-sel';
      extractSelBtn.hidden = true;

      var extractAllBtn = h('button', 'btn btn-primary', '全部解压');
      extractAllBtn.type = 'button';
      extractAllBtn.id = 'archive-btn-extract-all';

      var gotoBtn = h('button', 'btn btn-primary', '前往查看');
      gotoBtn.type = 'button';
      gotoBtn.id = 'archive-btn-goto';
      gotoBtn.hidden = true;
      gotoBtn.addEventListener('click', function () {
        var destFid = finishedToFid || target.fid;
        var destName = target.name || '解压目录';
        ui.close(destFid);
        setView('files');
        navigate(destFid, destName);
      });

      foot.appendChild(closeBtn);
      foot.appendChild(extractSelBtn);
      foot.appendChild(extractAllBtn);
      foot.appendChild(gotoBtn);
      ui.panel.appendChild(foot);

      function updateSelectionButtons() {
        var n = checkedPaths.size;
        extractSelBtn.hidden = n === 0 || !!finishedToFid;
        extractSelBtn.textContent = '解压选中 (' + n + ')';
        extractSelBtn.disabled = extracting || n === 0;
        extractAllBtn.hidden = !!finishedToFid;
        extractAllBtn.disabled = extracting;
        pickBtn.disabled = extracting;
      }

      function renderArchiveCrumbs() {
        upBtn.disabled = crumbs.length <= 1;
        crumbBox.textContent = '';
        crumbs.forEach(function (c, i) {
          if (i > 0) crumbBox.appendChild(icon('chevron', 'crumb-sep'));
          var b = h('button', 'crumb-item');
          b.type = 'button';
          b.textContent = c.name;
          b.disabled = i === crumbs.length - 1;
          b.addEventListener('click', function () {
            crumbs = crumbs.slice(0, i + 1);
            currentPathNo = c.pathNo;
            checkedPaths.clear();
            updateSelectionButtons();
            loadPreview(c.pathNo, 1, false, 0);
          });
          crumbBox.appendChild(b);
        });
        crumbBox.scrollLeft = crumbBox.scrollWidth;
      }

      upBtn.addEventListener('click', function () {
        if (crumbs.length <= 1) return;
        crumbs = crumbs.slice(0, crumbs.length - 1);
        var prev = crumbs[crumbs.length - 1];
        currentPathNo = prev.pathNo;
        checkedPaths.clear();
        updateSelectionButtons();
        loadPreview(prev.pathNo, 1, false, 0);
      });

      refBtn.addEventListener('click', function () {
        loadPreview(currentPathNo, 1, false, 0);
      });

      function submitPassword() {
        password = pwdInput.value;
        if (!password) {
          pwdMsg.textContent = '请输入解压密码';
          pwdInput.focus();
          return;
        }
        loadPreview(currentPathNo, 1, false, 0);
      }
      pwdSubmit.addEventListener('click', submitPassword);
      pwdInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitPassword(); }
      });

      pickBtn.addEventListener('click', async function () {
        var picked = await pickDirDialog({
          title: '选择云解压目标目录',
          confirmText: '解压到此处'
        });
        if (!alive || picked === null || picked === undefined) return;
        userPickedTarget = true;
        target.fid = String(picked);
        target.name = await dirNameOf(picked);
        if (!alive) return;
        targetStrong.textContent = target.name;
        if (finishedToFid) {
          finishedToFid = '';
          gotoBtn.hidden = true;
          updateSelectionButtons();
        }
      });

      function renderEntries(entries, hasMore, page) {
        listBox.textContent = '';
        if (!entries.length) {
          listBox.appendChild(h('div', 'picker-empty', '当前层级为空'));
          return;
        }
        entries.forEach(function (entry) {
          var row = h('div', 'archive-row' + (checkedPaths.has(entry.pathNo) ? ' selected' : ''));
          row.dataset.pathNo = entry.pathNo;

          var cbWrap = h('label', 'cb');
          var cb = h('input');
          cb.type = 'checkbox';
          cb.checked = checkedPaths.has(entry.pathNo);
          cb.setAttribute('aria-label', '选择 ' + entry.name);
          cb.addEventListener('change', function () {
            if (cb.checked) checkedPaths.add(entry.pathNo);
            else checkedPaths.delete(entry.pathNo);
            row.classList.toggle('selected', cb.checked);
            updateSelectionButtons();
          });
          cbWrap.appendChild(cb);
          cbWrap.appendChild(h('i'));
          row.appendChild(cbWrap);

          var icName = entry.isFolder ? 'folder' : iconFor({ dir: false, name: entry.name, ext: (entry.name.split('.').pop() || '') });
          row.appendChild(icon(icName, 'archive-row-ic' + (entry.isFolder ? ' dir' : '')));

          var nameEl = h('span', 'archive-row-name', entry.name);
          nameEl.title = entry.path || entry.name;
          row.appendChild(nameEl);

          row.appendChild(h('span', 'archive-row-size', entry.isFolder ? '文件夹' : fmtSize(entry.size)));

          if (entry.isFolder) {
            var enterBtn = h('button', 'picker-enter', '进入');
            enterBtn.type = 'button';
            var drill = function () {
              crumbs = crumbs.concat([{ pathNo: entry.pathNo, name: entry.name }]);
              currentPathNo = entry.pathNo;
              checkedPaths.clear();
              updateSelectionButtons();
              loadPreview(entry.pathNo, 1, false, 0);
            };
            enterBtn.addEventListener('click', drill);
            row.addEventListener('dblclick', drill);
            row.appendChild(enterBtn);
          } else {
            row.appendChild(h('span', null, ''));
          }
          listBox.appendChild(row);
        });

        if (hasMore) {
          var moreBtn = h('button', 'btn btn-sm picker-more', '加载更多条目');
          moreBtn.type = 'button';
          moreBtn.addEventListener('click', function () { loadPreview(currentPathNo, page + 1, true, 0); });
          listBox.appendChild(moreBtn);
        }
      }

      async function loadPreview(pathNo, page, append, pollAttempt) {
        var seq = append ? previewSeq : ++previewSeq;
        renderArchiveCrumbs();
        if (!append) {
          listBox.textContent = '';
          listBox.appendChild(h('div', 'picker-loading', pollAttempt > 0 ? '云端正在解析压缩包目录，请稍候…' : '正在加载压缩包目录…'));
        }
        try {
          var res = await API.archive.preview({
            fid: fid,
            pathNo: pathNo,
            pwd: password,
            page: page || 1,
            size: 100
          });
          if (!alive || seq !== previewSeq) return;
          pwdBar.hidden = true;
          if (res && res.finish === false) {
            if (pollAttempt < 12) {
              var gap = Math.max(500, Math.min(2500, Number(res.tqGap) || 800));
              setTimeout(function () {
                if (alive && seq === previewSeq) loadPreview(pathNo, page, append, pollAttempt + 1);
              }, gap);
              return;
            }
            listBox.textContent = '';
            var retryWrap = h('div', 'picker-empty');
            retryWrap.appendChild(h('div', null, '云端仍在解析压缩包结构，请稍后重试'));
            var retryBtn = h('button', 'btn btn-sm btn-primary', '重试加载');
            retryBtn.type = 'button';
            retryBtn.style.marginTop = '10px';
            retryBtn.addEventListener('click', function () { loadPreview(pathNo, page, append, 0); });
            retryWrap.appendChild(retryBtn);
            listBox.appendChild(retryWrap);
            return;
          }
          var list = (res && Array.isArray(res.list)) ? res.list : [];
          currentEntries = append ? currentEntries.concat(list) : list;
          if (res && res.totalFileCount > 0) {
            countSpan.textContent = ' · 共 ' + fmtInt(res.totalFileCount) + ' 个文件';
          }
          var hasMore = !!(res && res.count > 0 && currentEntries.length < res.count);
          renderEntries(currentEntries, hasMore, page || 1);
        } catch (err) {
          if (!alive || seq !== previewSeq) return;
          var e = API.normalizeError(err, '读取压缩包目录失败');
          if (e.code === 'ARCHIVE_NEED_PWD' || e.code === 'ARCHIVE_PWD_ERROR') {
            pwdBar.hidden = false;
            pwdMsg.textContent = e.code === 'ARCHIVE_PWD_ERROR'
              ? '解压密码不正确，请重新输入。'
              : '该压缩包已加密，请输入解压密码后浏览或解压。';
            listBox.textContent = '';
            listBox.appendChild(h('div', 'picker-empty', '输入正确密码后将展示压缩包内文件目录'));
            setTimeout(function () { try { pwdInput.focus(); } catch (_) {} }, 20);
            return;
          }
          listBox.textContent = '';
          listBox.appendChild(h('div', 'picker-empty', e.message || '读取压缩包目录失败'));
        }
      }

      function pushFloatUnarchive(payload) {
        if (state.settings.floatingUnarchiveWindow && API.has('app', 'unarchiveProgress')) {
          API.app.unarchiveProgress(Object.assign({ name: item.name }, payload || {})).catch(function () {});
        }
      }

      async function startExtract(onlySelected, conflictMode) {
        if (extracting) return;
        extracting = true;
        finishedToFid = '';
        updateSelectionButtons();
        progBox.hidden = false;
        progBox.classList.remove('done', 'error');
        progLabel.textContent = '正在提交云解压任务…';
        progPct.textContent = '0%';
        progFill.style.width = '4%';
        pushFloatUnarchive({ state: 'running', stage: '正在提交云解压任务…', pct: 4, hint: '目标：' + target.name });

        var pathNos = onlySelected ? Array.from(checkedPaths) : [];
        try {
          var res = await API.archive.unarchive({
            fid: fid,
            toFid: target.fid,
            pwd: password,
            pathNos: pathNos,
            currPathNo: onlySelected ? currentPathNo : '',
            conflictMode: conflictMode || 1
          });
          if (!alive) return;
          if (res && (res.finish || res.status === 'finish' || !res.taskId)) {
            onExtractFinished();
            return;
          }
          var taskId = String(res.taskId);
          progLabel.textContent = '云端正在解压中…';
          pushFloatUnarchive({ state: 'running', stage: '云端正在解压中…', pct: 8, hint: '目标：' + target.name });
          for (var i = 0; i < 180; i++) {
            await sleep(600);
            if (!alive) return;
            var st = await API.archive.queryTask(taskId);
            if (!alive) return;
            var pct = Math.max(0, Math.min(100, Number(st && st.progress) || 0));
            progPct.textContent = Math.round(pct) + '%';
            progFill.style.width = Math.max(6, pct) + '%';
            pushFloatUnarchive({ state: 'running', stage: '云端正在解压中…', pct: Math.round(pct), hint: '目标：' + target.name });
            if (st && st.done) {
              onExtractFinished();
              return;
            }
            if (st && st.failed) {
              throw API.normalizeError({ code: 'SERVER', message: st.message || '云端解压失败' });
            }
          }
          progLabel.textContent = '解压任务仍在云端后台运行，稍后可前往目标目录查看。';
          pushFloatUnarchive({ state: 'running', stage: '云端后台继续解压中…', pct: 95, hint: '稍后可前往目标目录查看' });
          extracting = false;
          updateSelectionButtons();
        } catch (err) {
          if (!alive) return;
          var e = API.normalizeError(err, '云解压失败');
          if (e.code === 'ARCHIVE_NEED_PWD' || e.code === 'ARCHIVE_PWD_ERROR') {
            extracting = false;
            progBox.hidden = true;
            pwdBar.hidden = false;
            pwdMsg.textContent = e.code === 'ARCHIVE_PWD_ERROR' ? '解压密码错误，请重新输入。' : '该压缩包需要解压密码。';
            updateSelectionButtons();
            pwdInput.focus();
            return;
          }
          if ((e.code === 'CONFLICT' || e.bizCode === 23008) && (conflictMode || 1) === 1) {
            extracting = false;
            updateSelectionButtons();
            var overwrite = await confirmDialog({
              title: '目标目录存在同名文件',
              message: '「' + target.name + '」中已存在同名文件或目录，是否覆盖解压？',
              confirmText: '覆盖并继续解压',
              danger: true
            });
            if (overwrite && alive) {
              startExtract(onlySelected, 2);
              return;
            }
            progBox.hidden = true;
            return;
          }
          progBox.classList.add('error');
          var niceErr = friendlyErrorMessage(e, '云解压失败');
          progLabel.textContent = niceErr;
          progPct.textContent = '失败';
          pushFloatUnarchive({ state: 'error', stage: niceErr, pct: 100, hint: '请返回主窗口查看详情' });
          extracting = false;
          updateSelectionButtons();
        }
      }

      function onExtractFinished() {
        extracting = false;
        finishedToFid = target.fid;
        progBox.classList.add('done');
        progLabel.textContent = '云解压完成，文件已保存至「' + target.name + '」';
        progPct.textContent = '100%';
        progFill.style.width = '100%';
        gotoBtn.hidden = false;
        updateSelectionButtons();
        pushFloatUnarchive({ state: 'done', stage: '云解压完成', pct: 100, hint: '已保存至「' + target.name + '」', targetFid: target.fid });
        invalidateDirCache(target.fid);
        if (state.view === 'files' && String(state.fid) === String(target.fid)) {
          reloadCurrent();
        }
        silentRefreshAccountAndQuota({ force: true });
        toast('ok', '云解压已完成');
      }

      extractSelBtn.addEventListener('click', function () { startExtract(true, 1); });
      extractAllBtn.addEventListener('click', function () { startExtract(false, 1); });

      // 并发预拉取建议目录、权益提示与首层内容
      if (API.has('archive', 'targetDir')) {
        API.archive.targetDir(fid).then(function (td) {
          if (!alive || userPickedTarget || !td || !td.dirFid) return;
          target.fid = String(td.dirFid);
          if (td.dirName) target.name = td.dirName;
          targetStrong.textContent = target.name;
        }).catch(function () { /* 静默 */ });
      }
      if (API.has('archive', 'rightTimes')) {
        API.archive.rightTimes(fid).then(function (rt) {
          if (!alive || !rt) return;
          if (rt.baseEnough === false && rt.extendLeft > 0) {
            rightPill.textContent = '体验次数剩余 ' + rt.extendLeft + ' 次';
            rightPill.hidden = false;
          } else if (rt.baseEnough === false) {
            rightPill.textContent = '云解压受账号权益限制';
            rightPill.hidden = false;
          }
        }).catch(function () { /* 静默 */ });
      }
      loadPreview('', 1, false, 0);
    });
  }

  /* ================================================================== *
   * 空间占用明细弹窗（点击侧边栏空间卡片打开）
   * ================================================================== */

  function openStorageDetailModal() {
    if (!API.injected || needsLoginState()) return;
    var alive = true;
    openOverlay(function (ui) {
      ui.setResolve(function () { alive = false; });
      ui.panel.classList.add('dlg-storage');

      var head = h('div', 'dlg-head');
      head.appendChild(icon('cloud', 'dlg-ic'));
      head.appendChild(h('h3', 'dlg-title', '云盘空间占用明细'));
      ui.panel.appendChild(head);

      var body = h('div', 'dlg-body');
      var sumRow = h('div', 'storage-summary');
      var statFree = h('div', 'storage-stat');
      statFree.appendChild(h('span', 'storage-stat-k', '剩余可用空间'));
      var statFreeVal = h('span', 'storage-stat-v primary', '—');
      statFree.appendChild(statFreeVal);
      var statUsed = h('div', 'storage-stat');
      statUsed.appendChild(h('span', 'storage-stat-k', '已使用空间'));
      var statUsedVal = h('span', 'storage-stat-v', '—');
      statUsed.appendChild(statUsedVal);
      var statTotal = h('div', 'storage-stat');
      statTotal.appendChild(h('span', 'storage-stat-k', '账号总容量'));
      var statTotalVal = h('span', 'storage-stat-v', '—');
      statTotal.appendChild(statTotalVal);
      sumRow.appendChild(statFree);
      sumRow.appendChild(statUsed);
      sumRow.appendChild(statTotal);
      body.appendChild(sumRow);

      var stack = h('div', 'storage-stack');
      body.appendChild(stack);

      var rowsBox = h('div', 'storage-rows');
      rowsBox.appendChild(h('div', 'picker-loading', '正在读取各来源空间占用…'));
      body.appendChild(rowsBox);
      ui.panel.appendChild(body);

      var foot = h('div', 'dlg-foot');
      var recycleBtn = h('button', 'btn btn-sm', '打开回收站释放空间');
      recycleBtn.type = 'button';
      recycleBtn.id = 'storage-btn-recycle';
      recycleBtn.addEventListener('click', function () {
        ui.close(null);
        setView('recycle');
      });
      var refreshBtn = h('button', 'btn btn-sm', '刷新数据');
      refreshBtn.type = 'button';
      refreshBtn.id = 'storage-btn-refresh';
      var closeBtn = h('button', 'btn btn-primary', '关闭');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', function () { ui.close(null); });
      foot.appendChild(recycleBtn);
      foot.appendChild(refreshBtn);
      foot.appendChild(closeBtn);
      ui.panel.appendChild(foot);

      function paintSummary() {
        var q = state.quota;
        if (q && q.total > 0) {
          statFreeVal.textContent = fmtSize(freeBytesOf(q));
          statUsedVal.textContent = fmtSize(Math.max(0, Number(q.used) || 0));
          statTotalVal.textContent = fmtSize(q.total);
        }
      }

      async function loadBreakdown() {
        paintSummary();
        refreshBtn.disabled = true;
        rowsBox.textContent = '';
        rowsBox.appendChild(h('div', 'picker-loading', '正在读取各来源空间占用…'));
        var tasks = [
          silentRefreshAccountAndQuota({ force: true, withAccount: true }),
          API.has('fs', 'storageDetail') ? API.fs.storageDetail().catch(function () { return null; }) : Promise.resolve(null)
        ];
        var res = await Promise.all(tasks);
        if (!alive) return;
        refreshBtn.disabled = false;
        paintSummary();
        var detail = res[1];
        var list = (detail && Array.isArray(detail.list)) ? detail.list.slice() : [];
        list = list.filter(function (x) { return (Number(x.size) || 0) > 0 || (Number(x.count) || 0) > 0; });
        list.sort(function (a, b) { return (Number(b.size) || 0) - (Number(a.size) || 0); });

        stack.textContent = '';
        rowsBox.textContent = '';
        if (!list.length) {
          rowsBox.appendChild(h('div', 'picker-empty', '暂无空间分类明细，已为你刷新最新剩余容量。'));
          return;
        }
        var sumSize = list.reduce(function (acc, x) { return acc + (Number(x.size) || 0); }, 0);
        var base = Math.max(sumSize, (state.quota && state.quota.used) || 0, 1);
        list.forEach(function (entry) {
          var meta = STORAGE_SRC_META[String(entry.srcName || '').toUpperCase()] || { label: entry.srcName || '其他', color: '#64748B' };
          var sz = Number(entry.size) || 0;
          var pct = (sz / base) * 100;
          if (sz > 0) {
            var seg = h('div', 'storage-stack-seg');
            seg.style.width = Math.max(1.2, pct).toFixed(2) + '%';
            seg.style.background = meta.color;
            seg.title = meta.label + '：' + fmtSize(sz);
            stack.appendChild(seg);
          }
          var row = h('div', 'storage-row');
          var dot = h('span', 'storage-dot');
          dot.style.background = meta.color;
          row.appendChild(dot);
          row.appendChild(h('span', 'storage-name', meta.label));
          row.appendChild(h('span', 'storage-count', entry.count > 0 ? (fmtInt(entry.count) + ' 项') : ''));
          row.appendChild(h('span', 'storage-size', sz > 0 ? fmtSize(sz) : '0 B'));
          rowsBox.appendChild(row);
        });
      }

      refreshBtn.addEventListener('click', loadBreakdown);
      loadBreakdown();
    });
  }

  /* ================================================================== *
   * 回收站视图（极简查看、还原、彻底删除、清空释放空间）
   * ================================================================== */

  function updateRecycleControls() {
    if (!el.recycleCheckAll) return;
    var items = state.recycle.items || [];
    var selCount = state.recycle.selected.size;
    el.recycleCheckAll.checked = items.length > 0 && selCount >= items.length;
    el.recycleCheckAll.indeterminate = selCount > 0 && selCount < items.length;
    el.recycleCheckAll.disabled = items.length === 0;
    if (el.btnRecycleRecover) el.btnRecycleRecover.disabled = selCount === 0;
    if (el.btnRecycleRemove) el.btnRecycleRemove.disabled = selCount === 0;
    if (el.btnRecycleClear) el.btnRecycleClear.disabled = items.length === 0 && !state.recycle.total;
    if (el.recycleSummary) {
      if (!API.injected) el.recycleSummary.textContent = '未连接后端';
      else if (needsLoginState()) el.recycleSummary.textContent = '请先登录';
      else if (selCount > 0) el.recycleSummary.textContent = '已选 ' + selCount + ' / ' + (state.recycle.total || items.length) + ' 项';
      else if (state.recycle.loadedOnce) el.recycleSummary.textContent = '共 ' + (state.recycle.total || items.length) + ' 项 · 到期自动清理';
      else el.recycleSummary.textContent = '';
    }
  }

  function renderRecycle() {
    if (!el.recycleList) return;
    var box = el.recycleList;
    box.textContent = '';
    if (el.recycleFoot) el.recycleFoot.textContent = '';
    updateRecycleControls();

    if (!API.injected) {
      var nb = h('div', 'empty');
      nb.appendChild(icon('trash', 'empty-ic'));
      nb.appendChild(h('div', 'empty-title', '未注入桥接层，无法访问回收站'));
      box.appendChild(nb);
      return;
    }
    if (needsLoginState()) {
      var nl = h('div', 'empty');
      nl.appendChild(icon('cloud', 'empty-ic'));
      nl.appendChild(h('div', 'empty-title', '登录夸克账号后可查看并还原回收站文件'));
      var lb = h('button', 'btn btn-primary empty-action', '登录夸克账号');
      lb.type = 'button';
      lb.addEventListener('click', doLogin);
      nl.appendChild(lb);
      box.appendChild(nl);
      return;
    }
    if (state.recycle.loading && !state.recycle.items.length) {
      box.appendChild(h('div', 'picker-loading', '正在加载回收站…'));
      return;
    }
    var items = state.recycle.items || [];
    if (!items.length) {
      var em = h('div', 'empty');
      em.appendChild(icon('trash', 'empty-ic'));
      em.appendChild(h('div', 'empty-title', '回收站是空的'));
      em.appendChild(h('div', 'empty-sub', '已删除的文件会暂存在这里，支持随时还原或彻底清理释放空间。'));
      box.appendChild(em);
      return;
    }

    items.forEach(function (it) {
      var rid = String(it.recordId || it.fid);
      var selected = state.recycle.selected.has(rid);
      var row = h('div', 'recycle-row' + (selected ? ' selected' : ''));
      row.dataset.recordId = rid;
      row.setAttribute('role', 'listitem');

      var cbCell = h('span', 'cb-cell');
      var cbLabel = h('label', 'cb');
      var cb = h('input');
      cb.type = 'checkbox';
      cb.checked = selected;
      cb.setAttribute('aria-label', '选择 ' + it.name);
      cb.addEventListener('change', function () {
        if (cb.checked) state.recycle.selected.add(rid);
        else state.recycle.selected.delete(rid);
        row.classList.toggle('selected', cb.checked);
        updateRecycleControls();
      });
      cbLabel.appendChild(cb);
      cbLabel.appendChild(h('i'));
      cbCell.appendChild(cbLabel);
      row.appendChild(cbCell);

      var nameCol = h('span', 'col-name');
      var icWrap = h('span', 'fileicon ' + catClass(it));
      icWrap.appendChild(icon(iconFor(it)));
      var fname = h('span', 'fname', it.name);
      fname.title = it.name;
      nameCol.appendChild(icWrap);
      nameCol.appendChild(fname);
      row.appendChild(nameCol);

      var originText = it.pdirName || '全部文件';
      var originEl = h('span', 'recycle-origin', originText);
      originEl.title = originText;
      row.appendChild(originEl);

      row.appendChild(h('span', 'col-size', it.dir ? '—' : fmtSize(it.size)));

      var days = it.remainMs > 0 ? Math.max(1, Math.ceil(it.remainMs / 86400000)) : 0;
      var remainText = days > 0 ? (days + ' 天') : '即将清理';
      row.appendChild(h('span', 'recycle-remain' + (days <= 3 ? ' soon' : ''), remainText));

      var ops = h('span', 'col-ops');
      var recBtn = h('button', 'op');
      recBtn.type = 'button';
      recBtn.title = '还原到原位置';
      recBtn.setAttribute('aria-label', '还原 ' + it.name);
      recBtn.appendChild(icon('restore'));
      recBtn.addEventListener('click', function () { doRecycleRecover([it]); });
      ops.appendChild(recBtn);

      var delBtn = h('button', 'op danger');
      delBtn.type = 'button';
      delBtn.title = '彻底删除';
      delBtn.setAttribute('aria-label', '彻底删除 ' + it.name);
      delBtn.appendChild(icon('trash'));
      delBtn.addEventListener('click', function () { doRecycleRemove([it]); });
      ops.appendChild(delBtn);
      row.appendChild(ops);

      box.appendChild(row);
    });

    if (el.recycleFoot) {
      if (state.recycle.hasMore) {
        var more = h('button', 'btn btn-sm', '加载更多');
        more.type = 'button';
        more.addEventListener('click', function () { loadRecycle({ append: true }); });
        var wrap = h('div', 'foot-line');
        wrap.appendChild(more);
        el.recycleFoot.appendChild(wrap);
      } else {
        el.recycleFoot.appendChild(h('div', 'foot-line muted', '共 ' + items.length + ' 项'));
      }
    }
  }

  async function loadRecycle(opts) {
    var o = opts || {};
    if (!API.injected || needsLoginState() || !API.has('recycle', 'list')) {
      renderRecycle();
      return;
    }
    var seq = o.append ? recycleSeq : ++recycleSeq;
    var nextPage = o.append ? (state.recycle.page + 1) : 1;
    state.recycle.loading = true;
    if (!o.append) {
      state.recycle.selected.clear();
      renderRecycle();
    }
    try {
      var res = await API.recycle.list({ page: nextPage, size: 50 });
      if (seq !== recycleSeq) return;
      var list = (res && Array.isArray(res.list)) ? res.list : [];
      state.recycle.items = o.append ? state.recycle.items.concat(list) : list;
      state.recycle.page = nextPage;
      state.recycle.total = (res && typeof res.total === 'number' && res.total > 0) ? res.total : state.recycle.items.length;
      state.recycle.hasMore = !!(res && res.hasMore);
      state.recycle.loadedOnce = true;
    } catch (err) {
      if (seq !== recycleSeq) return;
      reportError(err, '读取回收站失败');
    } finally {
      if (seq === recycleSeq) {
        state.recycle.loading = false;
        renderRecycle();
      }
    }
  }

  async function waitAcceptedTask(accepted) {
    if (!accepted || accepted.done === true || !accepted.taskId) return;
    for (var i = 0; i < TASK_POLL_MAX; i++) {
      await sleep(TASK_POLL_MS);
      var arr = await API.fs.taskStatus({ taskIds: [accepted.taskId] });
      var st = Array.isArray(arr) ? arr[0] : arr;
      if (st && st.done === true) return;
    }
  }

  function removeRecycleLocally(recordIds) {
    var drop = new Set((recordIds || []).map(String));
    if (!drop.size) return;
    state.recycle.items = state.recycle.items.filter(function (x) { return !drop.has(String(x.recordId)); });
    drop.forEach(function (id) { state.recycle.selected.delete(id); });
    state.recycle.total = Math.max(0, state.recycle.total - drop.size);
    renderRecycle();
  }

  async function doRecycleRecover(items) {
    if (!ensureLoggedInForWrite('还原')) return;
    var list = (items || []).filter(Boolean);
    if (!list.length) return;
    var rids = list.map(function (x) { return x.recordId; });
    try {
      var accepted = await API.recycle.recover({ recordIds: rids });
      invalidateDirCache();
      removeRecycleLocally(rids);
      toast('ok', '已还原 ' + list.length + ' 个项目到原目录');
      await waitAcceptedTask(accepted).catch(function () {});
      loadRecycle({ reset: true });
      silentRefreshAccountAndQuota({ force: true });
    } catch (err) {
      reportError(err, '还原失败');
    }
  }

  async function doRecycleRemove(items) {
    if (!ensureLoggedInForWrite('彻底删除')) return;
    var list = (items || []).filter(Boolean);
    if (!list.length) return;
    var ok = await confirmDialog({
      title: '确认彻底删除',
      message: '即将彻底删除选中的 ' + list.length + ' 个项目，删除后无法找回。',
      detail: '彻底删除将释放对应的云盘空间。',
      confirmText: '彻底删除',
      danger: true,
      list: list.map(function (i) { return i.name + (i.dir ? '（文件夹）' : ''); })
    });
    if (!ok) return;
    var rids = list.map(function (x) { return x.recordId; });
    try {
      var accepted = await API.recycle.remove({ recordIds: rids, clearAll: false });
      removeRecycleLocally(rids);
      toast('ok', '已彻底删除 ' + list.length + ' 个项目');
      await waitAcceptedTask(accepted).catch(function () {});
      loadRecycle({ reset: true });
      silentRefreshAccountAndQuota({ force: true });
    } catch (err) {
      reportError(err, '彻底删除失败');
    }
  }

  async function doRecycleClearAll() {
    if (!ensureLoggedInForWrite('清空回收站')) return;
    var ok = await confirmDialog({
      title: '确认清空回收站',
      message: '即将永久清空回收站中的全部文件，此操作不可撤销！',
      detail: '清空后所有文件将无法恢复，并会立即释放云盘占用空间。',
      confirmText: '清空回收站',
      danger: true
    });
    if (!ok) return;
    try {
      var accepted = await API.recycle.remove({ clearAll: true });
      state.recycle.items = [];
      state.recycle.selected.clear();
      state.recycle.total = 0;
      renderRecycle();
      toast('ok', '回收站已清空');
      await waitAcceptedTask(accepted).catch(function () {});
      loadRecycle({ reset: true });
      silentRefreshAccountAndQuota({ force: true });
    } catch (err) {
      reportError(err, '清空回收站失败');
    }
  }

  /* ================================================================== *
   * 文件操作
   * ================================================================== */

  var OPS = [
    { key: 'unarchive', title: '云解压 / 浏览', icon: 'file-archive' },
    { key: 'download', title: '下载', icon: 'download' },
    { key: 'rename', title: '重命名', icon: 'rename' },
    { key: 'move', title: '移动到', icon: 'move' },
    { key: 'copy', title: '复制到', icon: 'copy' },
    { key: 'remove', title: '删除', icon: 'trash', danger: true }
  ];

  function currentDirName() {
    var c = state.crumbs[state.crumbs.length - 1];
    return c ? c.name : '全部文件';
  }

  async function openItem(item) {
    if (!item) return;
    if (item.dir) { navigate(item.fid, item.name, item.pdirFid); return; }
    downloadItems([item]);
  }

  /** 从当前视图中即时移除已删除/已移走的项目，让界面立即响应无需等待异步任务轮询结束。 */
  function removeItemsLocally(fids) {
    if (!Array.isArray(fids) || !fids.length) return 0;
    var drop = new Set(fids.map(function (id) { return String(id); }));
    var removed = 0;
    var next = [];
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      var key = it && it.fid !== undefined && it.fid !== null ? String(it.fid) : '';
      if (key && drop.has(key)) {
        delete state.itemMap[key];
        state.selected.delete(key);
        dirDetailCache.delete(key);
        removed += 1;
      } else {
        next.push(it);
      }
    }
    dirDetailCache.delete(String(state.fid));
    if (state.inspectorFid && drop.has(String(state.inspectorFid))) {
      state.inspectorFid = null;
    }
    if (!removed) return 0;
    state.items = next;
    if (typeof state.total === 'number' && state.total >= 0) {
      state.total = Math.max(0, state.total - removed);
    }
    listVersion += 1;
    renderRows(listSeq, true);
    if (!state.items.length && !state.hasMore) {
      renderEmpty(state.mode === 'search' ? '没有找到匹配的文件' : '此文件夹为空', false);
    }
    updateSelectAll();
    renderStatusBar();
    renderInspector();
    return removed;
  }

  /** 目录分页加载：把一条异步任务受理结果轮询到结束，失效缓存并按需刷新当前目录。 */
  async function awaitTask(accepted, what, originFid, extraInvalidateFid, opts) {
    var srcFid = originFid !== undefined ? String(originFid) : String(state.fid);
    var accountSnap = state.account;
    var o = opts || {};
    var removedSet = (Array.isArray(o.removedFids) && o.removedFids.length)
      ? new Set(o.removedFids.map(function (id) { return String(id); }))
      : null;
    var maybeRefresh = function (allowRetry) {
      if (!sameAccountSession(accountSnap)) return;
      invalidateDirCache(srcFid);
      dirDetailCache.delete(srcFid);
      if (extraInvalidateFid !== undefined && extraInvalidateFid !== null) {
        invalidateDirCache(String(extraInvalidateFid));
        dirDetailCache.delete(String(extraInvalidateFid));
      }
      var inTargetDir = state.view === 'files' && (state.mode === 'search' || String(state.fid) === srcFid);
      if (inTargetDir) {
        reloadCurrent();
        // 云端删除/移动大文件夹偶发短暂最终一致性延迟：若刷新后仍出现已删 fid，1.2s 后静默再校对一次
        if (allowRetry && removedSet && removedSet.size) {
          setTimeout(function () {
            if (!sameAccountSession(accountSnap)) return;
            if (state.view !== 'files' || (state.mode !== 'search' && String(state.fid) !== srcFid)) return;
            var stillPresent = false;
            removedSet.forEach(function (fid) {
              if (state.itemMap[fid]) stillPresent = true;
            });
            if (stillPresent) {
              invalidateDirCache(srcFid);
              loadPage({ reset: true, silent: true, preserveSelection: true });
            }
          }, 1200);
        }
      } else {
        pendingFilesRefresh = true;
      }
      if (what === '删除' || what === '复制') {
        silentRefreshAccountAndQuota({ force: true });
      }
    };
    if (!accepted) { setTimeout(function () { maybeRefresh(true); }, 700); return; }
    if (accepted.done === true) { setTimeout(function () { maybeRefresh(true); }, 260); return; }
    var taskId = accepted.taskId;
    if (!taskId) { setTimeout(function () { maybeRefresh(true); }, 900); return; }
    for (var i = 0; i < TASK_POLL_MAX; i++) {
      await sleep(TASK_POLL_MS);
      if (!sameAccountSession(accountSnap)) return;
      try {
        var arr = await API.fs.taskStatus({ taskIds: [taskId] });
        var st = Array.isArray(arr) ? arr[0] : arr;
        if (st && st.done === true) {
          maybeRefresh(true);
          if (what) toast('ok', what + '完成');
          return;
        }
      } catch (err) {
        reportError(err, '任务状态查询失败，尚未确认操作完成');
        maybeRefresh(false);
        return;
      }
    }
    toast('warn', '尚未确认任务完成，请刷新后检查结果');
    maybeRefresh(false);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function ensureLoggedInForWrite(actionName) {
    if (!API.injected) { toast('warn', '未注入桥接层，无法' + actionName); return false; }
    if (needsLoginState()) {
      toast('warn', state.expired ? '登录状态已失效，请重新登录后再' + actionName : '请先登录夸克账号后再' + actionName);
      return false;
    }
    return true;
  }

  var MAX_FOLDER_DOWNLOAD_FILES = 5000;
  var MAX_FOLDER_DOWNLOAD_DEPTH = 24;
  var FOLDER_DOWNLOAD_CONFIRM_THRESHOLD = 200;

  /** 递归收集所选文件与文件夹内的所有可下载子文件，并保留相对目录路径段数组。 */
  async function collectDownloadEntries(items) {
    var entries = [];
    var queue = [];
    var visitedDirs = new Set();
    var scannedDirs = 0;
    var truncated = false;
    var usedRootNames = new Map();

    var uniqueRootSegment = function (name) {
      var base = String(name || '未命名文件夹').trim() || '未命名文件夹';
      var count = usedRootNames.get(base) || 0;
      usedRootNames.set(base, count + 1);
      return count === 0 ? base : (base + ' (' + (count + 1) + ')');
    };

    (items || []).forEach(function (it) {
      if (!it || !it.fid) return;
      if (it.dir) {
        var fid = String(it.fid);
        if (!visitedDirs.has(fid)) {
          visitedDirs.add(fid);
          queue.push({ fid: fid, relDir: [uniqueRootSegment(it.name)], depth: 1 });
        }
      } else {
        entries.push({ fid: String(it.fid), name: it.name || String(it.fid), relDir: [] });
      }
    });

    var concurrency = Math.min(4, Math.max(1, queue.length));
    var workers = [];
    for (var w = 0; w < concurrency; w++) {
      workers.push((async function () {
        while (queue.length && !truncated) {
          var node = queue.shift();
          if (!node) break;
          scannedDirs += 1;
          var page = 1;
          while (!truncated) {
            var res = await API.fs.list({ pdirFid: node.fid, page: page, size: 100 });
            var list = (res && Array.isArray(res.list)) ? res.list : [];
            for (var i = 0; i < list.length; i++) {
              var child = list[i];
              if (!child || !child.fid) continue;
              if (child.dir) {
                var childFid = String(child.fid);
                if (!visitedDirs.has(childFid) && node.depth < MAX_FOLDER_DOWNLOAD_DEPTH) {
                  visitedDirs.add(childFid);
                  queue.push({
                    fid: childFid,
                    relDir: node.relDir.concat([String(child.name || '未命名文件夹')]),
                    depth: node.depth + 1
                  });
                }
              } else {
                entries.push({
                  fid: String(child.fid),
                  name: child.name || String(child.fid),
                  relDir: node.relDir
                });
                if (entries.length >= MAX_FOLDER_DOWNLOAD_FILES) {
                  truncated = true;
                  break;
                }
              }
            }
            if (!res || !res.hasMore || !list.length || page >= 500) break;
            page += 1;
          }
        }
      })());
    }
    await Promise.all(workers);
    return { entries: entries, scannedDirs: scannedDirs, truncated: truncated };
  }

  var folderDownloadScanning = false;

  async function downloadItems(items, opts) {
    var o = opts || {};
    if (!ensureLoggedInForWrite('下载')) return;
    var selected = (items || []).filter(Boolean);
    if (!selected.length) { toast('warn', '请先选择要下载的项目'); return; }
    var hasDirs = selected.some(function (i) { return !!i.dir; });
    if (hasDirs && folderDownloadScanning) {
      toast('info', '正在扫描文件夹子文件，请稍候…');
      return;
    }

    var dir = state.settings.downloadDir;
    var shouldPick = !!o.pickDir || !!state.settings.askDownloadDir || !dir;
    if (shouldPick) {
      var hadDefault = !!dir;
      try {
        dir = await API.dialog.saveDir(dir || undefined);
      } catch (err) { reportError(err, '选择下载目录失败'); return; }
      if (!dir) { toast('warn', '未选择下载目录，已取消下载'); return; }
      if (!hadDefault) await saveSettings({ downloadDir: dir });
    }

    var entries;
    var scannedDirs = 0;
    var truncated = false;
    if (hasDirs) {
      folderDownloadScanning = true;
      toast('info', '正在扫描文件夹内的子文件…');
      try {
        var collected = await collectDownloadEntries(selected);
        entries = collected.entries;
        scannedDirs = collected.scannedDirs;
        truncated = collected.truncated;
      } catch (err) {
        reportError(err, '扫描文件夹内容失败');
        return;
      } finally {
        folderDownloadScanning = false;
      }
      if (!entries.length) {
        toast('warn', '所选文件夹内没有可下载的文件');
        return;
      }
      if (entries.length > FOLDER_DOWNLOAD_CONFIRM_THRESHOLD || truncated) {
        var confirmed = await confirmDialog({
          title: '确认批量下载文件夹',
          message: '共扫描到 ' + entries.length + ' 个子文件（涉及 ' + scannedDirs + ' 个目录），将按原目录结构下载到目标文件夹。',
          detail: truncated
            ? ('已达到单次批量下载上限（' + MAX_FOLDER_DOWNLOAD_FILES + ' 个文件），超出部分请分目录下载。')
            : '确认后将全部加入下载队列并自动创建对应子目录。',
          confirmText: '开始下载 (' + entries.length + ')'
        });
        if (!confirmed) return;
      }
    } else {
      entries = selected.map(function (f) {
        return { fid: f.fid, name: f.name, relDir: [] };
      });
    }

    try {
      var payload = {
        fids: entries.map(function (f) { return f.fid; }),
        localDir: dir,
        names: entries.map(function (f) { return f.name; })
      };
      if (entries.some(function (f) { return f.relDir && f.relDir.length > 0; })) {
        payload.relDirs = entries.map(function (f) { return f.relDir || []; });
      }
      var ids = await API.transfer.download(payload);
      var n = Array.isArray(ids) ? ids.length : entries.length;
      toast('ok', '已加入下载队列：' + n + ' 个文件' + (hasDirs ? '（已保留目录结构）' : ''));
      refreshTransfers();
    } catch (err) {
      reportError(err, '下载失败');
    }
  }

  async function doUploadPaths(paths) {
    if (!paths || !paths.length) return;
    if (!ensureLoggedInForWrite('上传')) return;
    if (state.mode === 'search') {
      toast('warn', '搜索状态下请先返回浏览目录再上传');
      return;
    }
    try {
      var ids = await API.transfer.upload({ localPaths: paths, pdirFid: state.fid });
      invalidateDirCache(state.fid);
      var n = Array.isArray(ids) ? ids.length : paths.length;
      toast('ok', '已加入上传队列：' + n + ' 个文件，上传到「' + currentDirName() + '」');
      refreshTransfers();
      setView('transfers');
    } catch (err) {
      reportError(err, '上传失败');
    }
  }

  async function onUploadClick() {
    if (!ensureLoggedInForWrite('上传')) return;
    try {
      var paths = await API.dialog.pickFiles();
      if (!paths || !paths.length) return;
      await doUploadPaths(paths);
    } catch (err) {
      reportError(err, '选择文件失败');
    }
  }

  async function onMkdirClick() {
    if (!ensureLoggedInForWrite('新建文件夹')) return;
    if (state.mode === 'search') { toast('warn', '搜索状态下不能新建文件夹，请先返回浏览目录'); return; }
    var originFid = state.fid;
    var name = await promptDialog({
      title: '新建文件夹',
      message: '将在「' + currentDirName() + '」下创建文件夹。',
      placeholder: '请输入文件夹名称',
      confirmText: '创建',
      icon: 'folder-plus',
      validate: validateName
    });
    if (name === null) return;
    try {
      var accepted = await API.fs.mkdir({ pdirFid: originFid, name: name });
      invalidateDirCache(originFid);
      toast('ok', '已提交创建「' + name + '」');
      awaitTask(accepted, '创建文件夹', originFid);
    } catch (err) {
      reportError(err, '新建文件夹失败');
    }
  }

  function validateName(name) {
    if (/[\\/:*?"<>|]/.test(name)) return '名称不能包含 \\ / : * ? " < > | 等字符';
    if (name.length > 255) return '名称过长';
    if (name === '.' || name === '..') return '名称无效';
    return null;
  }

  async function onRename(item) {
    if (!item || !ensureLoggedInForWrite('重命名')) return;
    var originFid = state.fid;
    var name = await promptDialog({
      title: '重命名',
      message: '原名称：' + item.name,
      value: item.name,
      confirmText: '保存',
      icon: 'rename',
      validate: validateName
    });
    if (name === null || name === item.name) return;
    try {
      var accepted = await API.fs.rename({ fid: item.fid, name: name });
      item.name = name;
      if (!item.dir) {
        var dot = name.lastIndexOf('.');
        item.ext = (dot > 0 && dot < name.length - 1) ? name.slice(dot + 1).toLowerCase() : '';
      }
      invalidateDirCache(originFid);
      if (item.pdirFid) invalidateDirCache(item.pdirFid);
      var row = rowMap.get(String(item.fid));
      if (row) updateRow(row, item);
      if (state.inspectorOpen && state.inspectorFid === String(item.fid)) renderInspector();
      toast('ok', '已重命名为「' + name + '」');
      if (accepted && accepted.taskId && accepted.done !== true) {
        awaitTask(accepted, '重命名', originFid);
      }
    } catch (err) {
      reportError(err, '重命名失败');
    }
  }

  async function doTransferOp(kind, items) {
    if (!ensureLoggedInForWrite(kind === 'move' ? '移动' : '复制')) return;
    var list = (items || []).filter(Boolean);
    if (!list.length) return;
    var originFid = state.fid;
    var isMove = kind === 'move';
    var exclude = list.filter(function (i) { return i.dir; }).map(function (i) { return String(i.fid); });
    var targetFid = await pickDirDialog({
      title: isMove ? '选择移动到的目录' : '选择复制到的目录',
      confirmText: isMove ? '移动到此处' : '复制到此处',
      excludeFids: exclude
    });
    if (targetFid === null || targetFid === undefined) return;
    if (isMove) {
      var sameDir = list.every(function (i) {
        var parentFid = (i && i.pdirFid !== undefined && i.pdirFid !== null && String(i.pdirFid) !== '')
          ? String(i.pdirFid)
          : (state.mode === 'browse' ? String(state.fid) : '');
        return parentFid !== '' && parentFid === String(targetFid);
      });
      if (sameDir) {
        toast('warn', '目标目录与当前目录相同，无需移动');
        return;
      }
    }
    var targetName = await dirNameOf(targetFid);
    var ok = await confirmDialog({
      title: isMove ? '确认移动' : '确认复制',
      message: (isMove ? '将移动 ' : '将复制 ') + list.length + ' 个项目到「' + targetName + '」',
      detail: isMove
        ? '移动后原位置将不再显示这些项目。'
        : '复制会在目标目录生成副本，可能占用额外容量。',
      confirmText: isMove ? '移动' : '复制',
      list: list.map(function (i) { return i.name + (i.dir ? '（文件夹）' : ''); })
    });
    if (!ok) return;
    try {
      var fids = list.map(function (i) { return i.fid; });
      var accepted = isMove
        ? await API.fs.move({ fids: fids, toFid: targetFid })
        : await API.fs.copy({ fids: fids, toFid: targetFid });
      invalidateDirCache(originFid);
      invalidateDirCache(targetFid);
      toast('ok', '已提交' + (isMove ? '移动' : '复制') + '：' + list.length + ' 个项目');
      clearSelection();
      if (isMove && state.mode === 'browse' && String(originFid) === String(state.fid) && String(targetFid) !== String(originFid)) {
        removeItemsLocally(fids);
      }
      awaitTask(accepted, isMove ? '移动' : '复制', originFid, targetFid, isMove ? { removedFids: fids } : undefined);
      refreshQuota();
    } catch (err) {
      reportError(err, isMove ? '移动失败' : '复制失败');
    }
  }

  async function dirNameOf(fid) {
    var found = state.crumbs.filter(function (c) { return String(c.fid) === String(fid); })[0];
    if (found) return found.name;
    if (String(fid) === ROOT_FID) return '全部文件';
    try {
      var it = await API.fs.info(fid);
      if (it && it.name) return it.name;
    } catch (e) { /* 忽略 */ }
    return '所选目录';
  }

  async function doRemove(items, opts) {
    if (!ensureLoggedInForWrite('删除')) return;
    var list = (items || []).filter(Boolean);
    if (!list.length) return;
    var originFid = state.fid;
    var o = opts || {};
    var folderCount = list.filter(function (i) { return i.dir; }).length;
    var ok = await confirmDialog({
      title: o.bulk ? '确认批量删除' : '确认删除',
      message: '即将删除 ' + list.length + ' 个项目' + (folderCount ? '（其中文件夹 ' + folderCount + ' 个）' : '') + '，删除后可在网盘回收站找回。',
      detail: '此操作不可在当前客户端撤销。',
      confirmText: '删除',
      danger: true,
      list: list.map(function (i) { return i.name + (i.dir ? '（文件夹）' : ''); })
    });
    if (!ok) return;
    try {
      var fids = list.map(function (i) { return i.fid; });
      var accepted = await API.fs.remove({ fids: fids });
      invalidateDirCache(originFid);
      list.forEach(function (it) {
        if (it && it.pdirFid) invalidateDirCache(it.pdirFid);
        if (it && it.dir) invalidateDirCache(it.fid);
      });
      clearSelection();
      removeItemsLocally(fids);
      toast('ok', (accepted && accepted.done === true ? '已删除：' : '已提交删除：') + list.length + ' 个项目');
      awaitTask(accepted, '删除', originFid, null, { removedFids: fids });
      refreshQuota();
    } catch (err) {
      reportError(err, '删除失败');
    }
  }

  async function onBulk(action) {
    var items = selectedItems();
    if (action === 'clear') { clearSelection(); return; }
    if (!items.length) { toast('warn', '请先选择项目'); return; }
    if (action === 'download') return downloadItems(items);
    if (action === 'unarchive') {
      var arc = items.find(isArchiveItem);
      if (arc) return openArchiveModal(arc);
      toast('warn', '请选择一个压缩包文件进行云解压');
      return;
    }
    if (action === 'move') return doTransferOp('move', items);
    if (action === 'copy') return doTransferOp('copy', items);
    if (action === 'remove') return doRemove(items, { bulk: true });
  }

  /* ================================================================== *
   * 传输列表
   * ================================================================== */

  function transferActions(t) {
    var acts = [];
    if (t.status === 'running' || t.status === 'pending') {
      acts.push({ key: 'pause', title: '暂停', icon: 'pause' });
      acts.push({ key: 'cancel', title: '取消', icon: 'cancel', danger: true });
    } else if (t.status === 'paused') {
      acts.push({ key: 'resume', title: '继续', icon: 'resume' });
      acts.push({ key: 'cancel', title: '取消', icon: 'cancel', danger: true });
    } else if (t.status === 'error') {
      acts.push({ key: 'retry', title: '重试', icon: 'retry' });
      acts.push({ key: 'cancel', title: '取消', icon: 'cancel', danger: true });
    } else if (t.status === 'canceled') {
      acts.push({ key: 'retry', title: '重试', icon: 'retry' });
    } else {
      acts.push({ key: 'open', title: '打开所在文件夹', icon: 'folder-open' });
    }
    if (t.status === 'done' || t.status === 'canceled' || t.status === 'error') {
      acts.push({ key: 'clear', title: '清除记录', icon: 'close' });
    }
    return acts;
  }

  function transferSubdirHint(t) {
    if (!t || t.kind !== 'download' || !t.localDir) return '';
    var base = String(state.settings.downloadDir || '').replace(/[\\/]+$/, '');
    var dir = String(t.localDir).replace(/[\\/]+$/, '');
    if (!base || dir.length <= base.length) return '';
    if (dir.slice(0, base.length) !== base) return '';
    var rest = dir.slice(base.length);
    if (rest[0] !== '/' && rest[0] !== '\\') return '';
    return rest.slice(1).replace(/\\/g, '/');
  }

  function transferRowSig(t) {
    return [t.status, t.transferred, t.size, t.speed, t.eta, t.error || '', t.errorCode || '', t.attempts || 0, t.name || '', t.localDir || ''].join('|');
  }

  function createTransferRow(t) {
    var row = h('div', 'trow');
    row.dataset.id = t.id;

    var ic = h('span', 'ticon');
    ic.appendChild(icon(t.kind === 'upload' ? 'upload' : 'download'));
    row.appendChild(ic);

    var info = h('div', 'tinfo');
    var line1 = h('div', 'tname-row');
    var tname = h('span', 'tname', t.name);
    tname.title = t.name;
    line1.appendChild(tname);
    line1.appendChild(h('span', 'tdir ' + (t.kind === 'upload' ? 'up' : 'down'), t.kind === 'upload' ? '上传' : '下载'));
    var tpct = h('span', 'tpct', '');
    line1.appendChild(tpct);
    info.appendChild(line1);

    var meta = h('div', 'tmeta');
    var stateEl = h('span', 'tstate', STATUS_TEXT[t.status] || t.status);
    var subdirEl = h('span', 'tsubdir', '');
    subdirEl.hidden = true;
    var bytesEl = h('span', 'tbytes', '');
    var spEl = h('span', 'tspeed', '');
    var etaEl = h('span', 'teta', '');
    var terr = h('span', 'terror');
    terr.hidden = true;
    meta.appendChild(stateEl);
    meta.appendChild(h('span', 'tdot', '·'));
    meta.appendChild(bytesEl);
    meta.appendChild(subdirEl);
    meta.appendChild(spEl);
    meta.appendChild(etaEl);
    meta.appendChild(terr);
    info.appendChild(meta);

    var bar = h('div', 'tbar');
    var barFill = h('i');
    bar.appendChild(barFill);
    info.appendChild(bar);
    row.appendChild(info);

    var ops = h('div', 'tops');
    ops.dataset.ops = '';
    row.appendChild(ops);

    row._refs = {
      tname: tname,
      tpct: tpct,
      barFill: barFill,
      stateEl: stateEl,
      subdirEl: subdirEl,
      bytesEl: bytesEl,
      spEl: spEl,
      etaEl: etaEl,
      errEl: terr,
      ops: ops
    };

    updateTransferRow(row, t);
    return row;
  }

  function updateTransferRow(row, t) {
    var r = row._refs;
    if (!r) return;
    var pct = t.size > 0 ? Math.min(100, Math.max(0, (t.transferred / t.size) * 100)) : (t.status === 'done' ? 100 : 0);
    var pctStyle = pct.toFixed(2).replace(/\.00$/, '') + '%';
    if (r.barFill.dataset.pct !== pctStyle) {
      r.barFill.dataset.pct = pctStyle;
      r.barFill.style.width = pctStyle;
    }
    var pctLabel = Math.round(pct) + '%';
    if (r.tpct.textContent !== pctLabel) r.tpct.textContent = pctLabel;
    var fullTitle = t.name + (t.localDir ? (' — ' + t.localDir) : '');
    if (r.tname.textContent !== t.name) r.tname.textContent = t.name;
    if (r.tname.title !== fullTitle) r.tname.title = fullTitle;
    if (r.subdirEl) {
      var sub = transferSubdirHint(t);
      r.subdirEl.hidden = !sub;
      if (sub) {
        var subText = '目录：' + sub;
        if (r.subdirEl.textContent !== subText) {
          r.subdirEl.textContent = subText;
          r.subdirEl.title = t.localDir || sub;
        }
      }
    }

    var stText = STATUS_TEXT[t.status] || t.status;
    if (r.stateEl.textContent !== stText) r.stateEl.textContent = stText;
    row.dataset.status = t.status;

    var bytes = fmtSize(t.transferred) + ' / ' + fmtSize(t.size);
    if (r.bytesEl.textContent !== bytes) r.bytesEl.textContent = bytes;

    var sp = t.status === 'running' ? fmtSpeed(t.speed) : '';
    if (r.spEl.textContent !== sp) r.spEl.textContent = sp;

    var eta = t.status === 'running' ? fmtEta(t.eta) : '';
    if (r.etaEl.textContent !== eta) r.etaEl.textContent = eta;

    var errText = t.status === 'error'
      ? ('失败：' + (t.error || '未知错误') + (t.errorCode ? '（' + t.errorCode + '）' : '') +
        (t.attempts ? ' · 已重试 ' + t.attempts + ' 次' : ''))
      : '';
    var showErr = !!errText;
    if (r.errEl.hidden === showErr) r.errEl.hidden = !showErr;
    if (r.errEl.textContent !== errText) r.errEl.textContent = errText;

    var acts = transferActions(t);
    var wantKeys = acts.map(function (a) { return a.key; }).join(',');
    if (r.ops.dataset.ops !== wantKeys) {
      r.ops.dataset.ops = wantKeys;
      r.ops.textContent = '';
      acts.forEach(function (a) {
        var b = h('button', 'op' + (a.danger ? ' danger' : ''));
        b.type = 'button';
        b.dataset.tact = a.key;
        b.title = a.title;
        b.setAttribute('aria-label', a.title);
        b.appendChild(icon(a.icon));
        r.ops.appendChild(b);
      });
    }
  }

  function matchTransferFilter(t) {
    var f = state.transferFilter;
    if (f === 'all') return true;
    if (f === 'active') return t.status === 'running' || t.status === 'pending';
    if (f === 'paused') return t.status === 'paused';
    if (f === 'done') return t.status === 'done';
    if (f === 'error') return t.status === 'error' || t.status === 'canceled';
    return true;
  }

  function updateTransferBadgesOnly() {
    var list = state.transfers || [];
    var active = 0;
    var activeDown = 0;
    var activeUp = 0;
    var doneCount = 0;
    var downSpeed = 0;
    var upSpeed = 0;
    var activeTotalBytes = 0;
    var activeDoneBytes = 0;
    var activePctSum = 0;
    var primaryTask = null;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.status === 'done') {
        doneCount += 1;
      } else if (t.status === 'running' || t.status === 'pending') {
        active += 1;
        if (t.kind === 'upload') activeUp += 1;
        else activeDown += 1;
        if (!primaryTask || (primaryTask.status !== 'running' && t.status === 'running')) {
          primaryTask = t;
        }
        var sz = Number(t.size) || 0;
        var tr = Number(t.transferred) || 0;
        if (sz > 0) {
          activeTotalBytes += sz;
          activeDoneBytes += Math.min(sz, Math.max(0, tr));
          activePctSum += Math.min(100, Math.max(0, (tr / sz) * 100));
        }
        if (t.status === 'running' && t.speed > 0) {
          if (t.kind === 'upload') upSpeed += Number(t.speed) || 0;
          else downSpeed += Number(t.speed) || 0;
        }
      }
    }
    if (el.transferBadge) {
      el.transferBadge.hidden = active === 0;
      if (active > 0) el.transferBadge.textContent = String(active);
    }
    if (el.sidebarTransferMini && el.sidebarTransferText) {
      if (active > 0) {
        el.sidebarTransferMini.hidden = false;
        var spParts = [];
        if (downSpeed > 0) spParts.push('↓ ' + fmtSpeed(downSpeed));
        if (upSpeed > 0) spParts.push('↑ ' + fmtSpeed(upSpeed));
        el.sidebarTransferText.textContent = spParts.length
          ? spParts.join(' · ')
          : ('传输中 ' + active + ' 项');
      } else {
        el.sidebarTransferMini.hidden = true;
      }
    }
    // 压缩包与最新修改之间的实时传输状态胶囊
    if (el.subbarTransferLive) {
      if (active > 0) {
        el.subbarTransferLive.hidden = false;
        var kindLabel = activeDown > 0 && activeUp > 0 ? '传输' : (activeUp > 0 ? '上传' : '下载');
        var nameLabel = (primaryTask && primaryTask.name ? primaryTask.name : '文件')
          + (active > 1 ? (' 等 ' + active + ' 项') : '');
        var pct = activeTotalBytes > 0
          ? Math.min(100, Math.round((activeDoneBytes / activeTotalBytes) * 100))
          : Math.min(100, Math.round(activePctSum / active));
        var totalSp = downSpeed + upSpeed;
        var metaParts = [];
        if (totalSp > 0) metaParts.push(fmtSpeed(totalSp));
        metaParts.push(pct + '%');
        if (doneCount > 0 || active > 1) metaParts.push(doneCount + '/' + (doneCount + active));
        if (el.stlKind) el.stlKind.textContent = kindLabel;
        if (el.stlName) el.stlName.textContent = nameLabel;
        if (el.stlFill) el.stlFill.style.width = pct + '%';
        if (el.stlMeta) el.stlMeta.textContent = metaParts.join(' · ');
        el.subbarTransferLive.title = kindLabel + '中：' + nameLabel + '（' + metaParts.join(' · ') + '），点击查看传输列表';
      } else {
        el.subbarTransferLive.hidden = true;
      }
    }
  }

  function updateTransferFilterPills() {
    if (!el.transferFilters) return;
    Array.prototype.forEach.call(el.transferFilters.querySelectorAll('.pill'), function (b) {
      var on = b.dataset.tfilter === state.transferFilter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function renderTransfers(forceDom) {
    updateTransferBadgesOnly();
    if (!forceDom && state.view !== 'transfers') {
      state.transfersDirty = true;
      return;
    }
    state.transfersDirty = false;
    var list = state.transfers || [];
    var visible = list.filter(matchTransferFilter);

    var oldEmpty = el.tlist.querySelector('.empty');
    if (visible.length && oldEmpty && oldEmpty.parentNode) oldEmpty.parentNode.removeChild(oldEmpty);

    var alive = new Set();
    var cursor = el.tlist.firstChild;
    visible.forEach(function (t) {
      alive.add(t.id);
      var sig = transferRowSig(t);
      var row = transferMap.get(t.id);
      if (!row) {
        row = createTransferRow(t);
        transferMap.set(t.id, row);
        transferSigs.set(t.id, sig);
      } else if (transferSigs.get(t.id) !== sig) {
        updateTransferRow(row, t);
        transferSigs.set(t.id, sig);
      }
      if (row === cursor) cursor = cursor.nextSibling;
      else el.tlist.insertBefore(row, cursor);
    });
    transferMap.forEach(function (row, id) {
      if (!alive.has(id)) {
        if (row.parentNode) row.parentNode.removeChild(row);
        transferMap.delete(id);
        transferSigs.delete(id);
      }
    });

    var active = 0, paused = 0, failed = 0, finished = 0, downSpeed = 0, upSpeed = 0;
    for (var i = 0; i < list.length; i++) {
      var st = list[i].status;
      if (st === 'running' || st === 'pending') {
        active += 1;
        if (st === 'running' && list[i].speed > 0) {
          if (list[i].kind === 'upload') upSpeed += Number(list[i].speed) || 0;
          else downSpeed += Number(list[i].speed) || 0;
        }
      } else if (st === 'paused') {
        paused += 1;
      } else if (st === 'error') {
        failed += 1;
      } else if (st === 'done' || st === 'canceled') {
        finished += 1;
      }
    }

    el.transfersSummary.textContent = list.length
      ? ('共 ' + list.length + ' 个任务'
        + (active ? '，进行中 ' + active + ' 个' : '')
        + (paused ? '，已暂停 ' + paused + ' 个' : '')
        + (failed ? '，失败 ' + failed + ' 个' : '')
        + (finished ? '，已结束 ' + finished + ' 个' : ''))
      : '';

    if (el.btnPauseAll) el.btnPauseAll.hidden = active === 0;
    if (el.btnResumeAll) el.btnResumeAll.hidden = paused === 0;
    if (el.btnRetryFailed) el.btnRetryFailed.hidden = failed === 0;
    if (el.transferSpeedStrip && el.transferSpeedText) {
      var speeds = [];
      if (downSpeed > 0) speeds.push('下载 ' + fmtSpeed(downSpeed));
      if (upSpeed > 0) speeds.push('上传 ' + fmtSpeed(upSpeed));
      el.transferSpeedStrip.hidden = speeds.length === 0;
      if (speeds.length) el.transferSpeedText.textContent = speeds.join('  ·  ');
    }

    if (!visible.length) {
      if (!el.tlist.querySelector('.empty')) {
        var box = h('div', 'empty');
        box.appendChild(icon('transfer', 'empty-ic'));
        box.appendChild(h('div', 'empty-title', list.length ? '当前筛选下没有任务' : '暂无传输任务'));
        box.appendChild(h('div', 'empty-sub', list.length ? '切换上方筛选标签可查看其他状态的任务。' : '上传或下载文件后，任务会显示在这里。'));
        el.tlist.appendChild(box);
      }
    }
  }

  async function refreshTransfers() {
    var seq = ++transferSeq;
    try {
      var list = await API.transfer.list();
      if (seq !== transferSeq) return;
      state.transfers = Array.isArray(list) ? list : [];
      state.transfersLoaded = true;
      handleTransferCompletionRefresh(state.transfers);
      renderTransfers(state.view === 'transfers');
    } catch (err) {
      if (!API.injected) return;
      reportError(err, '读取传输列表失败');
    }
  }

  async function onTransferBatch(kind) {
    try {
      if (kind === 'pauseAll') {
        if (API.has('transfer', 'pauseAll')) await API.transfer.pauseAll();
        else {
          var running = (state.transfers || []).filter(function (t) { return t.status === 'running' || t.status === 'pending'; });
          for (var i = 0; i < running.length; i++) await API.transfer.pause(running[i].id);
        }
        toast('info', '已暂停全部进行中的任务');
      } else if (kind === 'resumeAll') {
        if (API.has('transfer', 'resumeAll')) await API.transfer.resumeAll();
        else {
          var paused = (state.transfers || []).filter(function (t) { return t.status === 'paused'; });
          for (var j = 0; j < paused.length; j++) await API.transfer.resume(paused[j].id);
        }
        toast('ok', '已继续全部暂停任务');
      } else if (kind === 'retryFailed') {
        if (API.has('transfer', 'retryFailed')) await API.transfer.retryFailed();
        else {
          var errs = (state.transfers || []).filter(function (t) { return t.status === 'error'; });
          for (var k = 0; k < errs.length; k++) await API.transfer.retry(errs[k].id);
        }
        toast('ok', '已重新提交失败任务');
      }
      refreshTransfers();
    } catch (err) {
      reportError(err, '批量操作失败');
    }
  }

  async function onTransferAction(id, act) {
    var t = (state.transfers || []).filter(function (x) { return x.id === id; })[0];
    try {
      if (act === 'pause') { await API.transfer.pause(id); toast('info', '已暂停'); }
      else if (act === 'resume') { await API.transfer.resume(id); toast('info', '已继续'); }
      else if (act === 'retry') { await API.transfer.retry(id); toast('info', '已开始重试'); }
      else if (act === 'cancel') { await API.transfer.cancel(id); toast('info', '已取消'); }
      else if (act === 'clear') { await API.transfer.clear([id]); }
      else if (act === 'open') {
        var done = false;
        if (API.has('transfer', 'openItem')) {
          try {
            var r = await API.transfer.openItem(id);
            done = r !== false;
          } catch (e) { done = false; }
        }
        if (!done) {
          var p = t && (t.localDir || t.localPath);
          if (p) { await API.dialog.showInFolder(p); }
          else { toast('warn', '该任务没有可定位的本地路径'); }
        }
      }
      refreshTransfers();
    } catch (err) {
      reportError(err, '操作失败');
    }
  }

  async function clearFinished() {
    var ids = (state.transfers || []).filter(function (t) {
      return t.status === 'done' || t.status === 'canceled' || t.status === 'error';
    }).map(function (t) { return t.id; });
    if (!ids.length) { toast('info', '没有已结束的任务需要清除'); return; }
    var ok = await confirmDialog({
      title: '清除传输记录',
      message: '将从列表中移除 ' + ids.length + ' 个已结束（含失败/已取消）的任务记录。',
      detail: '仅清除记录，不会删除已下载的本地文件或云盘文件。',
      confirmText: '清除'
    });
    if (!ok) return;
    try {
      await API.transfer.clear(ids);
      toast('ok', '已清除 ' + ids.length + ' 条记录');
      refreshTransfers();
    } catch (err) {
      reportError(err, '清除记录失败');
    }
  }

  /* ================================================================== *
   * Agent 接入（设置页卡片）
   *
   * 设计约束：
   *  - 只做「启停 / 授权范围 / 操作记录 / MCP 配置」，不做聊天窗口；
   *  - 状态里只展示路径与计数，**绝不展示 token、Cookie 或凭据文件内容**；
   *  - 目录名与 fid 来自网盘，属不可信数据：一律用 textContent / createElement 渲染，
   *    不用 innerHTML 拼接；
   *  - 桥接层未注入或后端命令未接线时整块面板只显示提示，不发任何调用、不抛异常。
   * ================================================================== */

  var AGENT_JOURNAL_LIMIT = 20;

  var AGENT_RESULT_LABEL = {
    ok: '成功', error: '失败', rejected: '已拒绝', timeout: '超时',
    enabled: '已启用', disabled: '已停用', updated: '已更新',
    token_rotated: '凭据已重置', started: '已启动', stopped: '已停止',
    skipped: '已跳过', pending: '待核对'
  };

  var AGENT_WRITE_MODE_LABEL = { 'read-only': '只读', 'scoped-write': '授权范围内可写' };

  var AGENT_TRANSPORT_LABEL = { 'unix-socket': 'unix-socket', 'named-pipe': 'named-pipe' };

  var AGENT_SCOPE_HINT = {
    'read-only': '只读：Agent 只能浏览、搜索与读取已授权本地文件，不能下载、上传或修改网盘内容。',
    'scoped-write': '授权范围内可写：Agent 可在下列授权目录内下载、新建、上传、重命名与移动；删除权限需在下方单独开启。'
  };

  var AGENT_DELETE_HINT = {
    off: '禁止删除（默认）：即使开启写入模式，Agent 也不能删除网盘文件。',
    on: '允许移入回收站：仅在「授权范围内可写」时生效，Agent 可将授权目录内文件移入网盘回收站（需二次确认名称）。'
  };

  /** Agent 面板是否可用（桥接层已注入且提供 agent.status）。 */
  function agentBridgeReady() {
    return !!API.injected && API.has('agent', 'status');
  }

  function agentOf() { return state.agent; }

  function firstLine(text, max) {
    var s = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  /** 安全取值：主进程返回的对象字段可能是任意类型，统一收敛成字符串。 */
  function asText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  /** 授权根列表：主进程可能返回字符串，也可能返回 { path } 对象。 */
  function asRootStrings(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function (item) {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return asText(item.path);
      return '';
    }).filter(function (p) { return !!p; });
  }

  /** 错误码 / 错误文案（兼容 string、Error 与主进程信封对象）。 */
  function agentErrText(err) {
    if (!err) return '操作失败';
    if (typeof err === 'string') return err;
    var e = API.normalizeError(err, '操作失败');
    return asText(e.message) || '操作失败';
  }

  /** 本地时间 HH:mm:ss。 */
  function fmtClock(ts) {
    var n = Number(ts);
    if (!isFinite(n) || n <= 0) return '—';
    var d = new Date(n);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function agentResultLabel(result) {
    var key = String(result || '');
    if (AGENT_RESULT_LABEL[key]) return AGENT_RESULT_LABEL[key];
    return key || '—';
  }

  /** 记录条目的一行摘要：优先错误码，其次错误文案，最后耗时。 */
  function agentEntrySummary(entry) {
    var d = entry && entry.detail && typeof entry.detail === 'object' ? entry.detail : {};
    if (d.code) return String(d.code) + (d.message ? '：' + firstLine(d.message, 60) : '');
    if (d.message) return firstLine(d.message, 80);
    if (d.endpoint) return firstLine(d.endpoint, 80);
    if (d.changed && Array.isArray(d.changed) && d.changed.length) return '变更：' + d.changed.join('、');
    if (isFinite(Number(d.ms))) return '耗时 ' + Math.max(0, Math.round(Number(d.ms))) + ' ms';
    return '';
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function agentStatusLabel(st) {
    if (!st.enabled) return '未启用';
    if (st.running) return '运行中';
    return '已启用但未运行';
  }

  function agentStatusHintText(st) {
    var writes = AGENT_WRITE_MODE_LABEL[String(st.writeMode)] || String(st.writeMode || '只读');
    if (!st.enabled) {
      return '启用后外部 Agent 可通过本机套接字连接本客户端；当前写入模式：' + writes + '。';
    }
    if (!st.running) {
      return '监听未建立，外部 Agent 目前无法连接。可尝试停用后重新启用。';
    }
    return '写入模式：' + writes + '；授权目录修改后立即生效，无需重启。';
  }

  function setAgentDot(stateName) {
    if (!el.agentStatusDot) return;
    el.agentStatusDot.className = 'agent-dot' + (stateName ? ' agent-dot-' + stateName : '');
  }

  function renderAgentStatus() {
    if (!el.agentStatusText) return;
    var ag = agentOf();
    var ready = agentBridgeReady();
    var st = ready && ag.status && typeof ag.status === 'object' ? ag.status : null;

    if (!ready) {
      // 区分两种降级：纯浏览器（window.qk 不存在）与 Tauri 过渡期（桥在、agent.* 命令未接线）
      var injected = !!API.injected;
      el.agentStatusText.textContent = injected ? '接入命令未接线' : '未注入桥接层';
      el.agentStatusHint.textContent = injected
        ? '桥接层已注入，但未提供 agent.* 命令（后端尚未接线）：无法读取 Agent 接入状态。'
        : '未注入桥接层（window.qk 不存在）：无法读取 Agent 接入状态。请通过 npm start 启动桌面端后再试。';
      if (el.agentStatusError) { el.agentStatusError.hidden = true; el.agentStatusError.textContent = ''; }
      if (el.agentStatusExtra) { el.agentStatusExtra.hidden = true; el.agentStatusExtra.textContent = ''; }
      setAgentDot('');
    } else if (!st) {
      el.agentStatusText.textContent = ag.statusError ? '状态读取失败' : '正在读取…';
      el.agentStatusHint.textContent = '正在读取 Agent 接入状态与授权范围。';
      if (el.agentStatusError) {
        el.agentStatusError.hidden = !ag.statusError;
        el.agentStatusError.textContent = ag.statusError ? '错误详情：' + ag.statusError : '';
      }
      if (el.agentStatusExtra) { el.agentStatusExtra.hidden = true; el.agentStatusExtra.textContent = ''; }
      setAgentDot(ag.statusError ? 'error' : '');
    } else {
      el.agentStatusText.textContent = agentStatusLabel(st);
      el.agentStatusHint.textContent = agentStatusHintText(st);
      if (el.agentStatusError) {
        var lastError = asText(st.lastError);
        el.agentStatusError.hidden = !lastError;
        el.agentStatusError.textContent = lastError ? '最近错误：' + lastError : '';
      }
      setAgentDot(st.running ? 'on' : (st.enabled ? 'warn' : 'off'));
    }

    if (el.agentStatusExtra) {
      var parts = [];
      if (st) {
        var transport = asText(st.transport) || 'unix-socket';
        parts.push('传输方式：' + (AGENT_TRANSPORT_LABEL[transport] || transport));
        parts.push('监听地址：' + (asText(st.endpoint) || '—'));
        if (st.running) {
          parts.push('已服务调用：' + (Number(st.callsServed) || 0) + ' 次');
          parts.push('当前连接：' + (Number(st.connections) || 0));
        }
        parts.push('凭据文件：' + (asText(st.bridgeFile) || '—'));
        parts.push('记录文件：' + (asText(st.journalFile) || '—'));
      }
      el.agentStatusExtra.hidden = !parts.length;
      el.agentStatusExtra.textContent = parts.join(' · ');
    }

    var canOperate = ready && !!st;
    var running = !!(st && st.running);
    var enabled = !!(st && st.enabled);

    if (el.agentBtnEnable) el.agentBtnEnable.disabled = !canOperate || running;
    if (el.agentBtnDisable) el.agentBtnDisable.disabled = !canOperate || !enabled;
    if (el.agentBtnRotate) el.agentBtnRotate.disabled = !canOperate || !enabled;
    if (el.agentBtnAddRemote) el.agentBtnAddRemote.disabled = !ready;
    if (el.agentBtnAddRead) el.agentBtnAddRead.disabled = !ready;
    if (el.agentBtnAddWrite) el.agentBtnAddWrite.disabled = !ready;
    if (el.agentBtnRefreshJournal) el.agentBtnRefreshJournal.disabled = !ready;
    if (el.agentBtnCopyMcp) el.agentBtnCopyMcp.disabled = !ready;
  }

  function renderAgentWriteMode() {
    if (!el.agentScopeSeg) return;
    var ag = agentOf();
    var ready = agentBridgeReady();
    var st = ag.status && typeof ag.status === 'object' ? ag.status : null;
    var mode = st ? String(st.writeMode || '') : '';
    if (mode !== 'read-only' && mode !== 'scoped-write') mode = '';
    Array.prototype.forEach.call(el.agentScopeSeg.querySelectorAll('.seg'), function (b) {
      var on = !!mode && b.dataset.agentScope === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.disabled = !ready || !st;
    });
    if (el.agentScopeHint) {
      el.agentScopeHint.textContent = AGENT_SCOPE_HINT[mode] ||
        (ready ? '写入模式决定 Agent 能否修改网盘内容；修改后立即生效。' : '未注入桥接层，无法修改授权范围。');
    }
    if (el.agentDeleteSeg) {
      var allowDelete = !!(st && st.allowDelete);
      var writable = mode === 'scoped-write';
      Array.prototype.forEach.call(el.agentDeleteSeg.querySelectorAll('.seg'), function (b) {
        var wantOn = b.dataset.agentDelete === 'on';
        var active = !!st && (wantOn ? allowDelete : !allowDelete);
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
        b.disabled = !ready || !st || (wantOn && !writable);
      });
      if (el.agentDeleteHint) {
        if (!ready) {
          el.agentDeleteHint.textContent = '未注入桥接层，无法修改删除权限。';
        } else if (!st) {
          el.agentDeleteHint.textContent = AGENT_DELETE_HINT.off;
        } else if (!writable) {
          el.agentDeleteHint.textContent = '当前为只读模式，Agent 不能执行任何修改或删除操作。';
        } else {
          el.agentDeleteHint.textContent = allowDelete ? AGENT_DELETE_HINT.on : AGENT_DELETE_HINT.off;
        }
      }
    }
  }

  function agentEmptyHint(kind) {
    if (kind === 'remote') return '尚未授权任何网盘目录：Agent 无法访问网盘文件。可进入具体目录后点「添加当前目录」。';
    return '尚未授权本地目录：Agent 无法上传或下载到本地。';
  }

  function renderAgentList(container, entries, kind) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!entries.length) {
      container.appendChild(h('div', 'sethint agent-empty', agentEmptyHint(kind)));
      return;
    }
    entries.forEach(function (entry) {
      var row = h('div', 'agent-item');
      var meta = h('div', 'agent-item-meta');
      meta.appendChild(h('div', 'agent-item-title', entry.title));
      if (entry.sub) meta.appendChild(h('div', 'agent-item-sub', entry.sub));
      row.appendChild(meta);
      var btn = h('button', 'btn btn-sm btn-ghost', '移除');
      btn.type = 'button';
      btn.dataset.agentRemove = String(entry.index);
      btn.dataset.agentKind = entry.kind;
      row.appendChild(btn);
      container.appendChild(row);
    });
  }

  function renderAgentRemoteRoots() {
    var st = agentOf().status;
    var roots = st && Array.isArray(st.remoteRoots) ? st.remoteRoots : [];
    var entries = roots.map(function (raw, i) {
      var r = raw && typeof raw === 'object' ? raw : {};
      var name = asText(r.name);
      var fid = asText(r.fid);
      return {
        index: i,
        kind: 'remote',
        title: name || (fid ? '未命名目录' : '未知目录'),
        sub: 'fid：' + (firstLine(fid, 80) || '—')
      };
    });
    renderAgentList(el.agentRemoteRoots, entries, 'remote');
  }

  function renderAgentLocalRoots() {
    var st = agentOf().status;
    var read = asRootStrings(st && st.localReadRoots);
    var write = asRootStrings(st && st.localWriteRoots);
    renderAgentList(el.agentLocalReadRoots, read.map(function (p, i) {
      return { index: i, kind: 'read', title: p, sub: '只读' };
    }), 'read');
    renderAgentList(el.agentLocalWriteRoots, write.map(function (p, i) {
      return { index: i, kind: 'write', title: p, sub: '可读写' };
    }), 'write');
  }

  function renderAgentJournal() {
    if (!el.agentJournal) return;
    var ag = agentOf();
    var ready = agentBridgeReady();
    while (el.agentJournal.firstChild) el.agentJournal.removeChild(el.agentJournal.firstChild);

    if (!ready) {
      var injected = !!API.injected;
      el.agentJournal.appendChild(h('div', 'sethint agent-empty',
        injected ? 'Agent 接入命令未接线，无法读取操作记录。' : '未注入桥接层，无法读取操作记录。'));
      return;
    }
    if (ag.journalError) {
      el.agentJournal.appendChild(h('div', 'sethint agent-empty', '读取失败：' + ag.journalError));
      return;
    }
    if (!ag.loaded) {
      el.agentJournal.appendChild(h('div', 'sethint agent-empty', '正在读取…'));
      return;
    }
    var list = Array.isArray(ag.journal) ? ag.journal : [];
    if (!list.length) {
      el.agentJournal.appendChild(h('div', 'sethint agent-empty', '暂无记录'));
      return;
    }
    // 后端按时间正序返回，UI 反转后最新在最上面
    list.slice().reverse().forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      var row = h('div', 'agent-journal-row');
      row.appendChild(h('span', 'agent-journal-time', fmtClock(entry.ts)));
      row.appendChild(h('span', 'agent-journal-tool', asText(entry.tool) || ('配置 · ' + (asText(entry.kind) || '事件'))));
      row.appendChild(h('span', 'agent-journal-result', agentResultLabel(entry.result)));
      row.appendChild(h('span', 'agent-journal-detail', agentEntrySummary(entry)));
      el.agentJournal.appendChild(row);
    });
  }

  function renderAgentMcp() {
    if (!el.agentMcp) return;
    var ag = agentOf();
    var ready = agentBridgeReady();
    if (!ready) {
      el.agentMcp.textContent = API.injected
        ? 'Agent 接入命令未接线，无法读取 MCP 配置。'
        : '未注入桥接层，无法读取 MCP 配置。';
      return;
    }
    if (!ag.mcpText) {
      el.agentMcp.textContent = ag.mcpError ? '读取失败：' + ag.mcpError : '尚未读取配置。';
      return;
    }
    el.agentMcp.textContent = ag.mcpText;
  }

  function renderAgent() {
    if (!el.agentStatusText) return;
    if (el.agentCard) el.agentCard.classList.toggle('agent-off', !agentBridgeReady());
    renderAgentStatus();
    renderAgentWriteMode();
    renderAgentRemoteRoots();
    renderAgentLocalRoots();
    renderAgentJournal();
    renderAgentMcp();
  }

  /* ------------------------------ 数据加载 ------------------------------ */

  async function loadAgentStatus(force) {
    var ag = agentOf();
    if (!agentBridgeReady()) { renderAgent(); return; }
    if (ag.loading && !force) return;
    ag.loading = true;
    try {
      var st = await API.agent.status();
      ag.status = st && typeof st === 'object' ? st : null;
      ag.statusError = '';
    } catch (err) {
      ag.status = null;
      ag.statusError = agentErrText(err);
    }
    ag.loading = false;
    renderAgent();
  }

  async function loadAgentJournal() {
    var ag = agentOf();
    if (!agentBridgeReady() || !API.has('agent', 'journal')) {
      ag.journal = [];
      ag.journalError = '';
      ag.loaded = true;
      renderAgentJournal();
      return;
    }
    try {
      var list = await API.agent.journal(AGENT_JOURNAL_LIMIT);
      ag.journal = Array.isArray(list) ? list : [];
      ag.journalError = '';
    } catch (err) {
      ag.journal = [];
      ag.journalError = agentErrText(err);
    }
    ag.loaded = true;
    renderAgentJournal();
  }

  async function loadAgentMcp() {
    var ag = agentOf();
    if (!agentBridgeReady() || !API.has('agent', 'mcpConfig')) {
      ag.mcpText = '';
      ag.mcpError = '';
      renderAgentMcp();
      return;
    }
    try {
      var cfg = await API.agent.mcpConfig();
      ag.mcpText = cfg === undefined || cfg === null ? '' : JSON.stringify(cfg, null, 2);
      ag.mcpError = '';
    } catch (err) {
      ag.mcpText = '';
      ag.mcpError = agentErrText(err);
    }
    renderAgentMcp();
  }

  /** 首次进入设置页时懒加载；未加载或上次失败时重新拉取。 */
  function ensureAgent() {
    if (!agentBridgeReady()) return;
    var ag = agentOf();
    if ((!ag.status && !ag.loading) || (!!ag.statusError && !ag.loading)) loadAgentStatus();
    if (!ag.loaded || ag.journalError) loadAgentJournal();
    if (!ag.mcpText || ag.mcpError) loadAgentMcp();
  }

  /* ------------------------------ 操作 ------------------------------ */

  /** 二次确认：优先走桥接层的系统确认框，缺失或失败时回落到应用内自绘确认框。 */
  function agentConfirm(opts) {
    var o = opts || {};
    if (API.injected && API.has('dialog', 'confirm')) {
      return API.dialog.confirm({
        title: o.title || '请确认',
        message: o.message || '',
        detail: o.detail || '',
        danger: !!o.danger,
        confirmText: o.confirmText || '确定'
      }).then(function (ok) { return !!ok; }, function () {
        return confirmDialog(o);
      });
    }
    return confirmDialog(o);
  }

  async function refreshAgentAsync() {
    await loadAgentStatus(true);
    await loadAgentJournal();
    await loadAgentMcp();
  }

  async function agentToggle() {
    var ag = agentOf();
    var st = ag.status;
    if (!agentBridgeReady() || !st) { toast('warn', '尚未读取到 Agent 接入状态'); return; }
    if (st.enabled) {
      var okDisable = await agentConfirm({
        title: '停用 Agent 接入',
        message: '停用后桥接凭据立即删除，已连接的 Agent 会立即失效，需要重新配置。',
        detail: '授权范围会保留，再次启用时无需重新配置。',
        danger: true,
        confirmText: '停用'
      });
      if (!okDisable) return;
      try {
        await API.agent.disable();
        toast('info', 'Agent 接入已停用，权限立即失效');
      } catch (err) {
        reportError(err, '停用 Agent 接入失败');
      }
    } else {
      try {
        // 授权范围已保存在主进程配置里，这里不重复提交，避免用渲染层的旧快照覆盖刚改过的范围
        await API.agent.enable({});
        toast('info', 'Agent 接入已启用');
      } catch (err) {
        reportError(err, '启用 Agent 接入失败');
      }
    }
    await refreshAgentAsync();
  }

  async function agentRotate() {
    if (!agentBridgeReady()) return;
    var ok = await agentConfirm({
      title: '重新生成桥接凭据',
      message: '旧的桥接凭据会立即失效，已连接的 Agent 会断开，需要重新配置后才能连接。',
      detail: '正在运行的监听会重启，端点可能变化；MCP 客户端无需改动配置文件。',
      danger: true,
      confirmText: '重新生成'
    });
    if (!ok) return;
    try {
      await API.agent.rotate();
      toast('info', '桥接凭据已重新生成');
    } catch (err) {
      reportError(err, '重新生成凭据失败');
    }
    await refreshAgentAsync();
  }

  async function agentSetWriteMode(mode) {
    if (mode !== 'read-only' && mode !== 'scoped-write') return;
    if (!agentBridgeReady()) { toast('warn', '未注入桥接层，无法修改写入模式'); return; }
    var ag = agentOf();
    if (ag.status && String(ag.status.writeMode) === mode) return;
    try {
      var st = await API.agent.setScope({ writeMode: mode });
      if (st && typeof st === 'object') ag.status = st;
      ag.statusError = '';
      renderAgent();
      toast('info', '写入模式已更新为' + AGENT_WRITE_MODE_LABEL[mode]);
    } catch (err) {
      reportError(err, '设置写入模式失败');
    }
    await loadAgentStatus(true);
  }

  async function agentSetAllowDelete(allow) {
    var want = !!allow;
    if (!agentBridgeReady()) { toast('warn', '未注入桥接层，无法修改删除权限'); return; }
    var ag = agentOf();
    if (ag.status && Boolean(ag.status.allowDelete) === want) return;
    if (want) {
      if (!ag.status || String(ag.status.writeMode) !== 'scoped-write') {
        toast('warn', '请先将写入模式切换为「授权范围内可写」');
        return;
      }
      var ok = await agentConfirm({
        title: '开启 Agent 删除权限',
        message: '开启后，外部 Agent 与内置对话可在授权目录内将文件移入网盘回收站。',
        detail: '删除仍受授权目录限制并需核对文件名，且文件会进入网盘回收站（可找回）。',
        danger: true,
        confirmText: '允许移入回收站'
      });
      if (!ok) return;
    }
    try {
      var st = await API.agent.setScope({ allowDelete: want });
      if (st && typeof st === 'object') ag.status = st;
      ag.statusError = '';
      renderAgent();
      toast('info', want ? '已开启 Agent 删除权限（仅移入回收站）' : '已禁止 Agent 删除网盘文件');
    } catch (err) {
      reportError(err, '更新删除权限失败');
    }
    await loadAgentStatus(true);
    await loadAgentJournal();
  }

  async function agentAddCurrentDir() {
    if (!agentBridgeReady()) { toast('warn', '未注入桥接层，无法授权网盘目录'); return; }
    var fid = String(state.fid || '');
    if (!fid || fid === ROOT_FID) {
      toast('warn', '根目录不能被授权，请进入具体目录');
      return;
    }
    var ag = agentOf();
    var roots = ag.status && Array.isArray(ag.status.remoteRoots) ? ag.status.remoteRoots : [];
    var exists = roots.some(function (r) { return r && String(r.fid) === fid; });
    if (exists) { toast('info', '当前目录已在授权列表中'); return; }
    var next = roots.map(function (r) {
      return { fid: String((r && r.fid) || ''), name: asText(r && r.name) };
    }).filter(function (r) { return !!r.fid; });
    next.push({ fid: fid, name: currentDirName() });
    await agentScope({ remoteRoots: next }, '已授权当前目录');
  }

  async function agentPickLocalRoots(kind) {
    if (!agentBridgeReady()) { toast('warn', '未注入桥接层，无法授权本地目录'); return; }
    var picked;
    try {
      picked = await API.dialog.pickDirs();
    } catch (err) {
      reportError(err, '选择目录失败');
      return;
    }
    if (!Array.isArray(picked) || !picked.length) return;
    var ag = agentOf();
    var field = kind === 'write' ? 'localWriteRoots' : 'localReadRoots';
    var current = asRootStrings(ag.status && ag.status[field]);
    var patch = {};
    patch[field] = current.slice();
    picked.forEach(function (p) {
      var s = asText(p);
      if (s && patch[field].indexOf(s) < 0) patch[field].push(s);
    });
    await agentScope(patch, kind === 'write' ? '已添加工作目录' : '已添加上传来源目录');
  }

  /** 提交授权范围补丁：成功后就地刷新状态与记录。 */
  async function agentScope(patch, okText) {
    try {
      var st = await API.agent.setScope(patch);
      var ag = agentOf();
      if (st && typeof st === 'object') ag.status = st;
      ag.statusError = '';
      renderAgent();
      if (okText) toast('info', okText);
    } catch (err) {
      reportError(err, '更新授权范围失败');
    }
    await loadAgentStatus(true);
    await loadAgentJournal();
  }

  async function agentRemoveRoot(kind, index) {
    if (!agentBridgeReady()) return;
    var ag = agentOf();
    if (!ag.status) { toast('warn', '尚未读取到授权范围'); return; }
    var patch = null;
    if (kind === 'remote') {
      var roots = Array.isArray(ag.status.remoteRoots) ? ag.status.remoteRoots : [];
      if (index < 0 || index >= roots.length) return;
      patch = { remoteRoots: roots.filter(function (r, i) { return i !== index; }) };
    } else if (kind === 'read' || kind === 'write') {
      var field = kind === 'write' ? 'localWriteRoots' : 'localReadRoots';
      var list = asRootStrings(ag.status[field]);
      if (index < 0 || index >= list.length) return;
      patch = {};
      patch[field] = list.filter(function (p, i) { return i !== index; });
    }
    if (!patch) return;
    await agentScope(patch, '已移除授权目录');
  }

  async function agentRefreshJournal() {
    if (!agentBridgeReady()) { toast('warn', '未注入桥接层，无法读取操作记录'); return; }
    await loadAgentJournal();
    toast('info', '操作记录已刷新');
  }

  async function agentCopyMcp() {
    if (!agentBridgeReady()) { toast('warn', '未注入桥接层，无法复制 MCP 配置'); return; }
    var payload = '';
    var wroteToSystemClipboard = false;
    try {
      var text = await API.agent.copyMcpConfig();
      // 兼容两种后端语义：返回配置对象/JSON 文本（Tauri 无主进程剪贴板能力），
      // 或返回 true 表示后端已直接写系统剪贴板（qck Electron 形态）。
      if (typeof text === 'string') payload = text;
      else if (text && typeof text === 'object') payload = JSON.stringify(text, null, 2);
      else if (text === true) wroteToSystemClipboard = true;
    } catch (err) {
      // 后端未提供复制命令（NO_BRIDGE）时退回渲染层剪贴板；其它错误照常上报
      var e = API.normalizeError(err, '复制 MCP 配置失败');
      if (e.code !== 'NO_BRIDGE') { reportError(e, '复制 MCP 配置失败'); return; }
    }
    if (!payload && !wroteToSystemClipboard) payload = agentOf().mcpText;
    if (payload) {
      // 后端只回配置不写剪贴板（Tauri 形态）：由渲染层写；失败则提示手动复制
      var copied = await copyTextToClipboard(payload);
      if (copied) toast('info', 'MCP 配置已复制到剪贴板');
      else toast('warn', '复制失败：请手动选中 MCP 配置文本复制', 6000);
    } else if (wroteToSystemClipboard) {
      toast('info', 'MCP 配置已复制到剪贴板');
    } else {
      toast('warn', '没有可复制的 MCP 配置');
    }
    await loadAgentMcp();
  }

  /** 兜底复制：主进程 clipboard 不可用时退回渲染进程剪贴板 API。 */
  async function copyTextToClipboard(text) {
    try {
      if (globalThis.navigator && globalThis.navigator.clipboard &&
        typeof globalThis.navigator.clipboard.writeText === 'function') {
        await globalThis.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      return false;
    }
    return false;
  }

  /* ================================================================== *
   * 对话（Chat 视图）
   *
   * 设计约束（与 Agent 面板保持一致）：
   *  - 模型服务由用户自己配置，客户端不内置模型；API Key 只写不读，
   *    status() 只回 hasKey，渲染层没有任何入口能把 Key 读回来；
   *  - 工具名、文件名、摘要都来自网盘与模型，属**不可信数据**：一律 textContent 渲染；
   *  - 进度依赖 chat.onEvent 事件流（Tauri 事件通道 qk:chat-event），订阅在
   *    subscribeChannels() 里完成（先于任何 send）；
   *  - 事件流缺席时用 send() 的返回值兜底渲染，界面不会卡在"处理中"。
   * ================================================================== */

  var CHAT_HISTORY_LIMIT = 100;
  var CHAT_INPUT_MAX = 8000;      // 与主进程一致
  var CHAT_ARG_MAX = 2000;        // 展开区里 args 的显示上限（主进程已截到 400 字符）

  function chatOf() { return state.chat; }

  /** 对话是否可用（桥接层已注入且提供 chat.status）。 */
  function chatBridgeReady() {
    return !!API.injected && API.has('chat', 'status');
  }

  /** Base URL 尾段：只显示主机名与最后一段路径，便于确认打到了哪个服务。 */
  function baseUrlTail(url) {
    var s = asText(url).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!s) return '';
    var parts = s.split('/').filter(function (p) { return !!p; });
    if (!parts.length) return '';
    return parts.length > 1 ? parts[0] + '/' + parts[parts.length - 1] : parts[0];
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderChatCard() {
    if (!el.chatCardStatus) return;
    var ag = chatOf();
    var ready = chatBridgeReady();
    var st = ready && ag.status && typeof ag.status === 'object' ? ag.status : null;
    var configured = !!(st && st.configured);

    if (el.chatCard) el.chatCard.classList.toggle('chat-off', !ready);
    if (el.chatCardStatus) {
      if (!ready) el.chatCardStatus.textContent = API.injected ? '对话命令未接线' : '未注入桥接层';
      else if (!st) el.chatCardStatus.textContent = ag.statusError ? '状态读取失败' : '正在读取…';
      else if (!configured) el.chatCardStatus.textContent = '尚未配置';
      else el.chatCardStatus.textContent = asText(st.model) + ' · ' + (baseUrlTail(st.baseUrl) || '未知服务');
    }
    if (el.chatCardDot) {
      el.chatCardDot.className = 'agent-dot' +
        (!ready || ag.statusError ? ' agent-dot-error' : (configured ? ' agent-dot-on' : ''));
    }
    if (el.chatCardHint) {
      el.chatCardHint.textContent = ready
        ? '对话由你自己填写的大模型服务提供，客户端不内置模型、不经过中间服务。'
        : (API.injected
          ? '桥接层已注入，但未提供 chat.* 命令（后端尚未接线）：无法使用对话。'
          : '未注入桥接层（window.qk 不存在）：无法使用对话。请通过 npm start 启动桌面端后再试。');
    }
    if (el.chatSummary) {
      el.chatSummary.textContent = !ready || !st
        ? ''
        : (configured
          ? '模型 ' + asText(st.model) + ' · 工具 ' + (Number(st.toolCount) || 0) + ' 个'
          : '尚未配置大模型');
    }
    // 已配置时折叠为一行状态；未配置或用户点了「设置」才展开表单
    if (el.chatConfigForm) el.chatConfigForm.hidden = !(configured ? !!ag.expanded : true);
    if (el.chatBtnSettings) el.chatBtnSettings.hidden = !configured;
    if (el.chatBtnClearConfig) el.chatBtnClearConfig.disabled = !ready || !st;
    if (el.chatApiKey) {
      el.chatApiKey.placeholder = (st && st.hasKey) ? '已保存，留空则不修改' : '粘贴你的 API Key';
    }
    if (el.chatConfigHint) {
      el.chatConfigHint.hidden = !ag.formError;
      el.chatConfigHint.textContent = ag.formError ? ag.formError : '';
    }
    if (el.chatBtnSave) el.chatBtnSave.disabled = !ready || ag.saving;
    if (el.chatBtnTest) {
      el.chatBtnTest.disabled = !ready || ag.testing;
      el.chatBtnTest.textContent = ag.testing ? '测试中…' : '测试连接';
    }
    if (el.chatBtnModels) {
      el.chatBtnModels.disabled = !ready || ag.loadingModels;
      el.chatBtnModels.textContent = ag.loadingModels ? '获取中…' : '获取列表';
    }
    if (el.chatBtnClear) el.chatBtnClear.disabled = !ready || ag.sending;
  }

  function renderChatComposer() {
    var ag = chatOf();
    var ready = chatBridgeReady();
    var st = ready && ag.status && typeof ag.status === 'object' ? ag.status : null;
    var usable = ready && !!(st && st.configured) && !ag.sending;
    if (el.chatInput) el.chatInput.disabled = !usable;
    if (el.chatBtnSend) {
      el.chatBtnSend.disabled = !usable;
      el.chatBtnSend.textContent = ag.sending ? '处理中…' : '发送';
    }
  }

  function renderChatStatus() {
    if (!el.chatStatus) return;
    var ag = chatOf();
    var ready = chatBridgeReady();
    var st = ready && ag.status && typeof ag.status === 'object' ? ag.status : null;

    if (!ready) {
      el.chatStatus.textContent = API.injected
        ? '对话命令未接线，无法使用对话（后端尚未提供 chat.* 命令）。'
        : '未注入桥接层，无法使用对话。请通过 npm start 启动桌面端后再试。';
      return;
    }
    if (ag.phase === 'error') {
      el.chatStatus.textContent = ag.errorText || '对话失败';
      return;
    }
    // 事件先于 send() 的 Promise 落地：本轮已有结论时优先显示结论，避免停在「正在对话…」
    if (ag.phase === 'done' && ag.doneText) {
      el.chatStatus.textContent = ag.doneText;
      return;
    }
    if (ag.phase === 'busy' || ag.sending) {
      var head = ag.curRound ? ('第 ' + ag.curRound + '/' + (ag.maxRounds || ag.curRound) + ' 轮') : '正在发送…';
      el.chatStatus.textContent = ag.runningTool
        ? head + ' · 正在调用 ' + ag.runningTool
        : head + ' · 正在与模型对话…';
      return;
    }
    if (!st) {
      el.chatStatus.textContent = ag.statusError ? '状态读取失败：' + ag.statusError : '正在读取配置…';
      return;
    }
    if (!st.configured) {
      el.chatStatus.textContent = '请先配置大模型：在上方表单填好 Base URL、API Key 与模型名并保存后即可开始对话。';
      return;
    }
    el.chatStatus.textContent = asText(st.model) + ' · 工具 ' + (Number(st.toolCount) || 0) + ' 个';
  }

  function chatScrollBottom() {
    if (!el.chatMessages) return;
    try { el.chatMessages.scrollTop = el.chatMessages.scrollHeight; } catch (e) { /* 无滚动概念时忽略 */ }
  }

  /** 消息气泡骨架：返回 { wrap, body, text } 三个节点。 */
  function chatBubble(role) {
    var wrap = h('div', 'chat-msg chat-msg-' + role);
    wrap.appendChild(h('div', 'chat-msg-meta', role === 'user' ? '我' : '助手'));
    var body = h('div', 'chat-msg-body');
    var text = h('div', 'chat-msg-text');
    body.appendChild(text);
    wrap.appendChild(body);
    return { wrap: wrap, body: body, text: text };
  }

  /**
   * 单条工具调用的展示。进行中（ok === undefined）显示「正在执行 xxx…」且不可展开；
   * 结束后原地更新为 ✓/✗ + 耗时，点击展开看 args 与 summary。
   */
  function updateChatToolRow(row, tool) {
    var t = tool && typeof tool === 'object' ? tool : {};
    var btn = row.querySelector('.chat-tool-toggle');
    var body = row.querySelector('.chat-tool-body');
    if (!btn || !body) return row;
    var title = asText(t.title) || asText(t.name) || '未知工具';
    var running = t.ok === undefined || t.ok === null;
    var ms = Number(t.ms);

    row.classList.toggle('chat-tool-running', running);
    row.classList.toggle('chat-tool-ok', !running && !!t.ok);
    row.classList.toggle('chat-tool-fail', !running && !t.ok);
    btn.disabled = running;
    btn.textContent = running
      ? '正在执行 ' + title + '…'
      : (t.ok ? '✓ ' : '✗ ') + title + (isFinite(ms) ? ' · ' + Math.max(0, Math.round(ms)) + ' ms' : '');

    while (body.firstChild) body.removeChild(body.firstChild);
    var args = asText(t.args);
    if (args.length > CHAT_ARG_MAX) args = args.slice(0, CHAT_ARG_MAX) + '…';
    if (args) body.appendChild(h('pre', 'chat-tool-args', args));
    var summary = asText(t.summary);
    if (summary) body.appendChild(h('div', 'chat-tool-summary', summary));
    return row;
  }

  function chatToolRow(tool) {
    var row = h('div', 'chat-tool');
    var btn = h('button', 'chat-tool-toggle');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    var body = h('div', 'chat-tool-body');
    body.hidden = true;
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      var open = body.hidden;
      body.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      row.classList.toggle('chat-tool-open', open);
    });
    row.appendChild(btn);
    row.appendChild(body);
    return updateChatToolRow(row, tool);
  }

  /** 历史条目 → 节点。entry 来自主进程 history()，字段可能缺失，逐项兜底。 */
  function chatEntryNode(entry) {
    var isUser = entry.role === 'user';
    var b = chatBubble(isUser ? 'user' : 'assistant');
    b.text.textContent = asText(entry.text);
    if (isUser) return b.wrap;
    if (entry.error) b.wrap.classList.add('chat-msg-error');

    var tools = Array.isArray(entry.toolCalls) ? entry.toolCalls.filter(function (t) {
      return t && typeof t === 'object';
    }) : [];
    if (tools.length) {
      var box = h('div', 'chat-tools');
      tools.forEach(function (t) {
        box.appendChild(chatToolRow({
          name: asText(t.name),
          title: asText(t.title) || asText(t.name),
          ok: !!t.ok,
          ms: Number(t.ms) || 0,
          summary: asText(t.summary),
          args: asText(t.args)
        }));
      });
      b.body.appendChild(box);
    }

    var subs = [];
    if (Number(entry.rounds) > 0) subs.push(Number(entry.rounds) + ' 轮');
    if (Number(entry.ms) > 0) subs.push(Math.max(0, Math.round(Number(entry.ms))) + ' ms');
    if (entry.stopped === 'max_rounds') subs.push('已达到轮次上限，回复可能不完整');
    if (subs.length) b.body.appendChild(h('div', 'chat-msg-sub', subs.join(' · ')));
    return b.wrap;
  }

  function renderChatHistory() {
    if (!el.chatMessages) return;
    var ag = chatOf();
    while (el.chatMessages.firstChild) el.chatMessages.removeChild(el.chatMessages.firstChild);

    if (!chatBridgeReady()) {
      el.chatMessages.appendChild(h('div', 'sethint chat-empty',
        API.injected ? '对话命令未接线，无法读取对话历史。' : '未注入桥接层，无法读取对话历史。'));
      return;
    }
    if (ag.historyError) {
      el.chatMessages.appendChild(h('div', 'sethint chat-empty', '读取对话历史失败：' + ag.historyError));
      return;
    }
    if (!ag.loaded) {
      el.chatMessages.appendChild(h('div', 'sethint chat-empty', '正在读取…'));
      return;
    }
    var list = Array.isArray(ag.history) ? ag.history : [];
    if (!list.length && !ag.round) {
      el.chatMessages.appendChild(h('div', 'sethint chat-empty',
        '暂无对话。先在下方配置大模型，然后说说你想对网盘做什么。'));
      return;
    }
    list.forEach(function (entry) {
      if (entry && typeof entry === 'object') el.chatMessages.appendChild(chatEntryNode(entry));
    });
    chatScrollBottom();
  }

  /* --------------------------- 实时消息 --------------------------- */

  function appendUserMessage(text) {
    if (!el.chatMessages) return;
    var empty = el.chatMessages.querySelector ? el.chatMessages.querySelector('.chat-empty') : null;
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var b = chatBubble('user');
    b.text.textContent = asText(text);
    el.chatMessages.appendChild(b.wrap);
    chatScrollBottom();
  }

  /** 开一轮新的助手气泡：说明文字、工具条目都往这里追加。 */
  function chatBeginRound() {
    var ag = chatOf();
    if (!el.chatMessages) { ag.round = null; return null; }
    var empty = el.chatMessages.querySelector ? el.chatMessages.querySelector('.chat-empty') : null;
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var b = chatBubble('assistant');
    b.wrap.classList.add('chat-msg-pending');
    var note = h('div', 'chat-msg-note');
    var toolBox = h('div', 'chat-tools');
    b.body.appendChild(note);
    b.body.appendChild(toolBox);
    el.chatMessages.appendChild(b.wrap);
    chatScrollBottom();
    ag.round = { bubble: b, note: note, toolBox: toolBox, tools: [], done: false };
    return ag.round;
  }

  function chatFinishRound(info) {
    var ag = chatOf();
    var round = ag.round;
    var data = info && typeof info === 'object' ? info : {};
    ag.phase = 'done';
    ag.runningTool = '';
    // done 事件已给出本轮结论：立即结束发送态，避免 send() Promise 迟到时按钮停在「处理中…」；
    // Promise 随后落地时 ag.round 已为 null，不会重复渲染。
    ag.sending = false;
    ag.doneText = (data.stopped ? '已达到轮次上限' : '已完成')
      + (Number(data.rounds) > 0 ? ' · ' + Number(data.rounds) + ' 轮' : '')
      + (Number(data.ms) > 0 ? ' · 耗时 ' + Math.max(0, Math.round(Number(data.ms))) + ' ms' : '');
    if (round) {
      round.done = true;
      round.bubble.wrap.classList.remove('chat-msg-pending');
      round.bubble.text.textContent = asText(data.reply) || '（模型没有返回内容）';
      // 事件流缺席时（只拿到 send() 的返回值）用返回值里的工具记录补齐，避免丢过程
      var calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
      if (calls.length && !round.toolBox.querySelectorAll('.chat-tool').length) {
        calls.forEach(function (c) {
          if (!c || typeof c !== 'object') return;
          round.toolBox.appendChild(chatToolRow({
            name: asText(c.name),
            title: asText(c.title) || asText(c.name),
            ok: !!c.ok,
            ms: Number(c.ms) || 0,
            summary: asText(c.summary),
            args: asText(c.args)
          }));
        });
      }
      var subs = [];
      if (Number(data.rounds) > 0) subs.push(Number(data.rounds) + ' 轮');
      if (Number(data.ms) > 0) subs.push(Math.max(0, Math.round(Number(data.ms))) + ' ms');
      if (data.stopped) subs.push('已达到轮次上限，回复可能不完整');
      if (subs.length) round.bubble.body.appendChild(h('div', 'chat-msg-sub', subs.join(' · ')));
      ag.round = null;
    }
    renderChatStatus();
    renderChatComposer();
    chatScrollBottom();
  }

  function chatFailRound(message, hint) {
    var ag = chatOf();
    var round = ag.round;
    var text = asText(message) || '对话失败';
    ag.phase = 'error';
    ag.runningTool = '';
    // 错误事件即本轮结束：不等待 send() 的 Promise（它随后 reject 时不会重复渲染），
    // 否则传输层卡住时按钮会永远停在「处理中…」。
    ag.sending = false;
    ag.errorText = '失败：' + text + (asText(hint) ? '（' + asText(hint) + '）' : '');
    if (round) {
      round.done = true;
      round.bubble.wrap.classList.remove('chat-msg-pending');
      round.bubble.wrap.classList.add('chat-msg-error');
      round.bubble.text.textContent = '❌ ' + text;
      ag.round = null;
    }
    renderChatStatus();
    renderChatComposer();
    chatScrollBottom();
  }

  /** 进度事件（Tauri 通道 qk:chat-event）。事件字段都当不可信数据处理。 */
  function handleChatEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    var ag = chatOf();
    var type = asText(ev.type);

    if (type === 'round') {
      ag.curRound = Number(ev.round) || ag.curRound;
      ag.maxRounds = Number(ev.maxRounds) || ag.maxRounds;
      if (!ag.round) chatBeginRound();
      ag.phase = 'busy';
      renderChatStatus();
      return;
    }

    if (type === 'assistant_note') {
      if (!ag.round) chatBeginRound();
      if (ag.round && asText(ev.text)) {
        ag.round.note.appendChild(h('div', 'chat-note-line', asText(ev.text)));
        chatScrollBottom();
      }
      return;
    }

    if (type === 'tool_start') {
      if (!ag.round) chatBeginRound();
      if (!ag.round) return;
      var name = asText(ev.name);
      var title = asText(ev.title) || name;
      var row = chatToolRow({ name: name, title: title, args: asText(ev.args) });
      ag.round.toolBox.appendChild(row);
      ag.round.tools.push({ name: name, row: row });
      ag.runningTool = title || name;
      ag.phase = 'busy';
      renderChatStatus();
      chatScrollBottom();
      return;
    }

    if (type === 'tool_end') {
      var endedName = asText(ev.name);
      var record = {
        name: endedName,
        title: asText(ev.title) || endedName,
        ok: !!ev.ok,
        ms: Number(ev.ms) || 0,
        summary: asText(ev.summary),
        args: asText(ev.args)
      };
      if (ag.round) {
        var target = null;
        for (var i = 0; i < ag.round.tools.length; i += 1) {
          var item = ag.round.tools[i];
          if (item.name === endedName && item.row.classList.contains('chat-tool-running')) { target = item; break; }
        }
        // 工具一条一条串行执行：正常情况下总能配对到刚才那条 tool_start，原地更新即可
        if (target) updateChatToolRow(target.row, record);
        else ag.round.toolBox.appendChild(chatToolRow(record));
      }
      ag.runningTool = '';
      renderChatStatus();
      chatScrollBottom();
      return;
    }

    if (type === 'done') {
      chatFinishRound({
        reply: asText(ev.reply),
        rounds: Number(ev.rounds) || 0,
        ms: Number(ev.ms) || 0,
        stopped: ev.stopped === 'max_rounds'
      });
      return;
    }

    if (type === 'error') {
      chatFailRound(asText(ev.message), asText(ev.hint));
    }
  }

  /* ------------------------------ 数据加载 ------------------------------ */

  /** 从服务端状态回填 Base URL 与模型名（force=false 时不覆盖用户正在编辑的输入）。 */
  function prefillChatForm(force) {
    var ag = chatOf();
    var st = ag.status && typeof ag.status === 'object' ? ag.status : null;
    if (!st) return;
    if (el.chatBaseUrl && (force || !String(el.chatBaseUrl.value || '').trim())) {
      el.chatBaseUrl.value = asText(st.baseUrl);
    }
    if (el.chatModel && (force || !String(el.chatModel.value || '').trim())) {
      el.chatModel.value = asText(st.model);
    }
  }

  async function loadChatStatus(force) {
    var ag = chatOf();
    if (!chatBridgeReady()) { renderChat(); return; }
    if (ag.loading && !force) return;
    ag.loading = true;
    try {
      var st = await API.chat.status();
      ag.status = st && typeof st === 'object' ? st : null;
      ag.statusError = '';
    } catch (err) {
      ag.status = null;
      ag.statusError = agentErrText(err);
    }
    ag.loading = false;
    prefillChatForm(false);
    renderChat();
  }

  async function loadChatHistory() {
    var ag = chatOf();
    if (!chatBridgeReady() || !API.has('chat', 'history')) {
      ag.history = [];
      ag.historyError = '';
      ag.loaded = true;
      renderChatHistory();
      return;
    }
    try {
      var list = await API.chat.history(CHAT_HISTORY_LIMIT);
      ag.history = Array.isArray(list) ? list : [];
      ag.historyError = '';
    } catch (err) {
      ag.history = [];
      ag.historyError = agentErrText(err);
    }
    ag.loaded = true;
    renderChatHistory();
  }

  /** 进入对话视图时懒加载；配置每次进入都重读，避免显示过期状态。 */
  function ensureChat() {
    if (!chatBridgeReady()) { renderChat(); renderChatHistory(); return; }
    var ag = chatOf();
    // 每次都重读配置：配置可能被其它入口改变（例如外部脚本经桥接调用 saveConfig），
    // 只做一次懒加载会让面板长期显示过期状态（与设置页 Agent 面板的处理一致）。
    // loadChatStatus 自带并发保护（ag.loading），重复调用安全。
    loadChatStatus();
    // 历史只在首次或上次失败时拉取：发送中重新渲染会丢掉正在进行的这一轮
    if ((!ag.loaded || ag.historyError) && !ag.sending) loadChatHistory();
  }

  function renderChat() {
    renderChatCard();
    renderChatComposer();
    renderChatStatus();
  }

  /* ------------------------------ 操作 ------------------------------ */

  function chatAutoGrow() {
    if (!el.chatInput) return;
    var lines = String(el.chatInput.value || '').split('\n').length;
    el.chatInput.setAttribute('rows', String(Math.max(2, Math.min(4, lines))));
  }

  async function chatSaveConfig() {
    var ag = chatOf();
    if (!chatBridgeReady()) { toast('warn', '未注入桥接层，无法保存对话配置'); return; }
    var patch = {
      baseUrl: el.chatBaseUrl ? String(el.chatBaseUrl.value || '').trim() : '',
      model: el.chatModel ? String(el.chatModel.value || '').trim() : ''
    };
    // 留空 = 保留原 Key（主进程约定：apiKey 省略或空字符串都表示不修改）
    var key = el.chatApiKey ? String(el.chatApiKey.value || '').trim() : '';
    if (key) patch.apiKey = key;

    ag.saving = true;
    renderChatCard();
    try {
      var st = await API.chat.saveConfig(patch);
      ag.status = st && typeof st === 'object' ? st : null;
      ag.statusError = '';
      ag.formError = '';
      ag.expanded = false;
      if (el.chatApiKey) el.chatApiKey.value = '';
      toast('info', '大模型配置已保存');
    } catch (err) {
      var e = API.normalizeError(err, '保存配置失败');
      ag.formError = '保存失败：' + asText(e.message) + (asText(e.hint) ? '（' + asText(e.hint) + '）' : '');
    }
    ag.saving = false;
    ag.phase = 'idle';
    ag.doneText = '';
    renderChat();
  }

  async function chatTest() {
    var ag = chatOf();
    if (!chatBridgeReady()) { toast('warn', '未注入桥接层，无法测试连接'); return; }
    ag.testing = true;
    ag.formError = '';
    renderChatCard();
    try {
      var r = await API.chat.test();
      var model = asText(r && r.model) || '模型';
      var reply = asText(r && r.reply);
      ag.formError = '';
      toast('info', '连接成功：' + model + (reply ? ' · ' + firstLine(reply, 40) : ''), 6000);
    } catch (err) {
      var e = API.normalizeError(err, '测试连接失败');
      ag.formError = '测试连接失败：' + asText(e.message) + (asText(e.hint) ? '（' + asText(e.hint) + '）' : '');
    }
    ag.testing = false;
    renderChatCard();
  }

  async function chatClear() {
    var ag = chatOf();
    if (!chatBridgeReady()) { toast('warn', '未注入桥接层，无法清空对话'); return; }
    if (ag.sending) { toast('warn', '正在处理中，请等这一轮结束'); return; }
    try {
      await API.chat.clear();
      ag.history = [];
      ag.historyError = '';
      ag.loaded = true;
      ag.phase = 'idle';
      ag.doneText = '';
      ag.errorText = '';
      ag.round = null;
      renderChatHistory();
      renderChatStatus();
      toast('info', '对话已清空');
    } catch (err) {
      reportError(err, '清空对话失败');
    }
  }

  async function chatClearConfig() {
    var ag = chatOf();
    if (!chatBridgeReady()) { toast('warn', '未注入桥接层，无法清除配置'); return; }
    if (ag.sending) { toast('warn', '正在处理中，请等这一轮结束'); return; }
    var ok = await agentConfirm({
      title: '清除大模型配置',
      message: '将删除 Base URL、模型名以及本机加密存储中的 API Key。',
      detail: '对话历史不受影响；清除后需要重新填写才能继续对话。',
      danger: true,
      confirmText: '清除'
    });
    if (!ok) return;
    try {
      var st = await API.chat.clearConfig();
      ag.status = st && typeof st === 'object' ? st : null;
      ag.statusError = '';
      ag.expanded = true;
      ag.formError = '';
      ag.phase = 'idle';
      ag.doneText = '';
      if (el.chatBaseUrl) el.chatBaseUrl.value = '';
      if (el.chatApiKey) el.chatApiKey.value = '';
      if (el.chatModel) el.chatModel.value = '';
      toast('info', '大模型配置已清除');
    } catch (err) {
      reportError(err, '清除配置失败');
    }
    renderChat();
  }

  /** 拉取模型列表并填充下拉（datalist）。需要先保存 Base URL 与 API Key。 */
  async function chatFetchModels() {
    var ag = chatOf();
    if (!chatBridgeReady() || !API.has('chat', 'models')) { toast('warn', '未注入桥接层，无法获取模型列表'); return; }
    ag.loadingModels = true;
    ag.formError = '';
    renderChatCard();
    try {
      var r = await API.chat.models();
      var models = r && Array.isArray(r.models) ? r.models : [];
      ag.modelOptions = models;
      renderChatModelList();
      toast('info', '已获取 ' + models.length + ' 个模型，点击模型输入框即可选择', 5000);
    } catch (err) {
      var e = API.normalizeError(err, '获取模型列表失败');
      ag.formError = '获取模型列表失败：' + asText(e.message) + (asText(e.hint) ? '（' + asText(e.hint) + '）' : '');
      renderChatCard();
    } finally {
      ag.loadingModels = false;
      renderChatCard();
    }
  }

  /** 把模型列表填进 datalist（保持已输入的值不被覆盖）。 */
  function renderChatModelList() {
    var ag = chatOf();
    var dl = el.chatModelList;
    if (!dl) return;
    while (dl.firstChild) dl.removeChild(dl.firstChild);
    var models = Array.isArray(ag.modelOptions) ? ag.modelOptions : [];
    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = String(m);
      dl.appendChild(opt);
    });
  }

  function chatToggleConfig() {
    var ag = chatOf();
    ag.expanded = !ag.expanded;
    if (ag.expanded) {
      ag.formError = '';
      prefillChatForm(true);
    }
    renderChatCard();
  }

  async function chatSend() {
    var ag = chatOf();
    if (ag.sending) return;
    var ready = chatBridgeReady();
    var st = ready && ag.status && typeof ag.status === 'object' ? ag.status : null;
    if (!ready || !st || !st.configured) {
      renderChatStatus();
      toast('warn', '请先配置大模型（Base URL、API Key 与模型名）');
      return;
    }
    var text = el.chatInput ? String(el.chatInput.value || '').trim() : '';
    if (!text) { toast('warn', '消息不能为空'); return; }
    if (text.length > CHAT_INPUT_MAX) { toast('warn', '单条消息过长（上限 8000 字）'); return; }

    appendUserMessage(text);
    if (el.chatInput) { el.chatInput.value = ''; chatAutoGrow(); }

    ag.sending = true;
    ag.phase = 'busy';
    ag.curRound = 0;
    ag.maxRounds = Number(st.maxRounds) || 0;
    ag.runningTool = '';
    ag.errorText = '';
    ag.doneText = '';
    chatBeginRound();
    renderChatCard();
    renderChatComposer();
    renderChatStatus();

    var result = null;
    try {
      result = await API.chat.send(text);
    } catch (err) {
      var e = API.normalizeError(err, '发送失败');
      ag.sending = false;
      renderChatCard();
      if (ag.round) chatFailRound(e.message, asText(e.hint) || asText(e.code));
      else if (ag.phase !== 'error') {
        ag.phase = 'error';
        ag.errorText = '失败：' + asText(e.message) + (asText(e.hint) ? '（' + asText(e.hint) + '）' : '');
        renderChatStatus();
      }
      renderChatComposer();
      return;
    }

    ag.sending = false;
    // 正常路径由 done 事件渲染并清空 ag.round；事件流缺席时用返回值兜底
    if (ag.round) {
      chatFinishRound({
        reply: result && asText(result.reply),
        rounds: result ? Number(result.rounds) || 0 : 0,
        ms: result ? Number(result.ms) || 0 : 0,
        stopped: !!(result && result.stopped === 'max_rounds'),
        toolCalls: result && Array.isArray(result.toolCalls) ? result.toolCalls : []
      });
    }
    renderChatCard();
    renderChatComposer();
    chatScrollBottom();
  }

  /* ================================================================== *
   * 设置
   * ================================================================== */

  function applyTheme(theme) {
    var t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('qk-theme', t); } catch (_) {}
    if (el.themeSeg) {
      Array.prototype.forEach.call(el.themeSeg.querySelectorAll('.seg'), function (b) {
        var on = b.dataset.theme === t;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
  }

  function applyAiBeta(enabled) {
    var on = !!enabled;
    state.settings.aiBetaEnabled = on;
    if (el.navChat) el.navChat.hidden = !on;
    if (el.agentCard) el.agentCard.hidden = !on;
    if (el.aiBetaHint) {
      el.aiBetaHint.textContent = on
        ? '已开启（Beta 测试功能）：左侧导航已显示「对话 Beta」，下方已展开「Agent 接入（Beta）」。可随时关闭恢复极简模式，已保存的配置不会丢失。'
        : '默认关闭。手动开启后，侧边栏将展示「对话 Beta」入口，并在下方展开「Agent 接入（Beta）」配置面板。';
    }
    if (el.setAiBeta) {
      Array.prototype.forEach.call(el.setAiBeta.querySelectorAll('.seg'), function (b) {
        var active = (b.dataset.aiBeta === 'on') === on;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
    if (!on && state.view === 'chat') {
      setView('settings');
    }
  }

  function applyFloatingSettings() {
    var ballOn = !!state.settings.floatingTransferBall;
    var unarchOn = !!state.settings.floatingUnarchiveWindow;
    if (el.setFloatBall) {
      Array.prototype.forEach.call(el.setFloatBall.querySelectorAll('.seg'), function (b) {
        var active = (b.dataset.floatBall === 'on') === ballOn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
    if (el.setFloatUnarchive) {
      Array.prototype.forEach.call(el.setFloatUnarchive.querySelectorAll('.seg'), function (b) {
        var active = (b.dataset.floatUnarchive === 'on') === unarchOn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
  }

  function renderAppVersion() {
    if (!el.appVersionText) return;
    var info = state.appInfo;
    if (info && info.version) {
      var plat = info.platform ? (' · ' + info.platform + (info.arch ? '/' + info.arch : '')) : '';
      el.appVersionText.textContent = '夸克网盘极简版 v' + info.version + ' · ' + (info.runtime || 'Tauri 2 + Rust') + plat;
    } else {
      el.appVersionText.textContent = '夸克网盘极简版 v1.2.0 · Tauri 2 + Rust';
    }
  }

  async function loadAppInfo() {
    if (!API.has('app', 'info')) { renderAppVersion(); return; }
    try {
      var info = await API.app.info();
      if (info && typeof info === 'object') state.appInfo = info;
    } catch (_) { /* 静默 */ }
    renderAppVersion();
  }

  function updatePerfWarning() {
    if (!el.setPerfWarn) return;
    var upC = parseInt(el.upConc ? el.upConc.value : state.settings.uploadConcurrency, 10) || state.settings.uploadConcurrency;
    var upP = parseInt(el.upPart ? el.upPart.value : state.settings.uploadPartConcurrency, 10) || state.settings.uploadPartConcurrency;
    var dnC = parseInt(el.downConc ? el.downConc.value : state.settings.downloadConcurrency, 10) || state.settings.downloadConcurrency;
    var dnP = parseInt(el.downParallel ? el.downParallel.value : state.settings.downloadParallel, 10) || state.settings.downloadParallel;
    var highs = [];
    if (upC > 6) highs.push('同时上传数 ' + upC + '（建议 ≤ 6）');
    if (upP > 12) highs.push('上传分片并发 ' + upP + '（建议 ≤ 12）');
    if (dnC > 6) highs.push('同时下载数 ' + dnC + '（建议 ≤ 6）');
    if (dnP > 32) highs.push('单文件下载连接 ' + dnP + '（建议 ≤ 32）');
    el.setPerfWarn.hidden = highs.length === 0;
    if (highs.length && el.setPerfWarnText) {
      el.setPerfWarnText.textContent = '已超过建议阈值：' + highs.join('、') + '。设置不设上限，但过高可能导致内存占用飙升、磁盘抖动、界面卡顿或触发限流。';
    }
  }

  function applyAskDownloadDir(ask) {
    var on = !!ask;
    state.settings.askDownloadDir = on;
    if (el.setAskDlDir) {
      Array.prototype.forEach.call(el.setAskDlDir.querySelectorAll('.seg'), function (b) {
        var active = (b.dataset.askDl === 'on') === on;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
  }

  async function loadSettings() {
    el.envHint.textContent = API.bridgeInfo().text;
    try {
      var s = await API.settings.get();
      if (s && typeof s === 'object') {
        state.settings = {
          downloadDir: s.downloadDir || '',
          askDownloadDir: s.askDownloadDir === true,
          uploadConcurrency: Math.max(1, Number(s.uploadConcurrency) || 2),
          downloadConcurrency: Math.max(1, Number(s.downloadConcurrency) || 2),
          downloadParallel: Math.max(1, Number(s.downloadParallel) || 16),
          downloadStrategy: ['auto', 'sequential', 'parallel'].indexOf(s.downloadStrategy) >= 0 ? s.downloadStrategy : 'auto',
          uploadPartConcurrency: Math.max(1, Number(s.uploadPartConcurrency) || 3),
          theme: s.theme === 'dark' ? 'dark' : 'light',
          aiBetaEnabled: s.aiBetaEnabled === true,
          serverOptIn: s.serverOptIn === true,
          serverPrompted: s.serverPrompted === true,
          tutorialSeen: s.tutorialSeen === true,
          viewMode: s.viewMode === 'grid' ? 'grid' : 'list',
          sortBy: typeof s.sortBy === 'string' && s.sortBy ? s.sortBy : DEFAULT_SORT
        };
        state.sortBy = state.settings.sortBy;
        applyTheme(state.settings.theme);
        applyAiBeta(state.settings.aiBetaEnabled);
        applyAskDownloadDir(state.settings.askDownloadDir);
        applyViewMode(state.settings.viewMode, false);
        updateSortIndicators();
        renderSettings();
        return;
      }
    } catch (err) {
      if (API.injected && !API.isMock) reportError(err, '读取设置失败');
    }
    applyTheme(state.settings.theme);
    applyAiBeta(state.settings.aiBetaEnabled);
    applyAskDownloadDir(state.settings.askDownloadDir);
    applyViewMode(state.settings.viewMode, false);
    updateSortIndicators();
    renderSettings();
  }

  function renderSettings() {
    el.dlDir.value = state.settings.downloadDir || '';
    el.dlDir.placeholder = state.settings.downloadDir ? '' : '尚未设置（首次下载时会提示选择）';
    applyAskDownloadDir(state.settings.askDownloadDir);
    el.upConc.value = state.settings.uploadConcurrency;
    el.downConc.value = state.settings.downloadConcurrency;
    if (el.upPart) el.upPart.value = state.settings.uploadPartConcurrency;
    if (el.downParallel) el.downParallel.value = state.settings.downloadParallel;
    if (el.downStrategy) el.downStrategy.value = state.settings.downloadStrategy;
    updatePerfWarning();
    applyTheme(state.settings.theme);
    applyAiBeta(state.settings.aiBetaEnabled);
    applyFloatingSettings();
    renderHubSettings();
    renderFeedbackView();
    renderAppVersion();
    renderSettingsAccountHint();
  }

  async function saveSettings(patch) {
    try {
      var s = await API.settings.set(patch);
      if (s && typeof s === 'object') Object.assign(state.settings, s);
      applyTheme(state.settings.theme);
      applyAiBeta(state.settings.aiBetaEnabled);
      renderSettings();
      return true;
    } catch (err) {
      renderSettings();
      reportError(err, '保存设置失败');
      return false;
    }
  }

  async function onToggleAiBeta(wantOn) {
    var on = !!wantOn;
    if (on === !!state.settings.aiBetaEnabled) return;
    if (on) {
      var ok = await saveSettings({ aiBetaEnabled: true });
      if (ok) {
        toast('ok', '已开启 AI 实验室（Beta 测试功能），侧栏已展示「对话 Beta」与下方 Agent 配置');
        renderAgent();
        ensureAgent();
        loadAgentStatus(true);
      }
      return;
    }
    var okOff = await saveSettings({ aiBetaEnabled: false });
    if (okOff) {
      toast('info', '已关闭 AI 实验室（Beta），界面恢复极简网盘模式');
    }
  }

  async function pickDownloadDir() {
    try {
      var dir = await API.dialog.saveDir(state.settings.downloadDir || undefined);
      if (!dir) return;
      if (await saveSettings({ downloadDir: dir })) toast('info', '下载目录已更新');
    } catch (err) {
      reportError(err, '选择目录失败');
    }
  }

  /* ================================================================== *
   * 视图切换
   * ================================================================== */

  /* ================================================================== *
   * 可选作者服务器（在线更新直链 / 脱敏性能日志 / 应用内反馈）
   *
   * 隐私硬约定：
   *  - serverOptIn 默认关闭；未开启时绝不向作者服务器发送任何请求或数据；
   *  - 开启后仅在 X25519+AES-256-GCM 端到端加密下上传经脱敏的非敏感摘要；
   *  - 更新清单经 Ed25519 验签，直链下载包经 SHA-256 校验后才落盘。
   * ================================================================== */

  function hubBridgeReady() {
    return !!API.injected && API.has('hub', 'setOptIn');
  }

  function hubAvailable() {
    return hubBridgeReady() && !(state.hub.config && state.hub.config.available === false);
  }

  function renderHubSettings() {
    var avail = hubAvailable();
    if (el.hubCard) el.hubCard.hidden = !avail;
    var navFb = $('nav-feedback');
    if (navFb) navFb.hidden = !avail;
    if (!avail) {
      if (state.view === 'feedback') setView('files');
      return;
    }
    var on = !!state.settings.serverOptIn;
    if (el.hubStatusBadge) {
      el.hubStatusBadge.textContent = on ? '已开启 · 加密连接' : '已关闭 · 零外传';
      el.hubStatusBadge.classList.toggle('hub-badge-on', on);
    }
    if (el.setHubOptIn) {
      Array.prototype.forEach.call(el.setHubOptIn.querySelectorAll('.seg'), function (b) {
        var active = (b.dataset.hubOptin === 'on') === on;
        b.classList.toggle('active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
        b.disabled = !hubBridgeReady();
      });
    }
    if (el.btnHubCheck) el.btnHubCheck.disabled = !hubBridgeReady() || !on || state.hub.checking;
    if (el.btnHubLogs) el.btnHubLogs.disabled = !hubBridgeReady();
    if (el.hubCryptoText && state.hub.config && state.hub.config.cryptoSummary) {
      el.hubCryptoText.textContent = '链路安全：' + state.hub.config.cryptoSummary + ' · 节点：' + (state.hub.config.region || '海外节点');
    }
    if (!on && el.hubUpdatePanel) {
      el.hubUpdatePanel.hidden = true;
    }
  }

  function renderFeedbackView() {
    var ready = hubBridgeReady();
    var on = !!state.settings.serverOptIn;
    if (el.fbGateCard) el.fbGateCard.hidden = !ready || on;
    var disabled = !ready || !on || state.hub.submittingFeedback;
    if (el.fbCategory) el.fbCategory.disabled = !ready || !on;
    if (el.fbContact) el.fbContact.disabled = !ready || !on;
    if (el.fbMessage) el.fbMessage.disabled = !ready || !on;
    if (el.fbIncludeLogs) el.fbIncludeLogs.disabled = !ready || !on;
    if (el.fbBtnPreview) el.fbBtnPreview.disabled = !ready;
    if (el.fbBtnSubmit) el.fbBtnSubmit.disabled = disabled;
    if (el.fbBtnEnable) el.fbBtnEnable.disabled = !ready;
    if (el.fbBtnRefreshHistory) {
      el.fbBtnRefreshHistory.disabled = !ready || !on || state.hub.feedbackLoading || !API.has('hub', 'listFeedback');
    }
    renderFeedbackHistory();
  }

  var FB_STATUS_TEXT = {
    open: '待处理',
    in_progress: '处理中',
    resolved: '已解决',
    archived: '已归档'
  };
  var FB_CATEGORY_TEXT = {
    bug: '问题反馈 / Bug',
    performance: '性能建议',
    ui: '界面与交互',
    feature: '新功能需求',
    other: '其他建议'
  };

  function renderFeedbackHistory() {
    if (!el.fbHistoryList) return;
    var box = el.fbHistoryList;
    box.textContent = '';
    var ready = hubBridgeReady() && API.has('hub', 'listFeedback');
    var on = !!state.settings.serverOptIn;
    if (!ready) {
      if (el.fbHistorySummary) el.fbHistorySummary.textContent = '当前环境未接入服务器反馈模块';
      box.appendChild(h('div', 'fb-history-empty', '当前环境不支持查看历史反馈。'));
      return;
    }
    if (!on) {
      if (el.fbHistorySummary) el.fbHistorySummary.textContent = '开启「连接作者服务器」后可实时追踪反馈进度与作者回复';
      box.appendChild(h('div', 'fb-history-empty', '未开启服务器连接：已遵守隐私承诺不拉取任何远程记录。'));
      return;
    }
    if (state.hub.feedbackLoading && !state.hub.feedbackLoaded) {
      box.appendChild(h('div', 'fb-history-empty', '正在加密拉取你的历史反馈与作者回复…'));
      return;
    }
    if (state.hub.feedbackError && !state.hub.feedbackItems.length) {
      box.appendChild(h('div', 'fb-history-empty', state.hub.feedbackError));
      return;
    }
    var items = Array.isArray(state.hub.feedbackItems) ? state.hub.feedbackItems : [];
    var repliedCount = items.filter(function (x) { return !!(x && x.hasAdminReply); }).length;
    if (el.fbHistorySummary) {
      el.fbHistorySummary.textContent = items.length
        ? ('共 ' + items.length + ' 条历史反馈' + (repliedCount ? (' · ' + repliedCount + ' 条已收到作者回复') : ' · 可随时刷新查看进度'))
        : '提交反馈后可在此实时追踪进度、查看作者回复并追加留言';
    }
    if (!items.length) {
      box.appendChild(h('div', 'fb-history-empty', '暂无反馈记录。提交一条新反馈后，这里会自动展示处理进度与作者回复。'));
      return;
    }
    items.forEach(function (item) {
      if (!item) return;
      var card = h('div', 'fb-thread-card');
      card.dataset.fbId = String(item.id);
      var statusKey = item.status || 'open';
      var statusLabel = FB_STATUS_TEXT[statusKey] || statusKey;
      var catLabel = FB_CATEGORY_TEXT[item.category] || item.category || '其他建议';

      var head = h('div', 'fb-thread-head');
      var badges = h('div', 'fb-thread-badges');
      badges.appendChild(h('span', 'fb-pill fb-pill-' + statusKey, statusLabel));
      badges.appendChild(h('span', 'fb-pill', catLabel));
      if (item.hasAdminReply) {
        badges.appendChild(h('span', 'fb-pill fb-pill-replied', '作者已回复'));
      }
      head.appendChild(badges);
      var metaText = '#' + item.id
        + (item.appVersion ? (' · v' + item.appVersion) : '')
        + (item.createdAt ? (' · ' + fmtTime(item.createdAt)) : '');
      head.appendChild(h('span', 'fb-thread-meta', metaText));
      card.appendChild(head);

      card.appendChild(h('div', 'fb-thread-origin', item.message || ''));

      var msgs = Array.isArray(item.messages) ? item.messages : [];
      if (msgs.length) {
        var chatLog = h('div', 'fb-chat-log');
        msgs.forEach(function (m) {
          var isAdmin = m && m.sender === 'admin';
          var bubble = h('div', 'fb-chat-msg' + (isAdmin ? ' fb-chat-msg-admin' : ''));
          var mHead = h('div', 'fb-chat-msg-head');
          mHead.appendChild(h('strong', null, isAdmin ? '作者回复' : '我（追加）'));
          if (m && m.createdAt) mHead.appendChild(h('span', null, fmtTime(m.createdAt)));
          bubble.appendChild(mHead);
          bubble.appendChild(h('div', 'fb-chat-msg-body', (m && m.message) || ''));
          chatLog.appendChild(bubble);
        });
        card.appendChild(chatLog);
      } else if (item.adminNote) {
        var noteLog = h('div', 'fb-chat-log');
        var noteBubble = h('div', 'fb-chat-msg fb-chat-msg-admin');
        var nHead = h('div', 'fb-chat-msg-head');
        nHead.appendChild(h('strong', null, '作者回复'));
        noteBubble.appendChild(nHead);
        noteBubble.appendChild(h('div', 'fb-chat-msg-body', item.adminNote));
        noteLog.appendChild(noteBubble);
        card.appendChild(noteLog);
      }

      if (statusKey !== 'archived' && API.has('hub', 'replyFeedback')) {
        var replyRow = h('div', 'fb-reply-row');
        var input = h('textarea', 'input fb-reply-input');
        input.rows = 1;
        input.maxLength = 2000;
        input.placeholder = '追加补充说明或回复作者（Ctrl/⌘+Enter 发送）…';
        var draftKey = String(item.id);
        if (feedbackReplyDrafts.has(draftKey)) input.value = feedbackReplyDrafts.get(draftKey);
        input.addEventListener('input', function () {
          if (input.value) feedbackReplyDrafts.set(draftKey, input.value);
          else feedbackReplyDrafts.delete(draftKey);
        });
        var btn = h('button', 'btn btn-sm btn-primary', '追加回复');
        btn.type = 'button';
        btn.disabled = state.hub.replyingId === item.id;
        var submitReply = function () {
          sendFeedbackReply(item.id, input.value, input, btn);
        };
        btn.addEventListener('click', submitReply);
        input.addEventListener('keydown', function (ev) {
          if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
            ev.preventDefault();
            submitReply();
          }
        });
        replyRow.appendChild(input);
        replyRow.appendChild(btn);
        card.appendChild(replyRow);
      }
      box.appendChild(card);
    });
  }

  var feedbackReplyDrafts = new Map();
  var FB_SEEN_REPLY_KEY = 'qdl_seen_admin_reply_id';

  function getLastSeenAdminReplyId() {
    try {
      var raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FB_SEEN_REPLY_KEY) : '';
      var n = parseInt(raw || '0', 10);
      return isFinite(n) && n > 0 ? n : 0;
    } catch (_) { return 0; }
  }

  function maxAdminReplyId(items) {
    var maxId = 0;
    (items || []).forEach(function (it) {
      var msgs = it && Array.isArray(it.messages) ? it.messages : [];
      msgs.forEach(function (m) {
        if (m && m.sender === 'admin') {
          var id = Number(m.id) || 0;
          if (id > maxId) maxId = id;
        }
      });
    });
    return maxId;
  }

  function updateFeedbackUnreadBadge(items, opts) {
    var o = opts || {};
    var list = Array.isArray(items) ? items : [];
    var latestAdminId = maxAdminReplyId(list);
    if (o.markRead || state.view === 'feedback') {
      if (latestAdminId > getLastSeenAdminReplyId()) {
        try { if (typeof localStorage !== 'undefined') localStorage.setItem(FB_SEEN_REPLY_KEY, String(latestAdminId)); } catch (_) {}
      }
      state.hub.unreadReplies = 0;
    } else {
      var seen = getLastSeenAdminReplyId();
      var unread = 0;
      list.forEach(function (it) {
        var msgs = it && Array.isArray(it.messages) ? it.messages : [];
        msgs.forEach(function (m) {
          if (m && m.sender === 'admin' && (Number(m.id) || 0) > seen) unread += 1;
        });
      });
      state.hub.unreadReplies = unread;
    }
    if (el.feedbackBadge) {
      el.feedbackBadge.hidden = state.hub.unreadReplies <= 0;
      if (state.hub.unreadReplies > 0) {
        el.feedbackBadge.textContent = String(state.hub.unreadReplies);
      }
    }
  }

  async function loadMyFeedback(opts) {
    var o = opts || {};
    if (!hubBridgeReady() || !state.settings.serverOptIn || !API.has('hub', 'listFeedback')) {
      renderFeedbackHistory();
      return;
    }
    if (state.hub.feedbackLoading) return;
    state.hub.feedbackLoading = true;
    state.hub.feedbackError = '';
    if (!o.background) renderFeedbackView();
    try {
      var res = await API.hub.listFeedback();
      state.hub.feedbackItems = (res && Array.isArray(res.items)) ? res.items : [];
      state.hub.feedbackLoaded = true;
      state.hub.feedbackError = '';
      updateFeedbackUnreadBadge(state.hub.feedbackItems, { markRead: state.view === 'feedback' });
      if (!o.silent) toast('ok', '已刷新反馈历史与最新回复');
    } catch (err) {
      var emsg = (err && err.message) ? err.message : '拉取反馈历史失败（海外服务器如连接不畅可开梯子重试）';
      state.hub.feedbackError = emsg;
      if (!o.silent) toast('warn', emsg);
    } finally {
      state.hub.feedbackLoading = false;
      if (!o.background || state.view === 'feedback') renderFeedbackView();
    }
  }

  async function sendFeedbackReply(feedbackId, rawText, inputEl, btnEl) {
    if (!hubBridgeReady() || !state.settings.serverOptIn || !API.has('hub', 'replyFeedback')) return;
    var text = String(rawText || '').trim();
    if (!text) {
      toast('warn', '请输入要追加的回复内容');
      if (inputEl) inputEl.focus();
      return;
    }
    if (state.hub.replyingId !== null) return;
    state.hub.replyingId = feedbackId;
    if (btnEl) btnEl.disabled = true;
    try {
      var res = await API.hub.replyFeedback({ feedbackId: feedbackId, message: text });
      feedbackReplyDrafts.delete(String(feedbackId));
      if (inputEl) inputEl.value = '';
      if (res && res.reply) {
        var target = state.hub.feedbackItems.filter(function (x) { return x && x.id === feedbackId; })[0];
        if (target) {
          if (!Array.isArray(target.messages)) target.messages = [];
          target.messages.push(res.reply);
          target.replyCount = target.messages.length;
          target.lastSender = 'user';
          if (res.updatedAt) target.updatedAt = res.updatedAt;
        }
      }
      toast('ok', '追加消息已加密送达作者控制台');
      state.hub.replyingId = null;
      renderFeedbackHistory();
      loadMyFeedback({ silent: true });
    } catch (err) {
      var emsg = (err && err.message) ? err.message : '追加消息发送失败';
      toast('warn', emsg);
      state.hub.replyingId = null;
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function setHubOptIn(wantOn, opts) {
    var o = opts || {};
    var on = !!wantOn;
    if (!hubBridgeReady()) {
      toast('warn', '当前环境未接入服务器模块');
      return false;
    }
    try {
      var cfg = await API.hub.setOptIn({ optIn: on });
      state.settings.serverOptIn = on;
      state.settings.serverPrompted = true;
      if (cfg && typeof cfg === 'object') state.hub.config = cfg;
      renderHubSettings();
      renderFeedbackView();
      if (!o.silent) {
        toast(on ? 'ok' : 'info', on
          ? '已开启作者服务器连接（端到端加密 · 仅传脱敏数据），非常感谢支持！'
          : '已关闭作者服务器连接：应用承诺绝不外传任何数据');
      }
      if (on && !o.skipProbe) {
        startHubPollLoop();
        checkHubUpdate({ silent: true });
        sendHubTelemetry('opt_in');
        loadMyFeedback({ silent: true, background: state.view !== 'feedback' });
      } else if (!on) {
        stopHubPollLoop();
        updateFeedbackUnreadBadge([], { markRead: true });
      }
      return true;
    } catch (err) {
      reportError(err, '更新连接设置失败');
      renderHubSettings();
      renderFeedbackView();
      return false;
    }
  }

  function renderHubUpdateResult(info) {
    if (!el.hubUpdatePanel) return;
    if (!info) { el.hubUpdatePanel.hidden = true; return; }
    el.hubUpdatePanel.hidden = false;
    if (el.hubUpdateTitle) {
      el.hubUpdateTitle.textContent = info.hasUpdate
        ? ('发现新版本 v' + info.latestVersion + '（当前 v' + info.currentVersion + '）')
        : ('已是最新版本 v' + info.currentVersion);
    }
    if (el.hubUpdateMeta) {
      var metaParts = [];
      if (info.releaseDate) metaParts.push(info.releaseDate);
      if (info.signatureVerified) metaParts.push('Ed25519 验签通过');
      if (info.serverRegion) metaParts.push(info.serverRegion);
      if (info.tuning && info.tuning.version > 0) metaParts.push('热配置 v' + info.tuning.version);
      if (info.hotUi && info.hotUi.activeVersion) metaParts.push('热更 UI ' + info.hotUi.activeVersion);
      el.hubUpdateMeta.textContent = metaParts.join(' · ');
    }
    if (el.hubUpdateNotice) {
      if (info.notice) {
        el.hubUpdateNotice.hidden = false;
        el.hubUpdateNotice.textContent = '作者公告：' + info.notice;
      } else {
        el.hubUpdateNotice.hidden = true;
        el.hubUpdateNotice.textContent = '';
      }
    }
    if (el.hubUpdateChangelog) {
      el.hubUpdateChangelog.textContent = info.changelog || '（暂无更新说明）';
    }
    var rec = info.recommendedAsset && info.recommendedAsset.filename ? info.recommendedAsset : null;
    var isAppImage = info.installType === 'appimage' || info.recommendedAssetKey === 'linux-x64-appimage';
    if (el.btnHubDownload) {
      el.btnHubDownload.hidden = !rec;
      el.btnHubDownload.disabled = state.hub.downloading;
      if (rec) {
        el.btnHubDownload.textContent = '直链下载 ' + rec.filename + (rec.size ? '（' + fmtBytes(rec.size) + '）' : '');
      }
    }
    if (el.hubUpdateFallbackHint) {
      if (!rec && info.hasUpdate) {
        el.hubUpdateFallbackHint.hidden = false;
        el.hubUpdateFallbackHint.textContent = isAppImage
          ? '当前运行的是 Linux AppImage 便携版（因打包了完整 WebKitGTK/GTK3 运行库约 80 MB，不走海外中转直链）。请点击下方按钮前往 GitHub Releases 下载最新 .AppImage 覆盖即可；如使用 Ubuntu/Debian，也可改用约 6 MB 的 .deb 安装包以获得应用内高速直链更新。'
          : '当前系统架构对应的安装包未托管在海外中转服务器，请点击下方按钮前往 GitHub Releases 页面下载完整安装包。';
      } else {
        el.hubUpdateFallbackHint.hidden = true;
        el.hubUpdateFallbackHint.textContent = '';
      }
    }
    if (el.btnHubGithub) {
      var showGithub = !!info.hasUpdate || (!rec && isAppImage);
      el.btnHubGithub.hidden = !showGithub;
      if (showGithub) {
        var primaryGithub = !rec;
        el.btnHubGithub.classList.toggle('btn-primary', primaryGithub);
        el.btnHubGithub.classList.toggle('btn-ghost', !primaryGithub);
        if (primaryGithub) {
          el.btnHubGithub.textContent = isAppImage
            ? '前往 GitHub Releases 下载 AppImage'
            : '前往 GitHub Releases 下载';
        } else {
          el.btnHubGithub.textContent = 'GitHub Releases 备用下载';
        }
      }
    }
    if (el.btnHubOpenPkg) {
      el.btnHubOpenPkg.hidden = !state.hub.downloadedPath;
      if (state.hub.downloadedPath) {
        el.btnHubOpenPkg.textContent = API.has('hub', 'installUpdate') ? '一键安装并升级' : '打开安装包';
      }
    }
    if (el.btnHubReveal) {
      el.btnHubReveal.hidden = !state.hub.downloadedPath;
    }
  }

  async function checkHubUpdate(opts) {
    var o = opts || {};
    if (!hubBridgeReady() || !state.settings.serverOptIn) {
      if (!o.silent) toast('info', '请先开启「作者服务器连接」后再检查更新');
      return null;
    }
    if (state.hub.checking) return null;
    state.hub.checking = true;
    state.hub.lastUpdateCheckAt = Date.now();
    renderHubSettings();
    if (!o.silent && el.hubUpdateSummary) el.hubUpdateSummary.textContent = '正在连接海外更新服务器并校验 Ed25519 数字签名…';
    try {
      var res = await API.hub.checkUpdate();
      state.hub.latest = res;
      if (res && res.tuning) applyRuntimeTuning(res.tuning);
      if (state.hub.downloadedPath && state.hub.downloadedVersion && res && res.latestVersion && String(res.latestVersion) !== String(state.hub.downloadedVersion)) {
        state.hub.downloadedPath = '';
        state.hub.downloadedVersion = '';
      }
      var hasRec = !!(res && res.recommendedAsset && res.recommendedAsset.filename);
      var isAppImagePkg = !!(res && (res.installType === 'appimage' || res.recommendedAssetKey === 'linux-x64-appimage'));
      if (el.hubUpdateSummary) {
        el.hubUpdateSummary.textContent = res.hasUpdate
          ? (hasRec
            ? ('发现新版本 v' + res.latestVersion + '，已通过 Ed25519 签名验证，可直链下载并一键升级。')
            : (isAppImagePkg
              ? ('发现新版本 v' + res.latestVersion + '（已验签）。Linux AppImage 便携版请前往 GitHub Releases 下载最新 .AppImage 覆盖升级。')
              : ('发现新版本 v' + res.latestVersion + '（已验签），请前往 GitHub Releases 下载对应系统安装包。')))
          : ('当前 v' + res.currentVersion + ' 已是最新版本（已通过 Ed25519 签名验证' + (res.tuningApplied ? ' · 已热更新引擎参数' : '') + '）。');
      }
      renderHubUpdateResult(res);
      // L2: 自动后台拉取并校验兼容的轻量前端热更新包（~100KB），就绪后提示一键秒切
      if (res && res.hasUiHotfix && res.uiHotfix && API.has('hub', 'applyUiHotfix') && !state.hub.applyingHotfix) {
        state.hub.applyingHotfix = true;
        API.hub.applyUiHotfix().then(function (hfRes) {
          if (hfRes && hfRes.applied && hfRes.needsReload) {
            var hfVer = String(hfRes.version || '');
            var hfNote = hfRes.changelog ? ('：' + String(hfRes.changelog).slice(0, 60)) : '';
            banner('hub-hot-ui', 'info', '已校验轻量界面热更新 ' + hfVer + hfNote + '（无需重装，1 秒刷新即可生效）。', [
              { label: '立即刷新生效', primary: true, onClick: function () {
                clearBanner('hub-hot-ui');
                if (API.has('hub', 'reloadUi')) {
                  API.hub.reloadUi().catch(function (e) { reportError(e, '应用界面热更新失败'); });
                } else {
                  location.reload();
                }
              } },
              { label: '下次启动生效', onClick: function () { clearBanner('hub-hot-ui'); } }
            ]);
          }
        }).catch(function () {
          // 静默失败，不影响主流程
        }).finally(function () {
          state.hub.applyingHotfix = false;
        });
      }
      if (res.hasUpdate) {
        var mustUpgrade = !!res.forceUpgrade;
        if (mustUpgrade || !o.silent || state.hub.dismissedUpdateVersion !== String(res.latestVersion || '')) {
          var bannerMsg = mustUpgrade
            ? ('【重要更新】当前版本 v' + res.currentVersion + ' 已停止旧版在线支持，强烈建议升级至 v' + res.latestVersion + (hasRec ? '（支持应用内一键升级）。' : '（请前往 GitHub Releases 下载最新安装包）。'))
            : (hasRec
              ? ('发现新版本 v' + res.latestVersion + '（当前 v' + res.currentVersion + '），可前往设置页直链下载。')
              : (isAppImagePkg
                ? ('发现新版本 v' + res.latestVersion + '（当前 v' + res.currentVersion + '），AppImage 版请前往 GitHub Releases 下载更新。')
                : ('发现新版本 v' + res.latestVersion + '（当前 v' + res.currentVersion + '），请前往设置页或 GitHub Releases 下载更新。')));
          var bannerBtns = [
            { label: mustUpgrade ? '立即前往升级' : (hasRec ? '查看更新' : '查看更新说明'), primary: hasRec || mustUpgrade, onClick: function () {
              if (!mustUpgrade) clearBanner('hub-update');
              setView('settings');
              if (el.hubCard && typeof el.hubCard.scrollIntoView === 'function') {
                el.hubCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            } }
          ];
          if (!hasRec && API.has('hub', 'openReleasePage')) {
            bannerBtns.unshift({
              label: isAppImagePkg ? '前往 GitHub 下载 AppImage' : '前往 GitHub 下载',
              primary: true,
              onClick: function () {
                if (!mustUpgrade) clearBanner('hub-update');
                API.hub.openReleasePage().catch(function (err) { reportError(err, '打开 GitHub 发布页失败'); });
              }
            });
          }
          if (!mustUpgrade) {
            bannerBtns.push({ label: '稍后再说', onClick: function () {
              state.hub.dismissedUpdateVersion = String(res.latestVersion || '');
              clearBanner('hub-update');
            } });
          }
          banner('hub-update', mustUpgrade ? 'warn' : 'info', bannerMsg, bannerBtns);
        }
      } else if (!o.silent) {
        toast('ok', '当前已是最新版本 v' + res.currentVersion);
      }
      // 独立实时顶部公告（支持网页管理台单独随时下发，不依赖发版）
      var liveBanner = (res && res.liveBanner && res.liveBanner.enabled && res.liveBanner.text)
        ? res.liveBanner
        : (res && res.notice ? { id: 'notice:' + String(res.notice).slice(0, 64), level: 'info', text: String(res.notice), dismissible: true } : null);
      if (liveBanner && liveBanner.text) {
        var bId = String(liveBanner.id || liveBanner.text).slice(0, 80);
        var dismissedB = '';
        try { dismissedB = localStorage.getItem('qk-dismissed-banner-id') || ''; } catch (_) {}
        if (liveBanner.dismissible === false || dismissedB !== bId) {
          var bActs = [];
          if (liveBanner.ctaLabel && typeof liveBanner.ctaUrl === 'string' && /^https:\/\//i.test(liveBanner.ctaUrl)) {
            bActs.push({
              label: String(liveBanner.ctaLabel).slice(0, 24),
              primary: true,
              onClick: function () {
                if (API.has('hub', 'openExternalUrl')) {
                  API.hub.openExternalUrl({ url: liveBanner.ctaUrl }).catch(function (e) { reportError(e, '打开链接失败'); });
                }
              }
            });
          }
          if (liveBanner.dismissible !== false) {
            bActs.push({
              label: '我知道了',
              onClick: function () {
                try { localStorage.setItem('qk-dismissed-banner-id', bId); } catch (_) {}
                clearBanner('hub-live-banner');
              }
            });
          }
          banner('hub-live-banner', liveBanner.level === 'error' ? 'error' : (liveBanner.level === 'warn' ? 'warn' : 'info'), '公告：' + String(liveBanner.text), bActs);
        }
      } else {
        clearBanner('hub-live-banner');
      }
      // 独立弹窗提示（网页管理台可单独发送或关闭；按 popup.id 去重避免反复打扰）
      if (res && res.popup && res.popup.enabled && (res.popup.title || res.popup.body)) {
        showServerAnnouncementPopup(res.popup);
      }
      return res;
    } catch (err) {
      if (!o.silent) {
        if (el.hubUpdateSummary) el.hubUpdateSummary.textContent = err && err.message ? err.message : '检查更新失败（海外服务器如连接不畅可尝试开梯子重试）';
        toast('warn', err && err.message ? err.message : '连接海外更新服务器失败，如有梯子可开启后重试');
      }
      return null;
    } finally {
      state.hub.checking = false;
      renderHubSettings();
    }
  }

  function handleHubUpdateProgress(prog) {
    if (!prog || !el.hubDlProgress) return;
    el.hubDlProgress.hidden = false;
    var pct = Math.max(0, Math.min(100, Number(prog.percent) || 0));
    if (el.hubDlFill) el.hubDlFill.style.width = pct + '%';
    if (el.hubDlLabel) {
      if (prog.phase === 'done') {
        el.hubDlLabel.textContent = '下载完成并已通过 SHA-256 完整性校验：' + (prog.filename || '');
      } else {
        var totalStr = prog.total > 0 ? (' / ' + fmtBytes(prog.total)) : '';
        el.hubDlLabel.textContent = '正在直链下载 ' + (prog.filename || '') + '：' + fmtBytes(prog.downloaded || 0) + totalStr + ' (' + pct + '%)';
      }
    }
  }

  async function downloadHubUpdate() {
    if (!hubBridgeReady() || !state.settings.serverOptIn || state.hub.downloading) return;
    var info = state.hub.latest;
    var assetKey = info && info.recommendedAssetKey ? info.recommendedAssetKey : undefined;
    state.hub.downloading = true;
    state.hub.downloadedPath = '';
    renderHubUpdateResult(info);
    if (el.hubDlProgress) el.hubDlProgress.hidden = false;
    if (el.hubDlFill) el.hubDlFill.style.width = '4%';
    if (el.hubDlLabel) el.hubDlLabel.textContent = '正在从作者服务器直链下载安装包…';
    try {
      var res = await API.hub.downloadUpdate({
        assetKey: assetKey,
        localDir: state.settings.downloadDir || undefined
      });
      state.hub.downloadedPath = res && res.path ? String(res.path) : '';
      state.hub.downloadedVersion = (res && res.version) ? String(res.version) : (info && info.latestVersion ? String(info.latestVersion) : '');
      toast('ok', '更新包已下载并通过 SHA-256 校验：' + (res.filename || ''));
      renderHubUpdateResult(info);
    } catch (err) {
      if (el.hubDlLabel) el.hubDlLabel.textContent = err && err.message ? err.message : '下载更新包失败';
      toast('warn', err && err.message ? err.message : '直链下载更新包失败');
    } finally {
      state.hub.downloading = false;
      renderHubUpdateResult(info);
    }
  }

  async function sendHubTelemetry(eventType) {
    if (!hubBridgeReady() || !state.settings.serverOptIn) return;
    try {
      var list = state.transfers || [];
      var dlSpeeds = [];
      var ulSpeeds = [];
      var dlTasks = 0;
      var ulTasks = 0;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.kind === 'upload') {
          ulTasks += 1;
          if (t.speed > 0) ulSpeeds.push(Number(t.speed));
        } else {
          dlTasks += 1;
          if (t.speed > 0) dlSpeeds.push(Number(t.speed));
        }
      }
      var avg = function (arr) { return arr.length ? Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length) : undefined; };
      var peak = function (arr) { return arr.length ? Math.round(Math.max.apply(null, arr)) : undefined; };
      var memMb;
      if (typeof performance !== 'undefined' && performance.memory && performance.memory.usedJSHeapSize) {
        memMb = Math.round(performance.memory.usedJSHeapSize / (1024 * 1024));
      }
      var screenBucket = '1080p';
      try {
        var sw = (window.screen && window.screen.width) || window.innerWidth || 0;
        if (sw >= 3200) screenBucket = '4k';
        else if (sw >= 2200) screenBucket = '2k';
        else if (sw > 0 && sw < 1400) screenBucket = '<=720p';
      } catch (_) {}
      await API.hub.sendTelemetry({
        eventType: eventType || 'heartbeat',
        avgDlBps: avg(dlSpeeds),
        peakDlBps: peak(dlSpeeds),
        avgUlBps: avg(ulSpeeds),
        peakUlBps: peak(ulSpeeds),
        dlTasks: dlTasks || undefined,
        ulTasks: ulTasks || undefined,
        memMb: memMb,
        appMetrics: {
          theme: state.settings.theme === 'dark' ? 'dark' : 'light',
          viewMode: state.settings.viewMode === 'grid' ? 'grid' : 'list',
          downloadStrategy: state.settings.downloadStrategy || 'auto',
          downloadParallel: Number(state.settings.downloadParallel) || 16,
          downloadConcurrency: Number(state.settings.downloadConcurrency) || 2,
          uploadPartConcurrency: Number(state.settings.uploadPartConcurrency) || 3,
          floatingBall: !!state.settings.floatingTransferBall,
          floatingUnarchive: !!state.settings.floatingUnarchiveWindow,
          aiBeta: !!state.settings.aiBetaEnabled,
          screenBucket: screenBucket
        }
      });
      state.hub.telemetrySent = true;
    } catch (_) {
      // 静默失败：海外服务器不可达绝不打扰用户
    }
  }

  async function openHubLogPreviewModal() {
    if (!hubBridgeReady()) return;
    var logs = [];
    try {
      var res = await API.hub.logPreview();
      logs = res && Array.isArray(res.logs) ? res.logs : [];
    } catch (_) { logs = []; }
    var text = logs.length ? JSON.stringify(logs, null, 2) : '（当前暂无运行日志记录）';
    await new Promise(function (resolve) {
      openOverlay(function (ui) {
        ui.setResolve(resolve);
        var head = h('div', 'dlg-head');
        head.appendChild(icon('shield', 'dlg-ic'));
        head.appendChild(h('h3', 'dlg-title', '脱敏运行日志预览'));
        ui.panel.appendChild(head);

        var body = h('div', 'dlg-body');
        body.appendChild(h('p', 'dlg-msg', '以下是将随反馈附带或上报的脱敏诊断日志预览（已剥离文件名、本地路径、Cookie、Token 与 IP）：'));
        body.appendChild(h('pre', 'log-preview-pre', text));
        ui.panel.appendChild(body);

        var foot = h('div', 'dlg-foot');
        var okBtn = h('button', 'btn btn-primary', '关闭预览');
        okBtn.type = 'button';
        okBtn.addEventListener('click', function () { ui.close(); });
        foot.appendChild(okBtn);
        ui.panel.appendChild(foot);
      });
    });
  }

  async function submitFeedbackForm() {
    if (!hubBridgeReady() || !state.settings.serverOptIn || state.hub.submittingFeedback) return;
    var msg = el.fbMessage ? el.fbMessage.value.trim() : '';
    if (msg.length < 2) {
      toast('warn', '请至少输入 2 个字的反馈内容');
      if (el.fbMessage) el.fbMessage.focus();
      return;
    }
    state.hub.submittingFeedback = true;
    renderFeedbackView();
    if (el.fbStatus) { el.fbStatus.textContent = '正在加密并发送到作者服务器…'; el.fbStatus.dataset.level = ''; }
    try {
      var res = await API.hub.submitFeedback({
        category: el.fbCategory ? el.fbCategory.value : 'other',
        message: msg,
        contact: el.fbContact ? el.fbContact.value.trim() : '',
        includeLogs: !!(el.fbIncludeLogs && el.fbIncludeLogs.checked)
      });
      if (el.fbMessage) el.fbMessage.value = '';
      var tip = '已加密送达作者控制台' + (res && res.id ? '（编号 #' + res.id + '）' : '') + '，可在下方随时查看进度与回复！';
      if (el.fbStatus) { el.fbStatus.textContent = tip; el.fbStatus.dataset.level = 'ok'; }
      toast('ok', tip);
      loadMyFeedback({ silent: true });
    } catch (err) {
      var emsg = err && err.message ? err.message : '发送反馈失败（海外服务器如连接不畅可尝试开梯子）';
      if (el.fbStatus) { el.fbStatus.textContent = emsg; el.fbStatus.dataset.level = 'error'; }
      toast('warn', emsg);
    } finally {
      state.hub.submittingFeedback = false;
      renderFeedbackView();
    }
  }

  var TUTORIAL_STEPS = [
    {
      icon: 'folder',
      title: '欢迎使用夸克网盘极简版',
      showVersion: true,
      sub: '基于 Tauri 2 + Rust 原生打造，轻巧流畅、零广告干扰，30 秒即可轻松上手。',
      points: [
        { icon: 'arrow-up', title: '深层目录高效导航', desc: '支持后退 / 前进 / 上一级按钮、深层面包屑「···」下拉一键跳级，以及鼠标滚轮与 Alt+↑ / Backspace 快捷键。' },
        { icon: 'info', title: '文件夹真实大小自动统计', desc: '进入任意目录即自动在主列表回填文件夹真实大小，无需逐个点开；支持多选合计与列表 / 网格双视图切换。' },
        { icon: 'search', title: '快筛、搜索与键盘流', desc: '按文件夹 / 图片 / 视频 / 文档 / 音频 / 压缩包一键筛选；Ctrl/⌘+F 快速搜索，F2 重命名，支持拖拽直接上传。' }
      ]
    },
    {
      icon: 'transfer',
      title: '自研高速并发传输与整目录下载',
      sub: 'Rust 事件驱动并发引擎，空闲零轮询，大文件断点续传与校验一步到位。',
      points: [
        { icon: 'download', title: '支持整个文件夹递归批量下载', desc: '可直接下载单个或多个文件夹（及混合选中），自动保留嵌套子目录结构；也支持每次询问或按项指定下载位置。' },
        { icon: 'upload', title: '不设死的并发调节', desc: '可在设置中自由调整上传/下载并发数与分片连接数，超出推荐阈值时自动提醒，兼顾极速与稳定。' },
        { icon: 'refresh', title: '实时传输胶囊与自动刷新', desc: '活跃传输时子工具栏常驻速度与进度胶囊；上传/删除文件夹后即时响应并自动同步目录与剩余空间。' }
      ]
    },
    {
      icon: 'file-archive',
      title: '五大极简实用云工具',
      sub: '把高频刚需云工具收纳得恰到好处，保持极简清爽不臃肿。',
      points: [
        { icon: 'file-archive', title: '压缩包云解压与在线浏览', desc: '在 zip / rar / 7z 等压缩包上点击云解压，支持包内目录钻取、密码解锁、勾选部分解压、同名覆盖与实时进度。' },
        { icon: 'history', title: '增强文件详情与历史版本', desc: '打开右侧详情抽屉查看云端路径、媒体时长/帧率、来源与一键复制 MD5/SHA-1，并支持展开恢复历史版本。' },
        { icon: 'trash', title: '空间占用明细与轻量回收站', desc: '点击左下角「剩余可用空间」卡片查看分类占用占比；左侧「回收站」支持还原、彻底删除或一键清空释放空间。' }
      ]
    },
    {
      icon: 'shield',
      title: '隐私安全承诺与可选在线更新',
      sub: '你的网盘数据与登录凭据始终由你自己掌控。',
      points: [
        { icon: 'lock', title: '凭据本地加密 · 零外泄', desc: '扫码登录在独立原生窗口完成，Cookie 经 AES-256-GCM 加密存放在本机资料目录，所有网盘请求直连夸克官方接口。' },
        { icon: 'cloud', title: '自动更新检测与双向意见反馈', desc: '可选开启作者服务器连接：启动及运行期间自动静默检测新版本与作者回复提醒，支持直链验签下载和反馈历史追问；关闭则严格零外传。' },
        { icon: 'settings', title: '随时可重看本教程', desc: '之后可随时前往「设置 → 版本与运行环境 → 查看使用教程」再次打开，祝你使用愉快！' }
      ]
    }
  ];

  function showOnboardingTutorial(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      var step = 0;
      var markDone = function (result) {
        if (settled) return;
        settled = true;
        if (!state.settings.tutorialSeen && API.injected && API.has('settings', 'set')) {
          state.settings.tutorialSeen = true;
          API.settings.set({ tutorialSeen: true }).catch(function () { /* 静默 */ });
        } else {
          state.settings.tutorialSeen = true;
        }
        resolve(result);
      };
      openOverlay(function (ui) {
        ui.setResolve(function (val) { markDone(val || 'skipped'); });
        ui.panel.classList.add('dlg-tutorial');

        var head = h('div', 'tut-head');
        var badge = h('span', 'tut-badge');
        badge.appendChild(icon('cloud'));
        badge.appendChild(h('span', null, '新手使用教程'));
        var counter = h('span', 'tut-step-counter', '1 / ' + TUTORIAL_STEPS.length);
        head.appendChild(badge);
        head.appendChild(counter);
        ui.panel.appendChild(head);

        var body = h('div', 'tut-body');
        var hero = h('div', 'tut-hero');
        var heroIc = h('div', 'tut-hero-ic');
        var heroText = h('div', 'tut-hero-text');
        var titleEl = h('h3', 'tut-title', '');
        var subEl = h('p', 'tut-sub', '');
        heroText.appendChild(titleEl);
        heroText.appendChild(subEl);
        hero.appendChild(heroIc);
        hero.appendChild(heroText);
        body.appendChild(hero);

        var pointsBox = h('div', 'tut-points');
        body.appendChild(pointsBox);

        var dotsBox = h('div', 'tut-dots');
        TUTORIAL_STEPS.forEach(function (_, idx) {
          var dot = h('button', 'tut-dot');
          dot.type = 'button';
          dot.setAttribute('aria-label', '第 ' + (idx + 1) + ' 步');
          dot.addEventListener('click', function () {
            step = idx;
            paint();
          });
          dotsBox.appendChild(dot);
        });
        body.appendChild(dotsBox);
        ui.panel.appendChild(body);

        var foot = h('div', 'tut-foot');
        var skipBtn = h('button', 'btn btn-ghost', '全部跳过');
        skipBtn.type = 'button';
        skipBtn.id = 'tut-btn-skip';
        skipBtn.addEventListener('click', function () { ui.close('skipped'); });
        foot.appendChild(skipBtn);

        var right = h('div', 'tut-foot-right');
        var prevBtn = h('button', 'btn', '上一步');
        prevBtn.type = 'button';
        prevBtn.id = 'tut-btn-prev';
        prevBtn.addEventListener('click', function () {
          if (step > 0) { step -= 1; paint(); }
        });
        var nextBtn = h('button', 'btn btn-primary', '下一步');
        nextBtn.type = 'button';
        nextBtn.id = 'tut-btn-next';
        nextBtn.dataset.autofocus = '1';
        nextBtn.addEventListener('click', function () {
          if (step < TUTORIAL_STEPS.length - 1) {
            step += 1;
            paint();
          } else {
            ui.close('completed');
          }
        });
        right.appendChild(prevBtn);
        right.appendChild(nextBtn);
        foot.appendChild(right);
        ui.panel.appendChild(foot);

        function paint() {
          var s = TUTORIAL_STEPS[step];
          counter.textContent = (step + 1) + ' / ' + TUTORIAL_STEPS.length;
          heroIc.textContent = '';
          heroIc.appendChild(icon(s.icon));
          var ver = (state.appInfo && state.appInfo.version) ? state.appInfo.version : '1.3.1';
          titleEl.textContent = s.showVersion ? (s.title + ' v' + ver) : s.title;
          subEl.textContent = s.sub;
          pointsBox.textContent = '';
          s.points.forEach(function (pt) {
            var card = h('div', 'tut-point');
            card.appendChild(icon(pt.icon));
            var t = h('div', 'tut-point-text');
            t.appendChild(h('div', 'tut-point-title', pt.title));
            t.appendChild(h('div', 'tut-point-desc', pt.desc));
            card.appendChild(t);
            pointsBox.appendChild(card);
          });
          Array.prototype.forEach.call(dotsBox.children, function (d, i) {
            d.classList.toggle('active', i === step);
          });
          prevBtn.hidden = step === 0;
          var isLast = step === TUTORIAL_STEPS.length - 1;
          nextBtn.textContent = isLast ? (o.manual ? '知道了' : '开始使用') : '下一步';
          skipBtn.hidden = isLast;
        }
        paint();
      });
    });
  }

  function showServerAnnouncementPopup(popup) {
    if (!popup || !popup.enabled) return;
    var pid = String(popup.id || popup.updatedAt || popup.title || 'popup').slice(0, 80);
    var dismissed = '';
    try { dismissed = localStorage.getItem('qk-dismissed-popup-id') || ''; } catch (_) {}
    if (popup.dismissible !== false && dismissed === pid) return;
    if (state.hub.shownPopupId === pid) return;
    state.hub.shownPopupId = pid;
    if (hasActiveOverlay()) return;
    openOverlay(function (ui) {
      var level = popup.level === 'error' ? 'error' : (popup.level === 'warn' ? 'warn' : 'info');
      var head = h('div', 'dlg-head');
      head.appendChild(icon(level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'info'), 'dlg-ic'));
      head.appendChild(h('h3', 'dlg-title', String(popup.title || '重要通知')));
      ui.panel.appendChild(head);

      var body = h('div', 'dlg-body');
      var badge = h('div', 'announce-popup-badge ' + level, level === 'error' ? '重要提醒' : (level === 'warn' ? '升级 / 维护提醒' : '官方通知'));
      body.appendChild(badge);
      body.appendChild(h('div', 'announce-popup-body', String(popup.body || '')));
      ui.panel.appendChild(body);

      var foot = h('div', 'dlg-foot');
      if (popup.ctaLabel && typeof popup.ctaUrl === 'string' && /^https:\/\//i.test(popup.ctaUrl)) {
        var ctaBtn = h('button', 'btn btn-primary', String(popup.ctaLabel).slice(0, 28));
        ctaBtn.type = 'button';
        ctaBtn.addEventListener('click', function () {
          if (popup.dismissible !== false) {
            try { localStorage.setItem('qk-dismissed-popup-id', pid); } catch (_) {}
          }
          if (API.has('hub', 'openExternalUrl')) {
            API.hub.openExternalUrl({ url: popup.ctaUrl }).catch(function (e) { reportError(e, '打开链接失败'); });
          }
          ui.close(true);
        });
        foot.appendChild(ctaBtn);
      }
      var okBtn = h('button', popup.ctaLabel ? 'btn' : 'btn btn-primary', '我知道了');
      okBtn.type = 'button';
      okBtn.addEventListener('click', function () {
        if (popup.dismissible !== false) {
          try { localStorage.setItem('qk-dismissed-popup-id', pid); } catch (_) {}
        }
        ui.close(false);
      });
      foot.appendChild(okBtn);
      ui.panel.appendChild(foot);
    });
  }

  function showServerOptInModal() {
    return new Promise(function (resolve) {
      var settled = false;
      var commit = function (choice) {
        if (settled) return;
        settled = true;
        setHubOptIn(choice).then(function () { resolve(choice); });
      };
      openOverlay(function (ui) {
        ui.setResolve(function (val) {
          commit(val === true);
        });
        var head = h('div', 'dlg-head');
        head.appendChild(icon('shield', 'dlg-ic'));
        head.appendChild(h('h3', 'dlg-title', '可选：连接作者服务器（更新与反馈）'));
        ui.panel.appendChild(head);

        var body = h('div', 'dlg-body');
        body.appendChild(h('p', 'dlg-msg', '是否开启可选的「连接作者服务器」功能？本功能完全自愿，可随时在设置中开启或关闭。'));

        var ul = h('ul', 'optin-list');
        ul.appendChild(h('li', null, '不开启承诺：选择「暂不开启」后，客户端底层严格拦截，绝对不会向作者服务器发送任何请求或数据。'));
        ul.appendChild(h('li', null, '开启后作用：① 接收作者最新更新日志、公告通知并直链下载经签名与 SHA-256 校验的安装包；② 在侧边栏「反馈」直接向作者反馈问题（可自选是否附带脱敏日志）。'));
        ul.appendChild(h('li', null, '脱敏与安全保障：仅可能上传经严格脱敏的非敏感普通数据（版本、错误码、下载/上传速度与性能摘要），绝不包含文件名、路径、Cookie、账号或任何隐私，全程 X25519 + AES-256-GCM 端到端加密，安全无泄露，能帮助作者更好改进应用，非常感谢！'));
        body.appendChild(ul);

        var note = h('div', 'optin-callout');
        note.appendChild(h('strong', null, '海外服务器提示：'));
        note.appendChild(document.createTextNode('该服务器位于海外节点（日本东京），国内直连可能出现连接失败或卡顿；如果您有梯子/代理开启后一般即可顺畅连接，没有也没关系，完全不影响网盘本地核心使用。'));
        body.appendChild(note);
        ui.panel.appendChild(body);

        var foot = h('div', 'dlg-foot');
        var declineBtn = h('button', 'btn', '暂不开启（零外传）');
        declineBtn.type = 'button';
        declineBtn.id = 'optin-btn-decline';
        declineBtn.addEventListener('click', function () { ui.close(false); });
        var acceptBtn = h('button', 'btn btn-primary', '开启连接（支持更新与反馈）');
        acceptBtn.type = 'button';
        acceptBtn.id = 'optin-btn-accept';
        acceptBtn.addEventListener('click', function () { ui.close(true); });
        foot.appendChild(declineBtn);
        foot.appendChild(acceptBtn);
        ui.panel.appendChild(foot);
      });
    });
  }

  async function initHubOnBoot() {
    if (!hubBridgeReady()) {
      renderHubSettings();
      renderFeedbackView();
      return;
    }
    try {
      var cfg = await API.hub.config();
      if (cfg && typeof cfg === 'object') {
        state.hub.config = cfg;
        state.settings.serverOptIn = cfg.optIn === true;
        state.settings.serverPrompted = cfg.prompted === true;
      }
    } catch (_) { /* 静默 */ }
    renderHubSettings();
    renderFeedbackView();

    if (!hubAvailable()) {
      renderHubSettings();
      renderFeedbackView();
      return;
    }
    if (!API.isMock && !state.settings.serverPrompted) {
      await showServerOptInModal();
      return;
    }
    // 严格遵守：仅当用户已显式开启 serverOptIn 时才在后台检查更新、同步作者回复与上报脱敏心跳
    if (state.settings.serverOptIn) {
      startHubPollLoop();
      checkHubUpdate({ silent: true });
      loadMyFeedback({ silent: true, background: true });
      setTimeout(function () {
        if (state.settings.serverOptIn && !state.hub.telemetrySent) {
          sendHubTelemetry('startup');
        }
      }, 4500);
    }
  }

    function fmtInt(n) {
    var v = Number(n);
    if (!isFinite(v)) return '0';
    return v.toLocaleString('zh-CN');
  }

  function fmtBytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    // 去掉无意义的 ".0"（2.0 KB → 2 KB），保留非整形的 1 位小数
    var s = i === 0 ? String(v) : (Number.isInteger(v) ? String(v) : v.toFixed(1));
    return s + ' ' + units[i];
  }

  function setView(view) {
    if (view === 'chat' && !state.settings.aiBetaEnabled) {
      toast('info', 'AI 对话为 Beta 测试功能，请先在「设置 → AI 实验室」手动开启');
      view = 'settings';
    }
    state.view = view;
    Array.prototype.forEach.call(el.nav.querySelectorAll('.nav-item'), function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    el.viewFiles.hidden = view !== 'files';
    if (el.viewRecycle) el.viewRecycle.hidden = view !== 'recycle';
    el.viewTransfers.hidden = view !== 'transfers';
    el.viewSettings.hidden = view !== 'settings';
    if (el.viewChat) el.viewChat.hidden = view !== 'chat';
    if (el.viewFeedback) el.viewFeedback.hidden = view !== 'feedback';
    closeCrumbMenu();
    setTopbarForView();
    if (view === 'files') {
      refreshCachedRowHeight();
      if (el.crumbs) {
        el.crumbs.scrollLeft = el.crumbs.scrollWidth;
        updateCrumbScrollBtns();
      }
      scheduleRows();
      if (pendingFilesRefresh) silentRefreshFiles();
    }
    if (view === 'recycle') {
      loadRecycle({ reset: true });
    }
    if (view === 'transfers') {
      renderTransfers(true);
      refreshTransfers();
    }
    if (view === 'chat') ensureChat();
    if (view === 'feedback') {
      updateFeedbackUnreadBadge(state.hub.feedbackItems, { markRead: true });
      renderFeedbackView();
      if (state.settings.serverOptIn) loadMyFeedback({ silent: true });
    }
    if (view === 'settings') {
      renderSettings();
      if (state.settings.aiBetaEnabled) {
        ensureAgent();
        loadAgentStatus();
      }
    }
  }

  /* ================================================================== *
   * 拖拽上传（兼容 DOM 拖拽与 Tauri 2 原生拖放事件）
   * ================================================================== */

  function showDropMask() {
    if (!el.dropmask || state.view !== 'files' || hasActiveOverlay()) return;
    el.dropmask.hidden = false;
    el.dropSub.textContent = state.mode === 'search'
      ? '搜索模式下请先返回浏览目录再拖拽上传'
      : ('文件将上传到「' + currentDirName() + '」');
  }

  function setupDragDrop() {
    var depth = 0;

    function hasFiles(e) {
      var dt = e.dataTransfer;
      if (!dt) return false;
      if (dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0) return true;
      return !!(dt.files && dt.files.length);
    }

    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      showDropMask();
    });

    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) el.dropmask.hidden = true;
    });

    window.addEventListener('drop', async function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      el.dropmask.hidden = true;
      if (API.has('dialog', 'onFilesDropped')) return; // Tauri delivers native paths separately.
      var files = Array.prototype.slice.call(e.dataTransfer.files || []);
      if (!files.length) return;
      if (state.view !== 'files') {
        toast('warn', '请先切换到「全部文件」再拖拽上传');
        setView('files');
        return;
      }
      await handleDroppedFiles(files);
    });
  }

  async function handleDroppedFiles(files) {
    if (!API.injected) { toast('warn', '未注入桥接层，无法上传文件'); return; }
    if (!API.has('dialog', 'getPathForFile')) {
      toast('warn', '当前桥接层未提供文件路径读取能力，拖拽上传不可用，请使用「上传」按钮选择文件。', 7000);
      return;
    }
    var paths = [];
    var failed = [];
    files.forEach(function (f) {
      var p = API.dialog.getPathForFile(f);
      if (p) paths.push(p); else failed.push(f.name);
    });
    if (!paths.length) {
      toast('warn', '无法获取拖入文件的真实路径，拖拽上传不可用，请使用「上传」按钮选择文件。', 7000);
      return;
    }
    if (failed.length) {
      toast('warn', failed.length + ' 个文件无法获取真实路径，已跳过；请使用「上传」按钮补充上传。', 6000);
    }
    await doUploadPaths(paths);
  }

  /* ================================================================== *
   * 事件绑定
   * ================================================================== */

  function moveKeyboardFocus(nextIndex, extend) {
    var items = displayItems();
    if (!items.length) return;
    var idx = Math.max(0, Math.min(items.length - 1, nextIndex));
    var item = items[idx];
    state.focusIndex = idx;
    if (extend && state.lastIndex >= 0) {
      var a = Math.min(state.lastIndex, idx);
      var b = Math.max(state.lastIndex, idx);
      state.selected.clear();
      for (var i = a; i <= b; i++) state.selected.add(String(items[i].fid));
    } else {
      state.selected.clear();
      state.selected.add(String(item.fid));
      state.lastIndex = idx;
    }
    if (state.viewMode === 'list' && el.listwrap) {
      var rowTop = idx * cachedRowHeight;
      var rowBottom = rowTop + cachedRowHeight;
      var viewTop = el.listwrap.scrollTop;
      var viewH = el.listwrap.clientHeight || 600;
      if (rowTop < viewTop) el.listwrap.scrollTop = rowTop;
      else if (rowBottom > viewTop + viewH) el.listwrap.scrollTop = Math.max(0, rowBottom - viewH);
    }
    listVersion += 1;
    renderRows(listSeq, true);
    updateSelectAll();
  }

  function bindEvents() {
    // 导航
    el.nav.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.nav-item') : null;
      if (btn) setView(btn.dataset.view);
    });
    if (el.sidebarTransferMini) {
      el.sidebarTransferMini.addEventListener('click', function () { setView('transfers'); });
    }
    if (el.subbarTransferLive) {
      el.subbarTransferLive.addEventListener('click', function () { setView('transfers'); });
    }
    if (el.sidebarQuota) {
      var openQuotaBreakdown = function () {
        if (!API.injected || needsLoginState()) return;
        openStorageDetailModal();
      };
      el.sidebarQuota.addEventListener('click', openQuotaBreakdown);
      el.sidebarQuota.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuotaBreakdown(); }
      });
    }

    // 回收站工具栏与全选
    if (el.btnRecycleRefresh) {
      el.btnRecycleRefresh.addEventListener('click', function () { loadRecycle({ reset: true }); });
    }
    if (el.btnRecycleRecover) {
      el.btnRecycleRecover.addEventListener('click', function () {
        var picked = (state.recycle.items || []).filter(function (x) {
          return state.recycle.selected.has(String(x.recordId || x.fid));
        });
        if (picked.length) doRecycleRecover(picked);
      });
    }
    if (el.btnRecycleRemove) {
      el.btnRecycleRemove.addEventListener('click', function () {
        var picked = (state.recycle.items || []).filter(function (x) {
          return state.recycle.selected.has(String(x.recordId || x.fid));
        });
        if (picked.length) doRecycleRemove(picked);
      });
    }
    if (el.btnRecycleClear) {
      el.btnRecycleClear.addEventListener('click', doRecycleClearAll);
    }
    if (el.recycleCheckAll) {
      el.recycleCheckAll.addEventListener('change', function () {
        state.recycle.selected.clear();
        if (el.recycleCheckAll.checked) {
          (state.recycle.items || []).forEach(function (x) {
            state.recycle.selected.add(String(x.recordId || x.fid));
          });
        }
        renderRecycle();
      });
    }

    // 面包屑鼠标滚轮横向滚动 + 左右滚动按钮（兼顾 Windows 鼠标与 Mac 触控板）
    if (el.crumbs) {
      el.crumbs.addEventListener('wheel', function (e) {
        if (el.crumbs.scrollWidth <= el.crumbs.clientWidth + 2) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          el.crumbs.scrollLeft += e.deltaY;
          updateCrumbScrollBtns();
        }
      }, { passive: false });
      el.crumbs.addEventListener('scroll', updateCrumbScrollBtns, { passive: true });
      if (typeof ResizeObserver === 'function') {
        var crumbRaf = 0;
        var crumbResizeObserver = new ResizeObserver(function () {
          if (crumbRaf) return;
          crumbRaf = requestAnimationFrame(function () {
            crumbRaf = 0;
            updateCrumbScrollBtns();
          });
        });
        crumbResizeObserver.observe(el.crumbs);
        unsubs.push(function () {
          if (crumbRaf) cancelAnimationFrame(crumbRaf);
          crumbResizeObserver.disconnect();
        });
      }
    }
    if (el.btnCrumbsPrev) {
      el.btnCrumbsPrev.addEventListener('click', function () {
        if (!el.crumbs) return;
        el.crumbs.scrollLeft = Math.max(0, el.crumbs.scrollLeft - 160);
        updateCrumbScrollBtns();
      });
    }
    if (el.btnCrumbsNext) {
      el.btnCrumbsNext.addEventListener('click', function () {
        if (!el.crumbs) return;
        el.crumbs.scrollLeft = Math.min(el.crumbs.scrollWidth, el.crumbs.scrollLeft + 160);
        updateCrumbScrollBtns();
      });
    }

    // 顶栏导航与搜索
    if (el.btnBack) el.btnBack.addEventListener('click', goBack);
    if (el.btnForward) el.btnForward.addEventListener('click', goForward);
    el.btnUp.addEventListener('click', goUp);
    el.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        runSearch(el.searchInput.value.trim());
      } else if (e.key === 'Escape') {
        el.searchInput.value = '';
        el.searchClear.hidden = true;
        if (el.searchKbd) el.searchKbd.hidden = false;
        leaveSearch();
      }
    });
    el.searchInput.addEventListener('input', function () {
      var hasVal = !!el.searchInput.value;
      el.searchClear.hidden = !hasVal;
      if (el.searchKbd) el.searchKbd.hidden = hasVal;
    });
    el.searchClear.addEventListener('click', function () {
      el.searchInput.value = '';
      el.searchClear.hidden = true;
      if (el.searchKbd) el.searchKbd.hidden = false;
      leaveSearch();
      el.searchInput.focus();
    });

    // 顶部按钮
    el.btnUpload.addEventListener('click', onUploadClick);
    el.btnMkdir.addEventListener('click', onMkdirClick);
    el.btnRefresh.addEventListener('click', function () {
      if (state.mode === 'search') runSearch(state.keyword, { fromHistory: true }); else reloadCurrent();
      silentRefreshAccountAndQuota({ force: true, withAccount: true });
    });

    // 文件管理增强栏（分类筛选 / 排序 / 列表网格切换 / 详情侧栏）
    if (el.filterPills) {
      el.filterPills.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.pill') : null;
        if (b && b.dataset.filter) setFilter(b.dataset.filter);
      });
    }
    if (el.sortSelect) {
      el.sortSelect.addEventListener('change', function () { setSortBy(el.sortSelect.value, true); });
    }
    if (el.listhead) {
      el.listhead.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.sort-btn') : null;
        if (b && b.dataset.sortCol) toggleSortColumn(b.dataset.sortCol);
      });
    }
    if (el.viewModeSeg) {
      el.viewModeSeg.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.seg') : null;
        if (b && b.dataset.mode) applyViewMode(b.dataset.mode, true);
      });
    }
    if (el.btnInspector) {
      el.btnInspector.addEventListener('click', function () { setInspectorOpen(!state.inspectorOpen); });
    }
    if (el.btnInspectorClose) {
      el.btnInspectorClose.addEventListener('click', function () { setInspectorOpen(false); });
    }

    // 列表滚动：虚拟化 + 无限加载
    el.listwrap.addEventListener('scroll', function () {
      if (state.view !== 'files') return;
      scheduleRows();
      if (state.loading || !state.hasMore) return;
      if (el.listwrap.scrollTop + el.listwrap.clientHeight >= el.listwrap.scrollHeight - 240) {
        loadPage({});
      }
    }, { passive: true });
    window.addEventListener('resize', function () {
      refreshCachedRowHeight();
      scheduleRows();
    });
    if (typeof ResizeObserver === 'function') {
      var listResizeRaf = 0;
      var listResizeObserver = new ResizeObserver(function () {
        if (listResizeRaf) return;
        listResizeRaf = requestAnimationFrame(function () {
          listResizeRaf = 0;
          refreshCachedRowHeight();
          scheduleRows();
        });
      });
      listResizeObserver.observe(el.listwrap);
      unsubs.push(function () {
        if (listResizeRaf) cancelAnimationFrame(listResizeRaf);
        listResizeObserver.disconnect();
      });
    }

    // 列表交互（O(1) 索引查找 + 整行单击选中 + 复选框增量多选）
    el.list.addEventListener('click', function (e) {
      var t = e.target;
      var row = t.closest ? t.closest('.row') : null;
      if (!row) return;
      var fid = row.dataset.fid;
      var items = displayItems();
      var idx = Number(row.dataset.index);
      if (!isFinite(idx) || !items[idx] || String(items[idx].fid) !== String(fid)) {
        idx = items.findIndex(function (i) { return String(i.fid) === String(fid); });
      }
      if (idx < 0) return;
      state.focusIndex = idx;

      if (t.closest('.cb')) {
        if (t.type !== 'checkbox') return;
        toggleSelect(fid, idx, e);
        return;
      }
      var opBtn = t.closest('.op');
      if (opBtn) {
        e.stopPropagation();
        runRowOp(opBtn.dataset.op, items[idx]);
        return;
      }
      // 单击行任意位置选中（保留 Ctrl/Cmd/Shift 多选）；双击由 dblclick 处理进入/下载
      if (e.detail <= 1) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          toggleSelect(fid, idx, e);
        } else {
          var alreadySole = state.selected.size === 1 && state.selected.has(String(fid));
          state.lastIndex = idx;
          state.inspectorFid = String(fid);
          if (!alreadySole) {
            var wasEmpty = state.selected.size === 0;
            clearSelection();
            if (wasEmpty) deferBulkDockOnce = true;
            setSelected(fid, true);
          } else if (state.inspectorOpen) {
            renderInspector();
          }
        }
      }
    });

    // 点击文件列表空白区域取消选中（与 Finder / 资源管理器一致）
    el.listwrap.addEventListener('click', function (e) {
      if (!state.selected.size) return;
      var t = e.target;
      if (t.closest && (t.closest('.row') || t.closest('button') || t.closest('.listfoot') || t.closest('.empty'))) return;
      clearSelection();
    });

    el.list.addEventListener('dblclick', function (e) {
      var row = e.target.closest ? e.target.closest('.row') : null;
      if (!row) return;
      if (e.target.closest('.op') || e.target.closest('.cb')) return;
      var item = findItem(row.dataset.fid);
      if (item) openItem(item);
    });

    // 右键菜单（支持文件行多选上下文 + 列表空白区域上下文）
    el.listwrap.addEventListener('contextmenu', function (e) {
      var row = e.target.closest ? e.target.closest('.row') : null;
      e.preventDefault();
      if (!row) {
        var bgEntries = [];
        if (state.mode === 'search') {
          bgEntries.push({ label: '返回目录', icon: 'arrow-up', run: leaveSearch });
        } else if (state.fid !== ROOT_FID) {
          bgEntries.push({ label: '返回上一级', icon: 'arrow-up', run: goUp });
        }
        bgEntries.push({ label: '刷新当前目录', icon: 'refresh', run: reloadCurrent });
        if (state.mode === 'browse') {
          bgEntries.push({ sep: true });
          bgEntries.push({ label: '新建文件夹', icon: 'folder-plus', run: onMkdirClick });
          bgEntries.push({ label: '上传文件…', icon: 'upload', run: onUploadClick });
        }
        if (displayItems().length) {
          bgEntries.push({ sep: true });
          bgEntries.push({ label: '全选', icon: 'check', run: function () {
            el.checkAll.checked = true;
            el.checkAll.dispatchEvent(new Event('change'));
          } });
        }
        openCtx(e.clientX, e.clientY, bgEntries);
        return;
      }
      var item = findItem(row.dataset.fid);
      if (!item) return;
      if (!state.selected.has(String(item.fid))) {
        clearSelection();
        setSelected(item.fid, true);
      }
      var sel = selectedItems();
      var multi = sel.length > 1;
      var hasDirInSel = sel.some(function (x) { return !!x.dir; });
      var entries = [];
      if (!multi && item.dir) entries.push({ label: '打开', icon: 'folder-open', run: function () { openItem(item); } });
      if (!multi && isArchiveItem(item) && API.has('archive', 'preview')) {
        entries.push({ label: '云解压 / 浏览内容…', icon: 'file-archive', run: function () { openArchiveModal(item); } });
      }
      if (sel.length) {
        var dlLabel = multi
          ? ('下载选中的 ' + sel.length + (hasDirInSel ? ' 项（含文件夹）' : ' 个文件'))
          : (item.dir ? '下载文件夹' : '下载');
        var dlPickLabel = multi
          ? ('下载选中的 ' + sel.length + (hasDirInSel ? ' 项到指定位置…' : ' 个文件到指定位置…'))
          : (item.dir ? '下载文件夹到指定位置…' : '下载到指定位置…');
        entries.push({
          label: dlLabel,
          icon: 'download',
          run: function () { downloadItems(sel); }
        });
        entries.push({
          label: dlPickLabel,
          icon: 'folder-open',
          run: function () { downloadItems(sel, { pickDir: true }); }
        });
      }
      if (!multi && state.mode === 'search' && item.pdirFid) {
        entries.push({
          label: '打开所在目录',
          icon: 'folder',
          run: function () { navigate(item.pdirFid, item.pdirFid === ROOT_FID ? '全部文件' : '上级目录'); }
        });
      }
      if (!multi) {
        entries.push({ label: '重命名', icon: 'rename', run: function () { onRename(item); } });
        entries.push({ label: '复制名称', icon: 'copy', run: function () { copyText(item.name, '文件名'); } });
        entries.push({ label: item.dir ? '查看大小与详情' : '查看详情', icon: 'info', run: function () { state.inspectorFid = String(item.fid); setInspectorOpen(true); } });
      }
      entries.push({ sep: true });
      entries.push({ label: '移动到…', icon: 'move', run: function () { doTransferOp('move', sel); } });
      entries.push({ label: '复制到…', icon: 'copy', run: function () { doTransferOp('copy', sel); } });
      entries.push({ sep: true });
      entries.push({ label: multi ? ('删除这 ' + sel.length + ' 项') : '删除', icon: 'trash', danger: true, run: function () { doRemove(sel, { bulk: multi }); } });
      openCtx(e.clientX, e.clientY, entries);
    });

    el.checkAll.addEventListener('change', async function () {
      if (!el.checkAll.checked) {
        clearSelection();
        listVersion += 1;
        updateSelectAll();
        return;
      }
      var seq = listSeq;
      function markVisibleSelected() {
        var curItems = displayItems();
        curItems.forEach(function (i) { state.selected.add(String(i.fid)); });
        rowMap.forEach(function (row) {
          row.classList.add('selected');
          var cb = row._refs ? row._refs.cb : row.querySelector('input[type=checkbox]');
          if (cb) cb.checked = true;
        });
        listVersion += 1;
        updateSelectAll();
      }
      markVisibleSelected();
      // 若当前目录还有未加载分页（例如包含大量小文件），自动分批加载并全量选中
      if (state.hasMore && !state.selectingAll) {
        state.selectingAll = true;
        var maxPages = 100;
        var loadedExtra = 0;
        if (state.total > state.items.length || state.hasMore) {
          toast('info', '正在加载目录内全部项目以便完整全选…', 2400);
        }
        try {
          while (state.hasMore && seq === listSeq && el.checkAll.checked && loadedExtra < maxPages && state.items.length < 10000) {
            var beforeLen = state.items.length;
            await loadPage({ preserveSelection: true });
            if (seq !== listSeq || !el.checkAll.checked) break;
            loadedExtra += 1;
            markVisibleSelected();
            if (state.items.length <= beforeLen) break;
          }
          if (seq === listSeq && el.checkAll.checked && loadedExtra > 0) {
            toast('ok', '已全选当前目录全部 ' + state.selected.size + ' 项');
          }
        } finally {
          state.selectingAll = false;
        }
      }
    });

    // 批量操作条
    el.bulkbar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-bulk]') : null;
      if (b) onBulk(b.dataset.bulk);
    });

    // 传输列表（筛选 / 批量 / 单项）
    if (el.transferFilters) {
      el.transferFilters.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.pill') : null;
        if (!b || !b.dataset.tfilter) return;
        state.transferFilter = b.dataset.tfilter;
        updateTransferFilterPills();
        renderTransfers(true);
      });
    }
    if (el.btnPauseAll) el.btnPauseAll.addEventListener('click', function () { onTransferBatch('pauseAll'); });
    if (el.btnResumeAll) el.btnResumeAll.addEventListener('click', function () { onTransferBatch('resumeAll'); });
    if (el.btnRetryFailed) el.btnRetryFailed.addEventListener('click', function () { onTransferBatch('retryFailed'); });
    el.tlist.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.op') : null;
      if (!b) return;
      var row = b.closest('.trow');
      if (row) onTransferAction(row.dataset.id, b.dataset.tact);
    });
    el.btnClearFinished.addEventListener('click', clearFinished);

    // 设置
    el.btnPickDir.addEventListener('click', pickDownloadDir);
    el.btnOpenDir.addEventListener('click', async function () {
      if (!state.settings.downloadDir) { toast('warn', '尚未设置下载目录'); return; }
      try { await API.dialog.openPath(state.settings.downloadDir); }
      catch (err) { reportError(err, '打开目录失败'); }
    });
    if (el.setAskDlDir) {
      el.setAskDlDir.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.seg') : null;
        if (!b || !b.dataset.askDl) return;
        saveSettings({ askDownloadDir: b.dataset.askDl === 'on' });
      });
    }
    el.upConc.addEventListener('input', updatePerfWarning);
    el.upConc.addEventListener('change', function () {
      var v = minInt(el.upConc.value, 1, 2);
      el.upConc.value = v;
      updatePerfWarning();
      saveSettings({ uploadConcurrency: v });
    });
    if (el.upPart) {
      el.upPart.addEventListener('input', updatePerfWarning);
      el.upPart.addEventListener('change', function () {
        var v = minInt(el.upPart.value, 1, 3);
        el.upPart.value = v;
        updatePerfWarning();
        saveSettings({ uploadPartConcurrency: v });
      });
    }
    el.downConc.addEventListener('input', updatePerfWarning);
    el.downConc.addEventListener('change', function () {
      var v = minInt(el.downConc.value, 1, 2);
      el.downConc.value = v;
      updatePerfWarning();
      saveSettings({ downloadConcurrency: v });
    });
    if (el.downParallel) {
      el.downParallel.addEventListener('input', updatePerfWarning);
      el.downParallel.addEventListener('change', function () {
        var v = minInt(el.downParallel.value, 1, 16);
        el.downParallel.value = v;
        updatePerfWarning();
        saveSettings({ downloadParallel: v });
      });
    }
    if (el.downStrategy) el.downStrategy.addEventListener('change', function () {
      saveSettings({ downloadStrategy: el.downStrategy.value });
    });
    if (el.setHubOptIn) {
      el.setHubOptIn.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.seg') : null;
        if (!b || b.disabled || !b.dataset.hubOptin) return;
        setHubOptIn(b.dataset.hubOptin === 'on');
      });
    }
    if (el.btnHubCheck) el.btnHubCheck.addEventListener('click', function () { checkHubUpdate({ silent: false }); });
    if (el.btnHubLogs) el.btnHubLogs.addEventListener('click', openHubLogPreviewModal);
    if (el.btnHubDownload) el.btnHubDownload.addEventListener('click', downloadHubUpdate);
    if (el.btnHubOpenPkg) {
      el.btnHubOpenPkg.addEventListener('click', async function () {
        if (!state.hub.downloadedPath) return;
        if (API.has('hub', 'installUpdate')) {
          try {
            var res = await API.hub.installUpdate({ path: state.hub.downloadedPath });
            if (res && res.message) toast('ok', res.message);
            return;
          } catch (err) {
            reportError(err, '启动一键升级失败');
            return;
          }
        }
        API.dialog.openPath(state.hub.downloadedPath).catch(function (err) { reportError(err, '打开安装包失败'); });
      });
    }
    if (el.btnHubReveal) {
      el.btnHubReveal.addEventListener('click', function () {
        if (!state.hub.downloadedPath) return;
        API.dialog.showInFolder(state.hub.downloadedPath).catch(function (err) { reportError(err, '定位安装包失败'); });
      });
    }
    if (el.btnHubGithub) {
      el.btnHubGithub.addEventListener('click', function () {
        if (API.has('hub', 'openReleasePage')) {
          API.hub.openReleasePage().then(function () {
            toast('info', '已在浏览器中打开 GitHub Releases 下载页');
          }).catch(function (err) {
            reportError(err, '打开 GitHub Releases 失败');
          });
        } else {
          toast('info', '请访问 GitHub Releases 下载最新安装包');
        }
      });
    }
    if (el.fbBtnEnable) el.fbBtnEnable.addEventListener('click', function () { setHubOptIn(true); });
    if (el.fbBtnPreview) el.fbBtnPreview.addEventListener('click', openHubLogPreviewModal);
    if (el.fbBtnSubmit) el.fbBtnSubmit.addEventListener('click', submitFeedbackForm);
    if (el.fbBtnRefreshHistory) el.fbBtnRefreshHistory.addEventListener('click', function () { loadMyFeedback({ silent: false }); });
    el.themeSeg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg') : null;
      if (!b) return;
      saveSettings({ theme: b.dataset.theme });
    });
    if (el.setFloatBall) {
      el.setFloatBall.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.seg') : null;
        if (!b || !b.dataset.floatBall) return;
        saveSettings({ floatingTransferBall: b.dataset.floatBall === 'on' });
      });
    }
    if (el.setFloatUnarchive) {
      el.setFloatUnarchive.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.seg') : null;
        if (!b || !b.dataset.floatUnarchive) return;
        saveSettings({ floatingUnarchiveWindow: b.dataset.floatUnarchive === 'on' });
      });
    }
    if (el.btnCopyQq) {
      el.btnCopyQq.addEventListener('click', function () {
        copyText('1054152586', 'QQ 群号（1054152586）');
      });
    }
    if (el.setAiBeta) {
      el.setAiBeta.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.seg') : null;
        if (!b || !b.dataset.aiBeta) return;
        onToggleAiBeta(b.dataset.aiBeta === 'on');
      });
    }
    el.btnVerify.addEventListener('click', async function () {
      try {
        var s = await API.auth.verify();
        applyAccount(s);
        if (s && s.expired) toast('warn', '登录状态已失效');
        else if (s && s.loggedIn) toast('ok', '登录状态有效');
        else toast('warn', '当前未登录，请先登录');
      } catch (err) { reportError(err, '校验登录状态失败'); }
    });
    el.btnLogin2.addEventListener('click', doLogin);
    el.btnLogout2.addEventListener('click', doLogout);
    if (el.btnOpenTutorial) el.btnOpenTutorial.addEventListener('click', function () { showOnboardingTutorial({ manual: true }); });
    el.btnEnvCheck.addEventListener('click', function () { location.reload(); });

    // Agent 接入
    if (el.agentBtnEnable) el.agentBtnEnable.addEventListener('click', agentToggle);
    if (el.agentBtnDisable) el.agentBtnDisable.addEventListener('click', agentToggle);
    if (el.agentBtnRotate) el.agentBtnRotate.addEventListener('click', agentRotate);
    if (el.agentScopeSeg) el.agentScopeSeg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg') : null;
      if (!b || b.disabled) return;
      agentSetWriteMode(b.dataset.agentScope);
    });
    if (el.agentDeleteSeg) el.agentDeleteSeg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg') : null;
      if (!b || b.disabled) return;
      agentSetAllowDelete(b.dataset.agentDelete === 'on');
    });
    if (el.agentBtnAddRemote) el.agentBtnAddRemote.addEventListener('click', agentAddCurrentDir);
    if (el.agentBtnAddRead) el.agentBtnAddRead.addEventListener('click', function () { agentPickLocalRoots('read'); });
    if (el.agentBtnAddWrite) el.agentBtnAddWrite.addEventListener('click', function () { agentPickLocalRoots('write'); });
    if (el.agentBtnRefreshJournal) el.agentBtnRefreshJournal.addEventListener('click', agentRefreshJournal);
    if (el.agentBtnCopyMcp) el.agentBtnCopyMcp.addEventListener('click', agentCopyMcp);

    // 对话视图
    if (el.chatBtnSave) el.chatBtnSave.addEventListener('click', chatSaveConfig);
    if (el.chatBtnTest) el.chatBtnTest.addEventListener('click', chatTest);
    if (el.chatBtnModels) el.chatBtnModels.addEventListener('click', chatFetchModels);
    if (el.chatBtnClearConfig) el.chatBtnClearConfig.addEventListener('click', chatClearConfig);
    if (el.chatBtnSettings) el.chatBtnSettings.addEventListener('click', chatToggleConfig);
    if (el.chatBtnSend) el.chatBtnSend.addEventListener('click', chatSend);
    if (el.chatBtnClear) el.chatBtnClear.addEventListener('click', chatClear);
    if (el.chatInput) {
      el.chatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          chatSend();
        }
      });
      el.chatInput.addEventListener('input', chatAutoGrow);
    }
    [el.agentRemoteRoots, el.agentLocalReadRoots, el.agentLocalWriteRoots].forEach(function (box) {
      if (!box) return;
      box.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-agent-remove]') : null;
        if (!b) return;
        agentRemoveRoot(b.dataset.agentKind, parseInt(b.dataset.agentRemove, 10));
      });
    });

    // 全局点击 & 鼠标侧键（后退 / 前进）
    document.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.toasts')) return;
      if (!el.ctx.hidden && (!e.target.closest || !e.target.closest('.ctxmenu'))) closeCtx();
      if (el.crumbMenu && !el.crumbMenu.hidden && (!e.target.closest || (!e.target.closest('#crumb-menu') && !e.target.closest('.crumb-ellipsis')))) {
        closeCrumbMenu();
      }
    });
    window.addEventListener('mouseup', function (e) {
      if (state.view !== 'files' || hasActiveOverlay()) return;
      if (e.button === 3) { e.preventDefault(); goBack(); }
      else if (e.button === 4) { e.preventDefault(); goForward(); }
    });
    window.addEventListener('resize', function () { closeCtx(); closeCrumbMenu(); updateCrumbScrollBtns(); });
    window.addEventListener('blur', function () { closeCtx(); closeCrumbMenu(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (pendingFilesRefresh) silentRefreshFiles();
      if (Date.now() - lastQuotaRefreshAt >= QUOTA_REFRESH_MS) {
        silentRefreshAccountAndQuota({ force: true });
      }
      if (state.settings.serverOptIn && (Date.now() - (state.hub.lastUpdateCheckAt || 0) >= HUB_POLL_MS)) {
        checkHubUpdate({ silent: true });
        loadMyFeedback({ silent: true, background: state.view !== 'feedback' });
      }
    });

    // 全局未捕获异常自动记录到脱敏诊断缓冲（含脚本基名与行号，不含本机路径或文件名），便于定位程序本身的问题
    window.addEventListener('error', function (ev) {
      var msg = (ev && ev.message) ? String(ev.message) : 'window error';
      // Chromium/WebView2 良性 ResizeObserver 帧末通知，不属于运行错误
      if (/^ResizeObserver loop/i.test(msg)) return;
      var src = ev && ev.filename ? String(ev.filename).split(/[\\/]/).pop().split('?')[0] : '';
      var loc = src ? (src + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0)) : '';
      recordDiag('error', 'window', 'JS_ERROR', loc ? (msg + ' @ ' + loc) : msg, {
        meta: { view: state.view, loc: loc || undefined }
      });
    });
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      var msg = r && r.message ? String(r.message) : String(r || 'unhandled rejection');
      var topFrame = '';
      if (r && typeof r.stack === 'string') {
        var m = r.stack.match(/([A-Za-z0-9_.-]+\.js:\d+:\d+)/);
        if (m) topFrame = m[1];
      }
      recordDiag('error', 'window', (r && r.code) ? String(r.code) : 'UNHANDLED_REJECTION', topFrame ? (msg + ' @ ' + topFrame) : msg, {
        httpStatus: r && r.httpStatus ? r.httpStatus : undefined,
        bizCode: r && r.bizCode !== undefined ? r.bizCode : undefined,
        meta: { view: state.view, frame: topFrame || undefined }
      });
    });

    // 轻量主线程卡顿监控：前台页面事件循环阻塞 >= 2.5s 时记录诊断日志用于性能排查
    (function startStallMonitor() {
      var lastTick = Date.now();
      var timer = setInterval(function () {
        var now = Date.now();
        var drift = now - lastTick - 2000;
        lastTick = now;
        if (!document.hidden && drift >= 2500 && drift < 120000) {
          recordDiag('warn', 'ui_perf', 'MAIN_THREAD_STALL', 'renderer main thread stalled ' + drift + 'ms', {
            durationMs: drift,
            meta: { view: state.view, rows: rowMap.size, transfers: (state.transfers || []).length }
          });
        }
      }, 2000);
      unsubs.push(function () { clearInterval(timer); });
    })();

    // 完整桌面端快捷键工作流（严格守卫模态框与输入框）
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
      if (hasActiveOverlay()) return;

      if (e.key === 'Escape' && !typing) {
        if (!el.ctx.hidden) { closeCtx(); return; }
        if (el.crumbMenu && !el.crumbMenu.hidden) { closeCrumbMenu(); return; }
        if (state.selected.size) { clearSelection(); return; }
        if (state.view === 'files' && state.mode === 'search') { leaveSearch(); return; }
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        if (state.view === 'files' && el.searchInput) {
          e.preventDefault();
          el.searchInput.focus();
          if (typeof el.searchInput.select === 'function') el.searchInput.select();
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
        if (state.view === 'files' && !typing) {
          e.preventDefault();
          setInspectorOpen(!state.inspectorOpen);
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        if (state.view === 'files' && !typing && state.mode !== 'search') {
          e.preventDefault();
          onMkdir();
          return;
        }
      }

      if (typing) return;
      if (state.view !== 'files') return;

      if ((e.altKey || e.metaKey) && e.key === 'ArrowUp') {
        e.preventDefault();
        goUp();
        return;
      }
      if ((e.altKey && e.key === 'ArrowLeft') || (e.metaKey && e.key === '[')) {
        e.preventDefault();
        goBack();
        return;
      }
      if ((e.altKey && e.key === 'ArrowRight') || (e.metaKey && e.key === ']')) {
        e.preventDefault();
        goForward();
        return;
      }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        goUp();
        return;
      }
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
        e.preventDefault();
        reloadCurrent();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        el.checkAll.checked = true;
        el.checkAll.dispatchEvent(new Event('change'));
        return;
      }
      if (e.key === 'F2' && state.selected.size === 1) {
        var one = selectedItems()[0];
        if (one) { e.preventDefault(); onRename(one); }
        return;
      }
      if (e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) {
        if (state.selected.size) {
          e.preventDefault();
          doRemove(selectedItems(), { bulk: state.selected.size > 1 });
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveKeyboardFocus(state.focusIndex < 0 ? 0 : state.focusIndex + 1, e.shiftKey);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveKeyboardFocus(state.focusIndex < 0 ? 0 : state.focusIndex - 1, e.shiftKey);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        moveKeyboardFocus(0, e.shiftKey);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        moveKeyboardFocus(displayItems().length - 1, e.shiftKey);
        return;
      }
      if (e.key === 'Enter' && tag !== 'BUTTON' && state.selected.size === 1) {
        var picked = selectedItems()[0];
        if (picked) { e.preventDefault(); openItem(picked); }
      }
    });

    window.addEventListener('beforeunload', function () {
      unsubs.forEach(function (f) { try { f(); } catch (e) {} });
      unsubs = [];
      stopAutoRefreshLoop();
    });
  }

  function minInt(v, min, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.max(min, n);
  }

  function runRowOp(op, item) {
    if (!item) return;
    if (op === 'unarchive') return openArchiveModal(item);
    if (op === 'download') return downloadItems([item]);
    if (op === 'rename') return onRename(item);
    if (op === 'move') return doTransferOp('move', [item]);
    if (op === 'copy') return doTransferOp('copy', [item]);
    if (op === 'remove') return doRemove([item]);
  }

  function runSearch(keyword, opts) {
    if (!API.injected) { toast('warn', '未注入桥接层，无法搜索'); return; }
    if (needsLoginState()) { toast('warn', '请先登录夸克账号后再搜索'); return; }
    var o = opts || {};
    var kw = String(keyword || '').trim();
    if (!kw) { leaveSearch(); return; }
    state.mode = 'search';
    state.keyword = kw;
    state.filter = 'all';
    state.selected.clear();
    el.searchClear.hidden = false;
    if (el.searchKbd) el.searchKbd.hidden = true;
    updateFilterPills();
    if (!o.fromHistory) {
      pushHistoryEntry({ mode: 'search', keyword: kw });
    }
    resetList();
    renderCrumbs();
    loadPage({ reset: true });
  }

  function leaveSearch() {
    if (state.mode !== 'search') return;
    state.mode = 'browse';
    state.keyword = '';
    state.filter = 'all';
    el.searchInput.value = '';
    el.searchClear.hidden = true;
    if (el.searchKbd) el.searchKbd.hidden = false;
    updateFilterPills();
    resetList();
    renderCrumbs();
    loadCrumbs(state.fid);
    loadPage({ reset: true });
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */

  function cacheEls() {
    el.banners = $('banners');
    el.nav = $('nav');
    el.navChat = $('nav-chat');
    el.navFeedback = $('nav-feedback');
    el.feedbackBadge = $('feedback-badge');
    el.transferBadge = $('transfer-badge');
    el.sidebarTransferMini = $('sidebar-transfer-mini');
    el.sidebarTransferText = $('sidebar-transfer-text');
    el.sidebarQuota = $('sidebar-quota');
    el.sidebarQuotaFree = $('sidebar-quota-free');
    el.sidebarQuotaPct = $('sidebar-quota-pct');
    el.sidebarQuotaFill = $('sidebar-quota-fill');
    el.sidebarQuotaText = $('sidebar-quota-text');
    el.sidebarFoot = $('sidebar-foot');
    el.btnQuit = $('btn-quit');
    el.crumbsShell = $('crumbs-shell');
    el.btnCrumbsPrev = $('btn-crumbs-prev');
    el.btnCrumbsNext = $('btn-crumbs-next');
    el.crumbs = $('crumbs');
    el.crumbMenu = $('crumb-menu');
    el.directoryNav = $('directory-nav');
    el.btnBack = $('btn-back');
    el.btnForward = $('btn-forward');
    el.btnUp = $('btn-up');
    el.btnUpLabel = $('btn-up-label');
    el.searchBox = $('search-box');
    el.searchInput = $('search-input');
    el.searchKbd = $('search-kbd');
    el.searchClear = $('search-clear');
    el.btnRefresh = $('btn-refresh');
    el.btnMkdir = $('btn-mkdir');
    el.btnUpload = $('btn-upload');
    el.account = $('account');
    el.viewFiles = $('view-files');
    el.viewRecycle = $('view-recycle');
    el.navRecycle = $('nav-recycle');
    el.recycleSummary = $('recycle-summary');
    el.btnRecycleRefresh = $('btn-recycle-refresh');
    el.btnRecycleRecover = $('btn-recycle-recover');
    el.btnRecycleRemove = $('btn-recycle-remove');
    el.btnRecycleClear = $('btn-recycle-clear');
    el.recycleCheckAll = $('recycle-check-all');
    el.recycleListwrap = $('recycle-listwrap');
    el.recycleList = $('recycle-list');
    el.recycleFoot = $('recycle-foot');
    el.viewTransfers = $('view-transfers');
    el.viewSettings = $('view-settings');
    el.viewFeedback = $('view-feedback');
    el.fileSubbar = $('file-subbar');
    el.filterPills = $('filter-pills');
    el.subbarTransferLive = $('subbar-transfer-live');
    el.stlKind = $('stl-kind');
    el.stlName = $('stl-name');
    el.stlFill = $('stl-fill');
    el.stlMeta = $('stl-meta');
    el.sortSelect = $('sort-select');
    el.viewModeSeg = $('view-mode-seg');
    el.btnInspector = $('btn-inspector');
    el.fileInspector = $('file-inspector');
    el.btnInspectorClose = $('btn-inspector-close');
    el.inspectorBody = $('inspector-body');
    el.fileStatusbar = $('file-statusbar');
    el.statusbarSummary = $('statusbar-summary');
    el.statusbarHint = $('statusbar-hint');
    el.bulkbar = $('bulkbar');
    el.bulkUnarchive = $('bulk-unarchive');
    el.bulkCount = $('bulk-count');
    el.fileCard = $('file-card');
    el.listhead = $('listhead');
    el.checkAll = $('check-all');
    el.listwrap = $('listwrap');
    el.list = $('list');
    el.listfoot = $('listfoot');
    el.tlist = $('tlist');
    el.transferBar = $('transfer-bar');
    el.transferFilters = $('transfer-filters');
    el.transferSpeedStrip = $('transfer-speed-strip');
    el.transferSpeedText = $('transfer-speed-text');
    el.btnPauseAll = $('btn-pause-all');
    el.btnResumeAll = $('btn-resume-all');
    el.btnRetryFailed = $('btn-retry-failed');
    el.transfersSummary = $('transfers-summary');
    el.btnClearFinished = $('btn-clear-finished');
    el.dlDir = $('set-download-dir');
    el.setAskDlDir = $('set-ask-dl-dir');
    el.upConc = $('set-up-conc');
    el.downConc = $('set-down-conc');
    el.upPart = $('set-up-part');
    el.downParallel = $('set-down-parallel');
    el.downStrategy = $('set-down-strategy');
    el.setPerfWarn = $('set-perf-warn');
    el.setPerfWarnText = $('set-perf-warn-text');
    el.themeSeg = $('set-theme');
    el.setFloatBall = $('set-float-ball');
    el.setFloatUnarchive = $('set-float-unarchive');
    el.btnCopyQq = $('btn-copy-qq');
    el.aiBetaCard = $('ai-beta-card');
    el.aiBetaHint = $('ai-beta-hint');
    el.setAiBeta = $('set-ai-beta');
    // 作者服务器与反馈
    el.hubCard = $('hub-card');
    el.hubStatusBadge = $('hub-status-badge');
    el.hubPrivacyNote = $('hub-privacy-note');
    el.hubCryptoText = $('hub-crypto-text');
    el.setHubOptIn = $('set-hub-optin');
    el.hubUpdateSummary = $('hub-update-summary');
    el.btnHubCheck = $('btn-hub-check');
    el.btnHubLogs = $('btn-hub-logs');
    el.hubUpdatePanel = $('hub-update-panel');
    el.hubUpdateTitle = $('hub-update-title');
    el.hubUpdateMeta = $('hub-update-meta');
    el.hubUpdateNotice = $('hub-update-notice');
    el.hubUpdateChangelog = $('hub-update-changelog');
    el.btnHubDownload = $('btn-hub-download');
    el.btnHubOpenPkg = $('btn-hub-open-pkg');
    el.btnHubReveal = $('btn-hub-reveal');
    el.btnHubGithub = $('btn-hub-github');
    el.hubUpdateFallbackHint = $('hub-update-fallback-hint');
    el.hubDlProgress = $('hub-dl-progress');
    el.hubDlFill = $('hub-dl-fill');
    el.hubDlLabel = $('hub-dl-label');
    el.fbGateCard = $('fb-gate-card');
    el.fbBtnEnable = $('fb-btn-enable');
    el.fbCard = $('fb-card');
    el.fbCategory = $('fb-category');
    el.fbContact = $('fb-contact');
    el.fbMessage = $('fb-message');
    el.fbIncludeLogs = $('fb-include-logs');
    el.fbBtnPreview = $('fb-btn-preview');
    el.fbBtnSubmit = $('fb-btn-submit');
    el.fbStatus = $('fb-status');
    el.fbHistoryCard = $('fb-history-card');
    el.fbHistorySummary = $('fb-history-summary');
    el.fbBtnRefreshHistory = $('fb-btn-refresh-history');
    el.fbHistoryList = $('fb-history-list');
    el.appVersionText = $('app-version-text');
    el.btnPickDir = $('btn-pick-dir');
    el.btnOpenDir = $('btn-open-dir');
    el.btnVerify = $('btn-verify');
    el.btnLogin2 = $('btn-login-2');
    el.btnLogout2 = $('btn-logout-2');
    el.envHint = $('set-env');
    el.btnOpenTutorial = $('btn-open-tutorial');
    el.btnEnvCheck = $('btn-env-check');
    el.setAccountHint = $('set-account-hint');
    el.dropmask = $('dropmask');
    el.dropSub = $('dropmask-sub');
    el.toasts = $('toasts');
    el.overlayRoot = $('overlay-root');
    el.ctx = $('ctxmenu');
    // Agent 接入面板
    el.agentCard = $('agent-card');
    el.agentStatusText = $('agent-status-text');
    el.agentStatusHint = $('agent-status-hint');
    el.agentStatusError = $('agent-status-error');
    el.agentStatusExtra = $('agent-status-extra');
    el.agentStatusDot = $('agent-status-dot');
    el.agentBtnEnable = $('agent-btn-enable');
    el.agentBtnDisable = $('agent-btn-disable');
    el.agentBtnRotate = $('agent-btn-rotate');
    el.agentScopeSeg = $('agent-scope-seg');
    el.agentScopeHint = $('agent-scope-hint');
    el.agentDeleteSeg = $('agent-delete-seg');
    el.agentDeleteHint = $('agent-delete-hint');
    el.agentRemoteRoots = $('agent-remote-roots');
    el.agentBtnAddRemote = $('agent-btn-add-remote');
    el.agentLocalReadRoots = $('agent-local-read-roots');
    el.agentBtnAddRead = $('agent-btn-add-read');
    el.agentLocalWriteRoots = $('agent-local-write-roots');
    el.agentBtnAddWrite = $('agent-btn-add-write');
    el.agentJournal = $('agent-journal');
    el.agentBtnRefreshJournal = $('agent-btn-refresh-journal');
    el.agentMcp = $('agent-mcp-config');
    el.agentBtnCopyMcp = $('agent-btn-copy-mcp');
    // 对话视图
    el.viewChat = $('view-chat');
    el.chatCard = $('chat-card');
    el.chatCardHint = $('chat-card-hint');
    el.chatCardDot = $('chat-card-dot');
    el.chatCardStatus = $('chat-card-status');
    el.chatBtnSettings = $('chat-btn-settings');
    el.chatBtnClearConfig = $('chat-btn-clear-config');
    el.chatConfigForm = $('chat-config-form');
    el.chatBaseUrl = $('chat-base-url');
    el.chatApiKey = $('chat-api-key');
    el.chatModel = $('chat-model');
    el.chatConfigHint = $('chat-config-hint');
    el.chatBtnSave = $('chat-btn-save');
    el.chatBtnTest = $('chat-btn-test');
    el.chatBtnModels = $('chat-btn-models');
    el.chatModelList = $('chat-model-list');
    el.chatSummary = $('chat-summary');
    el.chatMessages = $('chat-messages');
    el.chatInput = $('chat-input');
    el.chatBtnSend = $('chat-btn-send');
    el.chatBtnClear = $('chat-btn-clear');
    el.chatStatus = $('chat-status');
  }

  function subscribeChannels() {
    unsubs.push(API.auth.onChange(function (s) { applyAccount(s); }));
    if (API.app && typeof API.app.onOpenView === 'function') {
      unsubs.push(API.app.onOpenView(function (payload) {
        var view = payload && payload.view ? String(payload.view) : 'files';
        if (view === 'transfers' || view === 'files' || view === 'settings') setView(view);
        if (payload && payload.fid) navigate(String(payload.fid), '');
      }));
    }
    if (API.app && typeof API.app.onSettingsSync === 'function') {
      unsubs.push(API.app.onSettingsSync(function (saved) {
        if (saved && typeof saved === 'object') {
          Object.assign(state.settings, saved);
          applyFloatingSettings();
        }
      }));
    }

    var onTasks = function (tasks) {
      if (!Array.isArray(tasks)) return;
      transferSeq += 1;
      state.transfers = tasks;
      state.transfersLoaded = true;
      handleTransferCompletionRefresh(tasks);
      renderTransfers(false);
    };
    unsubs.push(API.transfer.onUpdate(onTasks));
    if (API.hub && typeof API.hub.onUpdateProgress === 'function') {
      unsubs.push(API.hub.onUpdateProgress(handleHubUpdateProgress));
    }

    unsubs.push(API.onToast(function (payload) {
      if (!payload || typeof payload !== 'object') return;
      var level = (payload.level === 'warn' || payload.level === 'error' || payload.level === 'ok') ? payload.level : 'info';
      if (payload.message) toast(level, payload.message);
    }));

    unsubs.push(API.chat.onEvent(handleChatEvent));
    unsubs.push(API.onNeedLogin(function () { showExpiredBanner(); }));
  }

  async function boot() {
    var bootStartedAt = Date.now();
    cacheEls();
    // 优先应用本地缓存主题，避免深色模式首帧白屏闪烁
    try {
      if (typeof localStorage !== 'undefined') {
        var cachedTheme = localStorage.getItem('qk-theme');
        if (cachedTheme === 'dark' || cachedTheme === 'light') {
          state.settings.theme = cachedTheme;
          applyTheme(cachedTheme);
        }
      }
    } catch (_) {}
    var isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || '');
    if (el.searchKbd) el.searchKbd.textContent = isMac ? '⌘F' : 'Ctrl+F';
    if (el.statusbarHint) {
      el.statusbarHint.textContent = isMac
        ? 'Alt+↑ 上一级 · Backspace 返回 · ⌘F 搜索 · F2 重命名'
        : 'Alt+↑ 上一级 · Backspace 返回 · Ctrl+F 搜索 · F2 重命名';
    }
    if (el.btnQuit) {
      el.btnQuit.hidden = !API.has('app', 'quit');
      el.btnQuit.addEventListener('click', async function () {
        try { await API.app.quit(); }
        catch (err) { reportError(err, '退出客户端失败'); }
      });
    }
    bindEvents();
    setupDragDrop();
    if (typeof API.dialog.onDragEnter === 'function') {
      unsubs.push(API.dialog.onDragEnter(function () { showDropMask(); }));
    }
    if (typeof API.dialog.onDragLeave === 'function') {
      unsubs.push(API.dialog.onDragLeave(function () { el.dropmask.hidden = true; }));
    }
    unsubs.push(API.dialog.onFilesDropped(function (paths) {
      el.dropmask.hidden = true;
      if (state.view !== 'files') {
        toast('warn', '请先切换到「全部文件」再拖拽上传');
        setView('files');
        return;
      }
      doUploadPaths(paths).catch(function (err) { reportError(err, '拖拽上传失败'); });
    }));

    var info = API.bridgeInfo();
    el.envHint.textContent = info.text;
    el.sidebarFoot.textContent = API.isMock ? '开发假数据模式' : (API.injected ? '' : '未连接后端');
    renderAppVersion();

    if (!API.injected) {
      showNoBridgeBanner(info);
      applyAiBeta(false);
      renderCrumbs();
      renderEmpty('未注入桥接层，无法读取文件列表', true);
      el.checkAll.disabled = true;
      setTopbarForView();
      renderAccount();
      renderTransfers(true);
      renderSettings();
      renderAgent();
      renderChat();
      renderChatHistory();
      renderStatusBar();
      return;
    }

    if (info.mock) {
      banner('mock', 'info', '开发假数据模式（?mock=1）：列表与传输任务均为本地假数据，未连接真实后端。', []);
    } else if (info.missing && info.missing.length) {
      banner('bridge', 'warn', '桥接层缺少以下方法：' + info.missing.join('、') + '，相关功能将不可用。', []);
    }

    subscribeChannels();
    applyTheme(state.settings.theme);
    applyAiBeta(state.settings.aiBetaEnabled);
    updateSortIndicators();
    updateFilterPills();
    pushHistoryEntry({ mode: 'browse', fid: ROOT_FID, name: '全部文件', crumbs: cloneCrumbs(state.crumbs) });
    setView('files');
    renderCrumbs();
    renderAccount();
    refreshCachedRowHeight();

    // 并发初始化：设置、版本信息、登录状态同时拉取，显著缩短冷启动首屏时间
    var settingsTask = loadSettings();
    loadAppInfo();

    var acct = null;
    try {
      acct = await API.auth.status();
      applyAccount(acct);
      if (acct && acct.expired) showExpiredBanner();
    } catch (err) {
      if (API.isNeedLogin(err)) showExpiredBanner();
      else reportError(err, '读取登录状态失败');
    }

    await settingsTask;
    startAutoRefreshLoop();

    if (acct && acct.loggedIn && !acct.expired) {
      refreshQuota();
      refreshTransfers();
      await loadPage({ reset: true });
    } else {
      state.loadedOnce = true;
      renderEmpty(
        acct && acct.expired ? '登录状态已失效，请重新登录' : '登录夸克账号后即可浏览、上传和下载你的网盘文件',
        false,
        { login: true }
      );
      renderStatusBar();
      refreshTransfers();
    }

    if (!API.isMock && !state.settings.tutorialSeen) {
      await showOnboardingTutorial();
    }
    var bootMs = Date.now() - bootStartedAt;
    recordDiag(bootMs >= 4000 ? 'warn' : 'info', 'perf', 'BOOT_TIMING', 'app boot ready in ' + bootMs + 'ms', {
      durationMs: bootMs,
      meta: { loggedIn: !!(acct && acct.loggedIn), view: state.view, items: state.items.length }
    });
    // L2 看门狗确认：通知 Rust 端当前界面（含热更新界面）已正常首屏渲染完成，并同步当前热配置
    if (API.has('hub', 'uiReady')) {
      API.hub.uiReady().then(function (st) {
        if (st && st.tuning) applyRuntimeTuning(st.tuning);
      }).catch(function () {});
    }
    initHubOnBoot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 便于在浏览器控制台做自检（例如 QKUI.state）
  window.QKUI = {
    state: state,
    toast: toast,
    setView: setView,
    reload: reloadCurrent,
    silentRefreshFiles: silentRefreshFiles,
    silentRefreshAccountAndQuota: silentRefreshAccountAndQuota,
    showOnboardingTutorial: showOnboardingTutorial,
    showServerOptInModal: showServerOptInModal,
    navigate: navigate,
    goUp: goUp,
    goBack: goBack,
    goForward: goForward,
    loadPage: loadPage,
    setFilter: setFilter,
    setSortBy: setSortBy,
    applyViewMode: applyViewMode,
    setInspectorOpen: setInspectorOpen,
    openArchiveModal: openArchiveModal,
    openStorageDetailModal: openStorageDetailModal,
    loadRecycle: loadRecycle,
    getRowCount: function () { return rowMap.size; },
    version: '1.3.1'
  };
})();
