/**
 * 节点链接与订阅内容解析。
 *
 * 本程序只支持 HTTP/HTTPS 正向代理，所以解析器只为这两种协议产出节点。
 * 其他协议（SOCKS、VLESS、Hysteria2、Trojan、SS…）仍然**被识别**，但只用于
 * 生成一条明确的中文「不支持」提示 —— 识别而不接纳，比静默丢弃更不容易让用户困惑。
 *
 * 输出的 ParsedNode 只包含「链接里写了什么」，不含 id / 健康状态 / 启用标记 ——
 * 那些由 node-model.js 的 createNode 负责补全。
 *
 * @typedef {Object} ParsedNode
 * @property {'http'|'https'} protocol
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string} password
 * @property {string} name
 * @property {string} raw
 * @property {Object} meta
 */

import {
  DEFAULT_PORTS, SUPPORTED_PROTOCOLS, UNSUPPORTED_PROTOCOL_MESSAGE, PROTOCOL_LABELS,
} from './constants.js';
import { normalizeProtocol } from './schema.js';

/** `scheme://` 前缀 */
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/** 行首注释标记 */
function isComment(text) {
  return text.startsWith('#') || text.startsWith('//') || text.startsWith(';');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** base64（含 URL-safe、缺失 padding）→ UTF-8 字符串；失败返回 null */
export function tryBase64(input) {
  const compact = String(input).replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/\-_]+={0,2}$/.test(compact)) return null;
  let b64 = compact.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** `-`/`_` 分隔转 camelCase */
function camelKey(key) {
  return String(key).toLowerCase().replace(/[-_]+([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** 把 URLSearchParams 转成 meta 对象 */
function queryToMeta(params) {
  const meta = {};
  const entries = params instanceof URLSearchParams ? params : new URLSearchParams(params || '');
  for (const [rawKey, rawValue] of entries) {
    const key = camelKey(rawKey);
    if (key) meta[key] = rawValue;
  }
  return meta;
}

/** 拆分 `host:port` / `[v6]:port`，缺端口时用 defaultPort */
function splitHostPort(addr, defaultPort) {
  const text = String(addr).trim();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return { host: '', port: NaN };
    const host = text.slice(1, end);
    const rest = text.slice(end + 1);
    const port = rest.startsWith(':') ? Number.parseInt(rest.slice(1), 10) : defaultPort;
    return { host, port };
  }
  const idx = text.lastIndexOf(':');
  if (idx < 0) return { host: text, port: defaultPort };
  return { host: text.slice(0, idx), port: Number.parseInt(text.slice(idx + 1), 10) };
}

function build({ protocol, host, port, username = '', password = '', name = '', raw = '', meta = {} }) {
  if (!host || !isValidPort(port)) return null;
  return { protocol, host, port, username, password, name, raw, meta };
}

/** 解析没有 scheme 的 `host:port` 与 `host:port:user:pass`，按 http 处理 */
function parseBareHostPort(text) {
  const hashIdx = text.indexOf('#');
  const name = hashIdx >= 0 ? safeDecode(text.slice(hashIdx + 1)) : '';
  const body = (hashIdx >= 0 ? text.slice(0, hashIdx) : text).trim();
  if (!body || /\s/.test(body)) return null;

  // IPv6 字面量必须带方括号才能和端口区分开
  if (body.startsWith('[')) {
    const { host, port } = splitHostPort(body, NaN);
    return build({ protocol: 'http', host, port, name, raw: text });
  }

  const parts = body.split(':');
  if (parts.length === 2) {
    return build({ protocol: 'http', host: parts[0], port: Number.parseInt(parts[1], 10), name, raw: text });
  }
  if (parts.length === 4) {
    return build({
      protocol: 'http',
      host: parts[0],
      port: Number.parseInt(parts[1], 10),
      username: parts[2],
      password: parts[3],
      name,
      raw: text,
    });
  }
  return null;
}

/**
 * 判定一行文本属于哪一类。
 * @param {string} line
 * @returns {{kind:'comment'}
 *          |{kind:'node', node: ParsedNode}
 *          |{kind:'unsupported', protocol: string, label: string, reason: string, line: string}
 *          |{kind:'invalid', reason: string, line: string}}
 */
export function classifyNodeLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return { kind: 'invalid', reason: '空行', line: text };
  if (isComment(text)) return { kind: 'comment' };

  const schemeMatch = SCHEME_RE.exec(text);

  if (!schemeMatch) {
    const node = parseBareHostPort(text);
    return node
      ? { kind: 'node', node }
      : { kind: 'invalid', reason: '无法识别的节点格式', line: text };
  }

  const protocol = normalizeProtocol(schemeMatch[1]);

  if (protocol === 'unknown') {
    return { kind: 'invalid', reason: `无法识别的协议「${schemeMatch[1]}」`, line: text };
  }

  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    const label = PROTOCOL_LABELS[protocol] || protocol.toUpperCase();
    return {
      kind: 'unsupported',
      protocol,
      label,
      reason: `${label} 节点：${UNSUPPORTED_PROTOCOL_MESSAGE}`,
      line: text,
    };
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'invalid', reason: '链接格式不合法（可能是端口越界）', line: text };
  }

  const node = build({
    protocol,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number.parseInt(url.port, 10) : DEFAULT_PORTS[protocol],
    username: safeDecode(url.username),
    password: safeDecode(url.password),
    name: url.hash ? safeDecode(url.hash.slice(1)) : '',
    raw: text,
    meta: queryToMeta(url.searchParams),
  });

  return node
    ? { kind: 'node', node }
    : { kind: 'invalid', reason: '地址或端口不合法', line: text };
}

/**
 * 解析单行节点链接。
 * @param {string} line
 * @returns {ParsedNode|null} 非 HTTP/HTTPS 或无法识别时返回 null
 */
export function parseNodeLine(line) {
  const result = classifyNodeLine(line);
  return result.kind === 'node' ? result.node : null;
}

/**
 * 把一段文本切成多个待解析条目。
 * 只在逗号/分号后面紧跟一个新条目起始时才切分，避免误伤 URL 参数里的逗号。
 */
function splitEntries(text) {
  const nextEntry = /[,;]\s*(?=(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)|(?:[A-Za-z0-9._-]+:\d{1,5}(?:[:,;\s]|$)))/;
  const out = [];
  for (const line of String(text ?? '').split(/[\r\n]+/)) {
    for (const part of line.split(nextEntry)) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/**
 * 批量解析节点文本。
 * @param {string} text 多行 / 逗号 / 分号分隔的节点链接
 * @returns {{nodes: ParsedNode[],
 *            unsupported: {line: string, protocol: string, label: string, reason: string}[],
 *            errors: {line: string, reason: string}[]}}
 */
export function parseNodeList(text) {
  const nodes = [];
  const unsupported = [];
  const errors = [];

  for (const entry of splitEntries(text)) {
    const result = classifyNodeLine(entry);
    switch (result.kind) {
      case 'comment':
        break;
      case 'node':
        nodes.push(result.node);
        break;
      case 'unsupported':
        unsupported.push({ line: result.line, protocol: result.protocol, label: result.label, reason: result.reason });
        break;
      default:
        errors.push({ line: result.line, reason: result.reason });
    }
  }

  return { nodes, unsupported, errors };
}

/**
 * 解码订阅内容。
 * 订阅站通常返回整段 base64；已经是明文时原样返回。
 */
export function decodeSubscription(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (raw.includes('://')) return raw;
  const decoded = tryBase64(raw);
  if (decoded && (decoded.includes('://') || /[A-Za-z0-9.-]+:\d{1,5}/.test(decoded))) return decoded;
  return raw;
}
