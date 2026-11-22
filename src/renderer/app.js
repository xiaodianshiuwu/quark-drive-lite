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

  var STATUS_TEXT = {
    pending: '等待中', running: '进行中', paused: '已暂停',
    error: '失败', done: '已完成', canceled: '已取消'
  };

  var state = {
    view: 'files',                 // files | transfers | settings
    fid: ROOT_FID,                 // 当前目录
    crumbs: [{ fid: ROOT_FID, name: '全部文件' }],
    mode: 'browse',                // browse | search
    keyword: '',
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
    settings: {
      downloadDir: '',
      uploadConcurrency: 2,
      downloadConcurrency: 2,
      downloadParallel: 16,
      downloadStrategy: 'auto',
      uploadPartConcurrency: 3,
      theme: 'light',
    },
    transfers: [],
    transfersLoaded: false,
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
  var rowMap = new Map();          // fid -> tr element
  var transferMap = new Map();     // id  -> element
  var unsubs = [];
  var toastSeq = 0;
  var listSeq = 0;
  var listFrame = null;
  var transferSeq = 0;
  var topSpacer = null;
  var bottomSpacer = null;

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
    if (!isFinite(b) || b <= 0) return b === 0 ? '—' : '—';
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
    if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'].indexOf(ext) >= 0) return 'file-video';
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

  /* ================================================================== *
   * toast
   * ================================================================== */

  function toast(level, message, ms) {
    if (!message) return;
    if (el.toasts.childElementCount >= 3) el.toasts.removeChild(el.toasts.firstChild);
    var lv = (level === 'warn' || level === 'error') ? level : 'info';
    var node = h('div', 'toast toast-' + lv);
    node.appendChild(icon(lv === 'error' ? 'error' : (lv === 'warn' ? 'warn' : 'info'), 'toast-ic'));
    var body = h('div', 'toast-body');
    body.appendChild(h('div', 'toast-title', lv === 'error' ? '出错了' : (lv === 'warn' ? '注意' : '提示')));
    body.appendChild(h('div', 'toast-msg', String(message)));
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
    var timer = setTimeout(remove, ms || (lv === 'error' ? 6000 : 3200));
    function remove() {
      clearTimeout(timer);
      if (!node.parentNode) return;
      node.classList.add('toast-out');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 160);
    }
  }

  /** 统一错误上报：NEED_LOGIN 由 QKAPI.onNeedLogin 统一驱动提示条，这里只负责文案。 */
  function reportError(err, fallback) {
    var e = API.normalizeError(err, fallback);
    if (API.isNeedLogin(e)) {
      toast('error', '登录状态已失效，请重新登录');
      return e;
    }
    toast('error', e.message || fallback || '操作失败');
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
      b.addEventListener('click', a.onClick);
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
      applyAccount(s);
      clearExpiredBanner();
      toast('info', '登录成功');
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
      resetSessionViews();
      applyAccount({ loggedIn: false, expired: false });
      clearExpiredBanner();
      toast('info', '已退出登录');
    } catch (err) {
      reportError(err, '退出登录失败');
    }
  }

  /** 登出或切换账号时清空备份与对话视图中的上个账号状态（保留大模型连接配置）。 */
  function resetSessionViews() {
    stopBackupPolling();
    backup.planned = null;
    backup.lastStatus = null;
    backup.taskOffset = 0;
    backup.pollBusy = false;
    backup.taskBusy = false;
    var runBox = $('backup-run');
    if (runBox) runBox.hidden = true;
    var planBox = $('backup-plan-result');
    if (planBox) { planBox.hidden = true; planBox.textContent = ''; }
    var verifyBox = $('backup-verify-result');
    if (verifyBox) { verifyBox.hidden = true; verifyBox.textContent = ''; }
    var taskList = $('backup-task-list');
    if (taskList) taskList.textContent = '';

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
      // Invalidate in-flight pages as well as the rendered rows on account changes.
      state.quota = null;
      state.fid = ROOT_FID;
      state.mode = 'browse';
      state.keyword = '';
      state.crumbs = [{ fid: ROOT_FID, name: '全部文件' }];
      el.searchInput.value = '';
      el.searchClear.hidden = true;
      resetList();
      renderCrumbs();
      renderEmpty(s.expired ? '登录状态已失效，请重新登录' : '请先登录夸克网盘', false);
      resetSessionViews();
    } else if ((!previous || !previous.loggedIn) && s.loggedIn) {
      chatOf().loaded = false;
    }
    if (s.expired === true) showExpiredBanner();
    else if (s.loggedIn === true) clearExpiredBanner();
    renderAccount();
    renderSettings();
  }

  function renderAccount() {
    // 登录态变化时顺带刷新 Agent 面板（面板只读本地状态，与账号渲染互相独立）
    renderAgent();
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
      sub.appendChild(h('span', 'acct-quota-text',
        '已用 ' + fmtSize(q.used) + ' / ' + fmtSize(q.total)));
    }
    meta.appendChild(sub);
    if (q && q.total > 0) {
      var bar = h('div', 'quota-bar');
      var fill = h('i');
      var pct = Math.min(100, Math.max(0, (q.used / q.total) * 100));
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
    try {
      var q = await API.auth.quota();
      if (state.account !== account || !account || !account.loggedIn) return;
      if (q && typeof q.total === 'number') { state.quota = q; renderAccount(); }
    } catch (e) { /* 容量信息失败不打扰用户 */ }
  }

  /* ================================================================== *
   * 自绘对话框
   * ================================================================== */

  function closeOverlay(node) {
    if (!node || !node.parentNode) return;
    node.classList.add('overlay-out');
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 140);
  }

  function openOverlay(build) {
    var wrap = h('div', 'overlay');
    var panel = h('div', 'dlg');
    wrap.appendChild(panel);
    el.overlayRoot.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('overlay-in'); });
    var closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      closeOverlay(wrap);
      if (resolveFn) resolveFn(result);
    }
    var resolveFn = null;
    var api = { wrap: wrap, panel: panel, close: close, setResolve: function (fn) { resolveFn = fn; } };
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(null); });
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    }
    document.addEventListener('keydown', onKey, true);
    build(api);
    var focusable = panel.querySelector('input, button.btn-primary, button');
    if (focusable) setTimeout(function () { try { focusable.focus(); } catch (e) {} }, 30);
    return api;
  }

  /** 二次确认对话框。danger=true 时确认按钮为红色。 */
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
        ok.dataset.autofocus = '1';
        cancel.focus();
      });
      api.wrap.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) {
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
   * 目录选择器：fs.crumbs + fs.list 逐层浏览，根目录 fid 恒为 '0'。
   * 返回选中的目标目录 fid，取消返回 null。
   */
  function pickDirDialog(opts) {
    var o = opts || {};
    var cur = { fid: ROOT_FID, name: '全部文件' };
    var crumbs = [{ fid: ROOT_FID, name: '全部文件' }];
    var exclude = o.excludeFids || [];
    var chosen = null;
    var listBox, crumbBox, confirmBtn, loadSeq = 0;

    return new Promise(function (resolve) {
      var api = openOverlay(function (ui) {
        ui.setResolve(resolve);
        ui.panel.classList.add('dlg-picker');

        var head = h('div', 'dlg-head');
        head.appendChild(icon('move', 'dlg-ic'));
        head.appendChild(h('h3', 'dlg-title', o.title || '选择目标目录'));
        ui.panel.appendChild(head);

        crumbBox = h('div', 'picker-crumbs');
        ui.panel.appendChild(crumbBox);

        listBox = h('div', 'picker-list');
        var loading = h('div', 'picker-loading', '加载中…');
        listBox.appendChild(loading);
        ui.panel.appendChild(listBox);

        var foot = h('div', 'dlg-foot');
        var hint = h('span', 'picker-hint', '未选中子目录时表示使用当前所在目录');
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
        foot.appendChild(hint);
        foot.appendChild(cancel);
        foot.appendChild(confirmBtn);
        ui.panel.appendChild(foot);

        loadDir(ROOT_FID);
      });

      function renderCrumbs() {
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
            loadDir(c.fid);
          });
          crumbBox.appendChild(b);
        });
      }

      async function loadDir(fid, page, append) {
        page = page || 1;
        var seq = append ? loadSeq : ++loadSeq;
        var more = listBox.querySelector(".picker-more");
        if (more) more.remove();
        if (!append) listBox.textContent = '';
        var indicator = h('div', 'picker-loading', '加载中…');
        listBox.appendChild(indicator);
        renderCrumbs();
        try {
          var res = await API.fs.list({ pdirFid: fid, page: page, size: 100 });
          if (seq !== loadSeq) return;
          var dirs = (res && res.list ? res.list : []).filter(function (it) { return it.dir; });
          indicator.remove();
          if (!dirs.length && !append) {
            listBox.appendChild(h('div', 'picker-empty', '当前目录下没有子文件夹'));
          } else {
            dirs.forEach(function (d) {
              var row = h('button', 'picker-row');
              row.type = 'button';
              row.dataset.fid = d.fid;
              var disabled = exclude.indexOf(d.fid) >= 0;
              if (disabled) { row.disabled = true; row.title = '不能选择该项自身'; }
              row.appendChild(icon('folder', 'picker-ic'));
              row.appendChild(h('span', 'picker-name', d.name));
              row.appendChild(h('span', 'picker-enter', '进入'));
              row.addEventListener('click', function (e) {
                if (e.target && e.target.classList.contains('picker-enter')) return;
                if (disabled) return;
                if (chosen === d.fid) { chosen = null; }
                else chosen = d.fid;
                Array.prototype.forEach.call(listBox.querySelectorAll('.picker-row'), function (r) {
                  r.classList.toggle('selected', r.dataset.fid === chosen);
                });
              });
              row.addEventListener('dblclick', function () {
                if (disabled) return;
                crumbs = crumbs.concat([{ fid: d.fid, name: d.name }]);
                cur = { fid: d.fid, name: d.name };
                chosen = null;
                loadDir(d.fid);
              });
              var enter = row.querySelector('.picker-enter');
              enter.addEventListener('click', function (e) {
                e.stopPropagation();
                crumbs = crumbs.concat([{ fid: d.fid, name: d.name }]);
                cur = { fid: d.fid, name: d.name };
                chosen = null;
                loadDir(d.fid);
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
   * 顶部栏：面包屑 / 搜索 / 账号
   * ================================================================== */

  function renderCrumbs() {
    var box = el.crumbs;
    box.textContent = '';
    var searching = state.mode === 'search';
    el.btnUp.disabled = !searching && state.fid === ROOT_FID;
    el.btnUpLabel.textContent = searching ? '返回目录' : '上一级';
    el.btnUp.title = searching ? '返回搜索前的目录（Alt+↑）' : '返回上一级目录（Alt+↑）';
    el.btnUp.setAttribute('aria-label', searching ? '返回搜索前的目录' : '返回上一级目录');
    if (state.mode === 'search') {
      box.appendChild(h('span', 'crumb-search-label', '搜索结果：'));
      box.appendChild(h('span', 'crumb-current', state.keyword));
      return;
    }
    state.crumbs.forEach(function (c, i) {
      if (i > 0) box.appendChild(icon('chevron', 'crumb-sep'));
      var last = i === state.crumbs.length - 1;
      var b = h('button', 'crumb-item' + (last ? ' current' : ''));
      b.type = 'button';
      b.textContent = c.name;
      b.title = last ? c.name : ('返回 ' + c.name);
      b.disabled = last;
      if (!last) b.addEventListener('click', function () { navigate(c.fid, c.name); });
      box.appendChild(b);
    });
    box.scrollLeft = box.scrollWidth;
  }

  async function loadCrumbs(fid) {
    var seq = listSeq;
    if (String(fid) === ROOT_FID) {
      state.crumbs = [{ fid: ROOT_FID, name: '全部文件' }];
      renderCrumbs();
      return;
    }
    try {
      var cs = await API.fs.crumbs(fid);
      if (seq !== listSeq || state.mode !== "browse" || String(fid) !== state.fid) return;
      if (Array.isArray(cs) && cs.length) {
        var path = cs.filter(function (c) { return c && c.fid !== undefined && c.fid !== null && String(c.fid) !== ''; }).map(function (c, i) {
          return { fid: String(c.fid), name: c.name || (i === 0 ? '全部文件' : '未命名') };
        });
        if (path.length && path[0].fid !== ROOT_FID) path.unshift({ fid: ROOT_FID, name: '全部文件' });
        var currentIndex = path.findIndex(function (c) { return c.fid === String(fid); });
        if (currentIndex >= 0) {
          state.crumbs = path.slice(0, currentIndex + 1);
        } else if (path.length > 1) {
          // Some path endpoints return only ancestors. A root-only response can
          // also mean unavailable metadata; never erase a locally known parent.
          state.crumbs = path.concat([state.crumbs[state.crumbs.length - 1]]);
        }
      }
    } catch (err) {
      if (seq !== listSeq) return;
      reportError(err, '读取路径失败');
    }
    renderCrumbs();
  }

  function setTopbarForView() {
    var filesView = state.view === 'files';
    [el.directoryNav, el.searchBox, el.btnMkdir, el.btnUpload, el.btnRefresh].forEach(function (n) {
      if (n) n.hidden = !filesView;
    });
  }

  /* ================================================================== *
   * 文件列表
   * ================================================================== */

  async function navigate(fid, name, parentFid) {
    var id = String(fid);
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
    state.selected.clear();
    state.lastIndex = -1;
    el.searchInput.value = '';
    el.searchClear.hidden = true;
    resetList();
    renderCrumbs();
    loadCrumbs(state.fid);
    await loadPage({ reset: true });
    el.listwrap.scrollTop = 0;
  }

  function goUp() {
    if (state.mode === 'search') { leaveSearch(); return; }
    if (state.fid === ROOT_FID) return;
    var parent = state.crumbs[state.crumbs.length - 2] || { fid: ROOT_FID, name: '全部文件' };
    navigate(parent.fid, parent.name);
  }

  function reloadCurrent() {
    if (state.view !== 'files') return;
    if (state.mode === 'search') { runSearch(state.keyword); return; }
    resetList();
    loadCrumbs(state.fid);
    loadPage({ reset: true });
  }

  function resetList() {
    listSeq += 1;
    state.selected.clear();
    state.lastIndex = -1;
    rowMap.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
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
  }

  function findItem(fid) { return state.itemMap[String(fid)] || null; }

  function selectedItems() {
    var out = [];
    state.selected.forEach(function (fid) { var it = findItem(fid); if (it) out.push(it); });
    return out;
  }

  async function loadPage(opts) {
    var o = opts || {};
    if (state.loading) return;
    if (!o.reset && !state.hasMore) return;
    var seq = listSeq;
    state.loading = true;
    renderListFoot();
    var nextPage = o.reset ? 1 : state.page + 1;
    try {
      var params = { page: nextPage, size: PAGE_SIZE };
      var res;
      if (state.mode === 'search') {
        params.keyword = state.keyword;
        res = await API.fs.search(params);
      } else {
        params.pdirFid = state.fid;
        params.sort = 'file_type:asc,updated_at:desc';
        res = await API.fs.list(params);
      }
      if (seq !== listSeq) return;
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
      // 容错：若主进程未正确返回 hasMore，但本页刚好满页且（总数未知或还没取完），
      // 仍继续尝试下一页；下一页返回不足一页时自然停止，不会无限加载。
      if (!state.hasMore && list.length >= PAGE_SIZE && (state.total < 0 || state.items.length < state.total)) {
        state.hasMore = true;
      }
      state.loadedOnce = true;
      await renderRows(seq);
    } catch (err) {
      if (seq !== listSeq) return;
      state.loadedOnce = true;
      var e = reportError(err, '读取目录失败');
      if (state.items.length === 0) renderEmpty(e.message || '读取目录失败', true);
    } finally {
      if (seq !== listSeq) return;
      state.loading = false;
      renderListFoot();
      updateSelectAll();
      maybeAutoFill();
    }
  }

  /** 首屏不足一屏且仍有下一页时继续拉取，保证滚动容器可滚动。 */
  function maybeAutoFill() {
    if (!state.hasMore || state.loading) return;
    if (el.listwrap.scrollHeight <= el.listwrap.clientHeight + 8) {
      loadPage({});
    }
  }

  function createRow(item) {
    var row = h('div', 'row');
    row.dataset.fid = String(item.fid);
    row.setAttribute('role', 'listitem');

    var cbCell = h('span', 'cb-cell');
    var label = h('label', 'cb');
    var input = h('input');
    input.type = 'checkbox';
    input.setAttribute('aria-label', '选择 ' + item.name);
    label.appendChild(input);
    label.appendChild(h('i'));
    cbCell.appendChild(label);
    row.appendChild(cbCell);

    var nameCell = h('span', 'col-name');
    var ic = h('span', 'fileicon ' + catClass(item));
    ic.appendChild(icon(iconFor(item)));
    nameCell.appendChild(ic);
    nameCell.appendChild(h('span', 'fname', item.name));
    row.appendChild(nameCell);

    row.appendChild(h('span', 'col-size', item.dir ? '—' : fmtSize(item.size)));
    row.appendChild(h('span', 'col-time', fmtTime(item.updatedAt || item.createdAt)));

    var ops = h('span', 'col-ops');
    OPS.forEach(function (op) {
      var b = h('button', 'op' + (op.danger ? ' danger' : ''));
      b.type = 'button';
      b.dataset.op = op.key;
      b.title = op.title;
      b.setAttribute('aria-label', op.title);
      b.appendChild(icon(op.icon));
      ops.appendChild(b);
    });
    row.appendChild(ops);
    return row;
  }

  function updateRow(row, item) {
    var nameEl = row.querySelector('.fname');
    if (nameEl && nameEl.textContent !== item.name) nameEl.textContent = item.name;
    var sizeEl = row.querySelector('.col-size');
    var sizeText = item.dir ? '—' : fmtSize(item.size);
    if (sizeEl && sizeEl.textContent !== sizeText) sizeEl.textContent = sizeText;
    var timeEl = row.querySelector('.col-time');
    var timeText = fmtTime(item.updatedAt || item.createdAt);
    if (timeEl && timeEl.textContent !== timeText) timeEl.textContent = timeText;
    var icWrap = row.querySelector('.fileicon');
    var want = 'fileicon ' + catClass(item);
    if (icWrap && icWrap.className !== want) {
      icWrap.className = want;
      icWrap.textContent = '';
      icWrap.appendChild(icon(iconFor(item)));
    }
    var cb = row.querySelector('input[type=checkbox]');
    var sel = state.selected.has(String(item.fid));
    if (cb && cb.checked !== sel) cb.checked = sel;
    if (row.classList.contains('selected') !== sel) row.classList.toggle('selected', sel);
  }

  /** Visible rows only: data and selection survive when their DOM nodes leave the viewport. */
  async function renderRows(seq) {
    if (seq !== listSeq) return;
    if (!topSpacer) {
      topSpacer = h('div', 'list-spacer');
      bottomSpacer = h('div', 'list-spacer');
      topSpacer.setAttribute('aria-hidden', 'true');
      bottomSpacer.setAttribute('aria-hidden', 'true');
      el.list.appendChild(topSpacer);
      el.list.appendChild(bottomSpacer);
    }
    var rowHeight = parseFloat(getComputedStyle(el.list).getPropertyValue('--row-h')) || 46;
    var range = window.QKVirtualList.range(state.items.length, el.listwrap.scrollTop,
      el.listwrap.clientHeight || 600, rowHeight, VIRTUAL_OVERSCAN);
    var visible = new Set();
    for (var i = range.start; i < range.end; i++) visible.add(String(state.items[i].fid));
    rowMap.forEach(function (row, fid) {
      if (!visible.has(fid)) {
        if (row.parentNode) row.parentNode.removeChild(row);
        rowMap.delete(fid);
      }
    });
    topSpacer.style.height = range.before + 'px';
    bottomSpacer.style.height = range.after + 'px';
    var ref = topSpacer.nextSibling;
    for (var j = range.start; j < range.end; j++) {
      var item = state.items[j];
      var key = String(item.fid);
      var row = rowMap.get(key);
      if (!row) {
        row = createRow(item);
        rowMap.set(key, row);
      }
      updateRow(row, item);
      row.setAttribute('aria-posinset', String(j + 1));
      row.setAttribute('aria-setsize', String(state.total >= 0 ? state.total : state.items.length));
      if (row === ref) ref = ref.nextSibling;
      else el.list.insertBefore(row, ref || bottomSpacer);
    }
    updateSelectAll();
    if (!state.items.length) renderEmpty(state.mode === 'search' ? '没有找到匹配的文件' : '这个文件夹是空的', false);
    else clearEmpty();
  }

  function scheduleRows() {
    if (listFrame !== null) return;
    listFrame = requestAnimationFrame(function () {
      listFrame = null;
      if (state.view === 'files') renderRows(listSeq);
    });
  }

  function renderEmpty(message, isError) {
    clearEmpty();
    var box = h('div', 'empty' + (isError ? ' empty-error' : ''));
    box.id = 'list-empty';
    box.appendChild(icon(isError ? 'error' : 'folder-open', 'empty-ic'));
    box.appendChild(h('div', 'empty-title', message));
    if (!isError) {
      box.appendChild(h('div', 'empty-sub', state.mode === 'search'
        ? '换个关键词试试，或清空搜索返回浏览。'
        : '把文件拖拽到窗口，或点击右上角「上传」。'));
    }
    el.listwrap.appendChild(box);
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
      foot.appendChild(h('div', 'foot-line muted', '向下滚动加载更多'));
      return;
    }
    var totalText = state.total >= 0
      ? '已全部加载，共 ' + state.total + ' 项'
      : (state.items.length ? '没有更多了' : '');
    if (!totalText) return;
    foot.appendChild(h('div', 'foot-line muted', totalText));
  }

  function updateSelectAll() {
    var box = el.checkAll;
    var loaded = state.items.length;
    var selCount = 0;
    state.selected.forEach(function (fid) { if (state.itemMap[fid]) selCount += 1; });
    box.checked = loaded > 0 && selCount === loaded;
    box.indeterminate = selCount > 0 && selCount < loaded;
    box.disabled = loaded === 0;

    var n = state.selected.size;
    if (n > 0) {
      el.bulkbar.hidden = false;
      el.bulkCount.textContent = '已选 ' + n + ' 项' + (selCount !== n ? '（含已隐藏项）' : '');
    } else {
      el.bulkbar.hidden = true;
    }
  }

  function setSelected(fid, on) {
    fid = String(fid);
    if (on) state.selected.add(fid); else state.selected.delete(fid);
    var row = rowMap.get(fid);
    if (row) {
      row.classList.toggle('selected', on);
      var cb = row.querySelector('input[type=checkbox]');
      if (cb) cb.checked = on;
    }
    updateSelectAll();
  }

  function clearSelection() {
    var fids = Array.from(state.selected);
    state.selected.clear();
    fids.forEach(function (fid) {
      var row = rowMap.get(fid);
      if (row) {
        row.classList.remove('selected');
        var cb = row.querySelector('input[type=checkbox]');
        if (cb) cb.checked = false;
      }
    });
    state.lastIndex = -1;
    updateSelectAll();
  }

  /**
   * 切换选中态。
   * 重要：调用方**不能**对复选框的 click 调用 preventDefault —— 浏览器会在事件派发结束后
   * 把 checked 回滚到点击前的值，导致"状态已选中但复选框显示未勾选"。
   * 因此这里以复选框原生切换后的 checked 为准，再同步 state。
   */
  function toggleSelect(fid, index, e) {
    fid = String(fid);
    var shift = e && e.shiftKey;
    var ctrl = e && (e.ctrlKey || e.metaKey);
    var row = rowMap.get(fid);
    var box = row ? row.querySelector('input[type=checkbox]') : null;
    var checkboxClick = e && e.target && e.target.type === "checkbox";
    var on = checkboxClick && box ? !!box.checked : !state.selected.has(fid);

    if (shift && state.lastIndex >= 0) {
      var a = Math.min(state.lastIndex, index);
      var b = Math.max(state.lastIndex, index);
      for (var i = a; i <= b; i++) {
        var it = state.items[i];
        if (it) {
          if (on) state.selected.add(String(it.fid)); else state.selected.delete(String(it.fid));
        }
      }
      renderRows(listSeq);
      state.lastIndex = index;
      return;
    }
    if (ctrl) {
      setSelected(fid, on);
      state.lastIndex = index;
      return;
    }
    clearSelection();
    if (on) setSelected(fid, true);
    state.lastIndex = index;
  }

  /* ================================================================== *
   * 文件操作
   * ================================================================== */

  var OPS = [
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

  /** 目录分页加载：把一条异步任务受理结果轮询到结束，再刷新列表。 */
  async function awaitTask(accepted, what) {
    if (!accepted) { setTimeout(reloadCurrent, 700); return; }
    if (accepted.done === true) { setTimeout(reloadCurrent, 300); return; }
    var taskId = accepted.taskId;
    if (!taskId) { setTimeout(reloadCurrent, 900); return; }
    for (var i = 0; i < TASK_POLL_MAX; i++) {
      await sleep(TASK_POLL_MS);
      try {
        var arr = await API.fs.taskStatus({ taskIds: [taskId] });
        var st = arr && arr[0];
        if (st && st.done === true) {
          reloadCurrent();
          if (what) toast('info', what + '完成');
          return;
        }
      } catch (err) {
        reportError(err, '任务状态查询失败，尚未确认操作完成');
        reloadCurrent();
        return;
      }
    }
    toast('warn', '尚未确认任务完成，请刷新后检查结果');
    reloadCurrent();
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function downloadItems(items) {
    var files = (items || []).filter(function (i) { return i && !i.dir; });
    if (!files.length) { toast('warn', '所选项目中没有可下载的文件'); return; }
    var dir = state.settings.downloadDir;
    if (!dir) {
      try {
        dir = await API.dialog.saveDir();
      } catch (err) { reportError(err, '选择下载目录失败'); return; }
      if (!dir) { toast('warn', '未选择下载目录，已取消下载'); return; }
      await saveSettings({ downloadDir: dir });
    }
    try {
      var ids = await API.transfer.download({
        fids: files.map(function (f) { return f.fid; }),
        localDir: dir,
        names: files.map(function (f) { return f.name; })
      });
      var n = Array.isArray(ids) ? ids.length : files.length;
      toast('info', '已加入下载队列：' + n + ' 个文件');
      refreshTransfers();
    } catch (err) {
      reportError(err, '下载失败');
    }
  }

  async function doUploadPaths(paths) {
    if (!paths || !paths.length) return;
    if (state.mode === 'search') {
      toast('warn', '搜索状态下请先返回浏览目录再上传');
      return;
    }
    try {
      var ids = await API.transfer.upload({ localPaths: paths, pdirFid: state.fid });
      var n = Array.isArray(ids) ? ids.length : paths.length;
      toast('info', '已加入上传队列：' + n + ' 个文件，上传到「' + currentDirName() + '」');
      refreshTransfers();
      setView('transfers');
    } catch (err) {
      reportError(err, '上传失败');
    }
  }

  async function onUploadClick() {
    if (!API.injected) { toast('warn', '未注入桥接层，无法上传'); return; }
    try {
      var paths = await API.dialog.pickFiles();
      if (!paths || !paths.length) return;
      await doUploadPaths(paths);
    } catch (err) {
      reportError(err, '选择文件失败');
    }
  }

  async function onMkdirClick() {
    if (state.mode === 'search') { toast('warn', '搜索状态下不能新建文件夹，请先返回浏览目录'); return; }
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
      var accepted = await API.fs.mkdir({ pdirFid: state.fid, name: name });
      toast('info', '已提交创建「' + name + '」');
      awaitTask(accepted, '创建文件夹');
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
    if (!item) return;
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
      var row = rowMap.get(String(item.fid));
      if (row) updateRow(row, item);
      toast('info', '已重命名为「' + name + '」');
      // 契约中 rename 返回 TaskAccepted：服务端无 task_id 时是 {done:true}，
      // 若确实返回了异步任务则同样轮询到结束再刷新。
      if (accepted && accepted.taskId && accepted.done !== true) {
        awaitTask(accepted, '重命名');
      }
    } catch (err) {
      reportError(err, '重命名失败');
    }
  }

  async function doTransferOp(kind, items) {
    var list = (items || []).filter(Boolean);
    if (!list.length) return;
    var isMove = kind === 'move';
    var exclude = list.filter(function (i) { return i.dir; }).map(function (i) { return String(i.fid); });
    var targetFid = await pickDirDialog({
      title: isMove ? '选择移动到的目录' : '选择复制到的目录',
      confirmText: isMove ? '移动到此处' : '复制到此处',
      excludeFids: exclude
    });
    if (targetFid === null || targetFid === undefined) return;
    if (isMove) {
      var sameDir = state.mode === 'browse'
        ? String(targetFid) === String(state.fid)
        : list.every(function (i) {
            return i.pdirFid !== undefined && i.pdirFid !== null && String(i.pdirFid) === String(targetFid);
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
      var accepted = isMove
        ? await API.fs.move({ fids: list.map(function (i) { return i.fid; }), toFid: targetFid })
        : await API.fs.copy({ fids: list.map(function (i) { return i.fid; }), toFid: targetFid });
      toast('info', '已提交' + (isMove ? '移动' : '复制') + '：' + list.length + ' 个项目');
      clearSelection();
      awaitTask(accepted, isMove ? '移动' : '复制');
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
    var list = (items || []).filter(Boolean);
    if (!list.length) return;
    var o = opts || {};
    var folderCount = list.filter(function (i) { return i.dir; }).length;
    // 二次确认：删除一律为危险操作，按钮红色
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
      var accepted = await API.fs.remove({ fids: list.map(function (i) { return i.fid; }) });
      toast('info', '已提交删除：' + list.length + ' 个项目');
      clearSelection();
      awaitTask(accepted, '删除');
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

  function createTransferRow(t) {
    var row = h('div', 'trow');
    row.dataset.id = t.id;

    var ic = h('span', 'ticon');
    ic.appendChild(icon(t.kind === 'upload' ? 'upload' : 'download'));
    row.appendChild(ic);

    var info = h('div', 'tinfo');
    var line1 = h('div', 'tname-row');
    line1.appendChild(h('span', 'tname', t.name));
    line1.appendChild(h('span', 'tdir ' + (t.kind === 'upload' ? 'up' : 'down'), t.kind === 'upload' ? '上传' : '下载'));
    info.appendChild(line1);

    var meta = h('div', 'tmeta');
    meta.appendChild(h('span', 'tstate', STATUS_TEXT[t.status] || t.status));
    meta.appendChild(h('span', 'tdot', '·'));
    meta.appendChild(h('span', 'tbytes', ''));
    meta.appendChild(h('span', 'tspeed', ''));
    meta.appendChild(h('span', 'teta', ''));
    var terr = h('span', 'terror');
    terr.hidden = true;
    meta.appendChild(terr);
    info.appendChild(meta);

    var bar = h('div', 'tbar');
    bar.appendChild(h('i'));
    info.appendChild(bar);
    row.appendChild(info);

    var ops = h('div', 'tops');
    ops.dataset.ops = '';
    row.appendChild(ops);

    updateTransferRow(row, t);
    return row;
  }

  function updateTransferRow(row, t) {
    var pct = t.size > 0 ? Math.min(100, Math.max(0, (t.transferred / t.size) * 100)) : (t.status === 'done' ? 100 : 0);
    var bar = row.querySelector('.tbar > i');
    if (bar && bar.dataset.pct !== String(pct)) {
      bar.dataset.pct = String(pct);
      bar.style.width = pct.toFixed(2) + '%';
    }
    var stateEl = row.querySelector('.tstate');
    var stText = STATUS_TEXT[t.status] || t.status;
    if (stateEl && stateEl.textContent !== stText) stateEl.textContent = stText;
    row.dataset.status = t.status;

    var bytes = fmtSize(t.transferred) + ' / ' + fmtSize(t.size);
    var bytesEl = row.querySelector('.tbytes');
    if (bytesEl && bytesEl.textContent !== bytes) bytesEl.textContent = bytes;

    var sp = t.status === 'running' ? fmtSpeed(t.speed) : '';
    var spEl = row.querySelector('.tspeed');
    if (spEl && spEl.textContent !== sp) spEl.textContent = sp;

    var eta = t.status === 'running' ? fmtEta(t.eta) : '';
    var etaEl = row.querySelector('.teta');
    if (etaEl && etaEl.textContent !== eta) etaEl.textContent = eta;

    var errEl = row.querySelector('.terror');
    var errText = t.status === 'error'
      ? ('失败：' + (t.error || '未知错误') + (t.errorCode ? '（' + t.errorCode + '）' : '') +
        (t.attempts ? ' · 已重试 ' + t.attempts + ' 次' : ''))
      : '';
    if (errEl) {
      var showErr = !!errText;
      if (errEl.hidden === showErr) errEl.hidden = !showErr;
      if (errEl.textContent !== errText) errEl.textContent = errText;
    }

    var ops = row.querySelector('.tops');
    var wantKeys = transferActions(t).map(function (a) { return a.key; }).join(',');
    if (ops.dataset.ops !== wantKeys) {
      ops.dataset.ops = wantKeys;
      ops.textContent = '';
      transferActions(t).forEach(function (a) {
        var b = h('button', 'op' + (a.danger ? ' danger' : ''));
        b.type = 'button';
        b.dataset.tact = a.key;
        b.title = a.title;
        b.setAttribute('aria-label', a.title);
        b.appendChild(icon(a.icon));
        ops.appendChild(b);
      });
    }
  }

  function renderTransfers() {
    var list = state.transfers || [];
    var alive = new Set();
    list.forEach(function (t) {
      alive.add(t.id);
      var row = transferMap.get(t.id);
      if (!row) {
        row = createTransferRow(t);
        transferMap.set(t.id, row);
        el.tlist.appendChild(row);
      } else {
        updateTransferRow(row, t);
      }
    });
    transferMap.forEach(function (row, id) {
      if (!alive.has(id)) {
        if (row.parentNode) row.parentNode.removeChild(row);
        transferMap.delete(id);
      }
    });

    var active = list.filter(function (t) { return t.status === 'running' || t.status === 'pending'; }).length;
    var finished = list.filter(function (t) { return t.status === 'done' || t.status === 'canceled'; }).length;
    el.transfersSummary.textContent = list.length
      ? ('共 ' + list.length + ' 个任务' + (active ? '，进行中 ' + active + ' 个' : '') + (finished ? '，已结束 ' + finished + ' 个' : ''))
      : '';

    if (!list.length) {
      if (!el.tlist.querySelector('.empty')) {
        var box = h('div', 'empty');
        box.appendChild(icon('transfer', 'empty-ic'));
        box.appendChild(h('div', 'empty-title', '暂无传输任务'));
        box.appendChild(h('div', 'empty-sub', '上传或下载文件后，任务会显示在这里。'));
        el.tlist.appendChild(box);
      }
    } else {
      var old = el.tlist.querySelector('.empty');
      if (old) old.parentNode.removeChild(old);
    }

    if (active > 0) {
      el.transferBadge.hidden = false;
      el.transferBadge.textContent = String(active);
    } else {
      el.transferBadge.hidden = true;
    }
  }

  async function refreshTransfers() {
    var seq = ++transferSeq;
    try {
      var list = await API.transfer.list();
      if (seq !== transferSeq) return;
      state.transfers = Array.isArray(list) ? list : [];
      state.transfersLoaded = true;
      renderTransfers();
    } catch (err) {
      if (!API.injected) return;
      reportError(err, '读取传输列表失败');
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
            // Tauri commands commonly return JSON null after a successful shell action.
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
      return t.status === 'done' || t.status === 'canceled';
    }).map(function (t) { return t.id; });
    if (!ids.length) { toast('info', '没有已结束的任务需要清除'); return; }
    var ok = await confirmDialog({
      title: '清除传输记录',
      message: '将从列表中移除 ' + ids.length + ' 个已结束的任务记录。',
      detail: '仅清除记录，不会删除已下载的本地文件或云盘文件。',
      confirmText: '清除'
    });
    if (!ok) return;
    try {
      await API.transfer.clear(ids);
      toast('info', '已清除 ' + ids.length + ' 条记录');
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
    ag.loaded = true;
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
    Array.prototype.forEach.call(el.themeSeg.querySelectorAll('.seg'), function (b) {
      var on = b.dataset.theme === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  async function loadSettings() {
    el.envHint.textContent = API.bridgeInfo().text;
    try {
      var s = await API.settings.get();
      if (s && typeof s === 'object') {
        state.settings = {
          downloadDir: s.downloadDir || '',
          uploadConcurrency: Number(s.uploadConcurrency) || 2,
          downloadConcurrency: Number(s.downloadConcurrency) || 2,
          downloadParallel: Number(s.downloadParallel) || 16,
          downloadStrategy: ['auto', 'sequential', 'parallel'].indexOf(s.downloadStrategy) >= 0 ? s.downloadStrategy : 'auto',
          uploadPartConcurrency: Number(s.uploadPartConcurrency) || 3,
          theme: s.theme === 'dark' ? 'dark' : 'light'
        };
        applyTheme(state.settings.theme);
        renderSettings();
        return;
      }
    } catch (err) {
      if (API.injected && !API.isMock) reportError(err, '读取设置失败');
    }
    applyTheme(state.settings.theme);
    renderSettings();
  }

  function renderSettings() {
    el.dlDir.value = state.settings.downloadDir || '';
    el.dlDir.placeholder = state.settings.downloadDir ? '' : '尚未设置（首次下载时会提示选择）';
    el.upConc.value = state.settings.uploadConcurrency;
    el.downConc.value = state.settings.downloadConcurrency;
    if (el.upPart) el.upPart.value = state.settings.uploadPartConcurrency;
    if (el.downParallel) el.downParallel.value = state.settings.downloadParallel;
    if (el.downStrategy) el.downStrategy.value = state.settings.downloadStrategy;
    applyTheme(state.settings.theme);
    var a = state.account;
    el.setAccountHint.textContent = !API.injected
      ? '未注入桥接层，无法读取登录状态。'
      : (a && a.expired ? '登录状态已失效，请点击「重新登录」。'
        : (a && a.loggedIn ? '当前已登录：' + (a.nickname || '未知账号') + '（' + (a.memberLabel || '普通用户') + '）'
          : '当前未登录。'));
  }

  async function saveSettings(patch) {
    try {
      var s = await API.settings.set(patch);
      if (s && typeof s === 'object') Object.assign(state.settings, s);
      applyTheme(state.settings.theme);
      renderSettings();
      return true;
    } catch (err) {
      renderSettings();
      reportError(err, '保存设置失败');
      return false;
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
   * 重装前备份（Phase-2）：分批发现 + 水位背压 + 可恢复上传
   * ================================================================== */

  var BACKUP_POLL_MS = 2000;      // 运行中状态轮询周期（离开/隐藏视图即停）
  var BACKUP_SAMPLE_MAX = 5;      // plan 预览最多展示的示例条数
  var BACKUP_ISSUE_MAX = 5;       // 验证问题最多逐条展示数（明细始终纯文本）

  var backup = {
    pollTimer: null,              // 轮询句柄（真实环境 setInterval；测试沙箱为可手动驱动的桩）
    planned: null,                // 最近一次 backup.plan 结果
    pollBusy:false, lastStatus:null, taskOffset:0, taskBusy:false,
    bindDone: false               // 事件绑定只做一次
  };

  /** 备份是否可用（桥接层已注入且提供 backup.plan）。 */
  function backupBridgeReady() {
    return !!API.injected && API.has('backup', 'plan');
  }

  function backupNum(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function backupBindOnce() {
    if (backup.bindDone) return;
    backup.bindDone = true;
    var pick = $('backup-pick-dir');
    var plan = $('backup-plan');
    var start = $('backup-start');
    var retry = $('backup-retry');
    var cancel = $('backup-cancel');
    var verify = $('backup-verify');
    if (pick) pick.addEventListener('click', function () {
      API.dialog.pickDirs().then(function (picked) {
        var dir = Array.isArray(picked) ? picked[0] : picked;
        if (!dir) return;
        $('backup-root').value = String(dir);
        backup.planned=null;
        $('backup-start').disabled=false;
        $('backup-plan-result').hidden = true;
        $('backup-verify-result').hidden = true;
      }).catch(function (e) { toast('error', '选择目录失败：' + agentErrText(e)); });
    });
    $('backup-pick-target').addEventListener('click',async function(){var fid=await pickDirDialog({title:'选择备份云端目录',confirmText:'备份到此处'});if(fid!==null){$('backup-target').value=String(fid);backup.planned=null;$('backup-verify-result').hidden=true;}});
    $('backup-use-current').addEventListener('click',function(){$('backup-target').value=String(state.fid||'0');backup.planned=null;toast('info','已使用当前文件目录作为云端目标');});
    $('backup-pause').addEventListener('click',async function(){var b=$('backup-pause');b.disabled=true;try{var s=await (backup.lastStatus&&backup.lastStatus.paused?API.backup.resume():API.backup.pause());backup.lastStatus=s;renderBackupStats(s);startBackupPolling();}catch(e){toast('error',agentErrText(e));}finally{b.disabled=false;}});
    $('backup-export').addEventListener('click',async function(){var b=$('backup-export');b.disabled=true;try{var r=await API.backup.export();if(r&&!r.canceled)toast('ok','已导出 '+fmtInt(r.exported)+' 项任务及排除记录');}catch(e){toast('error','导出失败：'+agentErrText(e));}finally{b.disabled=false;}});
    $('backup-tasks-prev').addEventListener('click',function(){backup.taskOffset=Math.max(0,backup.taskOffset-40);backupLoadTasks();});
    $('backup-tasks-next').addEventListener('click',function(){backup.taskOffset+=40;backupLoadTasks();});
    if (plan) plan.addEventListener('click', function () {
      if (!backupBridgeReady()) { toast('error', '未注入桥接层，无法预览备份'); return; }
      var root = String($('backup-root').value || '').trim();
      if (!root) { toast('error', '请先选择本地目录'); return; }
      var fid = String($('backup-target').value || '').trim() || '0';
      plan.disabled = true;
      $('backup-plan-result').hidden=false;
      $('backup-plan-result').textContent='正在进行有限预览，可直接开始备份；总量将在备份过程中继续统计…';
      API.backup.plan({ rootDir: root, targetFid: fid }).then(function (r) {
        backup.planned = r && typeof r === 'object' ? r : null;
        $('backup-start').disabled = false;
        renderBackupPlan(r);
      }).catch(function (e) {
        // 预览失败：收回旧结果并锁住「开始备份」，不允许盲传
        $('backup-start').disabled = true;
        renderBackupPlan(null);
        toast('error', '预览失败：' + agentErrText(e));
      }).finally(function () { plan.disabled = false; });
    });
    if (start) start.addEventListener('click', function () {
      if (!backupBridgeReady()) { toast('error', '未注入桥接层，无法开始备份'); return; }
      var root = String($('backup-root').value || '').trim();
      var fid = String($('backup-target').value || '').trim() || '0';
      if (!root) { toast('error', '请先选择本地目录'); return; }
      start.disabled = true;
      API.backup.start({ rootDir: root, targetFid: fid, config:{bandwidthLimitBps:Math.floor(Math.max(0,Number($('backup-bandwidth').value)||0)*1024*1024),discoveryBatchSize:clampInt($('backup-batch-size').value,1,5000,500),highWatermark:Math.max(1000,clampInt($('backup-batch-size').value,1,5000,500)),lowWatermark:500,uploadConcurrency:clampInt($('backup-concurrency').value,1,8,2)} }).then(function () {
        $('backup-plan-result').hidden = true;
        $('backup-run').hidden = false;
        startBackupPolling();
      }).catch(function (e) {
        toast('error', '启动失败：' + agentErrText(e));
      }).finally(function () { start.disabled = false; });
    });
    if (retry) retry.addEventListener('click', function () {
      API.backup.retry().then(function (r) {
        toast('ok', '已重新入队 ' + fmtInt(r && r.requeued) + ' 个失败任务');
      }).catch(function (e) { toast('error', '重试失败：' + agentErrText(e)); });
    });
    if (cancel) cancel.addEventListener('click', function () {
      API.backup.cancel().then(function () {
        stopBackupPolling();
        $('backup-run').hidden = true;
        toast('ok', '备份已取消（任务现场保留，同一目录再次开始会续传）');
      }).catch(function (e) { toast('error', '取消失败：' + agentErrText(e)); });
    });
    if (verify) verify.addEventListener('click', function () {
      verify.disabled = true;
      API.backup.verify({ sampleRatePpm: Number($('backup-sample-rate').value) || 10000 }).then(function (r) {
        renderBackupVerify(r);
        backupPollOnce();
      }).catch(function (e) { toast('error', '验证失败：' + agentErrText(e)); })
        .finally(function () { verify.disabled = false; });
    });
  }

  /** 进入备份视图：绑定事件并探测是否已有会话在跑（恢复运行区与轮询）。 */
  function ensureBackup() {
    backupBindOnce();
    if (!backupBridgeReady()) return;
    API.backup.status().then(function (st) {
      if (!st || typeof st !== 'object' || !(st.hasSession || st.running)) return;
      var runBox = $('backup-run');
      if (runBox) runBox.hidden = false;
      startBackupPolling();
    }).catch(function () { /* 状态探测失败不打扰用户 */ });
  }

  function startBackupPolling() {
    stopBackupPolling();
    if (state.view !== 'backup') return;
    backupPollOnce();
    backup.pollTimer = setInterval(backupPollTick, BACKUP_POLL_MS);
  }

  function backupPollTick() {
    // 离开/隐藏视图：立即停掉周期，不再发任何查询
    if (state.view !== 'backup') { stopBackupPolling(); return; }
    backupPollOnce();
  }

  function stopBackupPolling() {
    if (backup.pollTimer) { clearInterval(backup.pollTimer); backup.pollTimer = null; }
  }

  function backupPollOnce() {
    if (!backupBridgeReady() || state.view !== 'backup' || backup.pollBusy) return Promise.resolve(null);
    backup.pollBusy=true;
    return API.backup.status().then(function (st) {
      if (!st || typeof st !== 'object') return st;
      if (!(st.hasSession || st.running)) {
        // 会话已结束（完成或被取消）：收起运行区并停止轮询，任务现场由后端保留
        stopBackupPolling();
        var runBox = $('backup-run');
        if (runBox) runBox.hidden = true;
        return st;
      }
      backup.lastStatus=st;
      $('backup-run').hidden=false;
      renderBackupStats(st);
      backupLoadTasks();
      return st;
    }).catch(function (e) {if ($('backup-runtime-hint')) $('backup-runtime-hint').textContent='状态暂时不可用：'+agentErrText(e)+'；将继续重试';return null;}).finally(function(){backup.pollBusy=false;});
  }

  /** 状态网格键位（已上传单独用字节格式化）。 */
  var BACKUP_STAT_KEYS = [
    ['totalDiscovered', '已发现文件'], ['pending', '排队'], ['uploading', '上传中'], ['verifying', '核对中'],
    ['success', '成功'], ['failed', '失败'], ['skipped', '跳过'], ['warnings','排除与警告'], ['queueDepth', '待处理']
  ];

  function renderBackupStats(st) {
    var grid = $('backup-stats');
    if (grid) {
      grid.textContent = '';
      BACKUP_STAT_KEYS.forEach(function (kv) {
        var cell = h('div', 'backup-cell');
        cell.appendChild(h('div', 'backup-k', kv[1]));
        cell.appendChild(h('div', 'backup-v', fmtInt(st[kv[0]])));
        grid.appendChild(cell);
      });
      var upCell = h('div', 'backup-cell');
      upCell.appendChild(h('div', 'backup-k', '已上传'));
      upCell.appendChild(h('div', 'backup-v', fmtBytes(st.uploadedBytes)));
      grid.appendChild(upCell);
    }
    var titles={scanning:'正在发现文件',uploading:'正在上传',paused:'已暂停',incomplete:'备份仍有未完成项',awaiting_verification:'上传已结束，等待核验',verified:'备份核验通过',verifying_backup:'正在逐文件读回核验'};
    $('backup-status-title').textContent=titles[st.status] || '备份进行中';
    $('backup-runtime-hint').textContent=st.scanError || (st.paused && backupNum(st.failed)>0?'遇到失败项，已暂停自动处理。可重试失败，或继续其余任务；未完成项会保留在报告。':(st.status==='incomplete'?'存在失败、跳过或排除项。请检查任务清单，当前结果不能作为完整备份。':(st.scanComplete?'扫描已结束。重装前请完成核验，并保存导出的清单。':'正在逐步发现目录和文件，总量仍在统计。')));
    $('backup-pause').textContent=st.paused?'继续':'暂停';
    $('backup-verify').disabled=st.readyToVerify===false;
    $('backup-retry').disabled=backupNum(st.failed)===0;
    var issues=$('backup-runtime-issues');issues.textContent='';
    (st.issues||[]).concat(st.recentErrors||[]).slice(0,20).forEach(function(it){issues.appendChild(h('li',null,asText(it.relPath)+'：'+asText(it.message)));});
    if(st.currentFiles&&st.currentFiles.length)$('backup-runtime-hint').textContent+=' 当前：'+st.currentFiles.map(function(f){return asText(f.name);}).join('、')+' · '+fmtBytes(st.speed)+'/s';
    if(st.verification) renderBackupVerify(st.verification);
    renderBackupProgress(st);
  }

  /** 进度条：success / (discovered + success)，与后端任务库口径一致。 */
  function renderBackupProgress(st) {
    var bar = $('backup-bar');
    var pct = $('backup-pct');
    var success=Math.max(0,backupNum(st.success));
    var total=backupNum(st.totalDiscovered) || ['discovered','pending','uploading','verifying','success','failed','skipped','canceled'].reduce(function(n,k){return n+backupNum(st[k]);},0);
    var p=total?Math.min(st.scanComplete?100:99,(success/total)*100):0;
    if(bar){var fill=bar.querySelector('i')||bar.firstChild;if(fill)fill.style.width=p.toFixed(2)+'%';bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.setAttribute('aria-valuenow',String(Math.floor(p)));}
    if(pct) pct.textContent=(st.scanComplete?'已发现文件的成功率 ':'扫描中，总量仍在统计 · 已发现文件的成功率 ')+Math.floor(p)+'%（成功 '+fmtInt(success)+' / 已发现 '+fmtInt(total)+' 项）';
  }

  function backupLoadTasks() {
    if(!API.has('backup','tasks') || backup.taskBusy)return;
    backup.taskBusy=true;
    return API.backup.tasks({offset:backup.taskOffset,limit:40}).then(function(r){
      var list=$('backup-task-list');list.textContent='';
      var tasks=r&&Array.isArray(r.tasks)?r.tasks:[];
      tasks.forEach(function(t){var row=h('li','backup-task');row.appendChild(h('span','backup-task-path',asText(t.rel_path)));row.appendChild(h('span','backup-task-state',({discovered:'等待发现入队',pending:'排队',uploading:'上传中',verifying:'核对中',success:'成功',failed:'失败',skipped:'跳过',canceled:'取消'})[t.state]||asText(t.state)));if(t.last_error)row.appendChild(h('div','backup-task-error',asText(t.last_error)));list.appendChild(row);});
      $('backup-tasks-page').textContent='第 '+(Math.floor(backup.taskOffset/40)+1)+' 页';
      $('backup-tasks-prev').disabled=backup.taskOffset===0;$('backup-tasks-next').disabled=tasks.length<40;
    }).catch(function(e){$('backup-runtime-hint').textContent='读取任务清单失败：'+agentErrText(e);}).finally(function(){backup.taskBusy=false;});
  }

  /** plan 预览：统计摘要 + samples 前 5 条（全部 textContent）。 */
  function renderBackupPlan(r) {
    var box = $('backup-plan-result');
    if (!box) return;
    box.textContent = '';
    if (!r || typeof r !== 'object') { box.hidden = true; return; }
    box.hidden = false;
    if(r.truncated)box.appendChild(h('p','sethint','仅预览前5000项；总量未扫描完，备份开始后继续发现。'));
    box.appendChild(h('div', null, '发现 ' + fmtInt(r.files) + ' 个文件、' + fmtInt(r.dirs)
      + ' 个目录，共 ' + fmtBytes(r.totalBytes) + '（警告 ' + fmtInt(r.warnings)
      + ' 条，不可读项会跳过并记录）'));
    var samples = Array.isArray(r.samples) ? r.samples : [];
    if (samples.length) {
      box.appendChild(h('div', 'sethint',
        '示例（前 ' + Math.min(BACKUP_SAMPLE_MAX, samples.length) + ' 条）：'));
      var ul = h('ul', 'backup-samples');
      samples.slice(0, BACKUP_SAMPLE_MAX).forEach(function (s) {
        var li = h('li');
        li.textContent = backupSampleText(s);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
  }

  /** plan 示例条目 → 单行文本（文件路径 + 大小，或不可读警告）。 */
  function backupSampleText(s) {
    if (!s || typeof s !== 'object') return '';
    if (s.warning) {
      return '不可读：' + asText(s.warning) + (s.detail ? '（' + asText(s.detail) + '）' : '');
    }
    var name = asText(s.relPath) || '未知路径';
    var size = typeof s.size === 'number' ? '，' + fmtBytes(s.size) : '';
    return name + size;
  }

  var BACKUP_VERIFY_BADGE = { verified: '验证通过', partial: '部分一致', failed: '验证失败' };

  /** 验证结果：status 徽章 + 原始状态码 + 汇总 + issues 前 5 条（纯文本）。 */
  function renderBackupVerify(r) {
    var box = $('backup-verify-result');
    if (!box) return;
    if (!r || typeof r !== 'object') { box.hidden = true; return; }
    box.hidden = false;
    var status = asText(r.status) || 'unknown';
    box.dataset.level = status === 'verified' ? 'ok' : (status === 'partial' ? 'warn' : 'error');
    box.textContent = '';
    var badge = h('span', 'backup-verify-badge backup-verify-' + status,
      BACKUP_VERIFY_BADGE[status] || status);
    badge.title = '验证状态：' + status;
    box.appendChild(badge);
    box.appendChild(h('span', 'backup-verify-raw', status));
    box.appendChild(h('span', null, '清单一致 ' + fmtInt(r.listed_ok) + '/' + fmtInt(r.total_success)
      + '，缺失 ' + fmtInt(r.listed_missing) + '，大小不符 ' + fmtInt(r.size_mismatch)
      + '；选定核验项哈希一致 ' + fmtInt(r.sample_ok) + '/' + fmtInt(r.sample_requested === undefined ? r.sample_checked : r.sample_requested)));
    var issues = Array.isArray(r.issues) ? r.issues : [];
    var issueTotal = Math.max(issues.length, backupNum(r.issue_total));
    if (issues.length) {
      var ul = h('ul', 'backup-issues');
      issues.slice(0, BACKUP_ISSUE_MAX).forEach(function (it) {
        var li = h('li');
        li.textContent = backupIssueText(it);
        ul.appendChild(li);
      });
      if (issueTotal > BACKUP_ISSUE_MAX) {
        ul.appendChild(h('li', null, '…等共 ' + issueTotal + ' 条问题'));
      }
      box.appendChild(ul);
    }
  }

  /** 把验证问题里的字符串/对象/数组 detail 格式化为可读文本（绝不出现 [object Object]）。 */
  function backupDetailText(v) {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'object') return asText(v);
    if (Array.isArray(v)) {
      if (!v.length) return '';
      var parts = v.slice(0, 3).map(function (item) {
        if (!item || typeof item !== 'object') return asText(item);
        var p = asText(item.relPath) || asText(item.rel_path) || asText(item.dir);
        var m = asText(item.message) || asText(item.detail);
        if (p && m) return p + '：' + m;
        return p || m || JSON.stringify(item);
      }).filter(Boolean);
      var suffix = v.length > 3 ? '…等 ' + v.length + ' 项' : '';
      return parts.join('；') + suffix;
    }
    var keys = Object.keys(v);
    if (!keys.length) return '';
    var nonZero = keys.filter(function (k) { return v[k] !== 0 && v[k] !== null && v[k] !== undefined && v[k] !== ''; });
    var use = nonZero.length ? nonZero : keys;
    return use.slice(0, 6).map(function (k) {
      return k + '=' + (typeof v[k] === 'object' ? JSON.stringify(v[k]) : asText(v[k]));
    }).join('，');
  }

  /** 单条验证问题 → 一行摘要（字段名来自后端 VerifyReport.issues，全部按文本拼接）。 */
  function backupIssueText(it) {
    if (!it || typeof it !== 'object') return '';
    var kind = asText(it.kind);
    var path = asText(it.rel_path) || asText(it.dir) || asText(it.relPath);
    var extra = [];
    var expectedSize = it.expected_size !== undefined ? it.expected_size : it.local_size;
    if (expectedSize !== undefined) extra.push('本地 ' + fmtBytes(expectedSize));
    if (it.remote_size !== undefined) extra.push('远端 ' + fmtBytes(it.remote_size));
    if (it.count !== undefined) extra.push('共 ' + fmtInt(it.count) + ' 项');
    var detail = backupDetailText(it.detail);
    if (extra.length) detail = detail ? detail + '，' + extra.join('，') : extra.join('，');
    var head = (kind ? kind + '：' : '') + path;
    return head + (detail ? '（' + detail + '）' : '');
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
    state.view = view;
    Array.prototype.forEach.call(el.nav.querySelectorAll('.nav-item'), function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    el.viewFiles.hidden = view !== 'files';
    el.viewTransfers.hidden = view !== 'transfers';
    el.viewSettings.hidden = view !== 'settings';
    if (el.viewChat) el.viewChat.hidden = view !== 'chat';
    if (el.viewBackup) el.viewBackup.hidden = view !== 'backup';
    if (view !== 'backup') stopBackupPolling();   // 离开备份视图立即停轮询
    setTopbarForView();
    if (view === 'files') scheduleRows();
    if (view === 'transfers') refreshTransfers();
    if (view === 'chat') ensureChat();
    if (view === 'backup') ensureBackup();
    if (view === 'settings') {
      renderSettings();
      ensureAgent();
      // 每次进入设置页都重新拉取一次接入状态：网关可能被其它入口（桥接调用、错误导致停止）
      // 改变，只有"懒加载一次"会让面板长期显示过期状态（实机验证发现：经桥接停用后
      // 面板仍显示「运行中」）。loadAgentStatus 自带并发保护，重复调用安全。
      loadAgentStatus();
    }
  }

  /* ================================================================== *
   * 拖拽上传
   * ================================================================== */

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
      if (state.view !== 'files') return;
      el.dropmask.hidden = false;
      el.dropSub.textContent = '文件将上传到「' + currentDirName() + '」';
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

  function bindEvents() {
    // 导航
    el.nav.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.nav-item') : null;
      if (btn) setView(btn.dataset.view);
    });

    // 搜索
    el.btnUp.addEventListener('click', goUp);
    el.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        runSearch(el.searchInput.value.trim());
      } else if (e.key === 'Escape') {
        el.searchInput.value = '';
        el.searchClear.hidden = true;
        leaveSearch();
      }
    });
    el.searchInput.addEventListener('input', function () {
      el.searchClear.hidden = !el.searchInput.value;
    });
    el.searchClear.addEventListener('click', function () {
      el.searchInput.value = '';
      el.searchClear.hidden = true;
      leaveSearch();
      el.searchInput.focus();
    });

    // 顶部按钮
    el.btnUpload.addEventListener('click', onUploadClick);
    el.btnMkdir.addEventListener('click', onMkdirClick);
    el.btnRefresh.addEventListener('click', function () {
      if (state.mode === 'search') runSearch(state.keyword); else reloadCurrent();
    });

    // 列表滚动：无限加载
    el.listwrap.addEventListener('scroll', function () {
      if (state.view !== 'files') return;
      scheduleRows();
      if (state.loading || !state.hasMore) return;
      if (el.listwrap.scrollTop + el.listwrap.clientHeight >= el.listwrap.scrollHeight - 240) {
        loadPage({});
      }
    }, { passive: true });
    window.addEventListener('resize', scheduleRows);
    if (typeof ResizeObserver === 'function') {
      var listResizeObserver = new ResizeObserver(scheduleRows);
      listResizeObserver.observe(el.listwrap);
      unsubs.push(function () { listResizeObserver.disconnect(); });
    }

    // 列表交互（事件委托）
    el.list.addEventListener('click', function (e) {
      var t = e.target;
      var row = t.closest ? t.closest('.row') : null;
      if (!row) return;
      var fid = row.dataset.fid;
      var idx = state.items.findIndex(function (i) { return String(i.fid) === String(fid); });
      if (idx < 0) return;

      if (t.closest('.cb')) {
        if (t.type !== 'checkbox') return;
        // 不调用 preventDefault：让复选框自行切换后再同步选中态
        toggleSelect(fid, idx, e);
        return;
      }
      var opBtn = t.closest('.op');
      if (opBtn) {
        e.stopPropagation();
        runRowOp(opBtn.dataset.op, state.items[idx]);
        return;
      }
      var nameEl = t.closest('.fname');
      if (nameEl && e.detail === 1) {
        // 单击名称：仅选中；双击才进入（见 dblclick）
        if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
          var wasSelected = state.selected.has(String(fid));
          clearSelection();
          if (!wasSelected || state.selected.size !== 1) setSelected(fid, true);
          state.lastIndex = idx;
        } else {
          toggleSelect(fid, idx, e);
        }
      }
    });

    el.list.addEventListener('dblclick', function (e) {
      var row = e.target.closest ? e.target.closest('.row') : null;
      if (!row) return;
      if (e.target.closest('.op') || e.target.closest('.cb')) return;
      var item = findItem(row.dataset.fid);
      if (item) openItem(item);
    });

    el.list.addEventListener('contextmenu', function (e) {
      var row = e.target.closest ? e.target.closest('.row') : null;
      if (!row) return;
      e.preventDefault();
      var item = findItem(row.dataset.fid);
      if (!item) return;
      if (!state.selected.has(String(item.fid))) {
        clearSelection();
        setSelected(item.fid, true);
      }
      var entries = [];
      if (!item.dir) entries.push({ label: '下载', icon: 'download', run: function () { downloadItems([item]); } });
      if (item.dir) entries.push({ label: '打开', icon: 'folder-open', run: function () { openItem(item); } });
      entries.push({ label: '重命名', icon: 'rename', run: function () { onRename(item); } });
      entries.push({ label: '移动到…', icon: 'move', run: function () { doTransferOp('move', selectedItems()); } });
      entries.push({ label: '复制到…', icon: 'copy', run: function () { doTransferOp('copy', selectedItems()); } });
      entries.push({ sep: true });
      entries.push({ label: '删除', icon: 'trash', danger: true, run: function () { doRemove(selectedItems()); } });
      openCtx(e.clientX, e.clientY, entries);
    });

    el.checkAll.addEventListener('change', function () {
      if (el.checkAll.checked) {
        state.items.forEach(function (i) { state.selected.add(String(i.fid)); });
        rowMap.forEach(function (row, fid) {
          row.classList.add('selected');
          var cb = row.querySelector('input[type=checkbox]');
          if (cb) cb.checked = true;
        });
      } else {
        clearSelection();
      }
      updateSelectAll();
    });

    // 批量操作条
    el.bulkbar.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-bulk]') : null;
      if (b) onBulk(b.dataset.bulk);
    });

    // 传输列表
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
    el.upConc.addEventListener('change', function () {
      var v = clampInt(el.upConc.value, 1, 8, 2);
      el.upConc.value = v;
      saveSettings({ uploadConcurrency: v });
    });
    if (el.upPart) el.upPart.addEventListener('change', function () {
      var v = clampInt(el.upPart.value, 1, 8, 3);
      el.upPart.value = v;
      saveSettings({ uploadPartConcurrency: v });
    });
    el.downConc.addEventListener('change', function () {
      var v = clampInt(el.downConc.value, 1, 5, 2);
      el.downConc.value = v;
      saveSettings({ downloadConcurrency: v });
    });
    if (el.downParallel) el.downParallel.addEventListener('change', function () {
      var v = clampInt(el.downParallel.value, 1, 16, 16);
      el.downParallel.value = v;
      saveSettings({ downloadParallel: v });
    });
    if (el.downStrategy) el.downStrategy.addEventListener('change', function () {
      saveSettings({ downloadStrategy: el.downStrategy.value });
    });
    el.themeSeg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg') : null;
      if (!b) return;
      saveSettings({ theme: b.dataset.theme });
    });
    el.btnVerify.addEventListener('click', async function () {
      try {
        var s = await API.auth.verify();
        applyAccount(s);
        if (s && s.expired) toast('warn', '登录状态已失效');
        else if (s && s.loggedIn) toast('info', '登录状态有效');
        else toast('warn', '当前未登录，请先登录');
      } catch (err) { reportError(err, '校验登录状态失败'); }
    });
    el.btnLogin2.addEventListener('click', doLogin);
    el.btnLogout2.addEventListener('click', doLogout);
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
        // isComposing：中文输入法回车上屏时不发送
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          chatSend();
        }
      });
      el.chatInput.addEventListener('input', chatAutoGrow);
    }
    // 授权列表用事件委托：列表项每次渲染都会重建，委托可避免重复绑定
    [el.agentRemoteRoots, el.agentLocalReadRoots, el.agentLocalWriteRoots].forEach(function (box) {
      if (!box) return;
      box.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-agent-remove]') : null;
        if (!b) return;
        agentRemoveRoot(b.dataset.agentKind, parseInt(b.dataset.agentRemove, 10));
      });
    });

    // 全局
    document.addEventListener('click', function (e) {
      if (!el.ctx.hidden && !e.target.closest('.ctxmenu')) closeCtx();
    });
    window.addEventListener('resize', closeCtx);
    window.addEventListener('blur', closeCtx);

    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      if (e.key === 'Escape' && !typing) {
        if (!el.ctx.hidden) { closeCtx(); return; }
        if (state.selected.size) { clearSelection(); return; }
      }
      if (typing) return;
      if (state.view !== 'files') return;
      if (e.altKey && e.key === 'ArrowUp' && !document.querySelector('.overlay:not(.overlay-out)')) {
        e.preventDefault();
        goUp();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        el.checkAll.checked = true;
        el.checkAll.dispatchEvent(new Event('change'));
      } else if (e.key === 'Delete' && state.selected.size) {
        e.preventDefault();
        doRemove(selectedItems(), { bulk: state.selected.size > 1 });
      }
    });

    window.addEventListener('beforeunload', function () {
      unsubs.forEach(function (f) { try { f(); } catch (e) {} });
      unsubs = [];
      stopBackupPolling();
    });
  }

  function clampInt(v, min, max, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function runRowOp(op, item) {
    if (!item) return;
    if (op === 'download') return downloadItems([item]);
    if (op === 'rename') return onRename(item);
    if (op === 'move') return doTransferOp('move', [item]);
    if (op === 'copy') return doTransferOp('copy', [item]);
    if (op === 'remove') return doRemove([item]);
  }

  function runSearch(keyword) {
    if (!API.injected) { toast('warn', '未注入桥接层，无法搜索'); return; }
    var kw = String(keyword || '').trim();
    if (!kw) { leaveSearch(); return; }
    state.mode = 'search';
    state.keyword = kw;
    state.selected.clear();
    el.searchClear.hidden = false;
    resetList();
    renderCrumbs();
    loadPage({ reset: true });
  }

  function leaveSearch() {
    if (state.mode !== 'search') return;
    state.mode = 'browse';
    state.keyword = '';
    el.searchInput.value = '';
    el.searchClear.hidden = true;
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
    el.transferBadge = $('transfer-badge');
    el.sidebarFoot = $('sidebar-foot');
    el.btnQuit = $('btn-quit');
    el.crumbs = $('crumbs');
    el.directoryNav = $('directory-nav');
    el.btnUp = $('btn-up');
    el.btnUpLabel = $('btn-up-label');
    el.searchBox = $('search-box');
    el.searchInput = $('search-input');
    el.searchClear = $('search-clear');
    el.btnRefresh = $('btn-refresh');
    el.btnMkdir = $('btn-mkdir');
    el.btnUpload = $('btn-upload');
    el.account = $('account');
    el.viewFiles = $('view-files');
    el.viewTransfers = $('view-transfers');
    el.viewSettings = $('view-settings');
    el.bulkbar = $('bulkbar');
    el.bulkCount = $('bulk-count');
    el.checkAll = $('check-all');
    el.listwrap = $('listwrap');
    el.list = $('list');
    el.listfoot = $('listfoot');
    el.tlist = $('tlist');
    el.transfersSummary = $('transfers-summary');
    el.btnClearFinished = $('btn-clear-finished');
    el.dlDir = $('set-download-dir');
    el.upConc = $('set-up-conc');
    el.downConc = $('set-down-conc');
    el.upPart = $('set-up-part');
    el.downParallel = $('set-down-parallel');
    el.downStrategy = $('set-down-strategy');
    el.themeSeg = $('set-theme');
    el.btnPickDir = $('btn-pick-dir');
    el.btnOpenDir = $('btn-open-dir');
    el.btnVerify = $('btn-verify');
    el.btnLogin2 = $('btn-login-2');
    el.btnLogout2 = $('btn-logout-2');
    el.envHint = $('set-env');
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
    el.viewBackup = $('view-backup');
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

    var onTasks = function (tasks) {
      if (!Array.isArray(tasks)) return;
      transferSeq += 1;
      state.transfers = tasks;
      state.transfersLoaded = true;
      renderTransfers();
    };
    unsubs.push(API.transfer.onUpdate(onTasks));

    unsubs.push(API.onToast(function (payload) {
      if (!payload || typeof payload !== 'object') return;
      var level = payload.level === 'warn' || payload.level === 'error' ? payload.level : 'info';
      if (payload.message) toast(level, payload.message);
    }));

    // 对话：进度事件必须在任何 send 之前订阅，否则工具执行过程会看不到。
    // 桥接层以 chat.onEvent 暴露 Tauri 事件监听（通道名 qk:chat-event）；
    // 发送中不退订，避免丢事件导致界面卡在「处理中…」。
    unsubs.push(API.chat.onEvent(handleChatEvent));

    unsubs.push(API.onNeedLogin(function () { showExpiredBanner(); }));
  }

  async function boot() {
    cacheEls();
    if (el.btnQuit) {
      el.btnQuit.hidden = !API.has('app', 'quit');
      el.btnQuit.addEventListener('click', async function () {
        try { await API.app.quit(); }
        catch (err) { reportError(err, '退出客户端失败'); }
      });
    }
    bindEvents();
    setupDragDrop();
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

    if (!API.injected) {
      showNoBridgeBanner(info);
      // 无桥接层：仍渲染骨架与空态，不白屏、不报错
      renderCrumbs();
      renderEmpty('未注入桥接层，无法读取文件列表', true);
      el.checkAll.disabled = true;
      setTopbarForView();
      renderAccount();
      renderTransfers();
      renderSettings();
      return;
    }

    if (info.mock) {
      banner('mock', 'info', '开发假数据模式（?mock=1）：列表与传输任务均为本地假数据，未连接真实后端。', []);
    } else if (info.missing && info.missing.length) {
      banner('bridge', 'warn', '桥接层缺少以下方法：' + info.missing.join('、') + '，相关功能将不可用。', []);
    }

    subscribeChannels();
    applyTheme(state.settings.theme);
    setView('files');
    renderCrumbs();
    renderAccount();
    loadSettings();

    try {
      var acct = await API.auth.status();
      applyAccount(acct);
      if (acct && acct.expired) showExpiredBanner();
      if (acct && acct.loggedIn) refreshQuota();
    } catch (err) {
      if (API.isNeedLogin(err)) showExpiredBanner();
      else reportError(err, '读取登录状态失败');
    }

    await loadPage({ reset: true });
    refreshTransfers();
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
    navigate: navigate,
    loadPage: loadPage,
    getRowCount: function () { return rowMap.size; },
    version: '1.0.0'
  };
})();
