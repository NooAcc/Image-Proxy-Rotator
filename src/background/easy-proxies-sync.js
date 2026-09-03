/**
 * Easy Proxies 自动拉取的后台编排。
 *
 * 只做编排，不做判断：选优与合并都在 lib/easy-proxies.js（纯逻辑层）。
 * 这里的职责是：
 *   1. 按配置认证并拉取 /api/nodes
 *   2. 把选出的最优节点写进 config（只替换自动管理的节点）
 *   3. 重新注入 PAC，让新节点立刻进入轮询
 *   4. 按设置维护定时任务（chrome.alarms）
 *
 * 任何一步失败都不静默：lastSyncError 会写回配置，设置页能直接看到原因。
 */

import { ALARM_EASY_PROXIES } from '../lib/constants.js';
import {
  selectBestNodes,
  toProxyNodes,
  toLabelProxyNodes,
  mergeEasyProxiesNodes,
} from '../lib/easy-proxies.js';
import { getConfig, updateConfig, getLogger } from './state.js';
import { applyProxy } from './proxy-controller.js';

/** 防止定时与手动两路同步撞在一起（重复拉取、重复合并） */
let syncInFlight = false;

/** 去掉末尾斜杠，避免拼出 `//api/...` 的双斜杠路径 */
function cleanBaseUrl(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

/**
 * 调本地标签服务的 /api/convert。
 * @param {{url:string, token:string, selected:object[], host:string}} options
 * @param {typeof fetch} [fetchImpl] 测试注入点
 * @returns {Promise<object[]>} 服务返回的 nodes
 */
export async function convertViaLabelService({ url, token, selected, host }, fetchImpl = globalThis.fetch) {
  const base = cleanBaseUrl(url);
  const upstreams = (Array.isArray(selected) ? selected : []).map((entry) => ({
    name: String(entry?.name ?? '').trim(),
    host: String(host ?? '').trim(),
    port: entry?.port,
  }));
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetchImpl(`${base}/api/convert`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ upstreams }),
    });
  } catch (e) {
    throw new Error(`无法连接本地标签服务（${base}）：${e?.message || e}`);
  }

  let body = null;
  try { body = await response.json(); } catch { /* 非 JSON 响应体 */ }
  if (!response.ok) {
    const detail = body?.error ? `：${body.error}` : `（HTTP ${response.status}）`;
    throw new Error(`本地标签服务转换失败${detail}`);
  }
  if (!body || !Array.isArray(body.nodes)) {
    throw new Error('本地标签服务返回格式异常：缺少 nodes 列表');
  }
  return body.nodes;
}

/** 把 HTTP 错误与响应体里的中文 error 拼成可读消息 */
function describeHttpError(res, body) {
  const detail = body && typeof body.error === 'string' && body.error ? `：${body.error}` : '';
  return `easy_proxies 请求失败（HTTP ${res.status}）${detail}`;
}

/**
 * 认证（如配置了密码）并拉取 /api/nodes。
 * @param {{baseUrl:string, password:string}} options
 * @param {typeof fetch} [fetchImpl] 测试注入点
 * @returns {Promise<{nodes: object[]}>}
 */
export async function fetchEasyProxiesNodes({ baseUrl, password }, fetchImpl = globalThis.fetch) {
  const base = cleanBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('easy_proxies 管理地址无效，必须以 http:// 或 https:// 开头');
  }

  const headers = { Accept: 'application/json' };

  if (password) {
    let authRes;
    try {
      authRes = await fetchImpl(`${base}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch (e) {
      throw new Error(`无法连接 easy_proxies 管理地址（${base}）：${e?.message || e}`);
    }
    let authBody = null;
    try { authBody = await authRes.json(); } catch { /* 非 JSON 响应体 */ }
    if (!authRes.ok) throw new Error(describeHttpError(authRes, authBody));
    const token = authBody?.token;
    if (!token) throw new Error('easy_proxies 登录成功但未返回 token');
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetchImpl(`${base}/api/nodes`, { headers });
  } catch (e) {
    throw new Error(`无法连接 easy_proxies 管理地址（${base}）：${e?.message || e}`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 响应体 */ }
  if (!res.ok) throw new Error(describeHttpError(res, body));
  if (!body || !Array.isArray(body.nodes)) {
    throw new Error('easy_proxies 返回格式异常：缺少 nodes 列表');
  }
  return body;
}

/**
 * 执行一次同步（不检查开关、不检查并发——调用方负责）。
 * 失败时把原因写进 settings.easyProxies.lastSyncError，然后重新抛出。
 * @returns {Promise<{ok:true, added:number, removed:number, total:number, host:string, config:object}>}
 */
export async function runEasyProxiesSync() {
  const config = await getConfig();
  const ep = config.settings.easyProxies;
  const log = await getLogger();

  try {
    const url = new URL(cleanBaseUrl(ep.baseUrl));
    const host = url.hostname;
    if (!host) throw new Error('easy_proxies 管理地址缺少主机名');

    const payload = await fetchEasyProxiesNodes({ baseUrl: ep.baseUrl, password: ep.password });
    const selected = selectBestNodes(payload, ep.maxNodes);
    let incoming;
    if (ep.labelServiceUrl) {
      const converted = await convertViaLabelService({
        url: ep.labelServiceUrl,
        token: ep.labelServiceToken,
        selected,
        host,
      });
      incoming = toLabelProxyNodes(converted);
    } else {
      incoming = toProxyNodes(selected, host);
    }

    let added = 0;
    let removed = 0;
    await updateConfig((cfg) => {
      const merged = mergeEasyProxiesNodes(cfg.nodes, incoming);
      added = merged.added;
      removed = merged.removed;
      cfg.nodes = merged.nodes;
      cfg.settings.easyProxies = {
        ...cfg.settings.easyProxies,
        lastSyncAt: Date.now(),
        lastSyncCount: merged.added,
        lastSyncError: null,
      };
      return cfg;
    });

    await applyProxy();
    log.add({
      level: 'info',
      kind: 'config',
      message: `Easy Proxies 同步完成：可用 ${incoming.length} 条，新增 ${added} 条，移除旧自动节点 ${removed} 条`,
    });
    return { ok: true, added, removed, total: incoming.length, host, config: await getConfig() };
  } catch (e) {
    const message = String(e?.message || e);
    await updateConfig((cfg) => {
      cfg.settings.easyProxies = { ...cfg.settings.easyProxies, lastSyncError: message };
      return cfg;
    });
    log.add({ level: 'error', kind: 'config', message: `Easy Proxies 同步失败：${message}` });
    throw e;
  }
}

/**
 * 并发安全地触发一次同步（手动按钮 / 定时 / 启动共用）。
 * @returns {Promise<object>} 与 runEasyProxiesSync 相同；忙时返回 ok:false
 */
export async function syncNow() {
  if (syncInFlight) return { ok: false, error: 'Easy Proxies 同步正在进行中，请稍候' };
  syncInFlight = true;
  try {
    return await runEasyProxiesSync();
  } finally {
    syncInFlight = false;
  }
}

/** 按配置重建定时同步任务。chrome.alarms 最小周期 1 分钟 */
export async function scheduleEasyProxiesAlarm() {
  const config = await getConfig();
  try {
    await chrome.alarms.clear(ALARM_EASY_PROXIES);
  } catch {
    // 没有已存在的 alarm 时属正常
  }
  const ep = config.settings.easyProxies;
  if (!ep.enabled || !(ep.intervalMinutes > 0)) return false;
  const period = Math.max(1, ep.intervalMinutes);
  await chrome.alarms.create(ALARM_EASY_PROXIES, { delayInMinutes: period, periodInMinutes: period });
  return true;
}

/** 定时触发入口（只在开关启用时执行） */
export async function onEasyProxiesAlarm() {
  const config = await getConfig();
  if (!config.settings.easyProxies.enabled) return;
  try {
    await syncNow();
  } catch {
    // runEasyProxiesSync 已写日志与 lastSyncError
  }
}

/** 扩展启动时同步一次（只在开关启用时执行） */
export async function syncIfEnabled() {
  const config = await getConfig();
  if (!config.settings.easyProxies.enabled) return false;
  try {
    await syncNow();
    return true;
  } catch {
    return false;
  }
}
