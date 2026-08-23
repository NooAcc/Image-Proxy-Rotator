/**
 * 深度重试的桥 —— 隔离世界这一侧。
 *
 * **为什么必须有这个文件。** 主世界的补丁就是一段普通的页面脚本，`chrome.runtime`
 * 在那里是 undefined（Chromium 扩展组的原话：it's just a conventional web page script,
 * so it doesn't have access to extension APIs）。所以补丁没法直接问后台，只能
 * `window.postMessage` 给同一个页面里的这段隔离世界代码，由它转发。这不是设计选择，
 * 是主世界的硬性约束。
 *
 * **它把页面来的消息当不可信输入处理（决策 D32）。** 主世界补丁与页面脚本共享同一个
 * JS 环境 —— 页面读得到补丁里的一切，任何在补丁里生成或接收的 nonce 页面同样读得到，
 * 所以 nonce 在这里是安全剧场。真正的防线是两条：
 *
 *   1. **归属由后台裁决。** `planRetry()` 一进门就用 `matchPacUrl()` 判这个 URL 是不是
 *      本扩展路由出去的，不是就 give-up。页面伪造一个别人的地址进来，什么也拿不到。
 *   2. **每页限流。** 下面的两个上限防止页面脚本把这座桥当成打 Service Worker 的放大器。
 *
 * 残余风险（写进 LIMITATIONS）：勾了深度重试的站点可以借这座桥探测某个地址是否命中
 * 用户的规则，也可以刷高统计计数。两者都只在用户显式勾选的站点上成立，且不泄露节点、
 * 凭据或配置内容。
 *
 * **它是 classic script，不是模块。** 动态注册的内容脚本同样不支持 ESM，
 * 所以这里一个 import 都不能有。
 */

(() => {
  'use strict';

  /** 本页最多转发多少次询问。与 retry.js 的 PAGE_BUDGET 同一种思路 */
  const PAGE_BUDGET = 500;
  /** 同时挂起的询问数上限。超出的直接回 null，不排队 */
  const MAX_INFLIGHT = 16;
  /** URL 再长也没有意义，只是白占消息通道 */
  const MAX_URL_LENGTH = 4096;

  let spent = 0;
  let inflight = 0;

  /**
   * 把消息发回主世界。
   *
   * `targetOrigin` 用 `'*'` 是安全的：收信方就是本窗口自己，而消息内容（页面自己的
   * 请求地址、重试计划）本来就是页面能看到的东西，不存在向别的源泄露的问题。
   */
  function reply(id, plan) {
    try {
      window.postMessage({ __ppDeep: 1, kind: 'plan', id, plan: plan ?? null }, '*');
    } catch {
      // 页面把 postMessage 换掉了之类。补丁那侧有超时，不会永远挂着
    }
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          // 读一次 lastError，否则扩展被重载时控制台会冒出未处理的错误
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch {
        // 扩展被重载 / 卸载后上下文失效
        resolve(null);
      }
    });
  }

  /** 只接受形状对得上的字段，其余一律当没收到 —— 这是不可信输入的入口 */
  function readUrl(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) return '';
    return /^https?:\/\//i.test(value) ? value : '';
  }

  function readAttempt(value) {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 1;
  }

  function readVia(value) {
    return value === 'fetch' || value === 'xhr' || value === 'image' ? value : null;
  }

  async function onAsk(data) {
    const id = data.id;
    const url = readUrl(data.url);
    const via = readVia(data.via);
    if (!url || !via) {
      reply(id, null);
      return;
    }
    if (spent >= PAGE_BUDGET || inflight >= MAX_INFLIGHT) {
      reply(id, null);
      return;
    }

    spent++;
    inflight++;
    try {
      const plan = await send({
        type: 'imageRetryAsk',
        url,
        attempt: readAttempt(data.attempt),
        via,
      });
      reply(id, plan && plan.ok ? plan : null);
    } finally {
      inflight--;
    }
  }

  function onResult(data) {
    const url = readUrl(data.url);
    const via = readVia(data.via);
    if (!url || !via) return;
    // 只认补丁会给出的三种结局。`budget` 那一路是 retry.js 专用的，不从这里进来
    const mode = data.mode === 'fallback' ? 'fallback' : 'retry';
    const ok = data.ok === true ? true : (data.ok === false ? false : null);
    void send({ type: 'imageRetryResult', url, kind: mode, ok, via });
  }

  window.addEventListener('message', (event) => {
    // 同窗口的 postMessage 才可能是补丁发来的。别的 frame 或 opener 一律不理
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.__ppDeep !== 1) return;
    if (data.kind === 'ask') void onAsk(data);
    else if (data.kind === 'result') onResult(data);
  }, false);
})();
