/**
 * Chromium 只把 scheme + host + port 交给 PAC（https / wss 的 path 与 query 会被剥掉）。
 *
 * 这份测试是本项目最贵的一课：在此之前，整个 PAC 测试套件都用
 * `pac.find('https://cdn.manga.com/1.jpg', 'cdn.manga.com')` 这样的**完整 URL** 去调
 * FindProxyForURL —— 而浏览器从来不会这么调。于是 271 个测试全绿，扩展却一个请求
 * 都没代理出去。
 *
 * 所以下面所有断言都必须经 `browserUrl()` 走一遍，模拟浏览器真正递进来的东西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePac } from '../src/lib/pac-generator.js';
import { pacUrl, isSanitizedScheme } from '../src/lib/pac-url.js';
import { matchPacUrl, matchUrl } from '../src/lib/rule-matcher.js';
import { loadPac, browserUrl } from './helpers/pac-sandbox.js';

const node = (id, o = {}) => ({
  id, name: id, protocol: 'http', host: id + '.px', port: 8080, username: '', password: '',
  enabled: true, autoDisabled: false, raw: '', meta: {},
  health: { status: 'ok', latencyMs: 1, lastCheckedAt: 0, consecutiveFailures: 0, lastError: null, egressIp: null },
  ...o,
});
const rule = (o = {}) => ({ id: 'r_1', name: 'r', type: 'host', pattern: 'manga.com', enabled: true, nodeIds: [], ...o });
const cfg = (o = {}) => ({
  version: 1, enabled: true, nodes: [node('a')], rules: [rule()],
  settings: {
    strategy: 'round-robin', fallback: 'direct', rotateEvery: 1,
    probe: { url: 'https://probe.test/204', timeoutMs: 5000, intervalMinutes: 15, autoDisable: true, failureThreshold: 2, recoverProbe: true },
    logLimit: 200, bypassList: [],
  },
  ...o,
});

// ------------------------------------------------------------------ pacUrl()

test('https 的 path / query / hash 全部被剥掉', () => {
  assert.equal(pacUrl('https://cdn.manga.com/img/001.jpg?v=2#x'), 'https://cdn.manga.com/');
});

test('https 的非默认端口保留，默认端口省略', () => {
  assert.equal(pacUrl('https://cdn.manga.com:8443/img/1.jpg'), 'https://cdn.manga.com:8443/');
  assert.equal(pacUrl('https://cdn.manga.com:443/img/1.jpg'), 'https://cdn.manga.com/');
});

test('wss 与 https 一样被剥（Chromium 按「加密方案」判定，不是按 https 字面量）', () => {
  assert.equal(pacUrl('wss://push.manga.com/socket?token=abc'), 'wss://push.manga.com/');
  assert.equal(isSanitizedScheme('wss://push.manga.com/'), true);
  assert.equal(isSanitizedScheme('https://a.com/'), true);
  assert.equal(isSanitizedScheme('http://a.com/'), false);
});

test('http 保留完整 path 与 query，只去掉凭据与 hash', () => {
  assert.equal(pacUrl('http://cdn.manga.com/img/1.jpg?v=2'), 'http://cdn.manga.com/img/1.jpg?v=2');
  assert.equal(pacUrl('http://u:p@cdn.manga.com/a#frag'), 'http://cdn.manga.com/a');
});

test('无法解析的输入原样返回，绝不抛异常', () => {
  assert.equal(pacUrl('not a url'), 'not a url');
  assert.equal(pacUrl(''), '');
});

// -------------------------------------------------- 回归：这就是「一点流量都没有」的原因

test('回归：扩展名正则在 HTTPS 图片上永远命中不了，必须显式告知而不是静默直连', () => {
  // 这是 README 里教用户开启的那条预设。浏览器交给 PAC 的是 'https://cdn.manga.com/'，
  // 正则里的 `\.jpg$` 没有任何可匹配的对象。
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '\\.(jpe?g|png|webp)(\\?.*)?$' })] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  const url = 'https://cdn.manga.com/img/001.jpg';

  assert.equal(pac.find(...browserUrl(url)), 'DIRECT', '这条规则对 HTTPS 就是不生效 —— 事实如此');
  // 而 JS 侧看到的是完整 URL，会认为「本该走代理」；两边不一致正是统计里
  // 「277 次请求 / 277 次无法归因」的来源
  assert.ok(matchUrl(url, c.rules), 'JS 侧（完整 URL）命中');
  assert.equal(matchPacUrl(url, c.rules), null, 'PAC 侧（净化后 URL）不命中 —— 差值必须能被统计出来');
});

test('host 规则在净化后的 URL 下照常命中（这是唯一天然安全的类型）', () => {
  const pac = loadPac(generatePac(cfg(), { startIndex: 0 }));
  assert.match(pac.find(...browserUrl('https://cdn.manga.com/img/001.jpg')), /^PROXY a\.px:8080/);
});

test('prefix 规则在 HTTPS 下退化成同源匹配，而不是静默失效', () => {
  const c = cfg({ rules: [rule({ type: 'prefix', pattern: 'https://cdn.manga.com/img/' })] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  assert.match(pac.find(...browserUrl('https://cdn.manga.com/img/1.jpg')), /^PROXY /);
  assert.equal(pac.find(...browserUrl('https://other.com/img/1.jpg')), 'DIRECT');
  // http 下路径可见，仍然精确
  assert.equal(pac.find(...browserUrl('http://cdn.manga.com/other/1.jpg')), 'DIRECT',
    'http 请求能看到路径，就该按路径精确判断');
});

test('wildcard 规则在 HTTPS 下退化成域名通配', () => {
  const c = cfg({ rules: [rule({ type: 'wildcard', pattern: 'https://*.manga.com/img/*.jpg' })] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  assert.match(pac.find(...browserUrl('https://cdn1.manga.com/img/9.jpg')), /^PROXY /);
  assert.match(pac.find(...browserUrl('https://cdn2.manga.com/anything')), /^PROXY /,
    'HTTPS 下路径不可见，只能按域名放行');
  assert.equal(pac.find(...browserUrl('https://elsewhere.com/img/9.jpg')), 'DIRECT');
});

test('只约束域名的正则在 HTTPS 下依然有效', () => {
  const c = cfg({ rules: [rule({ type: 'regex', pattern: '^https?://(img|cdn)\\d*\\.' })] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  assert.match(pac.find(...browserUrl('https://cdn7.manga.com/a/1.jpg')), /^PROXY /);
  assert.equal(pac.find(...browserUrl('https://www.manga.com/a/1.jpg')), 'DIRECT');
});

test('退化只在 HTTPS 下发生，不会把 http 的精确规则也放宽', () => {
  const c = cfg({ rules: [rule({ type: 'exact', pattern: 'http://m.com/1.jpg' })] });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));
  assert.match(pac.find(...browserUrl('http://m.com/1.jpg')), /^PROXY /);
  assert.equal(pac.find(...browserUrl('http://m.com/2.jpg')), 'DIRECT');
});

test('JS 侧的 matchPacUrl 与 PAC 的判定逐条一致', () => {
  const rules = [
    rule({ id: 'r_host', type: 'host', pattern: 'manga.com' }),
    rule({ id: 'r_pre', type: 'prefix', pattern: 'https://pic.example.com/img/' }),
    rule({ id: 'r_wild', type: 'wildcard', pattern: 'https://*.wild.com/*.jpg' }),
    rule({ id: 'r_rx', type: 'regex', pattern: '\\.png$' }),
  ];
  const c = cfg({ rules });
  const pac = loadPac(generatePac(c, { startIndex: 0 }));

  for (const url of [
    'https://cdn.manga.com/1.jpg',
    'https://pic.example.com/img/1.jpg',
    'https://pic.example.com/other/1.jpg',
    'https://a.wild.com/x.jpg',
    'https://nope.com/x.png',
    'http://nope.com/x.png',
    'http://plain.com/x.gif',
  ]) {
    const viaPac = pac.find(...browserUrl(url)) !== 'DIRECT';
    const viaJs = matchPacUrl(url, rules) !== null;
    assert.equal(viaJs, viaPac, `${url} 两侧结论必须一致（JS=${viaJs} PAC=${viaPac}）`);
  }
});
