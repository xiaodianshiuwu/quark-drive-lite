'use strict';
/** Tauri 2 adapter for the existing renderer contract; no Node or Electron runtime. */
(function (global) {
  if (global.qk) return; // Keep the original Electron build usable during migration.
  var tauri = global.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return;

  function call(method, params) {
    return tauri.core.invoke('qk_call', { method: method, params: params || {} }).catch(function (error) {
      // Tauri serializes Rust errors directly. Preserve NEED_LOGIN and protocol codes.
      if (typeof error === 'string') {
        try { error = JSON.parse(error); } catch (_) { error = { message: error }; }
      }
      var descriptor = error && typeof error === 'object' ? error : {};
      throw Object.assign({ code: 'UNKNOWN', message: '操作失败' }, descriptor);
    });
  }
  function method(name, key) {
    return function (value) {
      var params = key ? {} : (value || {});
      if (key && value !== undefined) params[key] = value;
      return call(name, params);
    };
  }
  function listen(name, callback) {
    if (typeof callback !== 'function') return function () {};
    var disposed = false;
    var off = null;
    Promise.resolve(tauri.event.listen(name, function (event) {
      if (disposed) return;
      try { callback(event.payload); } catch (_) { /* Isolate subscriber failures. */ }
    })).then(function (unsubscribe) {
      if (disposed) unsubscribe();
      else off = unsubscribe;
    }).catch(function () { /* A closed window can race event registration. */ });
    return function () { disposed = true; if (off) { off(); off = null; } };
  }
  var platform = /Mac/i.test(global.navigator.platform) ? 'darwin' :
    (/Win/i.test(global.navigator.platform) ? 'win32' : 'linux');
  var api = {
    auth: {}, fs: {}, archive: {}, recycle: {}, transfer: {}, dialog: {}, settings: {},
    agent: {}, chat: {}, hub: {},
    platform: platform, runtime: 'tauri',
    app: {
      quit: function () { return call('app.quit'); },
      info: function () { return call('app.info'); },
      openView: method('app.openView'),
      unarchiveProgress: method('float.unarchiveProgress'),
      onOpenView: function (cb) { return listen('qk:open-view', cb); },
      onSettingsSync: function (cb) { return listen('qk:settings-sync', cb); }
    },
    onToast: function (cb) { return listen('qk:toast', cb); },
    onTransferUpdate: function (cb) { return listen('qk:transfer-update', cb); }
  };
  ['status', 'verify', 'login', 'logout', 'quota', 'getUserInfo'].forEach(function (name) {
    api.auth[name] = method('auth.' + name);
  });
  api.auth.onChange = function (cb) { return listen('qk:auth-changed', cb); };
  ['list', 'search', 'mkdir', 'rename', 'move', 'copy', 'remove', 'taskStatus', 'revertRevision', 'storageDetail'].forEach(function (name) {
    api.fs[name] = method('fs.' + name);
  });
  ['info', 'crumbs', 'dirDetail', 'revisions'].forEach(function (name) { api.fs[name] = method('fs.' + name, 'fid'); });
  ['rightTimes', 'targetDir'].forEach(function (name) { api.archive[name] = method('archive.' + name, 'fid'); });
  ['preview', 'unarchive'].forEach(function (name) { api.archive[name] = method('archive.' + name); });
  api.archive.queryTask = method('archive.queryTask', 'taskId');
  ['list', 'recover', 'remove'].forEach(function (name) { api.recycle[name] = method('recycle.' + name); });
  ['list', 'upload', 'download'].forEach(function (name) { api.transfer[name] = method('transfer.' + name); });
  ['pause', 'resume', 'retry', 'cancel', 'openItem'].forEach(function (name) {
    api.transfer[name] = method('transfer.' + name, 'id');
  });
  ['pauseAll', 'resumeAll', 'retryFailed'].forEach(function (name) {
    api.transfer[name] = method('transfer.' + name);
  });
  api.transfer.clear = method('transfer.clear', 'ids');
  api.transfer.onUpdate = api.onTransferUpdate;
  ['pickDirs', 'pickFiles', 'confirm'].forEach(function (name) { api.dialog[name] = method('dialog.' + name); });
  api.dialog.saveDir = method('dialog.saveDir', 'defaultPath');
  ['openPath', 'showInFolder'].forEach(function (name) { api.dialog[name] = method('dialog.' + name, 'path'); });
  // Web File objects intentionally contain no native paths in WKWebView/WebView2.
  // Native Tauri drag/drop supplies paths through a dedicated event instead.
  api.dialog.getPathForFile = function () { return ''; };
  api.dialog.onFilesDropped = function (cb) {
    return listen('tauri://drag-drop', function (payload) {
      if (payload && Array.isArray(payload.paths)) cb(payload.paths);
    });
  };
  api.dialog.onDragEnter = function (cb) {
    return listen('tauri://drag-enter', function (payload) {
      cb(payload || {});
    });
  };
  api.dialog.onDragLeave = function (cb) {
    return listen('tauri://drag-leave', function () {
      cb();
    });
  };
  api.settings.get = method('settings.get');
  api.settings.set = method('settings.set');
  // 外部 Agent 接入（crates/quark-agent 的 runtime.handle 分发；方法名与其 match 分支一致）。
  ['status', 'enable', 'disable', 'rotate'].forEach(function (name) {
    api.agent[name] = method('agent.' + name);
  });
  // 后端命令是 agent.updateScope（agent.scope 为别名），补丁为对象
  api.agent.setScope = method('agent.updateScope');
  // journal 的标量 limit 装进 { limit } 信封；后端返回 { records: [...] }，
  // 这里解包成数组，渲染层保持 qck 的「journal() 返回记录数组」语义。
  api.agent.journal = function (limit) {
    return call('agent.journal', { limit: Number(limit) || 20 }).then(function (res) {
      if (res && Array.isArray(res.records)) return res.records;
      if (Array.isArray(res)) return res;
      // 契约漂移不应表现为"空记录"：warn 而非静默
      console.warn('[qk] agent.journal 返回形状异常', res);
      return [];
    });
  };
  api.agent.mcpConfig = function () { return call('agent.mcpConfig'); };
  // 后端只返回配置本身（无主进程剪贴板能力），复制由渲染层兜底完成
  api.agent.copyMcpConfig = function () { return call('agent.mcpConfig'); };
  // 内置对话：进度事件走 Tauri 事件通道（与 qk:auth-changed 相同的订阅方式）。
  ['status', 'saveConfig', 'clearConfig', 'test', 'models', 'clear'].forEach(function (name) {
    api.chat[name] = method('chat.' + name);
  });
  api.chat.history = function (limit) { return call('chat.history', { limit: Number(limit) || 100 }); };
  api.chat.send = function (text) { return call('chat.send', { text: String(text === undefined ? '' : text) }); };
  api.chat.onEvent = function (cb) { return listen('qk:chat-event', cb); };
  // 可选作者服务器（默认关闭，关闭时后端严格零外传）
  [
    'config', 'setOptIn', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'openReleasePage', 'openExternalUrl',
    'runtimeStatus', 'applyUiHotfix', 'reloadUi', 'uiReady', 'rollbackUi',
    'sendTelemetry', 'submitFeedback', 'listFeedback', 'replyFeedback', 'logPreview', 'recordEvent'
  ].forEach(function (name) {
    api.hub[name] = method('hub.' + name);
  });
  api.hub.onUpdateProgress = function (cb) { return listen('qk:update-progress', cb); };
  Object.keys(api).forEach(function (key) {
    if (api[key] && typeof api[key] === 'object') Object.freeze(api[key]);
  });
  global.qk = Object.freeze(api);
})(window);
