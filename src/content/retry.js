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

  /** 原图 URL -> 已经尝试过几次（含首次） */
  const attempts = new Map();
  /** 正在等我们处理的元素 -> {mode, url}。用 WeakMap，元素被移除即自动释放 */
  const watching = new WeakMap();
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
    watching.set(img, { mode, url });
    img.addEventListener('load', onLoaded, { once: true });
  }

  function onLoaded(event) {
    const img = event.currentTarget;
    const state = watching.get(img);
    if (!state) return;
    watching.delete(img);
    attempts.delete(state.url);
    report(state.url, state.mode, true);
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
      watching.delete(img);
      report(previous.url, previous.mode, false);
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
        report(url, 'budget', false);
      }
      return;
    }

    const attempt = (attempts.get(url) ?? 0) + 1;
    if (inflight >= MAX_INFLIGHT) return;

    asking.add(img);
    inflight++;
    try {
      const plan = await send({ type: 'imageRetryAsk', url, attempt });
      if (!plan || !plan.ok) return;

      if (plan.reason === 'disabled') {
        disabledUntil = Date.now() + DISABLED_COOLDOWN_MS;
        return;
      }
      if (plan.action !== 'retry' && plan.action !== 'fallback') {
        // 刻意**不**清掉计数：清了的话，页面自己再触发一次加载就会让整轮重试从头开始。
        // 「已经用尽」必须是黏住的状态
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
      if (!img.isConnected) return;

      if (plan.action === 'retry') {
        watch(img, 'retry', url);
        reload(img, url);
      } else {
        watch(img, 'fallback', plan.url);
        forceSrc(img, plan.url);
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
