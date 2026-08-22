/**
 * 设置页的说明文本密度契约。
 *
 * 重做之前，「HTTPS 会把路径剥掉」这一件事同时写在三处：options.html 顶部的
 * `.hint` 段落、options.js 里 KPI 的 `hint`、以及 README —— 前两份无论用不用得上
 * 都常驻占位，而且改一处必漏两处。分工现在是：
 *
 *   诊断类（只在出问题时有意义）→ 条件 `.banner`，条件不成立就完全不渲染
 *   参考类（配置时查一次）      → `.card__help` 折叠区，默认收起
 *   心智模型（这张卡是干嘛的）  → 卡片顶部留一行 `.hint`
 *
 * 这里把这套分工钉成断言，让「往卡片顶部再贴一段话」变成一个必须明确做出的决定，
 * 而不是顺手就能加进来的东西。
 *
 * 注意第 3 条的比较范围：只比 HTML 的说明文本与 options.js 的 `hint` 值。条件
 * banner 不在其内 —— 诊断文案本来就该把话说全，它是那件事**唯一**的落点。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const html = readFileSync(join(ROOT, 'src', 'pages', 'options', 'options.html'), 'utf8');
const js = readFileSync(join(ROOT, 'src', 'pages', 'options', 'options.js'), 'utf8');

/** 常驻说明的长度上限。超过这个量级的文字属于「参考类」，该进折叠区 */
const HINT_MAX = 48;
/** KPI 提示的长度上限。它贴在数字下面，只够放一句短提示 */
const KPI_HINT_MAX = 40;
/** 判定重复所用的窗口。中文里连续 12 个字相同，基本不可能是巧合 */
const OVERLAP = 12;

/** 去标签、去空白 —— 源码里的换行是排版产物，不是文本的一部分 */
function plain(fragment) {
  return fragment.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
}

/** 卡片顶部的常驻说明段落（只取写死在 HTML 里的，动态填充的交给 JS） */
function residentHints() {
  return [...html.matchAll(/<p class="hint"[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => plain(m[1]))
    .filter(Boolean);
}

/** 折叠帮助区：整段 details 的原始片段 */
function helpBlocks() {
  return [...html.matchAll(/<details class="card__help">([\s\S]*?)<\/details>/g)].map((m) => m[1]);
}

/**
 * options.js 里 KPI 的 hint 值。
 *
 * 值可以是三元表达式、也可以跨行用 `+` 拼接，所以按行读到表达式结束，
 * 再把其中所有字符串字面量接起来 —— 拼接出来的段落同样要受长度约束。
 */
function kpiHints() {
  const values = [];
  const lines = js.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const start = /\bhint:\s*(.*)$/.exec(lines[i]);
    if (!start) continue;
    let expr = start[1];
    while (/\+$/.test(expr.trim()) && i + 1 < lines.length) {
      i += 1;
      expr += lines[i].trim();
    }
    const parts = [...expr.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    if (parts.length > 0) values.push(parts.join(''));
  }
  return values;
}

test('卡片顶部的常驻说明都是一句话的量级', () => {
  for (const text of residentHints()) {
    assert.ok(text.length <= HINT_MAX,
      `这段常驻说明有 ${text.length} 字，超过 ${HINT_MAX} —— 收进 .card__help：\n  ${text}`);
  }
});

test('KPI 的提示是短提示，不是段落', () => {
  for (const text of kpiHints()) {
    assert.ok(text.length <= KPI_HINT_MAX,
      `这条 KPI 提示有 ${text.length} 字，超过 ${KPI_HINT_MAX} —— 长解释属于 .card__help 或条件 banner：\n  ${text}`);
  }
});

test('折叠帮助区的 summary 有可读文字，不只是一个图标', () => {
  const blocks = helpBlocks();
  assert.ok(blocks.length > 0, '设置页应当有折叠帮助区');

  for (const block of blocks) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(block);
    assert.ok(summary, `.card__help 缺少 <summary>：\n  ${block.slice(0, 80)}`);
    // 图标标了 aria-hidden，读屏只念得到它之外的文字
    const readable = plain(summary[1].replace(/<span[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, ''));
    assert.ok(readable.length >= 2,
      `折叠标题只有图标，读屏念不出它是什么：\n  ${summary[1].trim()}`);
  }
});

test('同一段解释不在 HTML 与 JS 之间各写一遍', () => {
  const documented = [...residentHints(), ...helpBlocks().map(plain)].join('\n');

  for (const hint of kpiHints()) {
    for (let i = 0; i + OVERLAP <= hint.length; i += 1) {
      const window = hint.slice(i, i + OVERLAP);
      assert.ok(!documented.includes(window),
        `「${window}」在 HTML 的说明里已经写过了，KPI 提示不必复述：\n  ${hint}`);
    }
  }
});

test('删掉说明时 aria-describedby 一起删干净', () => {
  // 留着一个指向不存在元素的 describedby，读屏什么都念不出来，而且不报错
  const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) {
    for (const id of m[1].split(/\s+/)) {
      assert.ok(declared.has(id), `aria-describedby 指向 #${id}，但 HTML 里没有这个元素`);
    }
  }
});
