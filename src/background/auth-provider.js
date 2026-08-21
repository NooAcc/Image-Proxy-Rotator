/**
 * 代理认证自动应答。
 *
 * PAC 脚本里写不了账号密码（`PROXY user:pass@host:port` 不是合法 PAC 语法），
 * 所以带 Basic/Digest 认证的 HTTP/HTTPS 代理必须靠 webRequest.onAuthRequired 补上，
 * 否则用户每开一张图都会被弹一次认证框。
 *
 * 需要 `webRequest` + `webRequestAuthProvider` 两个权限。
 *
 * 只对 HTTP/HTTPS 代理节点应答 —— 本程序不支持其他代理类型，那些节点也不会被 PAC
 * 选中，因此永远不会走到这里。
 */

import { getConfig, getLogger } from './state.js';
import { isSupported, protocolLabel } from '../lib/node-model.js';

/** 已尝试过的 requestId：凭据错误时避免无限重试 */
const tried = new Set();
const TRIED_CAP = 200;

export function installAuthProvider() {
  if (!chrome.webRequest?.onAuthRequired) return false;

  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      // 只管代理认证，站点自身的 401 交给浏览器正常弹框
      if (!details.isProxy) {
        callback({});
        return;
      }
      if (tried.has(details.requestId)) {
        // 同一请求第二次要求认证 = 凭据不对，别再送了，让浏览器弹框
        callback({});
        return;
      }
      if (tried.size > TRIED_CAP) tried.clear();
      tried.add(details.requestId);

      resolveCredentials(details)
        .then(callback)
        .catch(() => callback({}));
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking'],
  );

  return true;
}

async function resolveCredentials(details) {
  const config = await getConfig();
  const log = await getLogger();
  const host = details.challenger?.host;
  const port = Number(details.challenger?.port);

  const node = config.nodes.find(
    (n) => isSupported(n) && n.host === host && Number(n.port) === port && n.username,
  );

  if (!node) {
    // 如果地址对得上但协议不受支持，要说清楚原因，而不是让用户以为是密码错了
    const mismatched = config.nodes.find((n) => n.host === host && Number(n.port) === port);
    log.add({
      level: 'warn',
      kind: 'proxy',
      message: mismatched && !isSupported(mismatched)
        ? `代理 ${host}:${port} 要求认证，但该节点是 ${protocolLabel(mismatched.protocol)} 类型，本程序仅支持 HTTP/HTTPS 代理`
        : `代理 ${host}:${port} 要求认证，但节点列表里没有匹配的账号密码，该请求可能失败`,
    });
    return {};
  }

  log.add({
    level: 'info',
    kind: 'proxy',
    nodeId: node.id,
    message: `已为节点「${node.name}」自动提供代理凭据`,
  });
  return { authCredentials: { username: node.username, password: node.password } };
}
