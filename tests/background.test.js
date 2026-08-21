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
import { loadPac } from './helpers/pac-sandbox.js';

const stub = installChromeStub();

const { getConfig, setConfig, getRuntime, getLogger } = await import('../src/background/state.js');
const { applyProxy } = await import('../src/background/proxy-controller.js');
const { probeNode, probeAll, scheduleProbeAlarm, onAlarm } = await import('../src/background/health-monitor.js');
const { handleMessage } = await import('../src/background/messaging.js');
const { installRequestLogger } = await import('../src/background/request-logger.js');
const { installAuthProvider } = await import('../src/background/auth-provider.js');
const { normalizeConfig } = await import('../src/lib/schema.js');
const { UNSUPPORTED_PROTOCOL_MESSAGE, PROBE_PARAM, ALARM_PROBE } = await import('../src/lib/constants.js');

assert.equal(installRequestLogger(), true, 'webRequest 监听器应注册成功');
assert.equal(installAuthProvider(), true, 'onAuthRequired 监听器应注册成功');

// ---------------------------------------------------------------- 夹具

const IMG = ['https://cdn.manga.com/ch1/001.jpg', 'cdn.manga.com'];
const RULE = { id: 'r_aaaaaaa1', name: '图片', type: 'regex', pattern: '\\.jpg$', enabled: true, nodeIds: [] };

/** 重置存储、运行时态与日志，并写入一份新配置 */
async function seed(partial = {}) {
  stub.reset();
  Object.assign(getRuntime(), {
    stats: {}, startIndex: 0, control: null, summary: null, lastApplyAt: null, probing: false,
  });
  await setConfig(normalizeConfig({ enabled: true, rules: [RULE], ...partial }));
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

  await stub.emit('onBeforeRequest', { requestId: 'req-1', url: IMG[0] });
  await stub.emit('onCompleted', { requestId: 'req-1', url: IMG[0], statusCode: 200, ip: '203.0.113.7' });

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
    requestId: 'req-3', url: 'https://cdn.manga.com/app.js', statusCode: 200, ip: '1.1.1.1',
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
