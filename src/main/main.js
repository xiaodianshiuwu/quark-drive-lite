'use strict';
/**
 * 主进程入口：装配全部模块 + 注册 IPC 白名单处理器 + 创建窗口。
 *
 * 安全基线（docs/IPC_CONTRACT.md 第 0 节）：
 *   contextIsolation: true / nodeIntegration: false / sandbox: true
 *   渲染进程只能通过 preload.js 暴露的白名单访问主进程能力。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fsPromises = require('fs/promises');

const { HttpClient } = require('./core/http');
const { createSecureStore } = require('./core/secure-store');
const { createSession } = require('./core/session');
const { createAccountModule } = require('./modules/account');
const { createFsModule } = require('./modules/fs');
const { createTransferModule } = require('./modules/transfer');
const { createSettingsModule } = require('./modules/settings');
const { ErrCode, QuarkError, isNeedLogin } = require('./core/errors');

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
let mainWindow = null;
let session = null;
let http = null;
let account = null;
let fsModule = null;
let transfer = null;
let settings = null;

/** 把任意异常规范成可跨 IPC 传递的形状（preload 也会兜底处理）。 */
function toIpcError(e) {
  const err = new QuarkError(e && e.message ? e.message : '操作失败', {
    code: (e && e.code) || ErrCode.UNKNOWN,
    bizCode: e && e.bizCode,
    httpStatus: e && e.httpStatus,
    raw: e && e.raw,
  });
  return err;
}

/**
 * 包装 IPC 处理器。
 *
 * 关键设计：**不通过「抛异常」跨 IPC 传错误**。
 * Electron 的 ipcRenderer.invoke 在处理器抛出时，只会把错误序列化成
 * `Error invoking remote method 'x': ...` 这一个字符串，**自定义字段（code/bizCode/raw）会全部丢失**。
 * 而 UI 依赖 `err.code === 'NEED_LOGIN'` 来弹出「登录状态已失效」提示条（需求明确要求），
 * 所以这里改为返回结果信封 { __qk: true, data } / { __qk: false, error }，
 * 由 preload 在渲染进程内还原成带 code 的真正的 Error 对象。
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      if (!mainWindow || _evt.sender !== mainWindow.webContents || _evt.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new QuarkError('已阻止未授权的窗口调用', { code: ErrCode.FORBIDDEN });
      }
      const data = await fn(...args);
      return { __qk: true, data };
    } catch (e) {
      if (isNeedLogin(e)) {
        try {
          session.markExpired();
          session.save();
          pushAuthState();
        } catch {
          /* 广播失败不影响错误返回 */
        }
      }
      const err = toIpcError(e);
      return {
        __qk: false,
        error: {
          code: err.code || ErrCode.UNKNOWN,
          message: err.message || '操作失败',
          bizCode: err.bizCode,
          httpStatus: err.httpStatus,
          raw: truncateRaw(err.raw),
        },
      };
    }
  });
}

/** 原始响应体可能较大，裁剪后再跨进程传递。 */
function truncateRaw(raw) {
  if (raw === undefined || raw === null) return undefined;
  try {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (typeof s !== 'string') return undefined;
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 推送
// ---------------------------------------------------------------------------
/**
 * 推送登录态。
 *
 * 注意：`account.status()` 是 **async**，必须 await 后再 send。
 * 若直接把 Promise 交给 webContents.send，Electron 会抛
 * `Error sending from webFrameMain: Failed to serialize arguments`，
 * 且该错误只在 stderr 出现、不会中断流程，极易被漏掉。
 */
async function pushAuthState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const state = await account.status();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('qk:auth-changed', state);
  } catch {
    /* ignore */
  }
}

function pushToast(level, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('qk:toast', { level, message });
  } catch {
    /* ignore */
  }
}

/** 传输模块的全量快照推送（节流由 transfer 模块保证 ≤ 4 次/秒） */
function pushTransferUpdate(tasks) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('qk:transfer-update', Array.isArray(tasks) ? tasks.map(sanitizeTask) : []);
  } catch {
    /* ignore */
  }
}

/**
 * 把传输任务对象裁剪成可安全序列化的纯数据。
 * 任务对象内部可能带 AbortController、Promise 等不可序列化的引用，
 * 直接 send 会触发 "Failed to serialize arguments"。
 */
function sanitizeTask(t) {
  return {
    id: String(t.id || ''),
    kind: t.kind === 'upload' ? 'upload' : 'download',
    name: String(t.name || ''),
    size: Number(t.size) || 0,
    transferred: Number(t.transferred) || 0,
    status: String(t.status || 'pending'),
    error: t.error === undefined ? undefined : String(t.error),
    errorCode: t.errorCode === undefined ? undefined : String(t.errorCode),
    attempts: Number(t.attempts) || 0,
    createdAt: Number(t.createdAt) || 0,
    updatedAt: Number(t.updatedAt) || 0,
    localPath: t.localPath === undefined ? undefined : String(t.localPath),
    pdirFid: t.pdirFid === undefined ? undefined : String(t.pdirFid),
    fid: t.fid === undefined ? undefined : String(t.fid),
    localDir: t.localDir === undefined ? undefined : String(t.localDir),
    speed: Number(t.speed) || 0,
    eta: Number.isFinite(Number(t.eta)) ? Number(t.eta) : -1,
  };
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------
function bootstrap() {
  const userDataDir = app.getPath('userData');

  const store = createSecureStore({ userDataDir, requireEncryption: true });
  session = createSession({ store }).load();

  http = new HttpClient({
    getCookie: () => session.getCookie(),
    // __puus 会随响应轮换（第三方源码确认），必须逐响应回写，否则会话会静默失效
    onSetCookie: (setCookies) => {
      try {
        session.applySetCookie(setCookies);
        session.save();
      } catch {
        /* 持久化失败不应中断请求 */
      }
    },
  });

  settings = createSettingsModule({ store });
  account = createAccountModule({ session, store, http, userDataDir });
  account.onStateChange(() => pushAuthState());
  fsModule = createFsModule({ http });
  transfer = createTransferModule({
    http,
    fsModule,
    getDownloadDir: () => settings.getDownloadDir(),
    getConcurrency: () => settings.getConcurrency(),
    onUpdate: pushTransferUpdate,
    onError: (e, task) => {
      if (isNeedLogin(e)) {
        session.markExpired();
        session.save();
        pushAuthState();
      }
      pushToast('error', `${task && task.name ? `${task.name}：` : ''}${task && task.error ? task.error : e && e.message ? e.message : '传输失败'}`);
    },
  });
}

// ---------------------------------------------------------------------------
// IPC 注册
// ---------------------------------------------------------------------------
function registerIpc() {
  // ---- auth ----
  handle('qk:auth:status', () => account.status());
  handle('qk:auth:verify', async () => {
    const s = await account.verify();
    pushAuthState();
    return s;
  });
  handle('qk:auth:login', async () => {
    const s = await account.login();
    pushAuthState();
    if (s && s.loggedIn) pushToast('info', '登录成功');
    return s;
  });
  handle('qk:auth:logout', async () => {
    await Promise.all(transfer.list().filter(t => ['running', 'pending', 'paused'].includes(t.status)).map(t => transfer.cancel(t.id)));
    await account.logout();
    pushAuthState();
    return true;
  });
  handle('qk:auth:quota', () => account.quota());
  handle('qk:auth:user-info', () => account.getUserInfo());

  // ---- fs ----
  handle('qk:fs:list', (p) => fsModule.list(p || {}));
  handle('qk:fs:search', (p) => fsModule.search(p || {}));
  handle('qk:fs:info', (fid) => fsModule.info(fid));
  handle('qk:fs:crumbs', (fid) => fsModule.crumbs(fid));
  handle('qk:fs:mkdir', (p) => fsModule.mkdir(p || {}));
  handle('qk:fs:rename', (p) => fsModule.rename(p || {}));
  handle('qk:fs:move', (p) => fsModule.move(p || {}));
  handle('qk:fs:copy', (p) => fsModule.copy(p || {}));
  handle('qk:fs:remove', (p) => fsModule.remove(p || {}));
  handle('qk:fs:task-status', (p) => fsModule.taskStatus(p || {}));

  // ---- transfer ----
  handle('qk:transfer:list', () => transfer.list());
  handle('qk:transfer:upload', (p) => transfer.upload(p || {}));
  handle('qk:transfer:download', (p) => transfer.download(p || {}));
  handle('qk:transfer:pause', (id) => transfer.pause(id));
  handle('qk:transfer:resume', (id) => transfer.resume(id));
  handle('qk:transfer:retry', (id) => transfer.retry(id));
  handle('qk:transfer:cancel', (id) => transfer.cancel(id));
  handle('qk:transfer:clear', (ids) => transfer.clear(ids));
  handle('qk:transfer:open-item', async (id) => {
    const p = transfer.openItem(id);
    if (!p) throw new QuarkError('该任务还没有产生本地文件', { code: ErrCode.NOT_FOUND });
    // 文件已下载完 → 在资源管理器中定位；否则打开所在目录
    let isFile = false;
    try {
      const st = await fsPromises.stat(p);
      isFile = st.isFile();
    } catch {
      throw new QuarkError('本地文件不存在，可能已被移动或删除', { code: ErrCode.NOT_FOUND });
    }
    if (isFile) {
      shell.showItemInFolder(p);
    } else {
      const err = await shell.openPath(p);
      if (err) throw new QuarkError(`无法打开：${err}`, { code: ErrCode.UNKNOWN });
    }
    return true;
  });

  // ---- dialog ----
  handle('qk:dialog:pick-dirs', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  handle('qk:dialog:pick-files', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  handle('qk:dialog:save-dir', async (defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || settings.getDownloadDir(),
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  /** 文件操作二次确认（需求明确要求）。返回 boolean。 */
  handle('qk:dialog:confirm', async (p) => {
    const payload = p || {};
    const r = await dialog.showMessageBox(mainWindow, {
      type: payload.danger ? 'warning' : 'question',
      buttons: [payload.confirmText || '确定', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: payload.title || '请确认',
      message: payload.message || '确定要执行该操作吗？',
      detail: payload.detail || '',
    });
    return r.response === 0;
  });

  handle('qk:dialog:open-path', async (p) => {
    if (!p) return false;
    const err = await shell.openPath(p);
    if (err) throw new QuarkError(`无法打开：${err}`, { code: ErrCode.UNKNOWN });
    return true;
  });

  handle('qk:dialog:show-in-folder', (p) => {
    if (!p) return false;
    shell.showItemInFolder(p);
    return true;
  });

  // ---- settings ----
  handle('qk:settings:get', () => settings.get());
  handle('qk:settings:set', (patch) => {
    const next = settings.set(patch || {});
    try {
      nativeTheme.themeSource = next.theme === 'dark' ? 'dark' : 'light';
    } catch {
      /* ignore */
    }
    return next;
  });

}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    title: '夸克网盘',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', async () => {
    mainWindow.show();
    // 启动后做一次静默判活：仅当本地存在登录态时才发起网络校验
    try {
      const st = await account.status();
      if (st && st.loggedIn) {
        account
          .verify()
          .then(() => pushAuthState())
          .catch(() => pushAuthState());
      }
    } catch {
      /* ignore */
    }
  });

  // 需求：不允许渲染进程被导航到外部站点
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      e.preventDefault();
      pushToast('warn', '已阻止跳转到外部页面');
    }
  });

  // 禁止在应用内打开新窗口
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    bootstrap();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
