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
const { resetFallbackWindows } = await import('../src/background/fallback-window.js');
const { normalizeConfig } = await import('../src/lib/schema.js');
const { FAILURE_TTL_MS, RETRY_ASK_GRACE_MS, FALLBACK_WINDOW_MS, FALLBACK_COOLDOWN_MS } = await import('../src/lib/constants.js');

assert.equal(installRequestLogger(), true, 'webRequest 监听器应注册成功');

// ---------------------------------------------------------------- 夹具

/** webRequest 看到的完整 URL */
const IMG_URL = 'https://cdn.manga.com/ch1/001.jpg';
/** 「域名」型规则 —— HTTPS 下 PAC 也判定得了，所以这些图真的走了代理 */
const RULE = { id: 'r_aaaaaaa1', name: '图片', type: 'host', pattern: 'manga.com', enabled: true, nodeIds: [] };
/** 依赖路径的规则：HTTPS 下 PAC 判定不了，这类图本来就是直连 */
const BLIND_RULE = { id: 'r_bbbbbbb2', name: '扩展名', type: 'regex', pattern: '\\.jpg$', enabled: true, nodeIds: [] };
/** 兜底代理：一个普通的 HTTP 正向代理，独立于节点列表 */
const FALLBACK = { enabled: true, raw: 'http://10.0.0.3:37581' };
/** 它在 PAC 里应当长成的样子 */
const FALLBACK_TOKEN = 'PROXY 10.0.0.3:37581';
/** 兜底窗口按「源」生效，这是 IMG_URL 的源前缀 */
const IMG_ORIGIN = 'https://cdn.manga.com/';

async function seed(partial = {}) {
  stub.reset();
  resetRetryThrottle();
  // 失败原因表活在模块作用域里，清存储清不掉它。不清的话上一个用例留下的原因
  // 会漏到下一个用例，让整个文件变成顺序相关的。兜底窗口同理
  resetObservedFailures();
  resetFallbackWindows();
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
/** 推进假时钟，再把定时器回调里那串 async 让干净 */
async function elapse(t, ms) {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

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

test('用尽 maxAttempts 后切到兜底代理，页面原地重发（不再改写地址）', async () => {
  await seed({ settings: { fallbackProxy: FALLBACK } });
  const plan = await askAfter({ error: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, { attempt: 3 });

  assert.equal(plan.action, 'fallback');
  assert.equal(plan.url, undefined, '兜底是传输层的，不给页面任何新地址');

  // 真正的切换发生在 PAC 里：该源被强制指向兜底代理
  const pac = stub.lastPac();
  assert.ok(pac.includes(FALLBACK_TOKEN), '注入的 PAC 里应当出现兜底代理');
  assert.ok(pac.includes(IMG_ORIGIN), '强制条目应当按这个源生效');

  const m = await view();
  assert.equal(m.retry.exhausted, 1);
  assert.equal(m.fallbackProxy.used, 1);
  // 「按源生效」与用户直觉有差距，必须说出来
  assert.match(await logText(), /所有.*请求都会走兜底代理/, '连带效应必须写在日志里');
});

test('exhausted 与 fallbackProxy.used 是两个口径，前者 ≥ 后者', async () => {
  await seed();
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  const m = await view();
  assert.equal(m.retry.exhausted, 1, '轮询节点都试过了');
  assert.equal(m.fallbackProxy.used, 0, '但没有兜底可用，所以没人接手');
});

test('没配兜底时用尽次数记成 exhausted 而不是 skipped', async () => {
  await seed();
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  assert.equal(plan.reason, 'exhausted');
  assert.equal((await view()).retry.skipped, 0);
});

test('maxAttempts=1 就是不重试，第一次失败直接走兜底', async () => {
  await seed({
    settings: { retry: { maxAttempts: 1, delayMs: 0 }, fallbackProxy: FALLBACK },
  });
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 1 });
  assert.equal(plan.action, 'fallback');
  assert.equal(plan.delayMs, 0, '0 毫秒是合法的：用户可以选择不等');
});

test('兜底地址不可用时兜底不生效，也不会往 PAC 里塞一个坏 token', async () => {
  // 1.4.x 正是栽在这里：把一个 HTTP 正向代理填进 `?url=` 模板框，校验全过、真用到时每次 400
  await seed({ settings: { fallbackProxy: { enabled: true, raw: 'socks5://10.0.0.3:1080' } } });
  assert.equal((await getConfig()).settings.fallbackProxy.enabled, false, '规范化时就该关掉它');

  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  assert.equal(plan.action, 'give-up');
  assert.equal(plan.reason, 'exhausted');
  assert.ok(!stub.lastPac()?.includes('1080'), '不可用的兜底代理不该进 PAC');
});

test('窗口开着时同源的下一张图直接复用，不再重注入一遍 PAC', async () => {
  // 一次大面积失败会让几十张图同时用尽。每张都重注入一遍 PAC 就是自找的抖动
  await seed({ settings: { fallbackProxy: FALLBACK } });
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  const injections = stub.proxyCalls.filter((c) => c.type === 'set').length;

  const second = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { url: `${IMG_URL}?2`, attempt: 3 });
  assert.equal(second.action, 'fallback', '窗口开着，照样放行');
  assert.equal(stub.proxyCalls.filter((c) => c.type === 'set').length, injections, '不该再注入一次');
  assert.equal((await view()).fallbackProxy.used, 2, '但两次都算兜底接管');
});

test('窗口过期后进入冷却期，用尽的图直接裂掉并单列计数', async (t) => {
  // 没有冷却，轮询池持续失败时窗口会几乎一直开着 —— 整个图源长期只走兜底代理那一个 IP，
  // 而这正是本扩展存在意义的反面
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  await seed({ settings: { fallbackProxy: FALLBACK } });
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });

  await elapse(t, FALLBACK_WINDOW_MS + 1000);
  resetObservedFailures();
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });

  assert.equal(plan.action, 'give-up');
  assert.equal(plan.reason, 'cooldown');
  const m = await view();
  assert.equal(m.fallbackProxy.cooldown, 1, '冷却期跳过要单列，否则读起来像兜底坏了');
  assert.equal(m.fallbackProxy.used, 1, '这一次没有接手');
  assert.match(await logText(), /冷却/, '为什么没兜底必须说出来');
});

test('冷却期过完之后可以再开一扇窗', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  await seed({ settings: { fallbackProxy: FALLBACK } });
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });

  await elapse(t, FALLBACK_WINDOW_MS + FALLBACK_COOLDOWN_MS + 1000);
  resetObservedFailures();
  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  assert.equal(plan.action, 'fallback');
});

test('fetch 与 XHR 现在也能兜底 —— 换代理对接口同样有效', async () => {
  // 1.4.x 的兜底是 URL 改写，把一个 JSON 接口套进 `?url=` 毫无意义，所以那时按 via 关掉了。
  // 传输层兜底没有这个限制，这条钉住新增的能力
  for (const via of ['fetch', 'xhr']) {
    await seed({ settings: { fallbackProxy: FALLBACK } });
    await stub.emit('onBeforeRequest', { requestId: 'r-1', url: IMG_URL });
    await stub.emit('onErrorOccurred', { requestId: 'r-1', url: IMG_URL, error: 'net::ERR_CONNECTION_CLOSED' });
    const plan = await handleMessage({ type: 'imageRetryAsk', url: IMG_URL, attempt: 3, via });
    assert.equal(plan.action, 'fallback', `${via} 应当也能拿到兜底`);
  }
});

test('兜底那一次再失败就到此为止，不会无限套娃', async () => {
  // 防递归靠 attempt 超限，不靠地址形状 —— 地址从头到尾就没变过
  await seed({ settings: { fallbackProxy: FALLBACK } });
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  resetObservedFailures();
  const again = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 4 });
  assert.notEqual(again.action, 'fallback');
  assert.equal(again.reason, 'exhausted');
});

test('注入失败时不回 fallback，并把窗口撤回去', async () => {
  // 窗口记着「已开」而 PAC 里其实没有对应条目，是最糟的状态：下一张图会因为
  // 「窗口已开」直接重发，落到普通节点上却被记成一次兜底
  await seed({ settings: { fallbackProxy: FALLBACK } });
  stub.setSettingsError('控制权被别的扩展占用');

  const plan = await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }, { attempt: 3 });
  assert.equal(plan.action, 'give-up');
  assert.equal(plan.reason, 'fallback-failed');
  assert.equal((await view()).fallbackProxy.used, 0, '没切成就不能记成用过');
  assert.match(await logText(), /注入分流脚本失败/);
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
  await tell('fallback', true);
  await tell('fallback', false);

  const m = await view();
  assert.equal(m.fallbackProxy.ok, 1);
  assert.equal(m.fallbackProxy.fail, 1);
  assert.equal(m.fallbackProxy.successRate, 50);
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

// ---------------------------------------------------------------- 页面没捕获到的失败

/*
 * 真实数据（logs/debug，2026-08-23）暴露的缺口：13 次失败里只有 7 次到过内容脚本。
 * 全部 7 次都是 t2.nhentai.net 的缩略图（DOM 里的真 <img>），而 i.nhentai.net 的
 * 阅读器大图一次都没有 —— 阅读器用 new Image() 预加载，不在 DOM 上的 Image 不会
 * 经过 document 的捕获阶段，内容脚本永远看不见。
 *
 * 旧实现里这类失败不产生任何计数，于是面板「未重试」显示 0，读起来像
 * 「每次失败都重试了」。它必须有自己的格子。
 */

test('网络层失败后页面一直没来问，记一次「页面没捕获」', async (t) => {
  await seed();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  await stub.emit('onBeforeRequest', { requestId: 'u-1', url: IMG_URL });
  await stub.emit('onErrorOccurred', {
    requestId: 'u-1', url: IMG_URL, error: 'net::ERR_CONNECTION_CLOSED',
  });

  assert.equal((await view()).retry.unseen, 0, '宽限期内不该下结论 —— 页面可能只是慢了几十毫秒');

  await elapse(t, RETRY_ASK_GRACE_MS + 1);
  assert.equal((await view()).retry.unseen, 1);
  assert.equal((await view()).retry.skipped, 0, '这不是「判定为不重试」，是压根没被问过');
});

test('页面在宽限期内来问了，就不算没捕获', async (t) => {
  await seed();
  // 假时钟必须在**失败落地之前**接管：expectRetryAsk 的定时器是那一刻建的，
  // 建在真时钟上的话 tick() 推不动它，这条用例就会假绿
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // askAfter 先发失败再问，所以 planRetry 当场查得到原因，不会走那 150ms 宽限
  await askAfter({ error: 'net::ERR_CONNECTION_CLOSED' });

  await elapse(t, RETRY_ASK_GRACE_MS + 1);
  assert.equal((await view()).retry.unseen, 0);
  assert.equal((await view()).retry.attempted, 1, '正常重试路径不受影响');
});

test('图源自己回 4xx 不算「页面没捕获」', async (t) => {
  // 换个代理拿到的还是同一个 404，页面捕不捕获都无所谓 ——
  // 把它算进来会让这一格变成与代理无关的噪音
  await seed();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  await stub.emit('onBeforeRequest', { requestId: 'u-2', url: IMG_URL });
  await stub.emit('onCompleted', { requestId: 'u-2', url: IMG_URL, statusCode: 404 });

  await elapse(t, RETRY_ASK_GRACE_MS + 1);
  assert.equal((await view()).retry.unseen, 0);
});

test('不归本扩展管的地址失败了，不记「页面没捕获」', async (t) => {
  await seed();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const outside = 'https://cdn.unrelated.com/logo.png';
  await stub.emit('onBeforeRequest', { requestId: 'u-3', url: outside });
  await stub.emit('onErrorOccurred', {
    requestId: 'u-3', url: outside, error: 'net::ERR_CONNECTION_CLOSED',
  });

  await elapse(t, RETRY_ASK_GRACE_MS + 1);
  assert.equal((await view()).retry.unseen, 0, '用户随手逛的任何站点的裂图都会走到这里');
});

test('页面抢在网络层之前来问，也不算没捕获', async (t) => {
  // 两条路径没有顺序保证 —— retry-coordinator 的 LOOKUP_GRACE_MS 就是为反向的
  // 那一半准备的。页面先到时，后台此刻还没开始计时，撤销无从谈起；
  // 等它开始计时了再判「没人来问」就是凭空造一个假数字
  await seed();
  await stub.emit('onBeforeRequest', { requestId: 'u-4', url: IMG_URL });

  // 刻意让询问**完整走完**再让网络层落地 —— 这是最危险的那个顺序。
  // 这一路查不到失败原因，会走 planRetry 那 150ms 宽限，所以假时钟只能在它之后接管
  await handleMessage({ type: 'imageRetryAsk', url: IMG_URL, attempt: 1 });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await stub.emit('onErrorOccurred', {
    requestId: 'u-4', url: IMG_URL, error: 'net::ERR_CONNECTION_CLOSED',
  });

  await elapse(t, RETRY_ASK_GRACE_MS + 1);
  assert.equal((await view()).retry.unseen, 0, '页面明明问过了');
});

// ---------------------------------------------------------------- 重发之后没了下文

/*
 * 真实数据里 attempted=7 / recovered=6，差的那 1 次：内容脚本 resent 之后，
 * 既没有 loaded 也没有 retry-failed，10 秒后网络层报了 ERR_ABORTED ——
 * 元素被页面换掉或导航走了，渲染进程不会再派发任何事件。
 * 内容脚本用超时兜住这种情况，回报一个「结果未知」。
 */

test('内容脚本回报「结果未知」时记 abandoned，不算救回也不算失败', async () => {
  await seed();
  await handleMessage({ type: 'imageRetryResult', url: IMG_URL, kind: 'retry', ok: null });

  const m = await view();
  assert.equal(m.retry.abandoned, 1);
  assert.equal(m.retry.recovered, 0);
  assert.equal(m.retry.exhausted, 0);
});

test('重发悬空的次数在面板上能看见', async () => {
  await seed();
  await askAfter({ error: 'net::ERR_CONNECTION_CLOSED' });
  assert.equal((await view()).retry.pending, 1, '刚重发出去，还没有结论');

  await handleMessage({ type: 'imageRetryResult', url: IMG_URL, kind: 'retry', ok: null });
  const m = await view();
  assert.equal(m.retry.pending, 0);
  assert.equal(m.retry.abandoned, 1, '结论是「不会有结论了」，也是一种结论');
});

// ---------------------------------------------------------------- 深度重试（决策 D31）

/** 走一遍「后台观测到失败 → 主世界补丁来问」的往返 */
async function askVia(via, observed, { url = IMG_URL, attempt = 1 } = {}) {
  await stub.emit('onBeforeRequest', { requestId: 'r-deep', url });
  if (observed.error) await stub.emit('onErrorOccurred', { requestId: 'r-deep', url, error: observed.error });
  else await stub.emit('onCompleted', { requestId: 'r-deep', url, statusCode: observed.statusCode });
  return handleMessage({ type: 'imageRetryAsk', url, attempt, via });
}

test('补丁问过就记 deep —— 它回答的是「补丁装上没有」，不是「重发了几次」', async () => {
  await seed();
  await askVia('fetch', { error: 'net::ERR_PROXY_CONNECTION_FAILED' });

  const m = await view();
  assert.equal(m.retry.deep, 1);
  assert.equal(m.retry.attempted, 1, 'deep 与 attempted 是正交的两格，同一次判定都要 +1');
});

test('被判定为不重试时 deep 照样 +1 —— 问过就算装上了', async () => {
  await seed();
  await askVia('xhr', { statusCode: 404 });

  const m = await view();
  assert.equal(m.retry.deep, 1);
  assert.equal(m.retry.attempted, 0);
  assert.equal(m.retry.skipped, 1);
});

test('`<img>` 那条路不记 deep', async () => {
  await seed();
  await askAfter({ error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  assert.equal((await view()).retry.deep, 0);
});

test('来路不明的 via 不记 deep，也不影响判定', async () => {
  await seed();
  const plan = await askVia('nonsense', { error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  assert.equal(plan.action, 'retry');
  assert.equal((await view()).retry.deep, 0);
});

test('fetch 用尽次数后照常给兜底 —— 传输层兜底对接口同样有效', async () => {
  // 1.4.x 的兜底是 URL 改写，把一个 JSON 接口套进 `?url=` 毫无意义，所以那时按 via 关掉了。
  // 现在兜底是「把这个源指向另一个代理」，对 fetch 与对图片没有任何区别
  await seed({ settings: { retry: { maxAttempts: 1 }, fallbackProxy: FALLBACK } });
  const plan = await askVia('fetch', { error: 'net::ERR_PROXY_CONNECTION_FAILED' });

  assert.equal(plan.action, 'fallback');
  assert.equal(plan.url, undefined, '不给页面任何新地址');

  const m = await view();
  assert.equal(m.retry.exhausted, 1);
  assert.equal(m.fallbackProxy.used, 1);
});

test('new Image() 用尽次数后照常给兜底', async () => {
  await seed({ settings: { retry: { maxAttempts: 1 }, fallbackProxy: FALLBACK } });
  const plan = await askVia('image', { error: 'net::ERR_PROXY_CONNECTION_FAILED' });

  assert.equal(plan.action, 'fallback');
  assert.equal((await view()).fallbackProxy.used, 1);
});

test('补丁来问同样撤销「页面没捕获」的判定', async () => {
  await seed();
  await askVia('image', { error: 'net::ERR_PROXY_CONNECTION_FAILED' });
  assert.equal((await view()).retry.unseen, 0, '补丁问过了，就不该再被算成「页面没捕获」');
});
