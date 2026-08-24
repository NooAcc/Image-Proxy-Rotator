/**
 * 兜底代理：解析、校验、PAC token。
 *
 * 这是重试链的最后一环，1.5.0 起取代了 1.4.x 的「兜底图片代理」（URL 改写）。
 *
 * **为什么换掉 URL 改写。** 旧形态要求兜底服务按 `?url=` 取图（wsrv.nl / imgproxy
 * 这类），于是把用户手里最常见的东西排除在外了 —— 一个自建的 HTTP 正向代理。两者说的
 * 不是一种协议：改写型服务收到的是源站形式的 `GET /?url=… HTTP/1.1`，而正向代理等的是
 * 绝对形式的 `GET http://target/path` 或 `CONNECT host:443`。把正向代理填进模板框，
 * 实测每一种 URL 写法都是 `HTTP 400`，而旧的 `validateTemplate()` 三项检查全过 ——
 * 于是开关显示开着、真用到时静默失败。
 *
 * **兜底代理不是节点。** 它不进 `config.nodes`、不测速、不自动禁用、不参与轮询、
 * 不进 `perNode` 统计。它唯一的身份是「用尽之后那一次重试该走谁」。
 * 但它在 PAC 里的写法必须与节点逐字一致，所以 token 格式化共用 `proxy-token.js`，
 * 地址解析共用 `proxy-address.js`。
 *
 * **它也不是「规则之外的流量走谁」。** 那是 `default-proxy.js` 管的另一件事。两者可以
 * 填成同一个地址，但触发条件毫不相干：兜底只在一张图用尽 maxAttempts 之后对该图源短暂
 * 开窗，默认代理则对所有没命中规则的请求长期生效。
 *
 * 本文件是纯逻辑，不碰 `chrome.*`（决策 D6）。刻意**不引** `schema.js` ——
 * `node-parser.js` 已经引了它，再引会绕成循环。
 */

import { emptyProxyAddress, parseProxyAddress } from './proxy-address.js';
import { proxyToken } from './proxy-token.js';

/** @returns 全新的空兜底代理 */
export function emptyFallbackProxy() {
  return emptyProxyAddress();
}

/**
 * 把用户填的一行地址解析成兜底代理。
 *
 * 接受的写法与节点、默认代理完全一致，好让用户不必记几套语法：
 *   · `http://10.0.0.3:37581`
 *   · `https://user:pass@proxy.lan:8443`
 *   · `10.0.0.3:37581`（没写 scheme 时按 http 处理）
 *
 * @param {unknown} text
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function parseFallbackProxy(text) {
  return parseProxyAddress(text, {
    noun: '兜底代理',
    // 填了路径几乎一定是把它当成了改写型图片服务 —— 那是 1.4.x 的形态
    pathHint: '带 `?url=` 的是改写型图片服务（如 wsrv.nl），本版本已改用 HTTP 代理',
  });
}

/**
 * 兜底代理在 PAC 里的表达式。
 * @returns {string|null} 未启用或不可用时返回 null
 */
export function fallbackProxyToken(fp) {
  if (!fp || fp.enabled !== true) return null;
  return proxyToken(fp);
}

/**
 * 设置页要展示的警示语。
 *
 * 与「非法」的分工和 rule-matcher 一样：`parseFallbackProxy` 判合法性（不合法根本存不
 * 进去），这里判「存得下但多半不如你所愿」。
 */
export function fallbackProxyWarnings(fp) {
  const warnings = [];
  if (!fp || !fp.host) return warnings;

  if (fp.username && fp.protocol === 'https') {
    warnings.push('HTTPS 代理的认证依赖代理服务器支持 Basic/Digest；若反复弹出认证框，请确认账号密码正确。');
  }
  return warnings;
}
