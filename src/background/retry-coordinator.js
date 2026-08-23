/**
 * 重试协调器 —— 内容脚本的唯一对话人。
 *
 * 职责边界（决策 D21）：**规则匹配、失败原因分类、次数上限全在这里，内容脚本一条规则
 * 都不持有。** 它只报告「这张图裂了，这是第几次」，然后照回复执行。理由和 UI 那条
 * 「不维护第二份状态」是同一个：规则一改，页面里那份副本就过期了，而过期的表现是
 * 「重试悄悄按旧规则在跑」—— 又一种不会报错的静默故障。
 *
 * 本模块只做编排：凑齐入参、写统计、写日志。判定本身在 lib/retry.js（纯函数，可单测）。
 */

import { decideRetry } from '../lib/retry.js';
import { matchPacUrl } from '../lib/rule-matcher.js';
import { fallbackProxyToken } from '../lib/fallback-proxy.js';
import { FALLBACK_WINDOW_MS } from '../lib/constants.js';
import { getConfig, getLogger, queueRuntimeSave } from './state.js';
import { observedFailure, forgetFailure, noteRetryAsked } from './request-logger.js';
import { noteRetryMetric, noteFallbackProxyMetric } from './metrics-store.js';
import { openFallbackWindow, abortFallbackWindow } from './fallback-window.js';
import { applyProxy } from './proxy-controller.js';
import { dbg } from './debug-store.js';

/**
 * 查不到失败原因时再等一次的时长。
 *
 * `webRequest.onErrorOccurred` 与渲染进程在 `<img>` 上派发 `error` 是两条独立的路径，
 * 没有顺序保证。绝大多数情况下网络层先落地，但差几十毫秒是常有的事 —— 不等一下就会把
 * 一批本该重试的图判成「原因不明」。
 */
const LOOKUP_GRACE_MS = 150;

/**
 * 日志去重：`${host}|${事件}` -> 上次写日志的时刻。
 *
 * 一个漫画页能打出几百个失败请求。逐条写日志会在几秒内把环形缓冲冲干净，把真正有用的
 * 那几条（注入失败、规则告警）挤掉。所以同一个域名的同一类事件每分钟最多说一次，
 * 具体次数去看统计 —— 那才是计数该待的地方。
 */
const spoken = new Map();
const SPEAK_INTERVAL_MS = 60000;
const SPOKEN_CAP = 200;

function shouldSpeak(key) {
  const now = Date.now();
  const last = spoken.get(key);
  if (last !== undefined && now - last < SPEAK_INTERVAL_MS) return false;
  if (spoken.size > SPOKEN_CAP) spoken.clear();
  spoken.set(key, now);
  return true;
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url).slice(0, 40);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** give-up 的理由 -> 给用户看的中文 */
const GIVE_UP_TEXT = {
  'not-routed': '该地址不匹配任何启用的规则，不是本扩展路由出去的，不干预',
  'not-proxy-failure': '失败原因不是代理故障（多为图源返回 4xx/5xx），换代理也是同样结果',
  'unknown-cause': '查不到这次失败的原因，保守起来不重试',
  exhausted: '已用尽可尝试的节点，且兜底代理未启用或不可用',
  cooldown: '已用尽可尝试的节点，而该图源刚用过兜底代理、正处在冷却期',
  'fallback-failed': '已用尽可尝试的节点，而切换到兜底代理时注入分流脚本失败',
};

/**
 * 内容脚本报告一张图加载失败，决定接下来怎么办。
 *
 * @param {{url: string, attempt: number, via?: 'fetch'|'xhr'|'image'}} report
 *   `via` 由主世界补丁给出（决策 D31）。缺省表示来自 retry.js 的 `<img>` 那条路。
 * @returns {Promise<{action: 'retry'|'fallback'|'give-up', url?: string, delayMs?: number, reason?: string}>}
 */
export async function planRetry({ url, attempt, via } = {}) {
  // 页面来问了，就撤销「这次失败页面没捕获到」的判定 —— 无论接下来决定重不重试。
  // 放在最前面：下面每一条提前返回都同样意味着「页面确实看见了」
  if (typeof url === 'string' && url) noteRetryAsked(url);

  // 补丁问过一次就记一笔，不管后台答不答应重发。这一格要回答的是「补丁到底装上没有、
  // 在不在干活」—— 它恒为 0 而 retry.unseen 照旧居高不下，就是「补丁没装上」的指认
  if (via === 'fetch' || via === 'xhr' || via === 'image') {
    await noteRetryMetric({ kind: 'deep', at: Date.now() });
  }

  const config = await getConfig();
  const give = (reason) => {
    // 这一路提前返回**不写活动日志也不计数**，于是「为什么这张图没被重发」在别处
    // 完全看不见。debug 日志是唯一能回答它的地方
    if (dbg.on) dbg('retry', 'declined', { url: url ?? null, attempt: attempt ?? null, reason });
    return { action: 'give-up', reason };
  };

  if (!config.enabled) return give('disabled');
  if (typeof url !== 'string' || !url) return give('not-routed');

  const retry = config.settings.retry;
  const fallbackProxy = config.settings.fallbackProxy;

  // 「这张图是本扩展路由出去的吗」必须用 matchPacUrl 而不是 matchUrl：后者按完整 URL
  // 判定，而浏览器交给 PAC 的 https URL 已被剥掉 path 与 query（决策 D16）。用 matchUrl
  // 会把一批「命中了规则但注定直连」的图片也拉进重试，而它们本来就没走代理。
  //
  // 这一步刻意放在查失败原因**之前**：整个网站的裂图都会走到这里，不归本扩展管的
  // 那些不该白等一次宽限期。
  //
  // 也刻意**不计数**：用户随手逛的任何网站上的裂图都会命中这一条，把它记进
  // `retry.skipped` 会让那一格变成「与你的配置无关的噪音计数」，用户看到
  // 「未重试 47 次」只会以为哪里出了问题。那一格的含义必须是「**你的**图片里
  // 有几张我们决定不重试」。
  if (!matchPacUrl(url, config.rules)) return give('not-routed');

  // 原因可能还没落地 —— onErrorOccurred 与渲染进程派发 error 是两条独立路径，
  // 没有顺序保证。等一次再查，仍然查不到就按「原因不明」处理（保守放弃）
  let kind = observedFailure(url);
  let waited = false;
  if (!kind) {
    waited = true;
    await sleep(LOOKUP_GRACE_MS);
    kind = observedFailure(url);
  }
  if (!kind) kind = 'unknown';

  // 1.5.0 起兜底是**传输层**的：后台把这个源临时指向兜底代理，页面原地重发即可。
  // 于是它对 fetch / XHR 与对 `<img>` 一样有效 —— 旧的 URL 改写型兜底做不到这一点
  // （把一个 JSON 接口套进 `?url=` 毫无意义），所以那时这里按 via 把兜底关掉了。
  const plan = decideRetry({
    attempt,
    kind,
    matched: true,
    maxAttempts: retry.maxAttempts,
    fallbackEnabled: Boolean(fallbackProxyToken(fallbackProxy)),
  });

  // 判定的入参与结论一次记全。少记一项，事后就只能靠猜「当时 observedFailure 查到了吗」
  if (dbg.on) {
    dbg('retry', 'planned', {
      url,
      attempt,
      cause: kind,
      waitedForCause: waited,
      action: plan.action,
      reason: plan.reason ?? null,
      via: via ?? 'img',
      maxAttempts: retry.maxAttempts,
      delayMs: retry.delayMs,
      fallbackEnabled: Boolean(fallbackProxyToken(fallbackProxy)),
    });
  }

  const log = await getLogger();

  if (plan.action === 'retry') {
    await noteRetryMetric({ kind: 'attempted', at: Date.now() });
    if (shouldSpeak(`${hostOf(url)}|retry`)) {
      log.add({
        level: 'warn',
        kind: 'request',
        message: `${hostOf(url)} 的图片加载失败（${kind === 'proxy' ? '代理故障' : '连接失败'}），`
          + `正在换一个节点重发（最多尝试 ${retry.maxAttempts} 个节点）。具体次数见统计页。`,
      });
    }
    queueRuntimeSave();
    return { action: 'retry', delayMs: retry.delayMs };
  }

  if (plan.action === 'fallback') return dispatchFallback({ url, retry, log });

  // 走到这里的一定是「你的图片」（不归本扩展管的已经在上面提前返回了）。
  // 用尽了却没兜底算 exhausted，其余算 skipped —— 后者的含义是
  // 「这张图归我管，但我判断重试没有意义」
  await noteRetryMetric({ kind: plan.reason === 'exhausted' ? 'exhausted' : 'skipped', at: Date.now() });
  if (plan.reason && shouldSpeak(`${hostOf(url)}|${plan.reason}`)) {
    log.add({
      level: plan.reason === 'exhausted' ? 'error' : 'info',
      kind: 'request',
      message: `${hostOf(url)} 的图片未重试：${GIVE_UP_TEXT[plan.reason] ?? plan.reason}`,
    });
    queueRuntimeSave();
  }
  return { action: 'give-up', reason: plan.reason };
}

/**
 * 把这个源切到兜底代理，然后让页面原地重发。
 *
 * **三件事的顺序不能换。** 先开窗（拿到「该不该切」的裁决），再注入 PAC（真的切过去），
 * 最后才回复页面。反过来 —— 先回复再注入 —— 页面就可能在 PAC 还没换上时就重发，
 * 那一次会落到普通轮询节点上，却被记成一次兜底：统计说谎，而用户完全无从发现。
 *
 * `exhausted` 无论切没切成都要记：它的含义是「轮询节点都试过了」，与兜底接不接手无关
 * （`exhausted >= fallbackProxy.used` 因此恒成立）。
 */
async function dispatchFallback({ url, retry, log }) {
  const opened = openFallbackWindow(url);

  if (!opened.ok) {
    await noteRetryMetric({ kind: 'exhausted', at: Date.now() });
    if (opened.reason === 'cooldown') {
      await noteFallbackProxyMetric({ cooldown: true, at: Date.now() });
      if (shouldSpeak(`${hostOf(url)}|cooldown`)) {
        log.add({
          level: 'warn',
          kind: 'request',
          message: `${hostOf(url)} 的图片在 ${retry.maxAttempts} 个节点上都失败了，`
            + '但该图源刚用过兜底代理、正处在冷却期，这次不再切换。'
            + '冷却是刻意的：否则轮询池持续失败时整个图源会长期只走兜底代理那一个 IP。',
        });
        queueRuntimeSave();
      }
      return { action: 'give-up', reason: 'cooldown' };
    }
    return { action: 'give-up', reason: 'exhausted' };
  }

  // 窗口已经开着说明这个源本来就指向兜底代理了，不必也不该重注入一遍 PAC ——
  // 一次大面积失败会让几十张图同时走到这里
  if (!opened.reused) {
    const applied = await applyProxy();
    if (!applied.applied) {
      // 窗口记着「已开」而 PAC 里其实没有对应条目，是最糟的状态：下一张图会因为
      // 「窗口已开」直接重发，落到普通节点上却被记成兜底。必须把窗口撤回去
      abortFallbackWindow(opened.origin);
      await noteRetryMetric({ kind: 'exhausted', at: Date.now() });
      log.add({
        level: 'error',
        kind: 'request',
        message: `${hostOf(url)} 的图片本该切到兜底代理，但注入分流脚本失败，已放弃这张图。`
          + '请到设置页检查代理设置的控制权是否被其他扩展占用。',
      });
      queueRuntimeSave();
      return { action: 'give-up', reason: 'fallback-failed' };
    }
  }

  await noteRetryMetric({ kind: 'exhausted', at: Date.now() });
  await noteFallbackProxyMetric({ used: true, at: Date.now() });
  if (shouldSpeak(`${hostOf(url)}|fallback`)) {
    log.add({
      level: 'warn',
      kind: 'request',
      message: `${hostOf(url)} 的图片在 ${retry.maxAttempts} 个节点上都失败了，已切到兜底代理。`
        + `注意：浏览器只把「协议+域名」交给分流脚本，所以接下来 ${Math.round(FALLBACK_WINDOW_MS / 1000)} 秒内`
        + '这个图源的**所有**请求都会走兜底代理，不只是这一张图。',
    });
  }
  queueRuntimeSave();
  return { action: 'fallback', delayMs: retry.delayMs };
}

/**
 * 内容脚本回报一次重发或兜底的结果。
 *
 * 这是 `retry.recovered` 唯一的来源 —— 它是「重发之后真的收到了 load 事件」，
 * 不是「大概成功了」（决策 D24）。
 *
 * `ok: null` 是第三种结果：**不会再有结果了**。元素被页面换掉或导航走之后，渲染进程
 * 不会在它上面派发任何事件，内容脚本用超时兜住这种情况。不单列它，`attempted` 就会
 * 永久悬空 —— 真实数据里 attempted=7 / recovered=6，那 1 次差额正是如此。
 *
 * @param {{url: string, kind: 'retry'|'fallback'|'budget', ok: ?boolean}} report
 *   ok 为 true = 收到 load，false = 又失败了，null = 永远不会有结论
 */
export async function noteRetryOutcome({ url, kind, ok, via } = {}) {
  const succeeded = ok === true;
  const abandoned = ok === null || ok === undefined;
  if (dbg.on) dbg('retry', 'outcome', { url: url ?? null, kind: kind ?? null, via: via ?? 'img', ok: abandoned ? null : succeeded });

  // 页面侧的重试预算用完了。上限是刻意设的，但绝不能悄悄生效 —— 不说的话，
  // 用户看到的是「重试到一半就不重试了」，而统计里找不到任何解释
  if (kind === 'budget') {
    const log = await getLogger();
    log.add({
      level: 'warn',
      kind: 'request',
      message: `${hostOf(url)} 所在页面的重试次数已达单页上限，本页后续裂图不再重试。`
        + '这通常意味着大批节点同时不可用 —— 请到设置页做一次全量测速。',
    });
    queueRuntimeSave();
    return { ok: true };
  }

  if (abandoned) {
    // 兜底那一路只有 used / ok / fail 三个口径，没有「结果未知」的位置；
    // 而重发的悬空是必须能看见的，所以只在 retry 这一路记
    if (kind !== 'fallback') await noteRetryMetric({ kind: 'abandoned', at: Date.now() });
    return { ok: true };
  }

  if (kind === 'fallback') {
    await noteFallbackProxyMetric({ ok: succeeded, at: Date.now() });
  } else if (succeeded) {
    await noteRetryMetric({ kind: 'recovered', at: Date.now() });
  }

  // 成功之后必须忘掉旧的失败原因：同一张图下次再裂时若读到这条陈旧记录，
  // 会按上一次的原因做判定
  if (succeeded && typeof url === 'string') forgetFailure(url);

  return { ok: true };
}

/** 供测试与诊断：清掉进程内的日志去重状态 */
export function resetRetryThrottle() {
  spoken.clear();
}
