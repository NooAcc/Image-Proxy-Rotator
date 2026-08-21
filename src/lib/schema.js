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
  defaultConfig, defaultSettings, defaultProbeSettings,
} from './constants.js';
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
