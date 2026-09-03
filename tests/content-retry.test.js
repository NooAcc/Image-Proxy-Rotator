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
 * @param {{debug?: boolean}} options debug 为真时替身让 storage.local 报告「调试日志已开启」
 * @returns 沙箱把手：触发 error、查看发出去的消息
 */
function mount(respond, options = {}) {
  const sent = [];
  const docHandlers = {};
  let onError = null;

  /**
   * 假时钟。**必须接管** setTimeout：内容脚本为每次重发挂一个 25 秒的「没下文」超时，
   * 用真定时器的话每个用例结束后都会把进程多挂 25 秒。
   */
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;

  /**
   * `fail()` 之后自动推进的上限。
   *
   * 取 100ms 是刻意的：重发前的 delayMs（用例里是 0 或 1）要自动走完，
   * 而调试日志的 1 秒攒批定时器与 25 秒超时**不能**被顺手触发 ——
   * 那两条正是另外几个用例要单独验的东西。
   */
  const AUTO_ADVANCE_MS = 100;

  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  /** 跑掉此刻已到期的定时器 */
  function fireDue() {
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  }

  /** 让短定时器自己走完，好让用例只 await 一次就看到最终状态 */
  async function autoAdvance() {
    for (let round = 0; round < 12; round++) {
      await flush();
      const soon = [...timers.values()].filter((t) => t.at - now <= AUTO_ADVANCE_MS);
      if (soon.length === 0) break;
      now = Math.min(...soon.map((t) => t.at));
      fireDue();
    }
    await flush();
  }

  const sandbox = {
    console,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: now + (Number(ms) || 0) });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    URL,
    Date,
    document: {
      visibilityState: 'visible',
      addEventListener(type, fn, capture) {
        if (type === 'error') {
          // 资源加载失败的 error 不冒泡，只走捕获阶段 —— 挂错了整块功能静默失效
          assert.equal(capture, true, 'error 监听必须用捕获阶段，否则永远收不到');
          onError = fn;
          return;
        }
        docHandlers[type] = fn;
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
      storage: {
        local: {
          get(_key, callback) {
            const got = {};
            if (options.debug) got.debug = { enabled: true };
            if (_key === 'config' || _key == null) {
              got.config = {
                settings: { retry: { slowTimeoutMs: options.watchdogMs ?? 0 } },
              };
            }
            callback(got);
          },
        },
        onChanged: { addListener() {} },
      },
    },
  };
  sandbox.globalThis = sandbox;
  runInContext(SOURCE, createContext(sandbox));
  assert.ok(onError, '脚本必须在 document 上注册 error 监听');

  const fireDoc = (type, target) => {
    const fn = docHandlers[type];
    assert.ok(fn, `document 上必须注册 ${type} 监听`);
    fn({ target });
  };

  return {
    sent,
    /** 触发一次资源加载失败并等它处理完（含重发前的短等待） */
    fail: (target) => {
      const done = onError({ target });
      return autoAdvance().then(() => done);
    },
    asks: () => sent.filter((m) => m.type === 'imageRetryAsk'),
    results: () => sent.filter((m) => m.type === 'imageRetryResult'),
    debugRows: () => sent.filter((m) => m.type === 'debugPush').flatMap((m) => m.rows),
    /** 把页面切到后台，逼出收尾那一批 */
    hide: () => {
      sandbox.document.visibilityState = 'hidden';
      docHandlers.visibilitychange?.();
    },
    /** 触发一次 document 捕获阶段的事件（loadstart / load / abort） */
    fireDoc,
    start: (target) => fireDoc('loadstart', target),
    loaded: (target) => fireDoc('load', target),
    aborted: (target) => fireDoc('abort', target),
    /** 明确推进假时钟，跑掉到期的定时器（验超时那几条用） */
    tick: async (ms) => {
      now += ms;
      fireDue();
      await autoAdvance();
    },
  };
}

/** 一个「永远回 retry」的后台 */
const alwaysRetry = () => ({ ok: true, action: 'retry', delayMs: 0 });
const IMG_URL = 'https://cdn.manga.com/001.jpg';

/**
 * 沙箱里造出来的对象跨 realm，原型与宿主的 Object.prototype 不是同一个，
 * 于是 deepStrictEqual 会以「结构相同但引用不等」为由失败。只比数据。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 「重发多久没下文就认定不会有下文」的时长。
 *
 * 它只活在内容脚本里 —— 那是 classic script，import 不进来（见该文件头部说明），
 * 所以这里从源码里取出来，两边永远不会各写一个数。
 */
const RETRY_OUTCOME_TIMEOUT_MS = Number(/RETRY_OUTCOME_TIMEOUT_MS = (\d+)/.exec(SOURCE)?.[1]);
assert.ok(RETRY_OUTCOME_TIMEOUT_MS > 0, '内容脚本里必须定义 RETRY_OUTCOME_TIMEOUT_MS');

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

// ---------------------------------------------------------------- 慢图看门狗

test('看门狗开启时，图片超过阈值仍没加载完就带 cause:"slow" 问后台并换节点', async () => {
  const page = mount(alwaysRetry, { watchdogMs: 1000 });
  const el = img(IMG_URL);
  page.start(el);

  await page.tick(800);
  assert.equal(page.asks().length, 0, '没到阈值不动手，大图只是慢不是坏');

  await page.tick(201);
  assert.equal(page.asks().length, 1);
  assert.deepEqual(plain(page.asks()[0]),
    { type: 'imageRetryAsk', url: IMG_URL, attempt: 1, cause: 'slow' });
  assert.deepEqual(el.srcWrites, [IMG_URL], '超时后要重新赋值 src，下一次 PAC 轮询会换节点');
});

test('看门狗关闭时只等事件，不主动打断慢图', async () => {
  const page = mount(alwaysRetry, { watchdogMs: 0 });
  const el = img(IMG_URL);
  page.start(el);

  await page.tick(60000);
  assert.equal(page.asks().length, 0);
  assert.equal(el.srcWrites.length, 0);
});

test('图片在阈值前加载完成，看门狗不再问', async () => {
  const page = mount(alwaysRetry, { watchdogMs: 1000 });
  const el = img(IMG_URL);
  page.start(el);
  page.loaded(el);

  await page.tick(2000);
  assert.equal(page.asks().length, 0);
});

test('看门狗重发后如果新节点也慢，尝试次数继续递增而不是从头数', async () => {
  const page = mount(alwaysRetry, { watchdogMs: 1000 });
  const el = img(IMG_URL);
  page.start(el);

  await page.tick(1001);
  assert.equal(page.asks().length, 1);
  assert.equal(el.srcWrites.length, 1, '前提：第一次看门狗已经换过节点');

  await page.tick(1001);
  assert.equal(page.asks().length, 2);
  assert.equal(page.asks()[1].attempt, 2, '第二次慢加载不能把第一次的尝试次数清零');
});

test('后台对慢请求回 give-up 时不打断原请求，让它自己继续等', async () => {
  const page = mount(() => ({ ok: true, action: 'give-up', reason: 'exhausted' }), { watchdogMs: 1000 });
  const el = img(IMG_URL);
  page.start(el);

  await page.tick(1001);
  assert.equal(page.asks()[0].cause, 'slow');
  assert.equal(el.srcWrites.length, 0, '没有可换的节点时，原请求还挂着，不该被我们清掉');
});

test('自己换节点触发的旧请求 abort/error 不再多问一次', async () => {
  const page = mount(alwaysRetry, { watchdogMs: 1000 });
  const el = img(IMG_URL);
  page.start(el);

  await page.tick(1001);
  assert.equal(el.srcWrites.length, 1, '前提：第一次超时已经触发重发');

  // 重新赋值 src 会中止旧请求；这个 error 是我们自己造成的，不是新节点失败
  await page.fail(el);
  assert.equal(page.asks().length, 1, '旧请求的失败不该再消耗一次重试');
  assert.equal(el.srcWrites.length, 1);

  page.start(el); // 新请求正式开始
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

test('回 fallback 就原地重发 —— 兜底是传输层的，页面这侧不改地址', async () => {
  // 1.4.x 的兜底会把 src 换成 `兜底服务/?url=原图`；1.5.0 起后台把这个源临时指向
  // 兜底代理，页面要做的和普通重发一模一样。地址一旦被改写，重发就不再是同一张图了
  const page = mount(() => ({ ok: true, action: 'fallback', delayMs: 0 }));
  const el = img(IMG_URL);
  await page.fail(el);
  assert.deepEqual(el.srcWrites, [IMG_URL], '重发的必须还是原图地址');
  assert.ok(!el.removed.includes('srcset'), '不再需要清 srcset —— 那是改写地址时才要做的事');
});

test('兜底与重试走同一条重发路径 —— <picture> 之类的处理不会有两套', async () => {
  const page = mount(() => ({ ok: true, action: 'fallback', delayMs: 0 }));
  const source = new StubElement('source');
  source.srcset = 'https://cdn.manga.com/001.webp';
  source.srcsetWrites.length = 0;
  const picture = new StubElement('picture');
  picture._sources = [source];
  const el = img(IMG_URL, { parentElement: picture });
  el.src = '';
  el.currentSrc = 'https://cdn.manga.com/001.webp';
  el.srcWrites.length = 0;

  await page.fail(el);
  assert.equal(source.srcsetWrites.length, 1, '与重试同样改 <source> 的 srcset');
  assert.equal(el.srcWrites.length, 0, '绝不能给 img.src 写空串');
});

test('兜底那一次也失败时到此为止，绝不再问 —— 否则会没完没了', async () => {
  const page = mount((m) => (m.type === 'imageRetryAsk'
    ? { ok: true, action: 'fallback', delayMs: 0 }
    : { ok: true }));
  const el = img(IMG_URL);
  await page.fail(el);
  assert.equal(page.asks().length, 1);

  // 地址从头到尾没变过，所以「别再问了」只能靠上一轮的 mode 判定
  await page.fail(el);
  assert.equal(page.asks().length, 1, '兜底失败之后不该再发起新的询问');
  assert.deepEqual(plain(page.results().at(-1)),
    { type: 'imageRetryResult', url: IMG_URL, kind: 'fallback', ok: false });
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

// ---------------------------------------------------------------- 调试日志（页面侧）

test('开关关着时页面侧一行调试日志都不发', async () => {
  const page = mount(alwaysRetry);
  await page.fail(img(IMG_URL));
  assert.deepEqual(page.debugRows(), []);
});

test('开关开着时把重试链的页面那半截回传给后台', async () => {
  const page = mount(alwaysRetry, { debug: true });
  await page.fail(img(IMG_URL));
  page.hide(); // 不足一批，靠切后台逼出收尾 flush

  const rows = plain(page.debugRows());
  assert.ok(rows.length > 0, '页面侧存不住东西，不回传就等于没有');
  assert.ok(rows.every((r) => r.ns === 'content'), '命名空间必须是 content');
  const events = rows.map((r) => r.ev);
  assert.ok(events.includes('caught'), '捕获到裂图这一刻要记');
  assert.ok(events.includes('resent'), '真的重新赋值了 src 也要记 —— 后台看不到这一步');
  assert.equal(rows.find((r) => r.ev === 'caught').data.url, IMG_URL);
});

test('页面切后台时把攒着的那批发出去，不等定时器', async () => {
  const page = mount(alwaysRetry, { debug: true });
  await page.fail(img(IMG_URL));
  const before = page.debugRows().length;
  page.hide();
  assert.ok(page.debugRows().length > before, '切后台没 flush 的话，导航走了这批就没了');
});

// ---------------------------------------------------------------- 重发之后没了下文

/*
 * 真实数据（logs/debug，2026-08-23）里的悬空案例：内容脚本 resent 之后，既没有
 * loaded 也没有 retry-failed，10 秒后网络层报了 ERR_ABORTED —— 元素被页面换掉或
 * 导航走了，渲染进程不会再在它上面派发任何事件。
 *
 * 于是后台的 attempted 永久悬空：attempted=7 / recovered=6，差的那 1 次
 * 在面板上无处可查。内容脚本必须自己兜住这种「不会再有结论」的情况。
 */

test('重发之后既没 load 也没 error，超时后回报「结果未知」', async () => {
  const page = mount(alwaysRetry);
  const el = img(IMG_URL);
  await page.fail(el);
  assert.equal(el.srcWrites.length, 1, '前提：确实重发了');

  await page.tick(RETRY_OUTCOME_TIMEOUT_MS + 1);

  assert.deepEqual(plain(page.results().at(-1)),
    { type: 'imageRetryResult', url: IMG_URL, kind: 'retry', ok: null },
    'ok 必须是 null —— 它既不是救回也不是失败，是「不会有结论了」');
});

test('超时之前不下结论 —— 真实请求最慢观测到 18 秒', async () => {
  const page = mount(alwaysRetry);
  await page.fail(img(IMG_URL));

  await page.tick(RETRY_OUTCOME_TIMEOUT_MS - 1000);
  assert.equal(page.results().length, 0, '只是慢，不是没了下文');
});

test('已经收到 load 就不再回报「结果未知」', async () => {
  const page = mount(alwaysRetry);
  const el = img(IMG_URL);
  await page.fail(el);
  el.fireLoad();

  await page.tick(RETRY_OUTCOME_TIMEOUT_MS + 1);
  const results = page.results();
  assert.equal(results.length, 1, '一次重发只该有一个结论');
  assert.equal(results[0].ok, true);
});

test('重发又失败之后不再补一条「结果未知」', async () => {
  // 第二次 error 走 onResourceError 的「上一轮是我们发起的」分支，已经如实回报过
  // 一次 false。超时若再补一条，同一次重发就有了两个结论，
  // 后台的 recovered / abandoned 会一起变成假数字
  let asked = 0;
  const page = mount(() => (++asked === 1
    ? { ok: true, action: 'retry', delayMs: 0 }
    : { ok: true, action: 'give-up', reason: 'exhausted' }));
  const el = img(IMG_URL);

  await page.fail(el);
  await page.fail(el);
  assert.deepEqual(page.results().map((r) => r.ok), [false]);

  await page.tick(RETRY_OUTCOME_TIMEOUT_MS + 1);
  assert.deepEqual(page.results().map((r) => r.ok), [false], '超时不该再补一条');
});

test('页面切到后台时，悬空的重发立刻结算', async () => {
  // 导航走是这类悬空最常见的成因。等满超时往往等不到 —— 页面已经卸载了
  const page = mount(alwaysRetry);
  await page.fail(img(IMG_URL));
  assert.equal(page.results().length, 0);

  page.hide();
  for (let i = 0; i < 8; i++) await Promise.resolve();

  assert.deepEqual(plain(page.results().at(-1)),
    { type: 'imageRetryResult', url: IMG_URL, kind: 'retry', ok: null });
});

test('兜底那一路同样会兜住悬空', async () => {
  const page = mount(() => ({ ok: true, action: 'fallback', delayMs: 0 }));
  await page.fail(img(IMG_URL));

  await page.tick(RETRY_OUTCOME_TIMEOUT_MS + 1);
  assert.deepEqual(plain(page.results().at(-1)),
    { type: 'imageRetryResult', url: IMG_URL, kind: 'fallback', ok: null });
});
