/**
 * 主世界补丁的行为契约。
 *
 * 这是整套深度重试里最危险的一段代码：它改写页面自己的 `fetch` / `XMLHttpRequest` /
 * `Image`，写错的代价不是「重试不生效」，而是**把用户勾选的站点搞坏**，或者把一次
 * 「发评论」重复提交出去。而它又几乎没法人工复现 —— 得真的找一个代理挂掉的漫画站。
 *
 * 所以这里照 tests/content-retry.test.js 的手法，用 `node:vm` 把它装进一个极小的替身
 * 环境里**真的执行**，而不是断言字符串（同决策 D7 的纪律）。不引 jsdom：本项目零依赖，
 * 而要验的东西也不需要一个完整的浏览器 —— 需要验的是「发了几次请求」「问没问后台」
 * 「重发时带上了什么」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../src/content/deep-patch.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------- 事件替身

/**
 * 极简 EventTarget。
 *
 * 补丁取的是 `EventTarget.prototype.addEventListener` 再 `.call(target, ...)`，
 * 所以监听器不能存在实例字段上（那样 window 这种非实例对象就挂不上），只能用
 * 以 `this` 为键的 WeakMap。
 */
const listeners = new WeakMap();

class FakeEventTarget {
  addEventListener(type, fn) {
    let map = listeners.get(this);
    if (!map) {
      map = new Map();
      listeners.set(this, map);
    }
    map.set(type, [...(map.get(type) ?? []), fn]);
  }

  removeEventListener(type, fn) {
    const map = listeners.get(this);
    if (map) map.set(type, (map.get(type) ?? []).filter((f) => f !== fn));
  }
}

/** 在某个对象上派发一个事件 */
function fire(target, type, extra = {}) {
  const map = listeners.get(target);
  for (const fn of [...(map?.get(type) ?? [])]) fn({ type, currentTarget: target, ...extra });
}

// ---------------------------------------------------------------- 装载

/**
 * 把补丁装进一个新的沙箱。
 *
 * @param {(ask: object) => ?object} respond 桥的应答：拿到 ask 消息，回一个 plan（或 null）
 * @returns 沙箱把手
 */
function mount(respond) {
  /** 补丁 postMessage 出来的全部消息 */
  const posted = [];
  /** 每次真正发出去的「网络请求」：{via, url, headers?} */
  const requests = [];

  // 假时钟。补丁给每次重发挂 25 秒超时、给每次询问挂 10 秒超时，
  // 用真定时器的话每个用例结束后都会把进程多挂半分钟
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;

  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };

  function fireDue() {
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  }

  /**
   * 让短定时器自己走完。
   * 上限取 200ms：重发前的 delayMs（用例里是 0 或 1）要走完，而 10 秒的询问超时与
   * 25 秒的结局超时**不能**被顺手触发 —— 那两条是另外几个用例要单独验的东西。
   */
  async function autoAdvance() {
    for (let round = 0; round < 16; round++) {
      await flush();
      const soon = [...timers.values()].filter((t) => t.at - now <= 200);
      if (soon.length === 0) break;
      now = Math.min(...soon.map((t) => t.at));
      fireDue();
    }
    await flush();
  }

  // ---- 网络替身 ----

  /** 每个 URL 还要失败几次；用完就成功 */
  const failures = new Map();

  function shouldFail(url) {
    const left = failures.get(url) ?? 0;
    if (left <= 0) return false;
    failures.set(url, left - 1);
    return true;
  }

  class FakeRequest {
    constructor(url, init = {}) {
      this.url = String(url);
      this.method = String(init.method ?? 'GET').toUpperCase();
      this.signal = init.signal ?? null;
    }
  }

  function fakeFetch(input, init = {}) {
    const url = input instanceof FakeRequest ? input.url : String(input);
    const method = input instanceof FakeRequest ? input.method : String(init.method ?? 'GET').toUpperCase();
    requests.push({ via: 'fetch', url, method });
    if (shouldFail(url)) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: true, url, attemptNo: requests.length });
  }

  class FakeXHR extends FakeEventTarget {
    constructor() {
      super();
      this.status = 0;
      this.readyState = 0;
    }

    open(method, url) {
      this._method = String(method).toUpperCase();
      this._url = String(url);
      this._headers = [];
    }

    setRequestHeader(name, value) {
      this._headers.push([name, value]);
    }

    send() {
      requests.push({ via: 'xhr', url: this._url, method: this._method, headers: [...this._headers] });
    }

    abort() {
      this._aborted = true;
    }
  }

  class FakeImage extends FakeEventTarget {
    constructor() {
      super();
      this._src = '';
      this.srcWrites = [];
      this.removed = [];
    }

    get src() { return this._src; }

    set src(value) {
      this._src = String(value);
      this.srcWrites.push(this._src);
      requests.push({ via: 'image', url: this._src, method: 'GET' });
    }

    removeAttribute(name) { this.removed.push(name); }
  }

  /**
   * 极简 document。
   *
   * 只需要 `createElement` / `createElementNS` 两个方法 —— 补丁会把它们就地换掉，
   * 而沙箱与 VM 共享同一个对象，所以换完之后从外面调到的就是包过的版本。
   * 造出来的 img 默认 `isConnected` 为 undefined，即「游离」：补丁该管的正是这些。
   */
  const fakeDocument = {
    createElement(tag) {
      return String(tag).toLowerCase() === 'img' ? new FakeImage() : new FakeEventTarget();
    },
    createElementNS(ns, tag) {
      return String(tag).toLowerCase() === 'img' ? new FakeImage() : new FakeEventTarget();
    },
  };

  // ---- 沙箱 ----

  const sandbox = {
    console,
    URL,
    Date,
    EventTarget: FakeEventTarget,
    location: { href: 'https://nhentai.net/g/674439/' },
    document: fakeDocument,
    fetch: fakeFetch,
    Request: FakeRequest,
    XMLHttpRequest: FakeXHR,
    Image: FakeImage,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: now + (Number(ms) || 0) });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    postMessage(data) {
      posted.push(data);
      if (data.kind !== 'ask') return;
      // respond 不是函数就代表「桥不回话」，留给「只有伪造消息进来」那几个用例
      if (typeof respond !== 'function') return;
      // 桥是异步的，回调绝不能同步触发，否则测不出重入与竞态。
      // 派发目标取 `sandbox.window` 而不是 `sandbox`：那个属性在 VM 里被设成了
      // globalThis，正是补丁挂监听器时用的那个身份
      queueMicrotask(() => {
        fire(sandbox.window, 'message', {
          source: sandbox.window,
          data: { __ppDeep: 1, kind: 'plan', id: data.id, plan: respond(data) },
        });
      });
    },
  };
  sandbox.window = sandbox;

  const ctx = createContext(sandbox);
  // `createContext(sandbox)` 之后，VM 内部的 globalThis 与外面这个 sandbox **不是同一个
  // 对象**（属性会转发，但身份不同）。而补丁是用 `nativeOn.call(window, ...)` 挂的监听器，
  // 键就是 VM 里那个 globalThis —— 从外面拿 sandbox 去派发事件会一条都收不到，
  // 于是「伪造消息进不来」那种用例会因为完全错误的原因通过。所以必须把真身取出来。
  const vmWindow = runInContext('globalThis.window = globalThis; globalThis;', ctx);
  runInContext(SOURCE, ctx, { timeout: 2000 });

  return {
    window: vmWindow,
    posted,
    requests,
    /** 让这个 URL 的前 n 次请求失败 */
    failTimes(url, n) { failures.set(url, n); },
    /** 补丁装上去之后的 fetch（可能就是原件，若补丁没包住） */
    fetch: () => vmWindow.fetch,
    newXHR: () => new vmWindow.XMLHttpRequest(),
    newImage: () => new vmWindow.Image(),
    /** `document.createElement(tag)`，走的是补丁包过的那个版本 */
    create: (tag) => vmWindow.document.createElement(tag),
    createNS: (tag) => vmWindow.document.createElementNS('http://www.w3.org/1999/xhtml', tag),
    /** 派发一个事件并把短定时器走完 */
    async emit(target, type, extra) {
      fire(target, type, extra);
      await autoAdvance();
    },
    async settle() { await autoAdvance(); },
    /** 推进假时钟到某个时刻并跑掉到期的定时器 */
    async advance(ms) {
      now += ms;
      fireDue();
      await flush();
    },
    asks: () => posted.filter((m) => m.kind === 'ask'),
    results: () => posted.filter((m) => m.kind === 'result'),
  };
}

/** 最常用的应答：一律同意重发，不等待 */
const alwaysRetry = () => ({ ok: true, action: 'retry', delayMs: 0 });
/** 一律拒绝 */
const alwaysGiveUp = () => ({ ok: true, action: 'give-up', reason: 'not-routed' });

const IMG = 'https://i.nhentai.net/galleries/674439/1.jpg';
const API = 'https://nhentai.net/api/v2/galleries/674439';

// ---------------------------------------------------------------- fetch

test('GET 的 fetch 失败一次：问后台、重发一次、页面拿到第二次的结果', async () => {
  const box = mount(alwaysRetry);
  box.failTimes(API, 1);

  const response = await box.window.fetch(API);
  await box.settle();

  assert.equal(response.ok, true, '页面拿到的应当是重发之后成功的那个响应');
  assert.equal(box.requests.length, 2, '一次原始请求 + 一次重发');
  assert.equal(box.asks().length, 1);
  assert.deepEqual(
    { url: box.asks()[0].url, attempt: box.asks()[0].attempt, via: box.asks()[0].via },
    { url: API, attempt: 1, via: 'fetch' },
  );
  assert.deepEqual(box.results().map((r) => [r.via, r.mode, r.ok]), [['fetch', 'retry', true]]);
});

test('页面完全看不到第一次失败 —— 这是 fetch 这条路唯一真正透明的地方', async () => {
  const box = mount(alwaysRetry);
  box.failTimes(API, 1);

  let caught = null;
  const response = await box.window.fetch(API).catch((e) => { caught = e; });
  await box.settle();

  assert.equal(caught, null, '第一次的 reject 必须被补丁吞掉');
  assert.equal(response.ok, true);
});

test('POST 一次都不问后台（决策 D33：重复提交的代价不对称）', async () => {
  const box = mount(alwaysRetry);
  box.failTimes(API, 1);

  await assert.rejects(() => box.window.fetch(API, { method: 'POST' }));
  await box.settle();

  assert.equal(box.asks().length, 0, '非幂等请求连问都不该问');
  assert.equal(box.requests.length, 1, '绝不能重复提交');
});

test('Request 对象上的 method 同样算 —— 方法名不只写在 init 里', async () => {
  const box = mount(alwaysRetry);
  box.failTimes(API, 1);
  const request = new box.window.Request(API, { method: 'DELETE' });

  await assert.rejects(() => box.window.fetch(request));
  await box.settle();
  assert.equal(box.asks().length, 0);
});

test('主动取消不算失败：翻页时取消一批预加载是阅读器的常态', async () => {
  const box = mount(alwaysRetry);
  box.failTimes(API, 1);

  // signal 已经处于 aborted 状态时，那次 reject 是取消而不是代理故障
  await assert.rejects(() => box.window.fetch(API, { signal: { aborted: true } }));
  await box.settle();

  assert.equal(box.asks().length, 0, 'signal 已经 aborted 时不该问后台');
  assert.equal(box.requests.length, 1);
});

test('后台说 give-up 时原样报错，且只发过一次请求', async () => {
  const box = mount(alwaysGiveUp);
  box.failTimes(API, 1);

  await assert.rejects(() => box.window.fetch(API), /Failed to fetch/);
  await box.settle();

  assert.equal(box.requests.length, 1);
  assert.equal(box.asks().length, 1);
  assert.equal(box.results().length, 0, '没有重发就没有结局可回报');
});

test('重发又失败时如实回报 false，并把错误交给页面', async () => {
  // 后台只同意一次重发，第二次就判定用尽 —— 于是「重发了一次、又失败了」是终局
  const box = mount((ask) => (ask.attempt < 2
    ? { ok: true, action: 'retry', delayMs: 0 }
    : { ok: true, action: 'give-up', reason: 'exhausted' }));
  box.failTimes(API, 5);

  await assert.rejects(() => box.window.fetch(API));
  await box.settle();

  assert.equal(box.requests.length, 2);
  assert.deepEqual(box.results().map((r) => r.ok), [false]);
});

test('fetch 拿到 fallback 也当放弃 —— 兜底是图片代理，套不住 JSON 接口', async () => {
  const box = mount(() => ({ ok: true, action: 'fallback', url: 'http://10.0.0.3:37581/?url=x', delayMs: 0 }));
  box.failTimes(API, 1);

  await assert.rejects(() => box.window.fetch(API));
  await box.settle();
  assert.equal(box.requests.length, 1, '绝不能把接口地址塞进图片代理');
});

test('桥不回话时等满超时就放弃，不会永远挂着', async () => {
  const box = mount(() => null);
  box.failTimes(API, 1);

  const promise = box.window.fetch(API);
  await box.settle();
  await box.advance(10000);
  await assert.rejects(() => promise);
  assert.equal(box.requests.length, 1);
});

// ---------------------------------------------------------------- XMLHttpRequest

test('XHR 网络失败：重新 open + send，且记下来的请求头被重新应用', async () => {
  const box = mount(alwaysRetry);
  const xhr = box.newXHR();
  xhr.open('GET', API);
  xhr.setRequestHeader('X-Reader', '1');
  xhr.send();

  await box.emit(xhr, 'error');

  assert.equal(box.asks().length, 1);
  assert.equal(box.asks()[0].via, 'xhr');
  assert.equal(box.requests.length, 2, '原始一次 + 重发一次');
  // open() 会把已经设过的请求头清空，不重新应用的话重发就是一个「裸」请求
  assert.deepEqual(box.requests[1].headers, [['X-Reader', '1']]);
  assert.equal(box.requests[1].method, 'GET');
  assert.equal(box.requests[1].url, API);
});

test('拿到了 HTTP 响应就不是网络层失败 —— 4xx/5xx 不重试（决策 D22）', async () => {
  const box = mount(alwaysRetry);
  const xhr = box.newXHR();
  xhr.open('GET', API);
  xhr.send();
  xhr.status = 404;

  await box.emit(xhr, 'error');
  assert.equal(box.asks().length, 0, '换个代理拿到的还是同一个 404');
  assert.equal(box.requests.length, 1);
});

test('POST 的 XHR 一次都不问后台', async () => {
  const box = mount(alwaysRetry);
  const xhr = box.newXHR();
  xhr.open('POST', API);
  xhr.send();

  await box.emit(xhr, 'error');
  assert.equal(box.asks().length, 0);
  assert.equal(box.requests.length, 1);
});

test('页面自己 abort 掉的 XHR 不重发', async () => {
  const box = mount(alwaysRetry);
  const xhr = box.newXHR();
  xhr.open('GET', API);
  xhr.send();
  xhr.abort();

  await box.emit(xhr, 'error');
  assert.equal(box.asks().length, 0);
});

test('XHR 重发成功后回报 true', async () => {
  const box = mount(alwaysRetry);
  const xhr = box.newXHR();
  xhr.open('GET', API);
  xhr.send();

  await box.emit(xhr, 'error');
  await box.emit(xhr, 'load');

  assert.deepEqual(box.results().map((r) => [r.via, r.ok]), [['xhr', true]]);
});

// ---------------------------------------------------------------- new Image()

test('new Image() 失败后重新赋 src —— retry.js 永远看不见这类图', async () => {
  const box = mount(alwaysRetry);
  const img = box.newImage();
  img.src = IMG;
  const before = box.requests.length;

  await box.emit(img, 'error');

  assert.equal(box.asks().length, 1);
  assert.equal(box.asks()[0].via, 'image');
  assert.equal(box.requests.length, before + 1, '给 src 赋值会触发一次全新的请求');
  assert.equal(img.srcWrites[img.srcWrites.length - 1], IMG);
});

test('Image 是唯一能走兜底图片代理的一条路 —— 它取的确实是一张图', async () => {
  const fallbackUrl = 'http://10.0.0.3:37581/?url=x';
  const box = mount(() => ({ ok: true, action: 'fallback', url: fallbackUrl, delayMs: 0 }));
  const img = box.newImage();
  img.src = IMG;

  await box.emit(img, 'error');

  assert.equal(img.srcWrites[img.srcWrites.length - 1], fallbackUrl);
  assert.ok(img.removed.includes('srcset'),
    'srcset 的优先级高于 src，不清掉的话浏览器仍会去选那个已经失败的源');
});

test('Image 重发成功后回报 true 并清掉次数，下次裂开重新从 1 数起', async () => {
  const box = mount(alwaysRetry);
  const img = box.newImage();
  img.src = IMG;

  await box.emit(img, 'error');
  await box.emit(img, 'load');
  assert.deepEqual(box.results().map((r) => [r.via, r.ok]), [['image', true]]);

  await box.emit(img, 'error');
  assert.equal(box.asks()[1].attempt, 1, '成功之后必须忘掉计数');
});

// ---------------------------------------------------------------- 游离的 img

test('createElement("img") 失败后同样重发 —— 实测里最大的那个缺口', async () => {
  // 2026-08-23 某站用 createElement 预加载了 66 张大图，一张都不在 DOM 里：
  // retry.js 看不见（游离），补丁当时也不管（只包 new Image()），两者之间漏了一整条路
  const box = mount(alwaysRetry);
  const img = box.create('img');
  img.src = IMG;
  const before = box.requests.length;

  await box.emit(img, 'error');

  assert.equal(box.asks().length, 1, 'createElement 出来的 img 也必须问后台');
  assert.equal(box.asks()[0].via, 'image');
  assert.equal(box.requests.length, before + 1);
});

test('createElementNS 造的 img 也包住 —— 换个命名空间不该逃掉', async () => {
  const box = mount(alwaysRetry);
  const img = box.createNS('img');
  img.src = IMG;

  await box.emit(img, 'error');
  assert.equal(box.asks().length, 1);
});

test('挂进 DOM 的 img 一次都不问 —— 那是 retry.js 的地盘', async () => {
  // 分工按「出错那一刻连着 DOM 没有」判，不按创建方式判。两边都插手会让一次失败
  // 问后台两次：attempt 跳着涨、上限提前用尽，recovered 也会被记成两笔
  const box = mount(alwaysRetry);
  const img = box.create('img');
  img.src = IMG;
  img.isConnected = true;
  const before = box.requests.length;

  await box.emit(img, 'error');

  assert.equal(box.asks().length, 0);
  assert.equal(box.requests.length, before, '不该重发，隔离世界那边会接手');
});

test('new Image() 之后被挂进 DOM 的，同样让给 retry.js', async () => {
  const box = mount(alwaysRetry);
  const img = box.newImage();
  img.src = IMG;
  img.isConnected = true;

  await box.emit(img, 'error');
  assert.equal(box.asks().length, 0, '早先这种元素会被问两次');
});

test('createElement 对非 img 不插手，返回值也不能被换掉', async () => {
  const box = mount(alwaysRetry);
  const div = box.create('div');

  assert.ok(div, 'createElement 必须原样返回它造出来的元素');
  await box.emit(div, 'error');
  assert.equal(box.asks().length, 0);
});

// ---------------------------------------------------------------- 通用约束

test('同一个 URL 反复失败时 attempt 递增 —— 上限由后台把守', async () => {
  const box = mount(alwaysRetry);
  const img = box.newImage();
  img.src = IMG;

  await box.emit(img, 'error');
  await box.emit(img, 'error');
  await box.emit(img, 'error');

  assert.deepEqual(box.asks().map((a) => a.attempt), [1, 2, 3]);
});

test('重发之后既没 load 也没 error 的，超时后回报「结果未知」（决策 D29）', async () => {
  const box = mount(alwaysRetry);
  const img = box.newImage();
  img.src = IMG;

  await box.emit(img, 'error');
  assert.equal(box.results().length, 0, '刚重发出去，还不该有结论');

  await box.advance(25000);
  assert.deepEqual(box.results().map((r) => r.ok), [null]);
});

test('同一次重发只下一次结论 —— 超时与 load 撞车不会报两次', async () => {
  const box = mount(alwaysRetry);
  const img = box.newImage();
  img.src = IMG;

  await box.emit(img, 'error');
  await box.emit(img, 'load');
  await box.advance(25000);

  assert.equal(box.results().length, 1, '报两次会让 recovered 与 abandoned 一起变成假数字');
});

test('页面伪造的消息进不来：没有 __ppDeep 标记就当没收到', async () => {
  // 桥保持沉默，于是这次重发的唯一变数就是那条伪造消息
  const box = mount(null);
  box.failTimes(API, 1);

  const promise = box.window.fetch(API);
  await box.settle();

  // id 是页内流水号，页面猜得到 —— 所以真正的闸门是标记与 source，不是 id
  fire(box.window, 'message', {
    source: box.window,
    data: { kind: 'plan', id: '1', plan: { action: 'retry', delayMs: 0 } },
  });
  await box.settle();
  assert.equal(box.requests.length, 1, '没有标记的消息不该触发重发');

  await box.advance(10000);
  await assert.rejects(() => promise);
});

test('别的窗口发来的消息进不来：source 不是本窗口就丢掉', async () => {
  const box = mount(null);
  box.failTimes(API, 1);

  const promise = box.window.fetch(API);
  await box.settle();

  fire(box.window, 'message', {
    source: { fake: true },
    data: { __ppDeep: 1, kind: 'plan', id: '1', plan: { action: 'retry', delayMs: 0 } },
  });
  await box.settle();
  assert.equal(box.requests.length, 1);

  await box.advance(10000);
  await assert.rejects(() => promise);
});

test('标记与 source 都对时才生效 —— 上面两条否定用例得有个对照', async () => {
  const box = mount(null);
  box.failTimes(API, 1);

  const promise = box.window.fetch(API);
  await box.settle();

  fire(box.window, 'message', {
    source: box.window,
    data: { __ppDeep: 1, kind: 'plan', id: '1', plan: { action: 'retry', delayMs: 0 } },
  });
  await box.settle();

  const response = await promise;
  assert.equal(response.ok, true);
  assert.equal(box.requests.length, 2);
});

test('装第二次不会包两次 —— 重复包装会让一次失败问后台两次', async () => {
  const box = mount(alwaysRetry);
  const wrapped = box.window.fetch;
  runInContext(SOURCE, createContext(box.window), { timeout: 2000 });
  assert.equal(box.window.fetch, wrapped, '第二次装载应当直接退场');
});

// ---------------------------------------------------------------- fetch 的重发轮数

test('fetch 会一直问到后台说停 —— maxAttempts 是后台的事，补丁不能只重发一次', async () => {
  // 后台按 attempt 决定：前两次同意重发，第三次判定用尽。
  // 补丁若只重发一次，第 3 个请求根本不会发出，用户设的「最多尝试 3 个节点」就是空话
  const box = mount((ask) => (ask.attempt < 3
    ? { ok: true, action: 'retry', delayMs: 0 }
    : { ok: true, action: 'give-up', reason: 'exhausted' }));
  box.failTimes(API, 9);

  await assert.rejects(() => box.window.fetch(API));
  await box.settle();

  assert.deepEqual(box.asks().map((a) => a.attempt), [1, 2, 3]);
  assert.equal(box.requests.length, 3, '原始 1 次 + 重发 2 次');
});

test('循环里每一次重发都单独回报结局，最后那次 give-up 才收尾', async () => {
  const box = mount((ask) => (ask.attempt < 3
    ? { ok: true, action: 'retry', delayMs: 0 }
    : { ok: true, action: 'give-up', reason: 'exhausted' }));
  box.failTimes(API, 9);

  await assert.rejects(() => box.window.fetch(API));
  await box.settle();

  // 两次重发都失败了，两笔 ok:false。少记一笔，后台的 attempted 就会永久停在
  // pending 里 —— 面板上「还没有结论」只增不减
  assert.deepEqual(box.results().map((r) => [r.via, r.ok]), [['fetch', false], ['fetch', false]]);
});

test('循环中途成功就立刻返回，不再多发一个请求', async () => {
  const box = mount(alwaysRetry);
  box.failTimes(API, 2);

  const response = await box.window.fetch(API);
  await box.settle();

  assert.equal(response.ok, true);
  assert.equal(box.requests.length, 3, '第 3 次成功，不该有第 4 次');
  assert.deepEqual(box.results().map((r) => r.ok), [false, true]);
});

test('循环期间被取消就立刻退出，不会接着重发', async () => {
  const box = mount(alwaysRetry);
  box.failTimes(API, 9);
  const signal = { aborted: false };

  const promise = box.window.fetch(API, { signal });
  await box.settle();
  const sent = box.requests.length;
  signal.aborted = true;
  await box.settle();

  await assert.rejects(() => promise);
  assert.ok(box.requests.length <= sent + 1,
    `取消之后不该继续重发，取消前 ${sent} 次、最终 ${box.requests.length} 次`);
});

test('后台一直说重发也不会无限循环 —— attempts 表被清空时的兜底', async () => {
  const box = mount(alwaysRetry);
  box.failTimes(API, 1000);

  await assert.rejects(() => box.window.fetch(API));
  await box.settle();

  assert.ok(box.requests.length <= 11,
    `硬上限是 10 轮，实际发了 ${box.requests.length} 次`);
});
