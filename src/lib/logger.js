/**
 * 环形日志缓冲。
 *
 * 状态页要能回答「刚才那张图走了哪个节点、成功了吗、为什么失败」，
 * 所以日志是功能的一部分，不是调试残留。
 *
 * `now` 可注入，便于单测；生产环境传 () => Date.now()。
 *
 * @typedef {Object} LogEntry
 * @property {string} id
 * @property {number} at
 * @property {'info'|'warn'|'error'} level
 * @property {string} kind 'probe'|'request'|'proxy'|'config'|'system'
 * @property {string} message
 * @property {?string} nodeId
 * @property {?string} url
 * @property {?number} latencyMs
 * @property {?boolean} ok
 */

const DEFAULT_LIMIT = 200;
const LEVELS = ['info', 'warn', 'error'];

function normalizeLimit(limit) {
  const n = Number.parseInt(limit, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
}

/**
 * @param {{limit?: number, now?: () => number}} options
 */
export function createLogger(options = {}) {
  let limit = normalizeLimit(options.limit);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** @type {LogEntry[]} 尾部是最新 */
  let entries = [];
  let seq = 0;

  function trim() {
    if (entries.length > limit) entries = entries.slice(entries.length - limit);
  }

  return {
    /** 追加一条日志；缺失字段会被补齐 */
    add(entry = {}) {
      seq++;
      const record = {
        id: `l${now()}-${seq}`,
        at: now(),
        level: LEVELS.includes(entry.level) ? entry.level : 'info',
        kind: entry.kind ? String(entry.kind) : 'system',
        message: entry.message == null ? '' : String(entry.message),
        nodeId: entry.nodeId == null ? null : String(entry.nodeId),
        url: entry.url == null ? null : String(entry.url),
        latencyMs: Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : null,
        ok: typeof entry.ok === 'boolean' ? entry.ok : null,
      };
      entries.push(record);
      trim();
      return record;
    },

    /**
     * 读取日志，最新在前。
     * @param {{kind?: string, level?: string, limit?: number}} filter
     * @returns {LogEntry[]} 浅拷贝，外部改动不会污染内部状态
     */
    list(filter = {}) {
      let out = entries;
      if (filter.kind) out = out.filter((r) => r.kind === filter.kind);
      if (filter.level) out = out.filter((r) => r.level === filter.level);
      out = out.slice().reverse();
      if (Number.isInteger(filter.limit) && filter.limit > 0) out = out.slice(0, filter.limit);
      return out.map((r) => ({ ...r }));
    },

    clear() {
      entries = [];
    },

    size() {
      return entries.length;
    },

    /** 调整上限；收紧时立即裁剪，保留最新的 */
    setLimit(next) {
      limit = normalizeLimit(next);
      trim();
    },

    /** 从持久化数组恢复（用于 Service Worker 被唤醒后接上之前的日志） */
    restore(rows) {
      if (!Array.isArray(rows)) return;
      // 传入的是「最新在前」的顺序，内部按「最新在尾」存放
      entries = rows
        .slice()
        .reverse()
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          id: String(r.id ?? ''),
          at: Number.isFinite(r.at) ? r.at : 0,
          level: LEVELS.includes(r.level) ? r.level : 'info',
          kind: r.kind ? String(r.kind) : 'system',
          message: r.message == null ? '' : String(r.message),
          nodeId: r.nodeId == null ? null : String(r.nodeId),
          url: r.url == null ? null : String(r.url),
          latencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : null,
          ok: typeof r.ok === 'boolean' ? r.ok : null,
        }));
      trim();
    },
  };
}
