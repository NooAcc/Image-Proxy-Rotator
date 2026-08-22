/**
 * 状态弹窗逻辑。
 *
 * 打开时拉一次完整状态，之后每 2 秒只拉日志与统计（轻量）。
 * 弹窗关闭即停止轮询 —— 否则会让 Service Worker 一直被唤醒。
 *
 * 四个视图（节点/规则/活动/统计）共用同一个滚动容器 #paneBody，切换只是重渲染它。
 * 这样弹窗高度恒定，不会出现「外层和内层两个滚动条抢滚轮」。
 *
 * 默认仍然停在「节点」：弹窗的主职责是快速开关节点，而顶部四宫格已经把最关键的
 * 数字摆在眼前了。要细看统计就切到「统计」，或者去设置页 —— 那边空间大得多。
 */

import { send, el, clear, fmtTime, fmtLatency, fmtAgo } from '../shared/api.js';
import { btn, badge, statusChip, statusLabel, setBanner, announce, kpi, shareBar } from '../shared/ui.js';
import { isSupported, isSelectable, protocolLabel, unsupportedNodes } from '../../lib/node-model.js';
import { validateRule } from '../../lib/rule-matcher.js';
import { RULE_TYPE_LABELS, UNSUPPORTED_PROTOCOL_MESSAGE } from '../../lib/constants.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 2000;
/** 弹窗窄，明细表放不下，只列前几名；要看全部去设置页 */
const TOP_N = 5;

/** 视图 → 标签按钮 id 与滚动区名称。顺序即分段控件顺序，第一个是默认视图 */
const VIEWS = [
  { key: 'nodes', tab: 'tabNodes', label: '节点列表' },
  { key: 'rules', tab: 'tabRules', label: '生效的规则' },
  { key: 'logs', tab: 'tabLogs', label: '最近活动' },
  { key: 'stats', tab: 'tabStats', label: '统计概览' },
];

let config = null;
let stats = {};
let metrics = null;
let logs = [];
let view = VIEWS[0].key;
let timer = null;
/**
 * 最近一次拿到的代理控制权状态。
 * 必须缓存：切换某个节点后也要重画状态行，而那条路径上没有新的 control，
 * 若按「没传就是没问题」处理，会把「代理设置被其他扩展占用」这条警告悄悄抹掉。
 */
let lastControl = null;

// ---------------------------------------------------------------- 视图切换

function setView(key) {
  view = key;
  for (const item of VIEWS) {
    $(item.tab).setAttribute('aria-pressed', String(item.key === key));
    if (item.key === key) $('paneBody').setAttribute('aria-label', item.label);
  }
  // 筛选下拉只在「活动」视图有意义，别的视图下摆着只会误导
  $('logFilterRow').hidden = key !== 'logs';
  renderBody();
}

// ---------------------------------------------------------------- 渲染

function renderStatus(control) {
  if (control !== undefined) lastControl = control;
  const effective = lastControl;
  const available = config.nodes.filter(isSelectable).length;
  const activeRules = config.rules.filter((r) => r.enabled && validateRule(r).ok).length;
  const occupied = Boolean(effective) && !effective.controlled
    && effective.levelOfControl !== 'unavailable';

  let text;
  let tone;
  if (!config.enabled) {
    text = '已关闭（全部直连）';
    tone = 'muted';
  } else if (occupied) {
    text = '代理设置被占用';
    tone = 'err';
  } else if (available === 0) {
    text = '无可用节点';
    tone = 'err';
  } else if (activeRules === 0) {
    text = '无生效规则';
    tone = 'warn';
  } else {
    text = `已生效（${available} 节点 / ${activeRules} 规则）`;
    tone = 'ok';
  }

  const chip = $('statusChip');
  clear(chip);
  chip.className = `head__status status status--${tone}`;
  chip.append(
    el('span', { class: 'status__glyph', 'aria-hidden': 'true', text: tone === 'ok' ? '●' : '○' }),
    el('span', { text }),
  );

  $('masterSwitch').checked = config.enabled;

  setBanner($('controlWarning'), occupied
    ? `浏览器代理设置的控制权是「${effective.levelOfControl}」，可能被其他代理扩展或系统策略占用，分流可能不生效。`
    : '', 'warn');

  const unsupported = unsupportedNodes(config.nodes);
  const kinds = [...new Set(unsupported.map((n) => protocolLabel(n.protocol)))].join(' / ');
  setBanner($('unsupportedWarning'), unsupported.length
    ? `${unsupported.length} 个节点为 ${kinds} 类型：${UNSUPPORTED_PROTOCOL_MESSAGE}，已停用且不参与分流。`
    : '', 'err');
}

function renderStats() {
  const disabled = (stats.manualDisabled ?? 0) + (stats.autoDisabled ?? 0);
  const latency = Number.isFinite(stats.avgLatency) ? `${stats.avgLatency}` : '–';

  $('statTotal').textContent = stats.total ?? 0;
  $('statAvailable').textContent = stats.available ?? 0;
  $('statDisabled').textContent = disabled;
  $('statAvgLatency').textContent = latency;

  // 读屏只念「3」没有意义，必须念一句完整的话
  announce($('statusSummary'),
    `共 ${stats.total ?? 0} 个节点，可用 ${stats.available ?? 0} 个，已禁用 ${disabled} 个，`
    + `平均延迟 ${latency === '–' ? '未知' : `${latency} 毫秒`}。`);
}

/** 四个视图共用一个容器，切换即整块重渲染 */
function renderBody() {
  const box = $('paneBody');
  clear(box);
  if (!config) return;

  if (view === 'nodes') renderNodes(box);
  else if (view === 'rules') renderRules(box);
  else if (view === 'stats') renderMetrics(box);
  else renderLogs(box);
}

function renderNodes(box) {
  if (config.nodes.length === 0) {
    box.append(el('p', { class: 'empty', text: '还没有节点。点「设置」添加 HTTP/HTTPS 代理。' }));
    return;
  }

  for (const node of config.nodes) {
    const supported = isSupported(node);
    const usable = supported && node.enabled && !node.autoDisabled;
    const used = metrics?.nodes.rows.find((r) => r.id === node.id)?.used ?? 0;

    box.append(el('div', { class: `node-row ${usable ? '' : 'is-off'}` },
      statusChip(node, { compact: true }),
      el('span', {
        class: 'node-row__name',
        text: node.name,
        title: `${protocolLabel(node.protocol)} ${node.host}:${node.port} · ${statusLabel(node)}`,
      }),
      supported ? null : badge('不支持', 'err'),
      used > 0 ? el('span', { class: 'node-row__used', text: `×${used}` }) : null,
      el('span', { class: 'node-row__latency', text: supported ? fmtLatency(node.health.latencyMs) : '—' }),
      supported
        ? btn({ text: '测', size: 'sm', title: `测试「${node.name}」的延迟`, onClick: () => probeOne(node.id) })
        : null,
      el('label', { class: 'switch switch--sm' },
        el('span', { class: 'sr-only', text: `启用 ${node.name}` }),
        el('input', {
          type: 'checkbox',
          checked: node.enabled && supported,
          disabled: !supported,
          title: supported ? '启用/禁用' : UNSUPPORTED_PROTOCOL_MESSAGE,
          onchange: (e) => toggleNode(node.id, e.target.checked),
        }),
      ),
    ));
  }
}

function renderRules(box) {
  const active = config.rules.filter((r) => r.enabled && validateRule(r).ok);
  if (active.length === 0) {
    box.append(el('p', { class: 'empty', text: '没有生效的规则，当前所有请求都直连。' }));
    return;
  }

  for (const rule of active) {
    box.append(el('div', { class: 'rule-row' },
      badge(RULE_TYPE_LABELS[rule.type] ?? rule.type),
      el('span', {
        class: 'rule-row__pattern',
        text: rule.pattern,
        title: `${rule.name}\n${rule.pattern}`,
      }),
    ));
  }
}

function renderLogs(box) {
  if (logs.length === 0) {
    box.append(el('p', { class: 'empty', text: '暂无记录。开启后访问漫画页即可看到分流情况。' }));
    return;
  }

  for (const row of logs) {
    box.append(el('div', { class: `log-row is-${row.level}` },
      el('span', { class: 'log-row__at', text: fmtTime(row.at) }),
      el('span', {
        class: 'log-row__msg',
        text: row.message + (Number.isFinite(row.latencyMs) ? `（${row.latencyMs}ms）` : ''),
      }),
    ));
  }
}

// ---------------------------------------------------------------- 统计视图

/** 小标题 + 内容的一段 */
function section(title, ...children) {
  return el('section', { class: 'sect' },
    el('h2', { class: 'sect__title', text: title }),
    ...children);
}

/** 排行榜的一行：名字 + 次数 + 占比条 */
function rankRow(name, amount, share, muted = false) {
  return el('div', { class: `rank ${muted ? 'is-off' : ''}` },
    el('span', { class: 'rank__name', text: name, title: name }),
    el('span', { class: 'rank__num num', text: `${amount}` }),
    shareBar(share),
  );
}

function renderMetrics(box) {
  if (!metrics) {
    box.append(el('p', { class: 'empty', text: '正在读取统计…' }));
    return;
  }

  const req = metrics.requests;
  box.append(section('请求',
    el('dl', { class: 'kpis' },
      kpi({ label: '命中规则', value: req.total, unit: '次' }),
      kpi({
        label: '真的走代理',
        value: req.routed,
        unit: '次',
        tone: req.total > 0 && req.routed === 0 ? 'err' : 'ok',
      }),
      kpi({
        label: '成功率',
        value: req.successRate,
        unit: '%',
        tone: req.successRate === null ? '' : (req.successRate >= 95 ? 'ok' : 'warn'),
      }),
      kpi({ label: '平均耗时', value: req.avgLatencyMs, unit: 'ms' }),
      kpi({
        label: '对端是代理',
        value: req.viaNodeIp,
        unit: '次',
        tone: req.routed > 0 && req.viaNodeIp === 0 ? 'warn' : 'ok',
      }),
      // 不为零就说明有规则依赖了 HTTPS 下看不见的路径 —— 最该先查的一项
      kpi({
        label: '命中但直连',
        value: req.blind,
        unit: '次',
        tone: req.blind > 0 ? 'err' : '',
      }),
      kpi({
        label: '无法归因',
        value: req.unattributed,
        unit: '次',
        tone: req.unattributed > 0 ? 'warn' : '',
      }),
    )));

  const usedNodes = metrics.nodes.rows.filter((r) => r.used > 0).slice(0, TOP_N);
  box.append(section(`节点用量${metrics.nodes.rows.length > TOP_N ? `（前 ${TOP_N}）` : ''}`,
    usedNodes.length === 0
      ? el('p', { class: 'empty', text: '还没有请求被归因到具体节点。' })
      : el('div', { class: 'ranks' }, ...usedNodes.map((r) => rankRow(r.name, r.used, r.share, !r.exists))),
  ));

  const hitRules = metrics.rules.rows.filter((r) => r.hits > 0).slice(0, TOP_N);
  const coldCount = metrics.rules.rows.filter((r) => r.exists && r.hits === 0).length;
  box.append(section(`规则命中${metrics.rules.rows.length > TOP_N ? `（前 ${TOP_N}）` : ''}`,
    hitRules.length === 0
      ? el('p', { class: 'empty', text: '还没有规则被命中。' })
      : el('div', { class: 'ranks' }, ...hitRules.map((r) => rankRow(r.name, r.hits, r.share, !r.exists))),
    // 「写了却从没命中」是最常见的配置错误，值得在这里点一句
    coldCount > 0
      ? el('p', { class: 'hint', text: `另有 ${coldCount} 条规则一次都没命中，可在设置页逐条核对。` })
      : null,
  ));

  const apply = metrics.apply;
  box.append(section('运行',
    el('div', { class: 'ranks' },
      el('p', { class: 'hint', text: `上次注入分流脚本：${fmtAgo(stats.lastApplyAt)}` }),
      el('p', { class: 'hint', text: `注入成功 ${apply.ok} 次 / 失败 ${apply.fail} 次` }),
      el('p', { class: 'hint', text: `测速成功 ${metrics.probe.ok} 次 / 失败 ${metrics.probe.fail} 次` }),
      el('p', {
        class: 'hint',
        text: metrics.since ? `统计自 ${fmtTime(metrics.since)} 起累计` : '尚未开始累计',
      }),
    ),
    apply.lastError
      ? el('div', { class: 'banner banner--err', text: `上次注入失败：${apply.lastError}` })
      : null,
  ));
}

// ---------------------------------------------------------------- 数据

function logFilterArgs() {
  const value = $('logFilter').value;
  if (!value) return {};
  const [key, val] = value.split(':');
  return { [key]: val };
}

async function guard(fn) {
  try {
    setBanner($('errorBanner'), '');
    await fn();
  } catch (e) {
    setBanner($('errorBanner'), e.message || String(e), 'err');
  }
}

async function loadAll() {
  const state = await send('getState');
  config = state.config;
  stats = state.stats;
  metrics = state.metrics ?? null;
  logs = state.logs ?? [];
  renderStatus(state.control);
  renderStats();
  renderBody();
}

/**
 * 轻量刷新：只拉日志与统计。
 * 节点/规则视图不重建 —— 用户可能正按着某个开关，重建会打断操作。
 */
async function tick() {
  try {
    const res = await send('getLogs', { ...logFilterArgs(), limit: 60 });
    if (res.stats) {
      stats = res.stats;
      renderStats();
    }
    if (res.metrics) metrics = res.metrics;
    logs = res.logs ?? [];
    if (view === 'logs' || view === 'stats') renderBody();
  } catch {
    // 弹窗轮询失败不值得打扰用户，下一次 tick 会再试
  }
}

async function toggleNode(id, enabled) {
  await guard(async () => {
    const res = await send('updateNode', { id, patch: { enabled } });
    config = res.config;
    renderStatus();
    renderBody();
    await tick();
  });
}

async function probeOne(id) {
  await guard(async () => {
    const res = await send('probeNode', { id });
    config = res.config;
    renderBody();
    if (!res.result.ok) setBanner($('errorBanner'), `测速失败：${res.result.error}`, 'warn');
    await tick();
  });
}

// ---------------------------------------------------------------- 事件

for (const item of VIEWS) {
  $(item.tab).addEventListener('click', () => setView(item.key));
}

$('masterSwitch').addEventListener('change', async (e) => {
  await guard(async () => {
    const res = await send('setEnabled', { enabled: e.target.checked });
    config = res.config;
    renderStatus(res.control);
    renderBody();
    await tick();
  });
});

$('btnProbeAll').addEventListener('click', async () => {
  const button = $('btnProbeAll');
  button.disabled = true;
  button.textContent = '测速中…';
  await guard(async () => {
    await send('probeAll');
    await loadAll();
  });
  button.disabled = false;
  button.textContent = '一键测速';
});

$('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('btnClearLogs').addEventListener('click', async () => {
  await guard(async () => {
    await send('clearLogs');
    await loadAll();
  });
});

$('logFilter').addEventListener('change', tick);

window.addEventListener('unload', () => clearInterval(timer));

// ---------------------------------------------------------------- 启动

setView(VIEWS[0].key);
guard(async () => {
  await loadAll();
  timer = setInterval(tick, REFRESH_MS);
});
