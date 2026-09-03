/**
 * 重试判定的契约。
 *
 * 这套判定是纯函数（决策 D6），所以「什么情况下该重发一次请求」这个问题可以在 Node 里
 * 逐条钉死，而不是靠在浏览器里刷漫画页去猜。
 *
 * 两条最容易写错、且写错了不会报错只会浪费流量的规则：
 *   1. **HTTP 4xx / 5xx 不重试，HTTP 429 例外**（决策 D22）——
 *      换一个代理拿到的还是同一个 404，但 429 正是“出口 IP 太密”，换出口有意义。
 *   2. **查不到失败原因时保守放弃** —— `onErrorOccurred` 与渲染进程派发 `error` 之间
 *      没有顺序保证，宁可少救一张图，也不要把每张裂图都重刷三遍。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyFailure,
  isRetriableKind,
  isRetriableAskKind,
  decideRetry,
} from '../src/lib/retry.js';

/** decideRetry 的默认入参，逐条测试只覆盖自己关心的那个字段 */
const base = {
  attempt: 1,
  kind: 'proxy',
  matched: true,
  maxAttempts: 3,
  fallbackEnabled: true,
};

// ---------------------------------------------------------------- 失败原因分类

test('代理层错误码归为 proxy，且可重试', () => {
  for (const error of [
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'net::ERR_PROXY_CERTIFICATE_INVALID',
    'net::ERR_PROXY_AUTH_UNSUPPORTED',
    'net::ERR_UNEXPECTED_PROXY_AUTH',
    'net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
  ]) {
    assert.equal(classifyFailure({ error }), 'proxy', error);
    assert.equal(isRetriableKind('proxy'), true);
  }
});

test('看门狗带来的 slow 原因被视为可重试 —— 它是主动放弃慢请求，不是网络失败', () => {
  assert.equal(isRetriableKind('slow'), true);
  assert.equal(decideRetry({ ...base, kind: 'slow', attempt: 1 }).action, 'retry');
  assert.equal(decideRetry({ ...base, kind: 'slow', attempt: 3 }).action, 'fallback');
});

test('连接层错误码归为 network，走代理时这些多半是代理侧的问题，可重试', () => {
  for (const error of [
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_ABORTED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_TIMED_OUT',
    'net::ERR_EMPTY_RESPONSE',
    'net::ERR_SSL_PROTOCOL_ERROR',
  ]) {
    assert.equal(classifyFailure({ error }), 'network', error);
  }
  assert.equal(isRetriableKind('network'), true);
});

test('HTTP 4xx / 5xx（429 除外）归为 origin，不可重试', () => {
  for (const statusCode of [400, 403, 404, 410, 500, 502, 503, 504]) {
    assert.equal(classifyFailure({ statusCode }), 'origin', `${statusCode}`);
  }
  assert.equal(isRetriableKind('origin'), false);
});

test('HTTP 429 是站点限流，换一个出口 IP 再取一次是有意义的', () => {
  assert.equal(classifyFailure({ statusCode: 429 }), 'rate-limit');
  assert.equal(isRetriableKind('rate-limit'), true);
  assert.equal(decideRetry({ ...base, kind: 'rate-limit', attempt: 1 }).action, 'retry');
});

test('407 是代理要求认证，归为 proxy 而不是 origin', () => {
  // 状态码看着像站点的错，实际是代理没认证成功 —— 换一个代理是有意义的
  assert.equal(classifyFailure({ statusCode: 407 }), 'proxy');
});

test('ERR_ABORTED 归为 aborted；页面仍能捕获到图片失败时允许重试', () => {
  assert.equal(classifyFailure({ error: 'net::ERR_ABORTED' }), 'aborted');
  assert.equal(isRetriableKind('aborted'), true);
  assert.equal(isRetriableAskKind('aborted'), false,
    '纯导航取消不该触发后台的「页面没捕获」计时 —— 那格是结构性盲区，不是取消');
  assert.equal(decideRetry({ ...base, kind: 'aborted', attempt: 1 }).action, 'retry');
});

test('代理故障与 429 都值得等待页面来问，进 unseen 计时', () => {
  assert.equal(isRetriableAskKind('proxy'), true);
  assert.equal(isRetriableAskKind('rate-limit'), true);
});

test('被其他扩展、策略或响应拦下的请求归为 blocked，不可重试', () => {
  for (const error of [
    'net::ERR_BLOCKED_BY_CLIENT',
    'net::ERR_BLOCKED_BY_ADMINISTRATOR',
    'net::ERR_BLOCKED_BY_RESPONSE',
  ]) {
    assert.equal(classifyFailure({ error }), 'blocked', error);
  }
  assert.equal(isRetriableKind('blocked'), false);
});

test('没见过的错误码归为 other，保守不重试', () => {
  assert.equal(classifyFailure({ error: 'net::ERR_SOMETHING_BRAND_NEW' }), 'other');
  assert.equal(isRetriableKind('other'), false);
});

test('成功的状态码归为 ok；什么都没有时是 unknown —— 两者都不重试', () => {
  assert.equal(classifyFailure({ statusCode: 200 }), 'ok');
  assert.equal(classifyFailure({ statusCode: 304 }), 'ok');
  assert.equal(classifyFailure({}), 'unknown');
  assert.equal(classifyFailure(null), 'unknown');
  assert.equal(isRetriableKind('ok'), false);
  assert.equal(isRetriableKind('unknown'), false);
});

// ---------------------------------------------------------------- 决策

test('代理层失败且次数没用尽 → 重试', () => {
  const out = decideRetry({ ...base, attempt: 1 });
  assert.equal(out.action, 'retry');
});

test('maxAttempts=3 时第 3 次失败后不再重试，改走兜底', () => {
  assert.equal(decideRetry({ ...base, attempt: 1 }).action, 'retry');
  assert.equal(decideRetry({ ...base, attempt: 2 }).action, 'retry');
  const third = decideRetry({ ...base, attempt: 3 });
  assert.equal(third.action, 'fallback');
  // 1.5.0 起兜底是传输层的：后台把该源临时指向兜底代理，页面原地重发同一个地址。
  // 判定层因此不该产出任何地址 —— 会产出地址的那一版是 URL 改写型兜底
  assert.equal(third.url, undefined, '兜底不再改写地址');
});

test('maxAttempts=1 表示不重试，第一次失败就直接走兜底', () => {
  const out = decideRetry({ ...base, attempt: 1, maxAttempts: 1 });
  assert.equal(out.action, 'fallback');
});

test('没配兜底时用尽次数即放弃，理由是 exhausted', () => {
  const out = decideRetry({ ...base, attempt: 3, fallbackEnabled: false });
  assert.equal(out.action, 'give-up');
  assert.equal(out.reason, 'exhausted');
});

test('兜底那一次也失败之后不再套娃 —— attempt 超过上限就只能放弃', () => {
  // 防递归靠次数，不靠地址形状。1.4.x 用 isProxiedUrl 判「这个地址是不是兜底服务给的」，
  // 那是 URL 改写型兜底才需要的；现在地址从头到尾没变过，只能看 attempt
  const out = decideRetry({ ...base, attempt: 4 });
  assert.equal(out.action, 'give-up');
  assert.equal(out.reason, 'exhausted');
});

test('URL 不匹配任何规则时完全不干预', () => {
  // 不是本扩展路由出去的图，裂了也与我们无关 —— 重刷它纯属给别人的站点添乱
  const out = decideRetry({ ...base, matched: false });
  assert.equal(out.action, 'give-up');
  assert.equal(out.reason, 'not-routed');
});

test('失败原因不是代理故障时不重试，理由能区分开', () => {
  assert.equal(decideRetry({ ...base, kind: 'origin' }).reason, 'not-proxy-failure');
  assert.equal(decideRetry({ ...base, kind: 'blocked' }).reason, 'not-proxy-failure');
  assert.equal(decideRetry({ ...base, kind: 'unknown' }).reason, 'unknown-cause');
  for (const kind of ['origin', 'blocked', 'unknown']) {
    assert.equal(decideRetry({ ...base, kind }).action, 'give-up');
  }
});

test('原因不明时即使已经用尽次数也不走兜底', () => {
  // 「查不到原因」不等于「代理挂了」。把它当成代理故障会让每张 404 的图都去兜底
  // 服务上再取一次，白白把图源地址交给第三方
  const out = decideRetry({ ...base, attempt: 3, kind: 'unknown' });
  assert.equal(out.action, 'give-up');
  assert.equal(out.reason, 'unknown-cause');
});

test('判定层不看地址 —— 同一个 URL 反复进来，结论只由 attempt 决定', () => {
  // 1.4.x 的兜底会把地址改写成 `兜底服务/?url=原图`，于是判定层必须认出「这已经是
  // 兜底地址了」才能防住套娃。现在地址从头到尾没变过，判定层压根不需要 url 这个入参 ——
  // 这条用来钉住那个简化：传不传 url 都不该影响结论
  assert.equal(decideRetry({ ...base, attempt: 3 }).action, 'fallback');
  assert.equal(decideRetry({ ...base, attempt: 3, url: 'https://whatever/x.jpg' }).action, 'fallback');
  assert.equal(decideRetry({ ...base, attempt: 4 }).action, 'give-up');
});

test('attempt 非法时按第一次处理，不会因为脏输入直接放弃', () => {
  for (const attempt of [0, -5, NaN, undefined, 'x']) {
    assert.equal(decideRetry({ ...base, attempt }).action, 'retry', `${attempt}`);
  }
});
