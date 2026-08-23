/**
 * 深度重试站点清单的规范化与校验。
 *
 * 这个文件回答一个问题：**用户填的一行文本，该注册成哪个 match pattern。**
 *
 * 为什么要单独一层而不是直接把用户输入塞给 `chrome.scripting`：
 *
 *   1. `registerContentScripts()` 对非法 pattern 是**整批拒绝**的 —— 十条里有一条写错，
 *      十条一起不注册。而失败之后页面照常加载、补丁只是不存在，表现又是「勾了但没用」。
 *      所以非法条目必须在进 chrome API 之前就被摘出来，并且带着**原因**回给设置页。
 *   2. 有几种「合法但等于绕回全局注入」的写法必须挡掉（`<all_urls>`、主机写成 `*`）。
 *      那是本设计被接受的前提（见 spec「为什么不是 manifest 静态声明」），不是可选项。
 *
 * 本文件是纯逻辑，不碰 `chrome.*`（决策 D6）。
 */

/** 一份配置里最多几条深度重试站点 */
export const DEEP_RETRY_SITE_CAP = 50;

/** 只允许这三种 scheme —— `file` / `ftp` 之类与图片代理毫无关系 */
const ALLOWED_SCHEMES = ['*', 'http', 'https'];

/**
 * 主机名里允许出现的字符。
 * 刻意不接受端口：match pattern 的 host 部分**不支持端口**，写了会被 chrome 整批拒绝。
 */
const HOST_CHARS = /^[a-z0-9.\-*]+$/i;

/**
 * 裸域名（没有 scheme、没有路径）的形状。
 * 至少要有一个点 —— `localhost` 这种单段主机名在这里没有意义，而且容易是手误。
 */
const BARE_DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 校验 match pattern 的 host 部分。
 * @returns {?string} 出错原因；null = 合法
 */
function hostReason(host) {
  if (!host) return '缺少主机名';
  if (host === '*') {
    return '主机名不能只写 `*` —— 那等于给所有网站打补丁，本扩展刻意不提供这个选项';
  }
  if (!HOST_CHARS.test(host)) {
    // 端口是最常见的一种写错，值得一句专门的提示 —— 泛泛的「含不允许的字符」
    // 会让用户盯着域名找错字，而错的其实是那个冒号
    if (host.includes(':')) return '不能带端口号：match pattern 的主机部分不支持端口';
    return `主机名含不允许的字符：${host}`;
  }
  // `*` 只能作为最前面的整段出现，`a*.com` / `*.*.com` 都是非法的
  const stars = host.split('*').length - 1;
  if (stars > 1) return '主机名里最多只能有一个 `*`';
  if (stars === 1 && !host.startsWith('*.')) {
    return '`*` 只能写成最前面的一整段，例如 `*.example.com`';
  }
  if (host.startsWith('*.') && !BARE_DOMAIN.test(host.slice(2))) {
    return `\`*.\` 后面不是一个合法域名：${host}`;
  }
  if (!host.startsWith('*.') && !BARE_DOMAIN.test(host)) {
    return `不是一个合法域名：${host}`;
  }
  return null;
}

/**
 * 把用户填的一行变成可以交给 `chrome.scripting` 的 match pattern。
 *
 * 两种写法：
 *   · 裸域名 `nhentai.net` → `*://*.nhentai.net/*`（连子域名一起覆盖，与「域名」型规则同调）
 *   · 完整 match pattern `https://noymanga.com/read/*` → 校验后原样使用
 *
 * @param {unknown} raw
 * @returns {{ok: true, pattern: string} | {ok: false, reason: string}}
 */
export function normalizeSite(raw) {
  const text = asText(raw);
  if (!text) return { ok: false, reason: '内容不能为空' };

  if (text === '<all_urls>') {
    return {
      ok: false,
      reason: '不接受 `<all_urls>`：给所有网站打主世界补丁正是本扩展刻意不做的事，'
        + '请逐个填写要覆盖的站点',
    };
  }

  // 没有 `://` 的一律当裸域名处理
  if (!text.includes('://')) {
    if (text.includes('/')) {
      return { ok: false, reason: '要带路径的话必须写成完整形式，例如 `https://example.com/read/*`' };
    }
    const reason = hostReason(text);
    if (reason) return { ok: false, reason };
    if (text.startsWith('*.')) return { ok: true, pattern: `*://${text}/*` };
    // 裸域名自动覆盖子域名：图源几乎总在子域上，只写主域是最常见的手误
    return { ok: true, pattern: `*://*.${text.toLowerCase()}/*` };
  }

  const matched = /^([a-z0-9*]+):\/\/([^/]*)(\/.*)?$/i.exec(text);
  if (!matched) return { ok: false, reason: '不是一个合法的 match pattern' };

  const [, rawScheme, host, path] = matched;
  const scheme = rawScheme.toLowerCase();
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    return { ok: false, reason: `不支持的 scheme：${rawScheme}（只能是 http、https 或 *）` };
  }

  const reason = hostReason(host.toLowerCase());
  if (reason) return { ok: false, reason };

  // 路径是 match pattern 的必需部分，省略时补 `/*`（chrome 自己不会补，会直接报错）
  return { ok: true, pattern: `${scheme}://${host.toLowerCase()}${path || '/*'}` };
}

/**
 * 整份清单 → 可注册的 patterns + 被摘出来的条目。
 *
 * **`skipped` 不是调试信息，是要展示给用户的东西。** 静默丢弃一条写错的站点，
 * 表现就是「这个站点勾了但补丁没装上」，而界面上什么线索都没有。
 *
 * @param {unknown} sites
 * @returns {{patterns: string[], skipped: Array<{raw: string, reason: string}>}}
 */
export function deepRetryPatterns(sites) {
  const list = Array.isArray(sites) ? sites : [];
  const patterns = [];
  const skipped = [];
  const seen = new Set();

  for (const raw of list.slice(0, DEEP_RETRY_SITE_CAP)) {
    const result = normalizeSite(raw);
    if (!result.ok) {
      skipped.push({ raw: asText(raw), reason: result.reason });
      continue;
    }
    // 重复的 pattern 交给 chrome 也不会报错，但会让「注册了几条」这个数字对不上
    if (seen.has(result.pattern)) continue;
    seen.add(result.pattern);
    patterns.push(result.pattern);
  }

  for (const raw of list.slice(DEEP_RETRY_SITE_CAP)) {
    skipped.push({ raw: asText(raw), reason: `超出上限（最多 ${DEEP_RETRY_SITE_CAP} 条）` });
  }

  return { patterns, skipped };
}

/**
 * 深度重试现在是不是真的在生效。
 *
 * 开关开着但一条可用模式都没有 = 什么都不会发生，这种状态**不算启用** ——
 * 与 `normalizeFallbackImage` 强制关掉非法模板是同一条纪律。
 *
 * @param {object} settings
 * @returns {boolean}
 */
export function deepRetryActive(settings) {
  const deep = settings?.deepRetry;
  if (deep?.enabled !== true) return false;
  return deepRetryPatterns(deep.sites).patterns.length > 0;
}
