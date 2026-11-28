'use strict';
(function () {
  var tauri = window.__TAURI__;
  if (!tauri || !tauri.core) return;
  var invoke = function (method, params) {
    return tauri.core.invoke('qk_call', { method: method, params: params || {} });
  };
  var dot = document.getElementById('dot');
  var nameEl = document.getElementById('name');
  var stageEl = document.getElementById('stage');
  var pctEl = document.getElementById('pct');
  var barEl = document.getElementById('bar');
  var fillEl = document.getElementById('fill');
  var hintEl = document.getElementById('hint');
  var openBtn = document.getElementById('btn-open-dir');
  var targetFid = '';

  function render(info) {
    if (!info || typeof info !== 'object') return;
    var state = info.state || 'idle';
    dot.className = 'dot' + (state === 'done' ? ' done' : (state === 'error' ? ' error' : ''));
    barEl.className = 'bar' + (state === 'done' ? ' done' : (state === 'error' ? ' error' : ''));
    nameEl.textContent = info.name || '云解压任务';
    stageEl.textContent = info.stage || (state === 'done' ? '解压完成' : (state === 'error' ? '解压未完成' : '正在云端解压…'));
    var pct = Math.max(0, Math.min(100, Number(info.pct) || 0));
    pctEl.textContent = state === 'idle' ? '—' : (pct + '%');
    fillEl.style.width = (state === 'idle' ? 0 : pct) + '%';
    hintEl.textContent = info.hint || (state === 'done' ? '文件已解压至网盘目录' : '云端执行中，不占用本地带宽');
    targetFid = info.targetFid ? String(info.targetFid) : '';
    openBtn.hidden = !(state === 'done' && targetFid);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  document.getElementById('btn-main').addEventListener('click', function () {
    invoke('app.openView', { view: 'files' }).catch(function () {});
  });
  document.getElementById('btn-close').addEventListener('click', function () {
    invoke('float.close', { target: 'unarchive' }).catch(function () {});
  });
  openBtn.addEventListener('click', function () {
    if (targetFid) {
      invoke('app.openView', { view: 'files', fid: targetFid }).catch(function () {});
    }
  });

  invoke('settings.get').then(function (s) {
    if (s && s.theme) applyTheme(s.theme);
  }).catch(function () {});

  if (tauri.event && typeof tauri.event.listen === 'function') {
    tauri.event.listen('qk:unarchive-progress', function (ev) { render(ev.payload); });
    tauri.event.listen('qk:theme-changed', function (ev) { applyTheme(ev.payload); });
  }
})();
