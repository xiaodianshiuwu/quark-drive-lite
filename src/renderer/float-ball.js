'use strict';
(function () {
  var tauri = window.__TAURI__;
  if (!tauri || !tauri.core) return;
  var invoke = function (method, params) {
    return tauri.core.invoke('qk_call', { method: method, params: params || {} });
  };
  var orb = document.getElementById('orb');
  var ring = document.getElementById('ring-prog');
  var orbLabel = document.getElementById('orb-label');
  var speedEl = document.getElementById('speed');
  var metaEl = document.getElementById('meta');
  var CIRC = 113.1;

  function fmtSpeed(bps) {
    var n = Number(bps) || 0;
    if (n <= 0) return '0 B/s';
    var units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 100 ? n.toFixed(0) : (n >= 10 ? n.toFixed(1) : n.toFixed(2))) + ' ' + units[i];
  }

  function render(tasks) {
    var list = Array.isArray(tasks) ? tasks : [];
    var active = list.filter(function (t) { return t && (t.status === 'running' || t.status === 'pending'); });
    var running = list.filter(function (t) { return t && t.status === 'running'; });
    var dlSpeed = 0, ulSpeed = 0, totalBytes = 0, doneBytes = 0;
    running.forEach(function (t) {
      if (t.kind === 'upload') ulSpeed += Number(t.speed) || 0;
      else dlSpeed += Number(t.speed) || 0;
    });
    active.forEach(function (t) {
      totalBytes += Math.max(0, Number(t.size) || 0);
      doneBytes += Math.max(0, Number(t.transferred) || 0);
    });
    if (!active.length) {
      orb.classList.remove('done');
      ring.style.strokeDashoffset = String(CIRC);
      orbLabel.textContent = '就绪';
      speedEl.textContent = '暂无进行中传输';
      var doneCount = list.filter(function (t) { return t && t.status === 'done'; }).length;
      metaEl.textContent = doneCount > 0 ? ('已完成 ' + doneCount + ' 项 · 拖拽可移动') : '拖拽可移动 · 点击 ↗ 展开';
      return;
    }
    var pct = totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0;
    ring.style.strokeDashoffset = String((CIRC * (1 - pct / 100)).toFixed(1));
    orb.classList.toggle('done', pct >= 100);
    orbLabel.textContent = pct + '%';
    var parts = [];
    if (dlSpeed > 0) parts.push('↓ ' + fmtSpeed(dlSpeed));
    if (ulSpeed > 0) parts.push('↑ ' + fmtSpeed(ulSpeed));
    speedEl.textContent = parts.length ? parts.join('  ') : '等待调度…';
    metaEl.textContent = running.length + ' 进行中' + (active.length > running.length ? (' · ' + (active.length - running.length) + ' 排队') : '') + ' · ' + pct + '%';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  document.getElementById('btn-main').addEventListener('click', function () {
    invoke('app.openView', { view: 'transfers' }).catch(function () {});
  });
  document.getElementById('btn-close').addEventListener('click', function () {
    invoke('float.close', { target: 'ball' }).catch(function () {});
  });

  invoke('settings.get').then(function (s) {
    if (s && s.theme) applyTheme(s.theme);
  }).catch(function () {});
  invoke('transfer.list').then(render).catch(function () {});

  if (tauri.event && typeof tauri.event.listen === 'function') {
    tauri.event.listen('qk:transfer-update', function (ev) { render(ev.payload); });
    tauri.event.listen('qk:theme-changed', function (ev) { applyTheme(ev.payload); });
  }
})();
