/**
 * 兜底图片代理：URL 模板的校验与改写。
 *
 * 这是重试链的最后一环。轮询节点全部试过仍然失败时，内容脚本把 `<img>` 的地址改写成
 * `模板(原图地址)`，让请求走一个 URL 改写型图片代理（wsrv.nl / imgproxy / 自建 Worker
 * 这类按 query 取图的服务）。
 *
 * **为什么兜底是 URL 改写而不是 HTTP 代理**（决策 D23）：HTTP 代理只能通过 PAC 表达，
 * 而 PAC 里的兜底会在重试**之前**生效 —— 连接失败会被浏览器当场切到兜底并成功，
 * 图片根本不派发 `error`，于是「先换几个轮询节点再说」那一段永远执行不到，兜底从
 * 「最后一道防线」变成了「第二个选项」。URL 改写是逐请求生效的，顺序完全正确，
 * 而且不碰全局代理设置，不与测速抢那把互斥锁（决策 D19）。
 *
 * 兜底请求走的是**兜底服务自己的域名**，命不中用户的图源规则，所以它自然直连、
 * 不经轮询池 —— 即使所有代理都挂了，兜底照样能用。
 *
 * 本文件是纯逻辑，不碰 `chrome.*`（决策 D6）。
 */

/** 模板里可用的占位符 */
export const PLACEHOLDERS = ['{url}', '{raw}'];

/** 校验时用来试填的探针地址，只为让模板能被 `new URL()` 解析 */
const PROBE = 'https://example.com/probe.jpg';

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 把占位符换成实际内容。`{url}` 编码、`{raw}` 原样 */
function substitute(template, url) {
  return template
    .split('{url}').join(encodeURIComponent(url))
    .split('{raw}').join(url);
}

/**
 * 模板能不能用。
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateTemplate(template) {
  const text = asText(template);
  if (!text) return { ok: false, reason: '请填写兜底图片代理地址' };

  if (!PLACEHOLDERS.some((p) => text.includes(p))) {
    // 没有占位符的模板会把每张图都改写成同一个地址，
    // 表现为「所有图片变成了同一张」—— 必须在入口就挡掉
    return { ok: false, reason: '地址里必须含 {url}（推荐）或 {raw} 占位符，用来放原图地址' };
  }

  let parsed;
  try {
    parsed = new URL(substitute(text, PROBE));
  } catch {
    return { ok: false, reason: '这不是一个合法的网址' };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, reason: '兜底图片代理只能是 http:// 或 https:// 地址' };
  }
  return { ok: true };
}

/**
 * 兜底服务自己的源，例如 `https://wsrv.nl`。
 * @returns {string|null} 模板非法时返回 null
 */
export function templateOrigin(template) {
  const text = asText(template);
  if (!validateTemplate(text).ok) return null;
  try {
    return new URL(substitute(text, PROBE)).origin;
  } catch {
    return null;
  }
}

/**
 * 兜底服务的主机名，例如 `wsrv.nl`。
 *
 * PAC 生成器用它把兜底服务加进绕过列表：兜底存在的前提就是轮询节点都不好使了，
 * 这时候再把取兜底图的请求送进同一个坏池子等于让最后一道防线也跟着挂。而用户完全
 * 可能写出一条宽泛的规则（`^https?://(img|cdn)\d*\.`）恰好命中兜底服务的域名 ——
 * 那种失效很难自查，不如直接钉死。
 *
 * @returns {string|null}
 */
export function templateHost(template) {
  const origin = templateOrigin(template);
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * 这个地址是不是已经由兜底服务提供的。
 *
 * 用来防止套娃：兜底本身失败时，那次失败会再走一遍重试判定，若不拦住就会套出
 * `兜底/?url=兜底/?url=…` 并无限递归下去。
 */
export function isProxiedUrl(template, url) {
  const origin = templateOrigin(template);
  if (!origin) return false;
  try {
    return new URL(String(url)).origin === origin;
  } catch {
    return false;
  }
}

/**
 * 把原图地址改写成兜底地址。
 * @returns {string|null} 模板非法、原图不是 http/https、或原图已经是兜底地址时返回 null
 */
export function rewriteImageUrl(template, url) {
  const text = asText(template);
  if (!validateTemplate(text).ok) return null;

  const target = asText(url);
  try {
    if (!/^https?:$/.test(new URL(target).protocol)) return null;
  } catch {
    return null;
  }
  if (isProxiedUrl(text, target)) return null;

  return substitute(text, target);
}
