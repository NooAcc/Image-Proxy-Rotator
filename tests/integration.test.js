/**
 * 主路径集成测试。
 *
 * 覆盖 task-change.md 要求优先保证的链路：
 *   仅 HTTP/HTTPS 节点 → 规则 → 开启 → 匹配请求轮询分流
 *
 * 与单元测试的区别：这里从「用户粘贴的原始文本」出发，经过解析 → 建模 → 规范化 →
 * 持久化 → 生成 PAC → 在沙箱里真的执行 PAC，全链路串起来跑一遍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNodeList, decodeSubscription } from '../src/lib/node-parser.js';
import { createNode, dedupeNodes, isSelectable, unsupportedNodes } from '../src/lib/node-model.js';
import { createRule } from '../src/lib/rule-matcher.js';
import { createStore, exportConfig, importConfig } from '../src/lib/storage.js';
import { generatePac, pacSummary } from '../src/lib/pac-generator.js';
import { UNSUPPORTED_PROTOCOL_MESSAGE, PROBE_PARAM } from '../src/lib/constants.js';
import { loadPac } from './helpers/pac-sandbox.js';

function fakeArea(initial = {}) {
  let data = { ...initial };
  return {
    async get(keys) { return typeof keys === 'string' ? { [keys]: data[keys] } : { ...data }; },
    async set(obj) { data = { ...data, ...obj }; },
    async remove(key) { delete data[key]; },
  };
}

/** 模拟一次完整的「粘贴节点 → 加规则 → 开总开关」流程，返回落库后的配置 */
async function setup(pasted, rulePartial) {
  const store = createStore(fakeArea());
  const config = await store.load();

  const parsed = parseNodeList(decodeSubscription(pasted));
  const built = [];
  for (const item of parsed.nodes) {
    const node = createNode(item, built);
    if (node) built.push(node);
  }
  config.nodes = dedupeNodes(built);
  config.rules = [createRule(rulePartial)];
  config.enabled = true;

  const saved = await store.save(config);
  return { store, config: saved, parsed };
}

const MANGA = ['https://cdn.manga.com/ch1/001.jpg', 'cdn.manga.com'];

test('主路径：粘贴 HTTP/HTTPS 节点 → 加规则 → 开启 → 匹配请求在节点间轮询', async () => {
  const { config } = await setup(
    [
      'http://10.0.0.1:8080#线路一',
      'https://10.0.0.2:8443#线路二',
      'http://user:pass@10.0.0.3:3128#线路三',
      '10.0.0.4:3128',
    ].join('\n'),
    { name: '漫画图片', type: 'regex', pattern: '\\.(jpe?g|png|webp)(\\?.*)?$' },
  );

  assert.equal(config.nodes.length, 4, '四个节点全部入库');
  assert.equal(config.nodes.filter(isSelectable).length, 4, '四个节点全部可用');

  const pac = loadPac(generatePac(config, { startIndex: 0 }));

  // 连续 8 个图片请求应当把 4 个节点各用 2 次
  const used = new Map();
  for (let i = 0; i < 8; i++) {
    const decision = pac.find(`https://cdn.manga.com/ch1/${String(i).padStart(3, '0')}.jpg`, 'cdn.manga.com');
    const token = decision.split(';')[0].trim();
    used.set(token, (used.get(token) || 0) + 1);
  }
  assert.equal(used.size, 4, `应轮询到 4 个节点，实际：${[...used.keys()].join(' | ')}`);
  assert.ok([...used.values()].every((n) => n === 2), '每个节点各被用 2 次');

  // 关键字必须与协议对应
  assert.ok([...used.keys()].includes('PROXY 10.0.0.1:8080'));
  assert.ok([...used.keys()].includes('HTTPS 10.0.0.2:8443'));
});

test('主路径：不命中规则的请求保持直连', async () => {
  const { config } = await setup('http://10.0.0.1:8080', { type: 'regex', pattern: '\\.jpg$' });
  const pac = loadPac(generatePac(config, {}));
  assert.equal(pac.find('https://cdn.manga.com/app.js', 'cdn.manga.com'), 'DIRECT');
  assert.equal(pac.find('https://www.example.com/', 'www.example.com'), 'DIRECT');
});

test('混合粘贴：只接纳 HTTP/HTTPS，其余逐条给出不支持提示', async () => {
  const pasted = [
    'http://10.0.0.1:8080#好节点',
    'socks5://10.0.0.9:1080#SOCKS节点',
    'vless://11111111-2222-3333-4444-555555555555@v.example.com:443?security=tls#VLESS节点',
    'hysteria2://pw@h.example.com:8443#HY2节点',
    'trojan://pw@t.example.com:443#Trojan节点',
    'ss://aes-256-gcm:pw@s.example.com:8388#SS节点',
    'https://10.0.0.2:8443#另一个好节点',
    '完全无法识别的一行',
  ].join('\n');

  const { config, parsed } = await setup(pasted, { type: 'regex', pattern: '\\.jpg$' });

  assert.equal(parsed.nodes.length, 2, '只接纳 http 与 https');
  assert.equal(parsed.unsupported.length, 5, '五个不支持的节点被单独归类');
  assert.equal(parsed.errors.length, 1, '一行无法识别');
  for (const item of parsed.unsupported) {
    assert.ok(item.reason.includes(UNSUPPORTED_PROTOCOL_MESSAGE), `提示必须含规定文案：${item.reason}`);
  }

  // 落库的只有可用节点
  assert.equal(config.nodes.length, 2);
  assert.equal(unsupportedNodes(config.nodes).length, 0);

  // PAC 里绝不出现任何不支持的协议痕迹
  const source = generatePac(config, {});
  for (const trace of ['SOCKS', 'v.example.com', 'h.example.com', 't.example.com', 's.example.com']) {
    assert.ok(!source.includes(trace), `PAC 不应包含 ${trace}`);
  }
});

test('历史配置里的非 HTTP/HTTPS 节点不会静默参与分流', async () => {
  // 模拟旧版本存下来的配置：混着 socks5 与 vless
  const legacy = JSON.stringify({
    version: 1,
    enabled: true,
    nodes: [
      { protocol: 'http', host: '10.0.0.1', port: 8080, name: '好节点' },
      { protocol: 'socks5', host: '10.0.0.9', port: 1080, name: '旧 SOCKS' },
      { protocol: 'vless', host: 'v.example.com', port: 443, name: '旧 VLESS' },
    ],
    rules: [{ type: 'regex', pattern: '\\.jpg$', enabled: true, nodeIds: [] }],
  });

  const store = createStore(fakeArea());
  const config = await store.save(importConfig(legacy, await store.load(), { merge: false }));

  // 三个节点都还在列表里（便于提示与清理），但只有 http 那个可用
  assert.equal(config.nodes.length, 3, '历史节点保留在列表中以便提示');
  assert.deepEqual(config.nodes.filter(isSelectable).map((n) => n.protocol), ['http']);
  assert.equal(unsupportedNodes(config.nodes).length, 2);

  // 即使它们 enabled 为 true，也进不了 PAC
  assert.ok(config.nodes.every((n) => n.enabled), '前提：历史节点默认是启用状态');
  const summary = pacSummary(config);
  assert.equal(summary.nodeCount, 1);
  assert.equal(summary.skipped.nodes.length, 2);

  const pac = loadPac(generatePac(config, {}));
  for (let i = 0; i < 6; i++) {
    assert.equal(pac.find(...MANGA), 'PROXY 10.0.0.1:8080; DIRECT', '只能选中那个 http 节点');
  }
});

test('全部是不支持的节点时：不代理、不报错、正常直连', async () => {
  const { config } = await setup(
    'socks5://10.0.0.9:1080\nvless://uuid@v.example.com:443\nhysteria2://pw@h.example.com:443',
    { type: 'regex', pattern: '\\.jpg$' },
  );
  assert.equal(config.nodes.length, 0, '一个都不入库');
  const pac = loadPac(generatePac(config, {}));
  assert.equal(pac.find(...MANGA), 'DIRECT', '没有可用节点时必须直连，而不是断网');
});

test('测速请求被强制路由到指定节点，且不带直连兜底', async () => {
  const { config } = await setup('http://10.0.0.1:8080\nhttps://10.0.0.2:8443',
    { type: 'regex', pattern: '\\.jpg$' });
  const pac = loadPac(generatePac(config, {}));
  const target = config.nodes[1];
  const decision = pac.find(
    `https://cp.cloudflare.com/generate_204?${PROBE_PARAM}=${target.id}&_pp_t=1`,
    'cp.cloudflare.com',
  );
  assert.equal(decision, 'HTTPS 10.0.0.2:8443', '必须精确命中目标节点且无兜底');
});

test('测速失败导致自动禁用后，该节点从轮询中消失', async () => {
  const { store, config } = await setup('http://10.0.0.1:8080\nhttp://10.0.0.2:8080',
    { type: 'regex', pattern: '\\.jpg$' });

  // 模拟 health-monitor 对第二个节点判定失败并自动禁用
  const next = structuredClone(config);
  next.nodes[1].autoDisabled = true;
  next.nodes[1].health.status = 'fail';
  next.nodes[1].health.consecutiveFailures = 2;
  const saved = await store.save(next);

  const pac = loadPac(generatePac(saved, {}));
  for (let i = 0; i < 5; i++) {
    assert.ok(pac.find(...MANGA).includes('10.0.0.1'), '只剩第一个节点');
  }
  assert.equal(pacSummary(saved).nodeCount, 1);

  // 但它仍然可以被单独测速（否则永远无法恢复）
  assert.equal(
    pac.find(`https://probe/x?${PROBE_PARAM}=${saved.nodes[1].id}`, 'probe'),
    'PROXY 10.0.0.2:8080',
  );
});

test('配置导出再导入后，分流行为完全一致', async () => {
  const { config } = await setup(
    'http://10.0.0.1:8080#A\nhttps://10.0.0.2:8443#B\nhttp://u:p@10.0.0.3:3128#C',
    { name: '图片', type: 'regex', pattern: '\\.(jpe?g|webp)$' },
  );

  const restored = importConfig(exportConfig(config), config, { merge: false });

  const before = loadPac(generatePac(config, { startIndex: 0 }));
  const after = loadPac(generatePac(restored, { startIndex: 0 }));
  for (let i = 0; i < 6; i++) {
    assert.equal(after.find(...MANGA), before.find(...MANGA), `第 ${i + 1} 次决策应一致`);
  }
  // 凭据要保住，否则导入后代理认证会失败
  assert.equal(restored.nodes[2].username, 'u');
  assert.equal(restored.nodes[2].password, 'p');
});

test('总开关关闭时，无论配置多完整都全部直连', async () => {
  const { store, config } = await setup('http://10.0.0.1:8080', { type: 'regex', pattern: '.*' });
  const off = await store.save({ ...config, enabled: false });
  const pac = loadPac(generatePac(off, {}));
  assert.equal(pac.find(...MANGA), 'DIRECT');
  assert.equal(pac.find('https://anything.example/', 'anything.example'), 'DIRECT');
});

test('PAC 里不含任何代理账号密码', async () => {
  const { config } = await setup('http://alice:topsecret@10.0.0.1:8080',
    { type: 'regex', pattern: '\\.jpg$' });
  const source = generatePac(config, {});
  assert.ok(!source.includes('topsecret'), '密码绝不能出现在 PAC 里');
  assert.ok(!source.includes('alice'), '用户名绝不能出现在 PAC 里');
  // 但凭据要留在配置里供 onAuthRequired 使用
  assert.equal(config.nodes[0].password, 'topsecret');
});
