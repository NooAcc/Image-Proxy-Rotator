/**
 * 图片重试 —— 页面侧的执行端。
 *
 * **为什么必须有这个文件。** 扩展没有任何办法拦下一个正在失败的请求并改写它的代理：
 * MV3 收走了阻塞式 webRequest（`webRequestBlocking` 只对 policy 强制安装的扩展开放），
 * `declarativeNetRequest` 只能改 URL 不能改传输层，Service Worker 自己的 `fetch` 指定
 * 不了代理，`onErrorOccurred` 是纯观测的、通知到手时请求已经死了。所以「换个代理重发
 * 一次」只能由页面里的代码做 —— 重新给 `<img>` 赋值 `src` 会发一个全新的请求，浏览器
 * 因此重新调用一次 PAC，轮询下标已经前进，而刚刚连不上的那个代理也已经被 Chromium
 * 自己的坏代理列表排除掉了（决策 D20）。
 *
 * **这个文件刻意很笨。** 它不持有任何规则、不认识节点、不知道重试上限是多少，
 * 只做三件事：发现 `<img>` 裂了、问后台该怎么办、照办并回报结果（决策 D21）。
 * 规则一改，页面里的副本就过期了，而过期的表现是「重试悄悄按旧规则在跑」——
 * 又一种不会报错的静默故障。
 *
 * **它是 classic script，不是模块。** MV3 的 content_scripts 不支持 ESM，
 * 所以这里一个 import 都不能有，常量只能重复一份。
 *
 * 覆盖面（已知缺口，见 docs/LIMITATIONS.md）：只有 `<img>` 会派发可捕获的 error。
 * CSS 背景图、canvas、以及页面 JS 用 fetch/XHR 取 blob 的阅读器都救不回来。
 */

(() => {
  'use strict';

  /** 本页最多发起多少次重试。防止一个全站裂图的页面把请求打成风暴 */
  const PAGE_BUDGET = 500;
  /** 同时挂起的询问数上限。超出的直接放弃，不排队 —— 排队只会让裂图停留更久 */
  const MAX_INFLIGHT = 16;
  /** 跟踪中的 URL 数上限，防止长驻页面把 Map 撑大 */
  const MAX_TRACKED = 800;
  /** 后台回「扩展已关闭」之后，多久之内不再问 */
  const DISABLED_COOLDOWN_MS = 30000;
  /**
   * 重发之后等多久还没有 load / error，就认定这次重发**不会再有结论**。
   *
   * 元素被页面换掉、或者整页导航走之后，渲染进程不会在它上面派发任何事件 —— 于是
   * 「重发出去了，然后呢」这个问题永远不会有人回答，后台的 `attempted` 永久悬空。
   * 真实数据里 attempted=7 / recovered=6，差的那 1 次正是如此：网络层 10 秒后报了
   * `ERR_ABORTED`，而 img 上什么都没派发。
   *
   * 取 25 秒是因为观测到的真实首次请求最慢 18.2 秒 —— 阈值必须明显大于它，
   * 否则会把「只是很慢」误判成「没有结论」。
   */
  const RETRY_OUTCOME_TIMEOUT_MS = 25000;

  /** 原图 URL -> 已经尝试过几次（含首次） */
  const attempts = new Map();
  /** 正在等我们处理的元素 -> state。用 WeakMap，元素被移除即自动释放 */
  const watching = new WeakMap();
  /**
   * 还没有结论的重发（state 对象本身）。
   *
   * WeakMap 查得快但遍历不了，而页面被切到后台时必须能把悬空的那些**一次结清** ——
   * 导航走正是这类悬空最常见的成因，等满超时往往等不到，页面已经卸载了。
   * 强引用是刻意的，但有界：每个 state 最多存活 RETRY_OUTCOME_TIMEOUT_MS，
   * 而同一窗口内的重发次数本来就受 PAGE_BUDGET 约束。
   */
  const outstanding = new Set();
  /** 已经问过一次、正在等回复的元素，防止同一张图并发重入 */
  const asking = new WeakSet();

  let spent = 0;
  let inflight = 0;
  let budgetReported = false;
  let disabledUntil = 0;

  // ---------------------------------------------------------------- 与后台通信

  function send(message) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        chrome.runtime.sendMessage(message, (response) => {
          // 读一次 lastError，否则扩展被重载时控制台会冒出未处理的错误
          void chrome.runtime.lastError;
          done(response || null);
        });
      } catch {
        // 扩展被重载 / 卸载后上下文失效，页面侧只能安静退场
        done(null);
      }
    });
  }

  function report(url, kind, ok) {
    void send({ type: 'imageRetryResult', url, kind, ok });
  }

  // ---------------------------------------------------------------- 调试日志（页面侧）

  /**
   * 开发者调试日志的页面端（决策 D25）。
   *
   * **这里存不住东西。** 页面级存储每个 tab、每个 iframe 一份，页一关就没，导出时
   * 根本不知道该去哪些 tab 收。所以只攒一小批发回后台，存与导都归 debug-store。
   *
   * 开关直接读 storage.local 并监听变更 —— 否则每写一行都得先问后台一次「现在该记吗」。
   *
   * 记的是后台**看不到**的那半截：等了多久、src 重赋了没有、最后是 load 还是 error。
   */
  const DEBUG_KEY = 'debug';
  /** 攒够这么多行立刻发 */
  const DEBUG_BATCH = 20;
  /** 或者等这么久 */
  const DEBUG_FLUSH_MS = 1000;
  /** 单页最多回传多少行。与 PAGE_BUDGET 同一种思路：坏页面不能变成消息风暴 */
  const DEBUG_PAGE_CAP = 2000;

  let debugOn = false;
  let debugSpent = 0;
  let debugQueue = [];
  let debugTimer = null;

  function debugFlush() {
    if (debugTimer) {
      clearTimeout(debugTimer);
      debugTimer = null;
    }
    if (debugQueue.length === 0) return;
    const rows = debugQueue;
    debugQueue = [];
    void send({ type: 'debugPush', rows });
  }

  function dbg(ev, data) {
    if (!debugOn || debugSpent >= DEBUG_PAGE_CAP) return;
    debugSpent++;
    debugQueue.push({ at: Date.now(), ns: 'content', ev, data: data || {} });
    if (debugQueue.length >= DEBUG_BATCH) {
      debugFlush();
      return;
    }
    if (debugTimer) return;
    debugTimer = setTimeout(debugFlush, DEBUG_FLUSH_MS);
  }

  try {
    chrome.storage.local.get(DEBUG_KEY, (got) => {
      void chrome.runtime.lastError;
      debugOn = !!(got && got[DEBUG_KEY] && got[DEBUG_KEY].enabled === true);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes[DEBUG_KEY]) return;
      const next = changes[DEBUG_KEY].newValue;
      debugOn = !!(next && next.enabled === true);
      if (!debugOn) debugQueue = [];
    });
  } catch {
    // storage 不可用（上下文失效、权限被裁剪）时就当开关是关的
  }

  try {
    // 收尾挂 visibilitychange 而不是 beforeunload —— 后者在 MV3 里不可靠。
    // 两件事都得做：把悬空的重发结清（导航走之后它们永远不会有结论了），
    // 再把最后不足一批的调试行发回去（不发就永久丢了）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      for (const state of [...outstanding]) settle(state, null);
      debugFlush();
    });
  } catch {
    // 没有这个事件也只是少一次收尾：超时那条路照样会给出结论，定时器照样会发
  }

  // ---------------------------------------------------------------- 重新加载

  /**
   * 让浏览器重新取一次这张图。
   *
   * 给 `src` / `srcset` 赋值（哪怕是同一个值）都会触发 HTML 规范里的
   * "update the image data"，于是发出一个全新的请求。**不加缓存穿透参数**：
   * 那会破坏签名 URL，而且失败的响应本来就没被缓存，没有穿透的必要。
   *
   * 三个分支不能合并：`<picture>` 里图片地址来自兄弟 `<source>`，此时 `img` 自己的
   * `src` 与 `srcset` 都是空的 —— 直接写 `img.src = img.src` 等于把 src 设成空串，
   * 那不是重试，是把图片彻底弄没。改 `<source>` 的 srcset 才会让浏览器重跑一次源选择。
   */
  function reload(img, url) {
    const picture = img.parentElement;
    if (picture && picture.tagName === 'PICTURE') {
      let touched = false;
      for (const source of picture.querySelectorAll('source')) {
        if (source.srcset) {
          source.srcset = source.srcset;
          touched = true;
        }
      }
      if (touched) return;
    }
    if (img.srcset) img.srcset = img.srcset;
    else if (img.getAttribute && img.getAttribute('src')) img.src = img.src;
    else img.src = url;
  }

  /**
   * 强制这张图去取指定地址（只用于兜底）。
   *
   * `<picture>` 里 `<source>` 的优先级高于 `<img src>`，所以不先把兄弟 `<source>` 的
   * srcset 清掉的话，赋 `img.src` 根本不会生效 —— 浏览器仍然会去选那个已经失败的源。
   * 这是一次真实的 DOM 改动，但走到兜底这一步说明原来那些源已经全都取不到了。
   */
  function forceSrc(img, url) {
    const picture = img.parentElement;
    if (picture && picture.tagName === 'PICTURE') {
      for (const source of picture.querySelectorAll('source')) {
        source.removeAttribute('srcset');
        source.removeAttribute('src');
      }
    }
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.src = url;
  }

  function watch(img, mode, url) {
    const state = { img, mode, url, timer: 0 };
    // 超时是这条链路唯一的兜底：load 与 error 都不来的时候，只有它能给出结论
    state.timer = setTimeout(() => settle(state, null), RETRY_OUTCOME_TIMEOUT_MS);
    watching.set(img, state);
    outstanding.add(state);
    img.addEventListener('load', onLoaded, { once: true });
  }

  /**
   * 给一次重发下结论并回报，**只下一次**。
   *
   * load、error、超时、页面隐藏是四条会撞车的路径（比如超时刚触发、load 紧接着到），
   * 而同一次重发报两个结论会让后台的 recovered / abandoned 一起变成假数字。
   * `outstanding.delete()` 的返回值就是这道闸门。
   *
   * @param {boolean|null} ok true = 收到 load，false = 又失败了，null = 不会有结论了
   */
  function settle(state, ok) {
    if (!outstanding.delete(state)) return;
    clearTimeout(state.timer);
    // 按身份删而不是按元素删：同一个 <img> 可能已经挂上了**新一轮**重发的 state，
    // 那时无条件 delete(img) 会把新一轮的跟踪一起抹掉
    if (watching.get(state.img) === state) watching.delete(state.img);

    if (ok === true) attempts.delete(state.url);
    dbg(ok === true ? 'loaded' : (ok === false ? 'retry-failed' : 'abandoned'),
      { url: state.url, mode: state.mode });
    report(state.url, state.mode, ok);
  }

  function onLoaded(event) {
    const state = watching.get(event.currentTarget);
    if (state) settle(state, true);
  }

  // ---------------------------------------------------------------- 失败入口

  function currentUrl(img) {
    const url = img.currentSrc || img.src || '';
    return /^https?:/i.test(url) ? url : '';
  }

  async function onResourceError(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;

    // 上一轮是我们发起的：先把结果如实回报，再决定要不要继续
    const previous = watching.get(img);
    if (previous) {
      settle(previous, false);
      // 兜底也失败了就到此为止 —— 再问下去只会套娃
      if (previous.mode === 'fallback') return;
    }

    if (Date.now() < disabledUntil) return;
    if (asking.has(img)) return;

    const url = currentUrl(img);
    if (!url) return;

    if (spent >= PAGE_BUDGET) {
      // 上限是刻意设的，但不能悄悄生效 —— 说一次，让它在活动日志里留下痕迹
      if (!budgetReported) {
        budgetReported = true;
        dbg('budget-exhausted', { spent, cap: PAGE_BUDGET });
        report(url, 'budget', false);
      }
      return;
    }

    const attempt = (attempts.get(url) ?? 0) + 1;
    if (inflight >= MAX_INFLIGHT) {
      dbg('inflight-cap', { url, inflight });
      return;
    }

    asking.add(img);
    inflight++;
    dbg('caught', { url, attempt });
    try {
      const plan = await send({ type: 'imageRetryAsk', url, attempt });
      if (!plan || !plan.ok) {
        dbg('no-plan', { url, attempt });
        return;
      }

      if (plan.reason === 'disabled') {
        disabledUntil = Date.now() + DISABLED_COOLDOWN_MS;
        dbg('cooldown', { untilMs: DISABLED_COOLDOWN_MS });
        return;
      }
      if (plan.action !== 'retry' && plan.action !== 'fallback') {
        // 刻意**不**清掉计数：清了的话，页面自己再触发一次加载就会让整轮重试从头开始。
        // 「已经用尽」必须是黏住的状态
        dbg('gave-up', { url, attempt, reason: plan.reason ?? null });
        return;
      }

      if (attempts.size > MAX_TRACKED) attempts.clear();
      attempts.set(url, attempt);
      spent++;

      // 等一小会儿再发：给 Chromium 时间把刚失败的代理登记进它自己的坏代理列表，
      // 否则重发很可能又落回同一个节点
      const delay = Number(plan.delayMs);
      if (Number.isFinite(delay) && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      // 等待期间图片可能已被页面换掉或移除，这时重发没有意义
      if (!img.isConnected) {
        dbg('detached', { url, attempt });
        return;
      }

      if (plan.action === 'retry') {
        watch(img, 'retry', url);
        reload(img, url);
        dbg('resent', { url, attempt, waitedMs: Number.isFinite(delay) ? delay : 0 });
      } else {
        watch(img, 'fallback', plan.url);
        forceSrc(img, plan.url);
        dbg('fallback-sent', { url, target: plan.url, attempt });
      }
    } finally {
      inflight--;
      asking.delete(img);
    }
  }

  // 资源加载失败的 error 事件不冒泡，但会经过捕获阶段 —— 所以只能在这里挂，
  // 且必须用 capture=true
  document.addEventListener('error', onResourceError, true);
})();
