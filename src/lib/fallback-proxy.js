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
 * 但它在 PAC 里的写法必须与节点逐字一致，所以 token 格式化共用 `proxy-token.js`。
 *
 * 本文件是纯逻辑，不碰 `chrome.*`（决策 D6）。刻意**不引** `schema.js` ——
 * `node-parser.js` 已经引了它，再引会绕成循环。
 */

import { SUPPORTED_PROTOCOLS, PROTOCOL_LABELS, UNSUPPORTED_PROTOCOL_MESSAGE, DEFAULT_PORTS } from './constants.js';
import { proxyToken } from './proxy-token.js';

/** `scheme://` 前缀 */
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 去掉 IPv6 字面量外层的方括号 */
function stripBrackets(host) {
  return String(host ?? '').replace(/^\[/, '').replace(/\]$/, '');
}

/** @returns 全新的空兜底代理 */
export function emptyFallbackProxy() {
  return { enabled: false, raw: '', protocol: 'http', host: '', port: 0, username: '', password: '' };
}

/**
 * 把用户填的一行地址解析成兜底代理。
 *
 * 接受的写法与节点完全一致，好让用户不必记两套语法：
 *   · `http://10.0.0.3:37581`
 *   · `https://user:pass@proxy.lan:8443`
 *   · `10.0.0.3:37581`（没写 scheme 时按 http 处理）
 *
 * @param {unknown} text
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function parseFallbackProxy(text) {
  const raw = asText(text);
  if (!raw) return { ok: false, reason: '请填写兜底代理地址' };
  if (/\s/.test(raw)) return { ok: false, reason: '地址里不能有空格' };

  const withScheme = SCHEME_RE.test(raw) ? raw : `http://${raw}`;
  const scheme = SCHEME_RE.exec(withScheme)[1].toLowerCase();

  if (!SUPPORTED_PROTOCOLS.includes(scheme)) {
    const label = PROTOCOL_LABELS[scheme] || scheme.toUpperCase();
    return { ok: false, reason: `${label}：${UNSUPPORTED_PROTOCOL_MESSAGE}` };
  }

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: '这不是一个合法的代理地址（可能是端口越界）' };
  }

  const host = stripBrackets(url.hostname);
  if (!host) return { ok: false, reason: '缺少主机名' };

  const port = url.port ? Number.parseInt(url.port, 10) : DEFAULT_PORTS[scheme];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: '端口不合法（必须是 1-65535）' };
  }

  // 路径对正向代理毫无意义，写了几乎一定是把它当成改写型图片服务了 —— 那是 1.4.x 的
  // 形态，静默忽略只会让用户以为自己填对了
  if (url.pathname !== '/' || url.search) {
    return {
      ok: false,
      reason: '兜底代理只要「地址:端口」，不要路径或查询串。'
        + '带 `?url=` 的是改写型图片服务（如 wsrv.nl），本版本已改用 HTTP 代理',
    };
  }

  const value = {
    enabled: false,
    raw,
    protocol: scheme,
    host,
    port,
    username: decodeSafe(url.username),
    password: decodeSafe(url.password),
  };

  // 走一遍 token：格式化是可用性的唯一判定点，这里过不了就等于配了个用不上的东西
  if (!proxyToken(value)) return { ok: false, reason: '无法把这个地址写进分流脚本' };

  return { ok: true, value };
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
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
