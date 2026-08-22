/**
 * 重试与兜底的后台编排。
 *
 * 这条链路的关键不是「会不会重试」，而是**什么时候不该重试**：换一个代理去取同一个
 * 404 只是白给图源添一次请求，而把图片地址交给兜底服务是有隐私代价的。所以判定必须
 * 建立在 webRequest 真正观测到的错误码 / 状态码上（决策 D22），而不是「图裂了就重刷」。
 *
 * 判定逻辑本身在 tests/retry.test.js（纯函数）里逐条钉过；这里测的是编排：
 * 观测结果有没有被记下来、有没有被查到、计数与日志有没有落对地方。
 *
 * 注意导入方式：state.js 在模块顶层就会读 chrome.storage.local，
 * 所以必须先装替身再动态导入，不能用顶层 import 语句。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, nodeFixture } from './helpers/chrome-stub.js';

const stub = installChromeStub();

const { getConfig, setConfig, getRuntime, getLogger } = await import('../src/background/state.js');
const { handleMessage } = await import('../src/background/messaging.js');
const { installRequestLogger, resetObservedFailures, observedFailure } = await import('../src/background/request-logger.js');
const { resetMetrics } = await import('../src/background/metrics-store.js');
const { resetRetryThrottle } = await import('../src/background/retry-coordinator.js');
const { normalizeConfig } = await import('../src/lib/schema.js');
const { FAILURE_TTL_MS } = await import('../src/lib/constants.js');

assert.equal(installRequestLogger(), true, 'webRequest 监听器应注册成功');

// ---------------------------------------------------------------- 夹具

/** webRequest 看到的完整 URL */
const IMG_URL = 'https://cdn.manga.com/ch1/001.jpg';
/** 「域名」型规则 —— HTTPS 下 PAC 也判定得了，所以这些图真的走了代理 */
const RULE = { id: 'r_aaaaaaa1', name: '图片', type: 'host', pattern: 'manga.com', enabled: true, nodeIds: [] };
/** 依赖路径的规则：HTTPS 下 PAC 判定不了，这类图本来就是直连 */
const BLIND_RULE = { id: 'r_bbbbbbb2', name: '扩展名', type: 'regex', pattern: '\\.jpg$', enabled: true, nodeIds: [] };
const TEMPLATE = 'https://wsrv.nl/?url={url}';
const PROXIED = `https://wsrv.nl/?url=${encodeURIComponent(IMG_URL)}`;

async function seed(partial = {}) {
  stub.reset();
  resetRetryThrottle();
  // 失败原因表活在模块作用域里，清存储清不掉它。不清的话上一个用例留下的原因
  // 会漏到下一个用例，让整个文件变成顺序相关的
  resetObservedFailures();
  Object.assign(getRuntime(), {
    startIndex: 0, control: null, summary: null, lastApplyAt: null, lastApplyError: null, probing: false,
  });
  await setConfig(normalizeConfig({
    enabled: true, rules: [RULE], nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')], ...partial,
  }));
  await resetMetrics();
  (await getLogger()).clear();
  return getConfig();
}

const logText = async () => (await getLogger()).list({ kind: 'request' }).map((r) => r.message).join('\n');
const view = async () => (await handleMessage({ type: 'getState' })).metrics;

/** 走一遍「后台观测到失败 → 内容脚本来问」的完整往返 */
async function askAfter(observed, { url = IMG_URL, attempt = 1 } = {}) {
  await stub.emit('onBeforeRequest', { requestId: 'r-1', url });
  if (observed.error) await stub.emit('onErrorOccurred', { requestId: 'r-1', url, error: observed.error });
  else await stub.emit('onCompleted', { requestId: 'r-1', url, statusCode: observed.statusCode });
  return handleMessage({ type: 'imageRetryAsk', url, attempt });
}

const ask = (url = IMG_URL, attempt = 1) => handleMessage({ type: 'imageRetryAsk', url, attempt });
const tell = (kind, ok, url = IMG_URL) => handleMessage({ type: 'imageRetryResult', url, kind, ok });

// ---------------------------------------------------------------- 该不该重试

test('代理层失败 → 重试，并带上重发前的等待时长', async () => {
  await seed();
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' });

  assert.equal(plan.action, 'retry');
  assert.equal(plan.delayMs, 300, '要留时间让 Chromium 把刚失败的代理登记进它自己的坏代理列表');
  assert.equal((await view()).retry.attempted, 1);
});

test('图源返回 404 → 不重试。换个代理拿到的还是同一个 404', async () => {
  await seed();
  const plan = await askAfter({ statusCode: 404 });

  assert.equal(plan.action, 'give-up');
  assert.equal(plan.reason, 'not-proxy-failure');

  const m = await view();
  assert.equal(m.retry.attempted, 0);
  assert.equal(m.retry.skipped, 1, '不重试也要留痕，否则用户查不出为什么没重试');
});

test('查不到失败原因时保守放弃，不盲目重刷', async () => {
  // 刻意不发任何 webRequest 事件：模拟渲染进程的 error 抢在网络层回调之前到达
  await seed();
  const plan = await ask();
  assert.equal(plan.action, 'give-up');
  assert.equal(plan.reason, 'unknown-cause');
});

test('不匹配任何规则的图片完全不干预', async () => {
  await seed();
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { url: 'https://cdn.other.com/x.jpg' });
  assert.equal(plan.reason, 'not-routed');
});

test('别人网站的裂图不进统计 —— 那一格数的是「你的图片」', async () => {
  // 用户随手逛的任何网站上的裂图都会走到这条判定。把它记进 skipped 会让
  // 「未重试」变成与配置无关的噪音计数，用户看到「未重试 47 次」只会以为哪里出了问题
  await seed();
  for (let i = 0; i < 5; i++) {
    await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { url: `https://cdn.other.com/${i}.jpg` });
  }
  const m = await view();
  assert.equal(m.retry.skipped, 0);
  assert.equal(m.retry.attempted, 0);
});

test('不归本扩展管的图片不该白等一次宽限期', async () => {
  // 整个网站的裂图都会走到这里。先判「归不归我管」再查失败原因，
  // 否则一个到处是裂图的页面会让 16 个并发询问各挂 150ms
  await seed();
  const started = Date.now();
  await ask('https://cdn.other.com/x.jpg');
  assert.ok(Date.now() - started < 100, `不该等宽限期，实际等了 ${Date.now() - started}ms`);
});

test('规则命中但 HTTPS 下判定不了的图片不重试：它本来就没走代理', async () => {
  // 判定必须用 matchPacUrl 而不是 matchUrl。用后者会把一批注定直连的图片拉进重试，
  // 而重发它们同样是直连，纯属浪费
  await seed({ rules: [BLIND_RULE] });
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  assert.equal(plan.reason, 'not-routed');
});

test('总开关关闭时回 disabled，内容脚本据此进入冷却而不是每张图都来问', async () => {
  await seed({ enabled: false });
  assert.equal((await ask()).reason, 'disabled');
});

// ---------------------------------------------------------------- 次数与兜底

test('用尽 maxAttempts 后交给兜底，地址是编码后的原图', async () => {
  await seed({ settings: { fallbackImage: { enabled: true, template: TEMPLATE } } });
  const plan = await askAfter({ error: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, { attempt: 3 });

  assert.equal(plan.action, 'fallback');
  assert.equal(plan.url, PROXIED);

  const m = await view();
  assert.equal(m.retry.exhausted, 1);
  assert.equal(m.fallbackImage.used, 1);
  assert.match(await logText(), /兜底服务会拿到图片地址/, '隐私代价必须说出来');
});

test('exhausted 与 fallbackImage.used 是两个口径，前者 ≥ 后者', async () => {
  await seed();
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  const m = await view();
  assert.equal(m.retry.exhausted, 1, '轮询节点都试过了');
  assert.equal(m.fallbackImage.used, 0, '但没有兜底可用，所以没人接手');
});

test('没配兜底时用尽次数记成 exhausted 而不是 skipped', async () => {
  await seed();
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  assert.equal(plan.reason, 'exhausted');
  assert.equal((await view()).retry.skipped, 0);
});

test('maxAttempts=1 就是不重试，第一次失败直接走兜底', async () => {
  await seed({
    settings: {
      retry: { maxAttempts: 1, delayMs: 0 },
      fallbackImage: { enabled: true, template: TEMPLATE },
    },
  });
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 1 });
  assert.equal(plan.action, 'fallback');
  assert.equal(plan.delayMs, 0, '0 毫秒是合法的：用户可以选择不等');
});

test('模板非法时兜底不生效，也不会产出一个坏地址', async () => {
  await seed({ settings: { fallbackImage: { enabled: true, template: 'https://wsrv.nl/' } } });
  assert.equal((await getConfig()).settings.fallbackImage.enabled, false, '规范化时就该关掉它');

  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  assert.equal(plan.action, 'give-up');
  assert.equal(plan.reason, 'exhausted');
});

// ---------------------------------------------------------------- 结果回报

test('recovered 来自内容脚本回报的 load，不是推断出来的', async () => {
  await seed();
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  await tell('retry', true);

  const m = await view();
  assert.equal(m.retry.attempted, 1);
  assert.equal(m.retry.recovered, 1);
  assert.equal(m.retry.recoveryRate, 100);
});

test('重试仍然失败时不计入 recovered', async () => {
  await seed();
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  await tell('retry', false);
  assert.equal((await view()).retry.recovered, 0);
});

test('兜底的成败单独记账，不混进「重试救回」', async () => {
  await seed();
  await tell('fallback', true, PROXIED);
  await tell('fallback', false, PROXIED);

  const m = await view();
  assert.equal(m.fallbackImage.ok, 1);
  assert.equal(m.fallbackImage.fail, 1);
  assert.equal(m.fallbackImage.successRate, 50);
  assert.equal(m.retry.recovered, 0, '兜底成功和重试救回是两件事');
});

test('重试成功后忘掉旧的失败原因，下次裂图不会读到过期结论', async () => {
  await seed();
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  await tell('retry', true);
  // 不再发任何 webRequest 事件；若上一条记录还在，这里会被误判成「代理故障，可重试」
  assert.equal((await ask()).reason, 'unknown-cause');
});

test('页面重试预算耗尽会写进日志，不是悄悄停下', async () => {
  await seed();
  await tell('budget', false);
  const text = await logText();
  assert.match(text, /单页上限/);
  assert.match(text, /全量测速/, '要告诉用户下一步做什么');
});

// ---------------------------------------------------------------- 日志节流与预览

test('同一域名的重试日志每分钟只说一次，但计数一次不漏', async () => {
  // 一个漫画页能打出几百个失败请求。逐条写日志会在几秒内把环形缓冲冲干净，
  // 把真正有用的那几条（注入失败、规则告警）挤掉
  await seed();
  for (let i = 0; i < 20; i++) {
    await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { url: `${IMG_URL}?i=${i}` });
  }
  const said = (await getLogger()).list({ kind: 'request' })
    .filter((r) => /换一个节点重发/.test(r.message)).length;
  assert.equal(said, 1, `同一域名每分钟只该说一次，实际说了 ${said} 次`);
  assert.equal((await view()).retry.attempted, 20, '日志节流不影响计数 —— 次数该去统计里看');
});

test('previewFallbackImage 给出改写结果与兜底服务的源', async () => {
  await seed();
  const good = await handleMessage({ type: 'previewFallbackImage', template: TEMPLATE, url: IMG_URL });
  assert.equal(good.ok, true);
  assert.equal(good.url, PROXIED);
  assert.equal(good.origin, 'https://wsrv.nl');
});

test('previewFallbackImage 对非法输入给出中文原因，而不是抛异常', async () => {
  await seed();
  const noPlaceholder = await handleMessage({ type: 'previewFallbackImage', template: 'https://wsrv.nl/', url: IMG_URL });
  assert.equal(noPlaceholder.ok, false);
  assert.match(noPlaceholder.error, /\{url\}/);

  const badUrl = await handleMessage({ type: 'previewFallbackImage', template: TEMPLATE, url: 'not-a-url' });
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.error, /http/);
});

test('兜底地址自己失败时不会被再套一层', async () => {
  // 不拦住的话会套出「兜底/?url=兜底/?url=…」并无限递归下去
  await seed({ settings: { fallbackImage: { enabled: true, template: TEMPLATE } } });
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { url: PROXIED, attempt: 3 });
  assert.notEqual(plan.action, 'fallback');
});

// ---------------------------------------------------------------- 失败原因表

test('只记失败：成功的请求不占表，也不会让后续裂图误判成「可重试」', async () => {
  await seed();
  await stub.emit('onCompleted', { requestId: 'ok-1', url: IMG_URL, statusCode: 200 });
  assert.equal(observedFailure(IMG_URL), null, '200 不该留下失败记录');
  assert.equal((await ask()).reason, 'unknown-cause');
});

test('记录会过期：超过留存窗口后按「原因不明」处理', async () => {
  await seed();
  await stub.emit('onErrorOccurred', { requestId: 'e-1', url: IMG_URL, error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  assert.equal(observedFailure(IMG_URL), 'proxy');

  // 把时钟往前推过留存窗口。原因不能永久有效 —— 十分钟前那次代理故障
  // 说明不了这一次为什么失败
  const realNow = Date.now;
  Date.now = () => realNow() + FAILURE_TTL_MS + 1000;
  try {
    assert.equal(observedFailure(IMG_URL), null);
  } finally {
    Date.now = realNow;
  }
});

test('表有容量上限，长时间运行不会无界增长', async () => {
  await seed();
  for (let i = 0; i < 400; i++) {
    await stub.emit('onErrorOccurred', {
      requestId: `c-${i}`,
      url: `https://cdn.manga.com/${i}.jpg`,
      error: 'net::ERR_PROXY_CONNECTION_FAILED',
    });
  }
  // 最新的一定还在；最旧的应该已经被挤掉了
  assert.equal(observedFailure('https://cdn.manga.com/399.jpg'), 'proxy');
  assert.equal(observedFailure('https://cdn.manga.com/0.jpg'), null, '最旧的该被挤出去');
});

test('不匹配规则的请求失败不进表 —— 没必要替整个网站记裂图', async () => {
  await seed();
  const other = 'https://cdn.other.com/x.jpg';
  await stub.emit('onErrorOccurred', { requestId: 'o-1', url: other, error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  assert.equal(observedFailure(other), null);
});
