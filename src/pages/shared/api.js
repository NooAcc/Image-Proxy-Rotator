/**
 * 页面侧与后台通信的封装，以及一些共用的格式化辅助函数。
 *
 * 页面**不维护第二份状态**：写操作的返回值里带着新的 config，直接拿它重渲染。
 * 展示组件（徽标、状态指示器、按钮）在 shared/ui.js，这里只管通信与格式化。
 */

// ---------------------------------------------------------------- 调试日志（页面侧）

/**
 * 开发者调试日志的页面端（决策 D25）。存与导都在后台，这里只攒一小批发过去。
 *
 * **DEBUG_SELF_TYPES 不是优化，是正确性。** 少了它，`debugPush` 自己会被记成新的一行，
 * 下次 flush 又把它发出去，而 flush 由定时器驱动 —— 于是日志永远在记录自己，永不收敛。
 */
const DEBUG_KEY = 'debug';
const DEBUG_SELF_TYPES = new Set(['getDebug', 'setDebug', 'debugPush', 'exportDebug', 'clearDebug']);
const DEBUG_BATCH = 10;
const DEBUG_FLUSH_MS = 1000;

let debugOn = false;
let debugQueue = [];
let debugTimer = null;

/** 把攒着的行发给后台。弹窗随时会被关掉，所以任何收尾时机都要调它 */
export async function flushUiDebug() {
  if (debugTimer) {
    clearTimeout(debugTimer);
    debugTimer = null;
  }
  if (debugQueue.length === 0) return;
  const rows = debugQueue;
  debugQueue = [];
  try {
    await send('debugPush', { rows });
  } catch {
    // 后台不在就丢掉这批，不能让调试日志的失败冒泡成页面报错
  }
}

/** 记一行页面侧日志 */
export function uiDbg(ev, data) {
  if (!debugOn) return;
  debugQueue.push({ at: Date.now(), ns: 'ui', ev, data: data || {} });
  if (debugQueue.length >= DEBUG_BATCH) {
    void flushUiDebug();
    return;
  }
  if (debugTimer) return;
  debugTimer = setTimeout(() => void flushUiDebug(), DEBUG_FLUSH_MS);
}

try {
  chrome.storage.local.get(DEBUG_KEY, (got) => {
    debugOn = !!(got && got[DEBUG_KEY] && got[DEBUG_KEY].enabled === true);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes || !changes[DEBUG_KEY]) return;
    debugOn = changes[DEBUG_KEY].newValue?.enabled === true;
    if (!debugOn) debugQueue = [];
  });
  // 弹窗被关掉时只有这个事件还来得及跑
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushUiDebug();
  });
} catch {
  // 拿不到 storage 就当开关是关的
}

/**
 * 向后台发一条消息。
 * @param {string} type 消息类型（见 background/messaging.js 的 handlers）
 * @param {object} payload
 * @returns {Promise<object>} 后台返回的结果
 * @throws {Error} 后台返回 ok:false 时抛出，message 是可直接展示的中文
 */
export async function send(type, payload = {}) {
  const traced = debugOn && !DEBUG_SELF_TYPES.has(type);
  const startedAt = traced ? Date.now() : 0;
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (e) {
    if (traced) uiDbg('sent', { type, ms: Date.now() - startedAt, ok: false, error: 'no-channel' });
    throw new Error(`无法与后台通信：${e?.message || e}（可尝试在扩展管理页重新加载扩展）`);
  }
  if (!response) {
    if (traced) uiDbg('sent', { type, ms: Date.now() - startedAt, ok: false, error: 'no-response' });
    throw new Error('后台没有响应，请在扩展管理页重新加载扩展');
  }
  if (traced) {
    uiDbg('sent', { type, ms: Date.now() - startedAt, ok: response.ok !== false, error: response.error ?? null });
  }
  if (response.ok === false) {
    const error = new Error(response.error || '操作失败');
    error.response = response;
    throw error;
  }
  return response;
}

/** 格式化时间戳为 HH:MM:SS */
export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 格式化延迟 */
export function fmtLatency(ms) {
  return Number.isFinite(ms) ? `${ms} ms` : '—';
}

/** 相对时间，例如「3 分钟前」 */
export function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '从未';
  const diff = Date.now() - ms;
  if (diff < 5000) return '刚刚';
  if (diff < 60000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  return `${Math.round(diff / 86400000)} 天前`;
}

/**
 * 轻量 DOM 构造器。
 * 全程使用 textContent / setAttribute，绝不拼 innerHTML —— 节点名和规则都来自
 * 用户粘贴的订阅内容，不能信任。
 *
 * @param {string} tag
 * @param {object} props class/text/title/value/type/... 以及 on* 事件
 * @param {...(Node|string|null|false)} children
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('禁止使用 html 属性，请改用 text');
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 清空一个容器 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 防抖 */
export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 下载一段文本为文件 */
export function downloadText(filename, text, type = 'application/json;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 复制到剪贴板，返回是否成功 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 时间戳后缀，用于导出文件名 */
export function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
