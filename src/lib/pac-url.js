/**
 * PAC 看得见什么 —— 本扩展最贵的一课。
 *
 * Chromium 在调用 `FindProxyForURL(url, host)` 之前会先**净化** URL
 * （`net/proxy_resolution/proxy_resolution_service.cc` 的 `SanitizeUrl`）：
 *
 *   · 所有方案：清掉 username / password / fragment
 *   · **加密方案（https、wss）：额外清掉 path 与 query**
 *
 * 也就是说浏览器交给 PAC 的不是 `https://cdn.manga.com/img/001.jpg`，
 * 而是 `https://cdn.manga.com/`。这是 Chromium 52 起的隐私措施
 * （PacHttpsUrlStrippingEnabled 策略早已随 Chrome 74 一起移除，无法关闭）。
 *
 * 后果极其隐蔽：一条 `\.(jpe?g|png|webp)$` 的规则在设置页的规则测试器里命中，
 * 在单元测试里命中，在浏览器里**永远命中不了** —— 而命中不了就是 DIRECT，
 * 图片照样加载，用户只会觉得「扩展装了但好像没用」。本项目 1.2.0 之前正是如此：
 * 统计显示 277 次「本该走代理」的请求，代理服务商后台却一条连接都没有。
 *
 * 所以：**任何以完整 URL 为模式的规则，都必须同时准备一份「只靠 scheme+host+port
 * 也能判定」的退化形式**。这个文件提供两件事：
 *   1. `pacUrl()` —— 精确复刻浏览器的净化行为，让 JS 侧和 PAC 侧看到同一个东西
 *   2. `urlPatternScope()` —— 从 URL 形态的规则里提取出净化后仍可判定的同源前缀
 */

/**
 * 会被剥掉 path / query 的方案。
 * 对应 Chromium 的 `GURL::SchemeIsCryptographic()`。
 */
const CRYPTOGRAPHIC_SCHEMES = ['https:', 'wss:'];

/** 该 URL 交给 PAC 时会不会丢掉 path 与 query */
export function isSanitizedScheme(url) {
  const scheme = String(url ?? '').slice(0, 6).toLowerCase();
  return scheme.startsWith('https:') || scheme.startsWith('wss:');
}

/**
 * 把页面里真实发起的 URL 变成浏览器实际递给 PAC 的那一个。
 *
 * 无法解析的输入原样返回 —— 这个函数在请求热路径上，绝不能抛。
 *
 * @param {string} url
 * @returns {string}
 */
export function pacUrl(url) {
  const raw = String(url ?? '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  if (CRYPTOGRAPHIC_SCHEMES.includes(parsed.protocol)) {
    // 注意顺序：先清 query 再清 path，避免中间态被 URL 序列化成 '?'
    parsed.search = '';
    parsed.pathname = '/';
  }
  return parsed.href;
}

/**
 * 从「整条 URL 的模式」里取出净化后仍可判定的同源前缀。
 *
 * 这是 exact / prefix / wildcard 三种规则在 HTTPS 下的退化形式：路径看不见了，
 * 那就退到「同一个源」这一层，而不是干脆匹配不上。范围确实被放宽了，所以设置页
 * 会把退化后的实际范围直接显示出来 —— 放宽可以接受，**悄悄放宽不行**。
 *
 * @param {string} pattern 规则内容
 * @param {{wildcard?: boolean}} [options] wildcard 型允许模式里带 `*`
 * @returns {{glob: boolean, pat: string}|null} 无法提取时返回 null（该规则对 HTTPS 无解）
 */
export function urlPatternScope(pattern, { wildcard = false } = {}) {
  const raw = String(pattern ?? '').trim();
  if (!raw) return null;

  // 只认「字面量 scheme + '//' + 权限部分」。`*://a.com/*` 这种连方案都通配的写法
  // 无法安全还原成前缀，宁可返回 null 并给出警告
  const matched = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(raw);
  if (!matched) return null;

  const [, scheme, authority] = matched;
  if (!authority) return null;

  if (!authority.includes('*')) {
    // 没有通配符时走一次真正的 URL 解析，好让默认端口、大小写、IDN 都被归一化 ——
    // 否则 `https://m.com:443/x` 会生成永远匹配不上的 `https://m.com:443/`
    try {
      const url = new URL(`${scheme}://${authority}/`);
      return { glob: false, pat: `${url.origin}/` };
    } catch {
      return null;
    }
  }

  if (!wildcard) return null;
  return { glob: true, pat: `${scheme.toLowerCase()}://${authority}/` };
}

/**
 * 净化后的 URL 长什么样，用来试探一条正则「有没有可能命中 HTTPS 请求」。
 *
 * 正则是图灵完备的，静态判定「能否匹配某个形状的字符串」不可判定，所以这里用
 * 取样法：拿一批形如 `https://主机/` 的样本试一遍，一条都匹配不上就提示用户。
 * 结论是启发式的，措辞也相应保留（「可能」）；要精确答案请用设置页的规则测试器，
 * 或直接看统计里的「规则命中但实际直连」计数 —— 那两处是精确的。
 */
const SANITIZED_SAMPLES = [
  'https://example.com/',
  'https://www.example.com/',
  'https://img1.example.com/',
  'https://image.example.com/',
  'https://images.example.com/',
  'https://pic.example.com/',
  'https://photo.example.com/',
  'https://cdn.example.net/',
  'https://static.example.org/',
  'https://media.example.org/',
  'https://a.b.c.example.org:8443/',
  'https://192.0.2.1/',
];

/** 从模式里抠出形似域名的字面量，用它拼出更贴近用户意图的样本 */
function literalHosts(pattern) {
  // 先把 \. 之类的转义还原成字面量，正则里的域名几乎都写成 cdn\.manga\.com
  const plain = String(pattern ?? '').replace(/\\(.)/g, '$1');
  const found = plain.match(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/gi) || [];
  return [...new Set(found)].slice(0, 8);
}

/**
 * 这条规则有没有可能命中一个被净化过的 HTTPS URL。
 *
 * @param {(url: string) => boolean} test 已编译的匹配函数
 * @param {string} pattern 原始模式，用于生成更贴题的样本
 * @returns {boolean} false 表示「取样范围内一条都匹配不上」
 */
export function canMatchSanitized(test, pattern) {
  const samples = [...SANITIZED_SAMPLES];
  for (const host of literalHosts(pattern)) {
    samples.push(`https://${host}/`, `https://cdn.${host}/`, `https://img1.${host}/`);
  }
  return samples.some((sample) => {
    try {
      return test(sample, new URL(sample).hostname) === true;
    } catch {
      return false;
    }
  });
}
