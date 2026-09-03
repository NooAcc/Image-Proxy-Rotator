/**
 * Easy Proxies 自动拉取的纯逻辑层。
 *
 * 三件事，与后台编排完全解耦（本文件不引用 chrome.*）：
 *   1. selectBestNodes —— 从 easy_proxies `/api/nodes` 的响应里挑出「最优」节点
 *   2. toProxyNodes —— 把选中的条目转成扩展能接受的节点形状
 *   3. mergeEasyProxiesNodes —— 只替换由本功能管理的节点，绝不碰手写节点
 *
 * 「最优」的唯一定义：可用（available=true）、未被拉黑、有本地监听端口，
 * 按最近一次探测延迟（last_latency_ms）升序取前 N 条；不足 N 条时按实际数量。
 * 延迟缺失或为负的节点排在最后 —— 有数字的总是比没数字的更可信。
 */

import { createNode } from './node-model.js';

/** 自动管理节点的标记名，存在 node.meta.easyProxies */
const EASY_PROXIES_MARKER = 'easyProxies';

/** 该节点是否由 Easy Proxies 自动拉取管理 */
export function isEasyProxiesNode(node) {
  return Boolean(node?.meta?.[EASY_PROXIES_MARKER]);
}

/**
 * 从 /api/nodes 响应中选出最优节点。
 * @param {{nodes: object[]}} payload easy_proxies 的 /api/nodes 响应
 * @param {number} maxNodes 最多取多少条
 * @returns {{tag:string, name:string, port:number, latencyMs:number|null, region:string, country:string}[]}
 */
export function selectBestNodes(payload, maxNodes) {
  const limit = Math.max(1, Math.floor(Number(maxNodes) || 15));
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];

  return nodes
    .filter((n) => n
      && n.available === true
      && !n.blacklisted
      && Number.isInteger(n.port) && n.port > 0)
    .map((n) => {
      // Number(null) 是 0，但语义上 null 表示「没测过」，必须当作缺失而不是 0ms
      const rawLatency = n.last_latency_ms == null ? NaN : Number(n.last_latency_ms);
      return {
        tag: String(n.tag ?? ''),
        name: String(n.name ?? '').trim(),
        port: n.port,
        latencyMs: Number.isFinite(rawLatency) && rawLatency >= 0 ? Math.round(rawLatency) : null,
        region: String(n.region ?? ''),
        country: String(n.country ?? ''),
      };
    })
    // 只按延迟排序；延迟缺失/非法时 latencyMs 为 null，按无穷大排在最后，
    // 延迟相同保持输入顺序（Array.prototype.sort 稳定）
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
    .slice(0, limit);
}

/**
 * 把选中的条目转成扩展的节点形状（尚未分配 id / 补全 health）。
 * @param {object[]} selected selectBestNodes 的输出
 * @param {string} host easy_proxies 所在主机（取自管理地址的主机名）
 */
export function toProxyNodes(selected, host) {
  const h = String(host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!h) return [];

  return (Array.isArray(selected) ? selected : []).map((entry) => ({
    protocol: 'http',
    host: h,
    port: entry.port,
    username: '',
    password: '',
    name: String(entry.name ?? '').trim() || `${h}:${entry.port}`,
    raw: `http://${h}:${entry.port}`,
    meta: {
      [EASY_PROXIES_MARKER]: true,
      tag: String(entry.tag ?? ''),
      latencyMs: entry.latencyMs ?? null,
    },
  }));
}

/**
 * 把本地标签服务 `/api/convert` 返回的节点转成扩展节点形状。
 *
 * 每个返回项已经带唯一的本地回环 host/port，额外保留 upstreamHost/upstreamPort
 * 作为元数据，供排查/展示「这个标签背后是哪个 easy_proxies 端口」。
 *
 * @param {{name:string, host:string, port:number, upstreamHost:string, upstreamPort:number}[]} converted
 */
export function toLabelProxyNodes(converted) {
  const entries = Array.isArray(converted) ? converted : [];
  return entries.map((item) => {
    const host = String(item?.host ?? '').trim().replace(/^\[|\]$/g, '');
    const port = Number.parseInt(item?.port, 10);
    const name = String(item?.name ?? '').trim() || `${host}:${port}`;
    return {
      protocol: 'http',
      host,
      port,
      username: '',
      password: '',
      name,
      raw: `http://${host}:${port}#${name}`,
      meta: {
        [EASY_PROXIES_MARKER]: true,
        labelProxy: {
          upstreamHost: String(item?.upstreamHost ?? '').trim(),
          upstreamPort: Number.parseInt(item?.upstreamPort, 10),
        },
      },
    };
  });
}

/** 节点去重键：同协议 + 同地址 + 同端口 */
function nodeKey(node) {
  return `${node.protocol}|${node.host}|${node.port}`;
}

/**
 * 把新拉取的自动节点并入节点列表。
 *
 * 纪律：**只替换旧自动节点，手写节点一律保留**，并且自动节点不会与手写节点
 * 撞地址重复加入 —— 同地址时手写节点优先。
 *
 * @param {object[]} currentNodes 当前配置里的 nodes
 * @param {object[]} incomingParsed toProxyNodes 的输出
 * @returns {{nodes: object[], added: number, removed: number}}
 */
export function mergeEasyProxiesNodes(currentNodes, incomingParsed) {
  const current = Array.isArray(currentNodes) ? currentNodes : [];
  const incoming = Array.isArray(incomingParsed) ? incomingParsed : [];

  const kept = current.filter((n) => !isEasyProxiesNode(n));
  const removed = current.length - kept.length;

  const seen = new Set(kept.map(nodeKey));
  const built = [];
  for (const item of incoming) {
    const key = nodeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const node = createNode(item, [...kept, ...built]);
    if (node) built.push(node);
  }

  return { nodes: [...kept, ...built], added: built.length, removed };
}
