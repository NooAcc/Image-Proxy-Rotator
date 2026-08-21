/**
 * 共享组件层：两个页面共用的展示构造器。
 *
 * 为什么要有这一层 —— 重做之前，徽标和状态圆点在 options.js 与 popup.js 里各写了
 * 一遍，同一个东西两份实现，改一处必漏一处。凡是两页都会出现的视觉元素，一律在
 * 这里落地，页面只管调用。
 *
 * 本模块**不得**写死任何页面 id：它接收调用方传进来的节点，不自己去 DOM 里找。
 * 这条由 tests/ui-contract.test.js 断言。
 */

import { el } from './api.js';
import { isSupported } from '../../lib/node-model.js';

/**
 * 节点状态的展示词典。
 *
 * 每个状态都同时给出**字形、文字、色调**三样，缺一不可 —— WCAG 1.4.1 要求不能
 * 只靠颜色传达信息，而绿色与红色的相对亮度天然接近，色觉障碍或灰度显示下仅凭
 * 色相分不开。所以颜色只是第三重线索，字形与文字才是主线索。
 *
 * 约束（由 tests/ui-status.test.js 守）：labels 互不相同，且 (glyph, tone) 组合
 * 互不相同 —— 任何两个状态都不允许长得一模一样。
 */
export const NODE_STATUS = {
  ok: { glyph: '●', label: '正常', tone: 'ok' },
  slow: { glyph: '◐', label: '偏慢', tone: 'warn' },
  fail: { glyph: '✕', label: '失败', tone: 'err' },
  unknown: { glyph: '○', label: '未测速', tone: 'muted' },
  'manual-off': { glyph: '⊘', label: '已手动禁用', tone: 'muted' },
  'auto-off': { glyph: '⊘', label: '已自动禁用', tone: 'warn' },
  unsupported: { glyph: '⊗', label: '不支持', tone: 'err' },
};

/**
 * 节点 → 状态键。纯函数，不碰 DOM，可在 Node 下直接单测。
 *
 * 判定顺序即优先级：协议不支持是硬否决（这类节点永远进不了轮询池），
 * 其次才是手动禁用、自动禁用，最后才看测速结果。
 *
 * @param {object} node
 * @returns {keyof typeof NODE_STATUS}
 */
export function nodeStatus(node) {
  if (!isSupported(node)) return 'unsupported';
  if (!node.enabled) return 'manual-off';
  if (node.autoDisabled) return 'auto-off';
  switch (node.health?.status) {
    case 'ok': return 'ok';
    case 'slow': return 'slow';
    case 'fail': return 'fail';
    default: return 'unknown';
  }
}

/** 节点状态的中文说明，供 title 与无障碍文本复用 */
export function statusLabel(node) {
  return NODE_STATUS[nodeStatus(node)].label;
}

/**
 * 状态指示器：字形 + 文字 + 色调。
 *
 * 字形标记 aria-hidden —— 它与紧随其后的文字表达同一件事，读屏不必念两遍。
 * @param {object} node
 * @param {{compact?: boolean}} options compact 时只显示字形，文字进 title
 */
export function statusChip(node, { compact = false } = {}) {
  const state = nodeStatus(node);
  const { glyph, label, tone } = NODE_STATUS[state];
  return el('span', {
    class: `status status--${tone}`,
    dataset: { state },
    title: compact ? label : '',
  },
  el('span', { class: 'status__glyph', 'aria-hidden': 'true', text: glyph }),
  el('span', { class: compact ? 'sr-only' : 'status__label', text: label }));
}

/**
 * 按钮。
 * @param {object} options
 * @param {string} options.text 按钮文字；图标按钮也必须给文字（可配 srOnly）
 * @param {Function} options.onClick
 * @param {'default'|'primary'|'danger'|'ghost'} [options.variant]
 * @param {'md'|'sm'} [options.size]
 */
export function btn({ text, onClick, variant = 'default', size = 'md', title = '', disabled = false }) {
  const classes = ['btn', `btn--${variant}`];
  if (size === 'sm') classes.push('btn--sm');
  return el('button', {
    type: 'button',
    class: classes.join(' '),
    text,
    title,
    disabled: disabled || null,
    onclick: onClick,
  });
}

/**
 * 徽标。
 * @param {string} text
 * @param {'neutral'|'accent'|'ok'|'warn'|'err'} [tone]
 */
export function badge(text, tone = 'neutral') {
  return el('span', { class: `badge badge--${tone}`, text });
}

/** 空列表占位文案 */
export function emptyState(text) {
  return el('p', { class: 'empty', text });
}

/**
 * 写入提示条；message 为空则隐藏。
 *
 * 换行由 CSS 的 white-space: pre-wrap 承担，所以调用方可以直接塞多行文本
 * （导入报错会逐条列出），不需要在 JS 里改样式。
 *
 * @param {HTMLElement} node
 * @param {string} message
 * @param {'err'|'warn'|'ok'|'info'} [tone]
 */
export function setBanner(node, message, tone = 'err') {
  if (!node) return;
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.className = `banner banner--${tone}`;
  node.textContent = message;
}

/**
 * 无障碍状态播报：把一句**带上下文**的话写进 role="status" 容器。
 *
 * 只写数字（"3"）读屏念出来毫无意义，必须是完整语义（"可用节点 3 个"）。
 *
 * 内容没变就不写。弹窗每 2 秒刷新一次统计，而把 textContent 赋成同一个字符串
 * 仍然算 DOM 变更 —— 不拦住的话读屏会每两秒重念一遍同样的话。
 *
 * @param {HTMLElement} node
 * @param {string} message
 */
export function announce(node, message) {
  if (!node || node.textContent === message) return;
  node.textContent = message;
}

/**
 * 指标卡：一个大数字 + 一行说明。
 *
 * 数字单独存在没有意义，所以 label 是必填的，且用 `<dt>/<dd>` 的语义关系
 * 把两者绑在一起 —— 读屏会念成「请求总数：128」而不是孤零零一个「128」。
 *
 * @param {object} options
 * @param {string} options.label 说明文字
 * @param {string|number|null} options.value 数值；null/undefined 显示为「—」
 * @param {string} [options.unit] 单位，小字跟在数字后
 * @param {'ok'|'warn'|'err'|''} [options.tone] 色调，只作为第三重线索
 * @param {string} [options.hint] 补充说明
 */
export function kpi({ label, value, unit = '', tone = '', hint = '' }) {
  const shown = value === null || value === undefined || value === '' ? '—' : String(value);
  return el('div', { class: 'kpi' },
    el('dt', { class: 'kpi__label', text: label }),
    el('dd', { class: 'kpi__value' },
      el('span', { class: `num kpi__num ${tone ? `status--${tone}` : ''}`, text: shown }),
      unit && shown !== '—' ? el('span', { class: 'kpi__unit', text: unit }) : null,
    ),
    hint ? el('p', { class: 'kpi__hint', text: hint }) : null,
  );
}

/**
 * 占比条。
 *
 * 用原生 `<progress>` 而不是「div + 动态 width」：后者必须写内联样式，而本项目的
 * 约定是一切视觉走令牌（由 tests/ui-contract.test.js 断言）。`<progress>` 的填充量
 * 是属性而不是样式，正好绕开这个矛盾，还自带语义。
 *
 * 条本身标 aria-hidden：紧随其后的百分比文字已经把信息说清了，读屏不必念两遍。
 *
 * @param {number} percent 0–100
 */
export function shareBar(percent) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  return el('div', { class: 'share' },
    el('progress', { class: 'share__bar', max: 100, value, 'aria-hidden': 'true' }),
    el('span', { class: 'share__pct num', text: `${value}%` }),
  );
}

/**
 * 名称-取值行的容器项，用于「运行状态」这类键值清单。
 * @param {string} label
 * @param {...(Node|string|null)} value
 */
export function kvRow(label, ...value) {
  return el('div', { class: 'kv__row' },
    el('dt', { class: 'kv__key', text: label }),
    el('dd', { class: 'kv__val' }, ...value),
  );
}
