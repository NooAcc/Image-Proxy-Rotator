/**
 * Service Worker 启动冒烟测试。
 *
 * 对应人工验证清单第 1 步「加载扩展，看控制台有没有红字」—— 在浏览器里这只能靠肉眼，
 * 这里把它变成断言：SW 模块能否被求值、顶层事件是否注册齐、冷启动后是否真的注入了 PAC。
 *
 * 单独一个文件是必须的：service-worker.js 在**导入时**就会跑 boot()，
 * 而 node --test 每个文件一个进程，这样才不会污染其他测试的模块状态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub } from './helpers/chrome-stub.js';
import { loadPac } from './helpers/pac-sandbox.js';

const stub = installChromeStub();

// 先把「历史配置」写进 storage：一个可用的 http 节点 + 一个早期版本残留的 socks5 节点。
// 必须在导入 SW 之前写好，因为 boot() 会在导入时立刻读它。
await stub.local.set({
  config: {
    version: 1,
    enabled: true,
    nodes: [
      { id: 'n_bbbbbbb1', name: '好节点', protocol: 'http', host: 'good.px', port: 8080 },
      { id: 'n_bbbbbbb9', name: '旧 SOCKS', protocol: 'socks5', host: 'old.px', port: 1080 },
    ],
    rules: [{ id: 'r_bbbbbbb1', name: '图片', type: 'regex', pattern: '\\.jpg$', enabled: true, nodeIds: [] }],
    settings: { probe: { intervalMinutes: 15 } },
  },
});

await import('../src/background/service-worker.js');

/** 等 boot() 跑完（它是导入时异步启动的） */
async function settled(check, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

const sessionLogs = () => stub.session._dump().logs ?? [];
const logText = () => sessionLogs().map((r) => r.message).join('\n');

test('顶层同步注册了全部事件监听（否则 SW 被唤醒时会漏事件）', () => {
  assert.equal(stub.listeners.onMessage.length, 1);
  assert.equal(stub.listeners.onInstalled.length, 1);
  assert.equal(stub.listeners.onStartup.length, 1);
  assert.equal(stub.listeners.onAlarm.length, 1);
  assert.equal(stub.listeners.onBeforeRequest.length, 1);
  assert.equal(stub.listeners.onCompleted.length, 1);
  assert.equal(stub.listeners.onErrorOccurred.length, 1);
  assert.equal(stub.listeners.onAuthRequired.length, 1);
});

test('冷启动后自动读回配置并注入 PAC', async () => {
  assert.ok(await settled(() => stub.lastPac() !== null), '启动后应当注入 PAC');

  const set = stub.lastSet();
  assert.equal(set.value.mode, 'pac_script');
  assert.equal(set.value.pacScript.mandatory, false);

  const pac = loadPac(stub.lastPac());
  assert.match(pac.find('https://cdn.manga.com/1.jpg', 'cdn.manga.com'), /^PROXY good\.px:8080/);
  assert.ok(!pac.find('https://cdn.manga.com/1.jpg', 'cdn.manga.com').includes('old.px'),
    '历史 socks5 节点绝不能进入分流');
});

test('启动日志写进 session，并显式告警历史遗留的不支持节点', async () => {
  assert.ok(await settled(() => /不支持的节点/.test(logText())), `实际日志：\n${logText()}`);

  assert.match(logText(), /后台已启动/);
  const warn = sessionLogs().find((r) => r.level === 'warn' && /不支持的节点/.test(r.message));
  assert.ok(warn, '必须是 warn 级，不能悄悄放过');
  assert.match(warn.message, /SOCKS5/);
  assert.match(warn.message, /仅支持 HTTP\/HTTPS 代理/);
});

test('启动时按配置建立定时测速任务', async () => {
  assert.ok(await settled(() => stub.alarms.size > 0));
  assert.equal(stub.alarms.get('pp-probe').periodInMinutes, 15);
});

test('onMessage 保持通道打开并异步回传结果', async () => {
  const listener = stub.listeners.onMessage[0].fn;
  const response = await new Promise((resolve) => {
    const kept = listener({ type: 'getState' }, null, resolve);
    assert.equal(kept, true, '必须返回 true，否则异步响应会被丢弃');
  });

  assert.equal(response.ok, true);
  assert.equal(response.config.nodes.length, 2);
  assert.equal(response.stats.available, 1, '只有那个 http 节点算可用');
  assert.deepEqual(response.unsupportedIds, ['n_bbbbbbb9']);
});

test('onMessage 对未知类型也如实回错，不会挂住通道', async () => {
  const listener = stub.listeners.onMessage[0].fn;
  const response = await new Promise((resolve) => listener({ type: '不存在' }, null, resolve));
  assert.equal(response.ok, false);
  assert.match(response.error, /未知的消息类型/);
});

test('alarms 只响应本扩展自己的任务名', async () => {
  const listener = stub.listeners.onAlarm[0].fn;
  const before = stub.fetchCalls.length;
  listener({ name: '别人的任务' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stub.fetchCalls.length, before, '不该被别的 alarm 触发测速');
});
