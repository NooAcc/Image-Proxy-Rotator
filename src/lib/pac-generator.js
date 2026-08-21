/**
 * PAC 脚本生成器 —— 本扩展的路由核心。
 *
 * 为什么是 PAC（决策 D1）：`chrome.proxy` 的 PAC 模式是扩展唯一能让**浏览器网络栈**
 * 把不同请求交给不同代理的手段。`fetch` 无法指定代理，`declarativeNetRequest` 只能
 * 改 URL 而不能改传输层。
 *
 * 为什么轮询计数器在 PAC 里（决策 D2）：PAC 上下文在多次 FindProxyForURL 调用之间
 * 保持模块作用域变量，因此计数器可以驻留其中，无需每请求与 Service Worker 通信。
 *
 * 生成的脚本必须满足三条硬约束：
 *   1. 顶层 try/catch 兜底返回 'DIRECT' —— 一条手误的正则不能让整个浏览器断网。
 *   2. 不含任何凭据 —— PAC 里写不了代理账号密码，认证走 webRequest.onAuthRequired。
 *   3. 所有用户输入一律经 JSON.stringify 注入，绝不字符串拼接。
 */

import { PROBE_PARAM } from './constants.js';
import { pacToken, isSelectable } from './node-model.js';
import { validateRule, wildcardToRegexSource } from './rule-matcher.js';

/** 私有网段 / 本地地址的 shExpMatch 模式 */
function privatePatterns() {
  const patterns = ['127.*', '10.*', '192.168.*', '169.254.*', '::1', '[::1]', 'fe80:*', 'fc*', 'fd*'];
  for (let i = 16; i <= 31; i++) patterns.push(`172.${i}.*`);
  return patterns;
}

/**
 * 把配置编译成 PAC 需要的数据结构。
 * @returns {{data: object, skipped: {nodes: string[], rules: string[]}}}
 */
function compile(config) {
  const settings = config?.settings ?? {};
  const nodes = Array.isArray(config?.nodes) ? config.nodes : [];
  const rules = Array.isArray(config?.rules) ? config.rules : [];

  const skippedNodes = [];
  /** 探测用：包含**所有**能表达出 token 的节点，含被禁用的 —— 否则无法测速与恢复 */
  const tokens = {};
  /** 轮询用：只包含当前可参与分流的节点 */
  const liveTokens = new Map();

  for (const node of nodes) {
    const token = pacToken(node);
    if (token === null) {
      // 只有「用户以为它能用」的节点才值得报告为被跳过
      if (node?.enabled !== false && node?.autoDisabled !== true) skippedNodes.push(node?.id);
      continue;
    }
    tokens[node.id] = token;
    if (isSelectable(node)) liveTokens.set(node.id, token);
  }

  const allLive = [...liveTokens.values()];
  const skippedRules = [];
  const pools = [];

  for (const rule of rules) {
    if (rule?.enabled === false) continue;
    if (!validateRule(rule).ok) {
      skippedRules.push(rule?.id);
      continue;
    }

    // 规则绑定的子集全挂了就回落到全部可用节点（与 scheduler.selectablePool 语义一致）
    let poolTokens = allLive;
    if (Array.isArray(rule.nodeIds) && rule.nodeIds.length > 0) {
      const subset = rule.nodeIds.filter((id) => liveTokens.has(id)).map((id) => liveTokens.get(id));
      if (subset.length > 0) poolTokens = subset;
    }

    const entry = { kind: rule.type, pat: rule.pattern, rx: null, tokens: poolTokens };
    if (rule.type === 'regex') entry.rx = rule.pattern;
    if (rule.type === 'wildcard') entry.rx = wildcardToRegexSource(rule.pattern);
    pools.push(entry);
  }

  return {
    data: {
      enabled: config?.enabled === true,
      fallback: settings.fallback === 'block' ? 'block' : 'direct',
      rotateEvery: Math.max(1, Number.parseInt(settings.rotateEvery, 10) || 1),
      bypass: Array.isArray(settings.bypassList) ? settings.bypassList.filter((x) => x && x !== '<local>') : [],
      privates: privatePatterns(),
      probeParam: PROBE_PARAM,
      tokens,
      pools,
    },
    skipped: { nodes: skippedNodes, rules: skippedRules },
  };
}

/**
 * 统计当前配置在 PAC 里的生效情况，供 UI 展示「有几条被忽略」。
 * @returns {{nodeCount: number, ruleCount: number, skipped: {nodes: string[], rules: string[]}}}
 */
export function pacSummary(config) {
  const { data, skipped } = compile(config);
  const live = new Set();
  for (const pool of data.pools) for (const token of pool.tokens) live.add(token);
  return {
    nodeCount: Object.keys(data.tokens).filter((id) => (config.nodes || []).some((n) => n.id === id && isSelectable(n))).length,
    ruleCount: data.pools.length,
    poolTokenCount: live.size,
    skipped,
  };
}

/**
 * 生成完整 PAC 脚本。
 * @param {object} config 完整配置
 * @param {{startIndex?: number}} options startIndex 决定轮询从第几个节点起步
 * @returns {string} PAC 脚本源码
 */
export function generatePac(config, options = {}) {
  const { data } = compile(config);
  const startIndex = Number.isInteger(options.startIndex) && options.startIndex >= 0 ? options.startIndex : 0;

  return `// 由「漫画图片代理分流」扩展自动生成，请勿手动修改。
var PP = ${JSON.stringify(data)};
var PP_I = ${startIndex};
var PP_N = 0;

// 规则正则在脚本装载时一次性编译，避免每个请求重复构造。
// 任何一条编译失败都只让那条规则失效，不影响其余规则。
var PP_RX = [];
for (var _i = 0; _i < PP.pools.length; _i++) {
  PP_RX[_i] = null;
  if (PP.pools[_i].rx) {
    try { PP_RX[_i] = new RegExp(PP.pools[_i].rx); } catch (e) { PP_RX[_i] = null; }
  }
}

function PP_bypass(host) {
  if (isPlainHostName(host)) return true;
  var i;
  for (i = 0; i < PP.bypass.length; i++) {
    if (host === PP.bypass[i] || shExpMatch(host, PP.bypass[i])) return true;
  }
  for (i = 0; i < PP.privates.length; i++) {
    if (shExpMatch(host, PP.privates[i])) return true;
  }
  return false;
}

// 识别「这是一次针对某个节点的延迟探测」，返回节点 id 或 null。
function PP_probeNode(url) {
  var key = PP.probeParam + '=';
  var at = url.indexOf(key);
  if (at < 0) return null;
  var rest = url.substring(at + key.length);
  var amp = rest.indexOf('&');
  return amp < 0 ? rest : rest.substring(0, amp);
}

function PP_matchPool(url, host) {
  for (var i = 0; i < PP.pools.length; i++) {
    var pool = PP.pools[i];
    var hit = false;
    if (pool.kind === 'exact') {
      hit = (url === pool.pat);
    } else if (pool.kind === 'prefix') {
      hit = (url.indexOf(pool.pat) === 0);
    } else if (pool.kind === 'host') {
      hit = (host === pool.pat) ||
        (host.length > pool.pat.length &&
         host.substring(host.length - pool.pat.length - 1) === '.' + pool.pat);
    } else if (PP_RX[i]) {
      hit = PP_RX[i].test(url);
    }
    if (hit) return pool.tokens;
  }
  return null;
}

// 轮询：取当前下标，然后按 rotateEvery 决定是否前进。
function PP_pick(tokens) {
  if (!tokens || tokens.length === 0) return null;
  var picked = tokens[PP_I % tokens.length];
  PP_N++;
  if (PP_N % PP.rotateEvery === 0) PP_I = (PP_I + 1) % tokens.length;
  return picked;
}

function FindProxyForURL(url, host) {
  try {
    if (!PP.enabled) return 'DIRECT';

    // 探测请求优先处理：强制走指定节点，且**不加 DIRECT 兜底** ——
    // 否则节点挂了也会静默直连，测出来的延迟就是假的。
    var probeId = PP_probeNode(url);
    if (probeId !== null) {
      return PP.tokens[probeId] || 'DIRECT';
    }

    if (PP_bypass(host)) return 'DIRECT';

    var tokens = PP_matchPool(url, host);
    if (!tokens) return 'DIRECT';

    var picked = PP_pick(tokens);
    if (!picked) return 'DIRECT';

    return PP.fallback === 'direct' ? (picked + '; DIRECT') : picked;
  } catch (e) {
    // 宁可全部直连，也绝不让 PAC 异常把浏览器整成断网。
    return 'DIRECT';
  }
}
`;
}
