/**
 * 后台运行时状态。
 *
 * Service Worker 随时会被浏览器回收，所以这里区分两类状态：
 *   · 配置 —— 存 chrome.storage.local，权威来源，进程内只做缓存
 *   · 运行时（日志 / 统计 / 轮询起点）—— 存 chrome.storage.session，丢了不致命
 */

import { createStore } from '../lib/storage.js';
import { createLogger } from '../lib/logger.js';

const store = createStore(chrome.storage.local);

/** @type {object|null} 配置缓存 */
let cache = null;
let logger = null;
let restored = false;

const runtime = {
  /** @type {Record<string, {used: number, ok: number, fail: number}>} */
  stats: {},
  /** 轮询起点：每次重新注入 PAC 时前进，避免总是从 0 号节点开始 */
  startIndex: 0,
  /** 最近一次 chrome.proxy 控制权检查结果 */
  control: null,
  /** 最近一次 PAC 注入摘要 */
  summary: null,
  /** 上次注入时间 */
  lastApplyAt: null,
  /** 是否正在批量探测 */
  probing: false,
};

export async function getConfig() {
  if (!cache) cache = await store.load();
  return cache;
}

export async function setConfig(config) {
  cache = await store.save(config);
  if (logger) logger.setLimit(cache.settings.logLimit);
  return cache;
}

/** 读-改-写。fn 可就地修改并返回配置，也可返回一份新配置 */
export async function updateConfig(fn) {
  const current = await getConfig();
  const next = (await fn(current)) || current;
  return setConfig(next);
}

export async function getLogger() {
  if (!logger) {
    const config = await getConfig();
    logger = createLogger({ limit: config.settings.logLimit, now: () => Date.now() });
  }
  if (!restored) {
    restored = true;
    await restoreRuntime();
  }
  return logger;
}

export function getRuntime() {
  return runtime;
}

/** 记录某个节点被用了一次 */
export function bumpNodeStat(nodeId, ok) {
  if (!nodeId) return;
  const stat = runtime.stats[nodeId] || (runtime.stats[nodeId] = { used: 0, ok: 0, fail: 0 });
  stat.used++;
  if (ok) stat.ok++;
  else stat.fail++;
}

export function resetStats() {
  runtime.stats = {};
}

/** 把运行时状态写进 session storage，便于 SW 被唤醒后接上 */
export async function saveRuntime() {
  try {
    await chrome.storage.session.set({
      runtime: { stats: runtime.stats, startIndex: runtime.startIndex },
      logs: logger ? logger.list({ limit: 200 }) : [],
    });
  } catch {
    // session storage 不可用（例如权限被裁剪）时静默降级：只丢历史，不影响功能
  }
}

async function restoreRuntime() {
  try {
    const got = await chrome.storage.session.get(['runtime', 'logs']);
    if (got?.runtime) {
      if (got.runtime.stats && typeof got.runtime.stats === 'object') runtime.stats = got.runtime.stats;
      if (Number.isInteger(got.runtime.startIndex)) runtime.startIndex = got.runtime.startIndex;
    }
    if (Array.isArray(got?.logs) && logger) logger.restore(got.logs);
  } catch {
    // 同上：恢复失败不影响后续运行
  }
}
