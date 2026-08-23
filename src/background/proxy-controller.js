/**
 * chrome.proxy 的注入与撤销。
 *
 * 全扩展只有这一处会写浏览器代理设置。任何改动了节点、规则、开关或健康状态的地方
 * 都必须调一次 applyProxy()，否则 PAC 里的节点池会和实际配置脱节。
 */

import { generatePac, pacSummary, canRouteProbe } from '../lib/pac-generator.js';
import { isAscii } from '../lib/ascii.js';
import { getConfig, getRuntime, getLogger, saveRuntime } from './state.js';
import { noteApplyMetric } from './metrics-store.js';
import { syncDeepRetryScripts } from './deep-retry-injector.js';
import { fallbackForceEntries, nextFallbackExpiry } from './fallback-window.js';
import { dbg } from './debug-store.js';


/**
 * 兜底窗口到点后把 PAC 换回干净的那一份。
 *
 * **这只是清理，不是正确性依赖。** PAC 里的 `until` 已经让过期条目自己失效了
 * （见 pac-generator 的 `data.force` 注释）—— 这个定时器没跑成，最坏结果只是 PAC 里
 * 多挂着一条已经不生效的条目，等下一次 applyProxy 顺手带走。
 */
let cleanupTimer = null;

function scheduleFallbackCleanup() {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  const expiry = nextFallbackExpiry();
  if (expiry === null) return;
  // 多等 250ms 再换，避免和 PAC 自己的过期判定卡在同一毫秒上反复横跳
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    void applyProxy();
  }, Math.max(0, expiry - Date.now()) + 250);
  // Node 下跑测试时别让待触发的定时器吊住进程
  if (typeof cleanupTimer?.unref === 'function') cleanupTimer.unref();
}


/** 读取当前代理设置的控制权 */
export async function readControl() {
  try {
    const result = await chrome.proxy.settings.get({ incognito: false });
    return {
      levelOfControl: result.levelOfControl,
      mode: result.value?.mode ?? 'unknown',
      controlled: result.levelOfControl === 'controlled_by_this_extension',
    };
  } catch (e) {
    return { levelOfControl: 'unavailable', mode: 'unknown', controlled: false, error: String(e?.message || e) };
  }
}

/** 撤销本扩展的代理设置，恢复浏览器默认行为 */
export async function clearProxy() {
  try {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    return true;
  } catch {
    // 本来就没设置过时会抛错，属于正常情况
    return false;
  }
}

/**
 * 把当前配置编译成 PAC 并注入浏览器。
 * @returns {Promise<{applied: boolean, summary: object, control: object}>}
 */
export async function applyProxy() {
  const log = await getLogger();
  const runtime = getRuntime();
  const config = await getConfig();

  // 深度重试的注入范围与 PAC 必须一起更新。挂在这里而不是散落在十几个改配置的 handler
  // 里：那样早晚会漏一处，而漏掉的表现是「站点清单改了、补丁的注册范围没跟上」——
  // 又一种不报错的静默失效。它自己带短路，重复调用是廉价的
  runtime.deepRetry = await syncDeepRetryScripts();

  const summary = pacSummary(config);
  runtime.summary = summary;

  if (!config.enabled || summary.nodeCount === 0) {
    await clearProxy();
    const control = await readControl();
    runtime.control = control;
    runtime.lastApplyAt = Date.now();
    if (dbg.on) dbg('pac', 'cleared', { enabled: config.enabled, nodeCount: summary.nodeCount, level: control.levelOfControl });
    log.add({
      level: config.enabled && summary.nodeCount === 0 ? 'warn' : 'info',
      kind: 'proxy',
      message: config.enabled
        ? '没有可用节点，已恢复直连（请检查节点是否被禁用或测速失败）'
        : '扩展总开关已关闭，已恢复直连',
    });
    await saveRuntime();
    return { applied: false, summary, control };
  }

  // 每次注入让起点前进一格：SW 重启后不会总是从 0 号节点开始，分布更均匀
  const startIndex = summary.poolTokenCount > 0 ? runtime.startIndex % summary.poolTokenCount : 0;
  runtime.startIndex = startIndex + 1;

  const pac = generatePac(config, { startIndex, forceEntries: fallbackForceEntries(config) });

  // PAC 内部发生的事这里一个字都看不到（没有 console、没有回传通道，见 LIMITATIONS）。
  // 能记的只有「编译出了什么」—— 逐请求选了哪个节点只能靠 request 里的对端 IP 反推
  if (dbg.on) {
    dbg('pac', 'compiled', {
      bytes: pac.length,
      nodes: summary.nodeCount,
      rules: summary.ruleCount,
      poolTokens: summary.poolTokenCount,
      startIndex,
      skippedNodes: summary.skipped.nodes.length,
      skippedRules: summary.skipped.rules.length,
      forced: fallbackForceEntries(config).length,
    });
  }

  // 最后一道闸：chrome.proxy 只接受纯 ASCII 的 pacScript.data，含一个非 ASCII 字节就
  // **整体**注入失败。生成器已经全程转义（见 lib/ascii.js），所以走到这里就是生成器出了
  // bug —— 与其把 Chrome 那句英文原文甩给用户，不如自己说清楚状况。
  if (!isAscii(pac)) {
    const detail = 'PAC 脚本含非 ASCII 字符';
    log.add({
      level: 'error',
      kind: 'proxy',
      message: '内部错误：生成的分流脚本含非 ASCII 字符，浏览器会拒绝它。'
        + '已保持当前代理设置不变。请在设置页的「诊断」里导出配置并反馈此问题。',
    });
    const control = await readControl();
    runtime.control = control;
    runtime.lastApplyError = detail;
    await noteApplyMetric({ ok: false, error: detail, at: Date.now() });
    await saveRuntime();
    return { applied: false, summary, control };
  }

  try {
    await chrome.proxy.settings.set({
      value: {
        mode: 'pac_script',
        // mandatory:false —— PAC 失败时让浏览器直连，而不是把整个浏览器搞成断网
        pacScript: { data: pac, mandatory: false },
      },
      scope: 'regular',
    });
  } catch (e) {
    const detail = String(e?.message || e);
    if (dbg.on) dbg('pac', 'inject-failed', { bytes: pac.length, error: detail });
    log.add({ level: 'error', kind: 'proxy', message: `注入代理设置失败：${detail}` });
    const control = await readControl();
    runtime.control = control;
    runtime.lastApplyError = detail;
    await noteApplyMetric({ ok: false, error: detail, at: Date.now() });
    await saveRuntime();
    return { applied: false, summary, control };
  }

  const control = await readControl();
  runtime.control = control;
  runtime.lastApplyAt = Date.now();
  runtime.lastApplyError = null;
  await noteApplyMetric({ ok: true, at: runtime.lastApplyAt });
  if (dbg.on) dbg('pac', 'injected', { controlled: control.controlled, level: control.levelOfControl, mode: control.mode });

  const skippedNote = summary.skipped.nodes.length || summary.skipped.rules.length
    ? `，已跳过 ${summary.skipped.nodes.length} 个节点 / ${summary.skipped.rules.length} 条规则`
    : '';
  log.add({
    level: control.controlled ? 'info' : 'warn',
    kind: 'proxy',
    message: control.controlled
      ? `代理规则已生效：${summary.nodeCount} 个节点 / ${summary.ruleCount} 条规则${skippedNote}`
      : `代理规则已下发，但浏览器代理设置的控制权是「${control.levelOfControl}」，可能被其他扩展或系统策略占用${skippedNote}`,
  });

  await saveRuntime();
  scheduleFallbackCleanup();
  return { applied: true, summary, control };
}

/** 供 UI 预览当前生效的 PAC，排障时很有用 */
export async function previewPac() {
  const config = await getConfig();
  return {
    pac: generatePac(config, {
      startIndex: getRuntime().startIndex,
      forceEntries: fallbackForceEntries(config),
    }),
    summary: pacSummary(config),
  };
}

/**
 * 注入「测速专用」PAC：发往测速地址所在源的请求被强制路由到指定节点，不加兜底。
 *
 * 为什么必须换一份 PAC 而不是在 URL 上做标记：浏览器交给 PAC 的 https URL 已被剥掉
 * path 与 query（见 lib/pac-url.js），标记根本传不进去。改成按「源」识别之后，
 * 一次只能定向一个节点 —— 这就是测速从并发改成串行的原因。
 *
 * 三道闸，任何一道没过都必须让测速**失败**而不是「照发不误」：注入失败、
 * ASCII 校验不过、代理设置控制权不在本扩展手上 —— 这三种情况下请求都会走别的通路，
 * 测出来的数字与目标节点毫无关系。
 *
 * @param {string} nodeId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function applyProbePac(nodeId) {
  const config = await getConfig();
  if (!canRouteProbe(config, nodeId)) {
    return { ok: false, error: '无法把测速请求定向到该节点（协议不受支持，或测速地址不是合法 URL）' };
  }

  const pac = generatePac(config, {
    startIndex: getRuntime().startIndex,
    probeNodeId: nodeId,
    // 测速期间兜底窗口照旧有效：探针条目排在 force 表最前面，测速优先，
    // 但没道理让一次测速把正在生效的兜底窗口静默掐掉
    forceEntries: fallbackForceEntries(config),
  });
  if (!isAscii(pac)) {
    return { ok: false, error: '内部错误：测速用的分流脚本含非 ASCII 字符' };
  }

  try {
    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: pac, mandatory: false } },
      scope: 'regular',
    });
  } catch (e) {
    return { ok: false, error: `无法注入测速用的代理设置：${String(e?.message || e)}` };
  }

  const control = await readControl();
  getRuntime().control = control;
  if (!control.controlled) {
    return {
      ok: false,
      error: `浏览器代理设置的控制权是「${control.levelOfControl}」，测速请求不会走本扩展指定的节点`,
    };
  }
  if (dbg.on) dbg('probe', 'pac-directed', { nodeId, bytes: pac.length, level: control.levelOfControl });
  return { ok: true };
}

