/**
 * 兜底代理的解析与校验。
 *
 * 这一层要挡住的，正是 1.4.x 兜底图片代理栽过的那个跟头：把一个 HTTP 正向代理填进
 * `?url=` 模板框，`validateTemplate()` 的三项检查（有占位符、能被 new URL 解析、
 * 协议是 http(s)）全过，于是开关保持开启、界面不给任何提示，只在真的用到时每次 400。
 *
 * 所以这里的用例大半是「看起来对、其实用不了」的输入 —— 它们必须被认出来并给出中文原因。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFallbackProxy,
  fallbackProxyToken,
  fallbackProxyWarnings,
  emptyFallbackProxy,
} from '../src/lib/fallback-proxy.js';

// ---------------------------------------------------------------- 解析

test('标准写法解析出协议、地址与端口', () => {
  const got = parseFallbackProxy('http://10.0.0.3:37581');
  assert.equal(got.ok, true);
  assert.deepEqual(
    { protocol: got.value.protocol, host: got.value.host, port: got.value.port },
    { protocol: 'http', host: '10.0.0.3', port: 37581 },
  );
  assert.equal(got.value.raw, 'http://10.0.0.3:37581', '原文要留着，设置页要回显');
});

test('没写 scheme 时按 http 处理 —— 与节点的填写语法保持一致', () => {
  const got = parseFallbackProxy('10.0.0.3:37581');
  assert.equal(got.ok, true);
  assert.equal(got.value.protocol, 'http');
  assert.equal(got.value.port, 37581);
});

test('https 代理与缺省端口', () => {
  assert.equal(parseFallbackProxy('https://proxy.lan').value.port, 443);
  assert.equal(parseFallbackProxy('http://proxy.lan').value.port, 80);
});

test('地址里的凭据被解出来并还原百分号编码', () => {
  const got = parseFallbackProxy('https://u:p%40ss@proxy.lan:8443');
  assert.equal(got.value.username, 'u');
  assert.equal(got.value.password, 'p@ss', '不还原的话密码是错的，而表现只是「反复弹认证框」');
});

test('IPv6 字面量能解析', () => {
  const got = parseFallbackProxy('http://[::1]:8080');
  assert.equal(got.ok, true);
  assert.equal(got.value.host, '::1', '存的时候不带方括号，进 PAC 时再补');
});

test('两端空白去掉 —— 从别处粘过来最常见的就是多一个空格', () => {
  assert.equal(parseFallbackProxy('  http://10.0.0.3:37581  ').value.raw, 'http://10.0.0.3:37581');
});

// ---------------------------------------------------------------- 拒绝

test('带路径或查询串一律拒绝，并点破它是 1.4.x 的改写型模板', () => {
  // 这是本文件存在的首要理由：`http://10.0.0.3:37581/?url={url}` 看起来完全合法，
  // 但它是「改写型图片服务」的写法，填给正向代理只会每次 400
  for (const raw of [
    'http://10.0.0.3:37581/?url={url}',
    'https://wsrv.nl/?url={url}',
    'http://10.0.0.3:37581/proxy',
  ]) {
    const got = parseFallbackProxy(raw);
    assert.equal(got.ok, false, `${raw} 不该被接受`);
    assert.match(got.reason, /路径|查询串/, `原因要说清楚：${got.reason}`);
  }
});

test('不支持的协议被认出来并说明只支持 HTTP/HTTPS', () => {
  for (const raw of ['socks5://10.0.0.3:1080', 'vless://x@10.0.0.3:443', 'trojan://p@h:443']) {
    const got = parseFallbackProxy(raw);
    assert.equal(got.ok, false, raw);
    assert.match(got.reason, /HTTP\/HTTPS/);
  }
});

test('端口越界、缺主机名、含空格一律拒绝', () => {
  assert.equal(parseFallbackProxy('http://10.0.0.3:99999').ok, false);
  assert.equal(parseFallbackProxy('http://10.0.0.3:0').ok, false);
  assert.equal(parseFallbackProxy('http://:37581').ok, false);
  assert.equal(parseFallbackProxy('not a url').ok, false);
});

test('空输入给出的是「请填写」而不是一句技术错误', () => {
  for (const raw of ['', '   ', null, undefined, 42]) {
    const got = parseFallbackProxy(raw);
    assert.equal(got.ok, false);
    assert.match(got.reason, /请填写/);
  }
});

// ---------------------------------------------------------------- PAC token

test('token 与节点用的是同一套格式化 —— 兜底代理不是节点，但写法必须一模一样', () => {
  const fp = { ...parseFallbackProxy('http://10.0.0.3:37581').value, enabled: true };
  assert.equal(fallbackProxyToken(fp), 'PROXY 10.0.0.3:37581');
});

test('https 代理在 PAC 里是 HTTPS 关键字，不是 PROXY', () => {
  const fp = { ...parseFallbackProxy('https://proxy.lan:8443').value, enabled: true };
  assert.equal(fallbackProxyToken(fp), 'HTTPS proxy.lan:8443');
});

test('IPv6 进 PAC 时补方括号，否则端口分不出来', () => {
  const fp = { ...parseFallbackProxy('http://[::1]:8080').value, enabled: true };
  assert.equal(fallbackProxyToken(fp), 'PROXY [::1]:8080');
});

test('中文域名转 Punycode —— 一个非 ASCII 字节就会让整份 PAC 被拒收', () => {
  const fp = { ...parseFallbackProxy('http://代理.com:8080').value, enabled: true };
  const token = fallbackProxyToken(fp);
  assert.match(token, /^PROXY xn--/, `实际：${token}`);
});

test('没启用时拿不到 token —— 这是「兜底这条路可用吗」的唯一判定点', () => {
  const fp = parseFallbackProxy('http://10.0.0.3:37581').value;
  assert.equal(fp.enabled, false, '解析产出的默认是未启用');
  assert.equal(fallbackProxyToken(fp), null);
  assert.equal(fallbackProxyToken({ ...fp, enabled: true }), 'PROXY 10.0.0.3:37581');
});

test('残缺对象不会让 token 抛异常', () => {
  for (const bad of [null, undefined, {}, { enabled: true }, { enabled: true, host: 'h' }]) {
    assert.equal(fallbackProxyToken(bad), null, JSON.stringify(bad));
  }
});

test('emptyFallbackProxy 每次都是新对象且默认关闭', () => {
  const a = emptyFallbackProxy();
  const b = emptyFallbackProxy();
  assert.notEqual(a, b);
  assert.equal(a.enabled, false);
  assert.equal(fallbackProxyToken(a), null);
});

// ---------------------------------------------------------------- 警示语

test('HTTPS 代理配了账号时提醒认证依赖服务器支持', () => {
  const fp = { ...parseFallbackProxy('https://u:p@proxy.lan:8443').value, enabled: true };
  assert.equal(fallbackProxyWarnings(fp).length, 1);
  assert.match(fallbackProxyWarnings(fp)[0], /Basic\/Digest/);
});

test('没填地址时不产出任何警示 —— 那是「还没配」，不是「配错了」', () => {
  assert.deepEqual(fallbackProxyWarnings(emptyFallbackProxy()), []);
  assert.deepEqual(fallbackProxyWarnings(null), []);
});
