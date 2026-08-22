/**
 * URL 规则匹配。
 *
 * 同一份匹配语义有两处实现：这里（供 UI 预览、统计归因与规则测试器）和 pac-generator
 * 生成的 PAC 脚本（供浏览器网络栈）。两处必须保持一致 —— pac-generator 直接复用本文件的
 * `wildcardToRegexSource`、`validateRule` 与 `sanitizedScope`，以尽量减少偏差。
 *
 * **最重要的一致性来源是 URL 本身。** 浏览器交给 PAC 的 https URL 已经被剥掉 path 与
 * query（见 lib/pac-url.js）。所以「这个请求会不会走代理」必须用 `matchPacUrl()` 回答，
 * 而不是 `matchUrl()`：后者看的是完整 URL，即用户的**意图**。两者的差值就是
 * 「规则命中但实际直连」，统计里单列一项，正是本扩展最容易踩的坑。
 */

import { RULE_TYPES } from './constants.js';
import { isAscii, toAsciiHost } from './ascii.js';
import { pacUrl, isSanitizedScheme, urlPatternScope, canMatchSanitized } from './pac-url.js';
import { stableId, isValidId } from './hash.js';


/** 生成稳定的规则 id */
export function makeRuleId(seed) {
  return stableId('r_', seed);
}

/**
 * 构造规则对象。刻意保持宽松 —— 不做合法性裁决，
 * 这样 UI 可以先拿到对象，再用 validateRule 拿到可展示的中文错误。
 */
export function createRule(partial = {}) {
  const type = String(partial.type ?? '').toLowerCase().trim();
  const pattern = String(partial.pattern ?? '').trim();
  return {
    id: isValidId('r_', partial.id) ? partial.id : makeRuleId(`${type}|${pattern}`),
    name: String(partial.name ?? '').trim() || pattern,
    type,
    pattern,
    enabled: partial.enabled !== false,
    nodeIds: Array.isArray(partial.nodeIds) ? partial.nodeIds.filter((x) => typeof x === 'string' && x) : [],
  };
}

/**
 * 把通配符表达式转成正则源码。只有 `*` 是通配符（匹配任意字符），
 * 其余字符（含 `?` `.`）都按字面量处理。
 */
export function wildcardToRegexSource(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return '^' + escaped.replace(/\\\*/g, '.*') + '$';
}

/**
 * 校验规则。
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateRule(rule) {
  if (!rule || typeof rule !== 'object') return { ok: false, reason: '规则格式不正确' };

  const type = String(rule.type ?? '').toLowerCase().trim();
  if (!RULE_TYPES.includes(type)) return { ok: false, reason: `不支持的规则类型：${rule.type}` };

  const pattern = String(rule.pattern ?? '').trim();
  if (!pattern) return { ok: false, reason: '规则内容不能为空' };

  if (type === 'regex') {
    try {
      new RegExp(pattern);
    } catch (e) {
      return { ok: false, reason: `正则表达式无法编译：${e.message}` };
    }
  }
  if (type === 'wildcard') {
    try {
      new RegExp(wildcardToRegexSource(pattern));
    } catch (e) {
      return { ok: false, reason: `通配符表达式无法编译：${e.message}` };
    }
  }
  return { ok: true };
}

/** 从 URL 里取主机名；无法解析时返回空串 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * 这条规则在「被净化过的 https URL」下的退化形式。
 *
 * 浏览器只把 `https://主机[:端口]/` 交给 PAC，路径与查询串一概看不到。于是：
 *
 * | 类型 | 退化形式 | 说明 |
 * |---|---|---|
 * | host | 不需要 | 本来就只看主机名，天然安全 |
 * | exact / prefix | 同源前缀 | `https://cdn.m.com/img/` → `https://cdn.m.com/` |
 * | wildcard | 域名通配 | `https://*.m.com/img/*.jpg` → `https://*.m.com/` |
 * | regex | **无** | 无法从任意正则里安全地反推出域名部分 |
 *
 * 退化意味着范围被放宽（原本只代理 `/img/` 下的请求，HTTPS 下会代理整个域名）。
 * 这是刻意的取舍：**放宽可以接受，悄悄失效不行**。所以设置页会把退化后的实际范围
 * 逐条显示出来，`ruleWarnings()` 也会说明。
 *
 * @param {object} rule
 * @returns {{glob: boolean, pat: string, rx: ?string}|null} null = 无退化形式
 */
export function sanitizedScope(rule) {
  if (!rule || !validateRule(rule).ok) return null;
  const type = String(rule.type).toLowerCase().trim();

  if (type === 'exact' || type === 'prefix') {
    const scope = urlPatternScope(rule.pattern);
    return scope ? { ...scope, rx: null } : null;
  }
  if (type === 'wildcard') {
    const scope = urlPatternScope(rule.pattern, { wildcard: true });
    if (!scope) return null;
    // 通配用 wildcardToRegexSource 而不是 PAC 的 shExpMatch：后者还把 `?` 当单字符
    // 通配，与本项目「只有 * 是通配符」的约定不一致，两侧会给出不同答案
    return scope.glob ? { ...scope, rx: wildcardToRegexSource(scope.pat) } : { ...scope, rx: null };
  }
  return null;
}

/**
 * 规则的「能存但多半不会如你所愿」提示。
 *
 * 与 validateRule 的分工：validateRule 判**合法性**（非法规则根本不进 PAC），
 * 这里判**有效性** —— 规则完全合法、也进了 PAC，但很可能永远命中不了。
 *
 * 两类：
 *
 * 1. **非 ASCII 的 URL 形态规则。** 浏览器交给 FindProxyForURL 的 URL 里域名已是
 *    Punycode 形式；host 型规则我们能安全转码，但 exact/prefix/wildcard/regex 是整条
 *    URL 的模式，无法判断哪一段是域名，改写会出错。
 *
 * 2. **HTTPS 下路径不可见。** 这是本扩展最容易踩的坑，详见 lib/pac-url.js。
 *    能退化的类型要告知「实际范围被放宽了」，退化不了的（正则）要告知「可能永远不生效」。
 *
 * @param {object} rule
 * @returns {string[]} 可直接展示的中文提示
 */
export function ruleWarnings(rule) {
  const warnings = [];
  if (!rule || !validateRule(rule).ok) return warnings;

  const type = String(rule.type).toLowerCase().trim();
  if (type !== 'host' && !isAscii(rule.pattern)) {
    warnings.push('规则内容含非 ASCII 字符。浏览器传给分流脚本的网址里，中文域名已被转换成 '
      + 'Punycode（形如 xn--qex62k.com），因此这条规则可能永远命中不了。'
      + '若你想匹配的是域名，请改用「域名」类型 —— 那种类型会自动转换。');
  }

  if (type === 'host') return warnings;

  const scope = sanitizedScope(rule);
  if (scope) {
    warnings.push(`HTTPS 请求只把 ${scope.pat} 这一层交给分流脚本（浏览器会剥掉路径与查询串），`
      + `所以这条规则对 HTTPS 实际按「${scope.pat}」整段生效，范围比你写的更宽。`
      + '要精确到路径，只有 http 图源能做到；想收窄范围请改用「域名」类型并挑更具体的子域。');
  } else if (type === 'regex') {
    if (!canMatchSanitized(compileRule(rule).test, rule.pattern)) {
      warnings.push('这条正则要求 URL 里有路径或扩展名，而 HTTPS 请求交给分流脚本时只剩 '
        + '`https://域名/`（路径与查询串被浏览器剥掉了），所以它对 HTTPS 图片很可能永远命中不了 —— '
        + '这不会报错，只会表现为「扩展好像没起作用」。请改用「域名」类型，或把正则收敛到只约束域名'
        + '（例如 `^https?://(img|cdn)\\d*\\.`）。可用下方的规则测试器确认。');
    }
  } else {
    warnings.push('无法从这条规则里推断出域名部分（需要形如 `https://主机/…` 的写法），'
      + '而 HTTPS 请求交给分流脚本时只剩 `https://域名/`，因此它对 HTTPS 不会生效。请改用「域名」类型。');
  }

  return warnings;
}

/**
 * 编译结果缓存。
 *
 * compileRule 在 webRequest 的热路径上按「请求 × 规则」调用，一个漫画页几百个请求；
 * 而每次编译要走 validateRule、sanitizedScope 与两三次 `new RegExp`。用规则对象本身
 * 当键：`setConfig()` 会经 normalizeConfig 重建整份配置，规则一改就是新对象，
 * 所以不存在读到过期编译结果的可能。WeakMap 也不会拖住已被丢弃的旧配置。
 */
const compiledCache = new WeakMap();

/**
 * 编译规则为可反复调用的匹配器。
 * 非法规则会得到一个「永不命中」的匹配器 —— 绝不抛异常，
 * 否则一条手误的正则就能让整个匹配流程崩掉。
 *
 * 返回值里有两个判定函数：
 *   · `test(url, host)` —— 按规则字面语义匹配传入的 URL
 *   · `testSanitized(url)` —— 退化形式，仅在 URL 被浏览器净化过时补一次
 */
export function compileRule(rule) {
  if (!rule || typeof rule !== 'object') return buildRule(rule);
  const cached = compiledCache.get(rule);
  if (cached) return cached;
  const built = buildRule(rule);
  compiledCache.set(rule, built);
  return built;
}

function buildRule(rule) {
  const scope = sanitizedScope(rule);
  const scopeRx = scope?.rx ? safeRegExp(scope.rx) : null;
  const base = {
    id: rule?.id ?? '',
    type: String(rule?.type ?? '').toLowerCase().trim(),
    pattern: String(rule?.pattern ?? ''),
    nodeIds: Array.isArray(rule?.nodeIds) ? rule.nodeIds : [],
    scope,
    testSanitized: !scope
      ? () => false
      : (url) => (scopeRx ? scopeRx.test(String(url)) : String(url).startsWith(scope.pat)),
  };

  if (!validateRule(rule).ok) return { ...base, test: () => false };

  const { type, pattern } = base;

  switch (type) {
    case 'exact':
      return { ...base, test: (url) => url === pattern };

    case 'prefix':
      return { ...base, test: (url) => String(url).startsWith(pattern) };

    case 'host': {
      // 与 PAC 保持一致：浏览器给出的 hostname 已是 Punycode 形式，
      // 所以中文域名规则必须先转码，否则这里和 PAC 会给出两种答案
      const target = toAsciiHost(pattern);
      return {
        ...base,
        test: (url, host) => {
          const h = host ?? hostOf(url);
          return h === target || h.endsWith(`.${target}`);
        },
      };
    }

    case 'wildcard': {
      const re = new RegExp(wildcardToRegexSource(pattern));
      return { ...base, test: (url) => re.test(url) };
    }

    case 'regex': {
      const re = new RegExp(pattern);
      return { ...base, test: (url) => re.test(url) };
    }

    default:
      return { ...base, test: () => false };
  }
}

/** 编译一个不会抛的正则；无法编译时返回 null（退化形式失效，但不影响主匹配） */
function safeRegExp(source) {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * 找出第一条命中的启用规则（数组顺序即优先级）。
 *
 * **这是「用户的意图」，不是「浏览器实际会怎么做」。** 它拿到的是完整 URL，
 * 而浏览器只把净化后的 URL 交给 PAC。要判断请求是否真的会走代理，用 `matchPacUrl()`。
 *
 * @returns {object|null} 原始规则对象，或 null
 */
export function matchUrl(url, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const host = hostOf(url);
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (compileRule(rule).test(url, host)) return rule;
  }
  return null;
}

/**
 * 按**浏览器实际递给 PAC 的 URL** 找出第一条命中的规则 —— 与 PAC 脚本等价。
 *
 * 这是「这个请求到底会不会走代理」的唯一权威答案，统计与规则测试器都用它。
 * 与 `matchUrl()` 的差值就是「规则命中但实际直连」。
 *
 * @param {string} url 页面里真实发起的完整 URL
 * @param {object[]} rules
 * @returns {object|null}
 */
export function matchPacUrl(url, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const seen = pacUrl(url);
  const host = hostOf(seen);
  const sanitized = isSanitizedScheme(seen);
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const compiled = compileRule(rule);
    if (compiled.test(seen, host)) return rule;
    if (sanitized && compiled.testSanitized(seen)) return rule;
  }
  return null;
}

