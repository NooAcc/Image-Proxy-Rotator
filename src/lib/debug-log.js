/**
 * 开发者调试日志 —— 环形缓冲 + 按命名空间导出（纯逻辑，零浏览器依赖）。
 *
 * **这不是 logger.js。** `lib/logger.js` 是给用户看的活动日志：中文整句、分级、200 条、
 * 弹窗里常驻。本模块是给开发者看的结构化现场：URL 原文、两次匹配各自的结论、归因中间量、
 * 重试判定的全部入参。两者刻意分开 —— 把几百个请求的调试细节灌进活动日志，用户就再也
 * 看不到「哪个节点在干活」了。
 *
 * 三条约束贯穿全文件：
 *   1. **默认关闭，关着的时候零开销。** `on` 是个活的布尔，调用点一律写
 *      `if (dbg.on) dbg(...)` —— 否则关着时那个对象字面量照样要构造，而热路径上
 *      一个漫画页有几百个请求。
 *   2. **记录时不拼字符串。** 格式化推迟到导出那一刻，记录只存结构。
 *   3. **关闭即清空。** 「开关是关的，但导出还有东西」是最容易被误读的状态 ——
 *      你会以为看到的是刚才那次复现，其实是上周的残留。
 *
 * @typedef {Object} DebugRow
 * @property {number} at
 * @property {string} ns   命名空间，取自 DEBUG_NS
 * @property {string} ev   短事件名（英文 kebab-case）
 * @property {object} data 结构化字段
 */

/**
 * 命名空间是**闭集合**。集合外的名字归到 misc 而不是新建一个 ——
 * 导出的文件名要落到用户磁盘上，不能是任意字符串。
 */
export const DEBUG_NS = [
  'pac', 'probe', 'request', 'retry', 'config', 'msg', 'content', 'ui', 'misc',
];

/** 默认条数上限。够覆盖「打开阅读器到读完一整话」而不丢头 */
export const DEBUG_LIMIT = 20000;

/**
 * 默认字节预算。session 区在 Chrome/Edge 112 起配额是 10 MB，这里占 4 MB，
 * 剩下的留给活动日志与 runtime。更老的浏览器上落盘会失败，缓冲退化为纯内存
 * （见 docs/LIMITATIONS.md）—— 只影响这一个诊断功能。
 */
export const DEBUG_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * 单个字符串值的字符上限。**与预算无关，必须保留** ——
 * 防的是 `data:image/png;base64,…` 这类病态值，一条能有几 MB。
 */
export const VALUE_CAP = 2000;

/** pushRows 单批默认上限，防止页面侧一次灌爆缓冲 */
export const PUSH_ROWS_MAX = 64;

const NS_SET = new Set(DEBUG_NS);
/** 事件名列宽。对齐是为了肉眼扫一列，不是为了好看 */
const EV_COLUMN = 16;
const NS_COLUMN = 9;

// ---------------------------------------------------------------- 规范化

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeNs(ns) {
  return NS_SET.has(ns) ? ns : 'misc';
}

function normalizeEv(ev) {
  if (typeof ev !== 'string' || !ev) return 'unknown';
  return ev.length > 40 ? ev.slice(0, 40) : ev;
}

/** 截断病态长值，并标明省了多少 —— 悄悄截断会让人以为 URL 本来就长这样 */
function capValue(value) {
  if (typeof value !== 'string' || value.length <= VALUE_CAP) return value;
  return `${value.slice(0, VALUE_CAP)}…(+${value.length - VALUE_CAP})`;
}

function normalizeData(data) {
  if (!data || typeof data !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(data)) out[key] = capValue(value);
  return out;
}

/**
 * 记录的体积估算：JSON 序列化后的长度。
 * 这是 UTF-16 码元数而不是真实字节数 —— 记的东西绝大多数是 ASCII（URL、IP、id），
 * 差值不足以影响「什么时候该淘汰」这个判断，而每条都过一遍 TextEncoder 不划算。
 */
function weigh(record) {
  try {
    return JSON.stringify(record).length;
  } catch {
    return 64;
  }
}

// ---------------------------------------------------------------- 时间与文件名

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** HH:MM:SS.mmm —— 跨文件对齐时间线靠它 */
function stampTime(at) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function stampFull(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 导出文件名。ns 不走 normalizeNs —— 合并文件用的是 'all'，它不是命名空间 */
export function debugFileName(ns, at) {
  const d = new Date(at);
  const safe = String(ns).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'log';
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `ipr-debug-${safe}-${stamp}.log`;
}

// ---------------------------------------------------------------- 渲染

/**
 * 一个值渲染成 `k=v` 右边那半截。
 * 规则刻意简单，目的是能被 grep：null 写 `-`，带空格的字符串加引号，其余走 JSON。
 */
function renderValue(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value === '' || /[\s"]/.test(value) ? JSON.stringify(value) : value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function renderKv(data) {
  return Object.entries(data).map(([key, value]) => `${key}=${renderValue(value)}`).join(' ');
}

function renderLine(row, withNs) {
  const ns = withNs ? row.ns.padEnd(NS_COLUMN) : '';
  // padEnd 对超过列宽的名字不会补出空格，事件名会和第一个 k= 粘在一起
  // （真实日志里出现过 fallback-window-openedorigin=…）。超过列宽时显式补一个分隔。
  const ev = row.ev.length > EV_COLUMN ? `${row.ev} ` : row.ev.padEnd(EV_COLUMN);
  return `${stampTime(row.at)}  ${ns}${ev}${renderKv(row.data)}`.trimEnd();
}

/**
 * 文件头。**警告必须在这五行里** —— 藏到文件末尾的警告等于没有，
 * 而这份文件是要被贴到 issue 里的。
 */
function renderHeader({ label, version, at, shown, total, bytes }) {
  return [
    `# Image-Proxy-Rotator ${version} 调试日志`,
    `# namespace : ${label}`,
    `# exported  : ${stampFull(at)}`,
    `# entries   : ${shown} 条（缓冲共 ${total} 条 / ${(bytes / 1024).toFixed(1)} KB）`,
    '# 警告：本文件含你访问过的图片地址与代理服务器地址，贴到公开 issue 前请自行确认。',
    '',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- 缓冲

/**
 * @param {{limit?: number, byteBudget?: number, now?: () => number}} options
 */
export function createDebugLog(options = {}) {
  const limit = intOr(options.limit, DEBUG_LIMIT);
  const byteBudget = intOr(options.byteBudget, DEBUG_BYTE_BUDGET);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let enabled = false;
  /** @type {{row: DebugRow, w: number}[]} 正序，尾部最新 */
  let entries = [];
  let bytes = 0;

  /** 条数与字节双上限，先到先限。至少留一条 —— 清空比留一条大记录更难排查 */
  function trim() {
    while (entries.length > limit || (bytes > byteBudget && entries.length > 1)) {
      bytes -= entries[0].w;
      entries.shift();
    }
  }

  function add(row) {
    const w = weigh(row);
    entries.push({ row, w });
    bytes += w;
    trim();
  }

  function accept(raw, fallbackAt) {
    if (!raw || typeof raw !== 'object') return false;
    add({
      at: Number.isFinite(raw.at) ? raw.at : fallbackAt,
      ns: normalizeNs(raw.ns),
      ev: normalizeEv(raw.ev),
      data: normalizeData(raw.data),
    });
    return true;
  }

  function copy(row) {
    return { at: row.at, ns: row.ns, ev: row.ev, data: { ...row.data } };
  }

  function clear() {
    entries = [];
    bytes = 0;
  }

  return {
    /** 活的布尔。调用点靠它跳过整个 data 对象的构造 */
    get on() {
      return enabled;
    },

    /** 开 / 关。关闭时顺手清空 —— 见文件头第 3 条约束 */
    enable(value) {
      const next = value === true;
      if (!next) clear();
      enabled = next;
      return enabled;
    },

    /** 记一条。关着时立即返回，不做任何事 */
    push(ns, ev, data) {
      if (!enabled) return null;
      const row = { at: now(), ns: normalizeNs(ns), ev: normalizeEv(ev), data: normalizeData(data) };
      add(row);
      return row;
    },

    /**
     * 批量接入内容脚本 / UI 回传的行。
     * @returns {number} 实际收下的条数（超出 max 的直接丢，不排队）
     */
    pushRows(rows, opts = {}) {
      if (!enabled) return 0;
      const max = intOr(opts.max, PUSH_ROWS_MAX);
      const list = Array.isArray(rows) ? rows.slice(0, max) : [];
      const at = now();
      let taken = 0;
      for (const raw of list) if (accept(raw, at)) taken++;
      return taken;
    },

    /** 读取，正序（最旧在前）。返回副本 */
    list(ns) {
      const want = ns == null ? null : normalizeNs(ns);
      return entries
        .filter((e) => want === null || e.row.ns === want)
        .map((e) => copy(e.row));
    },

    /** 每个非空命名空间各多少条 */
    groups() {
      const out = {};
      for (const { row } of entries) out[row.ns] = (out[row.ns] ?? 0) + 1;
      return out;
    },

    stats() {
      return {
        count: entries.length,
        bytes,
        limit,
        byteBudget,
        since: entries.length ? entries[0].row.at : null,
      };
    },

    /** 单个命名空间 → 可落盘的文本。空命名空间返回空串，不生成 0 行的文件 */
    format(ns, meta = {}) {
      const name = normalizeNs(ns);
      const rows = entries.filter((e) => e.row.ns === name);
      if (rows.length === 0) return '';
      const at = Number.isFinite(meta.at) ? meta.at : now();
      return renderHeader({
        label: name, version: meta.version ?? '', at, shown: rows.length, total: entries.length, bytes,
      }) + rows.map((e) => renderLine(e.row, false)).join('\n') + '\n';
    },

    /** 全部命名空间合并成一份，行首多一列 ns —— 跨环节的时间线只有它连得起来 */
    formatMerged(meta = {}) {
      if (entries.length === 0) return '';
      const at = Number.isFinite(meta.at) ? meta.at : now();
      const nsCount = new Set(entries.map((e) => e.row.ns)).size;
      return renderHeader({
        label: `全部（${nsCount} 个）`,
        version: meta.version ?? '',
        at,
        shown: entries.length,
        total: entries.length,
        bytes,
      }) + entries.map((e) => renderLine(e.row, true)).join('\n') + '\n';
    },

    clear,

    /**
     * 从持久化数组恢复（SW 被唤醒后接上）。
     * **关着的时候是空操作** —— 否则「关掉了但导出还有东西」的坑会从这里绕回来。
     */
    restore(rows) {
      if (!enabled || !Array.isArray(rows)) return;
      const at = now();
      for (const raw of rows.slice(-limit)) accept(raw, at);
    },
  };
}
