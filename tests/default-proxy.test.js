/**
 * 默认代理 —— 规则**没**命中时走谁。
 *
 * 这一项修的是一个静默故障：注入 PAC 会替换浏览器整份代理配置（含「使用系统代理」），
 * 于是规则外的流量从「经本机代理客户端出去」变成真·直连，表现是图片站正常、其余网站
 * 全部 ERR_CONNECTION_TIMED_OUT。所以本文件的重点不在解析（那和兜底代理共用一份），
 * 而在**「没配 / 配坏时必须回落到与从前完全一致的行为」**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDefaultProxy, parseDefaultProxy, defaultProxyToken, defaultProxyWarnings,
} from '../src/lib/default-proxy.js';

const node = (o = {}) => ({ id: 'n_1', name: '节点一', host: '10.0.0.3', port: 24014, ...o });

test('默认代理默认关闭 —— 新增这一项不能悄悄改变现有用户的出口', () => {
  const dp = emptyDefaultProxy();
  assert.equal(dp.enabled, false);
  assert.equal(defaultProxyToken(dp), null, '关着就必须没有 token，PAC 才会回落到 DIRECT');
});

test('emptyDefaultProxy 每次都是新对象', () => {
  assert.notEqual(emptyDefaultProxy(), emptyDefaultProxy());
});

test('本机客户端的常见写法都能解析', () => {
  for (const raw of ['http://127.0.0.1:7897', '127.0.0.1:7897', 'HTTP://127.0.0.1:7897']) {
    const got = parseDefaultProxy(raw);
    assert.equal(got.ok, true, `应当能解析：${raw}`);
    assert.equal(got.value.host, '127.0.0.1');
    assert.equal(got.value.port, 7897);
    assert.equal(got.value.protocol, 'http');
  }
});

test('解析出来的对象默认是关着的 —— 启用与否由用户勾选，不由地址决定', () => {
  assert.equal(parseDefaultProxy('127.0.0.1:7897').value.enabled, false);
});

test('账号密码写在地址里也认', () => {
  const got = parseDefaultProxy('https://u:p%40ss@proxy.lan:8443');
  assert.equal(got.ok, true);
  assert.equal(got.value.username, 'u');
  assert.equal(got.value.password, 'p@ss', '百分号编码要还原');
  assert.equal(got.value.protocol, 'https');
});

test('SOCKS5 之类填进来要说清楚不支持，而不是含糊拒绝', () => {
  const got = parseDefaultProxy('socks5://127.0.0.1:7890');
  assert.equal(got.ok, false);
  assert.match(got.reason, /HTTP\/HTTPS/);
});

test('填了路径要拒绝，并提示这里该填什么', () => {
  const got = parseDefaultProxy('http://127.0.0.1:7897/proxy.pac');
  assert.equal(got.ok, false);
  assert.match(got.reason, /路径|查询串/);
  assert.match(got.reason, /默认代理/, `措辞要说的是这个框：${got.reason}`);
});

test('空地址的提示说的是默认代理，不是兜底代理', () => {
  const got = parseDefaultProxy('   ');
  assert.equal(got.ok, false);
  assert.match(got.reason, /默认代理/);
});

test('端口越界与缺主机名都拒绝', () => {
  assert.equal(parseDefaultProxy('http://127.0.0.1:99999').ok, false);
  assert.equal(parseDefaultProxy('http://:7897').ok, false);
});

test('启用且合法时给出与节点逐字一致的 token', () => {
  const dp = { ...parseDefaultProxy('127.0.0.1:7897').value, enabled: true };
  assert.equal(defaultProxyToken(dp), 'PROXY 127.0.0.1:7897');
});

test('HTTPS 默认代理用 HTTPS 关键字', () => {
  const dp = { ...parseDefaultProxy('https://proxy.lan:8443').value, enabled: true };
  assert.equal(defaultProxyToken(dp), 'HTTPS proxy.lan:8443');
});

test('启用了但地址不可用时仍然没有 token —— 绝不能变成半开状态', () => {
  assert.equal(defaultProxyToken({ enabled: true, protocol: 'socks5', host: 'x', port: 1 }), null);
  assert.equal(defaultProxyToken({ enabled: true, protocol: 'http', host: '', port: 1 }), null);
  assert.equal(defaultProxyToken({ enabled: true, protocol: 'http', host: 'x', port: 0 }), null);
});

test('残缺对象不会让 token 抛异常', () => {
  assert.equal(defaultProxyToken(null), null);
  assert.equal(defaultProxyToken(undefined), null);
  assert.equal(defaultProxyToken({}), null);
});

test('IPv6 字面量带方括号，中文域名转 Punycode', () => {
  const v6 = { ...parseDefaultProxy('http://[::1]:7897').value, enabled: true };
  assert.equal(defaultProxyToken(v6), 'PROXY [::1]:7897');
  const idn = { enabled: true, protocol: 'http', host: '图床.com', port: 8080 };
  assert.match(defaultProxyToken(idn), /^PROXY xn--/);
});

test('默认代理填成轮询节点时给出警示 —— 那等于把日常流量压到该节点的出口上', () => {
  const dp = { ...parseDefaultProxy('10.0.0.3:24014').value, enabled: true };
  const warnings = defaultProxyWarnings(dp, [node()]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /节点一/);
});

test('端口不同就不是同一个节点，不该误报', () => {
  const dp = { ...parseDefaultProxy('10.0.0.3:7897').value, enabled: true };
  assert.deepEqual(defaultProxyWarnings(dp, [node()]), []);
});

test('HTTPS 默认代理配了账号时提醒认证依赖服务器支持', () => {
  const dp = { ...parseDefaultProxy('https://u:p@proxy.lan:8443').value, enabled: true };
  assert.match(defaultProxyWarnings(dp, []).join(' '), /Basic\/Digest/);
});

test('没填地址时不产出任何警示 —— 那是「还没配」，不是「配错了」', () => {
  assert.deepEqual(defaultProxyWarnings(emptyDefaultProxy(), [node()]), []);
  assert.deepEqual(defaultProxyWarnings(null), []);
});
