import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/lib/logger.js';

test('add 后 list 返回条目，最新在前', () => {
  let t = 1000;
  const log = createLogger({ limit: 10, now: () => t++ });
  log.add({ level: 'info', kind: 'probe', message: '第一条' });
  log.add({ level: 'info', kind: 'probe', message: '第二条' });
  const rows = log.list({});
  assert.equal(rows[0].message, '第二条');
  assert.equal(rows[1].message, '第一条');
});

test('超出 limit 时丢弃最旧的条目', () => {
  const log = createLogger({ limit: 3, now: () => 1 });
  for (let i = 1; i <= 5; i++) log.add({ level: 'info', kind: 'request', message: 'm' + i });
  assert.equal(log.size(), 3);
  assert.deepEqual(log.list({}).map((r) => r.message), ['m5', 'm4', 'm3']);
});

test('自动补齐 id / at / 默认字段', () => {
  const log = createLogger({ limit: 5, now: () => 4242 });
  log.add({ message: 'x' });
  const r = log.list({})[0];
  assert.ok(r.id);
  assert.equal(r.at, 4242);
  assert.equal(r.level, 'info');
  assert.equal(r.kind, 'system');
  assert.equal(r.nodeId, null);
  assert.equal(r.ok, null);
});

test('list 支持按 kind 与 level 过滤', () => {
  const log = createLogger({ limit: 10, now: () => 1 });
  log.add({ kind: 'probe', level: 'info', message: 'p' });
  log.add({ kind: 'request', level: 'error', message: 'r' });
  assert.equal(log.list({ kind: 'probe' }).length, 1);
  assert.equal(log.list({ level: 'error' })[0].message, 'r');
});

test('list 支持 limit 截断', () => {
  const log = createLogger({ limit: 10, now: () => 1 });
  for (let i = 0; i < 5; i++) log.add({ message: 'm' + i });
  assert.equal(log.list({ limit: 2 }).length, 2);
});

test('clear 清空', () => {
  const log = createLogger({ limit: 5, now: () => 1 });
  log.add({ message: 'x' });
  log.clear();
  assert.equal(log.size(), 0);
  assert.deepEqual(log.list({}), []);
});

test('limit 为 0 或非法时回落到默认值而不是丢弃全部日志', () => {
  const log = createLogger({ limit: 0, now: () => 1 });
  log.add({ message: 'x' });
  assert.equal(log.size(), 1);
});

test('list 返回副本，外部修改不影响内部状态', () => {
  const log = createLogger({ limit: 5, now: () => 1 });
  log.add({ message: 'x' });
  log.list({})[0].message = '被改了';
  assert.equal(log.list({})[0].message, 'x');
});

test('setLimit 收紧上限时立即裁剪', () => {
  const log = createLogger({ limit: 10, now: () => 1 });
  for (let i = 0; i < 8; i++) log.add({ message: 'm' + i });
  log.setLimit(3);
  assert.equal(log.size(), 3);
  assert.equal(log.list({})[0].message, 'm7', '保留的是最新的');
});

test('restore 从持久化数组恢复', () => {
  const log = createLogger({ limit: 10, now: () => 1 });
  log.restore([{ id: 'a', at: 5, level: 'warn', kind: 'probe', message: '旧的' }]);
  assert.equal(log.size(), 1);
  assert.equal(log.list({})[0].message, '旧的');
});

test('id 在同一毫秒内也不重复', () => {
  const log = createLogger({ limit: 10, now: () => 7 });
  for (let i = 0; i < 5; i++) log.add({ message: 'm' + i });
  const ids = new Set(log.list({}).map((r) => r.id));
  assert.equal(ids.size, 5);
});
