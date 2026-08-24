/**
 * 代理认证自动应答。
 *
 * PAC 脚本里写不了账号密码（`PROXY user:pass@host:port` 不是合法 PAC 语法），
 * 所以带 Basic/Digest 认证的 HTTP/HTTPS 代理必须靠 webRequest.onAuthRequired 补上，
 * 否则用户每开一张图都会被弹一次认证框。
 *
 * 需要 `webRequest` + `webRequestAuthProvider` 两个权限。
 *
 * 只对 HTTP/HTTPS 代理节点、兜底代理与默认代理应答 —— 本程序不支持其他代理类型，
 * 那些节点也不会被 PAC 选中，因此永远不会走到这里。
 */

import { getConfig, getLogger } from './state.js';
import { isSupported, protocolLabel } from '../lib/node-model.js';
import { fallbackProxyToken } from '../lib/fallback-proxy.js';
import { defaultProxyToken } from '../lib/default-proxy.js';

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

  if (node) {
    log.add({
      level: 'info',
      kind: 'proxy',
      nodeId: node.id,
      message: `已为节点「${node.name}」自动提供代理凭据`,
    });
    return { authCredentials: { username: node.username, password: node.password } };
  }

  // 兜底代理不在 nodes 里（它不测速、不自动禁用、不参与轮询），所以要单独认一次。
  // 漏掉这一段的表现是：轮询节点都失败之后切到兜底代理，然后每张图弹一次认证框
  const fallback = config.settings.fallbackProxy;
  if (fallbackProxyToken(fallback) && fallback.host === host && Number(fallback.port) === port && fallback.username) {
    log.add({
      level: 'info',
      kind: 'proxy',
      message: `已为兜底代理 ${host}:${port} 自动提供凭据`,
    });
    return { authCredentials: { username: fallback.username, password: fallback.password } };
  }

  // 默认代理同理，而且漏掉这一段更难受：它承担的是「规则之外的全部流量」，
  // 于是每开一个网站都弹一次认证框，看起来像整个浏览器坏了
  const dflt = config.settings.defaultProxy;
  if (defaultProxyToken(dflt) && dflt.host === host && Number(dflt.port) === port && dflt.username) {
    log.add({
      level: 'info',
      kind: 'proxy',
      message: `已为默认代理 ${host}:${port} 自动提供凭据`,
    });
    return { authCredentials: { username: dflt.username, password: dflt.password } };
  }

  // 如果地址对得上但协议不受支持，要说清楚原因，而不是让用户以为是密码错了
  const mismatched = config.nodes.find((n) => n.host === host && Number(n.port) === port);
  log.add({
    level: 'warn',
    kind: 'proxy',
    message: mismatched && !isSupported(mismatched)
      ? `代理 ${host}:${port} 要求认证，但该节点是 ${protocolLabel(mismatched.protocol)} 类型，本程序仅支持 HTTP/HTTPS 代理`
      : `代理 ${host}:${port} 要求认证，但节点列表、兜底代理与默认代理里都没有匹配的账号密码，该请求可能失败`,
  });
  return {};
}
