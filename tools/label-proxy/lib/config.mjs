/**
 * 本地标签代理的配置解析（纯函数）。
 *
 * 把「同一 IP 的不同端口」映射成一组不同的本地回环地址，使浏览器看到的
 * 对端 IP 各自唯一，扩展现有归因逻辑即可区分节点。
 *
 * 本文件不碰网络，只负责校验和产出运行所需的 plan。
 */

const DEFAULT_BASE_ADDRESS = '127.0.0.2';
const DEFAULT_LOCAL_PORT = 8080;
const LOOPBACK_MIN = 0x7f000000; // 127.0.0.0
const LOOPBACK_MAX = 0x7fffffff; // 127.255.255.255

function parseIpv4(value) {
  const parts = String(value).split('.').map((p) => Number(p));
  if (
    parts.length !== 4
    || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return null;
  }
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function formatIpv4(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

function assertPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}必须是 1-65535 的整数`);
  }
  return port;
}

/**
 * 把用户配置规范化为运行计划。
 * @param {object} raw 配置 JSON 的内容
 * @returns {{listeners: object[], importLines: string[]}}
 */
export function buildPlan(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const local = config.local && typeof config.local === 'object' ? config.local : {};
  const upstreams = Array.isArray(config.upstreams) ? config.upstreams : [];

  if (upstreams.length === 0) {
    throw new Error('至少需要 1 个上游代理');
  }

  const localPort = assertPort(
    local.port ?? DEFAULT_LOCAL_PORT,
    'local.port',
  );

  let next = parseIpv4(local.baseAddress ?? DEFAULT_BASE_ADDRESS);
  if (next === null) {
    throw new Error('local.baseAddress 必须是合法 IPv4 地址');
  }
  if (next < LOOPBACK_MIN || next > LOOPBACK_MAX) {
    throw new Error('local.baseAddress 必须在 127.0.0.0/8 回环网段内');
  }
  if (next <= 0x7f000001) {
    throw new Error('local.baseAddress 不能从 127.0.0.1 或更小的地址开始');
  }

  const listeners = [];
  const importLines = [];

  for (const upstream of upstreams) {
    const name = String(upstream?.name ?? '').trim();
    const host = String(upstream?.host ?? '').trim();
    if (!host) {
      throw new Error(`上游${name ? ` ${name}` : ''}的 host 不能为空`);
    }

    const label = name || `${host}:${upstream?.port}`;
    const upstreamPort = assertPort(upstream?.port, `上游 ${label} 的端口`);
    const localAddress = formatIpv4(next);
    next += 1;
    if (next > LOOPBACK_MAX) {
      throw new Error('本地回环地址已用尽，请减少上游数量');
    }

    listeners.push({
      localAddress,
      localPort,
      upstreamHost: host,
      upstreamPort,
      name: label,
    });
    importLines.push(`http://${localAddress}:${localPort}#${label}`);
  }

  return { listeners, importLines };
}
