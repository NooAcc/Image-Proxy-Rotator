/**
 * 重试判定 —— 「这张裂了的图该不该换个代理再发一次」的全部逻辑。
 *
 * 纯逻辑，不碰 `chrome.*`（决策 D6）。后台的 retry-coordinator 只负责把入参凑齐
 * （规则是否命中、失败原因、设置项），判定本身在这里，所以每一条规则都能在 Node 里
 * 逐个钉死。
 *
 * **为什么重试是「重新发一次请求」而不是「PAC 返回一串代理」**（决策 D20）：
 * PAC 可以返回 `PROXY a; PROXY b; DIRECT`，浏览器会在连不上 a 时自动改用 b。但那样
 * 一来，a 挂掉时它名下的**全部**流量都会压到 b 上，而 PAC 的轮询计数器根本不知道
 * 发生过失败，下一个请求的链首恰好也是 b —— b 干两份活。这个扩展存在的唯一理由就是
 * 把请求摊到多个 IP 上，链式兜底偏偏在最需要均匀的时候破坏均匀性。
 *
 * 重新发一次请求则会触发一次新的 `FindProxyForURL`：轮询下标已经前进，而 Chromium
 * 自带的坏代理列表也已经把刚刚连不上的那个排除掉了（见 docs/LIMITATIONS.md 第 5 节）。
 * 所以「跳过已经试过的代理」这件事不需要在扩展里维护任何状态。
 */

import { rewriteImageUrl } from './image-proxy.js';

/**
 * 代理层故障：连不上代理、CONNECT 被拒、代理证书有问题、认证没谈成。
 * 换一个代理是有意义的。
 */
const PROXY_ERRORS = new Set([
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CERTIFICATE_INVALID',
  'ERR_PROXY_AUTH_UNSUPPORTED',
  'ERR_UNEXPECTED_PROXY_AUTH',
  'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
  'ERR_NO_SUPPORTED_PROXIES',
  'ERR_SOCKS_CONNECTION_FAILED',
  'ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
]);

/**
 * 连接层故障。走代理时对端就是代理本身，所以这些错误多半也是代理侧的问题
 * （被打死、连接数满、上游超时），同样值得换一个再试。
 */
const NETWORK_ERRORS = new Set([
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_FAILED',
  'ERR_TIMED_OUT',
  'ERR_EMPTY_RESPONSE',
  'ERR_RESPONSE_HEADERS_TRUNCATED',
  'ERR_SSL_PROTOCOL_ERROR',
  'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_NETWORK_CHANGED',
]);

/** 主动取消：用户翻页了、别的扩展拦了。重发只会再被取消一次 */
const ABORTED_ERRORS = new Set([
  'ERR_ABORTED',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_BLOCKED_BY_ADMINISTRATOR',
  'ERR_BLOCKED_BY_RESPONSE',
]);

/** 可以重试的失败类别 */
const RETRIABLE = new Set(['proxy', 'network']);

/** 去掉 `net::` 前缀，拿到裸的错误码 */
function bareCode(error) {
  return String(error || '').replace(/^net::/, '').trim().toUpperCase();
}

/**
 * 把一次 webRequest 观测结果归类。
 *
 * @param {{error?: string, statusCode?: number}|null} observed
 *   `onErrorOccurred` 给 error，`onCompleted` 给 statusCode；两者都没有就是没观测到
 * @returns {'proxy'|'network'|'origin'|'aborted'|'other'|'ok'|'unknown'}
 */
export function classifyFailure(observed) {
  if (!observed || typeof observed !== 'object') return 'unknown';

  const code = bareCode(observed.error);
  if (code) {
    if (PROXY_ERRORS.has(code)) return 'proxy';
    if (NETWORK_ERRORS.has(code)) return 'network';
    if (ABORTED_ERRORS.has(code)) return 'aborted';
    return 'other';
  }

  const status = Number(observed.statusCode);
  if (!Number.isFinite(status) || status <= 0) return 'unknown';
  // 407 看着像站点的错，实际是代理要求认证而没谈成 —— 换一个代理是有意义的
  if (status === 407) return 'proxy';
  if (status >= 400) return 'origin';
  return 'ok';
}

/** 这个类别值不值得换个代理重发 */
export function isRetriableKind(kind) {
  return RETRIABLE.has(kind);
}

/** 把脏输入夹成 ≥1 的整数 */
function attemptOf(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 判定一张失败的图片接下来怎么办。
 *
 * @param {object} input
 * @param {string} input.url 原图地址
 * @param {number} input.attempt 这是第几次尝试（含首次）
 * @param {string} input.kind classifyFailure() 的结果
 * @param {boolean} input.matched 这个 URL 命中了启用的规则吗（即：是本扩展路由出去的吗）
 * @param {number} input.maxAttempts 每张图最多尝试几个节点（含首次）
 * @param {boolean} input.fallbackEnabled 兜底图片代理是否启用
 * @param {string} input.fallbackTemplate 兜底模板
 * @returns {{action: 'retry'|'fallback'|'give-up', url?: string, reason?: string}}
 *   reason 只在 give-up 时给，取值：not-routed | not-proxy-failure | unknown-cause | exhausted
 */
export function decideRetry({
  url,
  attempt,
  kind,
  matched,
  maxAttempts,
  fallbackEnabled,
  fallbackTemplate,
} = {}) {
  // 不是本扩展路由出去的图，裂了也与我们无关。重刷它纯属给别人的站点添乱
  if (!matched) return { action: 'give-up', reason: 'not-routed' };

  // 原因不明 ≠ 代理挂了。当成代理故障的话，每张 404 的图都会去兜底服务上再取一次，
  // 白白把图源地址交给第三方
  if (kind === 'unknown') return { action: 'give-up', reason: 'unknown-cause' };
  if (!isRetriableKind(kind)) return { action: 'give-up', reason: 'not-proxy-failure' };

  const cap = Math.max(1, Math.trunc(Number(maxAttempts)) || 1);
  if (attemptOf(attempt) < cap) return { action: 'retry' };

  // 轮询节点都试过了，交给兜底图片代理。rewriteImageUrl 会挡住「兜底自己失败后
  // 又被套一层」的情况（返回 null），所以这里不需要额外判断
  if (fallbackEnabled) {
    const rewritten = rewriteImageUrl(fallbackTemplate, url);
    if (rewritten) return { action: 'fallback', url: rewritten };
  }
  return { action: 'give-up', reason: 'exhausted' };
}
