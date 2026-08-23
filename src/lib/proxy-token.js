/**
 * 代理地址 → PAC token。
 *
 * **为什么单独一个文件。** 兜底代理不是节点：它不在 `config.nodes` 里、不测速、
 * 不自动禁用，所以走不了 `node-model.pacToken(node)`。但它在 PAC 里的写法必须与节点
 * **逐字一致** —— 协议关键字、Punycode 转码、IPv6 方括号，错一处就是一条浏览器会
 * 静默忽略的代理声明。
 *
 * 抽出来的唯一理由就是不要出现第二份格式化实现。`node-model.js` 与
 * `fallback-proxy.js` 都引这里，而本文件只依赖 constants 与 ascii，
 * 因此不会与 `schema.js → node-parser.js` 那条链形成循环导入。
 */

import { PAC_KEYWORDS } from './constants.js';
import { toAsciiHost } from './ascii.js';

/**
 * 代理在 PAC 里的表达式。
 *
 * @param {{protocol?: string, host?: string, port?: number}} target
 * @returns {string|null} 协议不受支持、或地址/端口不合法时返回 null ——
 *   这是「这个代理到底能不能用」的唯一判定点
 */
export function proxyToken(target) {
  if (!target) return null;

  const keyword = PAC_KEYWORDS[target.protocol];
  if (!keyword) return null;

  const port = Number(target.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const raw = String(target.host ?? '').trim();
  if (!raw) return null;

  // 中文域名必须转成 Punycode：PAC 产物只能是纯 ASCII，否则整份脚本注入失败
  const ascii = toAsciiHost(raw);
  // IPv6 字面量在 PAC 里必须带方括号，否则端口无法区分
  const host = ascii.includes(':') && !ascii.startsWith('[') ? `[${ascii}]` : ascii;
  return `${keyword} ${host}:${port}`;
}
