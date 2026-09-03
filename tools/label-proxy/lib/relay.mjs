/**
 * 本地标签代理的 TCP 中继运行层。
 *
 * 浏览器把 HTTP 代理协议直接讲给本地 listener，工具不做任何解析，只把字节流
 * 原样双向转发到对应的上游代理。这样同一份实现天然支持 HTTP、CONNECT 与
 * keep-alive —— 协议语义完全由两端自己处理。
 */

import net from 'node:net';

function relay(client, entry, sockets) {
  const upstream = net.connect({
    host: entry.upstreamHost,
    port: entry.upstreamPort,
  });

  sockets.add(client);
  sockets.add(upstream);
  client.setNoDelay(true);
  upstream.setNoDelay(true);

  const done = () => {
    sockets.delete(client);
    sockets.delete(upstream);
    client.destroy();
    upstream.destroy();
  };

  client.on('error', done);
  upstream.on('error', done);
  client.on('close', done);
  upstream.on('close', done);
  client.pipe(upstream);
  upstream.pipe(client);
}

/**
 * 按 plan 启动所有本地 listener。
 * @param {{listeners: object[]}} plan config.buildPlan 的产物
 * @param {(message: string) => void} [log]
 * @returns {Promise<{servers: object[], close: () => Promise<void>}>}
 */
export async function startRelays(plan, log = () => {}) {
  const listeners = plan?.listeners ?? [];
  if (listeners.length === 0) {
    throw new Error('没有可启动的 listener');
  }

  const servers = [];
  const sockets = new Set();

  try {
    for (const entry of listeners) {
      const server = net.createServer((client) => relay(client, entry, sockets));
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(entry.localPort, entry.localAddress);
      });
      servers.push(server);
      log(
        `${entry.localAddress}:${entry.localPort} -> `
        + `${entry.upstreamHost}:${entry.upstreamPort} (${entry.name})`,
      );
    }

    return {
      servers,
      async close() {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        await Promise.all(servers.map((server) => new Promise((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        })));
      },
    };
  } catch (error) {
    for (const server of servers) {
      try {
        if (server.listening) server.close();
      } catch {
        // 清理路径不抛
      }
    }
    const message = error?.message ?? String(error);
    throw new Error(`监听本地标签地址失败：${message}`);
  }
}
