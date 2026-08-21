/**
 * ASCII 安全化：把任意字符串/数据变成能安全嵌进 PAC 源码的纯 ASCII 形式。
 *
 * **为什么必须有这一层。** `chrome.proxy` 的 `pacScript.data` 只接受纯 ASCII：只要出现
 * 一个非 ASCII 字节，`chrome.proxy.settings.set()` 就整体抛错
 *
 *     'pacScript.data' supports only ASCII code(encode URLs in Punycode format).
 *
 * 注意它是**整体失败**：不是那个字符被忽略，而是一条 PAC 都注入不进去。而失败之后浏览器
 * 照旧直连，图片照样能加载 —— 于是这个 bug 的表现是「扩展安静地什么都没做」，用户只能
 * 在活动日志里看到一行错误。所以非 ASCII 在这里不是瑕疵，是功能级故障。
 *
 * 非 ASCII 会从两个方向漏进 PAC：
 *   1. 生成器自己写的注释（中文注释一律不许进 PAC，只留在本仓库的源码里）
 *   2. 用户配置 —— 规则内容、绕过列表、中文域名，经 JSON.stringify 原样带入
 *
 * 第 2 类由 `asciiJson()` 兜住：`\uXXXX` 是 JSON 与 JS 都认的转义，转义后语义**完全不变**，
 * 只是换了一种写法。第 1 类靠纪律 + tests/pac-generator.test.js 的断言。
 *
 * 本文件（以及 src/lib/ 下所有文件）不得引用 `chrome.*`。
 */

/** 任何超出 0x00-0x7F 的字符 */
const NON_ASCII = /[^\x00-\x7F]/;

/** 嵌进源码不安全的字符：非 ASCII，以及 ASCII 里的控制字符（含 DEL） */
const UNSAFE_IN_SOURCE = /[^\x20-\x7E]/g;

/**
 * 是否为纯 ASCII。
 * @param {unknown} text
 * @returns {boolean} 空值视为纯 ASCII
 */
export function isAscii(text) {
  return !NON_ASCII.test(String(text ?? ''));
}

/**
 * 把所有「嵌进源码不安全」的字符转成 `\uXXXX`。
 *
 * 顺带解决 U+2028 / U+2029：这两个字符在 JS 里算换行符，直接出现在字符串字面量中会把
 * 脚本从中间截断 —— 它们本来就该转义，跟 ASCII 要求无关。
 *
 * @param {unknown} text
 * @returns {string} 保证是纯 ASCII 可打印字符
 */
export function escapeNonAscii(text) {
  return String(text ?? '').replace(UNSAFE_IN_SOURCE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * `JSON.stringify` + 转义：产物既是合法 JSON 又是合法 JS 字面量，且保证纯 ASCII。
 *
 * 之所以能直接对 stringify 的结果做逐字符替换：JSON.stringify 的输出里不存在裸的控制
 * 字符（它自己会转义），也不存在裸引号或反斜杠，因此 0x20-0x7E 之外的字符只可能来自
 * 字符串内容（键或值）—— 把它们换成 `\uXXXX` 落在 JSON 字符串字面量内部，语义不变。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function asciiJson(value) {
  return escapeNonAscii(JSON.stringify(value));
}

/**
 * 域名 → Punycode（IDNA ToASCII）。
 *
 * 为什么需要：浏览器交给 `FindProxyForURL(url, host)` 的 host **已经是 Punycode 形式**
 * （`漫画.com` 到那里是 `xn--qex62k.com`）。所以配置里写中文域名，即便转义成 `\uXXXX`
 * 不再报错，也永远匹配不上任何请求 —— 那只是把崩溃换成了静默失效。必须转码才真能用。
 *
 * 实现借 `URL` 完成 IDNA，不自带 punycode 表。已实测通配符能存活：
 * `*.漫画.com` → `*.xn--qex62k.com`（`*` 不是 URL 的禁止主机字符）。
 *
 * 只接受**裸主机名**。带端口、带路径一律原样返回 —— 那说明用户填错了字段，
 * 悄悄截断比保留原值更糟（ASCII 底线仍由 escapeNonAscii 兜住）。
 *
 * @param {unknown} host
 * @returns {string}
 */
export function toAsciiHost(host) {
  const raw = String(host ?? '').trim();
  // 已是 ASCII 就绝不改动：连大小写都保持原样，否则等于悄悄改写了用户的规则
  if (!raw || isAscii(raw)) return raw;

  try {
    const parsed = new URL(`http://${raw}`);
    const lossless = parsed.pathname === '/' && !parsed.port && !parsed.search && !parsed.hash
      && !parsed.username && !parsed.password;
    if (lossless && parsed.hostname && isAscii(parsed.hostname)) return parsed.hostname;
  } catch {
    // 不是合法主机名（或 IDNA 转换失败），交回原值
  }
  return raw;
}
