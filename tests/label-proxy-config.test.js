import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan } from '../tools/label-proxy/lib/config.mjs';

test('buildPlan 从 baseAddress 起为每个上游分配递增的回环地址', () => {
  const plan = buildPlan({
    local: { baseAddress: '127.0.0.2', port: 8080 },
    upstreams: [
      { name: 'A', host: '10.0.0.3', port: 24000 },
      { name: 'B', host: '10.0.0.3', port: 24001 },
    ],
  });

  assert.deepEqual(plan.listeners, [
    {
      localAddress: '127.0.0.2',
      localPort: 8080,
      upstreamHost: '10.0.0.3',
      upstreamPort: 24000,
      name: 'A',
    },
    {
      localAddress: '127.0.0.3',
      localPort: 8080,
      upstreamHost: '10.0.0.3',
      upstreamPort: 24001,
      name: 'B',
    },
  ]);
  assert.deepEqual(plan.importLines, [
    'http://127.0.0.2:8080#A',
    'http://127.0.0.3:8080#B',
  ]);
});

test('buildPlan 在 local 缺省时使用 127.0.0.2 与 8080', () => {
  const plan = buildPlan({
    upstreams: [{ host: '192.0.2.10', port: 3128 }],
  });

  assert.equal(plan.listeners[0].localAddress, '127.0.0.2');
  assert.equal(plan.listeners[0].localPort, 8080);
  assert.equal(plan.listeners[0].upstreamHost, '192.0.2.10');
  assert.equal(plan.listeners[0].name, '192.0.2.10:3128');
});

test('buildPlan 拒绝空 upstreams', () => {
  assert.throws(
    () => buildPlan({ upstreams: [] }),
    /至少需要 1 个上游代理/,
  );
});

test('buildPlan 拒绝越界端口并带上条目名', () => {
  assert.throws(
    () => buildPlan({ upstreams: [{ name: 'X', host: '10.0.0.3', port: 0 }] }),
    /X.*端口必须是 1-65535/,
  );
});

test('buildPlan 拒绝空 host', () => {
  assert.throws(
    () => buildPlan({ upstreams: [{ host: '  ', port: 24000 }] }),
    /host 不能为空/,
  );
});

test('buildPlan 拒绝 127.0.0.1 作为分配起点', () => {
  assert.throws(
    () => buildPlan({
      local: { baseAddress: '127.0.0.1' },
      upstreams: [{ host: '10.0.0.3', port: 24000 }],
    }),
    /不能从 127\.0\.0\.1/,
  );
});
