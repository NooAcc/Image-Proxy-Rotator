/**
 * 页面侧与后台通信的封装，以及一些共用的展示辅助函数。
 *
 * 页面**不维护第二份状态**：写操作的返回值里带着新的 config，直接拿它重渲染。
 */

/**
 * 向后台发一条消息。
 * @param {string} type 消息类型（见 background/messaging.js 的 handlers）
 * @param {object} payload
 * @returns {Promise<object>} 后台返回的结果
 * @throws {Error} 后台返回 ok:false 时抛出，message 是可直接展示的中文
 */
export async function send(type, payload = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (e) {
    throw new Error(`无法与后台通信：${e?.message || e}（可尝试在扩展管理页重新加载扩展）`);
  }
  if (!response) throw new Error('后台没有响应，请在扩展管理页重新加载扩展');
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

/** 健康状态 → 中文 */
export function healthLabel(node) {
  if (!node.enabled) return '已手动禁用';
  if (node.autoDisabled) return '已自动禁用';
  switch (node.health?.status) {
    case 'ok': return '正常';
    case 'slow': return '偏慢';
    case 'fail': return '失败';
    default: return '未测速';
  }
}

/** 健康状态 → 圆点 class */
export function healthDotClass(node) {
  if (!node.enabled || node.autoDisabled) return 'off';
  switch (node.health?.status) {
    case 'ok': return 'ok';
    case 'slow': return 'slow';
    case 'fail': return 'fail';
    default: return '';
  }
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

/** 在 banner 元素上显示消息；message 为空则隐藏 */
export function showBanner(node, message, level = 'err') {
  if (!node) return;
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.className = `banner ${level}`;
  node.textContent = message;
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
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
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
