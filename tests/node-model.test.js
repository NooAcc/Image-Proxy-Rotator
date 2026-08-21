import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeNodeId, createNode, isSupported, isSelectable, pacToken,
  nodeWarnings, dedupeNodes, defaultNodeName, unsupportedNodes, protocolLabel,
} from '../src/lib/node-model.js';
import { UNSUPPORTED_PROTOCOL_MESSAGE } from '../src/lib/constants.js';

const parsed = (o) => ({ protocol: 'http', host: 'a.com', port: 8080, username: '', password: '', name: '', raw: '', meta: {}, ...o });

test('makeNodeId 稳定且格式正确', () => {
  const a = makeNodeId('http|a.com|8080');
  assert.match(a, /^n_[0-9a-f]{8}$/);
  assert.equal(a, makeNodeId('http|a.com|8080'));
  assert.notEqual(a, makeNodeId('http|a.com|8081'));
});

test('createNode 补齐全部默认字段', () => {
  const n = createNode(parsed(), []);
  assert.match(n.id, /^n_[0-9a-f]{8}$/);
  assert.equal(n.enabled, true);
  assert.equal(n.autoDisabled, false);
  assert.equal(n.health.status, 'unknown');
  assert.equal(n.health.latencyMs, null);
  assert.equal(n.health.consecutiveFailures, 0);
  assert.equal(n.name, 'http-a.com:8080', '无 fragment 时生成默认名');
  assert.equal('bridge' in n, false, '不再有本地网桥字段');
});

test('createNode 保留已有名字，并对重名追加序号', () => {
  const first = createNode(parsed({ name: '香港' }), []);
  const second = createNode(parsed({ name: '香港', host: 'b.com' }), [first]);
  assert.equal(first.name, '香港');
  assert.equal(second.name, '香港 (2)');
});

// ---------- 可用性判定：只有 http / https ----------

test('isSupported 只认 http 与 https', () => {
  assert.equal(isSupported(parsed({ protocol: 'http' })), true);
  assert.equal(isSupported(parsed({ protocol: 'https' })), true);
  for (const protocol of ['socks4', 'socks5', 'vless', 'hysteria2', 'trojan', 'ss', 'vmess', 'unknown']) {
    assert.equal(isSupported(parsed({ protocol })), false, `${protocol} 不应被认为可用`);
  }
});

test('pacToken 只为 http / https 产出，其余一律 null', () => {
  assert.equal(pacToken(createNode(parsed({ protocol: 'http' }), [])), 'PROXY a.com:8080');
  assert.equal(pacToken(createNode(parsed({ protocol: 'https' }), [])), 'HTTPS a.com:8080');
  for (const protocol of ['socks4', 'socks5', 'vless', 'hysteria2', 'trojan', 'ss']) {
    const node = createNode(parsed({ protocol }), []);
    assert.equal(pacToken(node), null, `${protocol} 不得产出 PAC token`);
  }
});

test('pacToken 对 IPv6 主机加方括号', () => {
  const n = createNode(parsed({ host: '2001:db8::1', protocol: 'https' }), []);
  assert.equal(pacToken(n), 'HTTPS [2001:db8::1]:8080');
});

test('isSelectable 排除手动禁用与自动禁用', () => {
  const n = createNode(parsed(), []);
  assert.equal(isSelectable(n), true);
  assert.equal(isSelectable({ ...n, enabled: false }), false);
  assert.equal(isSelectable({ ...n, autoDisabled: true }), false);
});

test('isSelectable 排除所有不支持的协议，即使它是启用状态', () => {
  for (const protocol of ['socks5', 'vless', 'hysteria2', 'trojan', 'ss', 'unknown']) {
    const node = createNode(parsed({ protocol }), []);
    assert.equal(node.enabled, true, '前提：节点处于启用状态');
    assert.equal(isSelectable(node), false, `${protocol} 绝不能进入轮询池`);
  }
});

// ---------- 提示语 ----------

test('nodeWarnings 对不支持的协议给出规定的中文提示', () => {
  for (const protocol of ['socks5', 'socks4', 'vless', 'hysteria2', 'trojan', 'ss']) {
    const w = nodeWarnings(createNode(parsed({ protocol }), []));
    assert.equal(w.length, 1, `${protocol} 应只有一条提示`);
    assert.ok(w[0].includes(UNSUPPORTED_PROTOCOL_MESSAGE), `${protocol} 的提示必须包含规定文案，实际：${w[0]}`);
    assert.ok(w[0].includes(protocolLabel(protocol)), '提示里要写明是哪种类型');
  }
});

test('nodeWarnings 对带账号密码的 SOCKS5 同样只报「不支持」', () => {
  const w = nodeWarnings(createNode(parsed({ protocol: 'socks5', username: 'u', password: 'p' }), []));
  assert.equal(w.length, 1);
  assert.ok(w[0].includes(UNSUPPORTED_PROTOCOL_MESSAGE));
});

test('nodeWarnings 对普通 http 节点为空', () => {
  assert.deepEqual(nodeWarnings(createNode(parsed(), [])), []);
});

test('protocolLabel 给出可读名称', () => {
  assert.equal(protocolLabel('http'), 'HTTP');
  assert.equal(protocolLabel('socks5'), 'SOCKS5');
  assert.equal(protocolLabel('hysteria2'), 'Hysteria2');
  assert.equal(protocolLabel('unknown'), '未知协议');
});

// ---------- 集合操作 ----------

test('unsupportedNodes 挑出所有不支持的节点', () => {
  const nodes = [
    createNode(parsed({ protocol: 'http', host: 'a' }), []),
    createNode(parsed({ protocol: 'socks5', host: 'b' }), []),
    createNode(parsed({ protocol: 'https', host: 'c' }), []),
    createNode(parsed({ protocol: 'vless', host: 'd' }), []),
  ];
  assert.deepEqual(unsupportedNodes(nodes).map((n) => n.host), ['b', 'd']);
});

test('dedupeNodes 按 protocol+host+port 去重，保留先出现的', () => {
  const a = createNode(parsed({ name: '先' }), []);
  const b = createNode(parsed({ name: '后' }), []);
  const out = dedupeNodes([a, b, createNode(parsed({ host: 'z.com' }), [])]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, '先');
});

test('defaultNodeName 覆盖各协议', () => {
  assert.equal(defaultNodeName(parsed({ protocol: 'https', host: 'x', port: 1 })), 'https-x:1');
});
