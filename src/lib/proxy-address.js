/**
 * 「一行地址」→ 代理对象。兜底代理与默认代理共用这一份解析。
 *
 * **为什么抽出来。** 这两个东西在配置里是两个独立字段、职责毫不相干（一个是「用尽之后
 * 那一次重试走谁」，一个是「规则没命中的流量走谁」），但它们接受的写法必须**逐字一致** ——
 * 用户不该为了填两个框去记两套语法。第二份解析实现意味着两个框对同一个地址给出不同结论，
 * 而其中一个的结论会是「静默不生效」。
 *
 * 只有两处措辞按角色不同：空值提示与「填了路径」的提示。其余判定（协议白名单、端口范围、
 * 能否写进 PAC）全部共享，并以 `proxyToken()` 为可用性的唯一判定点。
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

function decodeSafe(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

/** @returns 全新的空代理对象 —— 两个角色的存储形状完全相同 */
export function emptyProxyAddress() {
  return { enabled: false, raw: '', protocol: 'http', host: '', port: 0, username: '', password: '' };
}

/**
 * 把用户填的一行地址解析成代理对象。
 *
 * 接受的写法与节点完全一致：
 *   · `http://10.0.0.3:37581`
 *   · `https://user:pass@proxy.lan:8443`
 *   · `10.0.0.3:37581`（没写 scheme 时按 http 处理）
 *
 * @param {unknown} text
 * @param {{noun: string, pathHint?: string}} role 角色措辞：`noun` 用于空值提示，
 *   `pathHint` 追加在「不要填路径」之后，说明这个框最常见的填错方式
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function parseProxyAddress(text, role) {
  const noun = role?.noun ?? '代理';
  const raw = asText(text);
  if (!raw) return { ok: false, reason: `请填写${noun}地址` };
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

  // 路径对正向代理毫无意义，写了几乎一定是把这个框当成了别的东西，静默忽略只会让用户
  // 以为自己填对了
  if (url.pathname !== '/' || url.search) {
    const hint = role?.pathHint ? `${role.pathHint}` : '';
    return {
      ok: false,
      reason: `${noun}只要「地址:端口」，不要路径或查询串。${hint}`.trim(),
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
