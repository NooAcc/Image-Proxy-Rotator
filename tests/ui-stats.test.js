/**
 * 统计面板的口径契约。
 *
 * 这份测试的由来是一次真实测试留下的账（logs/，2026-08-23）：面板上有三个数字是错的，
 * 而它们**全都显示得理直气壮** —— 没有报错、没有空白，只是在说谎。
 *
 *   · 「真的走了代理 481」其实是 `total - blind`，一个连接层就失败的请求也算在里面
 *   · 「无法归因 481」把 13 次没有对端 IP 的失败也算成了归因失败
 *   · 「未重试 0」读起来像「每次失败都重试了」，实际是 6 次失败连门都没进
 *
 * 所以这里守两件事：
 *   1. **计数器一旦存在，面板上必须有它的落点。** 悄悄不渲染一个桶，就等于把那部分
 *      现实从用户眼前藏起来 —— 那正是上面三条的成因。
 *   2. **标签不许比数据更自信。** 已经被证伪的说法（「真的走了代理」）不得再出现。
 *
 * 做法是静态读源码而不是渲染 DOM：本项目零依赖、不引 jsdom，而这两件事都是
 * 「源码里有没有提到它」级别的问题，不需要一个完整的浏览器来回答。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyMetrics, summarizeMetrics } from '../src/lib/metrics.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const optionsJs = readFileSync(join(ROOT, 'src', 'pages', 'options', 'options.js'), 'utf8');
const popupJs = readFileSync(join(ROOT, 'src', 'pages', 'popup', 'popup.js'), 'utf8');
const optionsHtml = readFileSync(join(ROOT, 'src', 'pages', 'options', 'options.html'), 'utf8');

/** 视图模型真的长什么样 —— 逐字段核对，而不是照着记忆列一份清单 */
const view = summarizeMetrics(emptyMetrics(), { nodes: [], rules: [] });

test('请求统计的每个口径在设置页都有落点', () => {
  for (const key of Object.keys(view.requests)) {
    assert.ok(optionsJs.includes(key),
      `metrics.requests.${key} 没有被设置页读取 —— 一个只存不显的计数器等于不存在`);
  }
});

test('重试的每个口径在设置页都有落点', () => {
  for (const key of Object.keys(view.retry)) {
    assert.ok(optionsJs.includes(key),
      `metrics.retry.${key} 没有被设置页读取。abandoned / unseen 正是上一版「四个格子加起来`
      + `比 attempted 少 1」的原因，藏起来就等于那 1 次无处可查`);
  }
});

test('「真的走了代理」这个说法不再出现在标签上', () => {
  // routed 是 total - blind：连接层就失败的请求同样计入，它证明不了「真的走通了」。
  // 唯一的硬证据是 viaNodeIp（响应从你的节点地址回来的）。
  //
  // 只看 label / kvRow 的字面量，不看注释 —— 记录这次改动的注释里当然会引用旧说法，
  // 那是应该留着的历史，不是要禁的文案
  const labels = (source) => [
    ...[...source.matchAll(/\blabel:\s*'([^']*)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/kvRow\('([^']*)'/g)].map((m) => m[1]),
  ];

  for (const [name, source] of [['设置页', optionsJs], ['弹窗', popupJs]]) {
    for (const label of labels(source)) {
      assert.ok(!/真的走(了)?代理/.test(label),
        `${name}的「${label}」是 routed 的标签 —— 那是它做不到的承诺`);
    }
  }
});

test('延迟不再只报一个平均值', () => {
  // 真实数据：首次请求 p50 是 1.2s、p90 是 15.8s。一个 3.6s 的平均值把
  // 「每十张就有一张要等十几秒」这件事完全抹平了
  assert.ok(optionsJs.includes('latencyP90'),
    '设置页必须给出 p90 —— 平均值对长尾没有抵抗力');
});

test('缓存命中在面板上有自己的位置', () => {
  assert.ok(optionsJs.includes('cached'), '不单列的话，翻回去重看一遍漫画就能让「走了代理」翻倍');
});

test('节点分布表在无法区分节点时能整体收起', () => {
  assert.ok(optionsJs.includes('allShared'),
    '19 行 0/0/0/—/0% 是噪音；共用地址时该收成一句话');
  assert.ok(!/function sharedHostGroups/.test(optionsJs),
    '共用地址的判断已经收进 lib/metrics.js，页面里不该再留第二份实现');
});

test('测速延迟标明是握手时长，不会被当成拉图的耗时', () => {
  // 面板说「可用节点平均延迟 503ms」，而真实拉图 p90 是 15.8s ——
  // 前者量的是到 generate_204 的握手，两者不是一回事
  const label = /kvRow\('([^']*延迟[^']*)'/.exec(optionsJs)?.[1] ?? '';
  assert.ok(/探测|握手/.test(label),
    `「${label}」会被读成拉图耗时。它量的是探测握手，标签里必须说出来`);
});

test('说明文字提到了缓存与分位数这两件新口径', () => {
  const help = optionsHtml.replace(/\s+/g, '');
  assert.ok(help.includes('缓存'), '「为什么总量比我看的图少」需要一句解释');
  assert.ok(/p90|分位/.test(help), '「p90 是什么」需要一句解释');
});
