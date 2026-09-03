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
  /** 看门狗阈值缺省时的默认值（12 秒）。 */
  const WATCHDOG_DEFAULT_MS = 12000;
  /** 看门狗阈值上限：再高就不是“慢”，是配置写坏了。 */
  const WATCHDOG_MAX_MS = 60000;
  /** chrome.storage.local 中配置的键名。内容脚本没法 import，只能自己重复一份。 */
  const CONFIG_KEY = 'config';

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
  /** img -> { url, state, timer }。看门狗只盯“开始加载了、但还没有结果”的图。 */
  const pendingLoads = new WeakMap();
  /** 我们主动换节点时会中止旧请求；旧请求的 abort/error 不该再算一次失败。 */
  const suppressAbort = new WeakSet();

  let spent = 0;
  let inflight = 0;
  let budgetReported = false;
  let disabledUntil = 0;
  let watchdogMs = WATCHDOG_DEFAULT_MS;

  /** 把存储里读到的阈值夹成合法值；缺失/损坏时回到默认 */
  function normalizeWatchdogMs(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return WATCHDOG_DEFAULT_MS;
    if (n <= 0) return 0;
    return Math.min(n, WATCHDOG_MAX_MS);
  }

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
    chrome.storage.local.get(CONFIG_KEY, (got) => {
      void chrome.runtime.lastError;
      watchdogMs = normalizeWatchdogMs(got?.[CONFIG_KEY]?.settings?.retry?.slowTimeoutMs);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      if (changes[DEBUG_KEY]) {
        const next = changes[DEBUG_KEY].newValue;
        debugOn = !!(next && next.enabled === true);
        if (!debugOn) debugQueue = [];
      }
      if (changes[CONFIG_KEY]) {
        watchdogMs = normalizeWatchdogMs(changes[CONFIG_KEY].newValue?.settings?.retry?.slowTimeoutMs);
      }
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

  /** 清掉这张图上的看门狗状态（图片已经 load/error/abort，或我们即将重开一轮）。 */
  function clearPendingLoad(img) {
    const rec = pendingLoads.get(img);
    if (!rec) return;
    if (rec.timer) clearTimeout(rec.timer);
    pendingLoads.delete(img);
  }

  /** 只看门狗这一路清定时器，保留 rec 本体 —— give-up 时原请求还要继续等。 */
  function stopWatchdog(rec) {
    if (rec.timer) {
      clearTimeout(rec.timer);
      rec.timer = 0;
    }
  }

  /** 给“正在加载”的 img 挂上看门狗定时器。 */
  function armWatchdog(img, url, state) {
    clearPendingLoad(img);
    if (watchdogMs <= 0) return;
    const rec = { url, state: state ?? null, timer: 0 };
    pendingLoads.set(img, rec);
    rec.timer = setTimeout(() => {
      void onWatchdogTimeout(img, rec);
    }, watchdogMs);
  }

  function watch(img, mode, url) {
    const state = { img, mode, url, timer: 0 };
    // 超时是这条链路唯一的兜底：load 与 error 都不来的时候，只有它能给出结论
    state.timer = setTimeout(() => settle(state, null), RETRY_OUTCOME_TIMEOUT_MS);
    watching.set(img, state);
    outstanding.add(state);
    img.addEventListener('load', onLoaded, { once: true });
    // 重发同样可能撞上一个慢节点 —— 从这一轮开始计时，超时后再换一个
    armWatchdog(img, url, state);
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

  // ---------------------------------------------------------------- 慢图看门狗

  function onLoadStart(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    suppressAbort.delete(img);
    const url = currentUrl(img);
    if (!url) return;
    // 如果这一轮是我们发起的重发，watching 里已有 state；把 state 带上看门狗，
    // 下次再超时就能把上一轮正确结算成 abandoned
    armWatchdog(img, url, watching.get(img) ?? null);
  }

  function onLoadFinished(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    // 我们自己换节点时旧请求的 abort 会先到；不能让它把新请求的看门狗计时一起清掉。
    // 新请求的 loadstart 到达后 suppressAbort 会被移除，届时 load/abort 照常处理。
    if (event.type === 'abort' && suppressAbort.has(img)) return;
    suppressAbort.delete(img);
    clearPendingLoad(img);
  }

  /**
   * 看门狗到点：这张图还在加载（既没有 load 也没有 error）。
   *
   * 与失败重试不同，这里没有网络层错误码可查 —— 请求可能最终会成功，只是太慢。
   * 页面侧只负责把 cause:'slow' 带给后台，由后台按规则/次数/兜底决定下一步。
   */
  async function onWatchdogTimeout(img, rec) {
    if (pendingLoads.get(img) !== rec) return;
    if (Date.now() < disabledUntil) return;
    if (!img.isConnected) {
      clearPendingLoad(img);
      return;
    }
    if (asking.has(img)) return;

    const url = rec.url;
    if (!url) return;
    if (spent >= PAGE_BUDGET) {
      if (!budgetReported) {
        budgetReported = true;
        dbg('budget-exhausted', { spent, cap: PAGE_BUDGET });
        report(url, 'budget', false);
      }
      return;
    }
    if (inflight >= MAX_INFLIGHT) {
      dbg('inflight-cap', { url, inflight });
      return;
    }

    const attempt = (attempts.get(url) ?? 0) + 1;
    asking.add(img);
    inflight++;
    dbg('slow-timeout', { url, attempt, timeoutMs: watchdogMs });
    try {
      const plan = await send({ type: 'imageRetryAsk', url, attempt, cause: 'slow' });
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
        // 不给页面新地址，也不清 pending：原请求还挂在网上，让它自己等 load/error
        dbg('slow-gave-up', { url, attempt, reason: plan.reason ?? null });
        stopWatchdog(rec);
        return;
      }

      // 后台回复的这几毫秒里图片可能已经加载完了；加载完成事件会清掉 rec
      if (pendingLoads.get(img) !== rec) return;

      if (attempts.size > MAX_TRACKED) attempts.clear();
      attempts.set(url, attempt);
      spent++;

      // 上一轮是我们发起的：它还没出结果就被看门狗判了“太慢”，结算成结果未知
      if (rec.state) settle(rec.state, null);
      stopWatchdog(rec);

      const delay = Number(plan.delayMs);
      if (Number.isFinite(delay) && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      // 等待期间图片可能已被页面换掉或移除，这时重发没有意义
      if (!img.isConnected || pendingLoads.get(img) !== rec) {
        dbg('detached', { url, attempt });
        return;
      }

      // 换节点会中止还在网上的旧请求；它派发的 abort/error 是我们造成的，
      // 在下一个 loadstart 之前要压住，否则会把“旧请求被中止”误判成“新节点失败”
      suppressAbort.add(img);
      clearPendingLoad(img);
      const mode = plan.action === 'fallback' ? 'fallback' : 'retry';
      watch(img, mode, url);
      reload(img, url);
      dbg(plan.action === 'fallback' ? 'fallback-sent' : 'resent',
        { url, attempt, waitedMs: Number.isFinite(delay) ? delay : 0, slow: true });
    } finally {
      inflight--;
      asking.delete(img);
    }
  }

  // ---------------------------------------------------------------- 失败入口

  function currentUrl(img) {
    const url = img.currentSrc || img.src || '';
    return /^https?:/i.test(url) ? url : '';
  }

  async function onResourceError(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    // 重新赋值 src 会中止旧请求，那个 error 是我们自己造成的，不是节点失败
    if (suppressAbort.has(img)) return;
    if (!asking.has(img)) clearPendingLoad(img);

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

      // 重试与兜底在这里是**同一个动作**：都是原地重新请求同一个地址。
      // 差别全在后台 —— 兜底那一路，后台已经把这个图源临时指向了兜底代理
      // （1.5.0 起兜底是传输层的；1.4.x 那会儿它是 URL 改写，所以这里要改地址）。
      // mode 仍然要分开，否则统计分不出「换节点救回」和「兜底救回」
      watch(img, plan.action === 'fallback' ? 'fallback' : 'retry', url);
      reload(img, url);
      dbg(plan.action === 'fallback' ? 'fallback-sent' : 'resent',
        { url, attempt, waitedMs: Number.isFinite(delay) ? delay : 0 });
    } finally {
      inflight--;
      asking.delete(img);
    }
  }

  // 资源加载失败的 error 事件不冒泡，但会经过捕获阶段 —— 所以只能在这里挂，
  // 且必须用 capture=true。loadstart / load / abort 同理，全走捕获阶段。
  document.addEventListener('loadstart', onLoadStart, true);
  document.addEventListener('load', onLoadFinished, true);
  document.addEventListener('abort', onLoadFinished, true);
  document.addEventListener('error', onResourceError, true);
})();
