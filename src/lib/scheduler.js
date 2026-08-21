/**
 * 分流调度。
 *
 * 生产路径上的轮询实际发生在生成的 PAC 脚本里（见 pac-generator.js，决策 D2）；
 * 本文件是同一套语义的可测实现，用于 UI 预览、日志归因与回归测试。
 */

import { isSelectable } from './node-model.js';
import { fnv1a32 } from './hash.js';

/**
 * 计算某条规则可用的节点池。
 * @param {object[]} nodes 全部节点
 * @param {string[]} nodeIds 规则绑定的节点子集；空数组表示不限定
 * @returns {object[]} 可参与轮询的节点
 */
export function selectablePool(nodes, nodeIds = []) {
  const available = (Array.isArray(nodes) ? nodes : []).filter(isSelectable);
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) return available;

  const wanted = new Set(nodeIds);
  const subset = available.filter((n) => wanted.has(n.id));
  // 绑定的节点全挂了就回落到全部可用节点 —— 宁可换个节点，也别让图片直接裂开
  return subset.length > 0 ? subset : available;
}

/**
 * 创建轮询器。
 * @param {number} startIndex 起始下标
 */
export function createRoundRobin(startIndex = 0) {
  let index = Number.isInteger(startIndex) && startIndex >= 0 ? startIndex : 0;
  return {
    /** @returns {object|null} 下一个节点；池为空时返回 null */
    next(pool) {
      if (!Array.isArray(pool) || pool.length === 0) return null;
      const picked = pool[index % pool.length];
      index = (index + 1) % pool.length;
      return picked;
    },
    get index() {
      return index;
    },
  };
}

/**
 * 按 key 的哈希稳定选节点。
 * 同一个 URL 永远走同一个节点 —— 便于精确归因，也让浏览器缓存更容易命中。
 */
export function hashPick(pool, key) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  return pool[fnv1a32(key) % pool.length];
}

/**
 * 生成一段分流序列，用于设置页的「分流预览」。
 * @param {object[]} pool
 * @param {number} count
 * @param {'round-robin'|'hash'} strategy
 */
export function distribute(pool, count, strategy = 'round-robin') {
  const out = [];
  if (!Array.isArray(pool) || pool.length === 0) return out;

  if (strategy === 'hash') {
    for (let i = 0; i < count; i++) out.push(hashPick(pool, `sample-${i}`));
    return out;
  }

  const rr = createRoundRobin(0);
  for (let i = 0; i < count; i++) out.push(rr.next(pool));
  return out;
}
