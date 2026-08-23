/**
 * 兜底窗口 —— 「用尽之后那一次重试走兜底代理」的实现。
 *
 * **为什么是窗口而不是单次。** 浏览器交给 PAC 的 https URL 只剩 `https://主机/`
 * （见 lib/pac-url.js），同一个源的「首次请求」与「用尽后的重试」在 PAC 眼里一模一样。
 * 所以「只让这一张图走兜底代理」在 MV3 里表达不出来 —— 能表达的最接近的东西是
 * 「接下来 FALLBACK_WINDOW_MS 内，该源的请求都走兜底代理」。
 *
 * 这与用户直觉之间的差距必须写在设置页上，不能藏着。差距在实践中比听起来小：兜底触发的
 * 前提本来就是「这个源上的轮询节点刚刚连续失败了 maxAttempts 次」，此时把同源的其他
 * 请求也送去兜底代理，往往正是当下最该做的事。
 *
 * **窗口的过期时间写进 PAC，不靠这里的定时器。** 见 pac-generator 里 `data.force` 的
 * 注释：SW 随时会被回收，靠定时器撤销就意味着「SW 在窗口期内死掉 = 该源被永久钉在
 * 兜底代理上」。所以本模块的定时器只负责**清理**（把 PAC 换回干净的那份），
 * 正确性由 PAC 自己的 `until` 保证。
 *
 * **状态全在内存里，不持久化。** SW 重启后窗口与冷却记录一起丢失，于是兜底可能比预期
 * 更早地再次开窗。方向刻意偏向「可用」而不是「抑制」—— 冷却是保护措施，不是正确性约束。
 */

import { FALLBACK_WINDOW_MS, FALLBACK_COOLDOWN_MS } from '../lib/constants.js';
import { fallbackProxyToken } from '../lib/fallback-proxy.js';
import { dbg } from './debug-store.js';

/** 源 -> 窗口过期时刻。同时是「这个源现在是否开着窗」的唯一来源 */
const windows = new Map();
/** 源 -> 冷却结束时刻 */
const cooldowns = new Map();

/**
 * 跟踪的源数上限。
 * 一个长驻的 SW 逛过几百个站点也不该让这两张表无界增长；超了就整体清空 ——
 * 代价是丢掉冷却记录（偏向可用，与 SW 重启同一个方向）。
 */
const MAX_ORIGINS = 200;

/** 从 URL 取「源前缀」，形如 `https://i.example.net/`。取不到返回 null */
export function originPrefix(url) {
  try {
    return `${new URL(String(url)).origin}/`;
  } catch {
    return null;
  }
}

/** 供测试重置模块内状态 */
export function resetFallbackWindows() {
  windows.clear();
  cooldowns.clear();
}

/** 顺手清掉已经过期的条目，别让两张表靠上限兜底 */
function sweep(now) {
  for (const [origin, until] of windows) if (now >= until) windows.delete(origin);
  for (const [origin, until] of cooldowns) if (now >= until) cooldowns.delete(origin);
  if (windows.size + cooldowns.size > MAX_ORIGINS) {
    windows.clear();
    cooldowns.clear();
  }
}

/**
 * 当前该写进 PAC 的强制路由条目。
 *
 * 每次 `applyProxy()` 都会问一遍，所以过期条目在这里就被滤掉了 —— PAC 里那份 `until`
 * 是给「PAC 已经注入、后台却没来得及更新」那段时间兜底的。
 *
 * @param {object} config
 * @param {number} [now]
 * @returns {{pre: string, tok: string, until: number}[]}
 */
export function fallbackForceEntries(config, now = Date.now()) {
  const token = fallbackProxyToken(config?.settings?.fallbackProxy);
  if (!token) return [];
  sweep(now);
  return [...windows.entries()]
    .filter(([, until]) => until > now)
    .map(([pre, until]) => ({ pre, tok: token, until }));
}

/** 这个源现在开着窗吗（供诊断与日志措辞） */
export function isFallbackWindowOpen(url, now = Date.now()) {
  const origin = originPrefix(url);
  if (!origin) return false;
  const until = windows.get(origin);
  return Boolean(until && until > now);
}

/**
 * 为这个 URL 所在的源开一扇兜底窗口。
 *
 * **不负责注入 PAC** —— 调用方拿到 `{ok:true, reused:false}` 之后必须自己调
 * `applyProxy()`，且注入失败时不能把 `fallback` 回给页面。职责这么分是因为
 * `applyProxy` 在 proxy-controller 里，而它已经引了太多东西；反向依赖会绕成循环。
 *
 * @param {string} url
 * @param {number} [now]
 * @returns {{ok: true, reused: boolean, origin: string, until: number}
 *          |{ok: false, reason: 'unconfigured'|'bad-url'|'cooldown', until?: number}}
 */
export function openFallbackWindow(url, now = Date.now()) {
  const origin = originPrefix(url);
  if (!origin) return { ok: false, reason: 'bad-url' };

  sweep(now);

  const open = windows.get(origin);
  if (open && open > now) {
    // 窗口已经开着：这个源本来就已经指向兜底代理了，重发即可，绝不重注入 PAC。
    // 一次大面积失败会让几十张图同时走到这里，每张都重注入一遍 PAC 就是自找的抖动
    if (dbg.on) dbg('retry', 'fallback-window-reused', { origin, until: open });
    return { ok: true, reused: true, origin, until: open };
  }

  const cooling = cooldowns.get(origin);
  if (cooling && cooling > now) {
    if (dbg.on) dbg('retry', 'fallback-cooldown', { origin, until: cooling });
    return { ok: false, reason: 'cooldown', until: cooling };
  }

  const until = now + FALLBACK_WINDOW_MS;
  windows.set(origin, until);
  // 冷却从**窗口关闭**起算，所以现在就把结束时刻定下来：开窗 + 窗口时长 + 冷却时长
  cooldowns.set(origin, until + FALLBACK_COOLDOWN_MS);
  if (dbg.on) dbg('retry', 'fallback-window-opened', { origin, until, windowMs: FALLBACK_WINDOW_MS });
  return { ok: true, reused: false, origin, until };
}

/**
 * 开窗失败时把它撤掉。
 *
 * `applyProxy()` 注入失败时必须调这个：窗口记着「已开」而 PAC 里其实没有对应条目，
 * 下一张图就会因为「窗口已开」而直接重发，落到普通轮询节点上却被记成一次兜底。
 */
export function abortFallbackWindow(origin) {
  if (!origin) return;
  windows.delete(origin);
  cooldowns.delete(origin);
  if (dbg.on) dbg('retry', 'fallback-window-aborted', { origin });
}

/** 还有窗口开着吗（供 proxy-controller 决定要不要排一次清理） */
export function hasOpenFallbackWindow(now = Date.now()) {
  for (const until of windows.values()) if (until > now) return true;
  return false;
}

/** 最早的一个窗口什么时候到点；没有窗口时返回 null */
export function nextFallbackExpiry(now = Date.now()) {
  let earliest = null;
  for (const until of windows.values()) {
    if (until <= now) continue;
    if (earliest === null || until < earliest) earliest = until;
  }
  return earliest;
}
