/**
 * URL 规则匹配。
 *
 * 同一份匹配语义有两处实现：这里（供 UI 预览与日志归因）和 pac-generator 生成的
 * PAC 脚本（供浏览器网络栈）。两处必须保持一致 —— pac-generator 直接复用本文件的
 * `wildcardToRegexSource` 与 `validateRule`，以尽量减少偏差。
 */

import { RULE_TYPES } from './constants.js';
import { isAscii, toAsciiHost } from './ascii.js';
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
 * 规则的「能存但多半不会如你所愿」提示。
 *
 * 与 validateRule 的分工：validateRule 判**合法性**（非法规则根本不进 PAC），
 * 这里判**有效性** —— 规则完全合法、也进了 PAC，但很可能永远命中不了。
 *
 * 目前只有一种：非 ASCII 的 URL 形态规则。浏览器交给 FindProxyForURL 的 URL 里，
 * 域名部分已经是 Punycode 形式；host 型规则我们能安全转码（compileRule 与 PAC 都做了），
 * 但 exact/prefix/wildcard/regex 是整条 URL 的模式，无法判断哪一段是域名，改写会出错。
 * 所以这类规则原样保留，并明确告诉用户它可能不生效 —— 静默失效比报错更难排查。
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
  return warnings;
}

/**
 * 编译规则为可反复调用的匹配器。
 * 非法规则会得到一个「永不命中」的匹配器 —— 绝不抛异常，
 * 否则一条手误的正则就能让整个匹配流程崩掉。
 */
export function compileRule(rule) {
  const base = {
    id: rule?.id ?? '',
    type: String(rule?.type ?? '').toLowerCase().trim(),
    pattern: String(rule?.pattern ?? ''),
    nodeIds: Array.isArray(rule?.nodeIds) ? rule.nodeIds : [],
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

/**
 * 找出第一条命中的启用规则（数组顺序即优先级）。
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
