import test from 'node:test';
import assert from 'node:assert/strict';
import { createRule, validateRule, compileRule, matchUrl, wildcardToRegexSource, makeRuleId, ruleWarnings } from '../src/lib/rule-matcher.js';

const R = (o) => createRule({ type: 'exact', pattern: '', enabled: true, ...o });

test('makeRuleId 稳定且格式正确', () => {
  assert.match(makeRuleId('regex|x'), /^r_[0-9a-f]{8}$/);
  assert.equal(makeRuleId('regex|x'), makeRuleId('regex|x'));
});

test('exact 精确匹配整条 URL', () => {
  const c = compileRule(R({ type: 'exact', pattern: 'https://cdn.manga.com/1.jpg' }));
  assert.equal(c.test('https://cdn.manga.com/1.jpg', 'cdn.manga.com'), true);
  assert.equal(c.test('https://cdn.manga.com/1.jpg?x=1', 'cdn.manga.com'), false);
  assert.equal(c.test('https://cdn.manga.com/2.jpg', 'cdn.manga.com'), false);
});

test('prefix 前缀匹配', () => {
  const c = compileRule(R({ type: 'prefix', pattern: 'https://cdn.manga.com/img/' }));
  assert.equal(c.test('https://cdn.manga.com/img/1.jpg', 'cdn.manga.com'), true);
  assert.equal(c.test('https://cdn.manga.com/other/1.jpg', 'cdn.manga.com'), false);
});

test('host 匹配域名及其子域', () => {
  const c = compileRule(R({ type: 'host', pattern: 'manga.com' }));
  assert.equal(c.test('https://cdn.manga.com/1.jpg', 'cdn.manga.com'), true);
  assert.equal(c.test('https://manga.com/1.jpg', 'manga.com'), true);
  assert.equal(c.test('https://notmanga.com/1.jpg', 'notmanga.com'), false, '不能被 notmanga.com 误命中');
  assert.equal(c.test('https://other.com/1.jpg', 'other.com'), false);
});

test('wildcard 通配符匹配', () => {
  const c = compileRule(R({ type: 'wildcard', pattern: 'https://*.manga.com/img/*.jpg' }));
  assert.equal(c.test('https://cdn1.manga.com/img/001.jpg', 'cdn1.manga.com'), true);
  assert.equal(c.test('https://cdn1.manga.com/img/001.png', 'cdn1.manga.com'), false);
});

test('wildcardToRegexSource 转义正则元字符', () => {
  const src = wildcardToRegexSource('a.b/c?d*e');
  assert.equal(new RegExp(src).test('a.b/c?dXXXe'), true);
  assert.equal(new RegExp(src).test('aXb/c?dXe'), false, '. 必须被转义成字面量');
});

test('regex 正则匹配', () => {
  const c = compileRule(R({ type: 'regex', pattern: '^https://cdn\\d+\\.manga\\.com/.*\\.(jpg|webp)$' }));
  assert.equal(c.test('https://cdn12.manga.com/a/b.webp', 'cdn12.manga.com'), true);
  assert.equal(c.test('https://cdn12.manga.com/a/b.gif', 'cdn12.manga.com'), false);
});

test('validateRule 拒绝非法正则与空 pattern', () => {
  assert.equal(validateRule(R({ type: 'regex', pattern: '^ok$' })).ok, true);
  const bad = validateRule(R({ type: 'regex', pattern: '([' }));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /正则/);
  assert.equal(validateRule(R({ type: 'exact', pattern: '' })).ok, false);
  assert.equal(validateRule({ type: 'nope', pattern: 'x' }).ok, false);
});

test('matchUrl 跳过禁用的规则', () => {
  const rules = [
    R({ type: 'host', pattern: 'manga.com', enabled: false, name: '停用' }),
    R({ type: 'host', pattern: 'manga.com', enabled: true, name: '生效' }),
  ];
  assert.equal(matchUrl('https://manga.com/1.jpg', rules).name, '生效');
});

test('matchUrl 返回第一条命中的规则（顺序即优先级）', () => {
  const rules = [
    R({ type: 'regex', pattern: '\\.jpg$', name: 'A' }),
    R({ type: 'host', pattern: 'manga.com', name: 'B' }),
  ];
  assert.equal(matchUrl('https://manga.com/1.jpg', rules).name, 'A');
});

test('matchUrl 无命中返回 null', () => {
  assert.equal(matchUrl('https://example.com/', [R({ type: 'host', pattern: 'manga.com' })]), null);
});

test('matchUrl 忽略非法规则而不抛异常', () => {
  const rules = [{ id: 'r_00000000', name: 'bad', type: 'regex', pattern: '([', enabled: true, nodeIds: [] },
    R({ type: 'host', pattern: 'manga.com', name: 'ok' })];
  assert.equal(matchUrl('https://manga.com/x', rules).name, 'ok');
});

test('matchUrl 能处理无法解析的 URL 而不抛异常', () => {
  assert.equal(matchUrl('不是一个URL', [R({ type: 'host', pattern: 'manga.com' })]), null);
});

test('createRule 填充默认值', () => {
  const r = createRule({ type: 'host', pattern: 'a.com' });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.nodeIds, []);
  assert.equal(r.name, 'a.com');
  assert.match(r.id, /^r_[0-9a-f]{8}$/);
});

test('规则可绑定节点子集', () => {
  const c = compileRule(R({ type: 'host', pattern: 'a.com', nodeIds: ['n_1', 'n_2'] }));
  assert.deepEqual(c.nodeIds, ['n_1', 'n_2']);
});

// ---------------------------------------------------------------- 中文域名

test('host 型规则的中文域名被转成 Punycode 后匹配', () => {
  // 浏览器给出的 hostname 已是 xn-- 形式，不转码这条规则就永远命中不了
  const c = compileRule(R({ type: 'host', pattern: '漫画.com' }));
  assert.equal(c.test('https://xn--qex62k.com/1.jpg', 'xn--qex62k.com'), true);
  assert.equal(c.test('https://cdn.xn--qex62k.com/1.jpg', 'cdn.xn--qex62k.com'), true, '子域应命中');
  assert.equal(c.test('https://other.com/1.jpg', 'other.com'), false);
});

test('host 型规则不传 host 时也能从 URL 推出 Punycode 主机名', () => {
  const c = compileRule(R({ type: 'host', pattern: '漫画.com' }));
  assert.equal(c.test('https://漫画.com/1.jpg'), true, 'hostOf 会把中文域名解析成 xn-- 形式');
});

test('matchUrl 对中文域名与 PAC 给出一致结论', () => {
  const rules = [R({ type: 'host', pattern: '漫画.com', name: 'IDN' })];
  assert.equal(matchUrl('https://xn--qex62k.com/1.jpg', rules)?.name, 'IDN');
  assert.equal(matchUrl('https://漫画.com/1.jpg', rules)?.name, 'IDN');
});

test('ruleWarnings 对 URL 形态里的非 ASCII 给出提示', () => {
  // 这类规则合法、也进得了 PAC，但域名段已被浏览器转码，多半永远不命中 ——
  // 静默失效比报错更难排查，所以必须显式提示
  for (const type of ['exact', 'prefix', 'wildcard', 'regex']) {
    const warnings = ruleWarnings(R({ type, pattern: 'https://漫画.com/a.jpg' }));
    assert.equal(warnings.length, 1, `${type} 应给出一条提示`);
    assert.match(warnings[0], /Punycode/);
  }
});

test('ruleWarnings 对 host 型的中文域名不提示（我们已自动转码）', () => {
  assert.deepEqual(ruleWarnings(R({ type: 'host', pattern: '漫画.com' })), []);
});

test('ruleWarnings 对纯 ASCII 规则不提示', () => {
  assert.deepEqual(ruleWarnings(R({ type: 'regex', pattern: '\.(jpe?g|png)$' })), []);
  assert.deepEqual(ruleWarnings(R({ type: 'host', pattern: 'manga.com' })), []);
});

test('ruleWarnings 对非法规则不提示（合法性由 validateRule 负责）', () => {
  assert.deepEqual(ruleWarnings({ type: 'regex', pattern: '([漫画' }), []);
  assert.deepEqual(ruleWarnings(null), []);
});
