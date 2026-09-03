import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { startRelays } from '../tools/label-proxy/lib/relay.mjs';

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function createEchoServer(prefix) {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from(prefix), chunk])));
  });
  return { server, port: listen(server, '127.0.0.1') };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function freeLocalPort() {
  const probe = net.createServer();
  const port = await listen(probe, '127.0.0.1');
  await closeServer(probe);
  return port;
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
      if (received.length >= 5 + 'ping'.length) {
        socket.end();
        resolve(received);
      }
    });
    socket.on('error', reject);
  });
}

test('startRelays 把不同回环地址透明转发到各自上游', async () => {
  const upA = createEchoServer('UP-A:');
  const upB = createEchoServer('UP-B:');
  const localPort = await freeLocalPort();

  const handle = await startRelays({
    listeners: [
      {
        localAddress: '127.0.0.2',
        localPort,
        upstreamHost: '127.0.0.1',
        upstreamPort: await upA.port,
        name: 'A',
      },
      {
        localAddress: '127.0.0.3',
        localPort,
        upstreamHost: '127.0.0.1',
        upstreamPort: await upB.port,
        name: 'B',
      },
    ],
  });

  try {
    const a = await roundTrip('127.0.0.2', localPort);
    const b = await roundTrip('127.0.0.3', localPort);
    assert.equal(a, 'UP-A:ping');
    assert.equal(b, 'UP-B:ping');
  } finally {
    await handle.close();
    await closeServer(upA.server);
    await closeServer(upB.server);
  }
});

test('startRelays 在监听地址被占用时给出可读错误并清理已监听项', async () => {
  const blocker = net.createServer();
  const port = await listen(blocker, '127.0.0.2');
  await assert.rejects(
    startRelays({
      listeners: [
        {
          localAddress: '127.0.0.2',
          localPort: port,
          upstreamHost: '127.0.0.1',
          upstreamPort: 1,
          name: 'occupied',
        },
      ],
    }),
    /EADDRINUSE|address already in use|已占用/i,
  );
  await new Promise((resolve) => blocker.close(resolve));
});
