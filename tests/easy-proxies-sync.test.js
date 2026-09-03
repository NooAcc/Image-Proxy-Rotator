/**
 * Easy Proxies 自动拉取的后台编排测试。
 *
 * 覆盖认证、拉取、写存储、定时任务与消息入口。用 chrome.* 替身验证的是
 * 「真的把节点写进了 config、真的重新注入了 PAC、真的建了 alarm」，
 * 而不是「某个函数被调用了」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, nodeFixture } from './helpers/chrome-stub.js';

const stub = installChromeStub();

const { getConfig, setConfig, getLogger } = await import('../src/background/state.js');
const {
  runEasyProxiesSync,
  scheduleEasyProxiesAlarm,
  onEasyProxiesAlarm,
} = await import('../src/background/easy-proxies-sync.js');
const { handleMessage } = await import('../src/background/messaging.js');
const { normalizeConfig } = await import('../src/lib/schema.js');
const { ALARM_EASY_PROXIES } = await import('../src/lib/constants.js');

/** 伪造 fetch 响应 */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() { return body; },
  };
}

/** easy_proxies 节点快照夹具 */
function epNode(overrides = {}) {
  return {
    tag: 'hk-01',
    name: '香港01',
    port: 24001,
    available: true,
    blacklisted: false,
    last_latency_ms: 167,
    ...overrides,
  };
}

/** 写入一份带 Easy Proxies 设置的配置 */
async function seed(epOverrides = {}, partial = {}) {
  stub.reset();
  await setConfig(normalizeConfig({
    settings: {
      easyProxies: {
        enabled: true,
        baseUrl: 'http://10.0.0.3:19090',
        password: '',
        maxNodes: 15,
        intervalMinutes: 60,
        ...epOverrides,
      },
    },
    ...partial,
  }));
  (await getLogger()).clear();
  return getConfig();
}

// ---------------------------------------------------------------- 拉取与合并

test('runEasyProxiesSync 拉取最优节点并只替换自动节点，同时重新注入 PAC', async () => {
  await seed({}, {
    enabled: true,
    nodes: [
      nodeFixture('n_aaaaaa01', { host: '10.0.0.3', port: 3000 }),
      nodeFixture('n_aaaaaa02', { host: '10.0.0.3', port: 24001, meta: { easyProxies: true } }),
    ],
  });
  stub.setFetch(async (url) => {
    assert.equal(url, 'http://10.0.0.3:19090/api/nodes');
    return jsonResponse({
      nodes: [
        epNode({ tag: 'fast', name: '快', port: 24001, last_latency_ms: 100 }),
        epNode({ tag: 'down', name: '坏', port: 24002, available: false }),
        epNode({ tag: 'slow', name: '慢', port: 24003, last_latency_ms: 900 }),
      ],
    });
  });

  const result = await runEasyProxiesSync();
  const cfg = await getConfig();

  assert.equal(result.added, 2, '只有可用的 2 条进入节点列表');
  assert.equal(result.removed, 1, '旧自动节点被替换');
  assert.equal(cfg.nodes.length, 3, '手写 1 + 自动 2');
  assert.ok(cfg.nodes.some((n) => n.host === '10.0.0.3' && n.port === 3000), '手写节点必须保留');

  const auto = cfg.nodes.filter((n) => n.meta?.easyProxies === true);
  assert.deepEqual(auto.map((n) => n.port).sort((a, b) => a - b), [24001, 24003]);
  assert.ok(auto.every((n) => n.host === '10.0.0.3' && n.protocol === 'http'));
  assert.ok(auto.some((n) => n.name === '快'), '沿用 easy_proxies 里的节点名');

  assert.equal(cfg.settings.easyProxies.lastSyncCount, 2);
  assert.equal(cfg.settings.easyProxies.lastSyncError, null);
  assert.ok(Number.isFinite(cfg.settings.easyProxies.lastSyncAt));
  assert.notEqual(stub.lastPac(), null, '节点变化后必须重新注入 PAC');
});

test('可用节点不足 maxNodes 时按实际数量填入', async () => {
  await seed({ maxNodes: 15 });
  stub.setFetch(async () => jsonResponse({ nodes: [epNode({ tag: 'only' })] }));
  const result = await runEasyProxiesSync();
  assert.equal(result.added, 1);
});

test('开关关闭时手动同步仍然执行（立即拉取按钮不受自动开关限制）', async () => {
  await seed({ enabled: false });
  stub.setFetch(async () => jsonResponse({ nodes: [epNode({ tag: 'only' })] }));
  const result = await runEasyProxiesSync();
  assert.equal(result.added, 1);
});

test('空节点列表同步成功但不报错、不改动现有节点', async () => {
  await seed({}, { nodes: [nodeFixture('n_aaaaaa01')] });
  stub.setFetch(async () => jsonResponse({ nodes: [] }));
  const result = await runEasyProxiesSync();
  const cfg = await getConfig();
  assert.equal(result.added, 0);
  assert.equal(cfg.nodes.length, 1, '拉不到节点时不清空已有列表');
  assert.equal(cfg.nodes[0].id, 'n_aaaaaa01');
});

test('runEasyProxiesSync 配置本地标签服务时转换并写回标签节点', async () => {
  await seed({
    labelServiceUrl: 'http://127.0.0.1:19091',
    labelServiceToken: 'secret',
  }, {
    enabled: true,
    nodes: [
      nodeFixture('n_aaaaaa01', { host: '10.0.0.3', port: 3000 }),
      nodeFixture('n_aaaaaa02', { host: '10.0.0.3', port: 24001, meta: { easyProxies: true } }),
    ],
  });

  stub.setFetch(async (url, options = {}) => {
    if (url === 'http://10.0.0.3:19090/api/nodes') {
      return jsonResponse({
        nodes: [
          epNode({ tag: 'fast', name: '快', port: 24001, last_latency_ms: 100 }),
          epNode({ tag: 'slow', name: '慢', port: 24002, last_latency_ms: 900 }),
        ],
      });
    }
    assert.equal(url, 'http://127.0.0.1:19091/api/convert');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.upstreams, [
      { name: '快', host: '10.0.0.3', port: 24001 },
      { name: '慢', host: '10.0.0.3', port: 24002 },
    ]);
    return jsonResponse({
      ok: true,
      nodes: [
        { name: '快', host: '127.0.0.2', port: 8080, upstreamHost: '10.0.0.3', upstreamPort: 24001 },
        { name: '慢', host: '127.0.0.3', port: 8080, upstreamHost: '10.0.0.3', upstreamPort: 24002 },
      ],
    });
  });

  const result = await runEasyProxiesSync();
  const cfg = await getConfig();

  assert.equal(result.added, 2);
  assert.equal(result.removed, 1);
  const auto = cfg.nodes.filter((n) => n.meta?.easyProxies === true);
  assert.deepEqual(auto.map((n) => n.host), ['127.0.0.2', '127.0.0.3']);
  assert.deepEqual(auto.map((n) => n.meta.labelProxy.upstreamPort), [24001, 24002]);
  assert.ok(cfg.nodes.some((n) => n.id === 'n_aaaaaa01'), '手写节点必须保留');
  assert.equal(cfg.settings.easyProxies.lastSyncError, null);
  assert.notEqual(stub.lastPac(), null);
});

test('本地标签服务不可用时同步失败且不清空现有自动节点', async () => {
  await seed({
    labelServiceUrl: 'http://127.0.0.1:19091',
  }, {
    enabled: true,
    nodes: [
      nodeFixture('n_aaaaaa02', { host: '10.0.0.3', port: 24001, meta: { easyProxies: true } }),
    ],
  });

  stub.setFetch(async (url) => {
    if (url === 'http://10.0.0.3:19090/api/nodes') {
      return jsonResponse({ nodes: [epNode({ tag: 'only' })] });
    }
    return jsonResponse({ ok: false, error: '本地标签服务未启动' }, { ok: false, status: 503 });
  });

  await assert.rejects(() => runEasyProxiesSync(), /本地标签服务未启动/);
  const cfg = await getConfig();
  assert.equal(cfg.nodes.length, 1, '失败时不得清空现有节点');
  assert.equal(cfg.nodes[0].meta.easyProxies, true);
  assert.match(cfg.settings.easyProxies.lastSyncError, /本地标签服务未启动/);
});

// ---------------------------------------------------------------- 认证

test('配置了密码时先 POST /api/auth 再带 Bearer token 拉取', async () => {
  const calls = [];
  await seed({ password: 's3cret' });
  stub.setFetch(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth')) {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).password, 's3cret');
      return jsonResponse({ token: 'tok-123' });
    }
    assert.equal(url.endsWith('/api/nodes'), true);
    assert.equal(options.headers.Authorization, 'Bearer tok-123');
    return jsonResponse({ nodes: [] });
  });

  await runEasyProxiesSync();

  assert.deepEqual(
    calls.map((c) => c.url),
    ['http://10.0.0.3:19090/api/auth', 'http://10.0.0.3:19090/api/nodes'],
  );
});

test('登录失败时抛出可读错误并记录 lastSyncError', async () => {
  await seed({ password: 'wrong' });
  stub.setFetch(async (url) => {
    if (url.endsWith('/api/auth')) return jsonResponse({ error: '密码错误' }, { ok: false, status: 401 });
    return jsonResponse({ nodes: [] });
  });

  await assert.rejects(() => runEasyProxiesSync(), /密码错误/);
  const cfg = await getConfig();
  assert.match(cfg.settings.easyProxies.lastSyncError, /密码错误/);
});

test('拉取失败时抛出可读错误并记录 lastSyncError', async () => {
  await seed();
  stub.setFetch(async () => jsonResponse({ error: '服务不可用' }, { ok: false, status: 500 }));

  await assert.rejects(() => runEasyProxiesSync(), /服务不可用/);
  const cfg = await getConfig();
  assert.match(cfg.settings.easyProxies.lastSyncError, /服务不可用/);
});

// ---------------------------------------------------------------- 定时与消息

test('scheduleEasyProxiesAlarm 按开关与间隔重建/清除 alarm', async () => {
  await seed();
  await scheduleEasyProxiesAlarm();
  const alarm = stub.alarms.get(ALARM_EASY_PROXIES);
  assert.ok(alarm, '启用时应该创建定时任务');
  assert.equal(alarm.periodInMinutes, 60);

  await seed({ enabled: false });
  await scheduleEasyProxiesAlarm();
  assert.equal(stub.alarms.has(ALARM_EASY_PROXIES), false, '关闭后必须清除');

  await seed({ enabled: true, intervalMinutes: 0 });
  await scheduleEasyProxiesAlarm();
  assert.equal(stub.alarms.has(ALARM_EASY_PROXIES), false, '间隔 0 = 不做定时');
});

test('onEasyProxiesAlarm 关闭时什么都不做', async () => {
  await seed({ enabled: false });
  await onEasyProxiesAlarm();
  assert.equal(stub.fetchCalls.length, 0);
});

test('消息 easyProxiesSync 走通后台并带回新 config', async () => {
  await seed();
  stub.setFetch(async () => jsonResponse({ nodes: [epNode({ tag: 'only' })] }));
  const res = await handleMessage({ type: 'easyProxiesSync' });
  assert.equal(res.ok, true);
  assert.equal(res.config.settings.easyProxies.lastSyncCount, 1);
  assert.equal(res.config.nodes.length, 1);
});
