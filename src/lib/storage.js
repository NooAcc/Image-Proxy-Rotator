/**
 * 配置持久化：读写、版本迁移、导入导出。
 *
 * `createStore` 接收一个注入的 StorageArea（生产环境传 chrome.storage.local，
 * 测试传桩对象），因此本文件同样不引用 `chrome.*`。
 */

import { CONFIG_KEY, CONFIG_VERSION } from './constants.js';
import { normalizeConfig, normalizeNode } from './schema.js';

export { normalizeConfig };

/**
 * 版本迁移钩子。
 * 目前只有 v1，因此原样返回；未来新增版本时在这里逐级升级。
 * 遇到比当前更新的版本号也不报错 —— 由 normalizeConfig 尽力读取已知字段。
 */
export function migrateConfig(raw) {
  if (raw == null) return {};
  return raw;
}

/**
 * 创建配置仓库。
 * @param {{get:Function, set:Function, remove:Function}} area 注入的 StorageArea
 */
export function createStore(area) {
  return {
    /** 读取并规范化配置；存储为空时返回默认配置 */
    async load() {
      let stored;
      try {
        const got = await area.get(CONFIG_KEY);
        stored = got?.[CONFIG_KEY];
      } catch {
        stored = undefined;
      }
      return normalizeConfig(migrateConfig(stored));
    },

    /** 规范化后写入；返回写入的那份配置 */
    async save(config) {
      const normalized = normalizeConfig(config);
      await area.set({ [CONFIG_KEY]: normalized });
      return normalized;
    },

    /** 读-改-写。fn 可以就地修改并返回配置，也可以返回一份新配置 */
    async update(fn) {
      const current = await this.load();
      const next = (await fn(current)) || current;
      return this.save(next);
    },

    /** 清空配置，回到默认值 */
    async reset() {
      await area.remove(CONFIG_KEY);
      return this.load();
    },
  };
}

/** 节点去重键：同协议 + 同地址 + 同端口视为同一个节点 */
function nodeKey(node) {
  return `${node.protocol}|${node.host}|${node.port}`;
}

/** 规则去重键 */
function ruleKey(rule) {
  return `${rule.type}|${rule.pattern}`;
}

/**
 * 导出为 JSON 文本。
 * 保留账号密码（这是用户自己的备份），但清掉只在本次运行有意义的瞬时字段。
 */
export function exportConfig(config) {
  const normalized = normalizeConfig(config);
  const payload = {
    version: CONFIG_VERSION,
    exportedFrom: 'image-proxy-rotator',
    enabled: normalized.enabled,
    settings: normalized.settings,
    nodes: normalized.nodes.map((n) => ({
      ...n,
      health: { ...n.health, egressIp: null, lastError: null },
    })),
    rules: normalized.rules,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 从 JSON 文本导入配置。
 * @param {string} text
 * @param {object} current 当前配置（merge 模式下作为基底）
 * @param {{merge?: boolean}} options merge=true 时只追加节点与规则，保留现有设置
 * @returns {object} 规范化后的新配置
 * @throws {Error} JSON 非法时抛出带中文说明的错误
 */
export function importConfig(text, current, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`配置解析失败：${e.message}`);
  }

  const incoming = normalizeConfig(parsed);
  if (!options.merge) return incoming;

  const base = normalizeConfig(current);
  const seenNodes = new Set(base.nodes.map(nodeKey));
  const seenRules = new Set(base.rules.map(ruleKey));

  for (const node of incoming.nodes) {
    const key = nodeKey(node);
    if (seenNodes.has(key)) continue;
    seenNodes.add(key);
    base.nodes.push(node);
  }
  for (const rule of incoming.rules) {
    const key = ruleKey(rule);
    if (seenRules.has(key)) continue;
    seenRules.add(key);
    base.rules.push(rule);
  }
  return normalizeConfig(base);
}

/** 追加节点并按 protocol|host|port 去重；返回 {config, added} */
export function appendNodes(config, rawNodes) {
  const base = normalizeConfig(config);
  const seen = new Set(base.nodes.map(nodeKey));
  let added = 0;
  for (const raw of rawNodes) {
    const node = normalizeNode(raw);
    if (!node) continue;
    const key = nodeKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    base.nodes.push(node);
    added++;
  }
  return { config: base, added };
}
