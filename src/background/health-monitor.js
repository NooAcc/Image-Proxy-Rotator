/**
 * 延迟探测与自动禁用。
 *
 * 探测原理（决策 D3）：给探测 URL 加上 `__pp_node=<节点id>` 参数，PAC 认出这个标记后
 * 强制把请求路由到指定节点，且**不加 DIRECT 兜底**。因此测出来的是「浏览器经该代理
 * 到公网」的真实端到端延迟，和实际图片请求走的是同一条通路；失败也是真失败，不会
 * 被静默直连掩盖。
 *
 * 自动禁用只由探测结果驱动（决策 D8）—— 线上请求失败的原因太多（图片 404、站点 5xx、
 * 用户断网），据此禁用节点会把好节点全禁掉。
 */

import { PROBE_PARAM, ALARM_PROBE, SLOW_LATENCY_MS, UNSUPPORTED_PROTOCOL_MESSAGE } from '../lib/constants.js';
import { isSupported, protocolLabel } from '../lib/node-model.js';
import { getConfig, updateConfig, getLogger, getRuntime, saveRuntime } from './state.js';
import { applyProxy } from './proxy-controller.js';

/** 一次全量探测的并发上限，避免瞬间打出几十个请求 */
const PROBE_CONCURRENCY = 5;

let probeSeq = 0;

/** 构造带节点标记的探测 URL */
function probeUrl(baseUrl, nodeId) {
  const url = new URL(baseUrl);
  url.searchParams.set(PROBE_PARAM, nodeId);
  url.searchParams.set('_pp_t', `${Date.now()}-${++probeSeq}`); // 防缓存
  return url.toString();
}

/** 把 fetch 抛出的异常翻译成用户能看懂的中文 */
function describeError(error, aborted, timeoutMs) {
  if (aborted) return `超时（超过 ${timeoutMs}ms 未响应）`;
  const message = String(error?.message || error || '未知错误');
  if (/Failed to fetch/i.test(message)) {
    return '连接失败（节点不可达、代理拒绝转发，或探测地址不支持跨域 —— 建议改用 https://cp.cloudflare.com/generate_204）';
  }
  return message;
}

/**
 * 探测单个节点。
 * @param {string} nodeId
 * @returns {Promise<{nodeId: string, ok: boolean, latencyMs: number|null, error: string|null}>}
 */
export async function probeNode(nodeId) {
  const config = await getConfig();
  const node = config.nodes.find((n) => n.id === nodeId);
  if (!node) return { nodeId, ok: false, latencyMs: null, error: '节点不存在' };
  // 不支持的协议根本进不了 PAC，测速也没有意义 —— 直接给出明确原因
  if (!isSupported(node)) {
    return { nodeId, ok: false, latencyMs: null, error: `${protocolLabel(node.protocol)}：${UNSUPPORTED_PROTOCOL_MESSAGE}`, unsupported: true };
  }

  const { timeoutMs } = config.settings.probe;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  let result;
  try {
    await fetch(probeUrl(config.settings.probe.url, nodeId), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
    result = { nodeId, ok: true, latencyMs: Math.round(performance.now() - startedAt), error: null };
  } catch (e) {
    result = {
      nodeId,
      ok: false,
      latencyMs: null,
      error: describeError(e, controller.signal.aborted, timeoutMs),
    };
  } finally {
    clearTimeout(timer);
  }

  await recordProbeResult(nodeId, result);
  return result;
}

/**
 * 落库探测结果，并在连续失败达到阈值时自动禁用节点。
 * 节点池变化后必须重新注入 PAC，否则被禁用的节点还在轮询里。
 */
export async function recordProbeResult(nodeId, result) {
  const log = await getLogger();
  let autoDisabledNow = false;
  let recoveredNow = false;

  await updateConfig((config) => {
    const node = config.nodes.find((n) => n.id === nodeId);
    if (!node) return config;
    const probe = config.settings.probe;

    if (result.ok) {
      node.health = {
        ...node.health,
        status: result.latencyMs > SLOW_LATENCY_MS ? 'slow' : 'ok',
        latencyMs: result.latencyMs,
        lastCheckedAt: Date.now(),
        consecutiveFailures: 0,
        lastError: null,
      };
      if (node.autoDisabled) {
        node.autoDisabled = false;
        recoveredNow = true;
      }
    } else {
      const failures = (node.health.consecutiveFailures || 0) + 1;
      node.health = {
        ...node.health,
        status: 'fail',
        latencyMs: null,
        lastCheckedAt: Date.now(),
        consecutiveFailures: failures,
        lastError: result.error,
      };
      if (probe.autoDisable && failures >= probe.failureThreshold && !node.autoDisabled) {
        node.autoDisabled = true;
        autoDisabledNow = true;
      }
    }
    return config;
  });

  const config = await getConfig();
  const node = config.nodes.find((n) => n.id === nodeId);
  const name = node?.name ?? nodeId;

  log.add({
    level: result.ok ? 'info' : 'warn',
    kind: 'probe',
    nodeId,
    ok: result.ok,
    latencyMs: result.latencyMs,
    message: result.ok
      ? `节点「${name}」延迟 ${result.latencyMs}ms`
      : `节点「${name}」探测失败：${result.error}（连续失败 ${node?.health.consecutiveFailures ?? 1} 次）`,
  });
  if (recoveredNow) {
    log.add({ level: 'info', kind: 'probe', nodeId, message: `节点「${name}」已恢复可用，重新加入轮询` });
  }
  if (autoDisabledNow) {
    log.add({ level: 'error', kind: 'probe', nodeId, message: `节点「${name}」已自动禁用，轮询将跳过它（可在设置页手动重新启用）` });
  }

  await applyProxy();
  return result;
}

/**
 * 探测全部节点（并发上限 PROBE_CONCURRENCY）。
 * 被自动禁用的节点是否参与取决于 settings.probe.recoverProbe —— 参与才有机会恢复。
 */
export async function probeAll() {
  const config = await getConfig();
  const runtime = getRuntime();
  // 只测支持的协议；不支持的节点连 PAC 都进不去，测它们纯属浪费请求
  const targets = config.nodes.filter(
    (n) => isSupported(n) && n.enabled && (!n.autoDisabled || config.settings.probe.recoverProbe),
  );

  if (targets.length === 0) {
    const log = await getLogger();
    const unsupportedCount = config.nodes.filter((n) => !isSupported(n)).length;
    log.add({
      level: 'warn',
      kind: 'probe',
      message: unsupportedCount > 0 && unsupportedCount === config.nodes.length
        ? `没有可测速的节点：现有 ${unsupportedCount} 个节点均为不支持的类型。${UNSUPPORTED_PROTOCOL_MESSAGE}`
        : '没有可测速的节点（节点列表为空或全部被手动禁用）',
    });
    return [];
  }

  runtime.probing = true;
  const results = [];
  const queue = [...targets];
  try {
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const node = queue.shift();
        results.push(await probeNode(node.id));
      }
    });
    await Promise.all(workers);
  } finally {
    runtime.probing = false;
  }
  await saveRuntime();
  return results;
}

/** 按配置重建定时探测任务。chrome.alarms 的最小周期是 1 分钟 */
export async function scheduleProbeAlarm() {
  const config = await getConfig();
  try {
    await chrome.alarms.clear(ALARM_PROBE);
  } catch {
    // 没有已存在的 alarm 时属正常
  }
  const minutes = config.settings.probe.intervalMinutes;
  if (!config.enabled || minutes <= 0) return false;
  const period = Math.max(1, minutes);
  await chrome.alarms.create(ALARM_PROBE, { delayInMinutes: period, periodInMinutes: period });
  return true;
}

/** 定时探测触发入口 */
export async function onAlarm() {
  const config = await getConfig();
  if (!config.enabled) return;
  const log = await getLogger();
  log.add({ level: 'info', kind: 'probe', message: '开始定时全量延迟测试' });
  const results = await probeAll();
  const okCount = results.filter((r) => r.ok).length;
  log.add({
    level: okCount === 0 && results.length > 0 ? 'error' : 'info',
    kind: 'probe',
    message: `定时测试完成：${okCount}/${results.length} 个节点可用`,
  });
}

/** 手动解除自动禁用并清零失败计数 */
export async function resetNodeState(nodeId) {
  const log = await getLogger();
  await updateConfig((config) => {
    const node = config.nodes.find((n) => n.id === nodeId);
    if (!node) return config;
    node.autoDisabled = false;
    node.health = { ...node.health, status: 'unknown', consecutiveFailures: 0, lastError: null };
    return config;
  });
  const config = await getConfig();
  const node = config.nodes.find((n) => n.id === nodeId);
  log.add({ level: 'info', kind: 'config', nodeId, message: `已重置节点「${node?.name ?? nodeId}」的状态` });
  await applyProxy();
  return config;
}
