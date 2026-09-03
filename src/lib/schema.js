/**
 * 持久化数据结构的规范化层。
 *
 * 设计原则：**任何输入都必须能得到一份合法的 Config**。
 * 用户手改过的导入文件、旧版本残留、被截断的存储都不能让扩展崩溃 —— 无法修补的
 * 单条记录直接丢弃，而不是让整份配置失效。
 */

import {
  CONFIG_VERSION, KNOWN_PROTOCOLS, PROTOCOL_ALIASES, RULE_TYPES,
  STRATEGIES, FALLBACKS, DEFAULT_PROBE_URL, DEFAULT_BYPASS_LIST,
  RETRY_ATTEMPTS_CAP, RETRY_DELAY_CAP_MS, RETRY_SLOW_TIMEOUT_CAP_MS,
  defaultConfig, defaultSettings, defaultProbeSettings,
  defaultRetrySettings, defaultFallbackProxy, defaultDefaultProxy, defaultDeepRetry,
  defaultEasyProxiesSettings,
  EASY_PROXIES_DEFAULT_BASE_URL, EASY_PROXIES_MAX_NODES_CAP,
} from './constants.js';
import { parseFallbackProxy } from './fallback-proxy.js';
import { parseDefaultProxy } from './default-proxy.js';
import { deepRetryPatterns, DEEP_RETRY_SITE_CAP } from './deep-retry.js';
import { stableId, isValidId } from './hash.js';

/** 把值夹到 [min, max] 区间内的整数；非法时返回 fallback */
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asString(value) {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 去掉 IPv6 字面量外层的方括号 */
export function stripBrackets(host) {
  return asString(host).replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * 规范化协议名（含别名归一化）。
 *
 * 刻意保留「能识别但不可用」的协议名（如 socks5、vless）而不是统一压成 unknown ——
 * 这样 UI 才能明确告诉用户「你加的是 SOCKS5，本程序不支持」，而不是含糊的「未知协议」。
 * 可用性判定不在这里，而在 node-model.pacToken() / isSupported()。
 */
export function normalizeProtocol(raw) {
  const p = asString(raw).toLowerCase().trim();
  const aliased = PROTOCOL_ALIASES[p] || p;
  return KNOWN_PROTOCOLS.includes(aliased) ? aliased : 'unknown';
}

/** @returns 全新的默认健康状态 */
export function defaultHealth() {
  return {
    status: 'unknown',
    latencyMs: null,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    lastError: null,
    egressIp: null,
  };
}

export function normalizeHealth(raw) {
  const base = defaultHealth();
  if (!isPlainObject(raw)) return base;
  const status = ['unknown', 'ok', 'slow', 'fail'].includes(raw.status) ? raw.status : 'unknown';
  return {
    status,
    latencyMs: Number.isFinite(raw.latencyMs) ? Math.round(raw.latencyMs) : null,
    lastCheckedAt: Number.isFinite(raw.lastCheckedAt) ? raw.lastCheckedAt : null,
    consecutiveFailures: clampInt(raw.consecutiveFailures, 0, 9999, 0),
    lastError: raw.lastError == null ? null : asString(raw.lastError),
    egressIp: raw.egressIp == null ? null : asString(raw.egressIp),
  };
}

/**
 * 规范化单个节点。
 * @returns {object|null} 无法修补时返回 null（调用方应丢弃）
 */
export function normalizeNode(raw) {
  if (!isPlainObject(raw)) return null;

  const protocol = normalizeProtocol(raw.protocol);
  const host = stripBrackets(raw.host).trim();
  if (!host) return null;

  const port = Number.parseInt(raw.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const id = isValidId('n_', raw.id) ? raw.id : stableId('n_', `${protocol}|${host}|${port}`);
  const name = asString(raw.name).trim() || `${protocol}-${host}:${port}`;

  return {
    id,
    name,
    protocol,
    host,
    port,
    username: asString(raw.username),
    password: asString(raw.password),
    enabled: raw.enabled !== false,
    autoDisabled: raw.autoDisabled === true,
    health: normalizeHealth(raw.health),
    raw: asString(raw.raw),
    meta: isPlainObject(raw.meta) ? { ...raw.meta } : {},
  };
}

/**
 * 规范化单条规则。
 * @returns {object|null} 类型非法 / pattern 为空 / 正则无法编译时返回 null
 */
export function normalizeRule(raw) {
  if (!isPlainObject(raw)) return null;

  const type = asString(raw.type).toLowerCase().trim();
  if (!RULE_TYPES.includes(type)) return null;

  const pattern = asString(raw.pattern).trim();
  if (!pattern) return null;

  // 非法正则会让 PAC 抛异常并导致整个浏览器断网，必须在入口就挡掉。
  if (type === 'regex') {
    try {
      new RegExp(pattern);
    } catch {
      return null;
    }
  }

  const id = isValidId('r_', raw.id) ? raw.id : stableId('r_', `${type}|${pattern}`);
  return {
    id,
    name: asString(raw.name).trim() || pattern,
    type,
    pattern,
    enabled: raw.enabled !== false,
    nodeIds: Array.isArray(raw.nodeIds) ? raw.nodeIds.filter((x) => typeof x === 'string' && x) : [],
  };
}

export function normalizeProbeSettings(raw) {
  const base = defaultProbeSettings();
  if (!isPlainObject(raw)) return base;

  let url = asString(raw.url).trim() || base.url;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) url = DEFAULT_PROBE_URL;
  } catch {
    url = DEFAULT_PROBE_URL;
  }

  return {
    url,
    timeoutMs: clampInt(raw.timeoutMs, 500, 60000, base.timeoutMs),
    intervalMinutes: clampInt(raw.intervalMinutes, 0, 1440, base.intervalMinutes),
    autoDisable: raw.autoDisable !== false,
    failureThreshold: clampInt(raw.failureThreshold, 1, 10, base.failureThreshold),
    recoverProbe: raw.recoverProbe !== false,
  };
}

export function normalizeRetrySettings(raw) {
  const base = defaultRetrySettings();
  if (!isPlainObject(raw)) return base;
  return {
    maxAttempts: clampInt(raw.maxAttempts, 1, RETRY_ATTEMPTS_CAP, base.maxAttempts),
    delayMs: clampInt(raw.delayMs, 0, RETRY_DELAY_CAP_MS, base.delayMs),
    slowTimeoutMs: clampInt(raw.slowTimeoutMs, 0, RETRY_SLOW_TIMEOUT_CAP_MS, base.slowTimeoutMs),
  };
}

/**
 * 规范化兜底代理设置。
 *
 * **地址不可用时强制 enabled=false，但保留用户填的原文。** 两件事各有理由：
 * 强制关闭是为了不让「开关显示开着、实际什么都不会发生」这种状态被持久化 ——
 * 那正是 1.4.x 的兜底图片代理踩过的坑（把一个 HTTP 正向代理填进 `?url=` 模板框，
 * 校验三项全过、真用到时每次 400）；保留原文是为了让设置页能在字段旁边说明
 * 它为什么没被启用，而不是把用户填的东西默默抹掉。
 */
export function normalizeFallbackProxy(raw) {
  const base = defaultFallbackProxy();
  if (!isPlainObject(raw)) return base;

  // 原文是权威来源：解析一遍就能同时得到 host/port/凭据与「能不能用」的结论，
  // 不必信任存储里那几个可能被手改坏的分解字段
  const text = asString(raw.raw).trim()
    || (raw.host ? `${asString(raw.protocol) || 'http'}://${asString(raw.host)}:${raw.port}` : '');
  if (!text) return base;

  const parsed = parseFallbackProxy(text);
  if (!parsed.ok) return { ...base, raw: text };

  return {
    ...parsed.value,
    // 凭据不写在地址里时（设置页有单独的输入框）仍要保住
    username: parsed.value.username || asString(raw.username),
    password: parsed.value.password || asString(raw.password),
    enabled: raw.enabled === true,
  };
}

/**
 * 规范化默认代理设置（规则之外的流量走谁）。
 *
 * 与 `normalizeFallbackProxy` 逐条同构，也共用同一份解析：地址不可用时强制
 * `enabled=false` 但保留原文，好让设置页能说出它为什么没被启用。
 *
 * 这一项被强制关掉的后果比兜底代理严重得多 —— 兜底关掉只是少一层重试，
 * 而这一项关掉意味着**所有非规则流量都变成直连**，靠本机代理客户端上网的人会直接断网
 * （见 lib/default-proxy.js 开头）。所以设置页必须把「为什么关了」说在字段旁边。
 */
export function normalizeDefaultProxy(raw) {
  const base = defaultDefaultProxy();
  if (!isPlainObject(raw)) return base;

  const text = asString(raw.raw).trim()
    || (raw.host ? `${asString(raw.protocol) || 'http'}://${asString(raw.host)}:${raw.port}` : '');
  if (!text) return base;

  const parsed = parseDefaultProxy(text);
  if (!parsed.ok) return { ...base, raw: text };

  return {
    ...parsed.value,
    // 凭据不写在地址里时（设置页有单独的输入框）仍要保住
    username: parsed.value.username || asString(raw.username),
    password: parsed.value.password || asString(raw.password),
    enabled: raw.enabled === true,
  };
}

/**
 * 规范化深度重试设置。
 *
 * 与 `normalizeFallbackProxy` 同一条纪律：**一条可用站点都没有时强制 `enabled=false`，
 * 但保留用户填的文本。** 强制关闭是为了不把「开关显示开着、实际一个页面都不会被注入」
 * 这种状态持久化；保留文本是为了让设置页能逐行说明每一条为什么没被接受
 * （原因由 `deepRetryPatterns()` 给出）。
 */
export function normalizeDeepRetry(raw) {
  const base = defaultDeepRetry();
  if (!isPlainObject(raw)) return base;

  const sites = Array.isArray(raw.sites)
    ? raw.sites.map((x) => asString(x).trim()).filter(Boolean).slice(0, DEEP_RETRY_SITE_CAP)
    : [];

  return {
    enabled: raw.enabled === true && deepRetryPatterns(sites).patterns.length > 0,
    sites,
  };
}

/**
 * 规范化 Easy Proxies 自动拉取设置。
 *
 * 管理地址必须能解析成 http/https URL；没写 scheme 时自动补 http://。
 * 数量夹到 [1, 500]，间隔夹到 [0, 1440]（0 = 不做定时，仅启动时/手动同步）。
 * 最近一次同步的状态字段原样保留，便于设置页展示，不参与开关判定。
 */
export function normalizeEasyProxiesSettings(raw) {
  const base = defaultEasyProxiesSettings();
  if (!isPlainObject(raw)) return base;

  let baseUrl = EASY_PROXIES_DEFAULT_BASE_URL;
  const text = asString(raw.baseUrl).trim();
  if (text) {
    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
    try {
      const parsed = new URL(withScheme);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') baseUrl = withScheme;
    } catch {
      // 非法地址回落默认
    }
  }

  let labelServiceUrl = '';
  const serviceText = asString(raw.labelServiceUrl).trim();
  if (serviceText) {
    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(serviceText)
      ? serviceText
      : `http://${serviceText}`;
    try {
      const parsed = new URL(withScheme);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        labelServiceUrl = withScheme;
      }
    } catch {
      // 非法地址回落为空
    }
  }

  const lastSyncCount = Number.parseInt(raw.lastSyncCount, 10);
  return {
    enabled: raw.enabled === true,
    baseUrl,
    password: asString(raw.password),
    maxNodes: clampInt(raw.maxNodes, 1, EASY_PROXIES_MAX_NODES_CAP, base.maxNodes),
    intervalMinutes: clampInt(raw.intervalMinutes, 0, 1440, base.intervalMinutes),
    labelServiceUrl,
    labelServiceToken: asString(raw.labelServiceToken),
    lastSyncAt: Number.isFinite(raw.lastSyncAt) ? Math.round(raw.lastSyncAt) : null,
    lastSyncCount: Number.isInteger(lastSyncCount) && lastSyncCount >= 0 ? lastSyncCount : null,
    lastSyncError: raw.lastSyncError == null ? null : asString(raw.lastSyncError),
  };
}

export function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!isPlainObject(raw)) return base;

  const bypassList = Array.isArray(raw.bypassList)
    ? raw.bypassList.map((x) => asString(x).trim()).filter(Boolean)
    : [...DEFAULT_BYPASS_LIST];

  return {
    strategy: STRATEGIES.includes(raw.strategy) ? raw.strategy : base.strategy,
    fallback: FALLBACKS.includes(raw.fallback) ? raw.fallback : base.fallback,
    rotateEvery: clampInt(raw.rotateEvery, 1, 1000, base.rotateEvery),
    retry: normalizeRetrySettings(raw.retry),
    fallbackProxy: normalizeFallbackProxy(raw.fallbackProxy),
    defaultProxy: normalizeDefaultProxy(raw.defaultProxy),
    deepRetry: normalizeDeepRetry(raw.deepRetry),
    easyProxies: normalizeEasyProxiesSettings(raw.easyProxies),
    probe: normalizeProbeSettings(raw.probe),
    logLimit: clampInt(raw.logLimit, 10, 2000, base.logLimit),
    bypassList,
  };
}

/**
 * 规范化整份配置。永不抛异常。
 * @param {unknown} raw
 * @returns {object} 合法的 Config
 */
export function normalizeConfig(raw) {
  if (!isPlainObject(raw)) return defaultConfig();

  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map(normalizeNode).filter(Boolean)
    : [];
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map(normalizeRule).filter(Boolean)
    : [];

  return {
    version: CONFIG_VERSION,
    enabled: raw.enabled === true,
    nodes,
    rules,
    settings: normalizeSettings(raw.settings),
  };
}
