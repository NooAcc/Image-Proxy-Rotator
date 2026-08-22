/**
 * 兜底图片代理的模板契约。
 *
 * 这是重试链的最后一环，也是唯一会把用户的图片地址交给第三方的地方，
 * 所以两件事必须由断言把住：
 *   1. **编码正确。** `{url}` 必须是百分号编码后的形态 —— 不编码的话，原图 URL 里的
 *      `&` 会把后面的部分变成兜底服务自己的参数，取回来的是别的东西或直接 400。
 *   2. **不能自己套自己。** 兜底失败后如果又被当成一次普通失败去改写，就会套出
 *      `兜底/?url=兜底/?url=…`，无限递归。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTemplate,
  rewriteImageUrl,
  isProxiedUrl,
  templateOrigin,
} from '../src/lib/image-proxy.js';

const T = 'https://wsrv.nl/?url={url}';

// ---------------------------------------------------------------- 校验

test('合法模板：http/https + 至少一个占位符', () => {
  assert.equal(validateTemplate(T).ok, true);
  assert.equal(validateTemplate('http://p.example/img?src={raw}').ok, true);
  assert.equal(validateTemplate('https://p.example/{url}/x').ok, true);
});

test('没有占位符的模板一律拒绝', () => {
  // 否则每张图都被改写成同一个地址，表现为「所有图片变成同一张」
  const check = validateTemplate('https://wsrv.nl/');
  assert.equal(check.ok, false);
  assert.match(check.reason, /\{url\}/);
});

test('非 http/https 的模板一律拒绝', () => {
  for (const bad of ['ftp://p/{url}', 'javascript:alert(1)/{url}', 'data:text/html,{url}']) {
    assert.equal(validateTemplate(bad).ok, false, `${bad} 不该通过`);
  }
});

test('空模板与非字符串被拒绝，且不抛异常', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(validateTemplate(bad).ok, false);
  }
});

// ---------------------------------------------------------------- 改写

test('{url} 填百分号编码后的地址', () => {
  const out = rewriteImageUrl(T, 'https://cdn.manga.com/a b/001.jpg?w=1&h=2');
  assert.equal(out, `https://wsrv.nl/?url=${encodeURIComponent('https://cdn.manga.com/a b/001.jpg?w=1&h=2')}`);
  // 关键：原图的 & 必须已经变成 %26，否则 h=2 会被兜底服务当成自己的参数
  assert.ok(!out.slice(out.indexOf('url=')).includes('&'), '编码后不该再出现裸的 &');
});

test('{raw} 原样填入，供要求不编码的服务使用', () => {
  const out = rewriteImageUrl('https://p.example/?src={raw}', 'https://cdn.manga.com/001.jpg');
  assert.equal(out, 'https://p.example/?src=https://cdn.manga.com/001.jpg');
});

test('同一个占位符出现多次时全部替换', () => {
  const out = rewriteImageUrl('https://p.example/{url}?fallback={url}', 'https://a.com/1.jpg');
  const enc = encodeURIComponent('https://a.com/1.jpg');
  assert.equal(out, `https://p.example/${enc}?fallback=${enc}`);
});

test('模板非法或原图不是 http/https 时返回 null，不抛异常', () => {
  assert.equal(rewriteImageUrl('https://wsrv.nl/', 'https://a.com/1.jpg'), null);
  assert.equal(rewriteImageUrl(T, 'data:image/png;base64,AAAA'), null);
  assert.equal(rewriteImageUrl(T, ''), null);
  assert.equal(rewriteImageUrl(null, null), null);
});

// ---------------------------------------------------------------- 防自套

test('已经是兜底地址的 URL 不再改写', () => {
  const once = rewriteImageUrl(T, 'https://cdn.manga.com/001.jpg');
  assert.equal(isProxiedUrl(T, once), true);
  assert.equal(rewriteImageUrl(T, once), null, '套第二层会无限递归下去');
});

test('isProxiedUrl 只看源，不看路径 —— 兜底服务换个端点仍算它自己', () => {
  assert.equal(isProxiedUrl(T, 'https://wsrv.nl/other?x=1'), true);
  assert.equal(isProxiedUrl(T, 'https://cdn.manga.com/001.jpg'), false);
  // 模板非法时不该把任何东西判成「已代理」，否则会把正常图片挡在重试之外
  assert.equal(isProxiedUrl('https://wsrv.nl/', 'https://wsrv.nl/x'), false);
});

test('templateOrigin 给出兜底服务的源，供 UI 与绕过提示使用', () => {
  assert.equal(templateOrigin(T), 'https://wsrv.nl');
  assert.equal(templateOrigin('nonsense'), null);
});
