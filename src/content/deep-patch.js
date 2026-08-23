/**
 * 深度重试补丁 —— 主世界这一侧。
 *
 * **它做的事，正是 LIMITATIONS 第 16 节当年拒绝做的事。** 那条结论的前提是「注入到所有
 * 页面」；本文件只会被注册到用户逐条勾选的站点上（决策 D31），没勾的站点里连这段代码都
 * 不存在。风险因此从「可能把无关网站搞坏」收敛成「可能把你自己勾的那个站点搞坏」。
 *
 * 包住四个东西，它们的语义**并不一样**，别当成一回事：
 *
 * | 包住的 | 页面看得到第一次失败吗 | 说明 |
 * |---|---|---|
 * | `fetch` | **看不到** | 页面 await 的是本文件返回的 promise，第一次 reject 被吞掉 |
 * | `XMLHttpRequest` | 看得到 | error 事件是浏览器同步派发的，插不进去 |
 * | `new Image()` | 看得到 | 同上，与现有 `<img>` 重试是同一种取舍 |
 * | `document.createElement('img')` | 看得到 | 同上。**只管没挂进 DOM 的那些**，见下 |
 *
 * 后两者意味着：页面若在错误处理里做了「永久标记失败」或「自己也重试一次」，会出现双重
 * 处理。这是已知代价，写进了 LIMITATIONS。
 *
 * **只重发 GET / HEAD（决策 D33）。** 重复提交的代价不对称：漫画站的图源与列表接口几乎
 * 全是 GET，覆盖率损失极小，而一次被重发的「发评论」是用户账号上真实发生了两次的事。
 *
 * **它和 retry.js 一样刻意很笨**：不持有规则、不认识节点、不知道重试上限，也不判断失败
 * 原因（那要看 webRequest 里的真实错误码，只有后台知道）。只做三件事 —— 发现失败、
 * 隔着桥问后台该怎么办、照办并回报（决策 D21）。
 *
 * **它是 classic script，不是模块**，且必须在自己被执行的第一个同步 tick 里就完成包装：
 * 页面脚本随时可能把 `window.fetch` 取走存到别处，晚一步包上去就等于没包。
 */

(() => {
  'use strict';

  // 同一个页面被装两次（allFrames 与注册更新的时序）时只包一次。
  // 重复包装会让一次失败问后台两次，attempt 也会跳着涨
  if (window.__ppDeepRetry) return;
  window.__ppDeepRetry = true;

  // ---------------------------------------------------------------- 原件
  // 必须在最开头一次性取走：页面脚本随时可能改写这些全局对象，晚一步拿到的就是它的版本

  const nativeFetch = window.fetch;
  const NativeRequest = window.Request;
  const NativeXHR = window.XMLHttpRequest;
  const NativeImage = window.Image;
  const nativeOpen = NativeXHR && NativeXHR.prototype.open;
  const nativeSend = NativeXHR && NativeXHR.prototype.send;
  const nativeSetHeader = NativeXHR && NativeXHR.prototype.setRequestHeader;
  const nativeAbort = NativeXHR && NativeXHR.prototype.abort;
  // `document` 必须防御性地取：本文件也会被 tests/deep-patch.test.js 装进一个没有 DOM
  // 的沙箱里真的执行，而一个 ReferenceError 会让整段补丁一行都不生效
  const nativeDocument = typeof document === 'object' && document ? document : null;
  const nativeCreateElement = nativeDocument ? nativeDocument.createElement : null;
  const nativeCreateElementNS = nativeDocument ? nativeDocument.createElementNS : null;

  const nativeOn = EventTarget.prototype.addEventListener;
  const nativeOff = EventTarget.prototype.removeEventListener;
  const nativePost = window.postMessage.bind(window);
  const nativeSetTimeout = window.setTimeout.bind(window);

  // ---------------------------------------------------------------- 记账与限流

  /** 只有这两种方法会被重发（决策 D33） */
  const RETRYABLE_METHODS = ['GET', 'HEAD'];
  /** 本页最多发起多少次重发。与 retry.js 的 PAGE_BUDGET 同一种思路 */
  const PAGE_BUDGET = 500;
  /** 桥没回话时等多久放弃。桥那侧也有限流，超时是这条链路唯一的兜底 */
  const ASK_TIMEOUT_MS = 10000;
  /** 重发之后等多久还没有结论，就认定这次重发不会再有结论了（同 retry.js 的 D29） */
  const OUTCOME_TIMEOUT_MS = 25000;
  /** 跟踪中的 URL 数上限，防止长驻页面把 Map 撑大 */
  const MAX_TRACKED = 800;
  /**
   * 单次 fetch 最多循环几轮。
   *
   * 真正的上限在后台（`maxAttempts`，硬顶 10）。这一条只防一种边角：`attempts` 表撑到
   * MAX_TRACKED 被整体清空时次数会归零，后台就再也判不出「用尽」了。
   */
  const HARD_ROUND_CAP = 10;

  /** 原始 URL -> 已经尝试过几次（含首次） */
  const attempts = new Map();
  let spent = 0;

  function bumpAttempt(url) {
    if (attempts.size > MAX_TRACKED) attempts.clear();
    const next = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, next);
    return next;
  }

  /** 成功之后必须忘掉计数，否则同一张图下次再裂时会从上次的次数接着数 */
  function clearAttempt(url) {
    attempts.delete(url);
  }

  const sleep = (ms) => new Promise((resolve) => nativeSetTimeout(resolve, ms > 0 ? ms : 0));

  // ---------------------------------------------------------------- 与桥通信

  let seq = 0;
  /** 询问 id -> resolve */
  const waiting = new Map();

  nativeOn.call(window, 'message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.__ppDeep !== 1 || data.kind !== 'plan') return;
    const settle = waiting.get(data.id);
    if (settle) settle(data.plan ?? null);
  }, false);

  /**
   * 问后台这次失败该怎么办。
   * @returns {Promise<?object>} null = 别管了（桥没回话、超限、后台说 give-up）
   */
  function ask(url, attempt, via) {
    if (spent >= PAGE_BUDGET) return Promise.resolve(null);
    const id = `${++seq}`;
    return new Promise((resolve) => {
      let settled = false;
      const done = (plan) => {
        if (settled) return;
        settled = true;
        waiting.delete(id);
        resolve(plan);
      };
      waiting.set(id, done);
      try {
        nativePost({ __ppDeep: 1, kind: 'ask', id, url, attempt, via }, '*');
      } catch {
        done(null);
        return;
      }
      nativeSetTimeout(() => done(null), ASK_TIMEOUT_MS);
    });
  }

  function report(url, via, mode, ok) {
    try {
      nativePost({ __ppDeep: 1, kind: 'result', url, via, mode, ok }, '*');
    } catch {
      // 页面把 postMessage 换掉了。统计少一笔，不影响重发本身
    }
  }

  /**
   * 拿到一次重发资格。
   *
   * 独立成一个函数是因为三条路都要做同一件事，而漏掉 `spent++` 的那条路会变成
   * 「这条路上的重发不受单页上限约束」—— 一个全站裂图的页面就能打成请求风暴。
   *
   * @returns {Promise<?object>} plan；null = 不要重发
   */
  async function requestPlan(url, via) {
    if (spent >= PAGE_BUDGET) return null;
    const plan = await ask(url, bumpAttempt(url), via);
    if (!plan) return null;
    if (plan.action !== 'retry' && plan.action !== 'fallback') return null;
    spent++;
    if (plan.delayMs > 0) await sleep(plan.delayMs);
    return plan;
  }

  // ---------------------------------------------------------------- fetch

  /** 从 fetch 的入参里取出方法名。`Request` 对象与 init 都可能带 */
  function methodOf(input, init) {
    const raw = init && init.method != null
      ? init.method
      : (NativeRequest && input instanceof NativeRequest ? input.method : 'GET');
    return String(raw || 'GET').toUpperCase();
  }

  /** 从 fetch 的入参里取出绝对 URL。取不到就返回空串（那条路不干预） */
  function urlOf(input) {
    try {
      const raw = NativeRequest && input instanceof NativeRequest ? input.url : String(input);
      const absolute = new URL(raw, location.href).href;
      return /^https?:/i.test(absolute) ? absolute : '';
    } catch {
      return '';
    }
  }

  /** 主动取消不算失败：翻页时取消一批预加载是阅读器的常态 */
  function isAbort(error, signal) {
    if (signal && signal.aborted) return true;
    return Boolean(error) && (error.name === 'AbortError' || error.code === 20);
  }

  /**
   * 包住一次 fetch。
   *
   * **必须循环。** 只重发一次的话，`maxAttempts` 这个设置在 fetch 这条路上完全不起作用
   * （用户设 3，实测只发 2 个请求），而且更糟的是账对不上：重发又失败时 `ok:false` 在
   * `noteRetryOutcome` 里没有落点，后台的 `attempted` 于是永久停在 `pending` 里 ——
   * 面板上「还没有结论」只增不减。
   *
   * XHR 与 Image 天然是循环的（失败会再派发一次 error，再问一次后台），只有 fetch 这条
   * 路是补丁自己驱动的，所以循环得写在这里。上限仍然全在后台（决策 D21）：`requestPlan`
   * 每问一次 attempt 就 +1，后台一旦判定用尽就回 give-up，循环随之结束并记上 `exhausted`。
   * 外面那个 round 上限只是防御 —— `attempts` 表被撑爆清空时不该变成无限重发。
   */
  async function retryingFetch(self, input, init, url, signal) {
    let error;
    try {
      return await nativeFetch.call(self, input, init);
    } catch (first) {
      // fetch 的 reject 分不出「代理连不上」和「CORS 被拒」—— 两者都是
      // `TypeError: Failed to fetch`。真正的错误码在 webRequest 那边，
      // 所以这里不做任何分类，一律交给后台判（决策 D21 / D22）
      if (isAbort(first, signal)) throw first;
      error = first;
    }

    for (let round = 0; round < HARD_ROUND_CAP; round++) {
      const plan = await requestPlan(url, 'fetch');
      // fetch 拿到 fallback 也当放弃：兜底是图片代理，把一个 JSON 接口套进去毫无意义。
      // 后台已经按 via 关掉了兜底，这里再挡一次纯属保险
      if (!plan || plan.action !== 'retry') break;

      try {
        const response = await nativeFetch.call(self, input, init);
        clearAttempt(url);
        report(url, 'fetch', 'retry', true);
        return response;
      } catch (again) {
        error = again;
        if (isAbort(again, signal)) {
          report(url, 'fetch', 'retry', null);
          throw again;
        }
        report(url, 'fetch', 'retry', false);
      }
    }

    throw error;
  }

  if (typeof nativeFetch === 'function') {
    window.fetch = function fetch(input, init) {
      const method = methodOf(input, init);
      const url = RETRYABLE_METHODS.includes(method) ? urlOf(input) : '';
      // 没资格的一律原样转交，连一层 try 都不加 —— 少一层包装少一处出错的可能
      if (!url) return nativeFetch.call(this, input, init);
      const signal = (init && init.signal)
        || (NativeRequest && input instanceof NativeRequest ? input.signal : null);
      return retryingFetch(this, input, init, url, signal);
    };
  }

  // ---------------------------------------------------------------- 一次重发的结局

  /**
   * 给一次重发挂上「成 / 败 / 没下文」的观测，**只下一次结论**。
   *
   * load、error、超时是三条会撞车的路径，同一次重发报两个结论会让后台的
   * recovered / abandoned 一起变成假数字（决策 D24 / D29）。
   */
  function watchOutcome(target, url, via, mode) {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      nativeOff.call(target, 'load', onLoad);
      nativeOff.call(target, 'error', onError);
      if (ok === true) clearAttempt(url);
      report(url, via, mode, ok);
    };
    function onLoad() { finish(true); }
    function onError() { finish(false); }

    nativeOn.call(target, 'load', onLoad, false);
    nativeOn.call(target, 'error', onError, false);
    // 元素被页面换掉、或整页导航走之后，渲染进程不会再派发任何事件 ——
    // 没有这个超时，那次重发在后台的账上会永久悬空
    nativeSetTimeout(() => finish(null), OUTCOME_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------- XMLHttpRequest

  /** XHR 实例 -> 我们记下来的那点状态 */
  const xhrState = new WeakMap();

  function stateOf(xhr) {
    let state = xhrState.get(xhr);
    if (!state) {
      state = { method: 'GET', url: '', headers: [], aborted: false, watching: false, busy: false };
      xhrState.set(xhr, state);
    }
    return state;
  }

  async function onXhrError(xhr) {
    const state = xhrState.get(xhr);
    if (!state || state.aborted || state.busy || !state.url) return;
    // status 不为 0 说明拿到了 HTTP 响应，那不是网络层失败 —— 4xx/5xx 不重试（决策 D22）
    if (xhr.status !== 0) return;

    state.busy = true;
    try {
      const plan = await requestPlan(state.url, 'xhr');
      // 与 fetch 同理：兜底是图片代理，XHR 拿到它一律当放弃
      if (!plan || plan.action !== 'retry' || state.aborted) return;

      // open() 会把已经设过的请求头清空，所以必须把记下来的重新应用一遍。
      // withCredentials / responseType / timeout 不受 open() 影响，无需重设
      nativeOpen.call(xhr, state.method, state.url, true);
      for (const [name, value] of state.headers) {
        try {
          nativeSetHeader.call(xhr, name, value);
        } catch {
          // 非法头名（页面自己设的时候也会被拒），跳过这一条继续
        }
      }
      watchOutcome(xhr, state.url, 'xhr', 'retry');
      nativeSend.call(xhr, null);
    } finally {
      state.busy = false;
    }
  }

  if (nativeOpen && nativeSend) {
    NativeXHR.prototype.open = function open(method, url, ...rest) {
      const state = stateOf(this);
      state.method = String(method || 'GET').toUpperCase();
      try {
        state.url = new URL(String(url), location.href).href;
      } catch {
        state.url = '';
      }
      if (!/^https?:/i.test(state.url)) state.url = '';
      // open() 清空请求头，我们记的那一份也要跟着清 —— 否则重发会带上早已作废的头
      state.headers = [];
      state.aborted = false;
      return nativeOpen.call(this, method, url, ...rest);
    };

    NativeXHR.prototype.setRequestHeader = function setRequestHeader(name, value) {
      const result = nativeSetHeader.call(this, name, value);
      // 只记录真的被接受了的头：被浏览器拒掉的那些重发时也会被拒
      stateOf(this).headers.push([name, value]);
      return result;
    };

    NativeXHR.prototype.abort = function abort() {
      stateOf(this).aborted = true;
      return nativeAbort.call(this);
    };

    NativeXHR.prototype.send = function send(body) {
      const state = stateOf(this);
      if (state.url && RETRYABLE_METHODS.includes(state.method) && !state.watching) {
        state.watching = true;
        nativeOn.call(this, 'error', () => { void onXhrError(this); }, false);
      }
      return nativeSend.call(this, body);
    };
  }

  // ---------------------------------------------------------------- 游离的 img

  /**
   * 这是缺口最大的一块。
   *
   * 阅读器普遍预加载下一页，而**不挂进 DOM** 的 img 派发的 error 不经过 `document` 的
   * 捕获阶段 —— 隔离世界的 retry.js 永远看不见它。实测里这类请求占了 481 次中的 301 次，
   * 重试对它是零覆盖（LIMITATIONS 第 16 节）。
   *
   * **1.4.5 起两条创建路都包。** 早先只包 `new Image()`，理由是「createElement 出来的
   * 元素多半会被插进 DOM，届时由 retry.js 接手，两边都插手会让一次失败被问两次」。
   * 顾虑本身成立，但把整条路让出去是错的：2026-08-23 的实测里某站用
   * `document.createElement('img')` 预加载了 66 张大图，一张都不在 DOM 里 ——
   * retry.js 看不见（游离），补丁也不管（没包），两套机制之间正好漏了一条路，
   * 统计上表现为「深度重试恒为 0，而页面没捕获居高不下」。
   *
   * 分工改成按**出错那一刻连着 DOM 没有**来判：连着的归 retry.js，游离的归这里。
   * 捕获阶段本来就看不到游离元素，所以这条线不会重叠 —— 比「按创建方式分」既严密
   * 又少一个盲区。顺带把 `new Image()` 后又被 append 进 DOM 的那种双重询问也堵上了。
   */

  const imageBusy = new WeakSet();
  /** 已经挂过 error 监听的 img。两条创建路可能落到同一个元素上，挂两次就会问两次 */
  const imageWatched = new WeakSet();

  /** 给一个 img 挂上失败监听。幂等 */
  function watchImage(img) {
    if (!img || imageWatched.has(img)) return img;
    imageWatched.add(img);
    nativeOn.call(img, 'error', () => { void onImageError(img); }, false);
    return img;
  }

  function isImgTag(tag) {
    return String(tag ?? '').toLowerCase() === 'img';
  }

  async function onImageError(img) {
    if (imageBusy.has(img)) return;
    // 挂在 DOM 里的图归 retry.js。两边都插手会让一次失败问后台两次，attempt 跳着涨、
    // 上限提前用尽，而 recovered 会被记成两笔
    if (img.isConnected) return;
    const url = img.currentSrc || img.src || '';
    if (!/^https?:/i.test(url)) return;

    imageBusy.add(img);
    try {
      const plan = await requestPlan(url, 'image');
      if (!plan) return;

      if (plan.action === 'retry') {
        watchOutcome(img, url, 'image', 'retry');
        // 给 src 赋值（哪怕是同一个值）会触发 HTML 规范的 "update the image data"，
        // 于是发出一个全新的请求，PAC 轮询下标已经前进（决策 D20）
        img.src = img.src;
      } else if (plan.url) {
        // Image 是唯一能用兜底图片代理的一条路 —— 它取的确实是一张图
        watchOutcome(img, url, 'image', 'fallback');
        img.removeAttribute('srcset');
        img.src = plan.url;
      }
    } finally {
      imageBusy.delete(img);
    }
  }

  if (typeof NativeImage === 'function') {
    const PatchedImage = function Image(width, height) {
      return watchImage(new NativeImage(width, height));
    };
    // 保住 `x instanceof Image`：页面里真有代码这么判断
    PatchedImage.prototype = NativeImage.prototype;
    window.Image = PatchedImage;
  }

  // 只改 `document` 这一个实例，不动 `Document.prototype`：页面自己
  // `createHTMLDocument()` 造出来的文档与我们无关，iframe 各有各的补丁（allFrames）
  if (typeof nativeCreateElement === 'function') {
    nativeDocument.createElement = function createElement(tag, ...rest) {
      const el = nativeCreateElement.call(this, tag, ...rest);
      return isImgTag(tag) ? watchImage(el) : el;
    };
  }

  if (typeof nativeCreateElementNS === 'function') {
    nativeDocument.createElementNS = function createElementNS(ns, tag, ...rest) {
      const el = nativeCreateElementNS.call(this, ns, tag, ...rest);
      // SVG 的 `<image>` 局部名是 `image` 而不是 `img`，天然不会命中 —— 那是
      // SVGImageElement，走的是另一套加载路径，本补丁不碰
      return isImgTag(tag) ? watchImage(el) : el;
    };
  }
})();
