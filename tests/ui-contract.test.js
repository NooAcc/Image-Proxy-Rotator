/**
 * 页面结构契约。
 *
 * HTML 与 JS 之间只靠 id 字符串维系：把 `#bypassList` 改个名，浏览器不会报错，
 * 只会安静地少渲染一块 —— 重排 UI 时这是最容易留下的伤口。这里把契约钉成断言：
 *
 *   1. JS 取的每个 id 在 HTML 里都存在，且 HTML 里的 id 不重复
 *   2. HTML 里的每个 id 都真的被用到（JS / CSS / label for），没有孤儿节点
 *   3. 每个表单控件都有可访问名（包裹 label、label for、或 aria-label）
 *   4. HTML/JS 里不出现内联样式 —— 一切视觉走 tokens.css 的令牌
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 三份共享脚本也参与 id 引用统计：组件构造器可能按 id 取节点 */
const SHARED_JS = ['api.js', 'ui.js'].map((n) => join(ROOT, 'src', 'pages', 'shared', n));

const PAGES = [
  { name: '设置页', dir: 'options', base: 'options' },
  { name: '弹窗', dir: 'popup', base: 'popup' },
];

function read(...parts) {
  return readFileSync(join(ROOT, 'src', 'pages', ...parts), 'utf8');
}

/** HTML 里声明的所有 id，按出现顺序 */
function declaredIds(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
}

/** JS 里直接取的 id：$('x')、getElementById('x')、以及 el() 里的 id 属性。
 *  这一组必须严格 —— 它是「JS 写错 id 名」的唯一探测手段。 */
function referencedIds(js) {
  const ids = new Set();
  for (const m of js.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
  return ids;
}

/** JS 里出现过的所有字符串字面量。
 *  查孤儿 id 时用这一组：id 常常经查找表间接取用（如 popup 的 VIEWS），
 *  写死成 $('x') 反而是更差的写法，不该被测试逼着那么写。 */
function quotedStrings(js) {
  return new Set([...js.matchAll(/['"]([^'"\n]+)['"]/g)].map((m) => m[1]));
}

/** `<label ... >` 到 `</label>` 的字符区间 */
function labelRanges(html) {
  const ranges = [];
  for (const m of html.matchAll(/<label\b/g)) {
    const end = html.indexOf('</label>', m.index);
    if (end > 0) ranges.push([m.index, end]);
  }
  return ranges;
}

for (const page of PAGES) {
  const html = read(page.dir, `${page.base}.html`);
  const js = read(page.dir, `${page.base}.js`);
  const css = read(page.dir, `${page.base}.css`);
  const ids = declaredIds(html);

  test(`${page.name}：HTML 里的 id 不重复`, () => {
    const seen = new Set();
    for (const id of ids) {
      assert.ok(!seen.has(id), `id "${id}" 在 HTML 里出现了多次`);
      seen.add(id);
    }
  });

  test(`${page.name}：JS 取的每个 id 都在 HTML 里存在`, () => {
    const declared = new Set(ids);
    for (const id of referencedIds(js)) {
      assert.ok(declared.has(id), `${page.base}.js 取了 #${id}，但 HTML 里没有这个 id`);
    }
  });

  test(`${page.name}：HTML 里没有孤儿 id`, () => {
    const inJs = quotedStrings(js);
    const componentsCss = read('shared', 'components.css');
    for (const id of ids) {
      const selector = new RegExp(`#${id}\\b`);
      const inCss = selector.test(css) || selector.test(componentsCss);
      // 侧栏是 <a href="#nodes">，锚点目标也算被用到
      const asAnchor = html.includes(`href="#${id}"`);
      const asLabel = html.includes(`for="${id}"`)
        || html.includes(`aria-labelledby="${id}"`)
        || html.includes(`aria-describedby="${id}"`);
      assert.ok(inJs.has(id) || inCss || asAnchor || asLabel,
        `#${id} 在 HTML 里声明了却没人用 —— 删掉它或接上逻辑`);
    }
  });

  test(`${page.name}：每个表单控件都有可访问名`, () => {
    const ranges = labelRanges(html);
    const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)];
    assert.ok(controls.length > 0, '页面里应当有表单控件');

    for (const control of controls) {
      const tag = control[0];
      if (/type="(hidden|file)"/.test(tag)) continue; // file 由外层 label.btn 承担点击与命名
      const named = /aria-label="/.test(tag) || /aria-labelledby="/.test(tag);
      const id = /\sid="([^"]+)"/.exec(tag)?.[1];
      const hasFor = id ? html.includes(`for="${id}"`) : false;
      const wrapped = ranges.some(([start, end]) => control.index > start && control.index < end);
      assert.ok(named || hasFor || wrapped,
        `${page.base}.html 里的控件缺少可访问名：${tag.slice(0, 80)}`);
    }
  });

  test(`${page.name}：不使用内联样式`, () => {
    assert.ok(!/\sstyle="/.test(html), `${page.base}.html 出现内联 style，应改用令牌与工具类`);
    assert.ok(!/\bstyle:\s*['"]/.test(js), `${page.base}.js 给 el() 传了 style，应改用 class`);
  });
}

test('共享脚本不直接按 id 取设置页/弹窗的节点', () => {
  // shared/ 要对两个页面都通用，写死某页的 id 就等于偷偷建立耦合
  for (const file of SHARED_JS) {
    const source = readFileSync(file, 'utf8');
    assert.equal(referencedIds(source).size, 0,
      `${file} 里出现了写死的 id 引用，共享层应只接收传入的节点`);
  }
});

test('两个页面都只引用拆分后的共享样式', () => {
  for (const page of PAGES) {
    const html = read(page.dir, `${page.base}.html`);
    assert.match(html, /href="\.\.\/shared\/tokens\.css"/, `${page.base}.html 应引用 tokens.css`);
    assert.match(html, /href="\.\.\/shared\/components\.css"/, `${page.base}.html 应引用 components.css`);
    assert.ok(!html.includes('theme.css'), `${page.base}.html 仍引用已删除的 theme.css`);
  }
});

test('设置页侧栏的 hash 与 JS 的分区表逐项对齐', () => {
  // 侧栏 href 与 PANELS 是两处独立的字符串，任一处改名都会让导航静默失灵
  const html = read('options', 'options.html');
  const js = read('options', 'options.js');

  const navHashes = [...html.matchAll(/class="navitem" href="#([^"]+)"/g)].map((m) => m[1]);
  const table = [...js.matchAll(/\{\s*hash:\s*'([^']+)',\s*panel:\s*'([^']+)'\s*\}/g)];

  assert.ok(navHashes.length >= 3, '侧栏至少该有三项');
  assert.deepEqual(navHashes, table.map((m) => m[1]),
    '侧栏 href 的名字与顺序必须和 options.js 的 PANELS 完全一致');

  const declared = new Set(declaredIds(html));
  for (const [, , panelId] of table) {
    assert.ok(declared.has(panelId), `PANELS 指向的 #${panelId} 在 HTML 里不存在`);
  }

  // hash 不能撞上任何真实 id，否则浏览器会自作主张滚动到那个元素
  for (const hash of navHashes) {
    assert.ok(!declared.has(hash),
      `hash "${hash}" 与元素 id 同名，浏览器会触发锚点滚动，把标题顶到 sticky 导航底下`);
  }
});
