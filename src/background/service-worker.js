/**
 * Service Worker 入口。
 *
 * MV3 的 SW 随时会被回收再唤醒，所以这里只做两件事：
 *   1. 注册事件监听（必须在顶层同步注册，否则唤醒时会漏事件）
 *   2. 每次唤醒都跑一次 boot()，把配置读回来并重新注入 PAC
 */

import { getConfig, getLogger, saveRuntime } from './state.js';
import { applyProxy } from './proxy-controller.js';
import { handleMessage } from './messaging.js';
import { onAlarm, scheduleProbeAlarm } from './health-monitor.js';
import { installRequestLogger } from './request-logger.js';
import { installAuthProvider } from './auth-provider.js';
import { unsupportedNodes, protocolLabel } from '../lib/node-model.js';
import { ALARM_PROBE, UNSUPPORTED_PROTOCOL_MESSAGE } from '../lib/constants.js';

// ---- 事件注册（顶层同步）----

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // 保持消息通道打开，以支持异步响应
});

chrome.runtime.onInstalled.addListener((details) => {
  boot(details.reason === 'update' ? '扩展更新' : '扩展安装');
});

chrome.runtime.onStartup.addListener(() => {
  boot('浏览器启动');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PROBE) {
    onAlarm().catch(() => {
      /* 定时任务失败不应让 SW 崩溃，错误已写入日志 */
    });
  }
});

installRequestLogger();
installAuthProvider();

// ---- 启动流程 ----

let booting = null;

function boot(reason) {
  // 多个事件可能同时触发 boot，串行化避免重复注入 PAC
  booting = (booting ?? Promise.resolve())
    .then(() => runBoot(reason))
    .catch(() => {});
  return booting;
}

async function runBoot(reason) {
  const log = await getLogger();
  try {
    const config = await getConfig();
    await applyProxy();
    await scheduleProbeAlarm();
    log.add({
      level: 'info',
      kind: 'system',
      message: `后台已启动（${reason}）：${config.nodes.length} 个节点 / ${config.rules.length} 条规则，总开关${config.enabled ? '开启' : '关闭'}`,
    });

    // 历史配置里可能残留非 HTTP/HTTPS 节点。它们已经进不了 PAC 池了，
    // 但必须显式提示，避免用户以为它们还在分流。
    const unsupported = unsupportedNodes(config.nodes);
    if (unsupported.length > 0) {
      const kinds = [...new Set(unsupported.map((n) => protocolLabel(n.protocol)))].join(' / ');
      log.add({
        level: 'warn',
        kind: 'config',
        message: `检测到 ${unsupported.length} 个不支持的节点（${kinds}），已停用且不参与分流。${UNSUPPORTED_PROTOCOL_MESSAGE}，请在设置页清除它们。`,
      });
    }
  } catch (e) {
    log.add({ level: 'error', kind: 'system', message: `后台启动失败（${reason}）：${e?.message || e}` });
  }
  await saveRuntime();
}

// SW 被唤醒（包括冷启动）时也要跑一遍
boot('后台唤醒');
