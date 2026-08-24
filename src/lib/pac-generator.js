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
 * **PAC 管的是整个浏览器，不只是命中规则的那部分。** `chrome.proxy.settings.set` 替换
 * 掉的是浏览器**整份**代理配置，包括「使用系统代理设置」。所以「没命中规则的请求返回
 * 什么」不是一个无关紧要的默认值 —— 它决定了用户其余所有流量的出口。返回字面 `DIRECT`
 * 会让靠本机代理客户端上网的人在启用本扩展后，除图片站以外的网站全部
 * `ERR_CONNECTION_TIMED_OUT`，而扩展这边一个错都不报。这条路由由 `data.dflt` 表达，
 * 详见 lib/default-proxy.js。
 *
 * 生成的脚本必须满足五条硬约束：
 *   1. 顶层 try/catch 必须兜底 —— 一条手误的正则不能让整个浏览器断网。兜的是「规则之外的
 *      流量」那一项（配了默认代理就是它，否则 'DIRECT'），外面再套一层 catch 保底到
 *      'DIRECT'：读一个字符串不可能抛，但这是最后一道防线，不该有假设。
 *   2. 不含任何凭据 —— PAC 里写不了代理账号密码，认证走 webRequest.onAuthRequired。
 *   3. 所有用户输入一律经 JSON.stringify 注入，绝不字符串拼接。
 *   4. **产物必须是纯 ASCII** —— chrome.proxy 的 pacScript.data 只接受 ASCII，出现一个
 *      非 ASCII 字节就整体注入失败（详见 lib/ascii.js 开头）。因此：本文件里的中文注释
 *      一个都不许出现在模板字符串内，用户数据一律走 asciiJson()，域名一律走 toAsciiHost()。
 *      这条由 tests/pac-generator.test.js 的「生成的 PAC 一定是纯 ASCII」把守。
 *   5. **只能依赖 scheme + host + port 做判定**（决策 D16）—— https / wss 请求交到
 *      FindProxyForURL 手上时，path 与 query 已被浏览器剥掉。所以每条 URL 形态的规则
 *      都要额外带一份退化形式（`sanitizedScope()`），否则它在 HTTPS 上永远命中不了，
 *      表现为「扩展安静地什么都没做」。详见 lib/pac-url.js 与 docs/LIMITATIONS.md 第 12 节。
 */

import { asciiJson, toAsciiHost } from './ascii.js';
import { pacToken, isSelectable } from './node-model.js';
import { defaultProxyToken } from './default-proxy.js';
import { validateRule, wildcardToRegexSource, sanitizedScope } from './rule-matcher.js';

/** 私有网段 / 本地地址的 shExpMatch 模式 */
function privatePatterns() {
  const patterns = ['127.*', '10.*', '192.168.*', '169.254.*', '::1', '[::1]', 'fe80:*', 'fc*', 'fd*'];
  for (let i = 16; i <= 31; i++) patterns.push(`172.${i}.*`);
  return patterns;
}

/**
 * 测速请求的识别前缀。
 *
 * 测速必须**强制**走指定节点且不加兜底（决策 D3），可 https 的 query 到不了 PAC，
 * 所以标记不能放在 query 里 —— 只能按「源」来认。代价是测速期间对该源的所有请求都
 * 会被定向到目标节点；测速地址是专用探针端点，不会有别的流量。
 *
 * @returns {string|null} 形如 `https://cp.cloudflare.com/`
 */
function probeOriginPrefix(probeUrl) {
  try {
    return `${new URL(String(probeUrl)).origin}/`;
  } catch {
    return null;
  }
}

/**
 * 测速能不能被强制路由到这个节点。
 *
 * 答案是 false 时**绝不能**发测速请求 —— 那样请求会按普通规则走（多半是直连），
 * 却被记成「该节点延迟 xx ms」。1.2.0 之前正是如此：测速数字全是直连的延迟，
 * 节点因此永远不会被判失败，用户也就永远看不出代理根本没在转发。
 *
 * @param {object} config
 * @param {string} nodeId
 * @returns {boolean}
 */
export function canRouteProbe(config, nodeId) {
  const node = (Array.isArray(config?.nodes) ? config.nodes : []).find((n) => n?.id === nodeId);
  return Boolean(pacToken(node)) && Boolean(probeOriginPrefix(config?.settings?.probe?.url));
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

    // host 型规则比的是浏览器传进来的 host，而那个 host 已经是 Punycode 形式，
    // 所以中文域名必须在这里转码，否则规则永远命中不了（见 lib/ascii.js）
    const pat = rule.type === 'host' ? toAsciiHost(rule.pattern) : rule.pattern;
    const entry = { kind: rule.type, pat, rx: null, san: null, tokens: poolTokens };
    if (rule.type === 'regex') entry.rx = rule.pattern;
    if (rule.type === 'wildcard') entry.rx = wildcardToRegexSource(rule.pattern);
    // 退化形式：https/wss 请求到 PAC 手上时只剩 scheme+host+port（硬约束 5）
    const scope = sanitizedScope(rule);
    if (scope) entry.san = { glob: scope.glob, pat: scope.pat, rx: scope.rx };
    pools.push(entry);
  }

  const bypassList = Array.isArray(settings.bypassList)
    ? settings.bypassList.filter((x) => x && x !== '<local>')
    : [];

  return {
    data: {
      enabled: config?.enabled === true,
      fallback: settings.fallback === 'block' ? 'block' : 'direct',
      rotateEvery: Math.max(1, Number.parseInt(settings.rotateEvery, 10) || 1),
      // 绕过项同样是主机名模式，同样要转码
      bypass: bypassList.map(toAsciiHost),
      privates: privatePatterns(),
      /**
       * 规则之外的流量走谁。空串 = 直连。
       *
       * 这一格是「注入 PAC 会替换掉浏览器整份代理配置」的唯一解药：没有它，所有没命中
       * 规则的请求都会拿到字面 `DIRECT`，于是用户原先经本机代理客户端出去的通路整块消失
       * （详见 lib/default-proxy.js 开头）。
       */
      dflt: defaultProxyToken(settings.defaultProxy) ?? '',
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
 *
 * 模板里的注释**只能用英文**：整个产物必须是纯 ASCII（硬约束 4）。
 * 想解释「为什么这么写」请写在本文件的中文注释里，别写进模板。
 *
 * @param {object} config 完整配置
 * @param {object} options
 * @param {number} [options.startIndex] 轮询从第几个节点起步
 * @param {string} [options.probeNodeId] 传入时生成「测速专用」PAC：发往测速地址所在源的
 *   请求被强制路由到该节点且不加兜底（决策 D3）。其余流量的行为完全不变。
 * @param {{pre: string, tok: string, until: number}[]} [options.forceEntries] 兜底窗口：
 *   这些源在 `until` 之前被强制走兜底代理。见下方 `data.force` 的注释。
 * @returns {string} PAC 脚本源码，保证纯 ASCII
 */
export function generatePac(config, options = {}) {
  const { data } = compile(config);
  const startIndex = Number.isInteger(options.startIndex) && options.startIndex >= 0 ? options.startIndex : 0;

  /**
   * 强制路由表。两种来源共用一张表，因为它们要解决的是同一个问题 ——
   * 让某一类请求绕开轮询池走指定代理，而 https 的 path/query 到不了 PAC，
   * 只能按「源」来认（决策 D3）。
   *
   * `until` 是绝对毫秒时间戳，`0` 表示不过期。
   *
   *   · 测速条目 —— `until: 0`。它由 applyProbePac / applyProxy 显式换下，
   *     生命周期完全受控，加过期只会让一次慢测速在中途失去定向。
   *   · 兜底条目 —— 带真实过期时间。**这一条是刻意的**：若过期只靠后台定时器去重注入
   *     干净 PAC，那么 Service Worker 在窗口期内被回收就会把这个源永久钉在兜底代理上，
   *     没有任何东西会来撤销它，而用户看到的是「扩展好像不轮询了」。把时间写进 PAC
   *     之后，SW 死了 PAC 也会自己到点失效，后台的重注入降级成清理而非正确性依赖。
   *
   * 测速条目排在前面：测速是「这个节点到底通不通」的唯一答案，不能被兜底窗口改写。
   */
  const force = [];
  const probeToken = options.probeNodeId ? data.tokens[options.probeNodeId] : null;
  const probePrefix = probeToken ? probeOriginPrefix(config?.settings?.probe?.url) : null;
  if (probeToken && probePrefix) force.push({ pre: probePrefix, tok: probeToken, until: 0 });

  for (const entry of Array.isArray(options.forceEntries) ? options.forceEntries : []) {
    if (!entry?.pre || !entry?.tok) continue;
    force.push({ pre: String(entry.pre), tok: String(entry.tok), until: Number(entry.until) || 0 });
  }
  data.force = force;

  return `// Generated by the Image Proxy Rotator extension. Do not edit by hand.
// ASCII only: chrome.proxy rejects a pacScript.data that contains any non-ASCII byte.
//
// Chromium strips path and query from https:// and wss:// URLs before calling
// FindProxyForURL, so anything below that needs more than scheme+host+port has a
// "san" fallback compiled from the same rule.
var PP = ${asciiJson(data)};
var PP_I = ${startIndex};
var PP_N = 0;

// Rule regexes are compiled once at load time rather than rebuilt per request.
// If one fails to compile, only that rule goes dead; the rest keep working.
var PP_RX = [];
var PP_SRX = [];
for (var _i = 0; _i < PP.pools.length; _i++) {
  PP_RX[_i] = null;
  PP_SRX[_i] = null;
  if (PP.pools[_i].rx) {
    try { PP_RX[_i] = new RegExp(PP.pools[_i].rx); } catch (e) { PP_RX[_i] = null; }
  }
  if (PP.pools[_i].san && PP.pools[_i].san.rx) {
    try { PP_SRX[_i] = new RegExp(PP.pools[_i].san.rx); } catch (e) { PP_SRX[_i] = null; }
  }
}

// True when the browser handed us a URL with path and query removed.
function PP_stripped(url) {
  return url.indexOf('https:') === 0 || url.indexOf('wss:') === 0;
}

// Forced routes: probe traffic and fallback windows. Entries with a non-zero
// "until" expire on their own, so a Service Worker that dies mid-window cannot
// pin an origin to the fallback proxy forever.
function PP_forced(url) {
  var now = 0;
  try { now = Date.now(); } catch (e) { now = 0; }
  for (var i = 0; i < PP.force.length; i++) {
    var entry = PP.force[i];
    if (url.indexOf(entry.pre) !== 0) continue;
    // No clock available: honour only the never-expiring entries. Letting a
    // timed entry live forever would be the worse failure of the two.
    if (entry.until) {
      if (!now || now >= entry.until) continue;
    }
    return entry.tok;
  }
  return null;
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

// Degraded matcher used only when the URL was stripped: origin prefix or origin glob.
function PP_sanHit(i, url) {
  var san = PP.pools[i].san;
  if (!san) return false;
  if (san.rx) return PP_SRX[i] ? PP_SRX[i].test(url) : false;
  return url.indexOf(san.pat) === 0;
}

function PP_matchPool(url, host, stripped) {
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
    if (!hit && stripped) hit = PP_sanHit(i, url);
    if (hit) return pool.tokens;
  }
  return null;
}

// Round robin: take the current index, then advance once every rotateEvery hits.
// The counter is shared by every pool, so it must NOT be wrapped by the pool that
// happened to be used last. Wrapping by tokens.length lets a one-node pool (a rule
// bound to a single node) reset the shared index to 0 on every hit, which pins every
// other rule to the first one or two nodes -- the exact opposite of what this
// extension exists for. Wrap at a large constant instead and take the modulo only
// when picking.
function PP_pick(tokens) {
  if (!tokens || tokens.length === 0) return null;
  var picked = tokens[PP_I % tokens.length];
  PP_N++;
  if (PP_N % PP.rotateEvery === 0) PP_I = (PP_I + 1) % 1000000;
  return picked;
}

// The route for everything this extension was not asked to touch. Injecting a PAC
// replaces the browser's whole proxy configuration -- including "use the system
// proxy" -- so returning a literal DIRECT here silently cuts off anyone who reaches
// the internet through a local proxy client. Empty PP.dflt means the user really does
// want plain direct connections.
function PP_rest() {
  return PP.dflt || 'DIRECT';
}

function FindProxyForURL(url, host) {
  try {
    // Forced routes come first, even when the master switch is off: measuring a
    // node means routing through it. No DIRECT fallback here on purpose -- with one
    // a dead node would silently go direct and the measured latency would be a lie.
    // Fallback windows ride the same table; see PP_forced.
    var forced = PP_forced(url);
    if (forced) return forced;

    // Master switch off: only a probe PAC ever gets here (applyProxy clears the
    // setting outright), and a probe must not drag the rest of the browser along.
    if (!PP.enabled) return PP_rest();

    // Loopback and private ranges stay DIRECT no matter what. Sending 127.0.0.1 or
    // 192.168.* through a proxy is never what anyone wants, and this list is also
    // how the user's own proxy hosts stay reachable.
    if (PP_bypass(host)) return 'DIRECT';

    var tokens = PP_matchPool(url, host, PP_stripped(url));
    if (!tokens) return PP_rest();

    var picked = PP_pick(tokens);
    // A matched rule with an empty pool. Unreachable in practice (applyProxy clears
    // the setting when no node is selectable) but if it ever happens, the browser's
    // usual route beats leaking a direct connection.
    if (!picked) return PP_rest();

    // The trailing DIRECT is what the "all attempts failed" setting says on the tin:
    // show the image over a direct connection. Not PP_rest() -- the user picked
    // "direct" knowing it exposes the real IP, and quietly routing it somewhere else
    // would make that choice mean something different from what it says.
    return PP.fallback === 'direct' ? (picked + '; DIRECT') : picked;
  } catch (e) {
    // Never let a PAC error kill the network. Prefer the user's default route over a
    // hard DIRECT, but reading it must not be able to throw a second time.
    try { return PP.dflt || 'DIRECT'; } catch (e2) { return 'DIRECT'; }
  }
}
`;
}

