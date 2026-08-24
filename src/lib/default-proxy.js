/**
 * 默认代理：规则**没**命中时走谁。
 *
 * **为什么必须有这个东西。** `chrome.proxy.settings.set({mode:'pac_script'})` 替换的是
 * 浏览器**整份**代理配置，其中包括「使用系统代理设置」这一项。也就是说本扩展一旦生效，
 * 用户原先那条「所有流量经本机代理客户端出去」的通路就整块消失了 —— 而生成的 PAC 对
 * 没命中规则的请求只会回 `DIRECT`，即**真·直连**。
 *
 * 后果对靠本机客户端（Clash / sing-box / v2rayN 等）上网的人是致命的，而且极其难猜：
 * 图片站按规则走节点、一切正常，同时**其余网站全部 `ERR_CONNECTION_TIMED_OUT`**。
 * 扩展这边一个错误都不会报 —— 它确实按用户写的规则做了它该做的事。
 * 这就是本文件存在的唯一理由：让用户能说出「其余流量请照旧走这个代理」。
 *
 * **为什么不能自动继承。** Chrome 对 `mode: 'system'` 只回一个 `'system'`，不给服务器
 * 地址（这是刻意的隐私设计）。扩展没有任何 API 能读到系统代理指向哪里，所以这个地址只能
 * 由用户显式填一次，填不上就只能是 `DIRECT`。
 *
 * **它与兜底代理是两件事。** 见 `fallback-proxy.js` 开头。两者可以填成同一个地址，
 * 但触发条件毫不相干；共用的只有地址语法（`proxy-address.js`）与 token 格式化
 * （`proxy-token.js`）。
 *
 * **绕过列表与私有网段永远直连，不受这里影响。** 把 `127.0.0.1` / `192.168.*` 送进
 * 代理是纯粹的错误 —— 见 pac-generator 里 `PP_bypass` 的位置（它排在默认代理之前）。
 *
 * 本文件是纯逻辑，不碰 `chrome.*`（决策 D6）。
 */

import { emptyProxyAddress, parseProxyAddress } from './proxy-address.js';
import { proxyToken } from './proxy-token.js';

/** @returns 全新的空默认代理（默认关闭 = 规则外流量直连，与 1.5.0 及更早一致） */
export function emptyDefaultProxy() {
  return emptyProxyAddress();
}

/**
 * 把用户填的一行地址解析成默认代理。
 *
 * 写法与节点、兜底代理完全一致。绝大多数人要填的就是本机客户端的混合端口，
 * 例如 `http://127.0.0.1:7897`。
 *
 * @param {unknown} text
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function parseDefaultProxy(text) {
  return parseProxyAddress(text, {
    noun: '默认代理',
    pathHint: '通常填本机代理客户端的端口，例如 `http://127.0.0.1:7897`',
  });
}

/**
 * 默认代理在 PAC 里的表达式。
 * @returns {string|null} 未启用或不可用时返回 null —— 此时规则外流量回落到 `DIRECT`
 */
export function defaultProxyToken(dp) {
  if (!dp || dp.enabled !== true) return null;
  return proxyToken(dp);
}

/**
 * 设置页要展示的警示语。
 *
 * 分工同 `fallbackProxyWarnings`：合法性由 `parseDefaultProxy` 裁决（不合法根本存不
 * 进去），这里只说「存得下但多半不如你所愿」。
 *
 * @param {object} dp 默认代理设置
 * @param {object[]} [nodes] 节点列表，用于检出「默认代理填成了轮询节点」
 * @returns {string[]} 可直接展示的中文提示
 */
export function defaultProxyWarnings(dp, nodes = []) {
  const warnings = [];
  if (!dp || !dp.host) return warnings;

  if (dp.username && dp.protocol === 'https') {
    warnings.push('HTTPS 代理的认证依赖代理服务器支持 Basic/Digest；若反复弹出认证框，请确认账号密码正确。');
  }

  // 填成轮询节点等于把「所有其他网站」的流量也压到那个节点上：既让该节点的出口 IP
  // 承担全部日常流量（图源那边看到的请求量与行为都会变），也让分流失去意义
  const clash = (Array.isArray(nodes) ? nodes : []).find(
    (n) => n && n.host === dp.host && Number(n.port) === Number(dp.port),
  );
  if (clash) {
    warnings.push(`这个地址就是节点「${clash.name}」。默认代理承担的是「除规则之外的全部流量」，`
      + '把它指向一个轮询节点会让该节点的出口 IP 同时背上日常流量，图源那边看到的请求特征也会变。'
      + '建议改填本机代理客户端的端口。');
  }

  return warnings;
}
