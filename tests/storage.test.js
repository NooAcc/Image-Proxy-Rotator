import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, normalizeConfig, importConfig, exportConfig } from '../src/lib/storage.js';
import { CONFIG_KEY, CONFIG_VERSION } from '../src/lib/constants.js';

/** 极简 chrome.storage.StorageArea 桩 */
function fakeArea(initial = {}) {
  let data = { ...initial };
  return {
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: data[keys] };
      return { ...data };
    },
    async set(obj) { data = { ...data, ...obj }; },
    async remove(key) { delete data[key]; },
    _dump: () => data,
  };
}

test('空存储时 load() 返回默认配置', async () => {
  const store = createStore(fakeArea());
  const cfg = await store.load();
  assert.equal(cfg.version, CONFIG_VERSION);
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.nodes, []);
  assert.deepEqual(cfg.rules, []);
  assert.equal(cfg.settings.strategy, 'round-robin');
  assert.equal(cfg.settings.probe.timeoutMs, 5000);
});

test('save() 后 load() 能取回同一份配置', async () => {
  const area = fakeArea();
  const store = createStore(area);
  const cfg = await store.load();
  cfg.enabled = true;
  cfg.nodes.push({ id: 'n_1', name: 'a', protocol: 'http', host: 'h', port: 1 });
  await store.save(cfg);
  assert.ok(area._dump()[CONFIG_KEY], '必须写入 CONFIG_KEY');
  const again = await store.load();
  assert.equal(again.enabled, true);
  assert.equal(again.nodes.length, 1);
  assert.equal(again.nodes[0].health.status, 'unknown', '规范化时补齐 health');
});

test('normalizeConfig 修补缺失字段且不抛异常', () => {
  const cfg = normalizeConfig({ nodes: [{ host: 'x', port: '8080', protocol: 'HTTP' }] });
  assert.equal(cfg.nodes[0].port, 8080, 'port 转成数字');
  assert.equal(cfg.nodes[0].protocol, 'http', 'protocol 转小写');
  assert.match(cfg.nodes[0].id, /^n_[0-9a-f]{8}$/);
  assert.equal(cfg.nodes[0].enabled, true);
  assert.equal(cfg.nodes[0].autoDisabled, false);
  assert.equal(cfg.settings.logLimit, 200);
});

test('normalizeConfig 丢弃彻底非法的节点与规则', () => {
  const cfg = normalizeConfig({
    nodes: [null, 'x', { protocol: 'http', host: '', port: 1 }, { protocol: 'http', host: 'a', port: 70000 }],
    rules: [{ type: 'regex', pattern: '(' }, { type: 'exact', pattern: '' }],
  });
  assert.equal(cfg.nodes.length, 0);
  assert.equal(cfg.rules.length, 0, '非法正则与空 pattern 都要丢弃');
});

test('update() 是读-改-写', async () => {
  const store = createStore(fakeArea());
  await store.update((c) => { c.enabled = true; return c; });
  assert.equal((await store.load()).enabled, true);
});

test('export 再 import 得到等价配置（round-trip）', async () => {
  const store = createStore(fakeArea());
  const cfg = await store.load();
  cfg.enabled = true;
  cfg.rules.push({ id: 'r_1', name: 'r', type: 'regex', pattern: '\\.jpg$', enabled: true, nodeIds: [] });
  const text = exportConfig(cfg);
  assert.ok(text.includes('"version"'));
  const back = importConfig(text, normalizeConfig({}), { merge: false });
  assert.equal(back.rules.length, 1);
  assert.equal(back.rules[0].pattern, '\\.jpg$');
});

test('import merge=true 追加且按 host:port 去重', () => {
  const current = normalizeConfig({ nodes: [{ protocol: 'http', host: 'a', port: 1 }] });
  const incoming = JSON.stringify({
    version: 1,
    nodes: [{ protocol: 'http', host: 'a', port: 1 }, { protocol: 'http', host: 'b', port: 2 }],
  });
  const merged = importConfig(incoming, current, { merge: true });
  assert.equal(merged.nodes.length, 2, '重复的 a:1 不应重复加入');
});

test('import 非法 JSON 抛出可读错误', () => {
  assert.throws(() => importConfig('{oops', normalizeConfig({}), { merge: false }), /配置解析失败/);
});

test('未来版本号不崩溃，按当前版本尽力读取', () => {
  const cfg = normalizeConfig({ version: 99, enabled: true });
  assert.equal(cfg.version, CONFIG_VERSION);
  assert.equal(cfg.enabled, true);
});
