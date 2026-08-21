/**
 * 设置页逻辑。
 *
 * 单向数据流：所有写操作都发消息给后台，用返回的 config 重渲染整页 ——
 * 页面不维护第二份状态，也就不会出现「界面显示的和实际生效的不一致」。
 *
 * 分区靠 URL hash 切换（options.html#rules）。这样浏览器前进/后退能用，
 * 也能把某一屏的链接直接给别人；刷新后还停在原来那一屏。
 *
 * 本程序只支持 HTTP/HTTPS 代理；不受支持的节点会被显式标注并且永不参与分流。
 */

import {
  send, el, clear, debounce, fmtLatency, fmtAgo, fmtTime,
  downloadText, copyText, fileStamp,
} from '../shared/api.js';
import { btn, badge, statusChip, statusLabel, setBanner, announce, kpi, shareBar, kvRow } from '../shared/ui.js';
import { matchUrl, compileRule, validateRule, createRule } from '../../lib/rule-matcher.js';
import { isSupported, isSelectable, protocolLabel, unsupportedNodes } from '../../lib/node-model.js';
import { selectablePool } from '../../lib/scheduler.js';
import { RULE_TYPE_LABELS, UNSUPPORTED_PROTOCOL_MESSAGE } from '../../lib/constants.js';

const $ = (id) => document.getElementById(id);

/**
 * 分区：hash 里的名字 → 对应 section 的 id。
 *
 * 两者刻意**不同名**。如果 hash 恰好等于某个元素的 id，浏览器会自作主张把那个
 * 元素滚进视口 —— 而顶栏和窄屏下的横向导航都是 sticky，滚过去的结果是标题正好
 * 被压在导航底下，而且这个滚动发生在脚本之后，脚本里 scrollTo(0) 也拦不住。
 * 让 hash 谁都匹配不上，浏览器就不滚了，滚动完全由本文件说了算。
 *
 * 顺序即侧栏顺序；第一个是默认分区。
 */
const PANELS = [
  { hash: 'stats', panel: 'panelStats' },
  { hash: 'nodes', panel: 'panelNodes' },
  { hash: 'rules', panel: 'panelRules' },
  { hash: 'routing', panel: 'panelRouting' },
  { hash: 'diagnostics', panel: 'panelDiagnostics' },
];

/** 当前配置（只作为渲染快照，写操作一律走后台） */
let config = null;
let warnings = {};
let ruleNotes = {};
let stats = {};
let metrics = null;
let control = null;
/** 正在编辑的规则 id；null 表示新建 */
let editingRuleId = null;

// ---------------------------------------------------------------- 分区导航

function activatePanel(wanted) {
  const target = PANELS.find((p) => p.hash === wanted) ?? PANELS[0];
  for (const item of PANELS) $(item.panel).hidden = item !== target;
  for (const link of document.querySelectorAll('.navitem')) {
    if (link.getAttribute('href') === `#${target.hash}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  // 统计是唯一需要持续刷新的一屏，切走就停 —— 每次轮询都会唤醒 Service Worker
  setStatsPoll(target.hash === 'stats');
  // 换了一屏就该从头看，而不是停在上一屏滚到的位置
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- 渲染

function render() {
  renderTopbar();
  renderStatsPanel();
  renderNodes();
  renderRules();
  renderRuleWarnings();
  renderRuleNodeOptions();
  renderSettings();
}

/**
 * 「为什么没生效」的唯一判定处。
 *
 * 顶栏摘要和统计面板都用它，避免两处各写一遍判断然后慢慢长歪。
 * @returns {{text: string, tone: 'ok'|'warn'|'err'|'muted'}}
 */
function runState() {
  const available = config.nodes.filter(isSelectable).length;
  const activeRules = config.rules.filter((r) => r.enabled && validateRule(r).ok).length;
  const occupied = Boolean(control) && !control.controlled && control.levelOfControl !== 'unavailable';

  if (!config.enabled) return { text: '已关闭，当前全部直连', tone: 'muted' };
  if (occupied) return { text: '代理设置被其他程序占用', tone: 'err' };
  if (available === 0) return { text: '没有可用节点，当前全部直连', tone: 'err' };
  if (activeRules === 0) return { text: '没有生效的规则，当前全部直连', tone: 'warn' };
  return { text: `已生效（${available} 个节点 / ${activeRules} 条规则）`, tone: 'ok' };
}

function renderTopbar() {
  $('masterSwitch').checked = config.enabled;
  $('masterLabel').textContent = config.enabled ? '已启用' : '已关闭';

  const available = config.nodes.filter(isSelectable).length;
  const unsupported = unsupportedNodes(config.nodes).length;
  const activeRules = config.rules.filter((r) => r.enabled && validateRule(r).ok).length;

  $('navCountNodes').textContent = config.nodes.length || '';
  $('navCountRules').textContent = config.rules.length || '';

  const parts = [
    `${config.nodes.length} 个节点（可用 ${available}${unsupported ? `，不支持 ${unsupported}` : ''}）`,
    `${config.rules.length} 条规则（生效 ${activeRules}）`,
  ];
  // 「为什么没生效」必须直接写在最显眼处，而不是让用户翻各个分区自己拼线索
  const state = runState();
  if (state.tone !== 'ok') parts.push(state.text);
  announce($('summaryText'), parts.join('　·　'));
}

// ---------------------------------------------------------------- 统计面板

function renderStatsPanel() {
  // 轮询可能早于首次 getState 返回就跑起来（启动时 activatePanel 先执行），
  // 这时还没有配置可渲染
  if (!config) return;
  renderRunState();
  renderRequestKpis();
  renderNodeUsage();
  renderRuleHits();
}

function renderRunState() {
  const box = $('runStateList');
  clear(box);
  const state = runState();
  const apply = metrics?.apply;
  const probe = metrics?.probe;

  $('metricsSince').textContent = metrics?.since
    ? `以下数字自 ${fmtTime(metrics.since)}（${fmtAgo(metrics.since)}）起累计，跨浏览器重启保留。`
    : '还没有任何统计数据。开启总开关并访问漫画页后，这里就会开始累计。';

  box.append(
    kvRow('当前状态', el('span', { class: `status status--${state.tone}` },
      el('span', { class: 'status__glyph', 'aria-hidden': 'true', text: state.tone === 'ok' ? '●' : '○' }),
      el('span', { text: state.text }))),
    kvRow('代理设置控制权', control
      ? el('span', {
        class: control.controlled ? 'status status--ok' : 'status status--warn',
        text: control.controlled ? '由本扩展掌握' : `${control.levelOfControl}（可能被占用）`,
      })
      : '未知'),
    kvRow('上次注入分流脚本', stats.lastApplyAt
      ? `${fmtTime(stats.lastApplyAt)}（${fmtAgo(stats.lastApplyAt)}）`
      : '从未'),
    kvRow('注入次数', apply ? `成功 ${apply.ok} 次 / 失败 ${apply.fail} 次` : '—'),
    kvRow('测速次数', probe
      ? `成功 ${probe.ok} 次 / 失败 ${probe.fail} 次`
        + (probe.successRate === null ? '' : `（成功率 ${probe.successRate}%）`)
      : '—'),
    kvRow('可用节点平均延迟', fmtLatency(stats.avgLatency)),
    kvRow('当前最快节点', stats.fastest
      ? `${stats.fastest.name}（${fmtLatency(stats.fastest.latencyMs)}）`
      : '—'),
  );

  // 上一次注入失败的原因必须留在界面上 —— 它是「配了却不生效」的头号线索。
  // 用固定的告警条而不是往列表里 append：后者每次轮询都会重建，读屏会反复播报
  setBanner($('applyError'), apply?.lastError ? `上次注入分流脚本失败：${apply.lastError}` : '', 'err');
}

function renderRequestKpis() {
  const box = $('requestKpis');
  clear(box);
  const req = metrics?.requests;
  if (!req) return;

  box.append(
    kpi({ label: '走代理的请求', value: req.total, unit: '次' }),
    kpi({ label: '成功', value: req.ok, unit: '次', tone: 'ok' }),
    kpi({ label: '失败', value: req.fail, unit: '次', tone: req.fail > 0 ? 'err' : '' }),
    kpi({
      label: '成功率',
      value: req.successRate,
      unit: '%',
      tone: req.successRate === null ? '' : (req.successRate >= 95 ? 'ok' : 'warn'),
      hint: 'HTTP 状态码小于 400 算成功',
    }),
    kpi({ label: '平均耗时', value: req.avgLatencyMs, unit: 'ms', hint: '只统计真的测到耗时的请求' }),
    kpi({
      label: '无法归因',
      value: req.unattributed,
      unit: '次',
      tone: req.unattributed > 0 ? 'warn' : '',
      hint: '认不出走的是哪个节点。先测速可减少；数字很大则多半是在走直连兜底',
    }),
  );
}

function renderNodeUsage() {
  const body = $('nodeUsageBody');
  clear(body);
  const rows = metrics?.nodes.rows ?? [];
  const empty = rows.length === 0;
  $('nodeUsageEmpty').hidden = !empty;
  $('nodeUsageTable').hidden = empty;
  if (empty) return;

  for (const row of rows) {
    body.append(el('tr', { class: row.exists ? '' : 'is-off' },
      el('td', { class: 'truncate' }, row.name, row.exists ? null : badge('已删除', 'warn')),
      el('td', { class: 'num', text: `${row.used}` }),
      el('td', { class: 'num', text: `${row.ok}` }),
      el('td', { class: 'num', text: `${row.fail}` }),
      el('td', { class: 'num', text: row.successRate === null ? '—' : `${row.successRate}%` }),
      el('td', {}, shareBar(row.share)),
    ));
  }

  // 已删除节点的历史用量单独成行：不这么做，各节点占比加起来就不到 100%，
  // 用户会以为统计算错了
  if (metrics.nodes.retiredUsed > 0) {
    body.append(el('tr', { class: 'is-off' },
      el('td', { class: 'truncate', text: '已删除的节点（历史累计）' }),
      el('td', { class: 'num', text: `${metrics.nodes.retiredUsed}` }),
      el('td', { class: 'num', text: '—' }),
      el('td', { class: 'num', text: '—' }),
      el('td', { class: 'num', text: '—' }),
      el('td', {}, shareBar(Math.round((metrics.nodes.retiredUsed / metrics.nodes.totalUsed) * 1000) / 10)),
    ));
  }
}

function renderRuleHits() {
  const body = $('ruleHitBody');
  clear(body);
  const rows = metrics?.rules.rows ?? [];
  const empty = rows.length === 0;
  $('ruleHitEmpty').hidden = !empty;
  $('ruleHitTable').hidden = empty;
  if (empty) return;

  for (const row of rows) {
    body.append(el('tr', { class: row.exists && row.hits > 0 ? '' : 'is-off' },
      el('td', { class: 'truncate' }, row.name, row.exists ? null : badge('已删除', 'warn')),
      el('td', {}, row.type ? badge(RULE_TYPE_LABELS[row.type] ?? row.type) : '—'),
      el('td', { class: 'pattern truncate', text: row.pattern || '—', title: row.pattern }),
      el('td', { class: 'num', text: `${row.hits}` }),
      el('td', {}, shareBar(row.share)),
    ));
  }
}

function renderNodes() {
  const body = $('nodeTableBody');
  clear(body);
  const empty = config.nodes.length === 0;
  $('nodeEmpty').hidden = !empty;
  $('nodeTable').hidden = empty;

  for (const node of config.nodes) {
    const supported = isSupported(node);
    const usable = supported && node.enabled && !node.autoDisabled;
    const used = metrics?.nodes.rows.find((r) => r.id === node.id)?.used ?? 0;

    body.append(el('tr', { class: usable ? '' : 'is-off' },
      el('td', {},
        el('label', { class: 'switch switch--sm' },
          el('span', { class: 'sr-only', text: `启用节点 ${node.name}` }),
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
          'aria-label': `节点名称：${node.name}`,
          onchange: (e) => updateNode(node.id, { name: e.target.value }),
        }),
      ),
      el('td', {}, badge(protocolLabel(node.protocol), supported ? 'accent' : 'err')),
      el('td', { class: 'addr' },
        `${node.host}:${node.port}`,
        // 用文字徽标而不是 🔒 —— emoji 在各平台字形差异大，且读屏念法不可控
        node.username ? badge('认证') : null,
      ),
      el('td', { class: 'latency', text: supported ? fmtLatency(node.health.latencyMs) : '—' }),
      el('td', {},
        statusChip(node),
        node.health.lastCheckedAt && supported
          ? el('p', { class: 'hint', text: fmtAgo(node.health.lastCheckedAt) })
          : null,
      ),
      el('td', { class: 'used', text: `${used}` }),
      el('td', {}, el('div', { class: 'cell-ops' },
        supported ? btn({ text: '测速', size: 'sm', onClick: () => probeOne(node.id) }) : null,
        supported && node.autoDisabled
          ? btn({ text: '重置', size: 'sm', title: '清除自动禁用状态', onClick: () => resetNode(node.id) })
          : null,
        btn({ text: '删除', size: 'sm', variant: 'danger', onClick: () => deleteNode(node.id) }),
      )),
    ));
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
      class: 'banner banner--err',
      text: `有 ${unsupported.length} 个节点的类型为 ${kinds}：${UNSUPPORTED_PROTOCOL_MESSAGE}。`
        + '这些节点已停用且不会参与分流，建议点「清除不支持的」删除它们。',
    }));
  }

  // 逐节点提示。协议不支持的已在上面汇总过，这里跳过，避免同一件事说两遍
  for (const node of config.nodes) {
    if (!isSupported(node)) continue;
    for (const message of warnings[node.id] ?? []) {
      box.append(el('div', { class: 'banner banner--warn', text: `「${node.name}」${message}` }));
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

    body.append(el('tr', { class: rule.enabled && check.ok ? '' : 'is-off' },
      el('td', {},
        el('label', { class: 'switch switch--sm' },
          el('span', { class: 'sr-only', text: `启用规则 ${rule.name}` }),
          el('input', {
            type: 'checkbox',
            checked: rule.enabled,
            onchange: (e) => saveRule({ ...rule, enabled: e.target.checked }),
          }),
        ),
      ),
      el('td', { class: 'truncate', text: rule.name }),
      el('td', {}, badge(RULE_TYPE_LABELS[rule.type] ?? rule.type)),
      el('td', { class: 'pattern truncate', text: rule.pattern, title: rule.pattern }),
      el('td', { class: 'truncate', text: boundNames.length ? boundNames.join('、') : '全部可用节点' }),
      el('td', {},
        el('div', { class: 'cell-ops' },
          btn({ text: '编辑', size: 'sm', onClick: () => startEditRule(rule) }),
          // 上下箭头始终渲染、到头才禁用 —— 按条件隐藏会让每行按钮数不同，
          // 「删除」的位置跟着左右跳，很容易点错
          btn({
            text: '↑', size: 'sm', title: '上移', disabled: index === 0,
            onClick: () => moveRule(index, -1),
          }),
          btn({
            text: '↓', size: 'sm', title: '下移', disabled: index === config.rules.length - 1,
            onClick: () => moveRule(index, 1),
          }),
          btn({ text: '删除', size: 'sm', variant: 'danger', onClick: () => deleteRule(rule.id) }),
        ),
        // 规则非法的原因必须贴在这一行上，而不是丢到页面顶部让用户猜是哪条
        check.ok ? null : el('p', { class: 'field__error', text: check.reason }),
      ),
    ));
  });
}

function renderRuleWarnings() {
  const box = $('ruleWarnings');
  clear(box);
  for (const rule of config.rules) {
    for (const message of ruleNotes[rule.id] ?? []) {
      box.append(el('div', { class: 'banner banner--warn', text: `规则「${rule.name}」：${message}` }));
    }
  }
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
    setBanner($('controlWarning'), '');
    return;
  }
  setBanner($('controlWarning'),
    `浏览器代理设置的控制权当前是「${control.levelOfControl}」，可能被其他代理类扩展或系统/`
    + '企业策略占用，分流可能不生效。请关闭其他代理扩展后重试。',
    'warn');
}

// ---------------------------------------------------------------- 数据操作

async function refresh(response) {
  const state = response ?? await send('getState');
  config = state.config;
  if (state.warnings) warnings = state.warnings;
  if (state.ruleWarnings) ruleNotes = state.ruleWarnings;
  if (state.stats) stats = state.stats;
  if (state.metrics) metrics = state.metrics;
  if (state.control) {
    control = state.control;
    renderControlWarning(state.control);
  }
  render();
}

/**
 * 统计面板的轻量轮询。
 *
 * 只在这一屏可见时跑 —— 每次轮询都会唤醒 Service Worker，切到别的分区还继续轮询
 * 纯属浪费。用 getLogs 而不是 getState：前者已经带着统计与节点盘点，把 limit 压到 1
 * 就不会顺带搬运一堆日志。
 */
const STATS_POLL_MS = 5000;
let statsTimer = null;

async function pollStats() {
  try {
    const res = await send('getLogs', { limit: 1 });
    if (res.stats) stats = res.stats;
    if (res.metrics) metrics = res.metrics;
    if (res.control) control = res.control;
    renderStatsPanel();
  } catch {
    // 轮询失败不值得打扰用户，下一次会再试
  }
}

function setStatsPoll(active) {
  if (active && !statsTimer) {
    statsTimer = setInterval(pollStats, STATS_POLL_MS);
    void pollStats();
  } else if (!active && statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

/** 统一的错误出口：任何失败都要在界面上说清楚，不允许静默 */
async function guard(fn, bannerId = 'globalError') {
  try {
    setBanner($(bannerId), '');
    await fn();
  } catch (e) {
    setBanner($(bannerId), e.message || String(e), 'err');
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
      setBanner($('globalError'), `节点测速失败：${res.result.error}`, 'warn');
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
    $('ruleFormTitle').textContent = '新建规则';
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
  $('ruleFormTitle').textContent = `编辑规则「${rule.name}」`;
  setBanner($('ruleError'), '');
  $('rulePattern').focus();
}

function resetRuleForm() {
  editingRuleId = null;
  $('ruleName').value = '';
  $('rulePattern').value = '';
  for (const option of $('ruleNodes').options) option.selected = false;
  $('btnResetRuleForm').hidden = true;
  $('ruleFormTitle').textContent = '新建规则';
  setBanner($('ruleError'), '');
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
    const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    announce($('settingsSaved'), `设置已保存（${at}）`);
  });
}, 400);

// ---------------------------------------------------------------- 事件绑定

window.addEventListener('hashchange', () => activatePanel(location.hash.slice(1)));

$('masterSwitch').addEventListener('change', async (e) => {
  await guard(async () => {
    const res = await send('setEnabled', { enabled: e.target.checked });
    renderControlWarning(res.control);
    await refresh({ config: res.config });
  });
});

$('btnAddNodes').addEventListener('click', async () => {
  const text = $('nodeInput').value.trim();
  setBanner($('importErrors'), '');
  if (!text) {
    setBanner($('importErrors'), '请先粘贴节点链接', 'warn');
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
  setBanner($('importErrors'), lines.join('\n'), headline ? 'err' : level);
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
    setBanner($('globalError'), `测速完成：${ok}/${res.results.length} 个节点可用`,
      ok === res.results.length ? 'ok' : 'warn');
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
    setBanner($('globalError'), `已清除 ${res.removed} 个不支持的节点`, 'ok');
    await refresh({ config: res.config });
  });
});

$('btnDeleteDisabled').addEventListener('click', async () => {
  const ids = config.nodes.filter((n) => !n.enabled || n.autoDisabled).map((n) => n.id);
  if (ids.length === 0) {
    setBanner($('globalError'), '没有已禁用的节点', 'info');
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
    setBanner($('ruleError'), check.reason, 'err');
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
    setBanner($('ruleError'), '已插入 3 条预设规则（默认关闭，请确认后逐条启用）', 'ok');
  }, 'ruleError');
});

$('btnTestRule').addEventListener('click', () => {
  const url = $('ruleTester').value.trim();
  const box = $('ruleTestResult');
  if (!url) {
    setBanner(box, '请输入一个 URL', 'warn');
    return;
  }

  const rule = matchUrl(url, config.rules);
  if (!rule) {
    setBanner(box, '未命中任何启用的规则 → 该请求会直连，不走代理。', 'info');
    return;
  }

  const pool = selectablePool(config.nodes, compileRule(rule).nodeIds);
  if (pool.length === 0) {
    setBanner(box, `命中规则「${rule.name}」（${RULE_TYPE_LABELS[rule.type]}），`
      + '但当前没有可用的 HTTP/HTTPS 节点 → 会按兜底策略处理。', 'warn');
    return;
  }
  setBanner(box,
    `命中规则「${rule.name}」（${RULE_TYPE_LABELS[rule.type]}）→ 将在这 ${pool.length} 个节点间轮询：`
    + pool.map((n) => `${n.name}（${protocolLabel(n.protocol)}·${statusLabel(n)}）`).join('、'),
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
    setBanner($('ioError'),
      ok ? '配置已复制到剪贴板，同时填入下方文本框。' : '剪贴板不可用，配置已填入下方文本框。',
      'ok');
  }, 'ioError');
});

$('btnImportText').addEventListener('click', async () => {
  const text = $('configText').value.trim();
  if (!text) {
    setBanner($('ioError'), '请先把配置 JSON 粘贴到上方文本框', 'warn');
    return;
  }
  await guard(async () => {
    const res = await send('importConfig', { text, merge: $('chkImportMerge').checked });
    await refresh({ config: res.config });
    setBanner($('ioError'), '配置已导入。', 'ok');
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
    setBanner($('ioError'), `已从 ${file.name} 导入配置。`, 'ok');
  }, 'ioError');
  e.target.value = '';
});

$('btnRefreshPac').addEventListener('click', async () => {
  await guard(async () => {
    const res = await send('getPacPreview');
    $('pacPreview').textContent = res.pac;
  }, 'ioError');
});

$('btnResetMetrics').addEventListener('click', async () => {
  if (!confirm('确定把所有统计计数清零？\n\n只影响统计数字，节点、规则与设置都不会变。')) return;
  await guard(async () => {
    const res = await send('resetMetrics');
    metrics = res.metrics;
    renderStatsPanel();
    setBanner($('globalError'), '统计数据已清零。', 'ok');
  });
});

// ---------------------------------------------------------------- 启动

activatePanel(location.hash.slice(1));
guard(async () => {
  await refresh();
});
