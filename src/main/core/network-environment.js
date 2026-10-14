'use strict';
// Node 与 Chromium 各自的网络栈均需遵循运行环境的代理；保持 TLS 默认校验。
let configured = false;
const chromiumSessions = new WeakMap();
function configureNativeProxy(env = process.env) {
  if (configured) return;
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
  if (!keys.some(key => env[key])) return;
  const { setGlobalProxyFromEnv } = require('node:http');
  if (typeof setGlobalProxyFromEnv !== 'function') throw new Error('当前 Node 运行时不支持环境代理，请使用 Node 24.18 或更新版本');
  setGlobalProxyFromEnv(env);
  configured = true;
}
async function configureChromiumSession(session, env = process.env) {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy || !session || typeof session.setProxy !== 'function') return;
  const bypass = env.no_proxy || env.NO_PROXY || '';
  const key = `${proxy}|${bypass}`;
  let entry = chromiumSessions.get(session);
  if (!entry || entry.key !== key) {
    const proxyBypassRules = bypass.split(',').map(value=>value.trim()).filter(Boolean).join(';');
    const promise = session.setProxy({proxyRules:proxy,proxyBypassRules});
    entry={key,promise};chromiumSessions.set(session,entry);
    promise.catch(()=>{if(chromiumSessions.get(session)===entry)chromiumSessions.delete(session);});
  }
  await entry.promise;
}
module.exports = { configureNativeProxy, configureChromiumSession };
