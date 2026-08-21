/**
 * chrome.proxy 的注入与撤销。
 *
 * 全扩展只有这一处会写浏览器代理设置。任何改动了节点、规则、开关或健康状态的地方
 * 都必须调一次 applyProxy()，否则 PAC 里的节点池会和实际配置脱节。
 */

import { generatePac, pacSummary } from '../lib/pac-generator.js';
import { isAscii } from '../lib/ascii.js';
import { getConfig, getRuntime, getLogger, saveRuntime } from './state.js';
import { noteApplyMetric } from './metrics-store.js';

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

  const summary = pacSummary(config);
  runtime.summary = summary;

  if (!config.enabled || summary.nodeCount === 0) {
    await clearProxy();
    const control = await readControl();
    runtime.control = control;
    runtime.lastApplyAt = Date.now();
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

  const pac = generatePac(config, { startIndex });

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
  return { applied: true, summary, control };
}

/** 供 UI 预览当前生效的 PAC，排障时很有用 */
export async function previewPac() {
  const config = await getConfig();
  return {
    pac: generatePac(config, { startIndex: getRuntime().startIndex }),
    summary: pacSummary(config),
  };
}
