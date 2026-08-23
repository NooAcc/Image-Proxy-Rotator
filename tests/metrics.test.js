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
  LATENCY_BUCKETS_MS,
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
  assert.deepEqual(a.requests, {
    total: 0, ok: 0, fail: 0, latencySum: 0, latencyCount: 0,
    unattributed: 0, blind: 0, viaNodeIp: 0, cached: 0,
  });
  assert.deepEqual(a.latency, new Array(LATENCY_BUCKETS_MS.length + 1).fill(0));
  assert.deepEqual(a.perNode, {});
  assert.deepEqual(a.perRule, {});
  assert.deepEqual(a.retry, { attempted: 0, recovered: 0, exhausted: 0, skipped: 0, abandoned: 0, unseen: 0, deep: 0 });
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

test('noteRetry 七个口径互不重叠', () => {
  const m = emptyMetrics();
  noteRetry(m, { kind: 'attempted', at: 1000 });
  noteRetry(m, { kind: 'attempted' });
  noteRetry(m, { kind: 'recovered' });
  noteRetry(m, { kind: 'exhausted' });
  noteRetry(m, { kind: 'skipped' });
  noteRetry(m, { kind: 'abandoned' });
  noteRetry(m, { kind: 'unseen' });
  // deep 与上面六个是**正交**的：它数「这次是主世界补丁问的」，
  // 同一次判定既会 +1 attempted 也会 +1 deep，不该和其余口径一起对账
  noteRetry(m, { kind: 'deep' });

  assert.deepEqual(m.retry, {
    attempted: 2, recovered: 1, exhausted: 1, skipped: 1, abandoned: 1, unseen: 1, deep: 1,
  });
  assert.equal(m.since, 1000, '第一次重试判定也该点亮 since');
});

test('noteRetry 对未知口径与脏输入无动于衷，不会凭空长出字段', () => {
  const m = emptyMetrics();
  for (const kind of ['nonsense', 'constructor', '__proto__', 'toString', undefined, 42]) {
    noteRetry(m, { kind });
  }
  noteRetry(m);
  assert.deepEqual(m.retry, {
    attempted: 0, recovered: 0, exhausted: 0, skipped: 0, abandoned: 0, unseen: 0, deep: 0,
  });
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
  assert.deepEqual(m.retry, {
    attempted: 7, recovered: 3, exhausted: 0, skipped: 0, abandoned: 0, unseen: 0, deep: 0,
  });
  assert.deepEqual(m.fallbackImage, { used: 3, ok: 1, fail: 0 });
});

test('旧版存储里没有这两个桶时读回全零，而不是 undefined', () => {
  // 用户从旧版本升上来时存储里只有 requests / perNode，读回来必须是能直接继续累加的形状
  const m = normalizeMetrics({ requests: { total: 5, ok: 5 } });
  assert.deepEqual(m.retry, {
    attempted: 0, recovered: 0, exhausted: 0, skipped: 0, abandoned: 0, unseen: 0, deep: 0,
  });
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

// ---------------------------------------------------------------- 缓存命中

/*
 * 真实数据（logs/debug，2026-08-23）：481 条 request 事件只对应 236 个不同 URL，
 * 重复出现的 241 条中位数是 3ms —— 那是磁盘缓存，不是代理往返。旧实现从不读
 * `details.fromCache`，于是把它们全当成新的代理请求，「走了代理」虚高约一倍，
 * 「平均耗时」变成 2ms 缓存与 16s 真实请求的混合物。
 */

test('缓存命中单独计数，不进总量、成败、耗时与归因', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, latencyMs: 3, cached: true, viaNodeIp: true, ruleId: 'r_1', at: 1000 });

  assert.equal(m.requests.cached, 1);
  assert.equal(m.requests.total, 0, '缓存没有走网络，不该进「命中规则的请求」总量');
  assert.equal(m.requests.ok, 0);
  assert.equal(m.requests.latencyCount, 0, '2ms 的缓存读会把平均耗时拉成没有意义的数');
  assert.equal(m.requests.viaNodeIp, 0, '缓存命中时浏览器给的仍是上次的对端 IP，不是新证据');
  assert.equal(m.requests.unattributed, 0);
});

test('缓存命中不算规则在干活', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, latencyMs: 3, cached: true, ruleId: 'r_1' });
  assert.deepEqual(m.perRule, {}, '路由这次请求的是缓存，不是规则');
});

test('缓存命中也点亮 since', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, cached: true, at: 777 });
  assert.equal(m.since, 777);
});

test('summarizeMetrics 把缓存命中单列出来', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, latencyMs: 1200, responded: true });
  noteRequest(m, { ok: true, latencyMs: 3, cached: true });
  noteRequest(m, { ok: true, latencyMs: 3, cached: true });

  const view = summarizeMetrics(m);
  assert.equal(view.requests.cached, 2);
  assert.equal(view.requests.total, 1);
  assert.equal(view.requests.avgLatencyMs, 1200, '平均耗时只该由真实网络请求组成');
});

// ---------------------------------------------------------------- 延迟分位数

/*
 * 平均值单独一个数会骗人：真实数据里首次请求 p50 是 1.2s，p90 却是 15.8s。
 * 只报 avg 会让「大部分图其实很慢」这件事完全看不见。存的是固定桶的直方图，
 * 不是样本 —— 体积仍与运行时长无关（决策 D14）。
 */

test('延迟落进固定桶，桶数恒定不随请求数增长', () => {
  const m = emptyMetrics();
  for (let i = 0; i < 1000; i++) noteRequest(m, { ok: true, latencyMs: i, responded: true });
  assert.equal(m.latency.length, LATENCY_BUCKETS_MS.length + 1);
  assert.equal(m.latency.reduce((a, b) => a + b, 0), 1000, '每个样本恰好落一个桶');
});

test('分位数落在真值所在的桶里', () => {
  const m = emptyMetrics();
  for (let i = 0; i < 80; i++) noteRequest(m, { ok: true, latencyMs: 30, responded: true });
  for (let i = 0; i < 20; i++) noteRequest(m, { ok: true, latencyMs: 12000, responded: true });

  const view = summarizeMetrics(m);
  assert.ok(view.requests.latencyP50 > 0 && view.requests.latencyP50 <= 50,
    `真值 30ms，p50 应落在最低桶里，实际 ${view.requests.latencyP50}`);
  assert.ok(view.requests.latencyP90 > 8000 && view.requests.latencyP90 <= 16000,
    `真值 12000ms，p90 应落在 (8000,16000] 桶里，实际 ${view.requests.latencyP90}`);
});

test('没有耗时样本时分位数是「无」而不是 0', () => {
  const view = summarizeMetrics(emptyMetrics());
  assert.equal(view.requests.latencyP50, null);
  assert.equal(view.requests.latencyP90, null);
});

test('超过最大桶的样本报成桶下界，不假装知道具体值', () => {
  const m = emptyMetrics();
  for (let i = 0; i < 10; i++) noteRequest(m, { ok: true, latencyMs: 600000, responded: true });
  const view = summarizeMetrics(m);
  const last = LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1];
  assert.equal(view.requests.latencyP90, last, '只知道「≥ 最大桶下界」，不该编一个精确值');
});

test('normalizeMetrics 修得好被改坏的直方图', () => {
  const restored = normalizeMetrics({ latency: [1, -2, 'x', null] });
  assert.equal(restored.latency.length, LATENCY_BUCKETS_MS.length + 1);
  assert.equal(restored.latency[0], 1);
  assert.equal(restored.latency[1], 0, '负数归零');
  assert.equal(restored.latency[2], 0, '非数归零');
});

// ---------------------------------------------------------------- 归因口径

/*
 * 连接层就失败的请求（ERR_CONNECTION_CLOSED）压根没有对端 IP，
 * 谈不上「归因失败」。旧实现把这 13 次也算进「无法归因」，
 * 于是那一格显示 481 —— 等于请求总数，看起来像归因彻底失灵。
 */

test('没拿到响应的请求不计入「无法归因」，但仍算一次失败', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: false, responded: false, ruleId: 'r_1' });

  assert.equal(m.requests.total, 1, '它确实是一次本该走代理的请求，不计入会让成功率虚高');
  assert.equal(m.requests.fail, 1);
  assert.equal(m.requests.unattributed, 0, '连接都没建起来，没有对端 IP 可归因');
});

test('拿到了响应却认不出节点，才算无法归因', () => {
  const m = emptyMetrics();
  noteRequest(m, { ok: true, responded: true, viaNodeIp: true, ruleId: 'r_1' });
  assert.equal(m.requests.unattributed, 1);
});

// ---------------------------------------------------------------- 重试的两个新口径

/*
 * abandoned：重发出去了，但既没收到 load 也没收到 error —— 元素被页面换掉或
 *   导航走了。真实数据里 attempted=7 / recovered=6，差的那 1 次就是它，
 *   而旧面板四个格子加起来是 6，那 1 次无处可查。
 * unseen：网络层失败了，但页面侧压根没捕获到（阅读器用 new Image() 预加载，
 *   不在 DOM 上的 Image 不会经过 document 的捕获阶段）。真实数据里 13 次失败
 *   有 3 次属于此类，而旧面板「未重试」显示 0，读起来像「每次失败都重试了」。
 */

test('summarizeMetrics 暴露 abandoned 与 unseen，并把悬空的算清楚', () => {
  const m = emptyMetrics();
  for (let i = 0; i < 7; i++) noteRetry(m, { kind: 'attempted' });
  for (let i = 0; i < 6; i++) noteRetry(m, { kind: 'recovered' });
  noteRetry(m, { kind: 'abandoned' });
  for (let i = 0; i < 3; i++) noteRetry(m, { kind: 'unseen' });

  const view = summarizeMetrics(m);
  assert.equal(view.retry.abandoned, 1);
  assert.equal(view.retry.unseen, 3);
  assert.equal(view.retry.pending, 0, 'attempted 全部有了结论，不该有悬空');
});

test('重发了却还没有结论的次数单独可见', () => {
  const m = emptyMetrics();
  for (let i = 0; i < 5; i++) noteRetry(m, { kind: 'attempted' });
  noteRetry(m, { kind: 'recovered' });

  const view = summarizeMetrics(m);
  assert.equal(view.retry.pending, 4, '悬空的 4 次必须能在面板上看见，不能只体现为成功率变小');
});

// ---------------------------------------------------------------- 共用地址的节点

/*
 * 真实配置：19 个节点全在 10.0.0.3 上，只有端口不同。浏览器只给对端 IP、不给端口，
 * 所以「是哪个节点」这个问题无法回答 —— 面板于是渲染出 19 行 0/0/0/—/0%。
 * 解释文字是对的，但那张全零的表本身就是噪音。判断「这张表还有意义吗」是纯逻辑，
 * 放在这里，两个页面共用一份，不在 UI 里各写一遍。
 */

/** 一个真的能进轮询池的节点 —— 判断共用地址时只数这些 */
const proxyNode = (id, host, port, extra = {}) => ({
  id, name: id, protocol: 'http', host, port, enabled: true, autoDisabled: false, ...extra,
});

test('共用同一地址的节点被点出来，附带各自有几个', () => {
  const view = summarizeMetrics(emptyMetrics(), {
    nodes: [
      proxyNode('n_a', '10.0.0.3', 24000),
      proxyNode('n_b', '10.0.0.3', 24001),
      proxyNode('n_c', '10.0.0.9', 24002),
    ],
  });
  assert.deepEqual(view.nodes.sharedHosts, [{ host: '10.0.0.3', count: 2 }]);
  assert.equal(view.nodes.allShared, false, '还有一个地址唯一的节点，表仍然有意义');
});

test('每个节点都在共用地址里时，逐行列出只是噪音', () => {
  const view = summarizeMetrics(emptyMetrics(), {
    nodes: [proxyNode('n_a', '10.0.0.3', 24000), proxyNode('n_b', '10.0.0.3', 24001)],
  });
  assert.equal(view.nodes.allShared, true);
});

test('地址各不相同时不报共用，也不折叠', () => {
  const view = summarizeMetrics(emptyMetrics(), {
    nodes: [proxyNode('n_a', '10.0.0.3', 24000), proxyNode('n_b', '10.0.0.4', 24001)],
  });
  assert.deepEqual(view.nodes.sharedHosts, []);
  assert.equal(view.nodes.allShared, false);
});

test('一个节点都没配时不算「全部共用」', () => {
  const view = summarizeMetrics(emptyMetrics(), { nodes: [] });
  assert.deepEqual(view.nodes.sharedHosts, []);
  assert.equal(view.nodes.allShared, false, '空配置该走「还没有数据」那条路，不是折叠');
});

test('不可用协议的节点不参与共用地址的判断', () => {
  // 它压根进不了轮询池，拿它去论证「这张表分不开」是错的
  const view = summarizeMetrics(emptyMetrics(), {
    nodes: [
      proxyNode('n_a', '10.0.0.3', 24000),
      proxyNode('n_b', '10.0.0.3', 24001, { protocol: 'socks5' }),
    ],
  });
  assert.deepEqual(view.nodes.sharedHosts, [], '只剩一个真正可用的节点，不存在共用');
  assert.equal(view.nodes.allShared, false);
});

test('被禁用的节点也不参与共用地址的判断', () => {
  const view = summarizeMetrics(emptyMetrics(), {
    nodes: [
      proxyNode('n_a', '10.0.0.3', 24000),
      proxyNode('n_b', '10.0.0.3', 24001, { enabled: false }),
      proxyNode('n_c', '10.0.0.3', 24002, { autoDisabled: true }),
    ],
  });
  assert.deepEqual(view.nodes.sharedHosts, []);
});
