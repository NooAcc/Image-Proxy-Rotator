/**
 * 设计令牌的可访问性契约。
 *
 * 配色是 UI 里最容易「看起来还行、实际读不清」的部分：改一个十六进制值不会报错，
 * 但可能让弱视用户彻底读不到文字。所以对比度在这里当成**可执行的断言**来守，
 * 而不是靠设计阶段的口头承诺。
 *
 * 覆盖两件事：
 *   1. tokens.css 两套主题（深色为基准、亮色在 media query 里覆盖）的关键配色对
 *      都满足 WCAG 2.1：正文文字 ≥ 4.5:1，控件边框/焦点环等非文字元素 ≥ 3:1
 *   2. 页面 CSS 里 var() 引用的每个变量都真的有定义（改名漏改会静默失效）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'src', 'pages', 'shared');

// ---------------------------------------------------------------- CSS 解析

/** 从 `{` 开始取出配平大括号的那一段（含首尾） */
function braceBlock(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(openIndex, i + 1);
  }
  throw new Error('CSS 大括号不配平');
}

/** 取某个选择器后面紧跟的声明块 */
function ruleBody(source, selector) {
  const at = source.indexOf(selector);
  if (at < 0) throw new Error(`tokens.css 里找不到选择器 ${selector}`);
  return braceBlock(source, source.indexOf('{', at));
}

/** 解析出块内所有自定义属性 */
function customProps(block) {
  const out = new Map();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) out.set(m[1], m[2].trim());
  return out;
}

const tokensCss = readFileSync(join(SHARED, 'tokens.css'), 'utf8');

/** 深色是基准（:root），亮色只覆盖差异项 —— 与 tokens.css 的组织方式一致 */
const darkTokens = customProps(ruleBody(tokensCss, ':root'));
const lightTokens = new Map([
  ...darkTokens,
  ...customProps(ruleBody(tokensCss, '@media (prefers-color-scheme: light)')),
]);

// ---------------------------------------------------------------- WCAG 对比度

/** #rgb / #rrggbb → [r, g, b]，取值 0-255 */
function parseHex(hex) {
  const raw = hex.trim().replace(/^#/, '');
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
  assert.match(full, /^[0-9a-fA-F]{6}$/, `不是合法的十六进制颜色：${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** WCAG 相对亮度 */
function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 两色对比度，1:1 – 21:1 */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function ratio(tokens, fgName, bgName) {
  const fg = tokens.get(fgName);
  const bg = tokens.get(bgName);
  assert.ok(fg, `缺少令牌 ${fgName}`);
  assert.ok(bg, `缺少令牌 ${bgName}`);
  return contrast(fg, bg);
}

// ---------------------------------------------------------------- 断言

/** 承载正文的配色对，必须 ≥ 4.5:1（WCAG 1.4.3 AA） */
const TEXT_PAIRS = [
  ['--fg', '--bg'],
  ['--fg', '--surface'],
  ['--fg', '--surface-2'],
  ['--fg-muted', '--bg'],
  ['--fg-muted', '--surface'],
  ['--fg-muted', '--surface-2'],
  ['--accent', '--surface'],
  ['--ok', '--surface'],
  ['--warn', '--surface'],
  ['--err', '--surface'],
  ['--accent-fg', '--accent'],
];

/** 非文字但承载语义的元素，必须 ≥ 3:1（WCAG 1.4.11） */
const UI_PAIRS = [
  ['--border-strong', '--surface'],
  ['--border-strong', '--bg'],
  ['--ring', '--surface'],
];

for (const [themeName, tokens] of [['深色', darkTokens], ['亮色', lightTokens]]) {
  test(`${themeName}主题：正文配色对满足 4.5:1`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      const value = ratio(tokens, fg, bg);
      assert.ok(value >= 4.5, `${fg} on ${bg} 只有 ${value.toFixed(2)}:1，低于 4.5:1`);
    }
  });

  test(`${themeName}主题：控件边框与焦点环满足 3:1`, () => {
    for (const [fg, bg] of UI_PAIRS) {
      const value = ratio(tokens, fg, bg);
      assert.ok(value >= 3, `${fg} on ${bg} 只有 ${value.toFixed(2)}:1，低于 3:1`);
    }
  });

  // ok / warn / err 三态在色觉障碍下能否区分，不靠亮度差 —— 绿与红天然亮度接近，
  // 真正的兜底是每个状态各带独立字形与文字。那条契约在 ui-status.test.js 里守。
}

// ---------------------------------------------------------------- var() 完整性

test('页面 CSS 里 var() 引用的变量都有定义', () => {
  const cssFiles = [];
  for (const dir of ['shared', 'options', 'popup']) {
    const full = join(ROOT, 'src', 'pages', dir);
    for (const name of readdirSync(full)) {
      if (name.endsWith('.css')) cssFiles.push(join(full, name));
    }
  }
  assert.ok(cssFiles.length >= 3, '至少应有 tokens/options/popup 三份样式');

  const defined = new Set();
  const used = new Map();
  for (const file of cssFiles) {
    // 注释里出现 var(--x) 这类示意写法不算引用，先挖掉再扫
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of source.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    for (const m of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!used.has(m[1])) used.set(m[1], file);
    }
  }

  for (const [name, file] of used) {
    assert.ok(defined.has(name), `${file} 用了未定义的 ${name}`);
  }
});
