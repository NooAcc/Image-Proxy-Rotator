/**
 * 设置页逻辑。
 *
 * 单向数据流：所有写操作都发消息给后台，用返回的 config 重渲染整页 ——
 * 页面不维护第二份状态，也就不会出现「界面显示的和实际生效的不一致」。
 *
 * 本程序只支持 HTTP/HTTPS 代理；不受支持的节点会被显式标注并且永不参与分流。
 */

import {
  send, el, clear, showBanner, debounce, fmtLatency, fmtAgo,
  healthLabel, healthDotClass, downloadText, copyText, fileStamp,
} from '../shared/api.js';
import { matchUrl, compileRule, validateRule, createRule } from '../../lib/rule-matcher.js';
import { isSupported, isSelectable, protocolLabel, unsupportedNodes } from '../../lib/node-model.js';
import { selectablePool } from '../../lib/scheduler.js';
import { RULE_TYPE_LABELS, UNSUPPORTED_PROTOCOL_MESSAGE } from '../../lib/constants.js';

const $ = (id) => document.getElementById(id);

/** 当前配置（只作为渲染快照，写操作一律走后台） */
let config = null;
let warnings = {};
let stats = {};
/** 正在编辑的规则 id；null 表示新建 */
let editingRuleId = null;

// ---------------------------------------------------------------- 渲染

function render() {
  renderHeader();
  renderNodes();
  renderRules();
  renderRuleNodeOptions();
  renderSettings();
}

function renderHeader() {
  $('masterSwitch').checked = config.enabled;
  $('masterLabel').textContent = config.enabled ? '已启用' : '已关闭';

  const available = config.nodes.filter(isSelectable).length;
  const unsupported = unsupportedNodes(config.nodes).length;
  const activeRules = config.rules.filter((r) => r.enabled && validateRule(r).ok).length;

  const parts = [
    `${config.nodes.length} 个节点（可用 ${available} 个${unsupported ? `，不支持 ${unsupported} 个` : ''}）`,
    `${config.rules.length} 条规则（生效 ${activeRules} 条）`,
  ];
  if (!config.enabled) parts.push('总开关关闭，当前全部直连');
  else if (available === 0) parts.push('没有可用节点，当前全部直连');
  else if (activeRules === 0) parts.push('没有生效的规则，当前全部直连');
  $('summaryText').textContent = parts.join('　·　');
}

function renderNodes() {
  const body = $('nodeTableBody');
  clear(body);
  const empty = config.nodes.length === 0;
  $('nodeEmpty').hidden = !empty;
  $('nodeTable').hidden = empty;

  for (const node of config.nodes) {
    const supported = isSupported(node);
    const stat = stats.perNode?.[node.id];

    const row = el('tr', { class: supported && node.enabled && !node.autoDisabled ? '' : 'disabled' },
      el('td', {},
        el('label', { class: 'switch' },
          el('input', {
            type: 'checkbox',
            checked: node.enabled && supported,
            disabled: !supported,
            title: supported ? '启用/禁用该节点' : UNSUPPORTED_PROTOCOL_MESSAGE,
            onchange: (e) => updateNode(node.id, { enabled: e.target.checked }),
          }),
        ),
      ),
      el('td', {},
        el('input', {
          type: 'text',
          class: 'name-input',
          value: node.name,
          onchange: (e) => updateNode(node.id, { name: e.target.value }),
        }),
      ),
      el('td', {},
        el('span', {
          class: `badge ${supported ? 'accent' : 'err'}`,
          text: protocolLabel(node.protocol),
          title: supported ? '' : UNSUPPORTED_PROTOCOL_MESSAGE,
        }),
      ),
      el('td', { class: 'addr', text: `${node.host}:${node.port}${node.username ? ' 🔒' : ''}` }),
      el('td', { text: supported ? fmtLatency(node.health.latencyMs) : '—' }),
      el('td', {},
        el('span', { class: `dot ${supported ? healthDotClass(node) : 'fail'}` }),
        ' ',
        supported ? healthLabel(node) : '不支持',
        node.health.lastCheckedAt && supported
          ? el('div', { class: 'hint', style: 'margin:0', text: fmtAgo(node.health.lastCheckedAt) })
          : null,
      ),
      el('td', { text: stat ? `${stat.used}` : '0' }),
      el('td', {},
        el('div', { class: 'ops' },
          supported
            ? el('button', { class: 'btn tiny', text: '测速', onclick: () => probeOne(node.id) })
            : null,
          supported && node.autoDisabled
            ? el('button', { class: 'btn tiny', text: '重置', onclick: () => resetNode(node.id) })
            : null,
          el('button', { class: 'btn tiny danger', text: '删除', onclick: () => deleteNode(node.id) }),
        ),
      ),
    );
    body.append(row);
  }

  renderNodeWarnings();
  $('btnDeleteUnsupported').hidden = unsupportedNodes(config.nodes).length === 0;
}

function renderNodeWarnings() {
  const box = $('nodeWarnings');
  clear(box);

  const unsupported = unsupportedNodes(config.nodes);
  if (unsupported.length > 0) {
    const kinds = [...new Set(unsupported.map((n) => protocolLabel(n.protocol)))].join(' / ');
    box.append(el('div', {
      class: 'banner err',
      text: `有 ${unsupported.length} 个节点的类型为 ${kinds}：${UNSUPPORTED_PROTOCOL_MESSAGE}。这些节点已停用且不会参与分流，建议点「清除不支持的节点」删除它们。`,
    }));
  }

  // 其余逐节点提示（协议不支持的已在上面汇总，这里跳过）
  for (const node of config.nodes) {
    if (!isSupported(node)) continue;
    for (const message of warnings[node.id] ?? []) {
      box.append(el('div', { class: 'banner warn', text: `「${node.name}」${message}` }));
    }
  }
}

function renderRules() {
  const body = $('ruleTableBody');
  clear(body);
  const empty = config.rules.length === 0;
  $('ruleEmpty').hidden = !empty;
  $('ruleTable').hidden = empty;

  config.rules.forEach((rule, index) => {
    const check = validateRule(rule);
    const boundNames = rule.nodeIds
      .map((id) => config.nodes.find((n) => n.id === id)?.name)
      .filter(Boolean);

    body.append(el('tr', { class: rule.enabled && check.ok ? '' : 'disabled' },
      el('td', {},
        el('label', { class: 'switch' },
          el('input', {
            type: 'checkbox',
            checked: rule.enabled,
            onchange: (e) => saveRule({ ...rule, enabled: e.target.checked }),
          }),
        ),
      ),
      el('td', { text: rule.name }),
      el('td', {}, el('span', { class: 'badge', text: RULE_TYPE_LABELS[rule.type] ?? rule.type })),
      el('td', { class: 'pattern', text: rule.pattern, title: rule.pattern }),
      el('td', { text: boundNames.length ? boundNames.join('、') : '全部可用节点' }),
      el('td', {},
        el('div', { class: 'ops' },
          el('button', { class: 'btn tiny', text: '编辑', onclick: () => startEditRule(rule) }),
          index > 0 ? el('button', { class: 'btn tiny', text: '↑', title: '上移', onclick: () => moveRule(index, -1) }) : null,
          index < config.rules.length - 1 ? el('button', { class: 'btn tiny', text: '↓', title: '下移', onclick: () => moveRule(index, 1) }) : null,
          el('button', { class: 'btn tiny danger', text: '删除', onclick: () => deleteRule(rule.id) }),
        ),
        check.ok ? null : el('div', { class: 'hint', style: 'margin:0;color:var(--err)', text: check.reason }),
      ),
    ));
  });
}

function renderRuleNodeOptions() {
  const select = $('ruleNodes');
  const selected = new Set([...select.selectedOptions].map((o) => o.value));
  clear(select);
  // 只列出可用协议的节点 —— 把不支持的节点摆出来供绑定只会制造困惑
  for (const node of config.nodes.filter(isSupported)) {
    select.append(el('option', {
      value: node.id,
      text: `${node.name}（${protocolLabel(node.protocol)} ${node.host}:${node.port}）`,
      selected: selected.has(node.id),
    }));
  }
}

function renderSettings() {
  const s = config.settings;
  $('strategy').value = s.strategy;
  $('fallback').value = s.fallback;
  $('rotateEvery').value = s.rotateEvery;
  $('probeUrl').value = s.probe.url;
  $('probeTimeout').value = s.probe.timeoutMs;
  $('probeInterval').value = s.probe.intervalMinutes;
  $('failureThreshold').value = s.probe.failureThreshold;
  $('logLimit').value = s.logLimit;
  $('bypassList').value = s.bypassList.join(', ');
  $('autoDisable').checked = s.probe.autoDisable;
  $('recoverProbe').checked = s.probe.recoverProbe;
}

function renderControlWarning(control) {
  if (!control || control.controlled || control.levelOfControl === 'unavailable') {
    showBanner($('controlWarning'), '');
    return;
  }
  showBanner($('controlWarning'),
    `浏览器代理设置的控制权当前是「${control.levelOfControl}」，可能被其他代理类扩展或系统/企业策略占用，分流可能不生效。请关闭其他代理扩展后重试。`,
    'warn');
}

// ---------------------------------------------------------------- 数据操作

async function refresh(response) {
  const state = response ?? await send('getState');
  config = state.config;
  if (state.warnings) warnings = state.warnings;
  if (state.stats) stats = state.stats;
  if (state.control) renderControlWarning(state.control);
  render();
}

/** 统一的错误出口：任何失败都要在界面上说清楚，不允许静默 */
async function guard(fn, bannerId = 'globalError') {
  try {
    showBanner($(bannerId), '');
    await fn();
  } catch (e) {
    showBanner($(bannerId), e.message || String(e), 'err');
  }
}

async function updateNode(id, patch) {
  await guard(async () => refresh(await send('updateNode', { id, patch })));
}

async function deleteNode(id) {
  const node = config.nodes.find((n) => n.id === id);
  if (!confirm(`确定删除节点「${node?.name ?? id}」？`)) return;
  await guard(async () => refresh(await send('deleteNode', { id })));
}

async function probeOne(id) {
  await guard(async () => {
    const res = await send('probeNode', { id });
    await refresh({ config: res.config });
    if (!res.result.ok) {
      showBanner($('globalError'), `节点测速失败：${res.result.error}`, 'warn');
    }
  });
}

async function resetNode(id) {
  await guard(async () => refresh(await send('resetNodeState', { id })));
}

async function saveRule(rule) {
  await guard(async () => {
    const res = await send('saveRule', { rule });
    editingRuleId = null;
    $('btnResetRuleForm').hidden = true;
    await refresh({ config: res.config });
  }, 'ruleError');
}

async function deleteRule(id) {
  await guard(async () => refresh(await send('deleteRule', { id })), 'ruleError');
}

async function moveRule(index, delta) {
  const ids = config.rules.map((r) => r.id);
  const target = index + delta;
  if (target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await guard(async () => refresh(await send('reorderRules', { ids })));
}

function startEditRule(rule) {
  editingRuleId = rule.id;
  $('ruleName').value = rule.name;
  $('ruleType').value = rule.type;
  $('rulePattern').value = rule.pattern;
  for (const option of $('ruleNodes').options) option.selected = rule.nodeIds.includes(option.value);
  $('btnResetRuleForm').hidden = false;
  showBanner($('ruleError'), '');
  $('rulePattern').focus();
}

function resetRuleForm() {
  editingRuleId = null;
  $('ruleName').value = '';
  $('rulePattern').value = '';
  for (const option of $('ruleNodes').options) option.selected = false;
  $('btnResetRuleForm').hidden = true;
  showBanner($('ruleError'), '');
}

const saveSettings = debounce(async () => {
  await guard(async () => {
    const next = structuredClone(config);
    next.settings.strategy = $('strategy').value;
    next.settings.fallback = $('fallback').value;
    next.settings.rotateEvery = Number($('rotateEvery').value);
    next.settings.logLimit = Number($('logLimit').value);
    next.settings.bypassList = $('bypassList').value.split(',').map((s) => s.trim()).filter(Boolean);
    next.settings.probe.url = $('probeUrl').value.trim();
    next.settings.probe.timeoutMs = Number($('probeTimeout').value);
    next.settings.probe.intervalMinutes = Number($('probeInterval').value);
    next.settings.probe.failureThreshold = Number($('failureThreshold').value);
    next.settings.probe.autoDisable = $('autoDisable').checked;
    next.settings.probe.recoverProbe = $('recoverProbe').checked;

    const res = await send('saveConfig', { config: next });
    await refresh({ config: res.config });
    $('settingsSaved').textContent = `设置已保存（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`;
  });
}, 400);

// ---------------------------------------------------------------- 事件绑定

$('masterSwitch').addEventListener('change', async (e) => {
  await guard(async () => {
    const res = await send('setEnabled', { enabled: e.target.checked });
    renderControlWarning(res.control);
    await refresh({ config: res.config });
  });
});

$('btnAddNodes').addEventListener('click', async () => {
  const text = $('nodeInput').value.trim();
  showBanner($('importErrors'), '');
  if (!text) {
    showBanner($('importErrors'), '请先粘贴节点链接', 'warn');
    return;
  }
  try {
    const res = await send('addNodes', { text, merge: $('chkMerge').checked });
    $('nodeInput').value = '';
    reportImport(res);
    await refresh({ config: res.config });
  } catch (e) {
    // 后台把 unsupported / errors 一起挂在 error.response 上，要完整展示
    reportImport(e.response ?? {}, e.message);
    if (e.response?.config) await refresh({ config: e.response.config });
  }
});

/** 把导入结果里的「不支持」与「无法识别」逐条展示出来 */
function reportImport(res, headline = '') {
  const lines = [];
  if (headline) lines.push(headline);
  if (typeof res.added === 'number') lines.push(`成功新增 ${res.added} 个节点。`);
  for (const item of res.unsupported ?? []) {
    lines.push(`✕ ${item.line} —— ${item.label}：${UNSUPPORTED_PROTOCOL_MESSAGE}`);
  }
  for (const item of res.errors ?? []) {
    lines.push(`✕ ${item.line} —— ${item.reason}`);
  }
  if (lines.length === 0) return;
  const level = (res.unsupported?.length || res.errors?.length || headline) ? 'warn' : 'ok';
  showBanner($('importErrors'), lines.join('\n'), headline ? 'err' : level);
  $('importErrors').style.whiteSpace = 'pre-wrap';
}

$('btnProbeAll').addEventListener('click', async () => {
  const button = $('btnProbeAll');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '测速中…';
  await guard(async () => {
    const res = await send('probeAll');
    await refresh({ config: res.config });
    const ok = res.results.filter((r) => r.ok).length;
    showBanner($('globalError'), `测速完成：${ok}/${res.results.length} 个节点可用`, ok === res.results.length ? 'ok' : 'warn');
  });
  button.disabled = false;
  button.textContent = original;
});

$('btnEnableAll').addEventListener('click', async () => {
  await guard(async () => {
    // 只启用支持的协议 —— 不支持的节点启用了也进不去轮询，反而误导
    for (const node of config.nodes.filter((n) => isSupported(n) && !n.enabled)) {
      await send('updateNode', { id: node.id, patch: { enabled: true } });
    }
    await refresh();
  });
});

$('btnDeleteUnsupported').addEventListener('click', async () => {
  const targets = unsupportedNodes(config.nodes);
  if (!confirm(`确定删除 ${targets.length} 个不支持的节点？\n\n${UNSUPPORTED_PROTOCOL_MESSAGE}`)) return;
  await guard(async () => {
    const res = await send('deleteUnsupportedNodes');
    showBanner($('globalError'), `已清除 ${res.removed} 个不支持的节点`, 'ok');
    await refresh({ config: res.config });
  });
});

$('btnDeleteDisabled').addEventListener('click', async () => {
  const ids = config.nodes.filter((n) => !n.enabled || n.autoDisabled).map((n) => n.id);
  if (ids.length === 0) {
    showBanner($('globalError'), '没有已禁用的节点', 'info');
    return;
  }
  if (!confirm(`确定删除 ${ids.length} 个已禁用的节点？`)) return;
  await guard(async () => refresh(await send('deleteNodes', { ids })));
});

$('btnSaveRule').addEventListener('click', async () => {
  const rule = {
    id: editingRuleId ?? undefined,
    name: $('ruleName').value.trim(),
    type: $('ruleType').value,
    pattern: $('rulePattern').value.trim(),
    enabled: true,
    nodeIds: [...$('ruleNodes').selectedOptions].map((o) => o.value),
  };
  const check = validateRule(createRule(rule));
  if (!check.ok) {
    showBanner($('ruleError'), check.reason, 'err');
    return;
  }
  await saveRule(rule);
  resetRuleForm();
});

$('btnResetRuleForm').addEventListener('click', resetRuleForm);

$('btnAddPresets').addEventListener('click', async () => {
  const presets = [
    { name: '常见图片扩展名', type: 'regex', pattern: '\\.(jpe?g|png|webp|gif|avif|bmp)(\\?.*)?$' },
    { name: '图片 CDN 子域', type: 'regex', pattern: '^https?://(img|image|images|pic|photo|cdn)\\d*\\.' },
    { name: '带 image 路径的请求', type: 'regex', pattern: '^https?://[^/]+/.*/(images?|pics?|comic|manga)/' },
  ];
  await guard(async () => {
    for (const preset of presets) {
      // 预设默认关闭：让用户确认过再启用，避免一键代理掉整个浏览器的图片
      await send('saveRule', { rule: { ...preset, enabled: false, nodeIds: [] } });
    }
    await refresh();
    showBanner($('ruleError'), '已插入 3 条预设规则（默认关闭，请确认后逐条启用）', 'ok');
  }, 'ruleError');
});

$('btnTestRule').addEventListener('click', () => {
  const url = $('ruleTester').value.trim();
  const box = $('ruleTestResult');
  if (!url) {
    showBanner(box, '请输入一个 URL', 'warn');
    return;
  }

  const rule = matchUrl(url, config.rules);
  if (!rule) {
    showBanner(box, '未命中任何启用的规则 → 该请求会直连，不走代理。', 'info');
    return;
  }

  const pool = selectablePool(config.nodes, compileRule(rule).nodeIds);
  if (pool.length === 0) {
    showBanner(box, `命中规则「${rule.name}」（${RULE_TYPE_LABELS[rule.type]}），但当前没有可用的 HTTP/HTTPS 节点 → 会按兜底策略处理。`, 'warn');
    return;
  }
  showBanner(box,
    `命中规则「${rule.name}」（${RULE_TYPE_LABELS[rule.type]}）→ 将在这 ${pool.length} 个节点间轮询：`
    + pool.map((n) => `${n.name}（${protocolLabel(n.protocol)}）`).join('、'),
    'ok');
});

for (const id of ['strategy', 'fallback', 'rotateEvery', 'probeUrl', 'probeTimeout',
  'probeInterval', 'failureThreshold', 'logLimit', 'bypassList', 'autoDisable', 'recoverProbe']) {
  $(id).addEventListener('change', saveSettings);
}

$('btnExportFile').addEventListener('click', async () => {
  await guard(async () => {
    const res = await send('exportConfig');
    downloadText(`image-proxy-rotator-config-${fileStamp()}.json`, res.text);
  }, 'ioError');
});

$('btnExportClipboard').addEventListener('click', async () => {
  await guard(async () => {
    const res = await send('exportConfig');
    $('configText').value = res.text;
    const ok = await copyText(res.text);
    showBanner($('ioError'), ok ? '配置已复制到剪贴板，同时填入下方文本框。' : '剪贴板不可用，配置已填入下方文本框。', 'ok');
  }, 'ioError');
});

$('btnImportText').addEventListener('click', async () => {
  const text = $('configText').value.trim();
  if (!text) {
    showBanner($('ioError'), '请先把配置 JSON 粘贴到下方文本框', 'warn');
    return;
  }
  await guard(async () => {
    const res = await send('importConfig', { text, merge: $('chkImportMerge').checked });
    await refresh({ config: res.config });
    showBanner($('ioError'), '配置已导入。', 'ok');
  }, 'ioError');
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await guard(async () => {
    const text = await file.text();
    $('configText').value = text;
    const res = await send('importConfig', { text, merge: $('chkImportMerge').checked });
    await refresh({ config: res.config });
    showBanner($('ioError'), `已从 ${file.name} 导入配置。`, 'ok');
  }, 'ioError');
  e.target.value = '';
});

$('btnRefreshPac').addEventListener('click', async () => {
  await guard(async () => {
    const res = await send('getPacPreview');
    $('pacPreview').textContent = res.pac;
  }, 'ioError');
});

// ---------------------------------------------------------------- 启动

guard(async () => {
  await refresh();
});
