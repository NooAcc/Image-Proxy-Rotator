import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugLog, debugFileName, DEBUG_NS } from '../src/lib/debug-log.js';

/** 造一个时钟从 1000 开始、每次调用 +1 的缓冲 */
function make(options = {}) {
  let t = 1000;
  const dbg = createDebugLog({ now: () => t++, ...options });
  return dbg;
}

test('默认关闭，push 不记录任何东西', () => {
  const dbg = make();
  assert.equal(dbg.on, false);
  dbg.push('pac', 'compiled', { bytes: 10 });
  assert.equal(dbg.stats().count, 0);
});

test('enable(true) 之后 push 记录，list 按时间正序（最旧在前）', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('pac', 'first', {});
  dbg.push('pac', 'second', {});
  assert.deepEqual(dbg.list().map((r) => r.ev), ['first', 'second']);
});

test('on 是活的：enable 之后立刻为 true', () => {
  const dbg = make();
  dbg.enable(true);
  assert.equal(dbg.on, true);
});

test('超出条数上限时丢最老的', () => {
  const dbg = make({ limit: 3 });
  dbg.enable(true);
  for (let i = 1; i <= 5; i++) dbg.push('pac', 'e' + i, {});
  assert.deepEqual(dbg.list().map((r) => r.ev), ['e3', 'e4', 'e5']);
});

test('字节预算可以先于条数上限触发淘汰', () => {
  const dbg = make({ limit: 1000, byteBudget: 400 });
  dbg.enable(true);
  for (let i = 0; i < 40; i++) dbg.push('request', 'observed', { url: 'https://x.com/' + i });
  const stats = dbg.stats();
  assert.ok(stats.count < 40, `条数应被字节预算压下来，实际 ${stats.count}`);
  assert.ok(stats.bytes <= 400, `占用应不超预算，实际 ${stats.bytes}`);
  assert.ok(stats.count >= 1, '不能因为预算紧就把缓冲清空');
});

test('单个过长的字符串值被截断，避免一条 data URL 撑爆缓冲', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('content', 'error', { url: 'data:image/png;base64,' + 'A'.repeat(50000) });
  const row = dbg.list()[0];
  assert.ok(row.data.url.length < 2200, `应被截断，实际 ${row.data.url.length}`);
  assert.match(row.data.url, /…\(\+\d+\)$/, '截断处要标明省了多少字符');
});

test('默认上限要够跑完一整话漫画 —— 别把默认值收回小窗口', () => {
  const dbg = createDebugLog();
  const { limit, byteBudget } = dbg.stats();
  assert.ok(limit >= 20000, `默认条数上限 ${limit} 太小`);
  assert.ok(byteBudget >= 4 * 1024 * 1024, `默认字节预算 ${byteBudget} 太小`);
});

test('enable(false) 顺手清空缓冲', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('pac', 'x', {});
  dbg.enable(false);
  assert.equal(dbg.stats().count, 0);
  assert.deepEqual(dbg.list(), []);
});

test('groups 只列出非空的命名空间及其条数', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('pac', 'a', {});
  dbg.push('pac', 'b', {});
  dbg.push('retry', 'c', {});
  assert.deepEqual(dbg.groups(), { pac: 2, retry: 1 });
});

test('集合外的命名空间归到 misc，不新建', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('随便写的', 'x', {});
  assert.equal(dbg.list()[0].ns, 'misc');
  assert.ok(DEBUG_NS.includes('misc'));
});

test('list(ns) 只返回该命名空间，且是副本', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('pac', 'a', { n: 1 });
  dbg.push('retry', 'b', {});
  const rows = dbg.list('pac');
  assert.deepEqual(rows.map((r) => r.ev), ['a']);
  rows[0].ev = '被改了';
  assert.equal(dbg.list('pac')[0].ev, 'a');
});

test('pushRows 批量接入，并按 max 截断', () => {
  const dbg = make();
  dbg.enable(true);
  const rows = Array.from({ length: 10 }, (_, i) => ({ at: 5, ns: 'content', ev: 'e' + i, data: {} }));
  const accepted = dbg.pushRows(rows, { max: 4 });
  assert.equal(accepted, 4);
  assert.deepEqual(dbg.list().map((r) => r.ev), ['e0', 'e1', 'e2', 'e3']);
});

test('关闭时 pushRows 一条都不接', () => {
  const dbg = make();
  assert.equal(dbg.pushRows([{ at: 1, ns: 'ui', ev: 'x', data: {} }]), 0);
  assert.equal(dbg.stats().count, 0);
});

test('since 是第一条记录的时刻', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('pac', 'a', {});
  dbg.push('pac', 'b', {});
  assert.equal(dbg.stats().since, 1000);
});

test('restore 在关闭状态下是空操作 —— 关掉之后导出不该还有东西', () => {
  const dbg = make();
  dbg.restore([{ at: 5, ns: 'pac', ev: 'old', data: {} }]);
  assert.equal(dbg.stats().count, 0);
});

test('restore 在开启状态下恢复并保持正序', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.restore([
    { at: 5, ns: 'pac', ev: 'older', data: {} },
    { at: 9, ns: 'pac', ev: 'newer', data: {} },
  ]);
  assert.deepEqual(dbg.list().map((r) => r.ev), ['older', 'newer']);
});

// ------------------------------------------------------------------ 格式化

const META = { version: '1.3.0', at: 1755880867000 };

test('format 的文件头写明命名空间、条数与警告', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('request', 'observed', { url: 'https://x.com/1.jpg' });
  const text = dbg.format('request', META);
  const head = text.split('\n').slice(0, 5);
  assert.match(head[0], /Image-Proxy-Rotator 1\.3\.0/);
  assert.match(head[1], /namespace\s*:\s*request/);
  assert.match(head[3], /1 条/);
  assert.match(head[4], /^# 警告：/, '警告必须在文件头，不能藏在末尾');
  assert.match(text, /图片地址/, '警告要说清里面有什么');
});

test('format 的正文是「时刻 事件名 k=v」，可 grep', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('request', 'observed', { status: 200, blind: false });
  const line = dbg.format('request', META).trim().split('\n').pop();
  assert.match(line, /^\d{2}:\d{2}:\d{2}\.\d{3}\s+observed\s+status=200 blind=false$/);
});

test('format 的取值规则：null 写 -、对象走 JSON、带空格的字符串加引号', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('pac', 'injected', { err: null, summary: { nodes: 3 }, name: '我 的 节点' });
  const line = dbg.format('pac', META).trim().split('\n').pop();
  assert.match(line, /err=-/);
  assert.match(line, /summary=\{"nodes":3\}/);
  assert.match(line, /name="我 的 节点"/);
});

test('超过列宽的事件名与首字段之间保留分隔符', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('retry', 'fallback-window-opened', { origin: 'https://cdn.manga.com/' });
  const line = dbg.format('retry', META).trim().split('\n').pop();
  assert.match(line, /fallback-window-opened\s+origin=/);
  assert.doesNotMatch(line, /openedorigin=/, '事件名和字段粘连会让导出日志无法解析');
});

test('format 对空命名空间返回空串 —— 不生成 0 行的文件', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('pac', 'x', {});
  assert.equal(dbg.format('retry', META), '');
});

test('formatMerged 多一列命名空间，把跨环节的时间线接起来', () => {
  const dbg = make();
  dbg.enable(true);
  dbg.push('retry', 'planned', { verdict: 'retry' });
  dbg.push('content', 'resent', { attempt: 2 });
  const lines = dbg.formatMerged(META).trim().split('\n').filter((l) => !l.startsWith('#'));
  const body = lines.filter(Boolean);
  assert.match(body[0], /\bretry\s+planned\s+verdict=retry$/);
  assert.match(body[1], /\bcontent\s+resent\s+attempt=2$/);
});

test('debugFileName 带命名空间与时间戳，且是合法文件名', () => {
  const name = debugFileName('request', META.at);
  assert.match(name, /^ipr-debug-request-\d{8}-\d{4}\.log$/);
});
