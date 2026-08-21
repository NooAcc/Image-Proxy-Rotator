/**
 * 节点模型：规范化、可用性判定、PAC token 映射。
 *
 * 这里回答两个问题：
 *   1. 这个节点在 PAC 里该写成什么？（pacToken）
 *   2. 它现在该不该参与轮询？（isSelectable）
 *
 * **可用性的唯一闸门是 pacToken()**：只有 SUPPORTED_PROTOCOLS（http / https）能得到
 * token，其余协议一律返回 null。isSelectable、PAC 节点池、摘要统计都建立在它之上，
 * 所以不存在「某个不支持的协议从别的路径漏进轮询」的可能。
 */

import { SUPPORTED_PROTOCOLS, PAC_KEYWORDS, PROTOCOL_LABELS, UNSUPPORTED_PROTOCOL_MESSAGE } from './constants.js';
import { stableId } from './hash.js';
import { normalizeNode } from './schema.js';

/** 生成稳定的节点 id */
export function makeNodeId(seed) {
  return stableId('n_', seed);
}

/** 节点的默认显示名 */
export function defaultNodeName(node) {
  return `${node.protocol}-${node.host}:${node.port}`;
}

/** 协议展示名 */
export function protocolLabel(protocol) {
  return PROTOCOL_LABELS[protocol] || String(protocol || '').toUpperCase() || '未知协议';
}

/** 该节点的协议是否在本程序的支持范围内（http / https） */
export function isSupported(node) {
  return SUPPORTED_PROTOCOLS.includes(node?.protocol);
}

/** 去重键：同协议 + 同地址 + 同端口 */
function nodeKey(node) {
  return `${node.protocol}|${node.host}|${node.port}`;
}

/**
 * 由 ParsedNode 创建完整 Node。
 * @param {object} parsed node-parser 的输出（或任何形状相近的对象）
 * @param {object[]} existingNodes 已有节点，用于重名时追加序号
 * @returns {object|null}
 */
export function createNode(parsed, existingNodes = []) {
  const base = normalizeNode({
    ...parsed,
    id: undefined,
    name: '',
    health: undefined,
    enabled: true,
    autoDisabled: false,
  });
  if (!base) return null;

  base.id = makeNodeId(nodeKey(base));

  const wanted = String(parsed?.name ?? '').trim() || defaultNodeName(base);
  const taken = new Set(existingNodes.map((n) => n.name));
  let name = wanted;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${wanted} (${suffix})`;
    suffix++;
  }
  base.name = name;

  return base;
}

/**
 * 节点在 PAC 里的表达式。
 * @returns {string|null} 协议不受支持时返回 null —— 这是可用性的唯一判定点
 */
export function pacToken(node) {
  if (!node) return null;

  const keyword = PAC_KEYWORDS[node.protocol];
  if (!keyword) return null;

  // IPv6 字面量在 PAC 里必须带方括号，否则端口无法区分
  const host = node.host.includes(':') ? `[${node.host}]` : node.host;
  return `${keyword} ${host}:${node.port}`;
}

/** 当前是否应该参与轮询 */
export function isSelectable(node) {
  if (!node) return false;
  if (node.enabled === false) return false;
  if (node.autoDisabled === true) return false;
  return pacToken(node) !== null;
}

/**
 * UI 上要展示的警示语。
 * 这些都是「节点看起来配好了，但实际上用不了或有坑」的情况 —— 必须让用户看见，
 * 而不是让他们对着裂图猜原因。
 */
export function nodeWarnings(node) {
  const warnings = [];
  if (!node) return warnings;

  if (!isSupported(node)) {
    warnings.push(`${protocolLabel(node.protocol)}：${UNSUPPORTED_PROTOCOL_MESSAGE}。该节点不会参与分流，请删除或改用 HTTP/HTTPS 代理。`);
    // 协议本身就不受支持时，其余提示都没有意义
    return warnings;
  }

  if (node.username && node.protocol === 'https') {
    warnings.push('HTTPS 代理的认证依赖代理服务器支持 Basic/Digest；若反复弹出认证框，请确认账号密码正确。');
  }

  return warnings;
}

/** 按 protocol+host+port 去重，保留先出现的 */
export function dedupeNodes(nodes) {
  const seen = new Set();
  const out = [];
  for (const node of nodes) {
    if (!node) continue;
    const key = nodeKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

/** 挑出所有协议不受支持的节点（UI 用来提示与一键清理） */
export function unsupportedNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter((n) => n && !isSupported(n));
}
