import test from 'node:test';
import assert from 'node:assert/strict';
import { selectablePool, createRoundRobin, hashPick, distribute } from '../src/lib/scheduler.js';

const N = (id, o = {}) => ({
  id, name: id, protocol: 'http', host: id, port: 80, username: '', password: '',
  enabled: true, autoDisabled: false, raw: '', meta: {},
  health: { status: 'ok', latencyMs: 10, lastCheckedAt: 0, consecutiveFailures: 0, lastError: null, egressIp: null },
  ...o,
});

test('selectablePool 过滤手动禁用与自动禁用的节点', () => {
  const nodes = [N('a'), N('b', { enabled: false }), N('c', { autoDisabled: true }), N('d')];
  assert.deepEqual(selectablePool(nodes, []).map((n) => n.id), ['a', 'd']);
});

test('selectablePool 过滤所有非 HTTP/HTTPS 协议的节点', () => {
  const nodes = [
    N('http1', { protocol: 'http' }),
    N('socks', { protocol: 'socks5' }),
    N('vless', { protocol: 'vless' }),
    N('https1', { protocol: 'https' }),
    N('hy2', { protocol: 'hysteria2' }),
  ];
  assert.deepEqual(selectablePool(nodes, []).map((n) => n.id), ['http1', 'https1']);
});

test('selectablePool 在规则绑定了不支持的节点时回落到可用节点', () => {
  const nodes = [N('http1', { protocol: 'http' }), N('socks', { protocol: 'socks5' })];
  assert.deepEqual(selectablePool(nodes, ['socks']).map((n) => n.id), ['http1']);
});

test('selectablePool 按 nodeIds 取子集', () => {
  const nodes = [N('a'), N('b'), N('c')];
  assert.deepEqual(selectablePool(nodes, ['b', 'c']).map((n) => n.id), ['b', 'c']);
});

test('selectablePool 的子集若全不可用则回落到全部可用节点', () => {
  const nodes = [N('a'), N('b', { enabled: false })];
  assert.deepEqual(selectablePool(nodes, ['b']).map((n) => n.id), ['a']);
});

test('selectablePool 全部不可用时返回空数组', () => {
  assert.deepEqual(selectablePool([N('a', { enabled: false })], []), []);
});

test('轮询依次返回每个节点并循环', () => {
  const pool = [N('a'), N('b'), N('c')];
  const rr = createRoundRobin(0);
  assert.deepEqual([1, 2, 3, 4, 5].map(() => rr.next(pool).id), ['a', 'b', 'c', 'a', 'b']);
});

test('轮询在池为空时返回 null', () => {
  assert.equal(createRoundRobin(0).next([]), null);
});

test('轮询在池长度变化后不越界', () => {
  const rr = createRoundRobin(0);
  rr.next([N('a'), N('b'), N('c')]);
  rr.next([N('a'), N('b'), N('c')]);
  rr.next([N('a'), N('b'), N('c')]);
  const picked = rr.next([N('a')]);
  assert.equal(picked.id, 'a');
});

test('轮询可从指定下标起步（避免每次都从 0 号节点开始）', () => {
  const pool = [N('a'), N('b'), N('c')];
  assert.equal(createRoundRobin(2).next(pool).id, 'c');
});

test('100 个请求在 4 个节点上分布均匀（每个 25 次）', () => {
  const pool = [N('a'), N('b'), N('c'), N('d')];
  const counts = {};
  const rr = createRoundRobin(0);
  for (let i = 0; i < 100; i++) {
    const n = rr.next(pool);
    counts[n.id] = (counts[n.id] || 0) + 1;
  }
  assert.deepEqual(counts, { a: 25, b: 25, c: 25, d: 25 });
});

test('hashPick 同 key 稳定命中同一节点', () => {
  const pool = [N('a'), N('b'), N('c')];
  const first = hashPick(pool, 'https://x/1.jpg').id;
  assert.equal(hashPick(pool, 'https://x/1.jpg').id, first);
});

test('hashPick 不同 key 会打散到多个节点', () => {
  const pool = [N('a'), N('b'), N('c')];
  const ids = new Set(Array.from({ length: 60 }, (_, i) => hashPick(pool, 'u' + i).id));
  assert.ok(ids.size >= 2, '至少命中 2 个节点');
});

test('hashPick 空池返回 null', () => {
  assert.equal(hashPick([], 'k'), null);
});

test('distribute 生成预览序列', () => {
  const pool = [N('a'), N('b')];
  assert.deepEqual(distribute(pool, 4, 'round-robin').map((n) => n.id), ['a', 'b', 'a', 'b']);
  assert.equal(distribute(pool, 4, 'hash').length, 4);
});
