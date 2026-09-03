/**
 * 深度重试站点清单的行为契约。
 *
 * 这一层的价值全在「挡住什么」上：`chrome.scripting.registerContentScripts()` 对
 * 非法 pattern 是整批拒绝的，一条写错十条一起不注册，而失败之后页面照常加载、
 * 补丁只是不存在 —— 又一次「勾了但没用」的静默失效。所以下面每一条用例都在钉
 * 「这种写法必须被摘出来，并且带着能读的原因」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSite, deepRetryPatterns, deepRetryActive, unseenAdvice, DEEP_RETRY_SITE_CAP,
} from '../src/lib/deep-retry.js';

// ---------------------------------------------------------------- 裸域名

test('裸域名自动展开成覆盖子域名的 match pattern', () => {
  assert.deepEqual(normalizeSite('nhentai.net'), { ok: true, pattern: '*://*.nhentai.net/*' });
});

test('裸域名大小写归一', () => {
  assert.deepEqual(normalizeSite('  NHentai.NET  '), { ok: true, pattern: '*://*.nhentai.net/*' });
});

test('自己写了 *. 前缀的裸域名不再套一层', () => {
  assert.deepEqual(normalizeSite('*.nhentai.net'), { ok: true, pattern: '*://*.nhentai.net/*' });
});

test('单段主机名不接受 —— 多半是手误', () => {
  const result = normalizeSite('localhost');
  assert.equal(result.ok, false);
  assert.match(result.reason, /合法域名/);
});

// ---------------------------------------------------------------- 完整 match pattern

test('完整 match pattern 原样通过', () => {
  assert.deepEqual(
    normalizeSite('https://noymanga.com/read/*'),
    { ok: true, pattern: 'https://noymanga.com/read/*' },
  );
});

test('省略路径时补 /* —— chrome 自己不会补，会直接报错', () => {
  assert.deepEqual(normalizeSite('https://nhentai.net'), { ok: true, pattern: 'https://nhentai.net/*' });
});

test('scheme 通配可用', () => {
  assert.deepEqual(normalizeSite('*://*.example.com/*'), { ok: true, pattern: '*://*.example.com/*' });
});

// ---------------------------------------------------------------- 必须挡住的写法

test('拒绝 <all_urls>：那正是本设计被接受的前提', () => {
  const result = normalizeSite('<all_urls>');
  assert.equal(result.ok, false);
  assert.match(result.reason, /all_urls/);
});

test('拒绝主机名写成 * —— 等于给所有网站打补丁', () => {
  const result = normalizeSite('*://*/*');
  assert.equal(result.ok, false);
  assert.match(result.reason, /所有网站/);
});

test('拒绝 file / ftp 之类的 scheme', () => {
  const result = normalizeSite('file:///C:/x/*');
  assert.equal(result.ok, false);
  assert.match(result.reason, /scheme/);
});

test('拒绝带端口的主机名 —— match pattern 不支持端口', () => {
  const result = normalizeSite('https://example.com:8443/*');
  assert.equal(result.ok, false);
  assert.match(result.reason, /端口/);
});

test('拒绝 * 出现在主机名中间', () => {
  assert.equal(normalizeSite('https://img*.example.com/*').ok, false);
  assert.equal(normalizeSite('https://*.*.example.com/*').ok, false);
});

test('拒绝空值', () => {
  assert.equal(normalizeSite('').ok, false);
  assert.equal(normalizeSite(null).ok, false);
  assert.equal(normalizeSite(undefined).ok, false);
});

test('裸域名后面带路径要提示改用完整写法', () => {
  const result = normalizeSite('nhentai.net/g/*');
  assert.equal(result.ok, false);
  assert.match(result.reason, /完整形式/);
});

// ---------------------------------------------------------------- 整份清单

test('合法与非法混在一起时，合法的照常注册、非法的带原因单列', () => {
  const { patterns, skipped } = deepRetryPatterns([
    'nhentai.net',
    '<all_urls>',
    'https://noymanga.com/read/*',
    'img*.bad.com',
  ]);
  assert.deepEqual(patterns, ['*://*.nhentai.net/*', 'https://noymanga.com/read/*']);
  assert.equal(skipped.length, 2);
  assert.deepEqual(skipped.map((s) => s.raw), ['<all_urls>', 'img*.bad.com']);
  for (const item of skipped) assert.ok(item.reason.length > 0, '每条被摘出来的都必须有原因');
});

test('等价写法去重 —— 否则「注册了几条」这个数字对不上', () => {
  const { patterns } = deepRetryPatterns(['nhentai.net', '*.nhentai.net', 'NHENTAI.NET']);
  assert.deepEqual(patterns, ['*://*.nhentai.net/*']);
});

test('超出上限的部分被摘出来，而不是安静截断', () => {
  const many = Array.from({ length: DEEP_RETRY_SITE_CAP + 3 }, (_, i) => `site${i}.example.com`);
  const { patterns, skipped } = deepRetryPatterns(many);
  assert.equal(patterns.length, DEEP_RETRY_SITE_CAP);
  assert.equal(skipped.length, 3);
  for (const item of skipped) assert.match(item.reason, /上限/);
});

test('非数组输入不抛异常', () => {
  assert.deepEqual(deepRetryPatterns(null), { patterns: [], skipped: [] });
  assert.deepEqual(deepRetryPatterns('nhentai.net'), { patterns: [], skipped: [] });
});

// ---------------------------------------------------------------- 生效判定

test('开关开着但一条可用模式都没有，不算生效', () => {
  assert.equal(deepRetryActive({ deepRetry: { enabled: true, sites: [] } }), false);
  assert.equal(deepRetryActive({ deepRetry: { enabled: true, sites: ['<all_urls>'] } }), false);
});

test('开关关着时，有可用模式也不算生效', () => {
  assert.equal(deepRetryActive({ deepRetry: { enabled: false, sites: ['nhentai.net'] } }), false);
});

test('开关开着且有可用模式才算生效', () => {
  assert.equal(deepRetryActive({ deepRetry: { enabled: true, sites: ['nhentai.net'] } }), true);
});

test('缺字段不抛异常', () => {
  assert.equal(deepRetryActive(undefined), false);
  assert.equal(deepRetryActive({}), false);
});

// ---------------------------------------------------------------- 页面没捕获的提示

test('未配置深度重试时，提示去添加站点', () => {
  const advice = unseenAdvice(
    { unseen: 3, deep: 0 },
    { deepRetry: { enabled: false, sites: [] } },
  );
  assert.equal(advice.kind, 'add');
  assert.match(advice.text, /添加/);
});

test('深度重试已配置但零介入时，不再叫人重复添加，而是提示确认补丁', () => {
  const advice = unseenAdvice(
    { unseen: 3, deep: 0 },
    { deepRetry: { enabled: true, sites: ['nhentai.net'] } },
  );
  assert.equal(advice.kind, 'not-seen');
  assert.match(advice.text, /刷新/);
  assert.doesNotMatch(advice.text, /添加/);
});

test('深度重试有介入时，说明剩下的是补丁也够不到的类型', () => {
  const advice = unseenAdvice(
    { unseen: 3, deep: 2 },
    { deepRetry: { enabled: true, sites: ['nhentai.net'] } },
  );
  assert.equal(advice.kind, 'covered');
  assert.match(advice.text, /2/);
  assert.match(advice.text, /CSS/);
});
