/**
 * 本地标签代理的 HTTP 服务模式。
 *
 * 扩展从 easy_proxies 拉到节点后，调用 `POST /api/convert` 让本工具按同一套
 * `buildPlan` 规则分配回环标签、启动中继，并拿回可直接写回扩展的节点。
 *
 * 服务只应绑定在回环地址上，token 为可选的 Bearer 保护，避免同机其他程序
 * 随意启停代理中继。
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { buildPlan } from './config.mjs';
import { startRelays } from './relay.mjs';

const BODY_LIMIT_BYTES = 1_000_000;

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

function tokenMatches(expected, provided) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > BODY_LIMIT_BYTES) {
        const error = new Error('请求体超过 1 MB 上限');
        error.status = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * 启动 HTTP 服务并管理动态标签中继。
 * @param {object} options
 * @param {object} [options.local] config 里的 local 段
 * @param {object} [options.service] config 里的 service 段
 * @param {object[]} [options.initialUpstreams] 启动时先加载的 upstreams
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{port: number, replace: Function, close: Function}>}
 */
export async function startLabelService({
  local = {},
  service = {},
  initialUpstreams = [],
  log = () => {},
}) {
  let currentHandle = null;
  let currentPlan = { listeners: [], importLines: [] };

  const replace = async (upstreams) => {
    const plan = buildPlan({ local, upstreams });
    if (currentHandle) {
      await currentHandle.close();
      currentHandle = null;
    }
    try {
      currentHandle = await startRelays(plan, (line) => log(line));
    } catch (error) {
      const wrapped = new Error(`无法启动标签中继：${error?.message ?? error}`);
      wrapped.status = 503;
      throw wrapped;
    }
    currentPlan = plan;
    return plan;
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, {
          ok: true,
          mode: 'label-service',
          relays: currentPlan.listeners.length,
        });
        return;
      }

      if (request.method !== 'POST' || url.pathname !== '/api/convert') {
        sendJson(response, 404, { ok: false, error: '接口不存在' });
        return;
      }

      const token = String(service.token ?? '');
      const header = String(request.headers.authorization ?? '');
      if (token && !header.startsWith('Bearer ')) {
        sendJson(response, 401, { ok: false, error: '缺少 Bearer 认证' });
        return;
      }
      const provided = header.slice('Bearer '.length);
      if (token && !tokenMatches(token, provided)) {
        sendJson(response, 401, { ok: false, error: 'token 不正确' });
        return;
      }

      const body = await readBody(request);
      let parsed = null;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        sendJson(response, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }

      const upstreams = Array.isArray(parsed?.upstreams) ? parsed.upstreams : [];
      if (upstreams.length === 0) {
        sendJson(response, 400, { ok: false, error: '至少需要 1 个上游代理' });
        return;
      }

      let plan;
      try {
        plan = await replace(upstreams);
      } catch (error) {
        sendJson(response, error.status ?? 400, {
          ok: false,
          error: error?.message ?? String(error),
        });
        return;
      }

      sendJson(response, 200, {
        ok: true,
        nodes: plan.listeners.map((listener) => ({
          name: listener.name,
          host: listener.localAddress,
          port: listener.localPort,
          upstreamHost: listener.upstreamHost,
          upstreamPort: listener.upstreamPort,
        })),
      });
    } catch (error) {
      sendJson(response, error.status ?? 500, {
        ok: false,
        error: error?.message ?? String(error),
      });
    }
  });

  server.on('error', (error) => log(`HTTP 服务错误：${error?.message ?? error}`));

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
    server.listen(service.port ?? 19091, service.host ?? '127.0.0.1');
  });

  const port = server.address().port;

  try {
    if (Array.isArray(initialUpstreams) && initialUpstreams.length > 0) {
      await replace(initialUpstreams);
    }
  } catch (error) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  return {
    port,
    async replace(upstreams) {
      return replace(upstreams);
    },
    async close() {
      if (currentHandle) {
        await currentHandle.close();
        currentHandle = null;
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
