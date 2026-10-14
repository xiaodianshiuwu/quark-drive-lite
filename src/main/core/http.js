'use strict';
/**
 * HTTP 传输层。
 *
 * 设计要点：
 * 1. **不绑定 Electron**：默认自动选择传输实现，便于在纯 Node 下做单元测试。
 *    - 优先使用 Electron `net`（走 Chromium 网络栈，自动遵循系统代理设置）；
 *    - 不可用时回退到全局 fetch（Node 18+ / 测试环境）。
 * 2. 统一注入 Cookie、Referer、User-Agent 等夸克要求的头。
 * 3. 内建超时、中止（AbortSignal）、指数退避重试。
 * 4. 统一解析响应包络并抛出 QuarkError。
 */

const { QuarkError, ErrCode, fromEnvelope, asNetworkError, isRetryable } = require('./errors');

/**
 * 请求使用的 User-Agent —— **严格按官方客户端的构造方式拼装**，而非自造。
 *
 * 证据（本机官方客户端 app.asar，dist/main/main.js）：
 *   generateUserAgentForFusionQuantumWindow =
 *     `${await quarkApp.getUserAgent()} quark-cloud-drive/${app.isPackaged?"2.5.40":"1.0.0"} Channel/${"pckk@other_ch".replace(/^(\w+?)@/,"$1_")}`
 *   getBrowserName() -> "ucpro"          // 正是查询参数 pr=ucpro 的来源
 *   getVersion()     -> isPackaged ? "2.5.40" : app.getVersion()
 *   isPcQuark()      -> getUA().indexOf("QuarkPC") > -1   // 官方以此判定自家客户端
 *
 * 因此一个"看起来与官方一致"的 UA 必须同时包含：
 *   - 标准 Chromium UA（Chrome/<ver> Safari/537.36）
 *   - `QuarkPC/<产品版本>` —— 官方用它做客户端识别
 *   - `quark-cloud-drive/2.5.40 Channel/pckk_other_ch` —— 官方模板的固定后缀
 *
 * 版本号取本机已安装的官方客户端真实值（build_info.json: product_version 4.1.5.397），
 * Chromium 版本取本应用实际使用的 Electron 内置版本，保证自洽、不露馅。
 */
const QUARK_PRODUCT_VERSION = '4.1.5.397'; // 本机官方客户端 build_info.json
const QUARK_CLOUD_DRIVE_VERSION = '2.5.40'; // 官方 isPackaged 分支固定值
const QUARK_CHANNEL = 'pckk_other_ch'; // "pckk@other_ch" 经官方 replace 后的结果
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/130.0.6723.191 Safari/537.36 QuarkPC/${QUARK_PRODUCT_VERSION} ` +
  `quark-cloud-drive/${QUARK_CLOUD_DRIVE_VERSION} Channel/${QUARK_CHANNEL}`;

/**
 * 官方客户端常量（取自其 app.asar）：
 *   UC_PARAMS_STR = "dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt"
 * 其 axios 请求拦截器形如：
 *   e.params = { uc_param_str: UC_PARAMS_STR, device_model: getDeviceNameSync(), ...e.params, ...getUcParams() }
 * 即**每个请求都携带** uc_param_str 与 device_model。
 *
 * 本项目此前传的是**空字符串**，这会让请求形态与官方不一致（保真度缺口）。
 * 现按官方字面值补齐。
 */
const UC_PARAMS_STR = 'dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt';

/** 本机设备型号（对应官方 getDeviceNameSync()）。 */
function deviceModel() {
  try {
    const os = require('os');
    const arch = os.arch();
    const release = String(os.release() || '');
    const [majorS, minorS] = release.split('.');
    const major = Number(majorS);
    const minor = Number(minorS);
    let name = 'Windows 10';
    if (major === 6 && minor === 1) name = 'Windows 7';
    else if (major === 6 && minor === 2) name = 'Windows 8';
    else if (major === 6 && minor === 3) name = 'Windows 8.1';
    else if (major === 10 && minor === 0) name = 'Windows 10';
    const bits = arch === 'x64' || arch === 'arm64' ? '64-bit' : '32-bit';
    return `${name} ${bits}`;
  } catch {
    return 'Windows 10 64-bit';
  }
}

const DEFAULT_DEVICE_MODEL = deviceModel();

/** 公共查询参数：与官方一致（pr / fr / uc_param_str / device_model）。 */
const COMMON_QUERY = Object.freeze({
  pr: 'ucpro',
  fr: 'pc',
  uc_param_str: UC_PARAMS_STR,
  device_model: DEFAULT_DEVICE_MODEL,
});

const DEFAULT_REFERER = 'https://pan.quark.cn/';
const DEFAULT_ORIGIN = 'https://pan.quark.cn';

/**
 * 传输层选择。
 *
 * ⚠️ 实测结论（真实账号，2026-10）—— 这是一个必须分流的坑：
 *
 *   同一进程内，对**夸克 CDN 直链**（如 `dl-pc-zb-j.drive.quark.cn`）发起请求：
 *     · 原生 `fetch`（Node/undici）  → HTTP 206，正常取到数据
 *     · Electron `net.fetch`        → **挂起不返回**（300 秒无响应）
 *   而请求头完全相同。因此差异在传输层本身，不在请求内容。
 *
 *   对于**夸克 API**（`drive-pc.quark.cn`），`net.fetch` 工作正常。
 *
 * 由此得出分流规则：
 *   - `cookies: true`（夸克自有 API）→ 用 Electron `net.fetch`（走 Chromium 网络栈，遵循系统代理）
 *   - `cookies: false`（CDN / OSS 直连）→ 用原生 `fetch`
 *
 * 这也解释了一个此前的谜团：下载引擎报 403/超时，而非下载逻辑本身有问题。
 */

/** 判断是否应使用原生 fetch（直连 CDN/OSS 时）。 */
function shouldUseNativeFetch(req) {
  return !!(req && (req.direct || req.cookies === false));
}

/** 选择传输实现。Electron 可用时用 net.fetch（支持系统代理）。 */
function pickTransport() {
  try {
    // 仅在 Electron 主进程内可用
    const { app, net } = require('electron');
    if (app && net && typeof net.fetch === 'function') {
      return { kind: 'electron', fetch: net.fetch.bind(net) };
    }
  } catch {
    /* 非 Electron 环境 */
  }
  if (typeof globalThis.fetch === 'function') {
    return { kind: 'node', fetch: globalThis.fetch.bind(globalThis) };
  }
  throw new QuarkError('运行环境缺少可用的网络实现', { code: ErrCode.NETWORK });
}

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
 * 构造请求 URL。
 *
 * 注意调用约定：第一个参数是 **base**，第二个是 **path**。
 *
 * ⚠️ 这里曾有一个严重 bug（真实账号下载实测暴露）：
 *   对完整 URL（CDN 直链）曾误写成 `buildUrl(path, '/', query)`——
 *   把完整 URL 当成了 base、把 `'/'` 当成了 path，
 *   于是 `new URL('/', 完整URL)` 只保留 origin，
 *   **路径与查询串全部丢失**，请求打到 `https://<cdn>/`（CDN 根路径）并返回 403。
 *   Cookie、Range 等头其实都对，因此错误极具误导性（像"直链过期"）。
 *   现已改为在 absolute 场景下直接使用完整 URL（见下方 buildAbsoluteUrl）。
 */
function buildUrl(base, path, query) {
  const isAbsolute = /^https?:\/\//i.test(String(path));
  const url = isAbsolute ? new URL(path) : new URL(path, base);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** 完整 URL（CDN/OSS 直链）场景：以它本身为基准，仅追加额外查询参数。 */
function buildAbsoluteUrl(absoluteUrl, query) {
  const url = new URL(String(absoluteUrl));
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

class HttpClient {
  /**
   * @param {object} opts
   * @param {() => string} opts.getCookie   返回当前 Cookie 头的回调（由会话管理器提供）
   * @param {(setCookie: string[]) => void} [opts.onSetCookie] 接收响应 Set-Cookie
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.retries]         默认重试次数
   * @param {number} [opts.timeout]         单次请求超时（毫秒）
   */
  constructor(opts = {}) {
    this.getCookie = opts.getCookie || (() => '');
    this.onSetCookie = opts.onSetCookie || (() => {});
    this.baseUrl = opts.baseUrl || 'https://drive-pc.quark.cn';
    this.retries = opts.retries === undefined ? 2 : opts.retries;
    this.timeout = opts.timeout === undefined ? 30000 : opts.timeout;
    // 允许显式注入传输实现（测试用）。
    this._injectedFetch = opts.fetch || null;
    // 惰性解析，理由有两条：
    //  1. 构造函数在 Electron 启动早期被调用时，net 可能尚未就绪；
    //  2. 若在构造时 bind 当时的 globalThis.fetch，之后对 globalThis.fetch 打桩将失效，
    //     测试会静默打到真实网络（本项目集成验证曾因此踩坑）。
    const t = this._injectedFetch ? { kind: 'injected', fetch: this._injectedFetch } : pickTransport();
    this.transportKind = t.kind;
    this._fetch = t.fetch;
  }

  /**
   * 解析本次请求要用的 fetch（夸克自有 API 走 Electron net.fetch，遵循系统代理）。
   */
  _resolveFetch(req) {
    if (this._injectedFetch) return this._injectedFetch;
    if (this.transportKind === 'electron') return this._fetch;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch;
    return this._fetch;
  }

  /** 直连第三方域（CDN/OSS）时使用的原生 fetch。 */
  _nativeFetch() {
    if (typeof globalThis.fetch === 'function') return globalThis.fetch;
    return this._fetch;
  }

  /**
   * 发起一次 API 请求。
   * @param {object} req
   * @param {string} req.path
   * @param {'GET'|'POST'} [req.method]
   * @param {object} [req.query]
   * @param {object} [req.body]
   * @param {object} [req.headers]
   * @param {string} [req.baseUrl]  覆盖默认基址（上传时使用 OSS 域名）
   * @param {boolean} [req.raw]     true 时返回原始 Response，不解析包络
   * @param {boolean} [req.cookies] false 时不注入 Cookie/Referer/Origin
   *                                （OSS 直传时必须为 false：OSS 不是夸克域）
   * @param {boolean} [req.direct]  直连第三方域（CDN / OSS）时为 true：
   *                                **改用原生 fetch**（Electron net.fetch 对 CDN 直链会挂起，见文件顶部注释），
   *                                但仍按需注入 Cookie 头（夸克 CDN 要求携带 Cookie，否则 412）。
   * @param {AbortSignal} [req.signal]
   * @param {number} [req.retries]
   * @param {boolean} [req.absolute] true 时 path 视为完整 URL
   */
  async request(req) {
    const {
      path,
      method = 'GET',
      query,
      body,
      headers = {},
      baseUrl = this.baseUrl,
      raw = false,
      cookies = true,
      direct = false,
      signal,
      retries = method === 'GET' ? this.retries : 0,
      absolute = false,
    } = req;

    // 注意参数顺序：buildUrl(base, path, query)。
    // absolute 场景必须单独走 buildAbsoluteUrl —— 曾经误写成 buildUrl(path, '/', ...)，
    // 导致 CDN 直链的路径被丢弃、请求打到 CDN 根而 403（详见 buildUrl 注释）。
    const url = absolute ? buildAbsoluteUrl(path, query) : buildUrl(baseUrl, path, query);

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      let handedOff = false;
      const onOuterAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) throw new QuarkError('操作已取消', { code: ErrCode.ABORTED });
        signal.addEventListener('abort', onOuterAbort, { once: true });
      }
      // timeout <= 0 表示"不设超时"（用于长时间下载/上传），而非"立即超时"。
      // 注意：setTimeout(fn, 0) 会立刻触发，因此必须显式判断，否则计时器会被误触发。
      const timeout = req.timeout === undefined ? this.timeout : req.timeout;
      const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      };

      try {
        const init = {
          method,
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9',
            ...(cookies ? { referer: DEFAULT_REFERER, origin: DEFAULT_ORIGIN } : {}),
            'user-agent': DEFAULT_UA,
            ...(cookies && this.getCookie() ? { cookie: this.getCookie() } : {}),
            ...headers,
          },
          signal: controller.signal,
        };
        if (body !== undefined) {
          if (typeof body === 'string' || Buffer.isBuffer(body)) {
            init.body = body;
          } else {
            init.body = JSON.stringify(body);
            if (!init.headers['content-type'] && !init.headers['Content-Type']) {
              init.headers['content-type'] = 'application/json';
            }
          }
        }

        // 直连 CDN/OSS（direct 或 cookies:false）必须走原生 fetch：
        // Electron net.fetch 对 CDN 直链会挂起或 403（实测），详见文件顶部说明。
        const useNative = shouldUseNativeFetch({ direct, cookies });
        const res = await (this._injectedFetch || (useNative ? this._nativeFetch() : this._resolveFetch({ cookies })))(url, init);

        // 收集 Set-Cookie，供会话管理器滚动更新（__puus/__pus）
        try {
          const sc = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
          if (cookies && sc && sc.length) this.onSetCookie(sc);
        } catch {
          /* 忽略：某些实现不支持读取 Set-Cookie */
        }

        if (raw) {
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = fromEnvelope({}, res.status);
            err.raw = text;
            throw err;
          }
          // fetch 在收到响应头时就返回；中止与超时必须一直覆盖到响应体读取结束。
          if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            const stream = new ReadableStream({
              async pull(out) {
                try {
                  const next = await reader.read();
                  if (next.done) { cleanup(); out.close(); }
                  else out.enqueue(next.value);
                } catch (e) {
                  cleanup();
                  out.error(controller.signal.aborted
                    ? new QuarkError(signal && signal.aborted ? '操作已取消' : '请求超时，请检查网络', {
                      code: signal && signal.aborted ? ErrCode.ABORTED : ErrCode.TIMEOUT,
                    })
                    : asNetworkError(e));
                }
              },
              async cancel(reason) {
                cleanup();
                await reader.cancel(reason).catch(() => {});
              },
            });
            handedOff = true;
            return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
          }
          return res;
        }

        const text = await res.text();
        let envelope;
        try {
          envelope = text ? JSON.parse(text) : {};
        } catch {
          throw new QuarkError('服务端返回了非预期的数据格式', {
            code: ErrCode.SERVER, httpStatus: res.status, raw: text,
          });
        }

        const status = envelope.status;
        const code = envelope.code;
        const ok = res.ok && (code === 0 || code === undefined) && (status === undefined || status < 400);
        if (ok) return envelope;

        const err = fromEnvelope(envelope, res.status);
        if (attempt < retries && isRetryable(err)) {
          attempt += 1;
          await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000), signal);
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof QuarkError) {
          if (e.code === ErrCode.ABORTED && (!signal || !signal.aborted)) {
            // 超时导致的中止 → 归类为 TIMEOUT
            const err = new QuarkError('请求超时，请检查网络', { code: ErrCode.TIMEOUT, cause: e });
            if (attempt < retries) {
              attempt += 1;
              await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000), signal);
              continue;
            }
            throw err;
          }
          throw e;
        }
        const err = controller.signal.aborted
          ? new QuarkError(signal && signal.aborted ? '操作已取消' : '请求超时，请检查网络', {
            code: signal && signal.aborted ? ErrCode.ABORTED : ErrCode.TIMEOUT,
          })
          : asNetworkError(e);
        if (attempt < retries && isRetryable(err)) {
          attempt += 1;
          await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000), signal);
          continue;
        }
        throw err;
      } finally {
        if (!handedOff) cleanup();
      }
    }
  }

  get(path, query, opts = {}) {
    return this.request({ ...opts, path, method: 'GET', query });
  }

  post(path, body, opts = {}) {
    return this.request({ ...opts, path, method: 'POST', body });
  }
}

module.exports = {
  HttpClient,
  DEFAULT_UA,
  DEFAULT_REFERER,
  DEFAULT_ORIGIN,
  buildUrl,
  buildAbsoluteUrl,
  sleep,
  COMMON_QUERY,
  UC_PARAMS_STR,
  DEFAULT_DEVICE_MODEL,
  QUARK_PRODUCT_VERSION,
  QUARK_CLOUD_DRIVE_VERSION,
  QUARK_CHANNEL,
};
