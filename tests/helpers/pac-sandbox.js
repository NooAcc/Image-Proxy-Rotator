import vm from 'node:vm';

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
