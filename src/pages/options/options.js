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
  downloadText, copyText, fileStamp, uiDbg, flushUiDebug,
} from '../shared/api.js';
import { btn, badge, statusChip, statusLabel, setBanner, announce, kpi, shareBar, kvRow } from '../shared/ui.js';
import { matchUrl, matchPacUrl, compileRule, validateRule, createRule } from '../../lib/rule-matcher.js';
import { deepRetryPatterns } from '../../lib/deep-retry.js';
import { pacUrl, isSanitizedScheme } from '../../lib/pac-url.js';

import { isSupported, isSelectable, protocolLabel, unsupportedNodes } from '../../lib/node-model.js';
import { selectablePool } from '../../lib/scheduler.js';
import { parseFallbackProxy } from '../../lib/fallback-proxy.js';
import { parseDefaultProxy, defaultProxyWarnings } from '../../lib/default-proxy.js';
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
  // 调试日志的条数只在切到「诊断」时拉一次：它不需要跟着秒表跳，
  // 而每次拉取都要唤醒 Service Worker
  if (target.hash === 'diagnostics') void refreshDebugState();
  uiDbg('panel', { hash: target.hash });
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
  renderRetryKpis();
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
    // 「规则之外的流量走哪」必须出现在状态里。接管浏览器代理设置会连带顶掉「使用系统代理」，
    // 而那件事的唯一现象是「除图片站外全部网站超时」—— 排查时第一眼要能看到这一格。
    // 顺带把接管前的原始模式也写出来：它是「你原来确实在走代理」的凭证
    kvRow('规则之外的流量', config.settings.defaultProxy.enabled
      ? el('span', { class: 'status status--ok', text: `走 ${config.settings.defaultProxy.raw}` })
      : el('span', {
        class: control?.priorMode && control.priorMode !== 'direct' ? 'status status--warn' : 'status status--muted',
        text: control?.priorMode && control.priorMode !== 'direct'
          ? `直连（接管前浏览器是「${control.priorMode}」）`
          : '直连',
      })),
    kvRow('上次注入分流脚本', stats.lastApplyAt
      ? `${fmtTime(stats.lastApplyAt)}（${fmtAgo(stats.lastApplyAt)}）`
      : '从未'),
    kvRow('注入次数', apply ? `成功 ${apply.ok} 次 / 失败 ${apply.fail} 次` : '—'),
    kvRow('测速次数', probe
      ? `成功 ${probe.ok} 次 / 失败 ${probe.fail} 次`
        + (probe.successRate === null ? '' : `（成功率 ${probe.successRate}%）`)
      : '—'),
    // 标签必须说出它量的是什么。真实数据里探测握手 503ms、而拉图 p90 是 15.8s ——
    // 叫「平均延迟」会被直接读成「图片多久能到」，那是两个数量级的误导
    kvRow('可用节点探测延迟', fmtLatency(stats.avgLatency)),
    kvRow('探测最快的节点', stats.fastest
      ? `${stats.fastest.name}（${fmtLatency(stats.fastest.latencyMs)}）`
      : '—'),
  );

  // 上一次注入失败的原因必须留在界面上 —— 它是「配了却不生效」的头号线索。
  // 用固定的告警条而不是往列表里 append：后者每次轮询都会重建，读屏会反复播报
  setBanner($('applyError'), apply?.lastError ? `上次注入分流脚本失败：${apply.lastError}` : '', 'err');
}

/**
 * 请求统计的 KPI。
 *
 * 这里的 `hint` 一律**按条件给**：数字正常时，解释它为什么可能不正常纯属噪音，
 * 而十张卡片各挂一行常驻说明，等于把整屏最有用的数字挤到折叠线以下。所以
 * 「什么算成功、耗时怎么算」这类随时成立的话进卡片的 .card__help 折叠区，
 * 这里只留「这个数字现在不对劲」时才需要看到的那一句。
 *
 * 「命中但直连」的完整解释不在 hint 里 —— 它是全屏最值得响的警报，
 * 单独走下面的 blindWarning，那里放得下具体条数和该怎么改。
 *
 * **标签必须配得上数据。** 上一版把 `routed`（= total - blind）叫「真的走了代理」，
 * 而一个 `ERR_CONNECTION_CLOSED` 同样计入 routed —— 它连都没连上，谈不上走通。
 * 唯一能证明走通的是 `viaNodeIp`。所以这两格现在分别叫「按规则送去代理」和
 * 「对端确认是代理」：前者是意图，后者是结果。
 */
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
    }),
    // 平均值不单独出现：真实数据里它是 2ms 缓存与 16s 长尾搅出来的 3.6s，
    // 谁都没有过那个体验。p50 是「一般多久」，p90 是「最慢的那一成多久」
    kpi({ label: '耗时中位数', value: req.latencyP50, unit: 'ms' }),
    kpi({
      label: '慢的那一成',
      value: req.latencyP90,
      unit: 'ms',
      tone: req.latencyP90 === null ? '' : (req.latencyP90 >= 8000 ? 'warn' : 'ok'),
      hint: req.latencyP90 !== null && req.latencyP90 >= 8000 ? '十张里有一张要等这么久' : '',
    }),
    kpi({ label: '平均耗时', value: req.avgLatencyMs, unit: 'ms' }),
    kpi({
      label: '缓存命中',
      value: req.cached,
      unit: '次',
      hint: req.cached > 0 ? '没有走网络，不计入上面的总量' : '',
    }),
    kpi({
      label: '按规则送去代理',
      value: req.routed,
      unit: '次',
      // routed = total - blind，所以「routed 为 0」与「blind 等于 total」是同一件事：
      // 下面的 blindWarning 必然同时亮着，而且说得更具体。这里只留色调，不重复文字
      tone: req.total > 0 && req.routed === 0 ? 'err' : 'ok',
    }),
    kpi({
      label: '对端确认是代理',
      value: req.viaNodeIp,
      unit: '次',
      tone: req.routed > 0 && req.viaNodeIp === 0 ? 'warn' : 'ok',
      hint: req.routed > 0 && req.viaNodeIp === 0 ? '没有响应来自你的节点地址' : '',
    }),
    kpi({
      label: '规则命中但直连',
      value: req.blind,
      unit: '次',
      tone: req.blind > 0 ? 'err' : '',
    }),
    kpi({
      label: '无法归因',
      value: req.unattributed,
      unit: '次',
      tone: req.unattributed > 0 ? 'warn' : '',
      hint: req.unattributed > 0 ? '收到了响应但认不出是哪个节点' : '',
    }),
  );

  // 头号故障模式，也是唯一值得占满一条 banner 的诊断：规则看起来对、实际一个请求都没代理出去
  setBanner($('blindWarning'), req.blind > 0
    ? `有 ${req.blind} 个请求命中了规则却仍然直连。`
      + 'HTTPS 只把「协议 + 域名 + 端口」交给分流脚本，路径与查询串会被剥掉，'
      + '所以依赖扩展名或路径的规则（例如 \\.jpg$）对 HTTPS 图片永远命中不了 —— '
      + '不报错，只是安静地直连。把这类规则改成「域名」类型即可。'
    : '', 'err');
}

/**
 * 重试与兜底的 KPI。
 *
 * 这几个数字全是**观测值**：重试由本扩展的内容脚本亲自发起，重发之后是 load 还是
 * error 也由它回报。所以「重试救回」是真的收到了 load，不是「大概成功了」。
 *
 * 「重试」为零并不一定是好事 —— 也可能是兜底策略选了「直连原图」，代理连不上时
 * 浏览器静默改走直连、图片正常显示、根本不派发 error。那种矛盾组合由 renderSettings
 * 那边的 retryWarning 负责说，这里只在数字本身不对劲时给色调。
 *
 * **两格是补上一版的账。** 「结果未知」和「页面没捕获」以前不存在，于是：
 * 重发了 7 次、救回 6 次，四个格子加起来却是 6，差的那 1 次无处可查；13 次失败里
 * 有 3 次内容脚本压根没看见，而「未重试」显示 0，读起来像「每次失败都重试了」。
 */
function renderRetryKpis() {
  const box = $('retryKpis');
  clear(box);
  const retry = metrics?.retry;
  const fb = metrics?.fallbackProxy;
  if (!retry || !fb) return;

  box.append(
    kpi({ label: '重试', value: retry.attempted, unit: '次' }),
    kpi({
      label: '重试救回',
      value: retry.recovered,
      unit: '次',
      tone: retry.attempted > 0 && retry.recovered === 0 ? 'warn' : 'ok',
    }),
    kpi({
      label: '重试成功率',
      value: retry.recoveryRate,
      unit: '%',
      tone: retry.recoveryRate === null ? '' : (retry.recoveryRate >= 50 ? 'ok' : 'warn'),
    }),
    kpi({
      label: '用尽仍失败',
      value: retry.exhausted,
      unit: '次',
      tone: retry.exhausted > 0 ? 'err' : '',
      hint: retry.exhausted > 0 ? '所有节点都取不到这些图' : '',
    }),
    kpi({
      label: '结果未知',
      value: retry.abandoned,
      unit: '次',
      hint: retry.abandoned > 0 ? '重发了，但图片已被页面换掉' : '',
    }),
    kpi({
      label: '还没有结论',
      value: retry.pending,
      unit: '次',
      hint: retry.pending > 0 ? '刚重发出去，仍在等加载结果' : '',
    }),
    kpi({
      label: '判定为不重试',
      value: retry.skipped,
      unit: '次',
      hint: retry.skipped > 0 ? '多为图源自己回了 4xx/5xx' : '',
    }),
    kpi({
      label: '页面没捕获',
      value: retry.unseen,
      unit: '次',
      tone: retry.unseen > 0 ? 'warn' : '',
      hint: retry.unseen > 0 ? '这些裂图重试机制碰不到' : '',
    }),
    kpi({
      label: '深度重试',
      value: retry.deep,
      unit: '次',
      tone: retry.deep > 0 ? 'ok' : '',
      hint: retry.deep > 0 ? '主世界补丁问的（fetch / XHR / 预加载图）' : '',
    }),
    kpi({ label: '兜底接管', value: fb.used, unit: '次' }),
    kpi({
      label: '兜底成功率',
      value: fb.successRate,
      unit: '%',
      tone: fb.successRate === null ? '' : (fb.successRate >= 90 ? 'ok' : 'warn'),
    }),
    kpi({
      label: '冷却期跳过',
      value: fb.cooldown,
      unit: '次',
      tone: fb.cooldown > 0 ? 'warn' : '',
      hint: fb.cooldown > 0 ? '这些图本该兜底，但图源刚用过、在冷却期' : '',
    }),
  );

  // 「页面没捕获」不为零是一个结构性结论，不是一次偶发失败：这个站点的图不是
  // DOM 里的 <img>，重试机制对它整体无效。它值得一条 banner —— 否则用户只会
  // 反复调重试次数，而那个旋钮对这些图一点作用都没有
  //
  // 补丁装上之后措辞必须跟着变：那时「调高重试次数没有用」不再成立，而
  // 「deep 恒为 0 但 unseen 照旧居高不下」反倒是「补丁没装上」的指认
  setBanner($('unseenWarning'), retry.unseen > 0
    ? `有 ${retry.unseen} 次失败没能被页面捕获到，重试机制碰不到它们。`
      + '只有 DOM 里的 <img> 会派发可捕获的 error，而很多阅读器用 new Image() 预加载、'
      + '或用 fetch 取 blob —— 那些图裂了，扩展收不到任何通知，调高重试次数也没有用。'
      + (retry.deep > 0
        ? `（「深度重试」已经接住了 ${retry.deep} 次，剩下的这些是补丁也够不到的：CSS 背景图、canvas。）`
        : '要覆盖这类请求，请在下面的「深度重试站点」里加上这个站点。')
    : '', 'warn');
}

/**
 * 节点使用分布。
 *
 * **这张表有可能整体没有意义，那就该整体收起来。** 归因靠请求的对端 IP，而
 * `webRequest` 不给对端端口 —— 于是「一台机器开 19 个端口」这种常见配置下，19 个节点
 * 在这里根本分不开，表格只会渲染出 19 行 0/0/0/—/0%。上一版加了一段解释文字，话是
 * 对的，但那 19 行全零仍然摆在那里，读者第一眼看到的还是「轮询好像坏了」。
 *
 * 判断「分不分得开」的逻辑在 lib/metrics.js（allShared / sharedHosts）——
 * 那是关于数据的结论，页面只负责按结论选一种呈现。
 */
function renderNodeUsage() {
  const body = $('nodeUsageBody');
  clear(body);
  const rows = metrics?.nodes.rows ?? [];
  const shared = metrics?.nodes.sharedHosts ?? [];
  // 全部节点共用地址时，表格里不可能出现任何非零行 —— 收起来，只留那句解释
  const collapsed = Boolean(metrics?.nodes.allShared);
  const empty = rows.length === 0;

  $('nodeUsageEmpty').hidden = !empty || collapsed;
  $('nodeUsageTable').hidden = empty || collapsed;

  const note = $('nodeUsageShared');
  note.hidden = shared.length === 0;
  if (shared.length > 0) {
    const detail = shared.map(({ host, count }) => `${host}（${count} 个）`).join('、');
    note.textContent = collapsed
      ? `你的 ${rows.length} 个节点全在 ${detail} 上，只有端口不同。浏览器只告诉扩展对端的 IP、`
        + '不给端口，所以这张表分不出是哪个节点 —— 逐行列出只会得到一片 0，索性收起来了。'
        + '这些请求全部计入上面的「无法归因」。想确认轮询是否均匀，'
        + '请看代理服务商后台的分端口流量（步骤见 docs/VERIFICATION.md）。'
      : `注意：${detail} 上的节点共用同一个地址，只有端口不同。`
        + '浏览器只告诉扩展对端的 IP、不给端口，所以这些节点在本表里无法区分，'
        + '它们的请求全部计入上面的「无法归因」。想确认轮询是否均匀，请看代理服务商后台的分端口流量。';
  }

  if (empty || collapsed) return;

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

  // 「有规则一次都没命中」只在真的有冷规则时才说，而且要说清是几条 ——
  // 常驻一段「命中 0 次的规则值得查一下」，在全部命中时纯属占地方。
  // 弹窗那边（popup.js 的冷规则提示）用的是同一个判定
  const cold = rows.filter((row) => row.exists && row.hits === 0).length;
  setBanner($('coldRuleNote'), cold > 0
    ? `有 ${cold} 条规则一次都没命中：要么写错了，要么根本没有匹配的请求。`
      + '可在「规则」分区用规则测试器逐条验证。'
    : '', 'warn');

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
  $('retryAttempts').value = s.retry.maxAttempts;
  $('retryDelay').value = s.retry.delayMs;
  $('fallbackProxyRaw').value = s.fallbackProxy.raw;
  $('fallbackProxyUser').value = s.fallbackProxy.username;
  $('fallbackProxyPass').value = s.fallbackProxy.password;
  $('fallbackProxyEnabled').checked = s.fallbackProxy.enabled;
  $('defaultProxyMode').value = s.defaultProxy.enabled ? 'proxy' : 'direct';
  $('defaultProxyRaw').value = s.defaultProxy.raw;
  $('defaultProxyUser').value = s.defaultProxy.username;
  $('defaultProxyPass').value = s.defaultProxy.password;
  $('deepRetrySites').value = (s.deepRetry?.sites ?? []).join('\n');
  $('deepRetryEnabled').checked = s.deepRetry?.enabled === true;
  $('probeUrl').value = s.probe.url;
  $('probeTimeout').value = s.probe.timeoutMs;
  $('probeInterval').value = s.probe.intervalMinutes;
  $('failureThreshold').value = s.probe.failureThreshold;
  $('logLimit').value = s.logLimit;
  $('bypassList').value = s.bypassList.join(', ');
  $('autoDisable').checked = s.probe.autoDisable;
  $('recoverProbe').checked = s.probe.recoverProbe;
  renderRetryWarning();
  renderDeepRetryWarning();
  renderDefaultProxyWarning();
}

/**
 * 深度重试的两条提示。
 *
 * **逐行说明为什么某一条没被接受，是这块 UI 的主要价值。**
 * `chrome.scripting.registerContentScripts()` 对非法 match pattern 是整批拒绝的，
 * 一条写错十条一起不注册；而注册失败之后页面照常加载、补丁只是不存在 —— 表现就是
 * 「勾了但没用」。所以被摘出来的条目必须带着原因显示在填它的地方。
 *
 * 第二条是「开关自己关了」：一条可用站点都没有时 schema 会强制 enabled=false
 * （与兜底模板非法时同一条纪律），界面上得说清它为什么关了。
 */
function renderDeepRetryWarning() {
  const s = config.settings;
  const raw = $('deepRetrySites').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const { patterns, skipped } = deepRetryPatterns(raw);
  const wantsDeep = $('deepRetryEnabled').checked || raw.length > 0;

  const problems = [];
  if (skipped.length > 0) {
    problems.push(`有 ${skipped.length} 条填法不能用，它们不会被注入：`
      + skipped.map((x) => `「${x.raw}」—— ${x.reason}`).join('；'));
  }
  if ($('deepRetryEnabled').checked && patterns.length === 0) {
    problems.push('开关已勾选，但没有一条可用的站点 —— 保存后开关会自动关闭，'
      + '因为「显示开着、实际一个页面都不会被注入」是本扩展刻意不保存的状态。');
  }
  if (wantsDeep && s.fallback === 'direct') {
    problems.push('「全部失败后」目前是直连原图：那种情况下代理连不上会被浏览器静默改走直连，'
      + '深度重试同样一次都不会触发。想让它生效，请改选「不直连」。');
  }
  setBanner($('deepRetryWarning'), problems.join('　'), 'warn');

  setBanner($('deepRetryScope'), patterns.length > 0 && $('deepRetryEnabled').checked
    ? `补丁会被注入到：${patterns.join('、')}。只有这些范围内的页面会被注入，其余站点一个字节都没有。`
    : '', 'info');
}

/**
 * 「设置得看着在生效、实际整块失效」的那两种组合。
 *
 * 头一种是本次改动里最容易踩的坑：兜底策略选「直连原图」时，代理连不上会被浏览器
 * 静默改走直连 —— 图片正常显示、不派发 error，于是内容脚本什么都收不到，重试和
 * 兜底代理**一次都不会触发**，而真实 IP 已经交给图源了。这个后果必须写在做选择的
 * 地方，不能只写进文档。
 *
 * 第二种是兜底代理地址填了但不可用：规范化时会强制把开关关掉（见 lib/schema.js），
 * 界面上得说清楚它为什么自己关了，否则就是又一个静默失败 —— 1.4.x 的兜底图片代理
 * 正是栽在这里：把一个 HTTP 正向代理填进 `?url=` 模板框，三项校验全过，真用到时每次 400。
 */
function renderRetryWarning() {
  const s = config.settings;
  const raw = s.fallbackProxy.raw;
  const wantsRetry = s.retry.maxAttempts > 1 || Boolean(raw);
  const check = raw ? parseFallbackProxy(raw) : { ok: true };

  if (s.fallback === 'direct' && wantsRetry) {
    setBanner($('retryWarning'),
      '当前「全部失败后」是直连原图：代理连不上时浏览器会静默改走直连，图片照常显示、'
      + '不会报错 —— 于是重试与兜底代理一次都不会触发，而你的真实 IP 已经交给图源了。'
      + '想让它们生效，请改选「不直连」。',
      'warn');
    return;
  }
  if (!check.ok) {
    setBanner($('retryWarning'),
      `兜底代理地址不可用，已自动停用：${check.reason}`,
      'warn');
    return;
  }
  setBanner($('retryWarning'), '');
}

/**
 * 「规则之外的流量」这一节的警示。
 *
 * 三种情况，都必须说出来：
 *
 * 1. **选了直连**（默认）。这不是错，但后果得让用户当场看见：注入 PAC 会替换掉浏览器
 *    整份代理配置（含「使用系统代理」），所以规则之外的网站变成真·直连。靠本机客户端
 *    上网的人会看到「图片站正常、其余网站全部 ERR_CONNECTION_TIMED_OUT」，而扩展一个错
 *    都不报 —— 这正是本项目最贵的那类静默故障。
 * 2. **地址填了但不可用**：规范化时会强制关掉开关（见 lib/schema.js），得说清为什么。
 * 3. **存得下但多半不如所愿**（例如填成了轮询节点），交给 defaultProxyWarnings()。
 */
function renderDefaultProxyWarning() {
  const dp = config.settings.defaultProxy;
  const raw = dp.raw;
  const check = raw ? parseDefaultProxy(raw) : { ok: true };

  if (raw && !check.ok) {
    setBanner($('defaultProxyWarning'),
      `默认代理地址不可用，已自动停用（规则之外的流量将直连）：${check.reason}`,
      'warn');
    return;
  }
  if (!dp.enabled) {
    setBanner($('defaultProxyWarning'),
      '规则之外的流量当前是直连。本扩展一生效就会接管浏览器整份代理设置，'
      + '你原来的「使用系统代理」不再生效 —— 若你平时靠本机代理客户端上网，'
      + '除图片站以外的网站会连不上（ERR_CONNECTION_TIMED_OUT）。'
      + '要保留原来的通路，把客户端的端口填在上面并改选「走指定代理」。',
      'warn');
    return;
  }
  const notes = defaultProxyWarnings(dp, config.nodes);
  setBanner($('defaultProxyWarning'), notes.join(' '), 'warn');
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
    next.settings.retry.maxAttempts = Number($('retryAttempts').value);
    next.settings.retry.delayMs = Number($('retryDelay').value);
    next.settings.fallbackProxy = {
      enabled: $('fallbackProxyEnabled').checked,
      raw: $('fallbackProxyRaw').value.trim(),
      username: $('fallbackProxyUser').value,
      password: $('fallbackProxyPass').value,
    };
    next.settings.defaultProxy = {
      enabled: $('defaultProxyMode').value === 'proxy',
      raw: $('defaultProxyRaw').value.trim(),
      username: $('defaultProxyUser').value,
      password: $('defaultProxyPass').value,
    };
    next.settings.deepRetry = {
      enabled: $('deepRetryEnabled').checked,
      sites: $('deepRetrySites').value.split('\n').map((s) => s.trim()).filter(Boolean),
    };
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
  // 预设**必须**是「只靠协议+域名+端口就能判定」的形态：HTTPS 请求交给分流脚本时
  // 路径与查询串已被浏览器剥掉（见 lib/pac-url.js）。1.2.0 及以前这里放的是
  // `\.(jpe?g|png|webp)$` 之类依赖扩展名的正则，README 还教用户优先启用它 ——
  // 结果那条规则对 HTTPS 图片永远命中不了，扩展看起来装了却一个请求都没代理出去。
  const presets = [
    { name: '图片 CDN 子域', type: 'regex', pattern: '^https?://(img|image|images|pic|pics|photo|cdn|static|media|res)\\d*\\.' },
    { name: '图片域名（把 example.com 换成你的图源）', type: 'host', pattern: 'example.com' },
    { name: '常见图片扩展名（仅 http 图源有效）', type: 'regex', pattern: '^http://[^/]+/.*\\.(jpe?g|png|webp|gif|avif|bmp)(\\?.*)?$' },
  ];
  await guard(async () => {
    for (const preset of presets) {
      // 预设默认关闭：让用户确认过再启用，避免一键代理掉整个浏览器的图片
      await send('saveRule', { rule: { ...preset, enabled: false, nodeIds: [] } });
    }
    await refresh();
    setBanner($('ruleError'), '已插入 3 条预设规则（默认关闭，请确认后逐条启用）。'
      + '优先用「域名」类型：HTTPS 请求只把协议+域名+端口交给分流脚本，依赖路径或扩展名的规则对 HTTPS 不生效。', 'ok');
  }, 'ruleError');
});

$('btnTestRule').addEventListener('click', () => {
  const url = $('ruleTester').value.trim();
  const box = $('ruleTestResult');
  if (!url) {
    setBanner(box, '请输入一个 URL', 'warn');
    return;
  }

  // 两次判定：浏览器实际交给分流脚本的 URL（权威），以及完整 URL（用户的意图）。
  // 只报后者是 1.2.0 那份规则测试器的问题 —— 它说「命中」，浏览器里却是直连。
  const seen = pacUrl(url);
  const stripped = isSanitizedScheme(url) && seen !== url;
  const seenNote = stripped
    ? `浏览器只会把 ${seen} 交给分流脚本（HTTPS 的路径与查询串被剥掉）。`
    : '';

  const rule = matchPacUrl(url, config.rules);
  if (!rule) {
    const intended = matchUrl(url, config.rules);
    if (intended) {
      setBanner(box, `${seenNote}规则「${intended.name}」（${RULE_TYPE_LABELS[intended.type]}）在完整 URL 上命中，`
        + '但分流脚本判定不了 → 这个请求实际会**直连**。请把它改成「域名」类型，'
        + '或让规则只约束域名部分。', 'err');
      return;
    }
    setBanner(box, `${seenNote}未命中任何启用的规则 → 该请求会直连，不走代理。`, 'info');
    return;
  }

  const scope = compileRule(rule).scope;
  const widened = stripped && scope
    ? `注意：HTTPS 下这条规则实际按「${scope.pat}」整段生效，范围比你写的更宽。`
    : '';

  const pool = selectablePool(config.nodes, compileRule(rule).nodeIds);
  if (pool.length === 0) {
    setBanner(box, `${seenNote}命中规则「${rule.name}」（${RULE_TYPE_LABELS[rule.type]}），`
      + `但当前没有可用的 HTTP/HTTPS 节点 → 会按兜底策略处理。${widened}`, 'warn');
    return;
  }
  setBanner(box,
    `${seenNote}命中规则「${rule.name}」（${RULE_TYPE_LABELS[rule.type]}）→ 将在这 ${pool.length} 个节点间轮询：`
    + pool.map((n) => `${n.name}（${protocolLabel(n.protocol)}·${statusLabel(n)}）`).join('、')
    + (widened ? ` ${widened}` : ''),
    'ok');
});


for (const id of ['strategy', 'fallback', 'rotateEvery', 'retryAttempts', 'retryDelay',
  'fallbackProxyRaw', 'fallbackProxyUser', 'fallbackProxyPass', 'fallbackProxyEnabled',
  'defaultProxyMode', 'defaultProxyRaw', 'defaultProxyUser', 'defaultProxyPass',
  'deepRetrySites', 'deepRetryEnabled',
  'probeUrl', 'probeTimeout',
  'probeInterval', 'failureThreshold', 'logLimit', 'bypassList', 'autoDisable', 'recoverProbe']) {
  $(id).addEventListener('change', saveSettings);
}

// 逐行的「这条为什么不能用」必须边打字边出现。等到 change（失焦或保存）才说，
// 用户已经离开那个输入框了，提示与它指的那一行对不上
for (const id of ['deepRetrySites', 'deepRetryEnabled']) {
  $(id).addEventListener('input', renderDeepRetryWarning);
}

// 兜底代理地址同理：不可用的原因要边打字边说，别等保存之后才发现开关自己关了
$('fallbackProxyRaw').addEventListener('input', renderRetryWarning);

// 默认代理更要边打字边说：这一项配错的后果是「除图片站外全部网站超时」，
// 而那个现象看起来完全不像是这个输入框造成的
$('defaultProxyRaw').addEventListener('input', () => {
  // 打字过程中 config 还是旧的，先把当前输入喂进去，否则提示总慢一拍
  config.settings.defaultProxy = { ...config.settings.defaultProxy, raw: $('defaultProxyRaw').value.trim() };
  renderDefaultProxyWarning();
});
$('defaultProxyMode').addEventListener('change', () => {
  config.settings.defaultProxy = {
    ...config.settings.defaultProxy,
    enabled: $('defaultProxyMode').value === 'proxy',
  };
  renderDefaultProxyWarning();
});

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

// ---------------------------------------------------------------- 开发者调试日志

/** 面板上那行状态。空缓冲要说「还没记到东西」，不能显示成 0 条了事 —— 两者的下一步不同 */
function renderDebugState(state) {
  $('chkDebug').checked = state.enabled === true;
  if (!state.enabled) {
    $('debugStatus').textContent = '未开启。开启后重现一次问题，再回来导出。';
    return;
  }
  const { count, bytes, limit, byteBudget } = state.stats;
  const groups = Object.entries(state.groups).map(([ns, n]) => `${ns} ${n}`).join('、');
  $('debugStatus').textContent = `已开启：${count} 条 / ${(bytes / 1024).toFixed(1)} KB`
    + `（上限 ${limit} 条 / ${Math.round(byteBudget / 1024 / 1024)} MB，超出后丢最早的）。`
    + (groups || '还没有记录到任何东西 —— 去重现一次问题。');
}

/** 逐个触发下载。中间留一点间隔：连着几个 click() 浏览器可能只落地最后一个 */
async function downloadAll(files) {
  for (const [index, file] of files.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    downloadText(file.name, file.text, 'text/plain;charset=utf-8');
  }
}

async function refreshDebugState() {
  await guard(async () => {
    renderDebugState(await send('getDebug'));
  }, 'debugError');
}

$('chkDebug').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await guard(async () => {
    renderDebugState(await send('setDebug', { enabled }));
    setBanner($('debugError'),
      enabled
        ? '已开启。现在去重现一次问题（打开出问题的漫画页），然后回来导出。'
        : '已关闭，缓冲已清空。',
      'ok');
  }, 'debugError');
});

$('btnExportDebug').addEventListener('click', async () => {
  await guard(async () => {
    // 先把本页攒着的那几行发过去，否则 ui 那份文件会缺掉最后一段
    await flushUiDebug();
    const res = await send('exportDebug');
    if (res.files.length === 0) {
      setBanner($('debugError'), '还没有记录到任何调试日志。请先打开上面的开关，再重现一次问题。', 'warn');
      return;
    }
    await downloadAll(res.files);
    setBanner($('debugError'),
      `已导出 ${res.files.length} 个文件（${res.files.map((f) => f.name).join('、')}）。`
      + '浏览器可能会问一次「是否允许下载多个文件」。',
      'ok');
  }, 'debugError');
});

$('btnExportDebugMerged').addEventListener('click', async () => {
  await guard(async () => {
    await flushUiDebug();
    const res = await send('exportDebug');
    if (!res.merged) {
      setBanner($('debugError'), '还没有记录到任何调试日志。请先打开上面的开关，再重现一次问题。', 'warn');
      return;
    }
    downloadText(res.merged.name, res.merged.text, 'text/plain;charset=utf-8');
    setBanner($('debugError'),
      `已导出 ${res.merged.name}。跨环节的时间线只有这份合并文件连得起来。`, 'ok');
  }, 'debugError');
});

$('btnClearDebug').addEventListener('click', async () => {
  await guard(async () => {
    renderDebugState(await send('clearDebug'));
    setBanner($('debugError'), '调试日志已清空（「最近活动」与统计都不受影响）。', 'ok');
  }, 'debugError');
});

// ---------------------------------------------------------------- 启动

activatePanel(location.hash.slice(1));
guard(async () => {
  await refresh();
});
