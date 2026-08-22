/**
 * 统计计数器的持久化。
 *
 * **为什么要节流。** 计数发生在 webRequest.onCompleted 上 —— 一个漫画页一次能打出几百个
 * 图片请求。若每次计数都写一遍 chrome.storage.local，就是几百次真实磁盘写入；原先的
 * saveRuntime() 正是每请求写一次（只不过写的是内存态的 session 区，代价没那么显眼）。
 * 所以这里统一收敛成：**距上次落盘 ≥5 秒，或攒够 50 次改动，才写一次**。
 *
 * **代价是明确的：** Service Worker 被回收时，最多丢一个节流窗口（≤5 秒）的计数。
 * 统计不是账本，用这点精度换掉几百倍的写放大是划算的 —— 但它是有意为之，不是疏忽。
 *
 * **体积保证。** 每次落盘前先 pruneMetrics()：已删除的节点/规则并入 retired 聚合桶。
 * 于是 perNode / perRule 的键数恒等于当前配置里的实体数，不随运行时长增长。
 */

import {
  METRICS_KEY,
  emptyMetrics,
  normalizeMetrics,
  noteRequest,
  noteProbe,
  noteApply,
  noteRetry,
  noteFallbackImage,
  pruneMetrics,
  summarizeMetrics,
} from '../lib/metrics.js';
import { getConfig } from './state.js';

/** 距上次落盘至少这么久才允许再写 */
const FLUSH_INTERVAL_MS = 5000;
/** 或者攒够这么多次改动就立刻写 */
const FLUSH_AFTER_CHANGES = 50;

/** @type {object|null} 进程内计数器，权威副本；存储只是它的快照 */
let cache = null;
/** 距上次落盘累计了多少次改动 */
let pending = 0;
let lastFlushAt = 0;
let timer = null;

/** 读回计数器（只在首次访问时碰存储） */
async function load() {
  if (cache) return cache;
  try {
    const got = await chrome.storage.local.get(METRICS_KEY);
    cache = normalizeMetrics(got?.[METRICS_KEY]);
  } catch {
    // 存储不可用时降级为纯内存计数：丢历史，但不影响分流本身
    cache = emptyMetrics();
  }
  return cache;
}

/** 当前配置里还活着的实体 id，用于剪枝 */
async function presentIds() {
  try {
    const config = await getConfig();
    return {
      nodeIds: config.nodes.map((n) => n.id),
      ruleIds: config.rules.map((r) => r.id),
    };
  } catch {
    // 读不到配置就不剪枝 —— 宁可多留几个键，也不能误删用户的统计
    return {};
  }
}

/** 真正落盘。剪枝在这里做，保证写出去的永远是收敛后的形状 */
async function write() {
  if (!cache) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending = 0;
  lastFlushAt = Date.now();

  pruneMetrics(cache, await presentIds());
  try {
    await chrome.storage.local.set({ [METRICS_KEY]: cache });
  } catch {
    // 写失败不影响计数继续累加，下一个窗口会再试
  }
}

/** 记一次改动，按节流规则决定是立刻写、还是等窗口到点再写 */
function schedule() {
  pending++;
  const idleEnough = Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS;
  if (pending >= FLUSH_AFTER_CHANGES || idleEnough) {
    void write();
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void write();
  }, FLUSH_INTERVAL_MS);
  // Node 下跑测试时别用一个待触发的定时器吊住进程；浏览器里 setTimeout 返回数字，此处自然跳过
  if (typeof timer?.unref === 'function') timer.unref();
}

/** 立刻落盘。低频且重要的时刻（清零、导入配置）用它，别等窗口 */
export async function flushMetrics() {
  await load();
  await write();
}

/** 计数器原始形态，供测试与诊断 */
export async function getMetrics() {
  return load();
}

/** 加工成可直接渲染的视图模型（补名字、算占比、列出零命中项） */
export async function metricsView() {
  const metrics = await load();
  let config;
  try {
    config = await getConfig();
  } catch {
    config = { nodes: [], rules: [] };
  }
  return summarizeMetrics(metrics, { nodes: config.nodes, rules: config.rules });
}

/** 记一次命中了用户规则的请求（event.blind 区分「真的走代理」与「注定直连」） */
export async function noteRequestMetric(event) {
  noteRequest(await load(), event);
  schedule();
}

/** 记一次延迟探测结果 */
export async function noteProbeMetric(event) {
  noteProbe(await load(), event);
  schedule();
}

/** 记一次重试判定的结果（attempted / recovered / exhausted / skipped） */
export async function noteRetryMetric(event) {
  noteRetry(await load(), event);
  schedule();
}

/** 记一次兜底图片代理的动作（改写地址 / 加载成败） */
export async function noteFallbackImageMetric(event) {
  noteFallbackImage(await load(), event);
  schedule();
}

/** 记一次 PAC 注入结果 */
export async function noteApplyMetric(event) {
  noteApply(await load(), event);
  schedule();
}

/** 清零全部统计并立刻落盘 */
export async function resetMetrics() {
  cache = emptyMetrics();
  await write();
  return cache;
}
