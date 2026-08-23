/**
 * 深度重试的注入状态机。
 *
 * 这里验的是一件很容易写错、而且写错了**不会报错**的事：注册状态与配置对不上。
 * `chrome.scripting` 对「已注册的 id 再 register」会抛错、对「没注册过的 id 调 update」
 * 也会抛错，所以 register / update 的分支必须按当前状态选对；而任何一次失败之后页面
 * 照常加载、补丁只是不存在 —— 表现就是「勾了但没用」。
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeStub } from './helpers/chrome-stub.js';

const stub = installChromeStub();

let syncDeepRetryScripts;
let resetDeepRetrySync;
let setConfig;
let getLogger;

before(async () => {
  ({ syncDeepRetryScripts, resetDeepRetrySync } = await import('../src/background/deep-retry-injector.js'));
  ({ setConfig, getLogger } = await import('../src/background/state.js'));
});

beforeEach(async () => {
  stub.reset();
  resetDeepRetrySync();
  await setConfig({ enabled: true, nodes: [], rules: [], settings: {} });
});

/** 把深度重试设成某个状态 */
async function configure(deepRetry) {
  await setConfig({ enabled: true, nodes: [], rules: [], settings: { deepRetry } });
}

/** 活动日志里最近一条消息（logger.list() 是最新在前） */
async function lastLog() {
  const log = await getLogger();
  const entries = log.list({ limit: 1 });
  return entries.length ? entries[0] : null;
}

test('默认关闭时一个脚本都不注册', async () => {
  const result = await syncDeepRetryScripts();
  assert.equal(result.active, false);
  assert.equal(stub.registeredScripts.size, 0);
  assert.deepEqual(stub.scriptingCalls, [], '关着的时候连 chrome.scripting 都不该碰');
});

test('开启后注册两个脚本：桥在隔离世界，补丁在主世界', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  const result = await syncDeepRetryScripts();

  assert.equal(result.active, true);
  assert.deepEqual(result.patterns, ['*://*.nhentai.net/*']);
  assert.equal(stub.registeredScripts.size, 2);

  const bridge = stub.registeredScripts.get('pp-deep-bridge');
  const patch = stub.registeredScripts.get('pp-deep-patch');
  assert.equal(bridge.world, 'ISOLATED', '桥必须在隔离世界 —— 只有那里才有 chrome.runtime');
  assert.equal(patch.world, 'MAIN', '补丁必须在主世界 —— 隔离世界改不到页面的 window.fetch');
  for (const script of [bridge, patch]) {
    assert.equal(script.runAt, 'document_start',
      '晚于 document_start 就可能被页面脚本抢先取走 window.fetch');
    assert.equal(script.allFrames, true);
    assert.deepEqual(script.matches, ['*://*.nhentai.net/*']);
  }
});

test('两个脚本要么都注册要么都不注册', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  await syncDeepRetryScripts();
  // 只有桥没有补丁等于什么都不做；只有补丁没有桥则是补丁问不到人、每次都等满超时
  assert.ok(stub.registeredScripts.has('pp-deep-bridge'));
  assert.ok(stub.registeredScripts.has('pp-deep-patch'));
});

test('改站点清单走 update，而不是再 register 一次（那会抛「重复 id」）', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  await syncDeepRetryScripts();
  stub.scriptingCalls.length = 0;

  await configure({ enabled: true, sites: ['nhentai.net', 'https://noymanga.com/read/*'] });
  const result = await syncDeepRetryScripts();

  assert.deepEqual(result.patterns, ['*://*.nhentai.net/*', 'https://noymanga.com/read/*']);
  assert.deepEqual(stub.scriptingCalls.map((c) => c.type), ['update']);
  assert.deepEqual(
    stub.registeredScripts.get('pp-deep-patch').matches,
    ['*://*.nhentai.net/*', 'https://noymanga.com/read/*'],
  );
});

test('关掉之后注销，页面上再也不会被注入', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  await syncDeepRetryScripts();

  await configure({ enabled: false, sites: ['nhentai.net'] });
  const result = await syncDeepRetryScripts();

  assert.equal(result.active, false);
  assert.equal(stub.registeredScripts.size, 0);
  assert.ok(stub.scriptingCalls.some((c) => c.type === 'unregister'));
});

test('站点清单清空后同样注销 —— 开关还勾着也一样', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  await syncDeepRetryScripts();

  await configure({ enabled: true, sites: [] });
  const result = await syncDeepRetryScripts();
  assert.equal(result.active, false);
  assert.equal(stub.registeredScripts.size, 0);
});

test('全是非法填法时不注册，并把原因带回去', async () => {
  await configure({ enabled: true, sites: ['<all_urls>', '*://*/*'] });
  const result = await syncDeepRetryScripts();

  assert.equal(result.active, false);
  assert.equal(stub.registeredScripts.size, 0);
  assert.equal(result.skipped.length, 2);
  for (const item of result.skipped) assert.ok(item.reason.length > 0);
});

test('模式没变时不重复问 chrome —— 每次测速结束都会调一次 applyProxy', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  await syncDeepRetryScripts();
  const calls = stub.scriptingCalls.length;

  await syncDeepRetryScripts();
  await syncDeepRetryScripts();
  assert.equal(stub.scriptingCalls.length, calls, '签名没变就该短路');
});

test('注册失败时写 error 日志，绝不静默 —— 失败之后表现就是「勾了但没用」', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  stub.setScriptingError('Invalid match pattern');
  const result = await syncDeepRetryScripts();

  assert.equal(result.active, false);
  assert.match(result.error, /Invalid match pattern/);
  const entry = await lastLog();
  assert.equal(entry.level, 'error');
  assert.match(entry.message, /深度重试注入失败/);
  assert.match(entry.message, /仍然不会被重试/, '必须说清后果，不能只报错误码');
});

test('注册失败后不缓存签名，下一次会重试', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  stub.setScriptingError('boom');
  await syncDeepRetryScripts();

  stub.setScriptingError(null);
  const result = await syncDeepRetryScripts();
  assert.equal(result.active, true, '上一次失败不该被当成「已经同步好了」');
  assert.equal(stub.registeredScripts.size, 2);
});

test('浏览器没有 chrome.scripting 时给出明确原因，而不是崩掉', async () => {
  await configure({ enabled: true, sites: ['nhentai.net'] });
  stub.removeScripting();
  const result = await syncDeepRetryScripts();

  assert.equal(result.active, false);
  assert.match(result.error, /111/, '要告诉用户需要哪个版本');
  const entry = await lastLog();
  assert.equal(entry.level, 'error');
});
