/**
 * 稳定哈希与 id 生成。
 *
 * 刻意不用 Math.random()：同一个节点/规则重复导入时必须得到同一个 id，
 * 否则去重、规则绑定、健康状态都会在每次导入后失效。
 */

/** FNV-1a 32 位哈希 */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 8 位十六进制哈希 */
export function hashHex8(str) {
  return fnv1a32(str).toString(16).padStart(8, '0');
}

/**
 * 生成稳定 id。
 * @param {string} prefix 'n_' 或 'r_'
 * @param {string} seed 决定 id 的种子字符串
 */
export function stableId(prefix, seed) {
  return prefix + hashHex8(seed);
}

/** 判断 id 是否符合 `<prefix><8位hex>` 格式 */
export function isValidId(prefix, id) {
  return typeof id === 'string' && new RegExp(`^${prefix}[0-9a-f]{8}$`).test(id);
}
