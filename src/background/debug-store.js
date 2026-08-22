/**
 * 调试日志的后台侧 —— 缓冲的唯一持有者。
 *
 * **为什么汇聚到这里。** 内容脚本与 UI 页面各自的存储都是页面级的：每个 tab、每个
 * iframe 一份，页一关就没，导出时根本不知道该去哪些 tab 收。而这套日志的价值恰恰在于
 * 把「后台判定」和「页面执行」拼成一条时间线，分散存储等于放弃这件事。所以页面侧只管
 * 攒一小批发过来（debugPush），存、限、导全在这里 —— 内容脚本继续保持很笨（决策 D21）。
 *
 * **开关放 storage.local 的独立键，不进 config。** 两个理由：它不该被「导出配置」带给
 * 别人（那是配置，不是你的调试状态）；而放在独立键上，内容脚本与 UI 能直接读并监听
 * onChanged，不必为「我现在该不该记」再往后台发一次消息。
 *
 * **缓冲写 storage.session。** 跨 Service Worker 回收不丢，浏览器重启自动清空 ——
 * 一份诊断日志不该在用户机器上无限期留着，也不该跟 config / metrics 抢 local 的配额。
 */

import { createDebugLog, debugFileName, DEBUG_NS, PUSH_ROWS_MAX } from '../lib/debug-log.js';

/** storage.local：开关。形状 { enabled: boolean, since: ?number } */
export const DEBUG_KEY = 'debug';
/** storage.session：缓冲快照 */
export const DEBUG_LOG_KEY = 'debugLog';

/** 落盘节流窗口，沿用决策 D15 的手法 */
const FLUSH_INTERVAL_MS = 3000;
/** 或者攒够这么多条就立刻写 */
const FLUSH_AFTER_ROWS = 200;

const log = createDebugLog();

let pending = 0;
let timer = null;
let wired = false;
/** session 里的快照只接一次。接两次就是把同一批行复读一遍 */
let restored = false;

function stopTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

async function removeStored() {
  try {
    await chrome.storage.session.remove(DEBUG_LOG_KEY);
  } catch {
    // 删不掉不致命：下次开启会整份覆盖
  }
}

/** 真正落盘 */
async function write() {
  stopTimer();
  pending = 0;
  if (!log.on) return;
  try {
    await chrome.storage.session.set({ [DEBUG_LOG_KEY]: log.list() });
  } catch {
    // session 配额或权限问题：缓冲留在内存里，只丢掉「跨 SW 回收」这一项能力，
    // 分流本身不受影响（见 docs/LIMITATIONS.md）
  }
}

function schedule() {
  pending++;
  if (pending >= FLUSH_AFTER_ROWS) {
    void write();
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void write();
  }, FLUSH_INTERVAL_MS);
  // Node 下跑测试时别让待触发的定时器吊住进程；浏览器里 setTimeout 返回数字，自然跳过
  if (typeof timer?.unref === 'function') timer.unref();
}

/** 开关变更的唯一入口，保证内存、缓冲、存储三者一致 */
async function applyEnabled(next) {
  if (next === log.on) return;
  log.enable(next);
  if (next) return;
  stopTimer();
  pending = 0;
  await removeStored();
}

/**
 * 记一条调试日志。
 *
 * **调用点一律写 `if (dbg.on) dbg(...)`** —— 关着时这个函数立刻返回，但那还不够：
 * 不加守卫的话 `{ ...十个字段 }` 这个对象字面量照样要构造，而一个漫画页有几百个请求。
 */
export function dbg(ns, ev, data) {
  if (!log.on) return;
  log.push(ns, ev, data);
  schedule();
}

/** 活的开关。热路径守卫用它 */
Object.defineProperty(dbg, 'on', { get: () => log.on });

/**
 * 启动流程：读开关、监听变更、把 SW 被回收前的缓冲接回来。
 * 可重复调用（监听器只注册一次）。
 */
export async function initDebug() {
  if (!wired) {
    wired = true;
    try {
      chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== 'local' || !changes?.[DEBUG_KEY]) return;
        await applyEnabled(changes[DEBUG_KEY].newValue?.enabled === true);
      });
    } catch {
      // 没有 onChanged 也不致命：设置页那次写入在 SW 下次启动时照样读得到
    }
  }

  let stored = null;
  try {
    stored = (await chrome.storage.local.get(DEBUG_KEY))?.[DEBUG_KEY];
  } catch {
    // 读不到就当没开
  }
  await applyEnabled(stored?.enabled === true);
  if (!log.on || restored) return;
  restored = true;

  try {
    const got = await chrome.storage.session.get(DEBUG_LOG_KEY);
    log.restore(got?.[DEBUG_LOG_KEY]);
  } catch {
    // 恢复失败只丢历史
  }
}

/** 开 / 关。关闭时顺手清空 —— 「开关是关的但导出还有东西」是最容易被误读的状态 */
export async function setDebugEnabled(value) {
  const next = value === true;
  try {
    await chrome.storage.local.set({ [DEBUG_KEY]: { enabled: next, since: next ? Date.now() : null } });
  } catch {
    // 存不住开关就只在本次 SW 生命周期内有效
  }
  await applyEnabled(next);
  return next;
}

/** 给诊断面板的快照 */
export async function debugState() {
  return { enabled: log.on, stats: log.stats(), groups: log.groups() };
}

/** 内容脚本 / UI 的批量回传入口 */
export async function acceptDebugRows(rows) {
  if (!log.on) return 0;
  const taken = log.pushRows(rows, { max: PUSH_ROWS_MAX });
  if (taken > 0) schedule();
  return taken;
}

/** 每个非空命名空间一个文件，另加一份把时间线接起来的合并文件 */
export async function exportDebugFiles() {
  const at = Date.now();
  let version = '';
  try {
    version = chrome.runtime.getManifest()?.version ?? '';
  } catch {
    // 拿不到版本号就留空，不值得为它中断导出
  }

  const meta = { version, at };
  const files = [];
  for (const ns of DEBUG_NS) {
    const text = log.format(ns, meta);
    if (text) files.push({ name: debugFileName(ns, at), text });
  }
  const merged = log.formatMerged(meta);
  return { files, merged: merged ? { name: debugFileName('all', at), text: merged } : null };
}

/** 只清 debug 缓冲。活动日志与统计是另外两件事，混在一起会让人不敢点 */
export async function clearDebugLog() {
  log.clear();
  stopTimer();
  pending = 0;
  await removeStored();
}

/** 立刻落盘。导出前与低频重要时刻用它，别等窗口 */
export async function flushDebugLog() {
  await write();
}
