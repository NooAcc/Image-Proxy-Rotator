/**
 * 节点状态展示词典的契约。
 *
 * WCAG 1.4.1「不得只靠颜色传达信息」在这个界面上是硬要求：节点健康度是用户唯一
 * 能判断「为什么图片加载不出来」的线索，而绿与红的相对亮度天然接近，色觉障碍或
 * 灰度显示下仅凭色相分不开。真正的兜底是**每个状态各带独立字形与文字**。
 *
 * 这份测试守的就是那条兜底不被悄悄削掉：任何两个状态都不允许长得一模一样。
 * nodeStatus() 是纯函数（不碰 DOM），所以能在 Node 下直接跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NODE_STATUS, nodeStatus, statusLabel } from '../src/pages/shared/ui.js';

/** 造一个形状完整的节点，再按用例覆盖字段 */
function node(patch = {}) {
  return {
    id: 'n_test',
    name: '测试节点',
    protocol: 'http',
    host: '1.2.3.4',
    port: 8080,
    enabled: true,
    autoDisabled: false,
    health: { status: 'ok', latencyMs: 42, lastCheckedAt: 1 },
    ...patch,
  };
}

test('每个状态都同时给出字形、文字、色调', () => {
  const states = Object.entries(NODE_STATUS);
  assert.ok(states.length >= 5, '状态数量看起来不完整');

  for (const [key, preset] of states) {
    assert.ok(preset.glyph?.length > 0, `${key} 缺少字形`);
    assert.ok(preset.label?.length > 0, `${key} 缺少文字`);
    assert.ok(preset.tone?.length > 0, `${key} 缺少色调`);
  }
});

test('状态文字互不相同', () => {
  const labels = Object.values(NODE_STATUS).map((s) => s.label);
  assert.equal(new Set(labels).size, labels.length, `状态文字出现重复：${labels.join('、')}`);
});

test('任何两个状态的「字形 + 色调」组合都不重复', () => {
  // 光靠字形不同或光靠颜色不同都不够 —— 只要这两样合起来能区分，用户就分得清
  const combos = Object.entries(NODE_STATUS).map(([key, s]) => [`${s.glyph}|${s.tone}`, key]);
  const seen = new Map();
  for (const [combo, key] of combos) {
    assert.ok(!seen.has(combo), `${key} 与 ${seen.get(combo)} 的字形+色调完全相同，用户无法区分`);
    seen.set(combo, key);
  }
});

test('色调只取预期的几种', () => {
  for (const [key, preset] of Object.entries(NODE_STATUS)) {
    assert.ok(['ok', 'warn', 'err', 'muted'].includes(preset.tone), `${key} 的色调 ${preset.tone} 不在令牌范围内`);
  }
});

test('协议不受支持是最高优先级，压过启用状态与测速结果', () => {
  // 这类节点永远进不了轮询池，显示成「正常」会把用户引向错误的排查方向
  assert.equal(nodeStatus(node({ protocol: 'socks5' })), 'unsupported');
  assert.equal(nodeStatus(node({ protocol: 'vless', enabled: true, health: { status: 'ok' } })), 'unsupported');
});

test('手动禁用与自动禁用是两个状态，不能混为一谈', () => {
  // 「我自己关的」和「测速失败被系统关的」处理方式完全不同，必须分得开
  assert.equal(nodeStatus(node({ enabled: false })), 'manual-off');
  assert.equal(nodeStatus(node({ autoDisabled: true })), 'auto-off');
  assert.notEqual(NODE_STATUS['manual-off'].label, NODE_STATUS['auto-off'].label);
});

test('启用中的节点按测速结果落到 ok / slow / fail / unknown', () => {
  assert.equal(nodeStatus(node({ health: { status: 'ok' } })), 'ok');
  assert.equal(nodeStatus(node({ health: { status: 'slow' } })), 'slow');
  assert.equal(nodeStatus(node({ health: { status: 'fail' } })), 'fail');
  assert.equal(nodeStatus(node({ health: {} })), 'unknown');
  assert.equal(nodeStatus(node({ health: undefined })), 'unknown');
});

test('statusLabel 与 nodeStatus 始终一致', () => {
  for (const patch of [{}, { enabled: false }, { autoDisabled: true }, { protocol: 'trojan' }]) {
    const target = node(patch);
    assert.equal(statusLabel(target), NODE_STATUS[nodeStatus(target)].label);
  }
});
