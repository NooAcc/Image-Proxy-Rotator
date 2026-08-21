/**
 * 请求观测日志。
 *
 * 只观测、只记录 —— **绝不**根据这里的失败去禁用节点（决策 D8）。
 * 图片 404、站点 5xx、用户断网都会落到这里，据此禁用节点会把好节点全禁掉。
 * 自动禁用的唯一依据是 health-monitor 的探测结果。
 *
 * `details.ip` 是这次连接的对端 IP —— 走代理时它就是代理的出口地址。
 * 这是「分流真的生效了」最硬的证据，所以一定要记进日志给用户看。
 */

import { matchUrl } from '../lib/rule-matcher.js';
import { getConfig, getLogger, bumpNodeStat, saveRuntime, updateConfig } from './state.js';
import { PROBE_PARAM } from '../lib/constants.js';

/** requestId -> {url, startedAt}，用于算耗时 */
const pending = new Map();
const PENDING_CAP = 500;

function shorten(url, max = 90) {
  const text = String(url);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 从探测 URL 里取回节点 id，用于把请求归因到具体节点 */
function probeNodeId(url) {
  const key = `${PROBE_PARAM}=`;
  const at = url.indexOf(key);
  if (at < 0) return null;
  const rest = url.slice(at + key.length);
  const amp = rest.indexOf('&');
  return amp < 0 ? rest : rest.slice(0, amp);
}

export function installRequestLogger() {
  if (!chrome.webRequest) return false;
  const filter = { urls: ['<all_urls>'] };

  chrome.webRequest.onBeforeRequest.addListener((details) => {
    // 防止长时间运行后 Map 无限增长（有些请求既不 complete 也不 error）
    if (pending.size > PENDING_CAP) pending.clear();
    pending.set(details.requestId, { url: details.url, startedAt: Date.now() });
  }, filter);

  chrome.webRequest.onCompleted.addListener(async (details) => {
    const record = pending.get(details.requestId);
    pending.delete(details.requestId);
    try {
      const config = await getConfig();
      if (!config.enabled) return;

      const nodeId = probeNodeId(details.url);
      // 探测请求由 health-monitor 自己记日志，这里只补充出口 IP
      if (nodeId) {
        if (details.ip) await noteEgressIp(nodeId, details.ip);
        return;
      }

      const rule = matchUrl(details.url, config.rules);
      if (!rule) return; // 只记录走了代理的请求

      const log = await getLogger();
      const ok = details.statusCode < 400;
      const attributed = details.ip ? findNodeByIp(config.nodes, details.ip) : null;
      if (attributed) bumpNodeStat(attributed.id, ok);

      log.add({
        level: ok ? 'info' : 'warn',
        kind: 'request',
        ok,
        url: details.url,
        nodeId: attributed?.id ?? null,
        latencyMs: record ? Date.now() - record.startedAt : null,
        message: `${details.statusCode} ${shorten(details.url)}`
          + (details.ip ? `（出口 ${details.ip}${attributed ? ` → ${attributed.name}` : ''}）` : ''),
      });
      await saveRuntime();
    } catch {
      // 日志本身不能把请求流程搞崩
    }
  }, filter);

  chrome.webRequest.onErrorOccurred.addListener(async (details) => {
    pending.delete(details.requestId);
    try {
      const config = await getConfig();
      if (!config.enabled) return;
      if (probeNodeId(details.url)) return; // 探测失败由 health-monitor 记
      if (!matchUrl(details.url, config.rules)) return;

      const log = await getLogger();
      log.add({
        level: 'error',
        kind: 'request',
        ok: false,
        url: details.url,
        message: `请求失败：${details.error} ${shorten(details.url)}`,
      });
      await saveRuntime();
    } catch {
      // 同上
    }
  }, filter);

  return true;
}

/** 把探测请求观测到的出口 IP 记到节点上，作为「这个节点真的在转发」的证据 */
async function noteEgressIp(nodeId, ip) {
  await updateConfig((config) => {
    const node = config.nodes.find((n) => n.id === nodeId);
    if (node) node.health = { ...node.health, egressIp: ip };
    return config;
  });
}

/** 按已知的出口 IP 反查节点，用于给线上请求归因 */
function findNodeByIp(nodes, ip) {
  return nodes.find((n) => n.health?.egressIp === ip || n.host === ip) ?? null;
}
