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

// ---------------------------------------------------------------- 重试与兜底设置

test('默认配置带上重试与兜底，且兜底默认不启用', () => {
  const s = normalizeConfig({}).settings;
  assert.deepEqual(s.retry, { maxAttempts: 3, delayMs: 300 });
  assert.deepEqual(s.fallbackImage, { enabled: false, template: '' });
});

test('重试次数与间隔被夹进合法区间', () => {
  const tooBig = normalizeConfig({ settings: { retry: { maxAttempts: 999, delayMs: 999999 } } }).settings.retry;
  assert.equal(tooBig.maxAttempts, 10, '上限存在是为了防止误配把一张裂图变成几十次重刷');
  assert.equal(tooBig.delayMs, 5000);

  const tooSmall = normalizeConfig({ settings: { retry: { maxAttempts: 0, delayMs: -1 } } }).settings.retry;
  assert.equal(tooSmall.maxAttempts, 1, 'maxAttempts=1 就是「不重试」，没有比这更小的合法值');
  assert.equal(tooSmall.delayMs, 0, '0 毫秒是合法的：用户可以选择不等');
});

test('重试设置缺失或是垃圾时回落到默认值', () => {
  for (const retry of [undefined, null, 'x', [], { maxAttempts: 'abc' }]) {
    const s = normalizeConfig({ settings: { retry } }).settings.retry;
    assert.equal(s.maxAttempts, 3, `${JSON.stringify(retry)}`);
  }
});

test('兜底模板合法时可以启用', () => {
  const fb = normalizeConfig({
    settings: { fallbackImage: { enabled: true, template: '  https://wsrv.nl/?url={url}  ' } },
  }).settings.fallbackImage;
  assert.equal(fb.enabled, true);
  assert.equal(fb.template, 'https://wsrv.nl/?url={url}', '两端空白要去掉，否则 new URL 会失败');
});

test('模板非法时强制关闭，但保留用户填的文本', () => {
  // 强制关闭是因为「开关开着、实际什么都不会发生」正是本项目反复吃过亏的那类静默失败；
  // 保留文本是为了不把用户填了一半的东西抹掉，设置页会就地说明它为什么没被启用
  for (const template of ['https://wsrv.nl/', 'ftp://x/{url}', '', 'not a url {url}']) {
    const fb = normalizeConfig({ settings: { fallbackImage: { enabled: true, template } } }).settings.fallbackImage;
    assert.equal(fb.enabled, false, `${template} 不该被启用`);
    assert.equal(fb.template, template.trim(), '用户填的文本不该被抹掉');
  }
});

test('兜底设置本身是垃圾时回落到默认值，不让整份配置失效', () => {
  for (const fallbackImage of [undefined, null, 'x', 42, []]) {
    const fb = normalizeConfig({ settings: { fallbackImage } }).settings.fallbackImage;
    assert.deepEqual(fb, { enabled: false, template: '' });
  }
});

test('重试与兜底设置能跟着配置导出再导入', () => {
  const cfg = normalizeConfig({
    settings: {
      retry: { maxAttempts: 5, delayMs: 0 },
      fallbackImage: { enabled: true, template: 'https://p.example/?u={raw}' },
    },
  });
  const back = importConfig(exportConfig(cfg), normalizeConfig({}), { merge: false });
  assert.deepEqual(back.settings.retry, { maxAttempts: 5, delayMs: 0 });
  assert.equal(back.settings.fallbackImage.enabled, true);
  assert.equal(back.settings.fallbackImage.template, 'https://p.example/?u={raw}');
});
