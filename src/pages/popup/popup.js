/**
 * 状态弹窗逻辑。
 *
 * 打开时拉一次完整状态，之后每 2 秒只拉日志与统计（轻量）。
 * 弹窗关闭即停止轮询 —— 否则会让 Service Worker 一直被唤醒。
 */

import {
  send, el, clear, showBanner, fmtTime, fmtLatency,
  healthLabel, healthDotClass,
} from '../shared/api.js';
import { isSupported, isSelectable, protocolLabel, unsupportedNodes } from '../../lib/node-model.js';
import { validateRule } from '../../lib/rule-matcher.js';
import { RULE_TYPE_LABELS, UNSUPPORTED_PROTOCOL_MESSAGE } from '../../lib/constants.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 2000;

let config = null;
let stats = {};
let timer = null;

// ---------------------------------------------------------------- 渲染

function renderStatus(control) {
  const available = config.nodes.filter(isSelectable).length;
  const activeRules = config.rules.filter((r) => r.enabled && validateRule(r).ok).length;

  let text;
  let dot;
  if (!config.enabled) {
    text = '已关闭（全部直连）';
    dot = 'off';
  } else if (control && !control.controlled && control.levelOfControl !== 'unavailable') {
    text = '代理设置被占用';
    dot = 'fail';
  } else if (available === 0) {
    text = '无可用节点';
    dot = 'fail';
  } else if (activeRules === 0) {
    text = '无生效规则';
    dot = 'slow';
  } else {
    text = `已生效（${available} 个节点 / ${activeRules} 条规则）`;
    dot = 'ok';
  }

  $('statusText').textContent = text;
  $('statusDot').className = `dot ${dot}`;
  $('masterSwitch').checked = config.enabled;

  if (control && !control.controlled && control.levelOfControl !== 'unavailable') {
    showBanner($('controlWarning'),
      `浏览器代理设置的控制权是「${control.levelOfControl}」，可能被其他代理扩展或系统策略占用，分流可能不生效。`,
      'warn');
  } else {
    showBanner($('controlWarning'), '');
  }

  const unsupported = unsupportedNodes(config.nodes);
  if (unsupported.length > 0) {
    const kinds = [...new Set(unsupported.map((n) => protocolLabel(n.protocol)))].join(' / ');
    showBanner($('unsupportedWarning'),
      `${unsupported.length} 个节点为 ${kinds} 类型：${UNSUPPORTED_PROTOCOL_MESSAGE}，已停用且不参与分流。`,
      'err');
  } else {
    showBanner($('unsupportedWarning'), '');
  }
}

function renderStats() {
  $('statTotal').textContent = stats.total ?? 0;
  $('statAvailable').textContent = stats.available ?? 0;
  $('statDisabled').textContent = (stats.manualDisabled ?? 0) + (stats.autoDisabled ?? 0);
  $('statAvgLatency').textContent = Number.isFinite(stats.avgLatency) ? `${stats.avgLatency}` : '–';
}

function renderNodes() {
  const box = $('nodeList');
  clear(box);

  if (config.nodes.length === 0) {
    box.append(el('div', { class: 'empty', text: '还没有节点，点「打开设置」添加 HTTP/HTTPS 代理。' }));
    return;
  }

  for (const node of config.nodes) {
    const supported = isSupported(node);
    const stat = stats.perNode?.[node.id];
    box.append(el('div', { class: `node-row ${supported && node.enabled && !node.autoDisabled ? '' : 'off'}` },
      el('span', { class: `dot ${supported ? healthDotClass(node) : 'fail'}` }),
      el('span', { class: 'name', text: node.name, title: `${protocolLabel(node.protocol)} ${node.host}:${node.port} · ${supported ? healthLabel(node) : UNSUPPORTED_PROTOCOL_MESSAGE}` }),
      supported ? null : el('span', { class: 'badge err', text: '不支持' }),
      stat ? el('span', { class: 'used', text: `×${stat.used}` }) : null,
      el('span', { class: 'latency', text: supported ? fmtLatency(node.health.latencyMs) : '—' }),
      supported
        ? el('button', { class: 'btn tiny', text: '测', title: '测试该节点延迟', onclick: () => probeOne(node.id) })
        : null,
      el('label', { class: 'switch' },
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

function renderRules() {
  const box = $('ruleList');
  clear(box);
  const active = config.rules.filter((r) => r.enabled && validateRule(r).ok);

  if (active.length === 0) {
    box.append(el('div', { class: 'empty', text: '没有生效的规则，当前所有请求都直连。' }));
    return;
  }

  for (const rule of active) {
    box.append(el('div', { class: 'rule-row' },
      el('span', { class: 'badge', text: RULE_TYPE_LABELS[rule.type] ?? rule.type }),
      el('span', { class: 'pat', text: rule.pattern, title: `${rule.name}\n${rule.pattern}` }),
    ));
  }
}

function renderLogs(logs) {
  const box = $('logList');
  clear(box);

  if (!logs || logs.length === 0) {
    box.append(el('div', { class: 'empty', text: '暂无记录。开启后访问漫画页即可看到分流情况。' }));
    return;
  }

  for (const row of logs) {
    box.append(el('div', { class: `log-row ${row.level}` },
      el('span', { class: 'at', text: fmtTime(row.at) }),
      el('span', {
        class: 'msg',
        text: row.message + (Number.isFinite(row.latencyMs) ? `（${row.latencyMs}ms）` : ''),
      }),
    ));
  }
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
    showBanner($('errorBanner'), '');
    await fn();
  } catch (e) {
    showBanner($('errorBanner'), e.message || String(e), 'err');
  }
}

async function loadAll() {
  const state = await send('getState');
  config = state.config;
  stats = state.stats;
  renderStatus(state.control);
  renderStats();
  renderNodes();
  renderRules();
  renderLogs(state.logs);
}

/** 轻量刷新：只更新日志与统计，不重建节点/规则列表（避免打断用户操作） */
async function tick() {
  try {
    const res = await send('getLogs', { ...logFilterArgs(), limit: 60 });
    if (res.stats) {
      stats = res.stats;
      renderStats();
    }
    renderLogs(res.logs);
  } catch {
    // 弹窗轮询失败不值得打扰用户，下一次 tick 会再试
  }
}

async function toggleNode(id, enabled) {
  await guard(async () => {
    const res = await send('updateNode', { id, patch: { enabled } });
    config = res.config;
    renderStatus();
    renderNodes();
    await tick();
  });
}

async function probeOne(id) {
  await guard(async () => {
    const res = await send('probeNode', { id });
    config = res.config;
    renderNodes();
    if (!res.result.ok) showBanner($('errorBanner'), `测速失败：${res.result.error}`, 'warn');
    await tick();
  });
}

// ---------------------------------------------------------------- 事件

$('masterSwitch').addEventListener('change', async (e) => {
  await guard(async () => {
    const res = await send('setEnabled', { enabled: e.target.checked });
    config = res.config;
    renderStatus(res.control);
    renderNodes();
    await tick();
  });
});

$('btnProbeAll').addEventListener('click', async () => {
  const button = $('btnProbeAll');
  button.disabled = true;
  button.textContent = '测速中…';
  await guard(async () => {
    const res = await send('probeAll');
    config = res.config;
    renderNodes();
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

guard(async () => {
  await loadAll();
  timer = setInterval(tick, REFRESH_MS);
});
