/**
 * 桥的信任边界。
 *
 * 桥是深度重试里唯一同时接触「页面」与「扩展」的地方，也是整个设计的安全边界。
 * 它收到的每一条消息都来自主世界 —— 而主世界与页面脚本共享同一个 JS 环境，任何在
 * 补丁里生成的密钥页面同样读得到（决策 D32：所以不做 nonce，只做校验 + 限流）。
 *
 * 这里验的就是这套校验：形状对不上的一律丢弃，页面刷不动后台。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../src/content/deep-bridge.js', import.meta.url), 'utf8');

/**
 * 把桥装进沙箱。
 * @param {(message: object) => ?object} respond 后台的应答
 */
function mount(respond) {
  /** 桥发给后台的消息 */
  const sent = [];
  /** 桥回给主世界的消息 */
  const replies = [];
  const handlers = [];

  const sandbox = {
    console,
    postMessage(data) { replies.push(data); },
    addEventListener(type, fn) {
      if (type === 'message') handlers.push(fn);
    },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          sent.push(message);
          // 后台是异步的，回调绝不能同步触发
          queueMicrotask(() => callback(respond(message)));
        },
      },
    },
  };
  sandbox.window = sandbox;

  const ctx = createContext(sandbox);
  const vmWindow = runInContext('globalThis.window = globalThis; globalThis;', ctx);
  runInContext(SOURCE, ctx, { timeout: 2000 });

  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };

  return {
    sent,
    replies,
    /** 模拟主世界（或页面）发来一条消息 */
    async post(data, source = vmWindow) {
      for (const fn of handlers) fn({ source, data });
      await flush();
    },
  };
}

const plan = { ok: true, action: 'retry', delayMs: 300 };
const ask = (extra = {}) => ({
  __ppDeep: 1, kind: 'ask', id: '1', url: 'https://i.nhentai.net/x.jpg', via: 'image', ...extra,
});

/**
 * 把沙箱里造出来的对象搬回本 realm。
 *
 * `node:assert/strict` 的 deepEqual 就是 deepStrictEqual，而它连原型都比 —— VM 里
 * 造的对象原型是那个 realm 的 Object.prototype，结构一模一样也判不等。
 */
const plain = (value) => (value && typeof value === 'object' ? { ...value } : value);

test('形状正确的询问被转给后台，plan 原样回给主世界', async () => {
  const bridge = mount(() => plan);
  await bridge.post(ask({ attempt: 2 }));

  assert.deepEqual(bridge.sent.map(plain), [{
    type: 'imageRetryAsk', url: 'https://i.nhentai.net/x.jpg', attempt: 2, via: 'image',
  }]);
  assert.deepEqual(bridge.replies.map(plain), [{ __ppDeep: 1, kind: 'plan', id: '1', plan }]);
});

test('没有 __ppDeep 标记的消息一律不理，连回都不回', async () => {
  const bridge = mount(() => plan);
  await bridge.post({ kind: 'ask', id: '1', url: 'https://i.nhentai.net/x.jpg', via: 'image' });

  assert.deepEqual(bridge.sent, []);
  assert.deepEqual(bridge.replies, []);
});

test('别的窗口发来的消息一律不理', async () => {
  const bridge = mount(() => plan);
  await bridge.post(ask(), { notWindow: true });
  assert.deepEqual(bridge.sent, []);
});

test('非 http(s) 的地址不转发 —— 后台没有理由收到 javascript: 之类', async () => {
  const bridge = mount(() => plan);
  await bridge.post(ask({ url: 'javascript:alert(1)' }));

  assert.deepEqual(bridge.sent, []);
  assert.deepEqual(bridge.replies.map(plain), [{ __ppDeep: 1, kind: 'plan', id: '1', plan: null }],
    '不转发也要回一句，否则补丁那侧要白等满超时');
});

test('超长地址不转发', async () => {
  const bridge = mount(() => plan);
  await bridge.post(ask({ url: `https://a.com/${'x'.repeat(5000)}` }));
  assert.deepEqual(bridge.sent, []);
});

test('来路不明的 via 不转发 —— 它决定后台开不开兜底', async () => {
  const bridge = mount(() => plan);
  await bridge.post(ask({ via: 'anything' }));
  assert.deepEqual(bridge.sent, []);
});

test('脏 attempt 被夹成合法值，而不是原样带给后台', async () => {
  const bridge = mount(() => plan);
  await bridge.post(ask({ attempt: -5 }));
  assert.equal(bridge.sent[0].attempt, 1);

  await bridge.post(ask({ attempt: 1e9 }));
  assert.equal(bridge.sent[1].attempt, 1);
});

test('后台回 null（扩展被重载）时也要回一句，不让补丁挂着', async () => {
  const bridge = mount(() => null);
  await bridge.post(ask());
  assert.deepEqual(bridge.replies.map(plain), [{ __ppDeep: 1, kind: 'plan', id: '1', plan: null }]);
});

test('结局回报转成 imageRetryResult，mode 只认 retry / fallback', async () => {
  const bridge = mount(() => ({ ok: true }));
  await bridge.post({ __ppDeep: 1, kind: 'result', url: 'https://i.nhentai.net/x.jpg', via: 'image', mode: 'fallback', ok: true });
  await bridge.post({ __ppDeep: 1, kind: 'result', url: 'https://i.nhentai.net/x.jpg', via: 'fetch', mode: 'budget', ok: false });

  assert.deepEqual(bridge.sent.map((m) => [m.type, m.kind, m.ok]), [
    ['imageRetryResult', 'fallback', true],
    // `budget` 是 retry.js 专用的口径，不能从这座桥进来冒充
    ['imageRetryResult', 'retry', false],
  ]);
});

test('「结果未知」要作为 null 传下去，不能被压成 false', async () => {
  const bridge = mount(() => ({ ok: true }));
  await bridge.post({ __ppDeep: 1, kind: 'result', url: 'https://i.nhentai.net/x.jpg', via: 'xhr', mode: 'retry', ok: null });
  assert.equal(bridge.sent[0].ok, null, 'null 与 false 在统计里是两个格子（决策 D29）');
});

test('页面把桥当放大器猛刷时，超过单页上限就只回空 plan', async () => {
  const bridge = mount(() => plan);
  for (let i = 0; i < 520; i++) await bridge.post(ask({ id: `${i}` }));

  assert.equal(bridge.sent.length, 500, '单页上限是 500 次，多出来的不该打到后台');
  assert.equal(bridge.replies.length, 520, '被拒的也要回一句');
  assert.equal(bridge.replies[519].plan, null);
});
