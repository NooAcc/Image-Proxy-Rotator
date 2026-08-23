/**
 * 兜底窗口的开合、复用与冷却。
 *
 * 这个模块是「按源生效」这个取舍的落地点，而那个取舍是整套设计里最容易出错的一环：
 * 浏览器交给 PAC 的 https URL 只剩 `https://主机/`，所以「只让这一张图走兜底代理」
 * 表达不出来，只能开一扇按源生效的短窗口。窗口开合错一次的后果是安静的 ——
 * 要么整个图源被长期钉在兜底代理上（轮询失效），要么兜底根本没生效却记了一笔 used。
 *
 * 时间一律用显式的 `now` 入参驱动，不碰假时钟：这几条断言要钉的是「到点没到点」，
 * 用真时钟或 mock timers 只会让它们变成偶发失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub } from './helpers/chrome-stub.js';

installChromeStub();

const {
  openFallbackWindow,
  abortFallbackWindow,
  fallbackForceEntries,
  isFallbackWindowOpen,
  hasOpenFallbackWindow,
  nextFallbackExpiry,
  originPrefix,
  resetFallbackWindows,
} = await import('../src/background/fallback-window.js');
const { FALLBACK_WINDOW_MS, FALLBACK_COOLDOWN_MS } = await import('../src/lib/constants.js');

const IMG = 'https://i.manga.com/ch1/001.jpg';
const OTHER = 'https://t2.manga.com/ch1/001t.jpg';
const T0 = 1_700_000_000_000;

/** 一份启用了兜底代理的配置 */
const cfg = (fallbackProxy = {
  enabled: true, raw: 'http://10.0.0.3:37581', protocol: 'http', host: '10.0.0.3', port: 37581,
  username: '', password: '',
}) => ({ settings: { fallbackProxy } });

const TOKEN = 'PROXY 10.0.0.3:37581';

test.beforeEach(() => resetFallbackWindows());

// ---------------------------------------------------------------- 源前缀

test('originPrefix 把完整 URL 收敛成 PAC 认得的源前缀', () => {
  assert.equal(originPrefix(IMG), 'https://i.manga.com/');
  assert.equal(originPrefix('http://a.b:8080/x?y=1'), 'http://a.b:8080/');
});

test('无法解析的地址返回 null，而不是抛异常', () => {
  for (const bad of ['not a url', '', null, undefined]) {
    assert.equal(originPrefix(bad), null, String(bad));
  }
});

// ---------------------------------------------------------------- 开窗

test('第一次开窗返回 reused=false，调用方据此知道要注入一次 PAC', () => {
  const got = openFallbackWindow(IMG, T0);
  assert.equal(got.ok, true);
  assert.equal(got.reused, false);
  assert.equal(got.origin, 'https://i.manga.com/');
  assert.equal(got.until, T0 + FALLBACK_WINDOW_MS);
});

test('窗口开着时同源再来直接复用，不该触发第二次注入', () => {
  // 一次大面积失败会让几十张图同时用尽。每张都重注入一遍 PAC 就是自找的抖动
  openFallbackWindow(IMG, T0);
  const again = openFallbackWindow(`${IMG}?2`, T0 + 1000);
  assert.equal(again.ok, true);
  assert.equal(again.reused, true, '同一个源应当复用，而不是重开');
});

test('不同源各开各的窗，互不影响', () => {
  assert.equal(openFallbackWindow(IMG, T0).reused, false);
  assert.equal(openFallbackWindow(OTHER, T0).reused, false, '另一个源该独立开窗');
  assert.equal(isFallbackWindowOpen(IMG, T0), true);
  assert.equal(isFallbackWindowOpen(OTHER, T0), true);
});

test('无法解析的地址开不了窗', () => {
  const got = openFallbackWindow('not a url', T0);
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'bad-url');
});

// ---------------------------------------------------------------- 过期与冷却

test('窗口到点后不再算开着', () => {
  openFallbackWindow(IMG, T0);
  assert.equal(isFallbackWindowOpen(IMG, T0 + FALLBACK_WINDOW_MS - 1), true);
  assert.equal(isFallbackWindowOpen(IMG, T0 + FALLBACK_WINDOW_MS), false, '到点即失效');
});

test('窗口过期后进入冷却期，这段时间开不了新窗', () => {
  // 没有冷却，轮询池持续失败时窗口会几乎一直开着 —— 整个图源长期只走兜底代理那一个 IP
  openFallbackWindow(IMG, T0);
  const during = openFallbackWindow(IMG, T0 + FALLBACK_WINDOW_MS + 1);
  assert.equal(during.ok, false);
  assert.equal(during.reason, 'cooldown');
  assert.equal(during.until, T0 + FALLBACK_WINDOW_MS + FALLBACK_COOLDOWN_MS, '冷却从窗口关闭起算');
});

test('冷却期过完之后可以再开一扇窗', () => {
  openFallbackWindow(IMG, T0);
  const after = openFallbackWindow(IMG, T0 + FALLBACK_WINDOW_MS + FALLBACK_COOLDOWN_MS + 1);
  assert.equal(after.ok, true);
  assert.equal(after.reused, false);
});

test('一个源在冷却不影响另一个源开窗', () => {
  openFallbackWindow(IMG, T0);
  const t = T0 + FALLBACK_WINDOW_MS + 1;
  assert.equal(openFallbackWindow(IMG, t).ok, false, '这个源在冷却');
  assert.equal(openFallbackWindow(OTHER, t).ok, true, '另一个源不受牵连');
});

// ---------------------------------------------------------------- 喂给 PAC 的条目

test('开着的窗口变成一条带过期时间的强制路由', () => {
  openFallbackWindow(IMG, T0);
  const entries = fallbackForceEntries(cfg(), T0 + 1);
  assert.deepEqual(entries, [{
    pre: 'https://i.manga.com/', tok: TOKEN, until: T0 + FALLBACK_WINDOW_MS,
  }]);
});

test('过期的窗口不再进 PAC', () => {
  openFallbackWindow(IMG, T0);
  assert.deepEqual(fallbackForceEntries(cfg(), T0 + FALLBACK_WINDOW_MS + 1), []);
});

test('兜底代理没启用时一条都不产出 —— 免得往 PAC 里塞一个 null token', () => {
  openFallbackWindow(IMG, T0);
  const disabled = cfg({ enabled: false, protocol: 'http', host: '10.0.0.3', port: 37581, raw: '', username: '', password: '' });
  assert.deepEqual(fallbackForceEntries(disabled, T0 + 1), []);
});

test('配置残缺时不抛异常，只是没有条目', () => {
  openFallbackWindow(IMG, T0);
  for (const bad of [undefined, null, {}, { settings: {} }]) {
    assert.deepEqual(fallbackForceEntries(bad, T0 + 1), [], JSON.stringify(bad));
  }
});

test('多个源同时开窗时逐条产出', () => {
  openFallbackWindow(IMG, T0);
  openFallbackWindow(OTHER, T0);
  const pres = fallbackForceEntries(cfg(), T0 + 1).map((e) => e.pre).sort();
  assert.deepEqual(pres, ['https://i.manga.com/', 'https://t2.manga.com/']);
});

// ---------------------------------------------------------------- 撤回

test('注入失败时撤回窗口，连冷却一起清掉', () => {
  // 窗口记着「已开」而 PAC 里其实没有对应条目，是最糟的状态：下一张图会因为
  // 「窗口已开」直接重发，落到普通节点上却被记成一次兜底。
  // 冷却也要一起清 —— 这次压根没兜成，不该为此赔上一整个冷却期
  openFallbackWindow(IMG, T0);
  abortFallbackWindow('https://i.manga.com/');

  assert.equal(isFallbackWindowOpen(IMG, T0 + 1), false);
  assert.deepEqual(fallbackForceEntries(cfg(), T0 + 1), []);
  assert.equal(openFallbackWindow(IMG, T0 + 2).ok, true, '撤回之后应当可以立刻重试，而不是进冷却');
});

test('撤一个不存在的源不会炸', () => {
  abortFallbackWindow('https://nobody/');
  abortFallbackWindow(null);
  assert.equal(hasOpenFallbackWindow(T0), false);
});

// ---------------------------------------------------------------- 清理排程用的两个查询

test('hasOpenFallbackWindow 只认没过期的', () => {
  assert.equal(hasOpenFallbackWindow(T0), false);
  openFallbackWindow(IMG, T0);
  assert.equal(hasOpenFallbackWindow(T0 + 1), true);
  assert.equal(hasOpenFallbackWindow(T0 + FALLBACK_WINDOW_MS), false);
});

test('nextFallbackExpiry 给出最早到点的那一个，没有窗口时是 null', () => {
  assert.equal(nextFallbackExpiry(T0), null);
  openFallbackWindow(IMG, T0);
  openFallbackWindow(OTHER, T0 + 5000);
  assert.equal(nextFallbackExpiry(T0 + 5001), T0 + FALLBACK_WINDOW_MS, '取更早的那个');
});

test('resetFallbackWindows 把窗口与冷却一起清干净', () => {
  openFallbackWindow(IMG, T0);
  resetFallbackWindows();
  assert.equal(hasOpenFallbackWindow(T0 + 1), false);
  assert.equal(openFallbackWindow(IMG, T0 + 1).ok, true, '冷却也该被清掉');
});
