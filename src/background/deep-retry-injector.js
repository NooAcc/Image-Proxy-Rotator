/**
 * 深度重试的注入管理 —— 主世界补丁到底装在哪些站点上。
 *
 * **为什么是动态注册而不是 manifest 里静态声明（决策 D31）。** 静态声明只能写死
 * `matches`，要按用户的清单收窄就只有 `<all_urls>` + 运行时自查这一条路，而那条路有两个
 * 硬问题：一是所有页面都被注入了主世界代码，第 16、19 节担心的事一件没少；二是补丁必须
 * 在自己被执行的第一个同步 tick 里就完成包装（页面脚本随时会把 `window.fetch` 取走），
 * 而「这个站点勾了没有」得跨桥异步问后台 —— 等答案回来早就晚了。
 *
 * 所以「装不装」必须由**注册时机**决定，不能由运行时判断决定。
 *
 * **注册状态必须与配置同步更新。** 这个模块由 `applyProxy()` 调用，而不是散落在十几个
 * 改配置的 handler 里 —— 那样早晚会漏一处，而漏掉的表现是「规则改了、注入范围没跟上」，
 * 又一种不报错的静默失效。
 */

import { deepRetryPatterns } from '../lib/deep-retry.js';
import { getConfig, getLogger } from './state.js';
import { dbg } from './debug-store.js';

/** 两个脚本的固定 id。改名会导致旧注册无法被识别与清理，切勿修改 */
const BRIDGE_ID = 'pp-deep-bridge';
const PATCH_ID = 'pp-deep-patch';
const IDS = [BRIDGE_ID, PATCH_ID];

/**
 * 上一次成功同步的模式签名。
 *
 * `applyProxy()` 会在每次测速结束时被调用一次，节点多的时候一轮下来就是十几次。
 * 没有这道短路，每次都要去问一遍 `getRegisteredContentScripts()`。SW 被回收后签名
 * 归空，于是唤醒后必然重新核对一次 —— 不会因为缓存而漏掉真实的偏差。
 */
let lastSignature = null;

/** 供测试重置模块内状态 */
export function resetDeepRetrySync() {
  lastSignature = null;
}

function buildScripts(patterns) {
  return [
    {
      id: BRIDGE_ID,
      js: ['src/content/deep-bridge.js'],
      matches: patterns,
      runAt: 'document_start',
      allFrames: true,
      world: 'ISOLATED',
    },
    {
      id: PATCH_ID,
      js: ['src/content/deep-patch.js'],
      matches: patterns,
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
    },
  ];
}

/**
 * 把注册状态对齐到当前配置。
 *
 * @returns {Promise<{active: boolean, patterns: string[], skipped: object[], error: ?string}>}
 */
export async function syncDeepRetryScripts() {
  const config = await getConfig();
  const deep = config.settings.deepRetry;
  const { patterns, skipped } = deepRetryPatterns(deep?.sites);
  // normalizeDeepRetry 已经保证「一条可用模式都没有时 enabled 必为 false」，
  // 这里再判一次 patterns.length 是为了不依赖那个不变量
  const wanted = deep?.enabled === true && patterns.length > 0 ? patterns : [];
  const signature = wanted.join('\n');

  if (signature === lastSignature) return { active: wanted.length > 0, patterns: wanted, skipped, error: null };

  if (!chrome.scripting) {
    const error = '当前浏览器不支持 chrome.scripting，深度重试无法启用（需要 Chrome / Edge 111 及以上）';
    if (wanted.length > 0) (await getLogger()).add({ level: 'error', kind: 'config', message: error });
    return { active: false, patterns: [], skipped, error };
  }

  const log = await getLogger();
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: IDS });
    const registered = new Set(existing.map((s) => s.id));

    if (wanted.length === 0) {
      if (registered.size > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: [...registered] });
        log.add({ level: 'info', kind: 'config', message: '深度重试已关闭，主世界补丁已从所有站点撤下' });
      }
      lastSignature = signature;
      if (dbg.on) dbg('config', 'deep-unregistered', { had: registered.size });
      return { active: false, patterns: [], skipped, error: null };
    }

    const scripts = buildScripts(wanted);
    // 两个脚本要么都注册要么都不注册：只有桥没有补丁等于什么都不做，
    // 只有补丁没有桥则是补丁问不到人、每次都等满超时
    const toUpdate = scripts.filter((s) => registered.has(s.id));
    const toRegister = scripts.filter((s) => !registered.has(s.id));
    if (toUpdate.length > 0) await chrome.scripting.updateContentScripts(toUpdate);
    if (toRegister.length > 0) await chrome.scripting.registerContentScripts(toRegister);

    lastSignature = signature;
    if (dbg.on) dbg('config', 'deep-registered', { patterns: wanted, skipped: skipped.length });
    log.add({
      level: 'info',
      kind: 'config',
      message: `深度重试已生效：主世界补丁注册到 ${wanted.length} 个匹配范围（${wanted.join('、')}）`,
    });
    return { active: true, patterns: wanted, skipped, error: null };
  } catch (e) {
    const error = String(e?.message || e);
    // 注册失败绝不能只留一个 catch {}：失败之后页面照常加载、补丁只是不存在，
    // 表现就是「勾了但没用」—— 本项目最讨厌的那类静默失效
    lastSignature = null;
    log.add({
      level: 'error',
      kind: 'config',
      message: `深度重试注入失败：${error}。补丁没有装上，这些站点的 fetch / XHR / 预加载图仍然不会被重试。`,
    });
    if (dbg.on) dbg('config', 'deep-register-failed', { error, patterns: wanted });
    return { active: false, patterns: [], skipped, error };
  }
}
