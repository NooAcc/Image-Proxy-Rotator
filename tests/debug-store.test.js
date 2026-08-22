/**
 * 调试日志的后台侧：开关、落盘、导出。
 *
 * 缓冲本身的行为在 tests/debug-log.test.js 里钉过，这里测的是编排 ——
 * 开关从哪来、变更怎么传导、什么时候落盘、导出的形状对不对，
 * 以及**日志会不会记录日志自己**（那是个会自我喂养的环，必须显式打断）。
 *
 * 注意导入方式：state.js 在模块顶层就会读 chrome.storage.local，
 * 所以必须先装替身再动态导入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub } from './helpers/chrome-stub.js';

const stub = installChromeStub();

const {
  DEBUG_KEY,
  DEBUG_LOG_KEY,
  dbg,
  initDebug,
  setDebugEnabled,
  debugState,
  acceptDebugRows,
  exportDebugFiles,
  clearDebugLog,
  flushDebugLog,
} = await import('../src/background/debug-store.js');

const { handleMessage } = await import('../src/background/messaging.js');

/** 缓冲活在模块作用域里，清存储清不掉它 —— 每个用例都要显式关一次再开 */
async function fresh(enabled = true) {
  await setDebugEnabled(false);
  stub.reset();
  if (enabled) await setDebugEnabled(true);
}

test('默认关闭', async () => {
  await fresh(false);
  assert.equal(dbg.on, false);
  assert.equal((await debugState()).enabled, false);
});

test('setDebugEnabled 写进 storage.local 的独立键，不碰 config', async () => {
  await fresh(false);
  await setDebugEnabled(true);
  assert.equal(dbg.on, true);
  assert.equal(stub.local._dump()[DEBUG_KEY]?.enabled, true);
  assert.equal(stub.local._dump().config, undefined, '开关不该混进配置，否则会被导出带走');
});

test('记录之后 flush 落进 session', async () => {
  await fresh();
  dbg('pac', 'compiled', { bytes: 100 });
  await flushDebugLog();
  const rows = stub.session._dump()[DEBUG_LOG_KEY];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ev, 'compiled');
  assert.equal(rows[0].ns, 'pac');
});

test('攒几条不会立刻落盘 —— 热路径必须走节流', async () => {
  await fresh();
  for (let i = 0; i < 5; i++) dbg('request', 'observed', { i });
  assert.equal(stub.session._dump()[DEBUG_LOG_KEY], undefined);
});

test('关闭时 dbg 既不记也不落盘', async () => {
  await fresh(false);
  dbg('pac', 'compiled', {});
  await flushDebugLog();
  assert.equal(stub.session._dump()[DEBUG_LOG_KEY], undefined);
  assert.equal((await debugState()).stats.count, 0);
});

test('initDebug 把 SW 被回收前的缓冲接回来', async () => {
  await fresh(false);
  await stub.local.set({ [DEBUG_KEY]: { enabled: true, since: 1 } });
  await stub.session.set({
    [DEBUG_LOG_KEY]: [{ at: 5, ns: 'retry', ev: 'planned', data: { verdict: 'retry' } }],
  });
  await initDebug();
  assert.equal(dbg.on, true);
  const state = await debugState();
  assert.equal(state.stats.count, 1);
  assert.deepEqual(state.groups, { retry: 1 });
});

test('外部改 storage 的开关键会同步到内存 —— 设置页开完不用等 SW 重启', async () => {
  await fresh(false);
  await initDebug();
  await stub.local.set({ [DEBUG_KEY]: { enabled: true } });
  assert.equal(dbg.on, true);
  await stub.local.set({ [DEBUG_KEY]: { enabled: false } });
  assert.equal(dbg.on, false);
});

test('acceptDebugRows 按上限截断，页面侧灌不爆缓冲', async () => {
  await fresh();
  const rows = Array.from({ length: 100 }, (_, i) => ({ at: i, ns: 'content', ev: 'e' + i, data: {} }));
  assert.equal(await acceptDebugRows(rows), 64);
});

test('关闭时 acceptDebugRows 一条都不收', async () => {
  await fresh(false);
  assert.equal(await acceptDebugRows([{ at: 1, ns: 'ui', ev: 'x', data: {} }]), 0);
});

test('导出：每个非空命名空间一个文件，另加一份合并文件', async () => {
  await fresh();
  dbg('pac', 'compiled', { bytes: 10 });
  dbg('retry', 'planned', { verdict: 'retry' });
  const out = await exportDebugFiles();
  assert.deepEqual(
    out.files.map((f) => f.name.replace(/-\d{8}-\d{4}\.log$/, '')),
    ['ipr-debug-pac', 'ipr-debug-retry'],
  );
  assert.match(out.files[0].text, /namespace : pac/);
  assert.match(out.merged.name, /^ipr-debug-all-/);
  assert.match(out.merged.text, /0\.0\.0-test/, '文件头要带扩展版本号');
});

test('导出：缓冲为空时不产出任何文件', async () => {
  await fresh();
  const out = await exportDebugFiles();
  assert.deepEqual(out.files, []);
  assert.equal(out.merged, null);
});

test('clearDebugLog 只清 debug，活动日志原封不动', async () => {
  await fresh();
  await stub.session.set({ logs: [{ id: 'l1', message: '活动日志' }] });
  dbg('pac', 'x', {});
  await flushDebugLog();
  await clearDebugLog();
  assert.equal((await debugState()).stats.count, 0);
  assert.equal(stub.session._dump()[DEBUG_LOG_KEY], undefined);
  assert.equal(stub.session._dump().logs.length, 1, '活动日志是另一路，不能被顺手清掉');
});

test('关掉开关顺手清空 —— 导出不该拿到上一次复现的残留', async () => {
  await fresh();
  dbg('pac', 'x', {});
  await flushDebugLog();
  await setDebugEnabled(false);
  assert.deepEqual((await exportDebugFiles()).files, []);
  assert.equal(stub.session._dump()[DEBUG_LOG_KEY], undefined);
});

test('msg 命名空间不记 debug 自己的消息，否则日志里全是日志', async () => {
  await fresh();
  await handleMessage({ type: 'getDebug' });
  await handleMessage({ type: 'debugPush', rows: [{ at: 1, ns: 'ui', ev: 'sent', data: {} }] });
  const groups = (await debugState()).groups;
  assert.equal(groups.msg, undefined, 'debug 自身的消息必须被排除');
  assert.equal(groups.ui, 1, '页面回传的行照收');
});

test('msg 命名空间照常记别的消息', async () => {
  await fresh();
  await handleMessage({ type: 'getState' });
  assert.ok((await debugState()).groups.msg >= 1);
});
