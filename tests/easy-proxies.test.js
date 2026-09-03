/**
 * Easy Proxies 自动拉取的纯逻辑层测试。
 *
 * 覆盖三件事：
 *   1. selectBestNodes —— 从 /api/nodes 响应里挑「最优」节点的规则
 *   2. toProxyNodes / mergeEasyProxiesNodes —— 转成扩展节点并只替换自动管理的部分
 *   3. settings.easyProxies 的默认值与规范化
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectBestNodes,
  toProxyNodes,
  toLabelProxyNodes,
  mergeEasyProxiesNodes,
  isEasyProxiesNode,
} from '../src/lib/easy-proxies.js';
import { normalizeConfig } from '../src/lib/schema.js';

/** easy_proxies /api/nodes 里的一条节点快照 */
function epNode(overrides = {}) {
  return {
    tag: 'hk-01',
    name: '香港01 [1×] - Lv.3',
    port: 24001,
    available: true,
    blacklisted: false,
    last_latency_ms: 167,
    region: 'hk',
    country: 'China',
    ...overrides,
  };
}

// ---------------------------------------------------------------- 选优

test('selectBestNodes 只选可用且未拉黑的节点', () => {
  const payload = {
    nodes: [
      epNode({ tag: 'down', available: false }),
      epNode({ tag: 'banned', blacklisted: true }),
      epNode({ tag: 'ok' }),
    ],
  };
  const out = selectBestNodes(payload, 10);
  assert.deepEqual(out.map((n) => n.tag), ['ok']);
});

test('selectBestNodes 按最近探测延迟升序取前 N 条', () => {
  const payload = {
    nodes: [
      epNode({ tag: 'slow', last_latency_ms: 500 }),
      epNode({ tag: 'fast', last_latency_ms: 100 }),
      epNode({ tag: 'mid', last_latency_ms: 300 }),
    ],
  };
  const out = selectBestNodes(payload, 2);
  assert.deepEqual(out.map((n) => n.tag), ['fast', 'mid']);
});

test('selectBestNodes 可用节点不足 N 条时按实际数量返回', () => {
  const payload = { nodes: [epNode({ tag: 'only' })] };
  const out = selectBestNodes(payload, 15);
  assert.equal(out.length, 1);
});

test('selectBestNodes 缺失或非法延迟排在最后', () => {
  const payload = {
    nodes: [
      epNode({ tag: 'ok', last_latency_ms: 200 }),
      epNode({ tag: 'null-latency', last_latency_ms: null }),
      epNode({ tag: 'negative', last_latency_ms: -1 }),
      epNode({ tag: 'missing', last_latency_ms: undefined }),
    ],
  };
  const out = selectBestNodes(payload, 10);
  // 延迟缺失的节点彼此之间保持输入顺序（稳定排序）
  assert.deepEqual(out.map((n) => n.tag), ['ok', 'null-latency', 'negative', 'missing']);
});

test('selectBestNodes 忽略没有本地端口的节点', () => {
  const payload = { nodes: [epNode({ tag: 'no-port', port: 0 }), epNode({ tag: 'ok' })] };
  const out = selectBestNodes(payload, 10);
  assert.deepEqual(out.map((n) => n.tag), ['ok']);
});

// ---------------------------------------------------------------- 构造与合并

test('toProxyNodes 生成扩展节点形状并打上 easyProxies 标记', () => {
  const nodes = toProxyNodes(
    selectBestNodes({ nodes: [epNode({ tag: 'hk-01', name: '香港01', port: 24001, last_latency_ms: 167 })] }, 15),
    '10.0.0.3',
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].protocol, 'http');
  assert.equal(nodes[0].host, '10.0.0.3');
  assert.equal(nodes[0].port, 24001);
  assert.equal(nodes[0].name, '香港01');
  assert.equal(nodes[0].meta.easyProxies, true);
  assert.equal(nodes[0].meta.tag, 'hk-01');
  assert.equal(nodes[0].meta.latencyMs, 167);
});

test('toProxyNodes 没有名称时用 host:port 兜底', () => {
  const nodes = toProxyNodes([epNode({ name: '', port: 24002 })], '10.0.0.3');
  assert.equal(nodes[0].name, '10.0.0.3:24002');
});

test('toLabelProxyNodes 把本地标签服务返回的节点转成扩展节点形状', () => {
  const nodes = toLabelProxyNodes([
    {
      name: '香港01',
      host: '127.0.0.2',
      port: 8080,
      upstreamHost: '10.0.0.3',
      upstreamPort: 24001,
    },
    {
      name: '香港02',
      host: '127.0.0.3',
      port: 8080,
      upstreamHost: '10.0.0.3',
      upstreamPort: 24002,
    },
  ]);

  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].protocol, 'http');
  assert.equal(nodes[0].host, '127.0.0.2');
  assert.equal(nodes[0].port, 8080);
  assert.equal(nodes[0].name, '香港01');
  assert.equal(nodes[0].raw, 'http://127.0.0.2:8080#香港01');
  assert.equal(nodes[0].meta.easyProxies, true);
  assert.deepEqual(nodes[0].meta.labelProxy, {
    upstreamHost: '10.0.0.3',
    upstreamPort: 24001,
  });
  assert.equal(nodes[1].host, '127.0.0.3');
});

test('toLabelProxyNodes 没有名称时用本地 host:port 兜底', () => {
  const nodes = toLabelProxyNodes([
    { name: '', host: '127.0.0.2', port: 8080, upstreamHost: '10.0.0.3', upstreamPort: 24001 },
  ]);
  assert.equal(nodes[0].name, '127.0.0.2:8080');
});

test('mergeEasyProxiesNodes 只替换旧的自动节点，保留手写节点', () => {
  const current = [
    { id: 'n_user1', name: '我的节点', protocol: 'http', host: '10.0.0.3', port: 3000, meta: {} },
    { id: 'n_old1', name: '旧自动', protocol: 'http', host: '10.0.0.3', port: 24001, meta: { easyProxies: true } },
  ];
  const incoming = toProxyNodes([epNode({ port: 24001 })], '10.0.0.3');
  const { nodes, added, removed } = mergeEasyProxiesNodes(current, incoming);

  assert.equal(removed, 1, '旧自动节点应被移除');
  assert.equal(added, 1);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.some((n) => n.id === 'n_user1'), '手写节点必须保留');
  assert.ok(nodes.some((n) => isEasyProxiesNode(n) && n.port === 24001));
});

test('mergeEasyProxiesNodes 与手写节点同地址时去重，不重复加入', () => {
  const current = [
    { id: 'n_user1', name: '手写', protocol: 'http', host: '10.0.0.3', port: 24001, meta: {} },
  ];
  const incoming = toProxyNodes([epNode({ port: 24001 })], '10.0.0.3');
  const { nodes, added } = mergeEasyProxiesNodes(current, incoming);

  assert.equal(added, 0);
  assert.equal(nodes.length, 1, '同地址的手写节点优先，自动节点不应重复加入');
});

test('mergeEasyProxiesNodes 输出可被 normalizeConfig 接受', () => {
  const current = [];
  const incoming = toProxyNodes([epNode({ name: '香港01', port: 24001 })], '10.0.0.3');
  const merged = mergeEasyProxiesNodes(current, incoming);

  const cfg = normalizeConfig({ nodes: merged.nodes });
  assert.equal(cfg.nodes.length, 1);
  assert.match(cfg.nodes[0].id, /^n_/);
  assert.equal(cfg.nodes[0].meta.easyProxies, true);
  assert.equal(cfg.nodes[0].health.status, 'unknown', '健康状态应由扩展自己的测速决定');
});

test('mergeEasyProxiesNodes 能用手写同地址规则替换旧的同 IP 自动节点为标签节点', () => {
  const current = [
    { id: 'n_user1', name: '手写', protocol: 'http', host: '10.0.0.3', port: 3000, meta: {} },
    { id: 'n_old1', name: '旧自动', protocol: 'http', host: '10.0.0.3', port: 24001, meta: { easyProxies: true } },
  ];
  const incoming = toLabelProxyNodes([
    { name: '新标签', host: '127.0.0.2', port: 8080, upstreamHost: '10.0.0.3', upstreamPort: 24001 },
  ]);
  const { nodes, removed, added } = mergeEasyProxiesNodes(current, incoming);

  assert.equal(removed, 1);
  assert.equal(added, 1);
  assert.equal(nodes.length, 2);
  const auto = nodes.find((n) => isEasyProxiesNode(n));
  assert.equal(auto.host, '127.0.0.2');
  assert.equal(auto.meta.labelProxy.upstreamPort, 24001);
});

// ---------------------------------------------------------------- 设置项

test('默认配置带 easyProxies 设置且默认关闭', () => {
  const ep = normalizeConfig({}).settings.easyProxies;
  assert.deepEqual(ep, {
    enabled: false,
    baseUrl: 'http://10.0.0.3:19090',
    password: '',
    maxNodes: 15,
    intervalMinutes: 60,
    labelServiceUrl: '',
    labelServiceToken: '',
    lastSyncAt: null,
    lastSyncCount: null,
    lastSyncError: null,
  });
});

test('easyProxies 设置被规范化：数量与间隔夹进合法区间，非法地址回落默认', () => {
  const ep = normalizeConfig({
    settings: {
      easyProxies: {
        enabled: true,
        baseUrl: 'ftp://bad',
        password: 'secret',
        maxNodes: 9999,
        intervalMinutes: -5,
        labelServiceUrl: 'ftp://bad',
        labelServiceToken: 'token-123',
        lastSyncAt: 1234,
        lastSyncCount: 7,
        lastSyncError: 'boom',
      },
    },
  }).settings.easyProxies;

  assert.equal(ep.enabled, true);
  assert.equal(ep.baseUrl, 'http://10.0.0.3:19090', '非法地址应回落默认');
  assert.equal(ep.password, 'secret');
  assert.equal(ep.maxNodes, 500, '数量上限与节点容量上限一致');
  assert.equal(ep.intervalMinutes, 0, '负数应夹到 0（仅启动时/手动）');
  assert.equal(ep.labelServiceUrl, '', '非法服务地址应回落为空');
  assert.equal(ep.labelServiceToken, 'token-123');
  assert.equal(ep.lastSyncAt, 1234);
  assert.equal(ep.lastSyncCount, 7);
  assert.equal(ep.lastSyncError, 'boom');
});

test('easyProxies 管理地址没写 scheme 时自动补 http://', () => {
  const ep = normalizeConfig({
    settings: { easyProxies: { enabled: true, baseUrl: '10.0.0.3:19090' } },
  }).settings.easyProxies;
  assert.equal(ep.baseUrl, 'http://10.0.0.3:19090');
});

test('easyProxies 本地标签服务地址没写 scheme 时自动补 http://', () => {
  const ep = normalizeConfig({
    settings: { easyProxies: { labelServiceUrl: '127.0.0.1:19191' } },
  }).settings.easyProxies;
  assert.equal(ep.labelServiceUrl, 'http://127.0.0.1:19191');
});

test('easyProxies 设置本身是垃圾时回落到默认值', () => {
  for (const easyProxies of [undefined, null, 'x', 42, []]) {
    const ep = normalizeConfig({ settings: { easyProxies } }).settings.easyProxies;
    assert.equal(ep.enabled, false, `${JSON.stringify(easyProxies)}`);
    assert.equal(ep.maxNodes, 15);
  }
});
