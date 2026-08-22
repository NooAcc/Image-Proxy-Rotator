/**
 * 消息路由 —— UI（设置页 / 弹窗）与后台之间唯一的契约。
 *
 * 两条铁律：
 *   1. 每个 handler 都不许让异常逃出去变成静默失败，统一返回 {ok:false, error:'中文原因'}。
 *   2. 任何改动了配置的 handler 结束前都必须 applyProxy()，否则 PAC 会和配置脱节。
 *
 * UI 侧只做展示与派发，不维护第二份状态 —— 写操作的返回值里带上新的 config，
 * 由 UI 直接用它重渲染。
 */

import { getConfig, setConfig, updateConfig, getLogger, getRuntime, saveRuntime } from './state.js';
import { applyProxy, readControl, previewPac } from './proxy-controller.js';
import { metricsView, resetMetrics as clearMetrics, flushMetrics } from './metrics-store.js';
import { probeNode as runProbeNode, probeAll as runProbeAll, scheduleProbeAlarm, resetNodeState as runResetNodeState } from './health-monitor.js';
import { planRetry, noteRetryOutcome } from './retry-coordinator.js';
import {
  dbg,
  setDebugEnabled,
  debugState,
  acceptDebugRows,
  exportDebugFiles,
  clearDebugLog,
  flushDebugLog,
} from './debug-store.js';
import { decodeSubscription, parseNodeList } from '../lib/node-parser.js';
import { createNode, dedupeNodes, nodeWarnings, unsupportedNodes, isSelectable } from '../lib/node-model.js';
import { createRule, validateRule, ruleWarnings } from '../lib/rule-matcher.js';
import { exportConfig as serializeConfig, importConfig as deserializeConfig } from '../lib/storage.js';
import { pacSummary } from '../lib/pac-generator.js';
import { validateTemplate, rewriteImageUrl, templateOrigin } from '../lib/image-proxy.js';
import { UNSUPPORTED_PROTOCOL_MESSAGE } from '../lib/constants.js';

/** 给 UI 用的节点盘点快照。注意这里只回答「有多少节点、什么状态」，不含流量统计 */
function buildStats(config, runtime) {
  const total = config.nodes.length;
  const unsupported = unsupportedNodes(config.nodes).length;
  const manualDisabled = config.nodes.filter((n) => !n.enabled).length;
  const autoDisabled = config.nodes.filter((n) => n.enabled && n.autoDisabled).length;
  // 「可用」必须与 PAC 池用同一个判定，否则状态页会把不支持的节点算成可用
  const healthy = config.nodes.filter(isSelectable);
  const measured = healthy.filter((n) => Number.isFinite(n.health.latencyMs));
  const avgLatency = measured.length
    ? Math.round(measured.reduce((sum, n) => sum + n.health.latencyMs, 0) / measured.length)
    : null;
  const fastest = measured.length
    ? measured.reduce((best, n) => (n.health.latencyMs < best.health.latencyMs ? n : best))
    : null;

  return {
    total,
    available: healthy.length,
    unsupported,
    manualDisabled,
    autoDisabled,
    avgLatency,
    fastest: fastest ? { id: fastest.id, name: fastest.name, latencyMs: fastest.health.latencyMs } : null,
    probing: runtime.probing,
    lastApplyAt: runtime.lastApplyAt,
    lastApplyError: runtime.lastApplyError,
  };
}

async function stateSnapshot() {
  const config = await getConfig();
  const log = await getLogger();
  const runtime = getRuntime();
  const control = runtime.control ?? (await readControl());
  const unsupported = unsupportedNodes(config.nodes);
  return {
    ok: true,
    config,
    control,
    summary: pacSummary(config),
    stats: buildStats(config, runtime),
    metrics: await metricsView(),
    warnings: Object.fromEntries(config.nodes.map((n) => [n.id, nodeWarnings(n)])),
    ruleWarnings: Object.fromEntries(config.rules.map((r) => [r.id, ruleWarnings(r)])),
    unsupportedIds: unsupported.map((n) => n.id),
    logs: log.list({ limit: 100 }),
  };
}

const handlers = {
  async getState() {
    return stateSnapshot();
  },

  async setEnabled({ enabled }) {
    await updateConfig((config) => {
      config.enabled = enabled === true;
      return config;
    });
    const result = await applyProxy();
    await scheduleProbeAlarm();
    return { ok: true, control: result.control, summary: result.summary, config: await getConfig() };
  },

  async saveConfig({ config }) {
    await setConfig(config);
    const result = await applyProxy();
    await scheduleProbeAlarm();
    const log = await getLogger();
    log.add({ level: 'info', kind: 'config', message: '配置已保存' });
    return { ok: true, config: await getConfig(), summary: result.summary };
  },

  async addNodes({ text, merge = true }) {
    const decoded = decodeSubscription(text);
    const { nodes: parsed, unsupported, errors } = parseNodeList(decoded);
    const log = await getLogger();

    // 不支持的协议要逐条报出来，绝不静默丢弃
    for (const item of unsupported) {
      log.add({ level: 'warn', kind: 'config', message: `已忽略 ${item.label} 节点（${item.line}）：${UNSUPPORTED_PROTOCOL_MESSAGE}` });
    }

    if (parsed.length === 0) {
      const error = unsupported.length > 0
        ? `没有可用节点被导入：本次粘贴的 ${unsupported.length} 个节点均为 ${[...new Set(unsupported.map((u) => u.label))].join(' / ')} 类型。${UNSUPPORTED_PROTOCOL_MESSAGE}。`
        : '没有解析出任何可用节点，请检查格式';
      return { ok: false, error, unsupported, errors, config: await getConfig() };
    }

    let added = 0;
    await updateConfig((config) => {
      const base = merge ? config.nodes : [];
      const built = [];
      for (const item of parsed) {
        const node = createNode(item, [...base, ...built]);
        if (node) built.push(node);
      }
      const before = base.length;
      config.nodes = dedupeNodes([...base, ...built]);
      added = config.nodes.length - before;
      return config;
    });

    await applyProxy();
    log.add({
      level: unsupported.length || errors.length ? 'warn' : 'info',
      kind: 'config',
      message: `导入节点：新增 ${added} 个，忽略重复 ${parsed.length - added} 个`
        + (unsupported.length ? `，不支持的类型 ${unsupported.length} 个` : '')
        + (errors.length ? `，无法识别 ${errors.length} 行` : ''),
    });
    return { ok: true, added, unsupported, errors, config: await getConfig() };
  },

  async updateNode({ id, patch }) {
    await updateConfig((config) => {
      const node = config.nodes.find((n) => n.id === id);
      if (!node) return config;
      // 只允许改这些字段 —— 地址/协议改了就是另一个节点，应该删掉重加
      for (const key of ['name', 'enabled', 'username', 'password']) {
        if (key in patch) node[key] = patch[key];
      }
      return config;
    });
    await applyProxy();
    return { ok: true, config: await getConfig() };
  },

  async deleteNode({ id }) {
    const before = await getConfig();
    const target = before.nodes.find((n) => n.id === id);
    await updateConfig((config) => {
      config.nodes = config.nodes.filter((n) => n.id !== id);
      // 顺手把规则里对它的绑定清掉，避免出现指向不存在节点的死引用
      config.rules = config.rules.map((r) => ({ ...r, nodeIds: r.nodeIds.filter((x) => x !== id) }));
      return config;
    });
    await applyProxy();
    const log = await getLogger();
    log.add({ level: 'info', kind: 'config', message: `已删除节点「${target?.name ?? id}」` });
    return { ok: true, config: await getConfig() };
  },

  async deleteNodes({ ids }) {
    const set = new Set(Array.isArray(ids) ? ids : []);
    await updateConfig((config) => {
      config.nodes = config.nodes.filter((n) => !set.has(n.id));
      config.rules = config.rules.map((r) => ({ ...r, nodeIds: r.nodeIds.filter((x) => !set.has(x)) }));
      return config;
    });
    await applyProxy();
    const log = await getLogger();
    log.add({ level: 'info', kind: 'config', message: `已批量删除 ${set.size} 个节点` });
    return { ok: true, config: await getConfig() };
  },

  /** 一键清除所有协议不受支持的节点（SOCKS / VLESS / Hysteria2 / Trojan / SS 等） */
  async deleteUnsupportedNodes() {
    const config = await getConfig();
    const targets = unsupportedNodes(config.nodes);
    if (targets.length === 0) return { ok: true, removed: 0, config };

    const set = new Set(targets.map((n) => n.id));
    await updateConfig((next) => {
      next.nodes = next.nodes.filter((n) => !set.has(n.id));
      next.rules = next.rules.map((r) => ({ ...r, nodeIds: r.nodeIds.filter((x) => !set.has(x)) }));
      return next;
    });
    await applyProxy();
    const log = await getLogger();
    log.add({
      level: 'info',
      kind: 'config',
      message: `已清除 ${targets.length} 个不支持的节点（${[...new Set(targets.map((n) => n.protocol))].join(' / ')}）`,
    });
    return { ok: true, removed: targets.length, config: await getConfig() };
  },

  async reorderNodes({ ids }) {
    await updateConfig((config) => {
      const byId = new Map(config.nodes.map((n) => [n.id, n]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      const rest = config.nodes.filter((n) => !ids.includes(n.id));
      config.nodes = [...ordered, ...rest];
      return config;
    });
    await applyProxy();
    return { ok: true, config: await getConfig() };
  },

  async saveRule({ rule }) {
    const built = createRule(rule);
    const check = validateRule(built);
    if (!check.ok) return { ok: false, error: check.reason, config: await getConfig() };

    await updateConfig((config) => {
      const index = config.rules.findIndex((r) => r.id === built.id || r.id === rule.id);
      if (index >= 0) config.rules[index] = built;
      else config.rules.push(built);
      return config;
    });
    await applyProxy();
    const log = await getLogger();
    log.add({ level: 'info', kind: 'config', message: `规则已保存：${built.name}` });
    return { ok: true, config: await getConfig() };
  },

  async deleteRule({ id }) {
    await updateConfig((config) => {
      config.rules = config.rules.filter((r) => r.id !== id);
      return config;
    });
    await applyProxy();
    return { ok: true, config: await getConfig() };
  },

  async reorderRules({ ids }) {
    await updateConfig((config) => {
      const byId = new Map(config.rules.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      const rest = config.rules.filter((r) => !ids.includes(r.id));
      config.rules = [...ordered, ...rest];
      return config;
    });
    await applyProxy();
    return { ok: true, config: await getConfig() };
  },

  async probeNode({ id }) {
    const result = await runProbeNode(id);
    return { ok: true, result, config: await getConfig() };
  },

  async probeAll() {
    const results = await runProbeAll();
    return { ok: true, results, config: await getConfig() };
  },

  async resetNodeState({ id }) {
    const config = await runResetNodeState(id);
    return { ok: true, config };
  },

  async getLogs({ kind, level, limit = 100 } = {}) {
    const log = await getLogger();
    const config = await getConfig();
    const runtime = getRuntime();
    return {
      ok: true,
      logs: log.list({ kind: kind || undefined, level: level || undefined, limit }),
      stats: buildStats(config, runtime),
      metrics: await metricsView(),
      control: runtime.control,
    };
  },

  /** 只清日志。统计是另一件事，由 resetMetrics 负责 —— 混在一起会让人不敢点 */
  async clearLogs() {
    const log = await getLogger();
    log.clear();
    await saveRuntime();
    return { ok: true };
  },

  /** 清零全部统计计数器 */
  async resetMetrics() {
    await clearMetrics();
    const log = await getLogger();
    log.add({ level: 'info', kind: 'config', message: '统计数据已清零' });
    await saveRuntime();
    return { ok: true, metrics: await metricsView() };
  },

  async exportConfig() {
    return { ok: true, text: serializeConfig(await getConfig()) };
  },

  async importConfig({ text, merge = false }) {
    const next = deserializeConfig(text, await getConfig(), { merge });
    await setConfig(next);
    await applyProxy();
    await scheduleProbeAlarm();
    // 覆盖导入会整批换掉节点/规则 id，立刻落盘一次把旧 id 的计数并进 retired，
    // 别让它们在存储里挂到下一个节流窗口
    await flushMetrics();
    const log = await getLogger();
    log.add({
      level: 'info',
      kind: 'config',
      message: `配置已导入（${merge ? '合并' : '覆盖'}）：${next.nodes.length} 个节点 / ${next.rules.length} 条规则`,
    });
    return { ok: true, config: await getConfig() };
  },

  async getPacPreview() {
    const { pac, summary } = await previewPac();
    return { ok: true, pac, summary };
  },

  /**
   * 内容脚本：一张图加载失败了，接下来怎么办。
   *
   * 这是页面与后台之间唯一的「决定」型消息。规则匹配与次数上限都在后台（决策 D21），
   * 页面侧不持有任何规则副本。
   */
  async imageRetryAsk({ url, attempt }) {
    const plan = await planRetry({ url, attempt });
    return { ok: true, ...plan };
  },

  /** 内容脚本：重发或兜底的结果。`retry.recovered` 唯一的来源 */
  async imageRetryResult({ url, kind, ok }) {
    return noteRetryOutcome({ url, kind, ok });
  },

  /** 兜底模板的即时校验与预览，设置页的「试一下」按钮用 */
  async previewFallbackImage({ template, url }) {
    const check = validateTemplate(template);
    if (!check.ok) return { ok: false, error: check.reason };
    const rewritten = rewriteImageUrl(template, url);
    if (!rewritten) {
      return { ok: false, error: '请填一个 http:// 或 https:// 的图片地址（且不能是兜底服务自己的地址）' };
    }
    return { ok: true, url: rewritten, origin: templateOrigin(template) };
  },

  // ---------------------------------------------------------------- 开发者调试日志

  /** 面板快照：开关状态、占用、每个命名空间各多少条 */
  async getDebug() {
    return { ok: true, ...(await debugState()) };
  },

  async setDebug({ enabled }) {
    await setDebugEnabled(enabled);
    return { ok: true, ...(await debugState()) };
  },

  /** 内容脚本与 UI 页面的批量回传。它们自己存不住，见 debug-store.js 的开头 */
  async debugPush({ rows }) {
    return { ok: true, accepted: await acceptDebugRows(rows) };
  },

  /** 导出前先落盘一次，保证文件里包含最后那几行 */
  async exportDebug() {
    await flushDebugLog();
    return { ok: true, ...(await exportDebugFiles()) };
  },

  async clearDebug() {
    await clearDebugLog();
    return { ok: true, ...(await debugState()) };
  },
};

/**
 * 记 `msg` 日志时必须排除的消息类型。
 *
 * 少一个排除，日志里就全是日志自己：面板每次刷新发 getDebug、页面侧每秒 flush 一次
 * debugPush，两者都会被记成新的一行，而新的一行又会被下一次 flush 带走 —— 由定时器
 * 驱动，**永不收敛**。这不是优化，是正确性。
 */
const DEBUG_SELF_TYPES = new Set(['getDebug', 'setDebug', 'debugPush', 'exportDebug', 'clearDebug']);

/**
 * 分发一条消息。
 * @param {{type: string}} message
 * @returns {Promise<object>}
 */
export async function handleMessage(message) {
  const type = message?.type;
  const handler = handlers[type];
  if (!handler) return { ok: false, error: `未知的消息类型：${type}` };

  const traced = dbg.on && !DEBUG_SELF_TYPES.has(type);
  const startedAt = traced ? Date.now() : 0;

  try {
    const result = (await handler(message)) ?? { ok: true };
    if (traced) dbg('msg', 'handled', { type, ms: Date.now() - startedAt, ok: result.ok !== false });
    return result;
  } catch (e) {
    const detail = String(e?.message || e);
    if (traced) dbg('msg', 'threw', { type, ms: Date.now() - startedAt, error: detail });
    try {
      const log = await getLogger();
      log.add({ level: 'error', kind: 'system', message: `处理「${type}」时出错：${detail}` });
    } catch {
      // 连日志都写不了就只回错误
    }
    return { ok: false, error: detail };
  }
}
