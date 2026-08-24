import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePac, pacSummary, canRouteProbe } from '../src/lib/pac-generator.js';
import { loadPac, browserUrl } from './helpers/pac-sandbox.js';
import { isAscii } from '../src/lib/ascii.js';

/**
 * **所有 URL 都必须经 browserUrl() 走一遍。**
 * 浏览器不会把完整的 https URL 交给 FindProxyForURL —— path 与 query 已被剥掉
 * （见 helpers/pac-sandbox.js 与 src/lib/pac-url.js）。直接喂完整 URL 的断言会给出
 * 与线上相反的结论，本项目就是这么发布了一个「一个请求都没代理出去」的版本。
 */

const node = (id, o = {}) => ({
  id, name: id, protocol: 'http', host: id + '.px', port: 8080, username: '', password: '',
  enabled: true, autoDisabled: false, raw: '', meta: {},
  health: { status: 'ok', latencyMs: 1, lastCheckedAt: 0, consecutiveFailures: 0, lastError: null, egressIp: null },
  ...o,
});
const rule = (o = {}) => ({ id: 'r_1', name: 'r', type: 'host', pattern: 'manga.com', enabled: true, nodeIds: [], ...o });
const cfg = (o = {}) => ({
  version: 1, enabled: true, nodes: [node('a'), node('b')], rules: [rule()],
  settings: {
    strategy: 'round-robin', fallback: 'direct', rotateEvery: 1,
    probe: { url: 'https://probe.test/204', timeoutMs: 5000, intervalMinutes: 15, autoDisable: true, failureThreshold: 2, recoverProbe: true },
    logLimit: 200, bypassList: ['localhost', '127.0.0.1'],
  },
  ...o,
});

const MANGA = browserUrl('https://cdn.manga.com/1.jpg');
/** 浏览器发测速请求时 PAC 看到的东西（probe.url 是 https，所以只剩源） */
const PROBE = browserUrl('https://probe.test/204?__pp_node=b&_pp_t=1');

test('生成的脚本是合法 JS 且导出 FindProxyForURL', () => {
  const pac = loadPac(generatePac(cfg(), {}));
  assert.equal(typeof pac.find(...browserUrl('http://x.com/')), 'string');
});

test('不匹配规则的请求走 DIRECT', () => {
  const pac = loadPac(generatePac(cfg(), {}));
  assert.equal(pac.find(...browserUrl('https://other.com/a.jpg')), 'DIRECT');
});

test('匹配规则的请求走代理，并按轮询换节点', () => {
  const pac = loadPac(generatePac(cfg(), { startIndex: 0 }));
  const seq = [1, 2, 3, 4].map(() => pac.find(...MANGA));
  assert.ok(seq[0].startsWith('PROXY a.px:8080'), '第一个请求用 a，实际：' + seq[0]);
  assert.ok(seq[1].startsWith('PROXY b.px:8080'), '第二个请求用 b，实际：' + seq[1]);
  assert.ok(seq[2].startsWith('PROXY a.px:8080'));
  assert.ok(seq[3].startsWith('PROXY b.px:8080'));
});

test('fallback=direct 时代理串尾部带 DIRECT', () => {
  const pac = loadPac(generatePac(cfg(), {}));
  assert.match(pac.find(...MANGA), /; DIRECT$/);
});

test('fallback=block 时不带 DIRECT 兜底', () => {
  const c = cfg();
  c.settings.fallback = 'block';
  const pac = loadPac(generatePac(c, {}));
  assert.doesNotMatch(pac.find(...MANGA), /DIRECT/);
});

test('总开关关闭时一律 DIRECT', () => {
  const pac = loadPac(generatePac(cfg({ enabled: false }), {}));
  assert.equal(pac.find(...MANGA), 'DIRECT');
});

test('没有可用节点时按 fallback 走 DIRECT', () => {
  const c = cfg({ nodes: [node('a', { enabled: false }), node('b', { autoDisabled: true })] });
  const pac = loadPac(generatePac(c, {}));
  assert.equal(pac.find(...MANGA), 'DIRECT');
});

test('自动禁用的节点被排除在轮询之外', () => {
  const c = cfg({ nodes: [node('a'), node('b', { autoDisabled: true }), node('c')] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  const seen = new Set([1, 2, 3, 4, 5, 6].map(() => pac.find(...MANGA)));
  assert.ok(![...seen].some((s) => s.includes('b.px')), 'b 不应出现：' + [...seen].join(' | '));
  assert.equal(seen.size, 2);
});

// ----------------------------------------------------------------- 测速定向
//
// 测速的定向标记不能放在 query 里 —— https 的 query 到不了 PAC。所以改成
// 「生成一份把测速地址所在源钉死到目标节点的 PAC」，一次只定向一个节点。

test('测速专用 PAC 把测速地址强制路由到指定节点，且不带 DIRECT 兜底', () => {
  const pac = loadPac(generatePac(cfg(), { probeNodeId: 'b' }));
  assert.equal(pac.find(...PROBE), 'PROXY b.px:8080', '测速必须精确命中目标节点且无兜底');
});

test('测速定向即便总开关关闭也生效（要测就得真的从那里出去一次）', () => {
  const pac = loadPac(generatePac(cfg({ enabled: false }), { probeNodeId: 'a' }));
  assert.equal(pac.find(...PROBE), 'PROXY a.px:8080');
  assert.equal(pac.find(...MANGA), 'DIRECT', '其余流量仍然全部直连');
});

test('测速定向只影响测速地址所在的源，其余流量照常分流', () => {
  const pac = loadPac(generatePac(cfg(), { startIndex: 0, probeNodeId: 'b' }));
  assert.match(pac.find(...MANGA), /^PROXY /);
  assert.equal(pac.find(...browserUrl('https://unrelated.com/x')), 'DIRECT');
});

test('测速定向可命中已被自动禁用的节点（用于恢复探测）', () => {
  const c = cfg({ nodes: [node('a'), node('b', { autoDisabled: true })] });
  const pac = loadPac(generatePac(c, { probeNodeId: 'b' }));
  assert.equal(pac.find(...PROBE), 'PROXY b.px:8080');
});

test('测速定向可命中被手动禁用的节点（用户主动点单节点测速）', () => {
  const c = cfg({ nodes: [node('a'), node('b', { enabled: false })] });
  const pac = loadPac(generatePac(c, { probeNodeId: 'b' }));
  assert.equal(pac.find(...PROBE), 'PROXY b.px:8080');
});

test('不传 probeNodeId 时测速地址没有任何特殊待遇', () => {
  const pac = loadPac(generatePac(cfg(), {}));
  assert.equal(pac.find(...PROBE), 'DIRECT', '普通 PAC 不该把测速地址钉到某个节点上');
});

test('probeNodeId 指向不存在 / 不受支持的节点时不生成定向（宁可不测也别测出假数字）', () => {
  assert.equal(loadPac(generatePac(cfg(), { probeNodeId: 'zzz' })).find(...PROBE), 'DIRECT');
  const c = cfg({ nodes: [node('s', { protocol: 'socks5', port: 1080 })] });
  assert.equal(loadPac(generatePac(c, { probeNodeId: 's' })).find(...PROBE), 'DIRECT');
  assert.equal(canRouteProbe(c, 's'), false, 'canRouteProbe 必须先把这种情况挡掉');
  assert.equal(canRouteProbe(cfg(), 'b'), true);
});

test('http 测速地址同样能被定向（query 可见与否都不影响，因为按源识别）', () => {
  const c = cfg();
  c.settings.probe.url = 'http://probe.test/204';
  const pac = loadPac(generatePac(c, { probeNodeId: 'b' }));
  assert.equal(pac.find(...browserUrl('http://probe.test/204?__pp_node=b&_pp_t=9')), 'PROXY b.px:8080');
});

test('测速地址不是合法 URL 时不生成定向', () => {
  const c = cfg();
  c.settings.probe.url = 'not a url';
  assert.equal(canRouteProbe(c, 'b'), false);
  assert.equal(loadPac(generatePac(c, { probeNodeId: 'b' })).find(...MANGA).startsWith('PROXY'), true,
    '普通分流不受影响');
});

// ----------------------------------------------------------------- 绕过与规则

test('bypassList 与本地地址始终 DIRECT', () => {
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '.*' })] });
  const pac = loadPac(generatePac(c, {}));
  assert.equal(pac.find(...browserUrl('http://localhost:3000/x')), 'DIRECT');
  assert.equal(pac.find(...browserUrl('http://127.0.0.1/x')), 'DIRECT');
  assert.equal(pac.find('http://intranet/x', 'intranet'), 'DIRECT', '单段主机名视为内网');
  assert.equal(pac.find(...browserUrl('http://192.168.1.10/x')), 'DIRECT');
  assert.equal(pac.find(...browserUrl('http://172.20.3.4/x')), 'DIRECT', '172.16–172.31 属于私有段');
});

test('只约束域名的 regex 规则在 PAC 内正确工作', () => {
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '^https://cdn\\d+\\.manga\\.com/' })] });
  const pac = loadPac(generatePac(c, {}));
  assert.match(pac.find(...browserUrl('https://cdn7.manga.com/a/1.jpg')), /^PROXY /);
  assert.equal(pac.find(...browserUrl('https://www.manga.com/a/1.jpg')), 'DIRECT');
});

test('依赖路径的 regex 规则对 http 有效、对 https 无效（浏览器行为，不是缺陷）', () => {
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '\\.jpg$' })] });
  const pac = loadPac(generatePac(c, {}));
  assert.match(pac.find(...browserUrl('http://cdn.x.com/a/1.jpg')), /^PROXY /, 'http 能看到路径');
  assert.equal(pac.find(...browserUrl('https://cdn.x.com/a/1.jpg')), 'DIRECT',
    'https 只剩 https://cdn.x.com/，正则无从匹配 —— 这一条必须被统计与规则提示暴露出来');
});

test('wildcard 规则：http 精确到路径，https 退化到域名通配', () => {
  const c = cfg({ rules: [rule({ type: 'wildcard', pattern: 'https://*.manga.com/img/*.jpg' })] });
  const pac = loadPac(generatePac(c, {}));
  assert.match(pac.find(...browserUrl('https://cdn1.manga.com/img/9.jpg')), /^PROXY /);
  assert.match(pac.find(...browserUrl('https://cdn1.manga.com/img/9.png')), /^PROXY /,
    'https 下路径不可见，只能按域名放行');
  assert.equal(pac.find(...browserUrl('https://cdn1.other.com/img/9.jpg')), 'DIRECT');
});

test('exact 与 prefix 规则：http 精确，https 退化到同源', () => {
  const exact = loadPac(generatePac(cfg({ rules: [rule({ type: 'exact', pattern: 'http://m.com/1.jpg' })] }), {}));
  assert.match(exact.find(...browserUrl('http://m.com/1.jpg')), /^PROXY /);
  assert.equal(exact.find(...browserUrl('http://m.com/1.jpg?v=2')), 'DIRECT');

  const prefix = loadPac(generatePac(cfg({ rules: [rule({ type: 'prefix', pattern: 'https://m.com/img/' })] }), {}));
  assert.match(prefix.find(...browserUrl('https://m.com/img/1.jpg')), /^PROXY /);
  assert.match(prefix.find(...browserUrl('https://m.com/other/1.jpg')), /^PROXY /, 'https 退化到整个源');
  assert.equal(prefix.find(...browserUrl('https://other.com/img/1.jpg')), 'DIRECT');
});

test('退化前缀带非默认端口时端口也要对上', () => {
  const c = cfg({ rules: [rule({ type: 'prefix', pattern: 'https://m.com:8443/img/' })] });
  const pac = loadPac(generatePac(c, {}));
  assert.match(pac.find(...browserUrl('https://m.com:8443/img/1.jpg')), /^PROXY /);
  assert.equal(pac.find(...browserUrl('https://m.com/img/1.jpg')), 'DIRECT', '端口不同就是另一个源');
});

test('host 规则不会被 notmanga.com 误命中', () => {
  const pac = loadPac(generatePac(cfg(), {}));
  assert.equal(pac.find(...browserUrl('https://notmanga.com/1.jpg')), 'DIRECT');
  assert.match(pac.find(...browserUrl('https://manga.com/1.jpg')), /^PROXY /);
});

test('含引号/反斜杠的正则被安全转义，不破坏脚本', () => {
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '["\\\\]test' })] });
  const pac = loadPac(generatePac(c, {}));
  assert.equal(typeof pac.find(...browserUrl('https://x.com/')), 'string', '脚本仍可执行');
});

test('禁用的规则不生效', () => {
  const c = cfg({ rules: [rule({ enabled: false })] });
  const pac = loadPac(generatePac(c, {}));
  assert.equal(pac.find(...MANGA), 'DIRECT');
});

test('非法正则规则被跳过且脚本仍可运行', () => {
  const c = cfg({ rules: [rule({ id: 'r_bad', type: 'regex', pattern: '([' }), rule({ id: 'r_ok' })] });
  const pac = loadPac(generatePac(c, {}));
  assert.match(pac.find(...MANGA), /^PROXY /);
  assert.deepEqual(pacSummary(c).skipped.rules, ['r_bad']);
});

test('规则绑定的节点子集生效', () => {
  const c = cfg({ nodes: [node('a'), node('b'), node('c')], rules: [rule({ nodeIds: ['c'] })] });
  const pac = loadPac(generatePac(c, {}));
  const seen = new Set([1, 2, 3].map(() => pac.find(...MANGA)));
  assert.equal(seen.size, 1);
  assert.ok([...seen][0].includes('c.px'));
});

test('规则绑定的节点全不可用时回落到全部可用节点', () => {
  const c = cfg({ nodes: [node('a'), node('b', { autoDisabled: true })], rules: [rule({ nodeIds: ['b'] })] });
  const pac = loadPac(generatePac(c, {}));
  assert.ok(pac.find(...MANGA).includes('a.px'));
});

test('https 节点生成 HTTPS 关键字', () => {
  const c = cfg({ nodes: [node('t', { protocol: 'https', host: 't.px', port: 443 })] });
  assert.match(loadPac(generatePac(c, {})).find(...MANGA), /^HTTPS t\.px:443/);
});

test('不支持的协议绝不出现在 PAC 里，并被记入 summary.skipped', () => {
  for (const protocol of ['socks5', 'socks4', 'vless', 'hysteria2', 'trojan', 'ss']) {
    const c = cfg({ nodes: [node('x', { protocol, host: 'x.px', port: 1080 })] });
    const pac = loadPac(generatePac(c, {}));
    assert.equal(pac.find(...MANGA), 'DIRECT', `${protocol} 不该被选中`);
    assert.equal(pacSummary(c).skipped.nodes.length, 1, `${protocol} 应记入 skipped`);
    assert.equal(pacSummary(c).nodeCount, 0);
    assert.doesNotMatch(generatePac(c, {}), /SOCKS/, `${protocol} 不得在 PAC 里留下 SOCKS 关键字`);
  }
});

test('http/https 与不支持的协议混杂时，只有前者进入轮询', () => {
  const c = cfg({ nodes: [
    node('a', { protocol: 'http', host: 'a.px', port: 8080 }),
    node('s', { protocol: 'socks5', host: 's.px', port: 1080 }),
    node('v', { protocol: 'vless', host: 'v.px', port: 443 }),
    node('b', { protocol: 'https', host: 'b.px', port: 8443 }),
  ] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  const seen = new Set([1, 2, 3, 4, 5, 6].map(() => pac.find(...MANGA)));
  assert.equal(seen.size, 2, '只应在 a 与 b 之间轮询，实际：' + [...seen].join(' | '));
  assert.ok([...seen].every((s) => s.includes('a.px') || s.includes('b.px')));
  assert.equal(pacSummary(c).nodeCount, 2);
  assert.equal(pacSummary(c).skipped.nodes.length, 2);
});

test('PAC 内部绝不包含明文密码', () => {
  const c = cfg({ nodes: [node('a', { username: 'alice', password: 'topsecret' })] });
  const src = generatePac(c, {});
  assert.doesNotMatch(src, /topsecret/, '密码不得出现在 PAC 里');
  assert.doesNotMatch(src, /alice/);
});

test('PAC 顶层有异常兜底：即使内部出错也返回 DIRECT', () => {
  const src = generatePac(cfg(), {});
  assert.match(src, /try\s*\{/, '必须有 try/catch');
  assert.match(src, /catch/);
});

test('生成的脚本不含 eval / Function 构造器', () => {
  const src = generatePac(cfg(), {});
  assert.doesNotMatch(src, /\beval\s*\(/);
  assert.doesNotMatch(src, /new Function/);
});

test('startIndex 决定第一个被选中的节点', () => {
  const c = cfg({ nodes: [node('a'), node('b'), node('c')] });
  assert.ok(loadPac(generatePac(c, { startIndex: 2 })).find(...MANGA).includes('c.px'));
});

test('rotateEvery=2 时每两个请求才换节点', () => {
  const c = cfg();
  c.settings.rotateEvery = 2;
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  const seq = [1, 2, 3, 4].map(() => pac.find(...MANGA));
  assert.ok(seq[0].includes('a.px'));
  assert.ok(seq[1].includes('a.px'), '第二个请求仍用 a');
  assert.ok(seq[2].includes('b.px'));
  assert.ok(seq[3].includes('b.px'));
});

test('绑定单节点的规则不会把别的规则的轮询压死在少数几个节点上', () => {
  // 轮询下标 PP_I 由所有规则共用。推进时若按「当前这条规则的池长度」取模，
  // 一个单节点池（规则绑定了一个节点）每次命中都会把共享下标重置成 0 ——
  // 于是图片规则永远只走第一个节点，其余全闲着。而这个扩展存在的唯一理由
  // 就是把请求摊到多个 IP 上。
  //
  // 注意共享计数器本身的性质：夹在中间的 API 请求同样推进下标，所以图片是
  // 隔一个取一个。池大小与步长互质时仍能走遍全部节点，这是可接受的；
  // 「永远只有一个」则不是。
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id));
  const c = cfg({
    nodes,
    rules: [
      rule({ id: 'r_img', type: 'host', pattern: 'cdn.manga.com', nodeIds: [] }),
      rule({ id: 'r_api', type: 'host', pattern: 'api.manga.com', nodeIds: ['a'] }),
    ],
  });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  const API = browserUrl('https://api.manga.com/x');

  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    seen.add(pac.find(...browserUrl(`https://cdn.manga.com/${i}.jpg`)));
    // 每张图之间夹一次 API 请求，它命中的是那条只绑了一个节点的规则
    assert.match(pac.find(...API), /a\.px/, '绑定单节点的规则当然始终走那一个节点');
  }

  assert.equal(seen.size, 5,
    `图片应当走遍 5 个节点，实际只用到 ${seen.size} 个：${[...seen].join(' | ')}`);
});

test('pacSummary 统计生效的节点与规则数', () => {
  const s = pacSummary(cfg());
  assert.equal(s.nodeCount, 2);
  assert.equal(s.ruleCount, 1);
  assert.deepEqual(s.skipped.nodes, []);
  assert.deepEqual(s.skipped.rules, []);
});

test('大量节点与规则时脚本仍可正常执行', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => node('n' + i));
  const rules = Array.from({ length: 30 }, (_, i) => rule({ id: 'r' + i, type: 'regex', pattern: `cdn${i}\\.manga\\.com` }));
  const pac = loadPac(generatePac(cfg({ nodes, rules }), {}));
  assert.match(pac.find(...browserUrl('https://cdn7.manga.com/1.jpg')), /^PROXY /);
});

test('规则列表为空时一律 DIRECT（不会误代理全部流量）', () => {
  const pac = loadPac(generatePac(cfg({ rules: [] }), {}));
  assert.equal(pac.find(...MANGA), 'DIRECT');
  assert.equal(pac.find(...browserUrl('https://any.site/x')), 'DIRECT');
});

// ---------------------------------------------------------------- ASCII 硬约束
//
// chrome.proxy 只接受纯 ASCII 的 pacScript.data：出现一个非 ASCII 字节，
// settings.set() 就整体抛「'pacScript.data' supports only ASCII code
// (encode URLs in Punycode format).」，一条 PAC 都注入不进去。而失败后浏览器照旧
// 直连，图片照样加载 —— 所以这个故障的表现是「扩展安静地什么都没做」。
// 下面这几条断言就是防止它复发的唯一屏障。

/** 把中文塞进每一个能塞的角落的对抗配置 */
function hostileCfg() {
  const c = cfg({
    nodes: [node('a'), node('idn', { host: '代理.example' })],
    rules: [
      rule({ id: 'r_rx', type: 'regex', pattern: '漫画|コミック' }),
      rule({ id: 'r_host', type: 'host', pattern: '漫画.com' }),
      rule({ id: 'r_wild', type: 'wildcard', pattern: 'https://*/漫画/*' }),
      rule({ id: 'r_exact', type: 'exact', pattern: 'https://x.com/漫画.jpg' }),
    ],
  });
  c.settings.bypassList = ['内网.local', '*.测试.cn'];
  return c;
}

test('生成的 PAC 一定是纯 ASCII', () => {
  assert.equal(isAscii(generatePac(cfg(), {})), true, '默认配置的产物必须纯 ASCII');
  assert.equal(isAscii(generatePac(hostileCfg(), { startIndex: 0 })), true,
    '配置里塞满中文时也必须纯 ASCII');
  assert.equal(isAscii(generatePac(cfg({ nodes: [], rules: [] }), {})), true, '空配置同样');
  assert.equal(isAscii(generatePac(hostileCfg(), { probeNodeId: 'idn' })), true, '测速定向版同样');
});

test('PAC 里不留任何中文注释', () => {
  // 生成器源码里的中文注释是给维护者看的，绝不能跟着产物一起下发
  assert.doesNotMatch(generatePac(cfg(), {}), /[一-鿿]/);
});

test('转义不改变匹配语义：含中文的正则在 PAC 里照旧能匹配到中文', () => {
  // 这里刻意**不**经 browserUrl()：本条只验证 asciiJson() 的 \uXXXX 转义没有改变正则的
  // 语义，所以直接把原始字符串喂给脚本。真实浏览器里这条规则其实命中不了 —— 见下一条。
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '漫画' })] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  assert.match(pac.find('http://cdn.x.com/漫画/1.jpg', 'cdn.x.com'), /^PROXY /);
  assert.equal(pac.find('http://cdn.x.com/manga/1.jpg', 'cdn.x.com'), 'DIRECT');
});

test('浏览器会把路径里的中文百分号编码，所以中文正则实际命中不了（ruleWarnings 已提示）', () => {
  // GURL 在交给 PAC 之前会把路径规范化成 UTF-8 百分号编码：漫画 → %E6%BC%AB%E7%94%BB。
  // 于是「路径里写中文」的正则不是「不报错但可能不命中」，而是**确定不命中**。
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '漫画' })] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  assert.equal(pac.find(...browserUrl('http://cdn.x.com/漫画/1.jpg')), 'DIRECT');
});


test('host 型中文域名转成 Punycode，才命中浏览器真正传进来的 host', () => {
  // 浏览器交给 FindProxyForURL 的 host 已经是 xn-- 形式；只转义不转码的话
  // 不再报错，但永远匹配不上 —— 那只是把崩溃换成了静默失效
  const c = cfg({ rules: [rule({ type: 'host', pattern: '漫画.com' })] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  assert.match(pac.find(...browserUrl('https://xn--qex62k.com/1.jpg')), /^PROXY /);
  assert.match(pac.find(...browserUrl('https://cdn.xn--qex62k.com/1.jpg')), /^PROXY /, '子域也该命中');
  assert.equal(pac.find(...browserUrl('https://other.com/1.jpg')), 'DIRECT');
});

test('绕过列表里的中文域名转成 Punycode', () => {
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '.*' })] });
  c.settings.bypassList = ['测试.cn'];
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  assert.equal(pac.find(...browserUrl('https://xn--0zwm56d.cn/1.jpg')), 'DIRECT');
  assert.match(pac.find(...browserUrl('https://elsewhere.cn/1.jpg')), /^PROXY /);
});

test('节点主机是中文域名时，PAC token 用 Punycode', () => {
  const c = cfg({ nodes: [node('idn', { host: '代理.example' })] });
  const src = generatePac(c, { startIndex: 0 });
  assert.equal(isAscii(src), true);
  const got = loadPac(src).find(...MANGA);
  assert.match(got, /^PROXY xn--mnq481g\.example:8080/, '实际：' + got);
});

test('对抗配置下脚本仍可执行且行为正常', () => {
  const pac = loadPac(generatePac(hostileCfg(), { startIndex: 0 }));
  assert.equal(typeof pac.find(...browserUrl('https://x.com/')), 'string');
  assert.equal(pac.find(...browserUrl('https://xn--v6q792i.local/a.jpg')), 'DIRECT',
    '绕过列表里的中文域名转码后应生效');
});

// ---------------------------------------------------------------- 兜底窗口

/** 一条故意写得很宽的规则，用来确认兜底窗口压得过普通轮询 */
const WIDE = rule({ type: 'regex', pattern: '^https?://' });

const FB = 'PROXY fb.px:37581';
const IMG = browserUrl('https://img.manga.com/1.jpg');

test('窗口开着时，该源被强制走兜底代理而不是轮询节点', () => {
  const pac = loadPac(generatePac(cfg(), {
    forceEntries: [{ pre: 'https://img.manga.com/', tok: FB, until: Date.now() + 60000 }],
  }));
  assert.equal(pac.find(...IMG), FB);
});

test('窗口只管它自己那个源，别的源照旧轮询', () => {
  const pac = loadPac(generatePac(cfg(), {
    forceEntries: [{ pre: 'https://img.manga.com/', tok: FB, until: Date.now() + 60000 }],
  }));
  assert.match(pac.find(...MANGA), /^PROXY a\.px|^PROXY b\.px/, 'cdn.manga.com 不在窗口里');
});

test('until 到点后条目自己失效 —— SW 死在窗口期内也不会把图源永久钉在兜底代理上', () => {
  // 这是本设计最重要的一条：过期若只靠后台定时器重注入干净 PAC，Service Worker
  // 在窗口期内被回收就等于「这个源被永久指向兜底代理」，而且没有任何东西会来撤销它
  const pac = loadPac(generatePac(cfg(), {
    forceEntries: [{ pre: 'https://img.manga.com/', tok: FB, until: Date.now() - 1000 }],
  }));
  assert.notEqual(pac.find(...IMG), FB, '过期条目不该再生效');
  assert.match(pac.find(...IMG), /^PROXY a\.px|^PROXY b\.px/, '应当回落到正常轮询');
});

test('until=0 表示不过期 —— 测速定向靠它，生命周期由调用方显式控制', () => {
  const pac = loadPac(generatePac(cfg(), {
    forceEntries: [{ pre: 'https://img.manga.com/', tok: FB, until: 0 }],
  }));
  assert.equal(pac.find(...IMG), FB);
});

test('测速定向压过兜底窗口 —— 测速是「这个节点通不通」的唯一答案，不能被改写', () => {
  const pac = loadPac(generatePac(cfg(), {
    probeNodeId: 'b',
    forceEntries: [{ pre: 'https://probe.test/', tok: FB, until: Date.now() + 60000 }],
  }));
  assert.ok(pac.find(...PROBE).startsWith('PROXY b.px'), '测速条目排在前面，实际：' + pac.find(...PROBE));
});

test('兜底窗口与测速定向可以同时存在，各管各的源', () => {
  const pac = loadPac(generatePac(cfg(), {
    probeNodeId: 'b',
    forceEntries: [{ pre: 'https://img.manga.com/', tok: FB, until: Date.now() + 60000 }],
  }));
  assert.ok(pac.find(...PROBE).startsWith('PROXY b.px'));
  assert.equal(pac.find(...IMG), FB);
});

test('强制条目不带 DIRECT 兜底 —— 那会让「切到兜底代理」变成静默直连', () => {
  const c = cfg();
  c.settings.fallback = 'direct';
  const pac = loadPac(generatePac(c, {
    forceEntries: [{ pre: 'https://img.manga.com/', tok: FB, until: Date.now() + 60000 }],
  }));
  assert.doesNotMatch(pac.find(...IMG), /DIRECT/);
});

test('残缺的 force 条目被丢掉，不会在 PAC 里留下 undefined', () => {
  const pac = generatePac(cfg(), {
    forceEntries: [{ pre: '', tok: FB, until: 1 }, { pre: 'https://a/', tok: '', until: 1 }, null],
  });
  assert.doesNotMatch(pac.slice(pac.indexOf('"force"')), /undefined/);
  assert.equal(loadPac(pac).find(...MANGA).startsWith('PROXY'), true);
});

test('兜底代理是中文域名时，PAC 仍然是纯 ASCII', () => {
  // 一个非 ASCII 字节就会让整份 PAC 被浏览器拒收（决策 D13）
  const punycode = new URL('https://图床.com/').hostname;
  const pac = generatePac(cfg({ rules: [WIDE] }), {
    forceEntries: [{ pre: 'https://img.manga.com/', tok: `PROXY ${punycode}:8080`, until: Date.now() + 60000 }],
  });
  assert.ok(isAscii(pac), '生成的 PAC 必须是纯 ASCII');
  assert.match(punycode, /^xn--/, '前提：这个域名确实需要转码');
});

test('没有 forceEntries 时行为与从前完全一致', () => {
  const pac = loadPac(generatePac(cfg({ rules: [WIDE] }), {}));
  assert.match(pac.find(...IMG), /^PROXY a\.px|^PROXY b\.px/);
});

// ---------------------------------------------------------------- 规则之外的流量

/**
 * 这一组守的是本项目最贵的一次静默故障：注入 PAC 会替换掉浏览器**整份**代理配置
 * （含「使用系统代理」），于是规则外的流量从「经本机代理客户端出去」变成真·直连 ——
 * 图片站按规则走节点、一切看着正常，而其余网站全部 ERR_CONNECTION_TIMED_OUT，
 * 扩展这边一个错都不报。详见 src/lib/default-proxy.js 开头。
 */

const DFLT = '127.0.0.1:7897';
const DFLT_TOKEN = 'PROXY 127.0.0.1:7897';
const OTHER = browserUrl('https://other.com/a.jpg');

/** 带默认代理的配置 */
function dfltCfg(o = {}) {
  const c = cfg(o);
  c.settings.defaultProxy = {
    enabled: true, raw: DFLT, protocol: 'http', host: '127.0.0.1', port: 7897,
    username: '', password: '',
  };
  return c;
}

test('配了默认代理时，没命中规则的请求走默认代理而不是直连', () => {
  const pac = loadPac(generatePac(dfltCfg(), {}));
  assert.equal(pac.find(...OTHER), DFLT_TOKEN);
});

test('没配默认代理时行为与从前完全一致 —— 仍然是 DIRECT', () => {
  const pac = loadPac(generatePac(cfg(), {}));
  assert.equal(pac.find(...OTHER), 'DIRECT');
});

test('默认代理只是没启用时也回落到 DIRECT', () => {
  const c = dfltCfg();
  c.settings.defaultProxy.enabled = false;
  assert.equal(loadPac(generatePac(c, {})).find(...OTHER), 'DIRECT');
});

test('默认代理地址不可用时回落到 DIRECT，不产出半截 token', () => {
  const c = dfltCfg();
  c.settings.defaultProxy.protocol = 'socks5';
  const pac = generatePac(c, {});
  assert.match(pac, /"dflt":""/, '不可用就必须是空串，不能是 "undefined" / "null" 这类字面量');
  assert.equal(loadPac(pac).find(...OTHER), 'DIRECT');
});

test('默认代理不影响命中规则的请求 —— 它们照旧进轮询池', () => {
  const pac = loadPac(generatePac(dfltCfg(), { startIndex: 0 }));
  assert.ok(pac.find(...MANGA).startsWith('PROXY a.px:8080'));
  assert.ok(pac.find(...MANGA).startsWith('PROXY b.px:8080'), '轮询计数器不受影响');
});

test('绕过列表与私有网段永远直连，绝不送进默认代理', () => {
  const pac = loadPac(generatePac(dfltCfg(), {}));
  assert.equal(pac.find('http://localhost/x', 'localhost'), 'DIRECT');
  assert.equal(pac.find('http://127.0.0.1:7897/', '127.0.0.1'), 'DIRECT',
    '默认代理自己的地址必须直连，否则就是自环');
  assert.equal(pac.find('http://10.0.0.3:24014/', '10.0.0.3'), 'DIRECT');
  assert.equal(pac.find('http://192.168.1.2/', '192.168.1.2'), 'DIRECT');
});

test('fallback=direct 时命中规则的尾部仍是字面 DIRECT —— 那个设置说的就是直连', () => {
  const c = dfltCfg();
  c.settings.fallback = 'direct';
  const got = loadPac(generatePac(c, {})).find(...MANGA);
  assert.match(got, /; DIRECT$/, `实际：${got}`);
});

test('兜底窗口与测速定向压得过默认代理', () => {
  const pac = loadPac(generatePac(dfltCfg({ rules: [WIDE] }), {
    probeNodeId: 'b',
    forceEntries: [{ pre: 'https://img.manga.com/', tok: FB, until: Date.now() + 60000 }],
  }));
  assert.equal(pac.find(...IMG), FB, '兜底窗口优先');
  assert.ok(pac.find(...PROBE).startsWith('PROXY b.px'), '测速优先');
});

test('主开关关闭时（探测用 PAC）规则外流量仍走默认代理，不把整个浏览器拖下水', () => {
  const c = dfltCfg({ enabled: false });
  const pac = loadPac(generatePac(c, { probeNodeId: 'b' }));
  assert.equal(pac.find(...OTHER), DFLT_TOKEN);
  assert.ok(pac.find(...PROBE).startsWith('PROXY b.px'), '测速本身照旧被强制定向');
});

test('默认代理是中文域名时，PAC 仍然是纯 ASCII', () => {
  const c = dfltCfg();
  c.settings.defaultProxy.host = '图床.com';
  const pac = generatePac(c, {});
  assert.ok(isAscii(pac), '一个非 ASCII 字节就会让整份 PAC 被浏览器拒收');
  assert.match(loadPac(pac).find(...OTHER), /^PROXY xn--/);
});

test('默认代理不进 pacSummary 的节点计数 —— 它不是节点', () => {
  assert.equal(pacSummary(dfltCfg()).nodeCount, pacSummary(cfg()).nodeCount);
});
