/**
 * 请求观测日志。
 *
 * 只观测、只记录 —— **绝不**根据这里的失败去禁用节点（决策 D8）。
 * 图片 404、站点 5xx、用户断网都会落到这里，据此禁用节点会把好节点全禁掉。
 * 自动禁用的唯一依据是 health-monitor 的探测结果。
 *
 * `details.ip` 是这次连接的对端 IP。走代理时它是**代理服务器**的地址（浏览器的 socket
 * 连的就是代理），所以它既能证明「这个请求真的走了代理」，也能用来反查是哪个节点。
 *
 * **两种匹配的分工（决策 D16）**：
 *   · `matchPacUrl()` —— 按浏览器实际递给 PAC 的 URL 判定，即「会不会真的走代理」
 *   · `matchUrl()`    —— 按完整 URL 判定，即「用户以为会走代理」
 * 前者不命中、后者命中的请求记为 `blind`：规则写成了 PAC 判定不了的形态，这次请求
 * 必然是直连。把这两者混为一谈就是 1.2.0 那份统计的病根 —— 它报告 277 次「走代理的
 * 请求」，而代理服务商后台一条连接都没有。
 *
 * 归因说明：按对端 IP 反查节点**会漏**（IP 未知、多个节点共用地址）。漏掉的请求记进
 * metrics 的 unattributed，而不是丢弃、也不硬塞给某个节点 —— 「有 12 次没归因上」是
 * 有用的信息，一个凑整的假数字不是。
 */

import { matchUrl, matchPacUrl } from '../lib/rule-matcher.js';
import { pacUrl } from '../lib/pac-url.js';
import { getConfig, getLogger, queueRuntimeSave, updateConfig } from './state.js';
import { noteRequestMetric } from './metrics-store.js';
import { PROBE_PARAM } from '../lib/constants.js';

/** requestId -> {url, startedAt}，用于算耗时 */
const pending = new Map();
const PENDING_CAP = 500;

/**
 * 已经就「这条规则对 HTTPS 不生效」告警过的规则 id。
 * 一个漫画页能打出几百个请求，同一条规则不该在日志里刷几百遍同样的话。
 */
const blindWarned = new Set();

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

/**
 * 判定一次请求该怎么记：真的走代理、还是命中了规则但注定直连。
 * @returns {{rule: object, blind: boolean}|null} null = 与任何规则都无关，不计入统计
 */
function classify(url, rules) {
  const routed = matchPacUrl(url, rules);
  if (routed) return { rule: routed, blind: false };
  const intended = matchUrl(url, rules);
  return intended ? { rule: intended, blind: true } : null;
}

/** 规则写成了 PAC 判定不了的形态时，在日志里说清楚 —— 每条规则只说一次 */
async function warnBlindOnce(rule, url) {
  if (blindWarned.has(rule.id)) return;
  blindWarned.add(rule.id);
  const log = await getLogger();
  log.add({
    level: 'warn',
    kind: 'config',
    message: `规则「${rule.name}」命中了 ${shorten(url, 60)}，但这次请求实际走的是直连：`
      + `HTTPS 请求交给分流脚本时只剩 ${pacUrl(url)}（浏览器会剥掉路径与查询串），`
      + '这条规则判定不了。请改用「域名」类型，或把规则收敛到只约束域名。',
  });
}

/**
 * 按对端 IP 归因到节点。
 *
 * **一个节点一个 IP 是不成立的假设。** 常见形态是一台代理机开几十个端口，
 * 每个端口一个上游出口 —— 于是几十个节点的 host 完全相同，只有端口不同。而
 * `webRequest` 只给出对端 **IP**，没有对端端口，所以这种配置下「是哪个节点」
 * 这个问题根本无法回答。
 *
 * 旧实现用 `nodes.find(n => n.host === ip)` 取第一个匹配，结果把全部用量记到了
 * 列表里第一个节点上：面板显示「1 个节点 100%、其余 18 个 0%」，看起来像轮询坏了，
 * 其实是归因在编数字。**分不出来就说分不出来。**
 *
 * @returns {{node: ?object, shared: number, viaNodeIp: boolean}}
 *   node 为 null 且 shared > 1 表示「确实经过了你的代理，但分不出是哪个」
 */
function attribute(nodes, ip) {
  if (!ip) return { node: null, shared: 0, viaNodeIp: false };
  const matches = nodes.filter((n) => n.host === ip || n.health?.egressIp === ip);
  if (matches.length === 0) return { node: null, shared: 0, viaNodeIp: false };
  if (matches.length === 1) return { node: matches[0], shared: 1, viaNodeIp: true };
  return { node: null, shared: matches.length, viaNodeIp: true };
}

/** 归因结果的中文说明，直接进日志 */
function describeAttribution(ip, { node, shared }) {
  if (!ip) return '';
  if (node) return `（对端 ${ip} → ${node.name}）`;
  if (shared > 1) return `（对端 ${ip}，有 ${shared} 个节点共用这个地址、只有端口不同，分不出是哪一个）`;
  return `（对端 ${ip}，不属于任何已知节点）`;
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
      // 探测请求由 health-monitor 自己记日志，这里只补充对端 IP
      if (nodeId) {
        if (details.ip) await noteEgressIp(nodeId, details.ip);
        return;
      }

      const verdict = classify(details.url, config.rules);
      if (!verdict) return; // 与任何规则都无关，本就该直连
      const { rule, blind } = verdict;

      const log = await getLogger();
      const ok = details.statusCode < 400;
      const attributed = blind ? { node: null, shared: 0, viaNodeIp: false } : attribute(config.nodes, details.ip);
      const latencyMs = record ? Date.now() - record.startedAt : null;

      await noteRequestMetric({
        ok,
        latencyMs,
        nodeId: attributed.node?.id ?? null,
        viaNodeIp: attributed.viaNodeIp,
        ruleId: rule.id,
        blind,
        at: Date.now(),
      });

      if (blind) await warnBlindOnce(rule, details.url);

      log.add({
        level: blind ? 'warn' : (ok ? 'info' : 'warn'),
        kind: 'request',
        ok,
        url: details.url,
        nodeId: attributed.node?.id ?? null,
        latencyMs,
        message: `${details.statusCode} ${shorten(details.url)}`
          + (blind ? '（规则命中但 HTTPS 下判定不了，实际直连）' : describeAttribution(details.ip, attributed)),
      });
      // 热路径：一个漫画页能打出几百个请求，落盘必须走节流
      queueRuntimeSave();
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
      const verdict = classify(details.url, config.rules);
      if (!verdict) return;

      // 连接层面就失败了，没有对端 IP 可归因，但它确实是一次「本该走代理」的请求，
      // 不计入总量会让成功率虚高
      await noteRequestMetric({
        ok: false,
        nodeId: null,
        ruleId: verdict.rule.id,
        blind: verdict.blind,
        at: Date.now(),
      });

      const log = await getLogger();
      log.add({
        level: 'error',
        kind: 'request',
        ok: false,
        url: details.url,
        message: `请求失败：${details.error} ${shorten(details.url)}`,
      });
      queueRuntimeSave();
    } catch {
      // 同上
    }
  }, filter);

  return true;
}

/** 把探测请求观测到的对端 IP 记到节点上，作为「这个节点真的在转发」的证据 */
async function noteEgressIp(nodeId, ip) {
  await updateConfig((config) => {
    const node = config.nodes.find((n) => n.id === nodeId);
    if (node) node.health = { ...node.health, egressIp: ip };
    return config;
  });
}


