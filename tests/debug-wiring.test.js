/**
 * 调用点真的在记吗。
 *
 * tests/debug-log.test.js 验缓冲、tests/debug-store.test.js 验编排 —— 两者都可以全绿，
 * 而各模块一句 `dbg(...)` 都没调，日志导出来是空的。这个文件补的就是这一段：
 * 走一遍真实链路（注入 PAC → 观测请求 → 判定重试），然后**从导出的文件正文里**
 * 断言那几行在不在。断言导出文本而不是内部数组，是因为「文件里看不看得出问题」
 * 才是这个功能存在的理由。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, nodeFixture } from './helpers/chrome-stub.js';

const stub = installChromeStub();

const { setConfig, getRuntime } = await import('../src/background/state.js');
const { applyProxy } = await import('../src/background/proxy-controller.js');
const { installRequestLogger, resetObservedFailures } = await import('../src/background/request-logger.js');
const { planRetry, resetRetryThrottle } = await import('../src/background/retry-coordinator.js');
const { resetMetrics } = await import('../src/background/metrics-store.js');
const { setDebugEnabled, exportDebugFiles } = await import('../src/background/debug-store.js');
const { normalizeConfig } = await import('../src/lib/schema.js');

assert.equal(installRequestLogger(), true, 'webRequest 监听器应注册成功');

const RULE = { id: 'r_aaaaaaa1', name: '图片', type: 'host', pattern: 'manga.com', enabled: true, nodeIds: [] };
const IMG = 'https://cdn.manga.com/ch1/001.jpg';
/** nodeFixture 的 host 是 `${id.slice(2)}.px`，对端 IP 用它才能归因到具体节点 */
const NODE_HOST = 'aaaaaaa1.px';

async function seed() {
  await setDebugEnabled(false); // 顺手清空缓冲
  stub.reset();
  resetObservedFailures();
  resetRetryThrottle();
  Object.assign(getRuntime(), {
    startIndex: 0, control: null, summary: null, lastApplyAt: null, lastApplyError: null, probing: false,
  });
  await setConfig(normalizeConfig({
    enabled: true,
    rules: [RULE],
    nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')],
  }));
  await resetMetrics();
  await setDebugEnabled(true); // 开关在配置写完之后才开，免得夹具自己的动作进日志
}

/** 导出后取某个命名空间的文件正文 */
async function textOf(ns) {
  const out = await exportDebugFiles();
  return out.files.find((f) => f.name.includes(`-${ns}-`))?.text ?? '';
}

test('PAC 的编译与注入都落进 pac 命名空间', async () => {
  await seed();
  await applyProxy();
  const text = await textOf('pac');
  assert.match(text, /compiled\s+bytes=\d+/, '要记下脚本尺寸 —— 注入被拒时第一件想知道的事');
  assert.match(text, /poolTokens=2/);
  assert.match(text, /injected\s+controlled=true/);
});

test('一次请求观测把「命中规则」与「真的走代理」分开记', async () => {
  await seed();
  await stub.emit('onCompleted', {
    requestId: '1', url: IMG, statusCode: 200, ip: NODE_HOST, type: 'image',
  });
  const text = await textOf('request');
  assert.match(text, /completed\s+/);
  assert.match(text, /routed=true/);
  assert.match(text, /blind=false/);
  assert.match(text, /nodeId=n_aaaaaaa1/, '归因结果要记，否则查不了「统计为何算不出节点」');
  assert.match(text, /pacUrl=https:\/\/cdn\.manga\.com\//, 'PAC 实际看到的 URL 是这套日志最该回答的事');
});

test('连接层失败会记下错误码与归类', async () => {
  await seed();
  await stub.emit('onErrorOccurred', {
    requestId: '2', url: IMG, error: 'net::ERR_PROXY_CONNECTION_FAILED', type: 'image',
  });
  const text = await textOf('request');
  assert.match(text, /errored\s+/);
  assert.match(text, /error=net::ERR_PROXY_CONNECTION_FAILED/);
  assert.match(text, /cause=proxy/);
});

test('重试判定的入参与结论一次记全', async () => {
  await seed();
  await stub.emit('onErrorOccurred', {
    requestId: '3', url: IMG, error: 'net::ERR_PROXY_CONNECTION_FAILED', type: 'image',
  });
  const plan = await planRetry({ url: IMG, attempt: 1 });
  assert.equal(plan.action, 'retry');
  const text = await textOf('retry');
  assert.match(text, /planned\s+/);
  assert.match(text, /cause=proxy/);
  assert.match(text, /action=retry/);
  assert.match(text, /maxAttempts=3/);
});

test('不归本扩展管的裂图记下拒绝的理由 —— 那一路既不计数也不写活动日志', async () => {
  await seed();
  const plan = await planRetry({ url: 'https://other.example/x.png', attempt: 1 });
  assert.equal(plan.action, 'give-up');
  assert.match(await textOf('retry'), /declined\s+.*reason=not-routed/);
});

test('关着的时候整条链路一行都不产出', async () => {
  await seed();
  await setDebugEnabled(false);
  await applyProxy();
  await stub.emit('onCompleted', {
    requestId: '4', url: IMG, statusCode: 200, ip: NODE_HOST, type: 'image',
  });
  await planRetry({ url: IMG, attempt: 1 });
  const out = await exportDebugFiles();
  assert.deepEqual(out.files, []);
  assert.equal(out.merged, null);
});
