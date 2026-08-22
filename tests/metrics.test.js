/**
 * 统计计数器的契约。
 *
 * 三条设计约束，测试逐条守：
 *   1. **体积与运行时长无关。** 只存整数计数器，不存任何一条请求明细。占用只随
 *      节点数/规则数增长，不随时间增长（见 docs/ARCHITECTURE.md 决策 D14）。
 *   2. **分母诚实。** 节点被删掉后，它的历史用量并入 retired 而不是凭空消失 ——
 *      否则「各节点占比」加起来不等于 100%，用户会以为统计错了。
 *   3. **除零不产生 NaN。** 没有任何请求时成功率是「无」（null），不是 0% 也不是 NaN。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_CAP,
  emptyMetrics,
  normalizeMetrics,
  noteRequest,
  noteProbe,
  noteApply,
  noteRetry,
  noteFallbackImage,
  pruneMetrics,
  summarizeMetrics,
} from '../src/lib/metrics.js';

const nodeOf = (id, name = id) => ({ id, name });
const ruleOf = (id, o = {}) => ({ id, name: id, type: 'host', pattern: `${id}.com`, ...o });

// ---------------------------------------------------------------- 初始形态

test('emptyMetrics 每次都是新对象，字段齐全且全为零', () => {
  const a = emptyMetrics();
  const b = emptyMetrics();
  assert.notEqual(a, b, '不能共享引用，否则两处计数会互相污染');
  assert.equal(a.since, null);
  assert.deepEqual(a.requests, { total: 0, ok: 0, fail: 0, latencySum: 0, latencyCount: 0, unattributed: 0, blind: 0, viaNodeIp: 0 });
  assert.deepEqual(a.perNode, {});
  assert.deepEqual(a.perRule, {});
  assert.deepEqual(a.retry, { attempted: 0, recovered: 0, exhausted: 0, skipped: 0 });
  assert.deepEqual(a.fallbackImage, { used: 0, ok: 0, fail: 0 });
  assert.deepEqual(a.retired, { nodeUsed: 0, nodeOk: 0, nodeFail: 0, ruleHits: 0 });
  assert.deepEqual(a.probe, { ok: 0, fail: 0, lastAt: null });
  assert.deepEqual(a.apply, { ok: 0, fail: 0, lastAt: null, lastError: null });
});

// ---------------------------------------------------------------- 请求计数

test('noteRequest 累加总量、成败与耗时', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, latencyMs: 100, nodeId: 'n_a', ruleId: 'r_1', at: 1000 });
  noteRequest(m, { ok: false, latencyMs: 300, nodeId: 'n_a', ruleId: 'r_1', at: 2000 });

  assert.equal(m.requests.total, 2);
  assert.equal(m.requests.ok, 1);
  assert.equal(m.requests.fail, 1);
  assert.equal(m.requests.latencySum, 400);
  assert.equal(m.requests.latencyCount, 2);
  assert.deepEqual(m.perNode.n_a, { used: 2, ok: 1, fail: 1 });
  assert.deepEqual(m.perRule.r_1, { hits: 2 });
});

test('since 记录第一次计数的时刻，之后不再变', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, at: 5000 });
  noteRequest(m, { ok: true, at: 9000 });
  assert.equal(m.since, 5000);
});

test('无法归因到节点的请求单独计数，不污染 perNode', () => {
  // 按出口 IP 归因本身会漏（代理没转发、IP 未知），必须诚实地单列出来，
  // 而不是丢掉或硬塞给某个节点
  const m = emptyMetrics();
  noteRequest(m, { ok: true, nodeId: null, ruleId: 'r_1', at: 1 });
  assert.equal(m.requests.total, 1);
  assert.equal(m.requests.unattributed, 1);
  assert.deepEqual(m.perNode, {});
  assert.deepEqual(m.perRule.r_1, { hits: 1 });
});

test('耗时缺失或非法时只跳过耗时，其余照记', () => {
  const m = emptyMetrics();
  for (const latencyMs of [undefined, null, NaN, Infinity, -5, '100']) {
    noteRequest(m, { ok: true, latencyMs, nodeId: 'n_a', at: 1 });
  }
  assert.equal(m.requests.total, 6);
  assert.equal(m.requests.latencyCount, 0, '非法耗时不得进入平均值');
  assert.equal(m.requests.latencySum, 0);
  assert.equal(m.perNode.n_a.used, 6);
});

test('耗时为 0 是合法值', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, latencyMs: 0, at: 1 });
  assert.equal(m.requests.latencyCount, 1);
});

// ---------------------------------------------------------------- 测速与注入

test('noteProbe 分别累加成败并记下最近一次时间', () => {
  const m = emptyMetrics();
  noteProbe(m, { ok: true, at: 100 });
  noteProbe(m, { ok: false, at: 200 });
  noteProbe(m, { ok: false, at: 300 });
  assert.deepEqual(m.probe, { ok: 1, fail: 2, lastAt: 300 });
});

test('noteApply 记住最近一次失败原因，成功后清掉', () => {
  const m = emptyMetrics();
  noteApply(m, { ok: false, error: '控制权被占用', at: 100 });
  assert.equal(m.apply.fail, 1);
  assert.equal(m.apply.lastError, '控制权被占用');

  noteApply(m, { ok: true, at: 200 });
  assert.equal(m.apply.ok, 1);
  assert.equal(m.apply.lastError, null, '注入成功后旧的失败原因必须清掉，否则界面会一直挂着过期错误');
  assert.equal(m.apply.lastAt, 200);
});

test('注入与测速也会点亮 since', () => {
  const m = emptyMetrics();
  noteApply(m, { ok: true, at: 700 });
  assert.equal(m.since, 700);
});

// ---------------------------------------------------------------- 剪枝

test('pruneMetrics 把已删除节点/规则的历史量并入 retired', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, nodeId: 'n_keep', ruleId: 'r_keep', at: 1 });
  noteRequest(m, { ok: false, nodeId: 'n_gone', ruleId: 'r_gone', at: 2 });
  noteRequest(m, { ok: true, nodeId: 'n_gone', ruleId: 'r_gone', at: 3 });

  pruneMetrics(m, { nodeIds: ['n_keep'], ruleIds: ['r_keep'] });

  assert.deepEqual(Object.keys(m.perNode), ['n_keep'], '孤儿键必须清掉，否则会随时间无界增长');
  assert.deepEqual(Object.keys(m.perRule), ['r_keep']);
  assert.equal(m.retired.nodeUsed, 2);
  assert.equal(m.retired.nodeOk, 1);
  assert.equal(m.retired.nodeFail, 1);
  assert.equal(m.retired.ruleHits, 2);
});

test('pruneMetrics 不改变请求总量', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, nodeId: 'n_gone', ruleId: 'r_gone', at: 1 });
  const before = { ...m.requests };
  pruneMetrics(m, { nodeIds: [], ruleIds: [] });
  assert.deepEqual(m.requests, before);
});

test('pruneMetrics 拿不到 id 列表时什么都不删', () => {
  // 宁可暂时多留几个键，也不能因为一次读配置失败就把用户的统计抹掉
  const m = emptyMetrics();
  noteRequest(m, { ok: true, nodeId: 'n_a', ruleId: 'r_1', at: 1 });
  pruneMetrics(m, {});
  pruneMetrics(m, { nodeIds: null, ruleIds: undefined });
  assert.deepEqual(Object.keys(m.perNode), ['n_a']);
  assert.deepEqual(Object.keys(m.perRule), ['r_1']);
});

test('perNode 超过硬上限时丢弃用量最少的，并入 retired', () => {
  const m = emptyMetrics();
  const ids = [];
  for (let i = 0; i < MAP_CAP + 10; i++) {
    const id = `n_${i}`;
    ids.push(id);
    // 用量随序号递增，于是最该被丢的是最前面那几个
    for (let k = 0; k <= i; k++) noteRequest(m, { ok: true, nodeId: id, at: 1 });
  }
  pruneMetrics(m, { nodeIds: ids, ruleIds: [] });

  assert.equal(Object.keys(m.perNode).length, MAP_CAP, '必须收敛到硬上限');
  assert.ok(!('n_0' in m.perNode), '用量最少的应被丢弃');
  assert.ok(`n_${MAP_CAP + 9}` in m.perNode, '用量最多的必须留下');
  assert.ok(m.retired.nodeUsed > 0, '被丢弃的量要进 retired，别让占比分母缩水');
});

// ---------------------------------------------------------------- 汇总

test('summarizeMetrics 空数据时给出 null 而不是 NaN', () => {
  const view = summarizeMetrics(emptyMetrics(), { nodes: [], rules: [] });
  assert.equal(view.requests.total, 0);
  assert.equal(view.requests.successRate, null);
  assert.equal(view.requests.avgLatencyMs, null);
  assert.equal(view.probe.successRate, null);
  assert.deepEqual(view.nodes.rows, []);
  assert.deepEqual(view.rules.rows, []);
});

test('summarizeMetrics 算出成功率与平均耗时', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, latencyMs: 100, at: 1 });
  noteRequest(m, { ok: true, latencyMs: 200, at: 2 });
  noteRequest(m, { ok: false, latencyMs: 300, at: 3 });

  const view = summarizeMetrics(m, { nodes: [], rules: [] });
  assert.equal(view.requests.successRate, 66.7, '保留一位小数');
  assert.equal(view.requests.avgLatencyMs, 200);
});

test('summarizeMetrics 列出全部当前节点，没用过的也给 0 行', () => {
  // 「这个节点一次都没被用到」是重要信息，不该因为没有计数就整行消失
  const m = emptyMetrics();
  noteRequest(m, { ok: true, nodeId: 'n_a', at: 1 });

  const view = summarizeMetrics(m, { nodes: [nodeOf('n_a', 'A'), nodeOf('n_b', 'B')], rules: [] });
  assert.equal(view.nodes.rows.length, 2);
  const b = view.nodes.rows.find((r) => r.id === 'n_b');
  assert.deepEqual({ used: b.used, share: b.share, exists: b.exists }, { used: 0, share: 0, exists: true });
});

test('summarizeMetrics 按用量降序排列，并标出已删除的节点', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, nodeId: 'n_a', at: 1 });
  noteRequest(m, { ok: true, nodeId: 'n_gone', at: 2 });
  noteRequest(m, { ok: true, nodeId: 'n_gone', at: 3 });

  const view = summarizeMetrics(m, { nodes: [nodeOf('n_a', 'A')], rules: [] });
  assert.deepEqual(view.nodes.rows.map((r) => r.id), ['n_gone', 'n_a'], '用得多的排前面');
  assert.equal(view.nodes.rows[0].exists, false, '配置里已经没有它了，界面要标出来');
  assert.equal(view.nodes.rows[0].name, 'n_gone', '拿不到名字就退回 id，不能显示 undefined');
});

test('节点占比的分母包含已删除节点的历史量，加总为 100%', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, nodeId: 'n_a', at: 1 });
  noteRequest(m, { ok: true, nodeId: 'n_b', at: 2 });
  noteRequest(m, { ok: true, nodeId: 'n_gone', at: 3 });
  noteRequest(m, { ok: true, nodeId: 'n_gone', at: 4 });
  pruneMetrics(m, { nodeIds: ['n_a', 'n_b'], ruleIds: [] });

  const view = summarizeMetrics(m, { nodes: [nodeOf('n_a'), nodeOf('n_b')], rules: [] });
  assert.equal(view.nodes.totalUsed, 4, '分母必须算上已删除节点的 2 次');
  assert.equal(view.nodes.retiredUsed, 2);
  const shown = view.nodes.rows.reduce((sum, r) => sum + r.share, 0);
  assert.equal(Math.round(shown + 50), 100, '两个各 25% + 已删除的 50% = 100%');
});

test('summarizeMetrics 带出规则的类型与内容，便于直接渲染表格', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, ruleId: 'r_hit', at: 1 });

  const rules = [ruleOf('r_hit', { name: '图床', type: 'regex', pattern: '\\.jpg$' }), ruleOf('r_cold')];
  const view = summarizeMetrics(m, { nodes: [], rules });

  const hit = view.rules.rows.find((r) => r.id === 'r_hit');
  assert.deepEqual(
    { name: hit.name, type: hit.type, pattern: hit.pattern, hits: hit.hits, share: hit.share },
    { name: '图床', type: 'regex', pattern: '\\.jpg$', hits: 1, share: 100 },
  );
  assert.equal(view.rules.rows.find((r) => r.id === 'r_cold').hits, 0, '从未命中的规则要露出来');
});

test('summarizeMetrics 不改动传入的计数器', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, nodeId: 'n_a', ruleId: 'r_1', at: 1 });
  const snapshot = structuredClone(m);
  summarizeMetrics(m, { nodes: [nodeOf('n_a')], rules: [ruleOf('r_1')] });
  assert.deepEqual(m, snapshot);
});

// ---------------------------------------------------------------- 读回容错

test('normalizeMetrics 能吃下任何垃圾输入', () => {
  for (const raw of [null, undefined, 0, 'x', [], { requests: 'nope' }, { perNode: 5 }]) {
    const m = normalizeMetrics(raw);
    assert.equal(m.requests.total, 0, `${JSON.stringify(raw)} 应退化为空计数器`);
    assert.deepEqual(m.perNode, {});
  }
});

test('normalizeMetrics 保留合法字段并补齐缺失字段', () => {
  const m = normalizeMetrics({
    since: 42,
    requests: { total: 7, ok: 5 },
    perNode: { n_a: { used: 3, ok: 3 } },
    perRule: { r_1: { hits: 2 } },
    probe: { ok: 1 },
  });
  assert.equal(m.since, 42);
  assert.equal(m.requests.total, 7);
  assert.equal(m.requests.ok, 5);
  assert.equal(m.requests.fail, 0, '缺失的字段补零');
  assert.deepEqual(m.perNode.n_a, { used: 3, ok: 3, fail: 0 });
  assert.deepEqual(m.perRule.r_1, { hits: 2 });
  assert.equal(m.probe.fail, 0);
});

test('normalizeMetrics 丢掉负数与非有限值，不让脏数据传染统计', () => {
  const m = normalizeMetrics({
    requests: { total: -5, ok: NaN, fail: Infinity, latencySum: 1.7 },
    perNode: { n_a: { used: -1 } },
  });
  assert.equal(m.requests.total, 0);
  assert.equal(m.requests.ok, 0);
  assert.equal(m.requests.fail, 0);
  assert.equal(m.requests.latencySum, 2, '小数取整');
  assert.equal(m.perNode.n_a.used, 0);
});

test('normalizeMetrics 之后立刻能继续计数', () => {
  const m = normalizeMetrics({ requests: { total: 3 } });
  noteRequest(m, { ok: true, nodeId: 'n_a', at: 9 });
  assert.equal(m.requests.total, 4);
});

// ---------------------------------------------------------------- 重试与兜底

test('noteRetry 四个口径互不重叠', () => {
  const m = emptyMetrics();
  noteRetry(m, { kind: 'attempted', at: 1000 });
  noteRetry(m, { kind: 'attempted' });
  noteRetry(m, { kind: 'recovered' });
  noteRetry(m, { kind: 'exhausted' });
  noteRetry(m, { kind: 'skipped' });

  assert.deepEqual(m.retry, { attempted: 2, recovered: 1, exhausted: 1, skipped: 1 });
  assert.equal(m.since, 1000, '第一次重试判定也该点亮 since');
});

test('noteRetry 对未知口径与脏输入无动于衷，不会凭空长出字段', () => {
  const m = emptyMetrics();
  for (const kind of ['nonsense', 'constructor', '__proto__', 'toString', undefined, 42]) {
    noteRetry(m, { kind });
  }
  noteRetry(m);
  assert.deepEqual(m.retry, { attempted: 0, recovered: 0, exhausted: 0, skipped: 0 });
});

test('兜底的 used 与 ok/fail 是两个时刻，可以先记 used 后补成败', () => {
  const m = emptyMetrics();
  noteFallbackImage(m, { used: true, at: 5000 });
  noteFallbackImage(m, { used: true });
  assert.deepEqual(m.fallbackImage, { used: 2, ok: 0, fail: 0 }, '还没加载完时只有 used');

  noteFallbackImage(m, { ok: true });
  noteFallbackImage(m, { ok: false });
  assert.deepEqual(m.fallbackImage, { used: 2, ok: 1, fail: 1 });
});

test('兜底的 ok 缺省是 null，不会被当成 false 记成失败', () => {
  // {used:true} 只表示「改写了地址」，此刻结果还不知道。把缺省当失败会让
  // 兜底成功率永远显示 0%
  const m = emptyMetrics();
  noteFallbackImage(m, { used: true });
  assert.equal(m.fallbackImage.fail, 0);
});

test('normalizeMetrics 读回新计数器，缺字段补零、脏值归零', () => {
  const m = normalizeMetrics({
    retry: { attempted: 7, recovered: '3', exhausted: -1, skipped: NaN },
    fallbackImage: { used: 2.6, ok: 1 },
  });
  assert.deepEqual(m.retry, { attempted: 7, recovered: 3, exhausted: 0, skipped: 0 });
  assert.deepEqual(m.fallbackImage, { used: 3, ok: 1, fail: 0 });
});

test('旧版存储里没有这两个桶时读回全零，而不是 undefined', () => {
  // 用户从旧版本升上来时存储里只有 requests / perNode，读回来必须是能直接继续累加的形状
  const m = normalizeMetrics({ requests: { total: 5, ok: 5 } });
  assert.deepEqual(m.retry, { attempted: 0, recovered: 0, exhausted: 0, skipped: 0 });
  assert.deepEqual(m.fallbackImage, { used: 0, ok: 0, fail: 0 });
});

test('summarizeMetrics 给出重试救回率与兜底成功率；分母为 0 时是「无」', () => {
  const empty = summarizeMetrics(emptyMetrics());
  assert.equal(empty.retry.recoveryRate, null, '一次都没重试过时不该显示 0%');
  assert.equal(empty.fallbackImage.successRate, null);

  const m = emptyMetrics();
  for (let i = 0; i < 4; i++) noteRetry(m, { kind: 'attempted' });
  noteRetry(m, { kind: 'recovered' });
  noteRetry(m, { kind: 'exhausted' });
  noteFallbackImage(m, { used: true });
  noteFallbackImage(m, { ok: true });
  noteFallbackImage(m, { ok: false });

  const view = summarizeMetrics(m);
  assert.equal(view.retry.attempted, 4);
  assert.equal(view.retry.recoveryRate, 25);
  assert.equal(view.retry.exhausted, 1);
  assert.equal(view.fallbackImage.used, 1);
  assert.equal(view.fallbackImage.successRate, 50);
});

test('剪枝不碰重试与兜底 —— 它们不是按实体分桶的', () => {
  const m = emptyMetrics();
  noteRetry(m, { kind: 'attempted' });
  noteFallbackImage(m, { used: true });
  pruneMetrics(m, { nodeIds: [], ruleIds: [] });
  assert.equal(m.retry.attempted, 1);
  assert.equal(m.fallbackImage.used, 1);
});
