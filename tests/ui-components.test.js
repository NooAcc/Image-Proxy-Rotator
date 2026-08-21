/**
 * 共享组件构造器的行为契约。
 *
 * 这些构造器输出 DOM，所以本文件先装一个**极小的 document 替身**再导入它们。
 * 不引 jsdom：本项目零依赖，而这里要验的东西也不需要一个完整的浏览器 ——
 * 需要验的是 el() 那条「属性还是 attribute」的分支有没有把事情做对。
 *
 * 为什么值得测：占比条用的是原生 `<progress>`，填充量走 value/max **属性**。
 * 如果 el() 把它们当 attribute 写进去（或者反过来），条子会永远是空的，
 * 而页面不会报任何错 —— 这正是最难发现的一类问题。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- DOM 替身

class StubNode {}

class StubElement extends StubNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.textContent = '';
    this.attrs = {};
    this.kids = [];
    this.dataset = {};
    this.events = {};

    // 只给真实元素上确实存在的 IDL 属性开口。多开一个，el() 的 `key in node`
    // 分支就会把本该 setAttribute 的东西写成属性，测试也就失去了意义。
    if (tag === 'progress') {
      this.max = 1;
      this.value = 0;
    }
  }

  setAttribute(key, value) {
    this.attrs[key] = String(value);
  }

  append(...nodes) {
    this.kids.push(...nodes);
  }

  addEventListener(type, fn) {
    (this.events[type] ??= []).push(fn);
  }
}

globalThis.Node = StubNode;
globalThis.document = {
  createElement: (tag) => new StubElement(tag),
  createTextNode: (text) => Object.assign(new StubNode(), { textContent: String(text) }),
};

const { kpi, shareBar, kvRow, badge } = await import('../src/pages/shared/ui.js');

/** 递归收集一棵子树里的全部文字 */
function textOf(node) {
  const own = node.textContent ?? '';
  return own + (node.kids ?? []).map(textOf).join('');
}

/** 按 class 找第一个后代 */
function find(node, className) {
  for (const kid of node.kids ?? []) {
    if (kid.className?.split(' ').includes(className)) return kid;
    const deeper = find(kid, className);
    if (deeper) return deeper;
  }
  return null;
}

// ---------------------------------------------------------------- kpi

test('kpi 用 dt/dd 把数字和它的说明绑在一起', () => {
  // 单独一个「128」读屏念出来毫无意义，必须是「走代理的请求：128」
  const node = kpi({ label: '走代理的请求', value: 128, unit: '次' });
  assert.equal(node.className, 'kpi');
  assert.equal(node.kids[0].tagName, 'DT');
  assert.equal(node.kids[0].textContent, '走代理的请求');
  assert.equal(node.kids[1].tagName, 'DD');
  assert.match(textOf(node), /128/);
  assert.match(textOf(node), /次/);
});

test('kpi 把「没有数据」显示成破折号，而不是 0 或 undefined', () => {
  // 0% 和「还没测到」是两件完全不同的事，混在一起会误导排查方向
  for (const value of [null, undefined, '']) {
    const node = kpi({ label: '成功率', value, unit: '%' });
    assert.match(textOf(node), /—/, `${JSON.stringify(value)} 应显示为破折号`);
    assert.doesNotMatch(textOf(node), /%/, '没有数值时不该拖着一个单位');
  }
});

test('kpi 的色调只是第三重线索，数字本身始终在', () => {
  const node = kpi({ label: '失败', value: 3, tone: 'err' });
  assert.match(find(node, 'kpi__num').className, /status--err/);
  assert.match(textOf(node), /3/);
});

test('kpi 的补充说明可选', () => {
  assert.equal(find(kpi({ label: 'x', value: 1 }), 'kpi__hint'), null);
  assert.match(textOf(kpi({ label: 'x', value: 1, hint: '只统计命中规则的请求' })), /只统计/);
});

// ---------------------------------------------------------------- shareBar

test('shareBar 把填充量写成 progress 的属性，不是内联样式', () => {
  const node = shareBar(42);
  const bar = find(node, 'share__bar');
  assert.equal(bar.tagName, 'PROGRESS');
  assert.equal(bar.value, 42, 'value 必须落在 IDL 属性上，否则条子永远是空的');
  assert.equal(bar.max, 100);
  assert.equal(bar.attrs.style, undefined, '不允许内联样式');
});

test('shareBar 的百分比文字与条子同步，且条子对读屏隐藏', () => {
  const node = shareBar(42);
  assert.equal(find(node, 'share__pct').textContent, '42%');
  assert.equal(find(node, 'share__bar').attrs['aria-hidden'], 'true', '文字已经说清了，别念两遍');
});

test('shareBar 把越界与非法输入夹到 0–100', () => {
  for (const [input, expected] of [[-5, 0], [140, 100], [NaN, 0], [undefined, 0], [0, 0], [100, 100]]) {
    assert.equal(find(shareBar(input), 'share__bar').value, expected, `${input} 应夹成 ${expected}`);
  }
});

// ---------------------------------------------------------------- kvRow

test('kvRow 同样是 dt/dd，取值可以是节点也可以是文字', () => {
  const row = kvRow('当前状态', badge('已生效', 'ok'));
  assert.equal(row.className, 'kv__row');
  assert.equal(row.kids[0].tagName, 'DT');
  assert.equal(row.kids[0].textContent, '当前状态');
  assert.equal(row.kids[1].tagName, 'DD');
  assert.match(textOf(row), /已生效/);

  assert.match(textOf(kvRow('上次注入', '从未')), /从未/);
});
