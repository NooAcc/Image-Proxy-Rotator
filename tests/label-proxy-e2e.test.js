import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { installChromeStub } from './helpers/chrome-stub.js';
import { startLabelService } from '../tools/label-proxy/lib/service.mjs';

const stub = installChromeStub();

const { getConfig, setConfig } = await import('../src/background/state.js');
const { runEasyProxiesSync } = await import('../src/background/easy-proxies-sync.js');
const { normalizeConfig } = await import('../src/lib/schema.js');

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
      if (received.length >= 'UP:ping'.length) {
        socket.end();
        resolve(received);
      }
    });
    socket.on('error', reject);
  });
}

test('真实 HTTP 服务 + easy_proxies 同步：自动转换并写回可用的标签节点', async () => {
  const upstream = createEchoServer('UP:');
  const relayPort = await freePort();
  const service = await startLabelService({
    local: { baseAddress: '127.0.20.2', port: relayPort },
    service: { host: '127.0.0.1', port: 0 },
  });

  stub.reset();
  await setConfig(normalizeConfig({
    enabled: true,
    settings: {
      easyProxies: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:19090',
        labelServiceUrl: `http://127.0.0.1:${service.port}`,
        labelServiceToken: '',
        maxNodes: 15,
        intervalMinutes: 0,
      },
    },
  }));

  stub.setFetch(async (url, options = {}) => {
    if (url === 'http://127.0.0.1:19090/api/nodes') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            nodes: [
              {
                tag: 'e2e',
                name: '端到端',
                port: await upstream.port,
                available: true,
                blacklisted: false,
                last_latency_ms: 10,
              },
            ],
          };
        },
      };
    }
    const response = await stub.realFetch(url, options);
    return {
      ok: response.ok,
      status: response.status,
      async json() {
        return response.json();
      },
    };
  });

  try {
    const result = await runEasyProxiesSync();
    const cfg = await getConfig();
    assert.equal(result.added, 1);
    assert.equal(cfg.nodes.length, 1);
    assert.equal(cfg.nodes[0].host, '127.0.20.2');
    assert.equal(cfg.nodes[0].meta.labelProxy.upstreamPort, await upstream.port);
    assert.equal(cfg.settings.easyProxies.lastSyncError, null);
    assert.equal(await roundTrip('127.0.20.2', relayPort), 'UP:ping');
  } finally {
    await service.close();
    await closeServer(upstream.server);
  }
});
