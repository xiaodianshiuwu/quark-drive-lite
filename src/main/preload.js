'use strict';
/**
 * 预加载脚本 —— 渲染进程与主进程之间唯一的桥。
 *
 * 安全要求（见 docs/IPC_CONTRACT.md 第 0 节）：
 * - contextIsolation: true → 本文件运行在隔离世界，不能污染页面全局
 * - sandbox: true        → 渲染进程无 Node 权限
 * - 这里只暴露**显式白名单**的方法，绝不暴露 ipcRenderer 本体或任意通道调用能力
 *
 * 错误传递约定（重要，两条均为实测结论）：
 * 1) 主进程的 IPC 处理器**不抛异常**，而是返回结果信封 `{__qk:true,data}` / `{__qk:false,error}`。
 *    原因是 Electron 在处理器抛出时只会把错误序列化成一句
 *    `Error invoking remote method '...'`，**自定义字段会全部丢失**；
 *    而 UI 依赖 `err.code === 'NEED_LOGIN'` 来弹「登录状态已失效」提示条（需求明确要求）。
 * 2) 在 preload 里 `throw new Error()` 并附加自定义属性时，contextBridge 跨隔离世界
 *    **只保留 message，code/bizCode 会被剥掉**（实测 Object.keys 为空）；
 *    而 **throw 一个普通对象则字段完整保留**。
 *    因此这里故意抛出普通对象而非 Error（由渲染侧 api.js 归一化成 Error）。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 构造一个跨隔离世界后仍能保留全部字段的错误描述对象。 */
function errorDescriptor(desc) {
  const d = desc || {};
  const out = {
    __qkError: true,
    code: d.code || 'UNKNOWN',
    message: d.message || '操作失败',
  };
  if (d.bizCode !== undefined) out.bizCode = d.bizCode;
  if (d.httpStatus !== undefined) out.httpStatus = d.httpStatus;
  if (d.raw !== undefined) out.raw = d.raw;
  return out;
}

/** 包装一个 invoke 方法：解信封，失败则抛出字段完整的错误描述对象。 */
function invoke(channel) {
  return async (...args) => {
    let env;
    try {
      env = await ipcRenderer.invoke(channel, ...args);
    } catch (e) {
      // 兜底：处理器本身异常（例如序列化失败）而没能返回信封
      throw errorDescriptor({ code: 'UNKNOWN', message: (e && e.message) || '操作失败' });
    }
    if (env && typeof env === 'object' && env.__qk === true) return env.data;
    if (env && typeof env === 'object' && env.__qk === false) throw errorDescriptor(env.error);
    // 兼容未来可能出现的非信封返回
    return env;
  };
}

/** 订阅类通道：返回取消订阅函数。 */
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const handler = (_evt, payload) => {
    try {
      cb(payload);
    } catch {
      /* 渲染层回调异常不应影响主进程推送 */
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/**
 * 专用于 auth 状态订阅：主进程推送的可能是 Promise（历史遗留风险），
 * 这里统一 await 一次，确保订阅者拿到的是普通对象而不是 Promise。
 */
function subscribeAsync(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const handler = (_evt, payload) => {
    Promise.resolve(payload)
      .then((v) => {
        try {
          cb(v);
        } catch {
          /* 订阅者异常不影响其他订阅者 */
        }
      })
      .catch(() => {});
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  auth: {
    status: invoke('qk:auth:status'),
    verify: invoke('qk:auth:verify'),
    login: invoke('qk:auth:login'),
    logout: invoke('qk:auth:logout'),
    quota: invoke('qk:auth:quota'),
    getUserInfo: invoke('qk:auth:user-info'),
    onChange: (cb) => subscribeAsync('qk:auth-changed', cb),
  },

  fs: {
    list: invoke('qk:fs:list'),
    search: invoke('qk:fs:search'),
    info: invoke('qk:fs:info'),
    crumbs: invoke('qk:fs:crumbs'),
    mkdir: invoke('qk:fs:mkdir'),
    rename: invoke('qk:fs:rename'),
    move: invoke('qk:fs:move'),
    copy: invoke('qk:fs:copy'),
    remove: invoke('qk:fs:remove'),
    taskStatus: invoke('qk:fs:task-status'),
  },

  transfer: {
    list: invoke('qk:transfer:list'),
    upload: invoke('qk:transfer:upload'),
    download: invoke('qk:transfer:download'),
    pause: invoke('qk:transfer:pause'),
    resume: invoke('qk:transfer:resume'),
    retry: invoke('qk:transfer:retry'),
    cancel: invoke('qk:transfer:cancel'),
    clear: invoke('qk:transfer:clear'),
    openItem: invoke('qk:transfer:open-item'),
    onUpdate: (cb) => subscribe('qk:transfer-update', cb),
  },

  dialog: {
    pickDirs: invoke('qk:dialog:pick-dirs'),
    pickFiles: invoke('qk:dialog:pick-files'),
    saveDir: invoke('qk:dialog:save-dir'),
    confirm: invoke('qk:dialog:confirm'),
    openPath: invoke('qk:dialog:open-path'),
    showInFolder: invoke('qk:dialog:show-in-folder'),
    /**
     * 拖拽上传需要把 File 对象换成本地真实路径。
     * webUtils 可能不存在（版本差异），因此必须存在性检查。
     */
    getPathForFile: (file) => {
      try {
        if (!webUtils || typeof webUtils.getPathForFile !== 'function') return '';
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    },
  },

  settings: {
    get: invoke('qk:settings:get'),
    set: invoke('qk:settings:set'),
  },

  /** 统一 toast 推送 */
  onToast: (cb) => subscribe('qk:toast', cb),

  /** 与 transfer.onUpdate 等价；保留两个入口便于 UI 选择 */
  onTransferUpdate: (cb) => subscribe('qk:transfer-update', cb),

  /** 内部：暴露平台信息，便于 UI 做差异化提示 */
  platform: process.platform,
};

contextBridge.exposeInMainWorld('qk', api);
