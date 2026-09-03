import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { startLabelService } from '../tools/label-proxy/lib/service.mjs';

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe, '127.0.0.1');
  await closeServer(probe);
  return port;
}

function createEchoServer(prefix) {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from(prefix), chunk])));
  });
  return { server, port: listen(server, '127.0.0.1') };
}

function roundTrip(localAddress, localPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(localPort, localAddress);
    let received = '';
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error(`到 ${localAddress}:${localPort} 的中继超时`));
    });
    socket.on('connect', () => socket.write('ping'));
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.length >= 'UP-A:ping'.length) {
        socket.end();
        resolve(received);
      }
    });
    socket.on('error', reject);
  });
}

async function postJson(url, body, token = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON 响应由调用方按状态码判断
  }
  return { status: response.status, body: payload };
}

test('POST /api/convert 启动标签中继并返回可写回扩展的节点', async () => {
  const upA = createEchoServer('UP-A:');
  const upB = createEchoServer('UP-B:');
  const relayPort = await freePort();
  const service = await startLabelService({
    local: { baseAddress: '127.0.0.2', port: relayPort },
    service: { host: '127.0.0.1', port: 0 },
  });

  try {
    const result = await postJson(`http://127.0.0.1:${service.port}/api/convert`, {
      upstreams: [
        { name: 'A', host: '127.0.0.1', port: await upA.port },
        { name: 'B', host: '127.0.0.1', port: await upB.port },
      ],
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.nodes.map((n) => n.host), ['127.0.0.2', '127.0.0.3']);
    assert.equal(result.body.nodes[0].upstreamPort, await upA.port);
    assert.equal(result.body.nodes[1].upstreamPort, await upB.port);
    assert.equal(await roundTrip('127.0.0.2', relayPort), 'UP-A:ping');
    assert.equal(await roundTrip('127.0.0.3', relayPort), 'UP-B:ping');
  } finally {
    await service.close();
    await closeServer(upA.server);
    await closeServer(upB.server);
  }
});

test('GET /api/status 返回服务状态', async () => {
  const service = await startLabelService({
    local: { baseAddress: '127.0.0.2', port: await freePort() },
    service: { host: '127.0.0.1', port: 0 },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/api/status`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.relays, 0);
  } finally {
    await service.close();
  }
});

test('配置 token 后 /api/convert 要求 Bearer 认证', async () => {
  const service = await startLabelService({
    local: { baseAddress: '127.0.0.2', port: await freePort() },
    service: { host: '127.0.0.1', port: 0, token: 'secret' },
  });
  try {
    const url = `http://127.0.0.1:${service.port}/api/convert`;
    const payload = { upstreams: [{ name: 'A', host: '127.0.0.1', port: 1 }] };
    const missing = await postJson(url, payload);
    assert.equal(missing.status, 401);
    const wrong = await postJson(url, payload, 'wrong');
    assert.equal(wrong.status, 401);
    const right = await postJson(url, payload, 'secret');
    assert.equal(right.status, 200);
  } finally {
    await service.close();
  }
});

test('非法 upstreams 返回 400 而不是 500', async () => {
  const service = await startLabelService({
    local: { baseAddress: '127.0.0.2', port: await freePort() },
    service: { host: '127.0.0.1', port: 0 },
  });
  try {
    const result = await postJson(`http://127.0.0.1:${service.port}/api/convert`, {
      upstreams: [{ name: 'X', host: '10.0.0.3', port: 0 }],
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /端口必须是 1-65535/);
  } finally {
    await service.close();
  }
});
