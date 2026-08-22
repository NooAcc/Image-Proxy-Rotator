import vm from 'node:vm';

/**
 * 模拟浏览器真正递给 FindProxyForURL 的两个参数。
 *
 * **必须用它，不要手写 `pac.find('https://a.com/1.jpg', 'a.com')`。**
 * Chromium 在调用 PAC 之前会净化 URL（net/proxy_resolution/proxy_resolution_service.cc
 * 的 SanitizeUrl）：去掉用户名、密码、fragment；**并且对「加密方案」（https / wss）
 * 额外清掉 path 与 query**。直接喂完整 URL 的测试会给出与线上完全相反的结论 ——
 * 本项目就是因此发布了一个「一个请求都没代理出去」的版本。
 *
 * 这里刻意不复用 src/lib/pac-url.js：两套独立实现互为对照，
 * 生产实现写错时测试不会跟着一起错。
 *
 * @param {string} url 页面里真实发起的完整 URL
 * @returns {[string, string]} 可直接展开给 pac.find(...) 的 [url, host]
 */
export function browserUrl(url) {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') {
    parsed.pathname = '/';
    parsed.search = '';
  }
  return [parsed.href, parsed.hostname.replace(/^\[|\]$/g, '')];
}

/**
 * 在带 PAC 内置函数桩的沙箱里执行生成出来的 PAC 脚本。
 *
 * 返回的 find() 可反复调用，且沙箱状态在多次调用之间保持 ——
 * 这对验证「轮询计数器真的在 FindProxyForURL 之间累加」至关重要。
 */
export function loadPac(source) {
  const sandbox = {
    isPlainHostName: (h) => !String(h).includes('.') && !String(h).includes(':'),
    dnsDomainIs: (h, d) => typeof h === 'string' && (h === d || h.endsWith(d)),
    shExpMatch: (str, pat) => {
      const src = '^' + String(pat)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$';
      return new RegExp(src).test(String(str));
    },
    localHostOrDomainIs: (h, d) => h === d,
    isInNet: () => false,
    myIpAddress: () => '127.0.0.1',
    dnsResolve: () => null,
    alert: () => {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(source, ctx, { timeout: 2000 });
  return {
    find(url, host) {
      const h = host ?? new URL(url).hostname;
      return vm.runInContext(
        `FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(h)})`,
        ctx,
        { timeout: 2000 },
      );
    },
  };
}
