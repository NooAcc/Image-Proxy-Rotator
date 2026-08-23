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
import { getConfig, getLogger, queueRuntimeSave } from './state.js';
import { observedFailure, forgetFailure, noteRetryAsked } from './request-logger.js';
import { noteRetryMetric, noteFallbackImageMetric } from './metrics-store.js';
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
  exhausted: '已用尽可尝试的节点，且没有可用的兜底图片代理',
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
  const fallbackImage = config.settings.fallbackImage;

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

  // 兜底是**图片**代理：把一个 JSON 接口套进 `?url=` 里毫无意义，而 fetch / XHR 这两条路
  // 分不出取的是图还是数据。所以只有 `<img>` 与 `new Image()` 能走到兜底 —— 其余在这里就
  // 把兜底关掉，让判定落到 `exhausted`。若只在补丁那侧挡，`planRetry` 会先把
  // `fallbackImage.used` 记上一笔，面板于是显示「兜底用了 N 次」而它一次都没被用过
  const canFallback = via !== 'fetch' && via !== 'xhr';

  const plan = decideRetry({
    url,
    attempt,
    kind,
    matched: true,
    maxAttempts: retry.maxAttempts,
    fallbackEnabled: canFallback && fallbackImage.enabled,
    fallbackTemplate: fallbackImage.template,
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
      fallbackEnabled: fallbackImage.enabled,
      fallbackOffered: canFallback && fallbackImage.enabled,
      fallbackUrl: plan.url ?? null,
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

  if (plan.action === 'fallback') {
    // exhausted 与 fallbackImage.used 是两个口径：前者数「轮询节点都试过了」，
    // 后者数「其中有多少次真的交给了兜底」。exhausted >= used 恒成立
    await noteRetryMetric({ kind: 'exhausted', at: Date.now() });
    await noteFallbackImageMetric({ used: true, at: Date.now() });
    if (shouldSpeak(`${hostOf(url)}|fallback`)) {
      log.add({
        level: 'warn',
        kind: 'request',
        message: `${hostOf(url)} 的图片在 ${retry.maxAttempts} 个节点上都失败了，改用兜底图片代理。`
          + '注意：兜底服务会拿到图片地址。',
      });
    }
    queueRuntimeSave();
    return { action: 'fallback', url: plan.url, delayMs: retry.delayMs };
  }

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
    await noteFallbackImageMetric({ ok: succeeded, at: Date.now() });
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
