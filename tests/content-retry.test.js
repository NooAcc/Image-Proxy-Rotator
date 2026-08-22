/**
 * 内容脚本的行为契约。
 *
 * 这个文件是整套重试机制里唯一跑在页面上的部分，出错的代价也最直接：轻则重试不生效，
 * 重则把别人的站点刷成风暴、或者在兜底地址上无限套娃。而它又是最难人工复现的 ——
 * 得真的找一个代理挂掉的漫画站。所以这里用 `node:vm` 把它装进一个极小的 DOM 替身里跑，
 * 与 tests/pac-generator.test.js 执行 PAC 的手法一致：**真的执行它**，而不是断言字符串。
 *
 * 不引 jsdom：本项目零依赖，而这里要验的东西也不需要一个完整的浏览器 ——
 * 需要验的是「给 src 赋了值没有」「问了后台几次」「回报了什么」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../src/content/retry.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------- DOM 替身

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.isConnected = true;
    this.parentElement = null;
    this.removed = [];
    this.listeners = {};
    this.attrs = { };
    this._src = '';
    this._srcset = '';
    /** 每次给 src 赋值都记一笔 —— `img.src = img.src` 在真实浏览器里会重发请求 */
    this.srcWrites = [];
    this.srcsetWrites = [];
  }

  get src() { return this._src; }
  set src(value) {
    this._src = String(value);
    this.attrs.src = this._src;
    this.srcWrites.push(this._src);
  }

  get srcset() { return this._srcset; }
  set srcset(value) {
    this._srcset = String(value);
    this.attrs.srcset = this._srcset;
    this.srcsetWrites.push(this._srcset);
  }

  getAttribute(name) {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }

  removeAttribute(name) {
    this.removed.push(name);
    delete this.attrs[name];
    if (name === 'srcset') this._srcset = '';
    if (name === 'src') this._src = '';
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  /** 触发挂在这个元素上的一次性 load 监听 */
  fireLoad() {
    for (const fn of this.listeners.load ?? []) fn({ currentTarget: this });
    this.listeners.load = [];
  }

  querySelectorAll() { return this._sources ?? []; }
}

function img(url, extra = {}) {
  const el = new StubElement('img');
  el.src = url;
  el.srcWrites.length = 0; // 构造时的初始赋值不算一次重发
  el.currentSrc = url;
  return Object.assign(el, extra);
}

// ---------------------------------------------------------------- 装载

/**
 * 把内容脚本装进一个新的沙箱。
 * @param {(message: object) => object|null} respond 后台的应答
 * @returns 沙箱把手：触发 error、查看发出去的消息
 */
function mount(respond) {
  const sent = [];
  let onError = null;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    Date,
    document: {
      addEventListener(type, fn, capture) {
        // 资源加载失败的 error 不冒泡，只走捕获阶段 —— 挂错了整块功能静默失效
        assert.equal(type, 'error');
        assert.equal(capture, true, 'error 监听必须用捕获阶段，否则永远收不到');
        onError = fn;
      },
    },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          sent.push(message);
          // 后台是异步的，回调绝不能同步触发，否则测不出重入与竞态。
          // 用微任务而不是定时器纯粹是为了快：520 次预算测试若走定时器要跑七秒多
          queueMicrotask(() => callback(respond(message)));
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  runInContext(SOURCE, createContext(sandbox));
  assert.ok(onError, '脚本必须在 document 上注册 error 监听');

  return {
    sent,
    /** 触发一次资源加载失败并等它处理完 */
    fail: (target) => onError({ target }),
    asks: () => sent.filter((m) => m.type === 'imageRetryAsk'),
    results: () => sent.filter((m) => m.type === 'imageRetryResult'),
  };
}

/** 一个「永远回 retry」的后台 */
const alwaysRetry = () => ({ ok: true, action: 'retry', delayMs: 0 });
const IMG_URL = 'https://cdn.manga.com/001.jpg';
const PROXIED = 'https://wsrv.nl/?url=x';

/**
 * 沙箱里造出来的对象跨 realm，原型与宿主的 Object.prototype 不是同一个，
 * 于是 deepStrictEqual 会以「结构相同但引用不等」为由失败。只比数据。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- 该不该出手

test('只管 <img>，别的元素裂了一律不问', async () => {
  const page = mount(alwaysRetry);
  const script = new StubElement('script');
  script.src = 'https://cdn.manga.com/app.js';
  await page.fail(script);
  assert.equal(page.asks().length, 0);
});

test('非 http(s) 的图片地址不问 —— data: / blob: 没有代理可换', async () => {
  const page = mount(alwaysRetry);
  await page.fail(img('data:image/png;base64,AAAA'));
  await page.fail(img('blob:https://cdn.manga.com/abc'));
  assert.equal(page.asks().length, 0);
});

test('裂图时带上地址与第几次尝试去问后台', async () => {
  const page = mount(alwaysRetry);
  await page.fail(img(IMG_URL));
  assert.deepEqual(plain(page.asks()[0]), { type: 'imageRetryAsk', url: IMG_URL, attempt: 1 });
});

test('currentSrc 优先于 src —— srcset 选中的才是真正失败的那一个', async () => {
  const page = mount(alwaysRetry);
  const el = img('https://cdn.manga.com/small.jpg');
  el.currentSrc = 'https://cdn.manga.com/large.jpg';
  await page.fail(el);
  assert.equal(page.asks()[0].url, 'https://cdn.manga.com/large.jpg');
});

// ---------------------------------------------------------------- 重发

test('回 retry 就真的重新赋值 src，且不加任何缓存穿透参数', async () => {
  // 加参数会破坏签名 URL，而失败的响应本来就没被缓存，没有穿透的必要
  const page = mount(alwaysRetry);
  const el = img(IMG_URL);
  await page.fail(el);
  assert.deepEqual(el.srcWrites, [IMG_URL], '同值赋值也会触发一次全新的请求');
});

test('用 srcset 的图片改写 srcset —— 只动 src 不会让浏览器重选源', async () => {
  const page = mount(alwaysRetry);
  const el = img(IMG_URL, { srcset: 'https://cdn.manga.com/1x.jpg 1x' });
  el.srcsetWrites.length = 0;
  await page.fail(el);
  assert.equal(el.srcsetWrites.length, 1);
  assert.equal(el.srcWrites.length, 0);
});

test('<picture> 里的图重发要改 <source> 的 srcset，绝不能给 img.src 写空串', async () => {
  // 这是最容易写错、后果也最严重的一处：<picture> 里图片地址来自兄弟 <source>，
  // img 自己的 src 与 srcset 都是空的。此时 `img.src = img.src` 等于把 src 设成空串，
  // 那不是重试，是把这张图彻底弄没
  const page = mount(alwaysRetry);
  const source = new StubElement('source');
  source.srcset = 'https://cdn.manga.com/001.webp';
  source.srcsetWrites.length = 0;
  const picture = new StubElement('picture');
  picture._sources = [source];

  const el = new StubElement('img');
  el.currentSrc = 'https://cdn.manga.com/001.webp'; // 只有 currentSrc，src/srcset 都是空的
  el.parentElement = picture;

  await page.fail(el);
  assert.equal(source.srcsetWrites.length, 1, '改 <source> 的 srcset 才会让浏览器重跑源选择');
  assert.deepEqual(el.srcWrites, [], '绝不能碰 img.src');
});

test('只有 currentSrc、又不在 <picture> 里时，退而把 currentSrc 写回 src', async () => {
  const page = mount(alwaysRetry);
  const el = new StubElement('img');
  el.currentSrc = IMG_URL;
  await page.fail(el);
  assert.deepEqual(el.srcWrites, [IMG_URL], '至少要发得出一个有效地址，不能写空串');
});

test('尝试次数逐次递增', async () => {
  const page = mount(alwaysRetry);
  const el = img(IMG_URL);
  await page.fail(el);
  await page.fail(el);
  await page.fail(el);
  assert.deepEqual(page.asks().map((m) => m.attempt), [1, 2, 3]);
});

test('回 give-up 就什么都不做', async () => {
  const page = mount(() => ({ ok: true, action: 'give-up', reason: 'not-routed' }));
  const el = img(IMG_URL);
  await page.fail(el);
  assert.equal(el.srcWrites.length, 0);
});

test('后台没应答（扩展被重载）时安静退场，不抛异常', async () => {
  const page = mount(() => null);
  const el = img(IMG_URL);
  await page.fail(el);
  assert.equal(el.srcWrites.length, 0);
});

test('等待期间图片已被移出文档时不再重发', async () => {
  const page = mount(() => ({ ok: true, action: 'retry', delayMs: 1 }));
  const el = img(IMG_URL);
  const done = page.fail(el);
  el.isConnected = false;
  await done;
  assert.equal(el.srcWrites.length, 0, '页面都换掉了，重发只是白发一个请求');
});

// ---------------------------------------------------------------- 兜底

test('回 fallback 就把 src 换成兜底地址', async () => {
  const page = mount(() => ({ ok: true, action: 'fallback', url: PROXIED, delayMs: 0 }));
  const el = img(IMG_URL);
  await page.fail(el);
  assert.deepEqual(el.srcWrites, [PROXIED]);
  assert.ok(el.removed.includes('srcset'), 'srcset 不清掉的话它的优先级高于 src');
});

test('<picture> 里的 <source> 要先清掉，否则赋 src 根本不生效', async () => {
  const page = mount(() => ({ ok: true, action: 'fallback', url: PROXIED, delayMs: 0 }));
  const source = new StubElement('source');
  const picture = new StubElement('picture');
  picture._sources = [source];
  const el = img(IMG_URL, { parentElement: picture });

  await page.fail(el);
  assert.ok(source.removed.includes('srcset'), '<source> 的优先级高于 <img src>');
  assert.deepEqual(el.srcWrites, [PROXIED]);
});

test('兜底地址自己也失败时到此为止，绝不再问 —— 否则会无限套娃', async () => {
  const page = mount((m) => (m.type === 'imageRetryAsk'
    ? { ok: true, action: 'fallback', url: PROXIED, delayMs: 0 }
    : { ok: true }));
  const el = img(IMG_URL);
  await page.fail(el);
  assert.equal(page.asks().length, 1);

  el.currentSrc = PROXIED;
  await page.fail(el);
  assert.equal(page.asks().length, 1, '兜底失败之后不该再发起新的询问');
  assert.deepEqual(plain(page.results().at(-1)), { type: 'imageRetryResult', url: PROXIED, kind: 'fallback', ok: false });
});

// ---------------------------------------------------------------- 回报结果

test('重发成功后回报 ok，附带的是**原图**地址而不是别的什么', async () => {
  const page = mount(alwaysRetry);
  const el = img(IMG_URL);
  await page.fail(el);
  el.fireLoad();
  assert.deepEqual(plain(page.results()[0]), { type: 'imageRetryResult', url: IMG_URL, kind: 'retry', ok: true });
});

test('重发又失败时先如实回报，再继续问下一步', async () => {
  const page = mount(alwaysRetry);
  const el = img(IMG_URL);
  await page.fail(el);
  await page.fail(el);
  assert.deepEqual(plain(page.results()[0]), { type: 'imageRetryResult', url: IMG_URL, kind: 'retry', ok: false });
  assert.equal(page.asks().length, 2, '回报之后照旧继续问');
});

test('不是我们发起的那次加载失败不会回报结果', async () => {
  const page = mount(() => ({ ok: true, action: 'give-up', reason: 'not-routed' }));
  await page.fail(img(IMG_URL));
  assert.equal(page.results().length, 0);
});

test('成功之后计数清零：同一张图以后再裂，重试从头开始', async () => {
  const page = mount(alwaysRetry);
  const el = img(IMG_URL);
  await page.fail(el);
  el.fireLoad();
  await page.fail(el);
  assert.deepEqual(page.asks().map((m) => m.attempt), [1, 1]);
});

// ---------------------------------------------------------------- 防失控

test('后台说扩展已关闭之后进入冷却，不再一张张来问', async () => {
  // 扩展关着的时候，整个浏览器的每张裂图都来问一次纯属浪费
  const page = mount(() => ({ ok: true, action: 'give-up', reason: 'disabled' }));
  for (let i = 0; i < 5; i++) await page.fail(img(`${IMG_URL}?i=${i}`));
  assert.equal(page.asks().length, 1);
});

test('单页重试预算有上限，且触顶时会明确上报一次', async () => {
  // 上限是刻意设的，但绝不能悄悄生效 —— 不上报的话用户看到的是
  // 「重试到一半就不重试了」，而统计里找不到任何解释
  const page = mount(alwaysRetry);
  for (let i = 0; i < 520; i++) await page.fail(img(`${IMG_URL}?i=${i}`));

  const asks = page.asks().length;
  assert.ok(asks <= 500, `不该无上限地问下去，实际问了 ${asks} 次`);
  const budget = page.results().filter((m) => m.kind === 'budget');
  assert.equal(budget.length, 1, '触顶只报一次，但必须报');
  assert.equal(budget[0].ok, false);
});

test('同一张图正在等回复时不重入', async () => {
  const page = mount(() => ({ ok: true, action: 'retry', delayMs: 1 }));
  const el = img(IMG_URL);
  const first = page.fail(el);
  await page.fail(el);
  await first;
  assert.equal(page.asks().length, 1, '重入会让同一张图并发发出多个重试');
});
