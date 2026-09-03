/**
 * 后台编排层测试（Task 9–11）。
 *
 * 这一层原先只有静态校验，行为全靠人工点浏览器 —— 而「测速失败 → 自动禁用 →
 * 重新注入 PAC」恰恰是最容易出错、又最难人工复现的链路。这里用 chrome.* 替身把它
 * 搬进 Node：断言的不是「函数被调用了」，而是**真的注入了什么 PAC、注入后怎么路由**
 * （用 node:vm 执行注入的脚本）。
 *
 * 注意导入方式：state.js 在模块顶层就会读 chrome.storage.local，
 * 所以必须先装替身再动态导入，不能用顶层 import 语句。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub, nodeFixture } from './helpers/chrome-stub.js';
import { loadPac, browserUrl } from './helpers/pac-sandbox.js';


const stub = installChromeStub();

const { getConfig, setConfig, getRuntime, getLogger } = await import('../src/background/state.js');
const { applyProxy } = await import('../src/background/proxy-controller.js');
const { probeNode, probeAll, scheduleProbeAlarm, onAlarm } = await import('../src/background/health-monitor.js');
const { handleMessage } = await import('../src/background/messaging.js');
const { installRequestLogger } = await import('../src/background/request-logger.js');
const { installAuthProvider } = await import('../src/background/auth-provider.js');
const { resetMetrics, flushMetrics, getMetrics } = await import('../src/background/metrics-store.js');
const { normalizeConfig } = await import('../src/lib/schema.js');
const { METRICS_KEY } = await import('../src/lib/metrics.js');
const { UNSUPPORTED_PROTOCOL_MESSAGE, PROBE_PARAM, ALARM_PROBE } = await import('../src/lib/constants.js');

assert.equal(installRequestLogger(), true, 'webRequest 监听器应注册成功');
assert.equal(installAuthProvider(), true, 'onAuthRequired 监听器应注册成功');

// ---------------------------------------------------------------- 夹具

/** webRequest 看到的完整 URL —— 它拿得到路径 */
const IMG_URL = 'https://cdn.manga.com/ch1/001.jpg';
/** PAC 看到的东西 —— https 的路径与查询串已被浏览器剥掉，两者刻意不同 */
const IMG = browserUrl(IMG_URL);
/**
 * 夹具规则用「域名」型。
 *
 * 之前这里是 `regex \.jpg$`，配上直接喂完整 URL 的断言，整套后台测试都是绿的 ——
 * 而那条规则在真实浏览器里对 HTTPS 图片永远命中不了。判定必须建立在浏览器真正
 * 递给 PAC 的东西上；依赖路径的规则另有专门用例覆盖（见「规则命中但实际直连」）。
 */
const RULE = { id: 'r_aaaaaaa1', name: '图片', type: 'host', pattern: 'manga.com', enabled: true, nodeIds: [] };
/** 依赖路径的规则：HTTPS 下 PAC 判定不了，必然直连 */
const BLIND_RULE = { id: 'r_bbbbbbb2', name: '扩展名', type: 'regex', pattern: '\\.jpg$', enabled: true, nodeIds: [] };


/** 重置存储、运行时态、统计与日志，并写入一份新配置 */
async function seed(partial = {}) {
  stub.reset();
  Object.assign(getRuntime(), {
    startIndex: 0, control: null, summary: null, lastApplyAt: null, lastApplyError: null,
    probing: false, priorProxyMode: null,
  });
  await setConfig(normalizeConfig({ enabled: true, rules: [RULE], ...partial }));
  // 统计缓存活在模块作用域里，stub.reset() 清不掉它 —— 必须显式清零，
  // 否则上一个用例的计数会漏到下一个用例
  await resetMetrics();
  (await getLogger()).clear();
  return getConfig();
}

const logsOf = async (filter = {}) => (await getLogger()).list(filter);
const textOf = (rows) => rows.map((r) => r.message).join('\n');
const decide = (pac) => loadPac(pac).find(...IMG);

// ---------------------------------------------------------------- PAC 注入

test('applyProxy 以 pac_script 模式注入，且 mandatory 为 false', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')] });
  const result = await applyProxy();

  assert.equal(result.applied, true);
  assert.equal(result.summary.nodeCount, 2);
  const set = stub.lastSet();
  assert.equal(set.value.mode, 'pac_script');
  assert.equal(set.value.pacScript.mandatory, false, 'PAC 出错时必须直连，而不是把浏览器搞成断网');
  assert.equal(set.scope, 'regular');
  // 注入的脚本必须真的能把图片请求路由出去
  assert.match(decide(stub.lastPac()), /^PROXY aaaaaaa1\.px:8080/);
});

test('总开关关闭时撤销代理设置，一个字节的 PAC 都不注入', async () => {
  await seed({ enabled: false, nodes: [nodeFixture('n_aaaaaaa1')] });
  const result = await applyProxy();

  assert.equal(result.applied, false);
  assert.equal(stub.lastPac(), null);
  assert.ok(stub.proxyCalls.some((c) => c.type === 'clear'));
  assert.match(textOf(await logsOf({ kind: 'proxy' })), /总开关已关闭/);
});

test('有节点但全部不可用时恢复直连，并给出 warn 级提示', async () => {
  await seed({
    nodes: [
      nodeFixture('n_aaaaaaa1', { enabled: false }),
      nodeFixture('n_aaaaaaa9', { protocol: 'socks5', port: 1080 }),
    ],
  });
  const result = await applyProxy();

  assert.equal(result.applied, false);
  assert.equal(result.summary.nodeCount, 0, '不支持的协议不得计入可用节点');
  const row = (await logsOf({ kind: 'proxy' }))[0];
  assert.equal(row.level, 'warn');
  assert.match(row.message, /没有可用节点/);
});

test('注入失败时不假装成功，写 error 日志并如实返回', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  stub.setSettingsError('被企业策略禁止');
  const result = await applyProxy();

  assert.equal(result.applied, false);
  assert.match(textOf(await logsOf({ level: 'error' })), /注入代理设置失败/);
});

test('代理设置控制权不在本扩展时降级为 warn，而不是静默', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  stub.setControl('controlled_by_other_extensions');
  const result = await applyProxy();

  assert.equal(result.applied, true, '仍然下发，只是可能不生效');
  assert.equal(result.control.controlled, false);
  const row = (await logsOf({ kind: 'proxy' }))[0];
  assert.equal(row.level, 'warn');
  assert.match(row.message, /控制权/);
});

test('每次注入让轮询起点前进一格（SW 重启后不总是从 0 号节点开始）', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')] });
  await applyProxy();
  const first = decide(stub.lastPac());
  await applyProxy();
  const second = decide(stub.lastPac());

  assert.notEqual(first, second);
  assert.equal(getRuntime().startIndex, 2);
});

// ---------------------------------------------------------------- 测速与自动禁用

test('不支持的协议直接拒绝测速，且不浪费一次请求', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa9', { protocol: 'socks5', port: 1080 })] });
  const result = await probeNode('n_aaaaaaa9');

  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.ok(result.error.includes(UNSUPPORTED_PROTOCOL_MESSAGE), `提示必须含规定文案：${result.error}`);
  assert.equal(stub.fetchCalls.length, 0);
});

test('测速请求带上节点标记，成功后落库延迟与状态', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  const result = await probeNode('n_aaaaaaa1');

  assert.equal(result.ok, true);
  assert.ok(Number.isFinite(result.latencyMs));
  assert.equal(stub.fetchCalls.length, 1);
  assert.ok(stub.fetchCalls[0].includes(`${PROBE_PARAM}=n_aaaaaaa1`), '否则 PAC 无法强制路由到该节点');

  const node = (await getConfig()).nodes[0];
  assert.equal(node.health.status, 'ok');
  assert.equal(node.health.consecutiveFailures, 0);
  assert.ok(Number.isFinite(node.health.latencyMs));
});

test('连续失败达到阈值后自动禁用，且重新注入的 PAC 里不再选中它', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')] });
  stub.setFetch(async (url) => {
    if (String(url).includes('n_aaaaaaa2')) throw new Error('Failed to fetch');
    return { ok: true, status: 204 };
  });

  await probeNode('n_aaaaaaa2');
  assert.equal((await getConfig()).nodes[1].autoDisabled, false, '第一次失败还不该禁用（阈值为 2）');

  const second = await probeNode('n_aaaaaaa2');
  assert.match(second.error, /连接失败/);

  const node = (await getConfig()).nodes[1];
  assert.equal(node.autoDisabled, true);
  assert.equal(node.health.consecutiveFailures, 2);
  assert.match(textOf(await logsOf({ level: 'error' })), /已自动禁用/);

  // 关键：池变了就必须重新注入，否则被禁用的节点还在轮询里
  const pac = loadPac(stub.lastPac());
  for (let i = 0; i < 4; i++) {
    assert.ok(!pac.find(...IMG).includes('aaaaaaa2.px'), '被自动禁用的节点不得再被选中');
  }
});

test('超时被识别为超时，而不是笼统的连接失败', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')], settings: { probe: { timeoutMs: 500 } } });
  stub.setFetch((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }));

  const result = await probeNode('n_aaaaaaa1');
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.equal((await getConfig()).nodes[0].health.status, 'fail');
});

test('被自动禁用的节点测速成功后自动恢复并重新加入轮询', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1', {
      autoDisabled: true,
      health: { status: 'fail', consecutiveFailures: 3, lastError: '连接失败' },
    })],
  });

  const result = await probeNode('n_aaaaaaa1');
  assert.equal(result.ok, true);

  const node = (await getConfig()).nodes[0];
  assert.equal(node.autoDisabled, false);
  assert.equal(node.health.consecutiveFailures, 0);
  assert.equal(node.health.lastError, null);
  assert.match(textOf(await logsOf({ kind: 'probe' })), /已恢复可用/);
  assert.match(decide(stub.lastPac()), /^PROXY aaaaaaa1\.px:8080/);
});

test('probeAll 只测支持的协议', async () => {
  await seed({
    nodes: [
      nodeFixture('n_aaaaaaa1'),
      nodeFixture('n_aaaaaaa9', { protocol: 'vless', port: 443 }),
      nodeFixture('n_aaaaaaa3', { protocol: 'https', port: 8443 }),
    ],
  });
  const results = await probeAll();

  assert.equal(results.length, 2);
  assert.equal(stub.fetchCalls.length, 2, '不支持的节点连请求都不该发');
  assert.ok(!stub.fetchCalls.join('|').includes('n_aaaaaaa9'));
});

test('全部节点都不支持时 probeAll 不报错，并说清原因', async () => {
  await seed({
    nodes: [
      nodeFixture('n_aaaaaaa9', { protocol: 'socks5', port: 1080 }),
      nodeFixture('n_aaaaaaa8', { protocol: 'vless', port: 443 }),
    ],
  });
  const results = await probeAll();

  assert.deepEqual(results, []);
  assert.ok(textOf(await logsOf({ kind: 'probe' })).includes(UNSUPPORTED_PROTOCOL_MESSAGE));
});

test('定时任务按开关与间隔重建，周期不足 1 分钟时提升到 1', async () => {
  await seed({ enabled: false, nodes: [nodeFixture('n_aaaaaaa1')] });
  assert.equal(await scheduleProbeAlarm(), false);
  assert.equal(stub.alarms.size, 0, '总开关关闭时不该有定时测速');

  await seed({ nodes: [nodeFixture('n_aaaaaaa1')], settings: { probe: { intervalMinutes: 0 } } });
  assert.equal(await scheduleProbeAlarm(), false, '间隔 0 = 关闭定时测速');

  await seed({ nodes: [nodeFixture('n_aaaaaaa1')], settings: { probe: { intervalMinutes: 15 } } });
  assert.equal(await scheduleProbeAlarm(), true);
  assert.equal(stub.alarms.get(ALARM_PROBE).periodInMinutes, 15);
});

test('定时触发：关闭时什么都不做，开启时写起止日志', async () => {
  await seed({ enabled: false, nodes: [nodeFixture('n_aaaaaaa1')] });
  await onAlarm();
  assert.equal(stub.fetchCalls.length, 0);

  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await onAlarm();
  assert.equal(stub.fetchCalls.length, 1);
  const text = textOf(await logsOf({ kind: 'probe' }));
  assert.match(text, /开始定时全量延迟测试/);
  assert.match(text, /定时测试完成：1\/1/);
});

// ---------------------------------------------------------------- 消息契约

test('addNodes 混合粘贴：只收 HTTP/HTTPS，其余逐条报出不支持', async () => {
  await seed();
  const result = await handleMessage({
    type: 'addNodes',
    text: [
      'http://1.2.3.4:8080#好节点',
      'https://5.6.7.8:8443#另一个好节点',
      'socks5://user:pass@9.9.9.9:1080#SOCKS节点',
      'vless://11111111-2222-3333-4444-555555555555@v.example.com:443?security=tls#VLESS节点',
      'hysteria2://pw@h.example.com:8443#HY2节点',
      '这是垃圾行',
    ].join('\n'),
    merge: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.equal(result.unsupported.length, 3);
  assert.equal(result.errors.length, 1);
  assert.equal(result.config.nodes.length, 2);

  const warned = textOf(await logsOf({ level: 'warn' }));
  for (const label of ['SOCKS5', 'VLESS', 'Hysteria2']) {
    assert.ok(warned.includes(label), `日志应点名 ${label}：${warned}`);
  }
  assert.ok(warned.includes(UNSUPPORTED_PROTOCOL_MESSAGE));
});

test('addNodes 全是不支持的类型时明确失败，不静默丢弃', async () => {
  await seed();
  const result = await handleMessage({
    type: 'addNodes',
    text: 'socks5://1.1.1.1:1080\nvless://11111111-2222-3333-4444-555555555555@v.example.com:443',
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.includes(UNSUPPORTED_PROTOCOL_MESSAGE));
  assert.equal(result.config.nodes.length, 0);
});

test('deleteUnsupportedNodes 一键清除，并顺手清掉规则里的死引用', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa9', { protocol: 'socks5', port: 1080 })],
    rules: [{ ...RULE, nodeIds: ['n_aaaaaaa1', 'n_aaaaaaa9'] }],
  });
  const result = await handleMessage({ type: 'deleteUnsupportedNodes' });

  assert.equal(result.removed, 1);
  assert.deepEqual(result.config.nodes.map((n) => n.id), ['n_aaaaaaa1']);
  assert.deepEqual(result.config.rules[0].nodeIds, ['n_aaaaaaa1']);
});

test('getState 的「可用」与 PAC 池同一判定，不支持的节点不算可用', async () => {
  await seed({
    nodes: [
      nodeFixture('n_aaaaaaa1'),
      nodeFixture('n_aaaaaaa9', { protocol: 'socks5', port: 1080 }),
      nodeFixture('n_aaaaaaa3', { enabled: false }),
    ],
  });
  const result = await handleMessage({ type: 'getState' });

  assert.equal(result.stats.total, 3);
  assert.equal(result.stats.available, 1);
  assert.equal(result.stats.unsupported, 1);
  assert.equal(result.stats.manualDisabled, 1);
  assert.deepEqual(result.unsupportedIds, ['n_aaaaaaa9']);
  assert.ok(result.warnings.n_aaaaaaa9.some((w) => w.includes(UNSUPPORTED_PROTOCOL_MESSAGE)));
});

test('setEnabled 同时重建 PAC 与定时任务', async () => {
  await seed({ enabled: false, nodes: [nodeFixture('n_aaaaaaa1')] });

  const on = await handleMessage({ type: 'setEnabled', enabled: true });
  assert.equal(on.config.enabled, true);
  assert.equal(stub.lastSet().value.mode, 'pac_script');
  assert.equal(stub.alarms.size, 1);

  const off = await handleMessage({ type: 'setEnabled', enabled: false });
  assert.equal(off.config.enabled, false);
  assert.equal(stub.alarms.size, 0);
  assert.ok(stub.proxyCalls.some((c) => c.type === 'clear'));
});

test('未知消息类型与 handler 异常都变成可读的 ok:false，绝不静默', async () => {
  await seed();
  const unknown = await handleMessage({ type: '并不存在的类型' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知的消息类型/);

  const broken = await handleMessage({ type: 'importConfig', text: '{被截断的' });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /配置解析失败/);
  assert.match(textOf(await logsOf({ level: 'error' })), /处理「importConfig」时出错/);
  assert.equal((await getConfig()).nodes.length, 0, '导入失败不得破坏原配置');
});

test('resetNodeState 解除自动禁用并立刻重新注入', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1', {
      autoDisabled: true,
      health: { status: 'fail', consecutiveFailures: 5, lastError: '超时' },
    })],
  });
  const result = await handleMessage({ type: 'resetNodeState', id: 'n_aaaaaaa1' });

  const node = result.config.nodes[0];
  assert.equal(node.autoDisabled, false);
  assert.equal(node.health.consecutiveFailures, 0);
  assert.equal(node.health.lastError, null);
  assert.match(decide(stub.lastPac()), /^PROXY aaaaaaa1\.px:8080/);
});

test('getPacPreview 返回的脚本可直接执行', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  const result = await handleMessage({ type: 'getPacPreview' });

  assert.equal(result.ok, true);
  assert.equal(result.summary.nodeCount, 1);
  assert.match(decide(result.pac), /^PROXY /);
});

// ---------------------------------------------------------------- 认证与观测

test('代理认证自动应答，凭据错误时不无限重试', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1', { username: 'alice', password: 'topsecret' })] });
  const entry = stub.listeners.onAuthRequired[0];
  assert.deepEqual(entry.args, [{ urls: ['<all_urls>'] }, ['asyncBlocking']], '必须是 asyncBlocking');

  const ask = (details) => new Promise((resolve) => entry.fn(details, resolve));
  const challenger = { host: 'aaaaaaa1.px', port: 8080 };

  const first = await ask({ isProxy: true, requestId: 'auth-1', challenger });
  assert.deepEqual(first.authCredentials, { username: 'alice', password: 'topsecret' });
  assert.match(textOf(await logsOf({ kind: 'proxy' })), /自动提供代理凭据/);

  const again = await ask({ isProxy: true, requestId: 'auth-1', challenger });
  assert.deepEqual(again, {}, '同一请求二次挑战说明凭据不对，应交还浏览器');

  const siteAuth = await ask({ isProxy: false, requestId: 'auth-2', challenger });
  assert.deepEqual(siteAuth, {}, '站点自身的 401 不该被代理凭据污染');
});

test('地址匹配但协议不支持时，说清是类型问题而不是密码问题', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa9', { protocol: 'socks5', port: 1080, username: 'u', password: 'p' })],
  });
  const entry = stub.listeners.onAuthRequired[0];
  const got = await new Promise((resolve) => entry.fn({
    isProxy: true,
    requestId: 'auth-socks',
    challenger: { host: 'aaaaaaa9.px', port: 1080 },
  }, resolve));

  assert.deepEqual(got, {});
  assert.match(textOf(await logsOf({ kind: 'proxy' })), /SOCKS5 类型/);
});

test('请求观测只记日志，绝不因线上失败禁用节点（决策 D8）', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });

  await stub.emit('onBeforeRequest', { requestId: 'req-1', url: IMG_URL });
  await stub.emit('onCompleted', { requestId: 'req-1', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });

  let rows = await logsOf({ kind: 'request' });
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /203\.0\.113\.7/, '出口 IP 是分流生效的硬证据，必须记下来');

  await stub.emit('onErrorOccurred', {
    requestId: 'req-2', url: 'https://cdn.manga.com/ch1/002.jpg', error: 'net::ERR_FAILED',
  });
  rows = await logsOf({ kind: 'request' });
  assert.equal(rows.length, 2);

  const node = (await getConfig()).nodes[0];
  assert.equal(node.autoDisabled, false, '图片 404 / 站点 5xx / 断网都会走到这里，不能据此禁用节点');
  assert.equal(node.health.consecutiveFailures, 0);
});

test('不命中规则的请求不记日志；测速请求只补出口 IP', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });

  await stub.emit('onCompleted', {
    requestId: 'req-3', url: 'https://cdn.unrelated.com/app.js', statusCode: 200, ip: '1.1.1.1',
  });
  assert.equal((await logsOf({ kind: 'request' })).length, 0);

  await stub.emit('onCompleted', {
    requestId: 'req-4',
    url: `https://probe.test/204?${PROBE_PARAM}=n_aaaaaaa1`,
    statusCode: 204,
    ip: '198.51.100.9',
  });
  assert.equal((await logsOf({ kind: 'request' })).length, 0, '测速日志由 health-monitor 记，这里不重复');
  assert.equal((await getConfig()).nodes[0].health.egressIp, '198.51.100.9');
});

// ---------------------------------------------------------------- 统计计数器

test('走了代理的请求进入统计：总量、成功率、耗时、按规则命中', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await applyProxy();

  await stub.emit('onBeforeRequest', { requestId: 'm-1', url: IMG_URL });
  await stub.emit('onCompleted', { requestId: 'm-1', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });
  await stub.emit('onBeforeRequest', { requestId: 'm-2', url: IMG_URL });
  await stub.emit('onCompleted', { requestId: 'm-2', url: IMG_URL, statusCode: 503, ip: '203.0.113.7' });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.total, 2);
  assert.equal(metrics.requests.ok, 1);
  assert.equal(metrics.requests.fail, 1);
  assert.equal(metrics.requests.successRate, 50);
  assert.equal(metrics.rules.rows.find((r) => r.id === RULE.id).hits, 2);
  assert.ok(Number.isFinite(metrics.requests.avgLatencyMs), '应当算出平均耗时');
});

test('不命中规则的请求不进统计', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onCompleted', {
    requestId: 'm-3', url: 'https://cdn.unrelated.com/app.js', statusCode: 200, ip: '1.1.1.1',
  });
  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.total, 0, '直连的请求不属于「分流统计」');
});

test('连接层失败也计入总量，成功率不虚高', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onErrorOccurred', { requestId: 'm-4', url: IMG_URL, error: 'net::ERR_FAILED' });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.total, 1);
  assert.equal(metrics.requests.fail, 1);
  assert.equal(metrics.requests.successRate, 0);
  assert.equal(metrics.requests.unattributed, 0,
    '连接都没建起来就没有对端 IP —— 那不叫归因失败，叫压根没得归因');
});

test('主动取消（ERR_ABORTED）单列，不把成功率拉低', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onCompleted', { requestId: 'm-ok', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });
  await stub.emit('onErrorOccurred', { requestId: 'm-abort', url: IMG_URL, error: 'net::ERR_ABORTED' });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.total, 2);
  assert.equal(metrics.requests.ok, 1);
  assert.equal(metrics.requests.fail, 0, '页面/用户取消不是代理失败');
  assert.equal(metrics.requests.aborted, 1);
  assert.equal(metrics.requests.successRate, 100);
  const text = textOf(await logsOf({ kind: 'request' }));
  assert.match(text, /中止/, '活动日志不该把用户取消说成代理“请求失败”');
});

test('被其他扩展/策略拦截也单列为取消，不计入代理失败；只是不重试', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onErrorOccurred', {
    requestId: 'm-blocked', url: IMG_URL, error: 'net::ERR_BLOCKED_BY_CLIENT',
  });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.fail, 0, '拦截不是代理失败');
  assert.equal(metrics.requests.aborted, 1);
  const text = textOf(await logsOf({ kind: 'request' }));
  assert.match(text, /中止/, '活动日志不该把拦截说成代理“请求失败”');
});

test('关闭总开关不把 clear 当成一次注入时间', async () => {
  const cfg = await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await applyProxy();
  // 用固定值而不是 Date.now() 比较：同一毫秒内跑完会让“被刷新”和“没被刷新”
  // 恰好得到同一个数，测试就失去区分力
  getRuntime().lastApplyAt = 123456;

  await setConfig(normalizeConfig({ ...cfg, enabled: false }));
  await applyProxy();
  assert.equal(getRuntime().lastApplyAt, 123456,
    '撤销代理设置不算注入，不该刷新“上次注入”的时间');
});

test('归因不到节点的请求单独计数，不硬塞给某个节点', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  // 出口 IP 不属于任何已知节点：代理没转发、或出口地址还没测出来
  await stub.emit('onCompleted', { requestId: 'm-5', url: IMG_URL, statusCode: 200, ip: '198.51.100.200' });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.total, 1);
  assert.equal(metrics.requests.unattributed, 1);
  assert.equal(metrics.nodes.rows.find((r) => r.id === 'n_aaaaaaa1').used, 0);
});

test('出口 IP 已知时归因到具体节点', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1', {
      health: {
        status: 'ok', latencyMs: 20, lastCheckedAt: 1,
        consecutiveFailures: 0, lastError: null, egressIp: '203.0.113.7',
      },
    })],
  });
  await stub.emit('onCompleted', { requestId: 'm-6', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });

  const { metrics } = await handleMessage({ type: 'getState' });
  const row = metrics.nodes.rows.find((r) => r.id === 'n_aaaaaaa1');
  assert.equal(row.used, 1);
  assert.equal(row.share, 100);
  assert.equal(metrics.requests.unattributed, 0);
});

test('测速与 PAC 注入的成败都计入统计', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await applyProxy();
  await probeNode('n_aaaaaaa1');
  stub.setFetch(async () => { throw new Error('Failed to fetch'); });
  await probeNode('n_aaaaaaa1');

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.probe.ok, 1);
  assert.equal(metrics.probe.fail, 1);
  assert.equal(metrics.probe.successRate, 50);
  assert.ok(metrics.apply.ok > 0, '注入成功也要计数');
});

test('注入失败时记下失败次数与原因', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  stub.setSettingsError('被企业策略禁止');
  await applyProxy();

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.apply.fail, 1);
  assert.match(metrics.apply.lastError, /被企业策略禁止/);
});

test('注入成功后清掉上一次的失败原因，界面不挂过期错误', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  stub.setSettingsError('临时故障');
  await applyProxy();
  stub.setSettingsError(null);
  await applyProxy();

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.apply.lastError, null);
});

test('统计落盘到 storage.local，跨浏览器重启保留', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onCompleted', { requestId: 'm-7', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });
  await flushMetrics();

  const stored = stub.local._dump()[METRICS_KEY];
  assert.ok(stored, '统计必须写进 storage.local —— session 区一关浏览器就没了');
  assert.equal(stored.requests.total, 1);
});

test('统计体积不随时间增长：删掉的节点并入 retired 而不是留下孤儿键', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')] });
  await stub.emit('onCompleted', { requestId: 'm-8', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });
  await handleMessage({ type: 'deleteNode', id: 'n_aaaaaaa1' });
  await handleMessage({ type: 'deleteNode', id: 'n_aaaaaaa2' });
  await flushMetrics();

  const stored = stub.local._dump()[METRICS_KEY];
  assert.deepEqual(Object.keys(stored.perNode), [], '配置里没有的节点不许在统计里留键');
  assert.equal(stored.requests.total, 1, '总量不受剪枝影响');
});

test('清空日志不动统计，清零统计不动日志 —— 两件事各自独立', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onCompleted', { requestId: 'm-9', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });
  assert.equal((await logsOf({ kind: 'request' })).length, 1);

  await handleMessage({ type: 'clearLogs' });
  assert.equal((await logsOf()).length, 0);
  assert.equal((await handleMessage({ type: 'getState' })).metrics.requests.total, 1,
    '清日志不该顺手抹掉统计');

  const reset = await handleMessage({ type: 'resetMetrics' });
  assert.equal(reset.metrics.requests.total, 0);
  assert.equal((await getMetrics()).since, null);
  assert.ok((await logsOf()).length > 0, '清零统计会留下一条说明日志');
});

test('getLogs 的轻量轮询也带上统计，弹窗不用再发第二条消息', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onCompleted', { requestId: 'm-11', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });

  const result = await handleMessage({ type: 'getLogs', limit: 10 });
  assert.equal(result.metrics.requests.total, 1);
  assert.ok(result.stats, '节点盘点也要一起带回来');
});

test('getState 带出最快节点与平均延迟，供统计面板直接展示', async () => {
  const health = (latencyMs) => ({
    status: 'ok', latencyMs, lastCheckedAt: 1, consecutiveFailures: 0, lastError: null, egressIp: null,
  });
  await seed({
    nodes: [
      nodeFixture('n_aaaaaaa1', { health: health(300) }),
      nodeFixture('n_aaaaaaa2', { health: health(40) }),
    ],
  });
  const { stats } = await handleMessage({ type: 'getState' });
  assert.equal(stats.fastest.id, 'n_aaaaaaa2');
  assert.equal(stats.avgLatency, 170);
});

test('注入的 PAC 一定是纯 ASCII，即便配置里全是中文', async () => {
  // 这是 #2 那个 bug 的回归测试：非 ASCII 会让 chrome.proxy 整体拒绝注入，
  // 而失败后浏览器照旧直连 —— 表现成「扩展安静地什么都没做」
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1', { host: '代理.example' })],
    rules: [
      { id: 'r_ccccccc1', name: '中文域名', type: 'host', pattern: '漫画.com', enabled: true, nodeIds: [] },
      { id: 'r_ccccccc2', name: '中文正则', type: 'regex', pattern: '漫画|コミック', enabled: true, nodeIds: [] },
    ],
  });
  const result = await applyProxy();

  assert.equal(result.applied, true, '不该再因为非 ASCII 而注入失败');
  const pac = stub.lastPac();
  assert.ok(pac, '必须真的注入了脚本');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(pac, /[^\x00-\x7F]/, '注入的 PAC 含非 ASCII 字符，浏览器会整体拒绝');
  assert.match(textOf(await logsOf({ kind: 'proxy' })), /已生效/);
});

test('规则的非 ASCII 提示随 getState 一起下发', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1')],
    rules: [{ id: 'r_bbbbbbb1', name: '中文正则', type: 'regex', pattern: '漫画', enabled: true, nodeIds: [] }],
  });
  const result = await handleMessage({ type: 'getState' });
  assert.match(result.ruleWarnings.r_bbbbbbb1[0], /Punycode/);
});

// ------------------------------------------- HTTPS 下路径不可见（决策 D16）
//
// 这一组是本项目最贵的回归测试。浏览器交给 PAC 的 https URL 已被剥掉 path 与 query，
// 所以「命中规则」和「真的走代理」是两件事。1.2.0 把它们当成一件事，于是统计报告
// 277 次「走代理的请求」，而代理服务商后台一条连接都没有。

test('规则命中但 HTTPS 下判定不了：记入 blind，不算进 routed，也不给规则记命中', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')], rules: [BLIND_RULE] });
  await applyProxy();

  await stub.emit('onBeforeRequest', { requestId: 'b-1', url: IMG_URL });
  await stub.emit('onCompleted', { requestId: 'b-1', url: IMG_URL, statusCode: 200, ip: '203.0.113.9' });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.total, 1, '仍要计入总量 —— 用户确实想代理它');
  assert.equal(metrics.requests.blind, 1);
  assert.equal(metrics.requests.routed, 0, '一次都没真的走代理');
  assert.equal(metrics.requests.unattributed, 0, '原因已经确切知道，不该再混进「认不出节点」');
  assert.equal(metrics.rules.rows.find((r) => r.id === BLIND_RULE.id).hits, 0,
    '这条规则没有路由任何东西，不能显示成在干活');
});

test('blind 请求在日志里说清原因，且同一条规则只说一次', async () => {
  // 用另一条规则 id：「每条规则只提示一次」的记录活在模块作用域里，
  // 上一个用例已经把 BLIND_RULE 的那一次用掉了 —— 这本身就是被测行为
  const other = { ...BLIND_RULE, id: 'r_bbbbbbb3', name: '扩展名二' };
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')], rules: [other] });
  for (let i = 0; i < 5; i++) {
    await stub.emit('onCompleted', { requestId: `b-${i}`, url: IMG_URL, statusCode: 200, ip: '203.0.113.9' });
  }
  const rows = (await logsOf({ kind: 'config' })).filter((r) => /剥掉路径/.test(r.message));
  assert.equal(rows.length, 1, `同一条规则不该刷屏，实际 ${rows.length} 条`);
  assert.match(rows[0].message, /https:\/\/cdn\.manga\.com\//, '要把浏览器实际交出去的 URL 写出来');
});

test('域名规则不会被误判成 blind', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onCompleted', { requestId: 'b-9', url: IMG_URL, statusCode: 200, ip: '203.0.113.9' });
  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.blind, 0);
  assert.equal(metrics.requests.routed, 1);
});

// ------------------------------------------- 测速定向（决策 D3 的实现方式已改）

test('测速期间注入的 PAC 真的把测速地址定向到目标节点', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')] });
  let pacDuringProbe = null;
  stub.setFetch(async () => {
    pacDuringProbe = stub.lastPac(); // 捕获发请求那一刻真正生效的脚本
    return { ok: true, status: 204 };
  });

  await probeNode('n_aaaaaaa2');

  assert.ok(pacDuringProbe, '测速前必须先注入定向 PAC');
  const probeUrl = stub.fetchCalls[0];
  const decision = loadPac(pacDuringProbe).find(...browserUrl(probeUrl));
  assert.equal(decision, 'PROXY aaaaaaa2.px:8080',
    '测速必须精确命中目标节点且无兜底，否则测出来的是直连的延迟');
});

test('测速结束后恢复正常 PAC，测速地址不再被钉在某个节点上', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')] });
  await probeAll();

  const after = loadPac(stub.lastPac());
  const probeOrigin = browserUrl((await getConfig()).settings.probe.url);
  assert.equal(after.find(...probeOrigin), 'DIRECT', '定向必须只在测速那一刻存在');
  assert.match(after.find(...IMG), /^PROXY /, '正常分流要恢复');
});

test('无法定向时测速判失败，绝不报告一个直连的延迟', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  stub.setControl('controlled_by_other_extensions');

  const result = await probeNode('n_aaaaaaa1');

  assert.equal(result.ok, false, '控制权不在手上时，请求根本不会走那个节点');
  assert.match(result.error, /控制权/);
  assert.equal(stub.fetchCalls.length, 0, '连请求都不该发出去');
  assert.equal((await getConfig()).nodes[0].health.status, 'fail');
});

test('测速地址非法时测速判失败而不是静默直连', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await handleMessage({
    type: 'saveConfig',
    config: { ...(await getConfig()), settings: { ...(await getConfig()).settings, probe: { ...(await getConfig()).settings.probe, url: 'https://ok.test/204' } } },
  });
  // schema 会把非法 URL 修回默认值，所以这里直接改缓存来模拟「拿不到源」的情形
  const config = await getConfig();
  config.settings.probe.url = 'not a url';

  const result = await probeNode('n_aaaaaaa1');
  assert.equal(result.ok, false);
  assert.match(result.error, /无法把测速请求定向/);
  assert.equal(stub.fetchCalls.length, 0);
});



// ------------------------------- 归因：多个节点共用同一地址（决策 D18）
//
// 真实用户的常见形态：一台代理机开 19 个端口，19 个节点的 host 全是 10.0.0.3。
// webRequest 只给出对端 IP，没有对端端口，所以「哪个节点在干活」这个问题在这种
// 配置下根本无法回答。旧的 findNodeByIp 用 `n.host === ip` 取第一个匹配，于是把
// 全部用量记到了列表里第一个节点上 —— 面板显示「1 个节点 100%、其余 18 个 0%」，
// 看起来像「轮询坏了」，其实是归因在编数字。

test('多个节点共用同一地址时不硬猜，记入无法归因而不是全塞给第一个', async () => {
  await seed({
    nodes: [
      nodeFixture('n_aaaaaaa1', { host: '10.0.0.3', port: 24000 }),
      nodeFixture('n_aaaaaaa2', { host: '10.0.0.3', port: 24001 }),
      nodeFixture('n_aaaaaaa3', { host: '10.0.0.3', port: 24002 }),
    ],
  });
  for (let i = 0; i < 6; i++) {
    await stub.emit('onBeforeRequest', { requestId: `s-${i}`, url: IMG_URL });
    await stub.emit('onCompleted', { requestId: `s-${i}`, url: IMG_URL, statusCode: 200, ip: '10.0.0.3' });
  }

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.routed, 6);
  assert.equal(metrics.requests.unattributed, 6, '端口分不出来，就不该假装知道是哪个节点');
  for (const row of metrics.nodes.rows) {
    assert.equal(row.used, 0, `${row.id} 不该被凭空记上用量`);
  }
  // 但「对端 IP 确实属于你的节点」是能确定的，这才是「真的走了代理」的硬证据
  assert.equal(metrics.requests.viaNodeIp, 6);
});

test('地址唯一的节点照旧能精确归因', async () => {
  await seed({
    nodes: [
      nodeFixture('n_aaaaaaa1', { host: '10.0.0.3', port: 24000 }),
      nodeFixture('n_aaaaaaa2', { host: '10.0.0.4', port: 24001 }),
    ],
  });
  await stub.emit('onCompleted', { requestId: 's-x', url: IMG_URL, statusCode: 200, ip: '10.0.0.4' });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.nodes.rows.find((r) => r.id === 'n_aaaaaaa2').used, 1);
  assert.equal(metrics.requests.unattributed, 0);
  assert.equal(metrics.requests.viaNodeIp, 1);
});

test('对端 IP 不属于任何节点时既不归因也不算作「经代理返回」', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1', { host: '10.0.0.3', port: 24000 })] });
  await stub.emit('onCompleted', { requestId: 's-y', url: IMG_URL, statusCode: 200, ip: '198.51.100.9' });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.unattributed, 1);
  assert.equal(metrics.requests.viaNodeIp, 0, '这次请求没有证据表明它经过了你的代理');
});

test('共用地址的节点数会在日志里说明，而不是给出一个假的节点名', async () => {
  await seed({
    nodes: [
      nodeFixture('n_aaaaaaa1', { host: '10.0.0.3', port: 24000 }),
      nodeFixture('n_aaaaaaa2', { host: '10.0.0.3', port: 24001 }),
    ],
  });
  await stub.emit('onCompleted', { requestId: 's-z', url: IMG_URL, statusCode: 200, ip: '10.0.0.3' });
  const text = textOf(await logsOf({ kind: 'request' }));
  assert.match(text, /10\.0\.0\.3/);
  assert.match(text, /共用|分不出|无法区分/, `应说明为什么归不到具体节点：${text}`);
});

// ------------------------------- 测速的并发保护
//
// 测速改成串行定向之后，一份 PAC 只能指向一个节点。两轮测速重叠时，A 轮注入的定向会
// 被 B 轮覆盖，于是「测节点 A 的请求」实际走了节点 B —— 又是一个会安静给出错数字的路径。

test('已有测速在进行时，再次触发会被明确拒绝而不是并发跑', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1'), nodeFixture('n_aaaaaaa2')] });
  // 让每次测速请求慢一拍，好让第二次调用落在第一轮还没结束的时候
  stub.setFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, status: 204 };
  });

  const first = probeAll();
  await Promise.resolve(); // 让第一轮真的开始

  assert.deepEqual(await probeAll(), [], '第二轮不该并发跑');
  const single = await probeNode('n_aaaaaaa1');
  assert.equal(single.ok, false, '单节点测速同样要被挡住');
  assert.match(single.error, /正在测速/);
  assert.match(textOf(await logsOf({ kind: 'probe' })), /正在测速/);

  assert.equal((await first).length, 2, '第一轮照常跑完');
});


// ------------------------------- 缓存命中
//
// 真实数据（logs/debug，2026-08-23）：481 条 request 事件只有 236 个不同 URL，重复
// 出现的 241 条中位数 3ms —— 那是磁盘缓存。旧实现从不读 details.fromCache，于是
// 「走了代理」虚高约一倍，而「平均耗时」变成 2ms 缓存与 16s 真实请求的混合物。
// 更隐蔽的是：缓存命中时浏览器**照样**给出上一次的对端 IP，所以它连
// 「对端确认是代理」都能骗过去。

test('缓存命中单列一格，不进总量、耗时与「对端确认是代理」', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1', { host: '203.0.113.7', port: 24000 })] });

  await stub.emit('onBeforeRequest', { requestId: 'c-1', url: IMG_URL });
  await stub.emit('onCompleted', {
    requestId: 'c-1', url: IMG_URL, statusCode: 200, ip: '203.0.113.7', fromCache: true,
  });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.cached, 1);
  assert.equal(metrics.requests.total, 0, '一个字节都没出去，不该算一次代理请求');
  assert.equal(metrics.requests.viaNodeIp, 0, '缓存给的是上一次的对端 IP，不是新证据');
  assert.equal(metrics.requests.avgLatencyMs, null);
  assert.equal(metrics.nodes.rows[0].used, 0, '不该记到节点用量上');
});

test('缓存命中不算规则在干活', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onCompleted', {
    requestId: 'c-2', url: IMG_URL, statusCode: 200, ip: '203.0.113.7', fromCache: true,
  });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.rules.rows.find((r) => r.id === RULE.id).hits, 0,
    '路由这次请求的是缓存，不是规则');
});

test('缓存命中在活动日志里说明为什么它很快', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await stub.emit('onCompleted', {
    requestId: 'c-3', url: IMG_URL, statusCode: 200, ip: '203.0.113.7', fromCache: true,
  });
  assert.match(textOf(await logsOf({ kind: 'request' })), /缓存/);
});

test('同一个 URL 首次走网络、之后命中缓存，两者分开计数', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1', { host: '203.0.113.7', port: 24000 })] });

  await stub.emit('onBeforeRequest', { requestId: 'c-4', url: IMG_URL });
  await stub.emit('onCompleted', { requestId: 'c-4', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });
  for (let i = 0; i < 5; i++) {
    await stub.emit('onBeforeRequest', { requestId: `c-5-${i}`, url: IMG_URL });
    await stub.emit('onCompleted', {
      requestId: `c-5-${i}`, url: IMG_URL, statusCode: 200, ip: '203.0.113.7', fromCache: true,
    });
  }

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.equal(metrics.requests.total, 1, '翻回去重看五遍不该让「走了代理」变成 6');
  assert.equal(metrics.requests.cached, 5);
  assert.equal(metrics.nodes.rows[0].used, 1);
});

// ------------------------------- 延迟分位数

test('分位数与平均值一起给出 —— 平均值对长尾没有抵抗力', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });

  // 九快一慢：平均值会被那一次 12 秒拉高，但 p50 应当仍然很小
  for (let i = 0; i < 9; i++) {
    await stub.emit('onBeforeRequest', { requestId: `p-${i}`, url: IMG_URL });
    await stub.emit('onCompleted', { requestId: `p-${i}`, url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });
  }
  await stub.emit('onCompleted', { requestId: 'p-slow', url: IMG_URL, statusCode: 200, ip: '203.0.113.7' });

  const { metrics } = await handleMessage({ type: 'getState' });
  assert.ok(Number.isFinite(metrics.requests.latencyP50), 'p50 应当给出具体数值');
  assert.ok(Number.isFinite(metrics.requests.latencyP90), 'p90 应当给出具体数值');
  assert.ok(metrics.requests.latencyP90 >= metrics.requests.latencyP50, 'p90 不该小于 p50');
});

// ---------------------------------------------------------------- 规则之外的流量

/**
 * 这一组守的是本项目最贵的一次静默故障。
 *
 * 注入 PAC 替换的是浏览器**整份**代理配置，包括「使用系统代理设置」。所以没配默认代理时，
 * 规则之外的流量拿到的是**真·直连** —— 靠本机代理客户端上网的人会看到「图片站一切正常、
 * 其余网站全部 ERR_CONNECTION_TIMED_OUT」，而扩展这边一个错都不报，因为它确实按用户写的
 * 规则做了它该做的事。
 */

/** 规则外的某个站点，PAC 眼里的样子 */
const OTHER = browserUrl('https://unrelated.example/page');
const DEFAULT_PROXY = { enabled: true, raw: 'http://127.0.0.1:7897' };

test('配了默认代理后，注入的 PAC 让规则外流量走它而不是直连', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1')],
    settings: { defaultProxy: DEFAULT_PROXY },
  });
  await applyProxy();
  const pac = loadPac(stub.lastPac());

  assert.equal(pac.find(...OTHER), 'PROXY 127.0.0.1:7897');
  assert.match(pac.find(...IMG), /^PROXY aaaaaaa1\.px:8080/, '命中规则的照旧走节点');
});

test('没配默认代理时规则外流量仍是 DIRECT —— 老配置的行为一个字都不变', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  await applyProxy();
  assert.equal(loadPac(stub.lastPac()).find(...OTHER), 'DIRECT');
});

test('接管一个非直连的浏览器代理设置且没配默认代理时，必须明说规则外流量已变直连', async () => {
  // 这条日志是这个故障唯一的自动线索：接管之后 proxy.settings.get() 永远只回
  // pac_script，「用户原本是怎么上网的」再也问不出来
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  stub.setControl('controllable_by_this_extension');
  stub.setSettingsValue({ mode: 'system' });

  await applyProxy();

  const text = textOf(await logsOf({ kind: 'proxy' }));
  assert.match(text, /已接管浏览器代理设置/);
  assert.match(text, /ERR_CONNECTION_TIMED_OUT/, '要说出用户会看到的现象，而不是只说「已接管」');
  assert.equal(getRuntime().priorProxyMode, 'system');
});

test('配了默认代理时不再唠叨那条告警 —— 原来的通路已经被保住了', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1')],
    settings: { defaultProxy: DEFAULT_PROXY },
  });
  stub.setControl('controllable_by_this_extension');
  stub.setSettingsValue({ mode: 'system' });

  await applyProxy();

  assert.doesNotMatch(textOf(await logsOf({ kind: 'proxy' })), /已接管浏览器代理设置/);
  assert.equal(getRuntime().priorProxyMode, 'system', '模式照旧记下来，供状态页展示');
});

test('浏览器原本就是直连时不告警 —— 接管它不改变任何事', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  stub.setControl('controllable_by_this_extension');
  stub.setSettingsValue({ mode: 'direct' });

  await applyProxy();

  assert.doesNotMatch(textOf(await logsOf({ kind: 'proxy' })), /已接管浏览器代理设置/);
});

test('已经是本扩展在管时问不出原始模式，也就不该乱猜', async () => {
  await seed({ nodes: [nodeFixture('n_aaaaaaa1')] });
  // stub 默认就是 controlled_by_this_extension
  await applyProxy();

  assert.equal(getRuntime().priorProxyMode, null);
  assert.doesNotMatch(textOf(await logsOf({ kind: 'proxy' })), /已接管浏览器代理设置/);
});

test('默认代理要求认证时自动应答 —— 否则每开一个网站都弹一次认证框', async () => {
  await seed({
    nodes: [nodeFixture('n_aaaaaaa1')],
    settings: {
      defaultProxy: { enabled: true, raw: 'http://gate.lan:3128', username: 'bob', password: 'hunter2' },
    },
  });
  const entry = stub.listeners.onAuthRequired[0];
  const got = await new Promise((resolve) => entry.fn({
    isProxy: true,
    requestId: 'auth-dflt',
    challenger: { host: 'gate.lan', port: 3128 },
  }, resolve));

  assert.deepEqual(got.authCredentials, { username: 'bob', password: 'hunter2' });
  assert.match(textOf(await logsOf({ kind: 'proxy' })), /默认代理 gate\.lan:3128/);
});
