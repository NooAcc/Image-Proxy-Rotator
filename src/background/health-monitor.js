/**
 * 延迟探测与自动禁用。
 *
 * 探测原理（决策 D3 / D16）：测速必须**强制**走目标节点且**不加 DIRECT 兜底** ——
 * 否则一个挂掉的节点会静默直连，测出来的延迟是假的，节点也永远不会被判失败。
 *
 * 定向的实现方式是 1.2.1 的关键修正。旧版把节点 id 写进测速 URL 的 query
 * （`?__pp_node=<id>`）让 PAC 认，可 Chromium 在调用 PAC 之前就把 https URL 的
 * path 与 query 剥掉了（见 lib/pac-url.js），标记根本传不到 PAC —— 于是每次测速都
 * 按普通规则走，实际是直连，却被记成「该节点延迟 xx ms」。**测速看起来一直很正常，
 * 代理却从未被使用过。**
 *
 * 现在改为：临时注入一份「把测速地址所在源定向到目标节点」的 PAC，测完再恢复。
 * 代价是一次只能定向一个节点，所以测速由并发改成**串行**。这个代价是必须付的：
 * 一个能骗人的并发测速比慢一点的诚实测速糟糕得多。
 *
 * 另一个后果：**测速期间会临时接管浏览器代理设置**，即使总开关是关的 —— 想测
 * 「经该代理到公网的延迟」，就只能真的从那里出去一次。测完立刻恢复（总开关关着时
 * 恢复成撤销代理设置）。
 *
 * 自动禁用只由探测结果驱动（决策 D8）—— 线上请求失败的原因太多（图片 404、站点 5xx、
 * 用户断网），据此禁用节点会把好节点全禁掉。
 */

import { PROBE_PARAM, ALARM_PROBE, SLOW_LATENCY_MS, UNSUPPORTED_PROTOCOL_MESSAGE } from '../lib/constants.js';
import { isSupported, protocolLabel } from '../lib/node-model.js';
import { getConfig, updateConfig, getLogger, getRuntime, saveRuntime } from './state.js';
import { noteProbeMetric } from './metrics-store.js';
import { applyProxy, applyProbePac } from './proxy-controller.js';

let probeSeq = 0;

/**
 * 是否有一轮测速正在进行。
 *
 * 串行定向让这个标志从「给 UI 看的状态」变成了**必须遵守的互斥锁**：一份 PAC 只能指向
 * 一个节点，两轮测速重叠时后一轮注入的定向会覆盖前一轮的，于是「测节点 A 的请求」实际
 * 走了节点 B —— 又一条会安静给出错数字的路径。测速现在可能要跑几十秒（节点多、串行），
 * 用户重复点击很正常，所以宁可明确拒绝，也不要给出一个错的延迟。
 */
let probeInFlight = false;

const BUSY_MESSAGE = '正在测速中，请等待当前一轮完成后再试';

/**
 * 构造探测 URL。
 *
 * `__pp_node` 已经不再由 PAC 读取（读不到），但仍然要带上：`webRequest` 看到的是完整
 * URL，request-logger 靠它把这次请求认成「测速」而不是普通请求，并把观测到的对端 IP
 * 记到节点上。
 */
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
 * 真正发一次测速请求。**调用前必须已经注入定向 PAC**，否则测的不是这个节点。
 * @returns {Promise<{nodeId: string, ok: boolean, latencyMs: number|null, error: string|null}>}
 */
async function measure(nodeId, probe) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probe.timeoutMs);
  const startedAt = performance.now();
  try {
    await fetch(probeUrl(probe.url, nodeId), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
    return { nodeId, ok: true, latencyMs: Math.round(performance.now() - startedAt), error: null };
  } catch (e) {
    return {
      nodeId,
      ok: false,
      latencyMs: null,
      error: describeError(e, controller.signal.aborted, probe.timeoutMs),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 定向 + 测量。不负责恢复 PAC —— 由调用方在整轮结束后统一恢复 */
async function routeAndMeasure(node, probe) {
  const routed = await applyProbePac(node.id);
  if (!routed.ok) {
    return { nodeId: node.id, ok: false, latencyMs: null, error: routed.error };
  }
  return measure(node.id, probe);
}

/**
 * 探测单个节点（含 PAC 定向与恢复）。
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
  // 不落库、不计数：这不是节点的失败，是操作被拒绝
  if (probeInFlight) return { nodeId, ok: false, latencyMs: null, error: BUSY_MESSAGE, busy: true };

  probeInFlight = true;
  getRuntime().probing = true;
  try {
    const result = await routeAndMeasure(node, config.settings.probe);
    await recordProbeResult(nodeId, result);
    return result;
  } finally {
    probeInFlight = false;
    getRuntime().probing = false;
    // 无论成败都要把 PAC 换回正常那份，否则测速地址会一直被钉在某个节点上
    await applyProxy();
  }
}


/**
 * 落库探测结果，并在连续失败达到阈值时自动禁用节点。
 *
 * 不在这里 applyProxy()：整轮测速期间 PAC 一直是「定向」版本，中途重新注入会把
 * 下一个节点的定向覆盖掉。恢复由 probeNode / probeAll 在最后统一做。
 */
export async function recordProbeResult(nodeId, result) {
  const log = await getLogger();
  let autoDisabledNow = false;
  let recoveredNow = false;

  await noteProbeMetric({ ok: result.ok === true, at: Date.now() });

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

  return result;
}

/**
 * 探测全部节点。
 *
 * **串行**：一份 PAC 只能定向一个节点（见文件头）。节点很多时这一轮会比旧版慢，
 * 换来的是每个数字都真的来自那个节点。
 *
 * 被自动禁用的节点是否参与取决于 settings.probe.recoverProbe —— 参与才有机会恢复。
 */
export async function probeAll() {
  const config = await getConfig();
  const runtime = getRuntime();

  if (probeInFlight) {
    const log = await getLogger();
    log.add({ level: 'warn', kind: 'probe', message: BUSY_MESSAGE });
    return [];
  }

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

  probeInFlight = true;
  runtime.probing = true;
  const results = [];
  try {
    for (const node of targets) {
      const result = await routeAndMeasure(node, config.settings.probe);
      await recordProbeResult(node.id, result);
      results.push(result);
    }
  } finally {
    probeInFlight = false;
    runtime.probing = false;
    // 恢复正常 PAC —— 总开关关着时这一步会撤销代理设置，把浏览器还给用户
    await applyProxy();
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
