/**
 * 页面侧调试日志的自噬防护。
 *
 * 这里只有两个断言，但第二个是正确性问题而不是优化：如果 `send()` 无差别地记 `ui` 日志，
 * 那么 `debugPush` 自己也会被记一笔 → 下次 flush 把它发出去 → 又记一笔 → 由定时器驱动，
 * **永不收敛**。少一个排除，日志里就全是日志自己。
 *
 * api.js 在模块顶层就会读一次开关，所以替身必须先装好再动态导入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const sent = [];

globalThis.chrome = {
  storage: {
    local: {
      get(_key, callback) {
        callback({ debug: { enabled: true } });
      },
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    async sendMessage(message) {
      sent.push(message);
      return { ok: true };
    },
  },
};
globalThis.document = { visibilityState: 'visible', addEventListener() {} };

const { send, flushUiDebug } = await import('../src/pages/shared/api.js');

test('页面发出的消息会记进 ui 命名空间', async () => {
  sent.length = 0;
  await send('getState');
  await flushUiDebug();

  const push = sent.find((m) => m.type === 'debugPush');
  assert.ok(push, '页面也存不住东西，不回传就等于没记');
  assert.equal(push.rows[0].ns, 'ui');
  assert.equal(push.rows[0].data.type, 'getState');
  assert.equal(push.rows[0].data.ok, true);
});

test('debug 自己的那几条消息不记，否则日志会自己喂自己', async () => {
  sent.length = 0;
  await send('getDebug');
  await send('exportDebug');
  await flushUiDebug();
  assert.equal(sent.find((m) => m.type === 'debugPush'), undefined);
});

test('后台回 ok:false 时照样记下来，并带上原因', async () => {
  sent.length = 0;
  globalThis.chrome.runtime.sendMessage = async (message) => {
    sent.push(message);
    return message.type === 'saveRule' ? { ok: false, error: '规则非法' } : { ok: true };
  };
  await assert.rejects(() => send('saveRule'));
  await flushUiDebug();

  const row = sent.find((m) => m.type === 'debugPush')?.rows[0];
  assert.equal(row.data.ok, false);
  assert.equal(row.data.error, '规则非法');
});
