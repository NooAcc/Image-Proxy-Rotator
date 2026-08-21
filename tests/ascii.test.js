/**
 * ASCII 安全化的契约。
 *
 * 这一层存在的唯一理由：chrome.proxy 的 `pacScript.data` 只接受纯 ASCII。
 * 出现任何一个非 ASCII 字节，chrome.proxy.settings.set 就整体抛
 * 「'pacScript.data' supports only ASCII code(encode URLs in Punycode format).」，
 * PAC 一条也注入不进去 —— 而浏览器照旧直连，于是表现成「扩展安静地什么都没做」。
 *
 * 所以这里的断言都是硬要求，不是风格偏好。
 *
 * 本文件里的特殊字符一律写成 \u / \x 转义而不是字面量：U+2028、DEL 这类字符在编辑器里
 * 完全看不见，写成字面量的测试等于把意图藏起来，改的人根本不知道自己动了什么。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAscii, escapeNonAscii, asciiJson, toAsciiHost } from '../src/lib/ascii.js';

// ---------------------------------------------------------------- isAscii

test('isAscii 只认 0x00-0x7F', () => {
  assert.equal(isAscii('PROXY 1.2.3.4:8080; DIRECT'), true);
  assert.equal(isAscii(''), true);
  assert.equal(isAscii(null), true, '空值当空串处理，不该抛');
  assert.equal(isAscii('漫画'), false);
  assert.equal(isAscii('a\u2028b'), false, 'U+2028 行分隔符会破坏 JS 源码，必须算不合格');
  assert.equal(isAscii('café'), false);
});

// ---------------------------------------------------------------- escapeNonAscii

test('escapeNonAscii 产物一定是纯 ASCII', () => {
  const inputs = ['漫画.com', 'café', '\u2028\u2029', 'ドメイン', '🎉', 'a\x7fb'];
  for (const input of inputs) {
    assert.equal(isAscii(escapeNonAscii(input)), true, `${JSON.stringify(input)} 转义后仍含非 ASCII`);
  }
});

test('escapeNonAscii 只动非可打印 ASCII，其余原样保留', () => {
  assert.equal(escapeNonAscii('PROXY a.px:8080'), 'PROXY a.px:8080');
  assert.equal(escapeNonAscii('\\.(jpe?g|png)$'), '\\.(jpe?g|png)$');
  assert.equal(escapeNonAscii('漫'), '\\u6f2b');
  assert.equal(escapeNonAscii('a漫b'), 'a\\u6f2bb');
});

test('escapeNonAscii 用四位小写十六进制，位数不足补零', () => {
  assert.equal(escapeNonAscii('é'), '\\u00e9');
  assert.equal(escapeNonAscii('\u2028'), '\\u2028');
  assert.equal(escapeNonAscii('\x7f'), '\\u007f', 'DEL 虽是 ASCII，但当控制字符嵌进源码不安全');
});

// ---------------------------------------------------------------- asciiJson

test('asciiJson 是纯 ASCII，且 JSON.parse 回来与原值完全一致', () => {
  const value = {
    pat: '漫画.com',
    list: ['café', 'ドメイン', '🎉'],
    '中文键': 1,
    nested: { sep: '\u2028' },
  };
  const text = asciiJson(value);
  assert.equal(isAscii(text), true, 'asciiJson 的产物必须纯 ASCII');
  assert.deepEqual(JSON.parse(text), value, '转义不得改变语义');
});

test('asciiJson 产物能当 JS 字面量直接求值', () => {
  const value = { pat: '漫画*', bypass: ['*.测试.cn'] };
  // PAC 生成器就是这么用的：把它拼进 `var PP = <这里>;`
  const evaluated = new Function(`return ${asciiJson(value)};`)();
  assert.deepEqual(evaluated, value);
});

test('asciiJson 正确处理会破坏字符串的字符', () => {
  const value = { q: '"双引号"', b: 'back\\slash', n: 'line\nbreak', t: 'tab\there' };
  assert.equal(isAscii(asciiJson(value)), true);
  assert.deepEqual(JSON.parse(asciiJson(value)), value);
});

test('asciiJson 处理孤立代理项时不产生非法 JSON', () => {
  const text = asciiJson({ lone: '\ud800' });
  assert.equal(isAscii(text), true);
  assert.doesNotThrow(() => JSON.parse(text));
});

// ---------------------------------------------------------------- toAsciiHost

test('toAsciiHost 把中文域名转成 Punycode', () => {
  assert.equal(toAsciiHost('漫画.com'), 'xn--qex62k.com');
  assert.equal(toAsciiHost('ドメイン.example'), 'xn--eckwd4c7c.example');
  assert.equal(toAsciiHost('例え.テスト'), 'xn--r8jz45g.xn--zckzah');
});

test('toAsciiHost 保留通配符', () => {
  // 绕过列表走 shExpMatch，通配符是语义的一部分，转码时绝不能吃掉
  assert.equal(toAsciiHost('*.漫画.com'), '*.xn--qex62k.com');
  assert.equal(toAsciiHost('漫画.*.com'), 'xn--qex62k.*.com');
});

test('toAsciiHost 对已是 ASCII 的输入原样返回（含大小写）', () => {
  // 不动既有配置：ASCII 域名连大小写都不许改，否则等于悄悄改了用户的规则
  assert.equal(toAsciiHost('manga.com'), 'manga.com');
  assert.equal(toAsciiHost('CDN.Manga.COM'), 'CDN.Manga.COM');
  assert.equal(toAsciiHost('*.manga.com'), '*.manga.com');
  assert.equal(toAsciiHost('1.2.3.4'), '1.2.3.4');
  assert.equal(toAsciiHost('[::1]'), '[::1]');
  assert.equal(toAsciiHost('xn--qex62k.com'), 'xn--qex62k.com');
});

test('toAsciiHost 对无法安全转换的输入原样返回', () => {
  // 宁可原样交出去（ASCII 底线由 escapeNonAscii 兜住），也不猜用户想要什么
  assert.equal(toAsciiHost('漫画.com/path'), '漫画.com/path', '带路径说明用户填错了，不该悄悄截断');
  assert.equal(toAsciiHost('漫画.com:8080'), '漫画.com:8080', '带端口同理');
  assert.equal(toAsciiHost(''), '');
  assert.equal(toAsciiHost(null), '');
  assert.equal(toAsciiHost(undefined), '');
});

test('toAsciiHost 去掉首尾空白', () => {
  assert.equal(toAsciiHost('  manga.com  '), 'manga.com');
  assert.equal(toAsciiHost('  漫画.com '), 'xn--qex62k.com');
});
