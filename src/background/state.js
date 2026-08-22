/**
 * 后台运行时状态。
 *
 * Service Worker 随时会被浏览器回收，所以这里区分三类状态：
 *   · 配置 —— 存 chrome.storage.local，权威来源，进程内只做缓存
 *   · 统计 —— 存 chrome.storage.local，跨浏览器重启累计（见 background/metrics-store.js）
 *   · 运行时（日志 / 轮询起点 / 控制权）—— 存 chrome.storage.session，丢了不致命
 *
 * 「使用次数」这类计数**不在这里**：它属于统计，归 metrics-store 管。
 * 这里只留真正随进程生灭的东西。
 */

import { createStore } from '../lib/storage.js';
import { createLogger } from '../lib/logger.js';
import { dbg } from './debug-store.js';

const store = createStore(chrome.storage.local);

/** @type {object|null} 配置缓存 */
let cache = null;
let logger = null;
let restored = false;

const runtime = {
  /** 轮询起点：每次重新注入 PAC 时前进，避免总是从 0 号节点开始 */
  startIndex: 0,
  /** 最近一次 chrome.proxy 控制权检查结果 */
  control: null,
  /** 最近一次 PAC 注入摘要 */
  summary: null,
  /** 上次成功注入的时间 */
  lastApplyAt: null,
  /** 上次注入失败的原因；成功后清空 */
  lastApplyError: null,
  /** 是否正在批量探测 */
  probing: false,
};

export async function getConfig() {
  if (!cache) {
    cache = await store.load();
    // 规范化会静默修补甚至丢弃单条记录（端口越界的节点、编译不了的正则）。
    // 「读回来之后到底剩下什么」只有这里看得到
    if (dbg.on) {
      dbg('config', 'loaded', {
        version: cache.version,
        enabled: cache.enabled,
        nodes: cache.nodes.length,
        rules: cache.rules.length,
        strategy: cache.settings.strategy,
        fallback: cache.settings.fallback,
        retry: cache.settings.retry,
        fallbackImage: cache.settings.fallbackImage.enabled,
      });
    }
  }
  return cache;
}

export async function setConfig(config) {
  cache = await store.save(config);
  if (logger) logger.setLimit(cache.settings.logLimit);
  if (dbg.on) {
    dbg('config', 'saved', {
      enabled: cache.enabled,
      nodes: cache.nodes.length,
      rules: cache.rules.length,
      autoDisabled: cache.nodes.filter((n) => n.autoDisabled).length,
    });
  }
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

/** 请求热路径上的节流窗口：一个漫画页几百个请求，不能每个都写一遍日志快照 */
const RUNTIME_FLUSH_MS = 3000;
let runtimeTimer = null;

/**
 * 攒一下再落盘。**只有 webRequest 那条热路径该用它** —— 其余低频调用点直接用
 * saveRuntime()，那里立刻写完更可预期。
 *
 * 代价：SW 被回收时最多丢 3 秒的请求日志。日志是诊断信息，这点精度换掉几百倍的
 * 写放大是划算的。
 */
export function queueRuntimeSave() {
  if (runtimeTimer) return;
  runtimeTimer = setTimeout(() => {
    runtimeTimer = null;
    void saveRuntime();
  }, RUNTIME_FLUSH_MS);
  // Node 下跑测试时别让待触发的定时器吊住进程；浏览器里 setTimeout 返回数字，自然跳过
  if (typeof runtimeTimer?.unref === 'function') runtimeTimer.unref();
}

/** 把运行时状态写进 session storage，便于 SW 被唤醒后接上 */
export async function saveRuntime() {
  if (runtimeTimer) {
    clearTimeout(runtimeTimer);
    runtimeTimer = null;
  }
  try {
    await chrome.storage.session.set({
      runtime: { startIndex: runtime.startIndex },
      // 跟随用户设置的保留条数，而不是写死 200 —— 否则 SW 一重启，
      // 用户明明配了 2000 条却只剩 200 条
      logs: logger ? logger.list({ limit: cache?.settings?.logLimit ?? 200 }) : [],
    });
  } catch {
    // session storage 不可用（例如权限被裁剪）时静默降级：只丢历史，不影响功能
  }
}

async function restoreRuntime() {
  try {
    const got = await chrome.storage.session.get(['runtime', 'logs']);
    if (got?.runtime && Number.isInteger(got.runtime.startIndex)) {
      runtime.startIndex = got.runtime.startIndex;
    }
    if (Array.isArray(got?.logs) && logger) logger.restore(got.logs);
  } catch {
    // 同上：恢复失败不影响后续运行
  }
}
