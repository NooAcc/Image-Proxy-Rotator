/**
 * 统计计数器：纯逻辑，不碰 `chrome.*`（决策 D6，可在 Node 下直接单测）。
 *
 * **存储方案的核心取舍（决策 D14）：只存聚合计数器，不存请求明细。**
 *
 * 「统计」很容易滑向「留一份事件流」，而事件流的体积随使用时长无界增长，最终必须配上
 * 淘汰策略、分页读取、甚至 IndexedDB。本扩展要回答的问题只有「总量多少、成功率多高、
 * 哪个节点被用得多、哪条规则从没命中」—— 这些全都能用 O(1) 的整数计数器回答。于是：
 *
 *   · 占用只随**节点数 / 规则数**增长，与运行时长无关
 *   · 满配（500 节点 + 500 规则）实测 31.5 KB —— 即便按 Chrome 113 及更早的 5 MB 配额算也只占 0.6%
 *   · 不需要 unlimitedStorage 权限，不需要淘汰策略
 *
 * 两处刻意的设计：
 *   1. **retired 桶。** 节点或规则被删除后，它的历史用量并入 retired 而不是丢弃 ——
 *      否则「各节点占比」加起来不到 100%，用户会以为统计算错了。同时这让 perNode /
 *      perRule 的键数严格收敛到「当前配置的实体数」，孤儿键不会随时间堆积。
 *   2. **MAP_CAP 硬上限。** 上一条已经把增长钉住了，这条是兜底：万一有人真的导入了
 *      几千个节点，按用量丢弃最少的那些，保证单键体积有天花板。
 */

/** chrome.storage.local 里存放统计的键名 */
export const METRICS_KEY = 'metrics';

/** perNode / perRule 各自的键数硬上限 */
export const MAP_CAP = 500;

/** 非负整数，脏数据一律归零 —— 统计里出现一个 NaN 会顺着平均值污染整块面板 */
function count(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 可选时间戳 */
function stamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** @returns 全新的空计数器（每次调用都是新对象，避免共享引用被意外修改） */
export function emptyMetrics() {
  return {
    /** 首次计数的时刻，面板用它显示「自 X 起累计」 */
    since: null,
    requests: { total: 0, ok: 0, fail: 0, latencySum: 0, latencyCount: 0, unattributed: 0, blind: 0, viaNodeIp: 0 },

    /** @type {Record<string, {used: number, ok: number, fail: number}>} */
    perNode: {},
    /** @type {Record<string, {hits: number}>} */
    perRule: {},
    /** 已删除的节点/规则的历史量，保证占比的分母诚实 */
    retired: { nodeUsed: 0, nodeOk: 0, nodeFail: 0, ruleHits: 0 },
    probe: { ok: 0, fail: 0, lastAt: null },
    apply: { ok: 0, fail: 0, lastAt: null, lastError: null },
  };
}

/**
 * 从存储读回时的容错规范化。
 * 存储里的东西可能来自旧版本、也可能被手工改坏过，一律尽力读取已知字段。
 * @param {unknown} raw
 * @returns {object} 形状完整、可直接继续计数的计数器
 */
export function normalizeMetrics(raw) {
  const base = emptyMetrics();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  base.since = stamp(raw.since);

  const req = raw.requests;
  if (req && typeof req === 'object') {
    for (const key of Object.keys(base.requests)) base.requests[key] = count(req[key]);
  }

  if (raw.perNode && typeof raw.perNode === 'object' && !Array.isArray(raw.perNode)) {
    for (const [id, stat] of Object.entries(raw.perNode)) {
      if (!id || !stat || typeof stat !== 'object') continue;
      base.perNode[id] = { used: count(stat.used), ok: count(stat.ok), fail: count(stat.fail) };
    }
  }

  if (raw.perRule && typeof raw.perRule === 'object' && !Array.isArray(raw.perRule)) {
    for (const [id, stat] of Object.entries(raw.perRule)) {
      if (!id || !stat || typeof stat !== 'object') continue;
      base.perRule[id] = { hits: count(stat.hits) };
    }
  }

  if (raw.retired && typeof raw.retired === 'object') {
    for (const key of Object.keys(base.retired)) base.retired[key] = count(raw.retired[key]);
  }

  if (raw.probe && typeof raw.probe === 'object') {
    base.probe.ok = count(raw.probe.ok);
    base.probe.fail = count(raw.probe.fail);
    base.probe.lastAt = stamp(raw.probe.lastAt);
  }

  if (raw.apply && typeof raw.apply === 'object') {
    base.apply.ok = count(raw.apply.ok);
    base.apply.fail = count(raw.apply.fail);
    base.apply.lastAt = stamp(raw.apply.lastAt);
    base.apply.lastError = raw.apply.lastError == null ? null : String(raw.apply.lastError);
  }

  return base;
}

/** 第一次计数时点亮 since */
function touch(metrics, at) {
  if (metrics.since === null) metrics.since = stamp(at) ?? null;
}

/**
 * 记一次「命中了用户规则」的请求。
 *
 * 注意 `blind` 与 `nodeId` 的关系：`blind` 表示浏览器压根没把足够的信息交给 PAC
 * （https 请求的 path 与 query 被剥掉了，见 lib/pac-url.js），这次请求**必然**走的是
 * 直连。既然原因已经确切知道，就不该再往 `unattributed` 里记一笔 —— 那一项的含义是
 * 「走了代理但认不出是哪个节点」，两者混在一起会让人查错方向。
 *
 * @param {object} metrics 就地修改
 * @param {object} event
 * @param {boolean} event.ok HTTP 状态 < 400
 * @param {number} [event.latencyMs] 端到端耗时；缺失或非法则不计入平均值
 * @param {?string} [event.nodeId] 归因到的**具体**节点；归因失败时记入 unattributed
 * @param {boolean} [event.viaNodeIp] 对端 IP 属于某个节点（可能不止一个）—— 这是
 *   「真的从代理回来了」的硬证据，即使分不出是哪个节点也成立
 * @param {?string} [event.ruleId] 实际生效的规则；blind 时不计命中
 * @param {boolean} [event.blind] 规则命中但 PAC 拿不到判定所需的信息，必然直连
 * @param {number} [event.at] 事件时刻
 * @returns {object} 同一个 metrics，便于链式调用
 */
export function noteRequest(metrics, { ok, latencyMs, nodeId, viaNodeIp = false, ruleId, blind = false, at } = {}) {
  touch(metrics, at);
  const req = metrics.requests;
  req.total++;
  if (ok) req.ok++;
  else req.fail++;

  // 只有真正测到的耗时才进平均值。把缺失当 0 会把平均耗时越算越低，
  // 那种「数字很好看但没有意义」的指标比没有指标更糟。
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    req.latencySum += Math.round(latencyMs);
    req.latencyCount++;
  }

  if (blind) {
    req.blind++;
    // 这条规则没有真的路由任何东西，不该让「规则命中」表格显示它在干活
    return metrics;
  }

  if (viaNodeIp || nodeId) req.viaNodeIp++;

  if (nodeId) {

    const stat = metrics.perNode[nodeId] || (metrics.perNode[nodeId] = { used: 0, ok: 0, fail: 0 });
    stat.used++;
    if (ok) stat.ok++;
    else stat.fail++;
  } else {
    // 按出口 IP 归因本身会漏（代理未转发、IP 未知），诚实单列，不硬塞给某个节点
    req.unattributed++;
  }

  if (ruleId) {
    const stat = metrics.perRule[ruleId] || (metrics.perRule[ruleId] = { hits: 0 });
    stat.hits++;
  }

  return metrics;
}


/** 记一次延迟探测的结果 */
export function noteProbe(metrics, { ok, at } = {}) {
  touch(metrics, at);
  if (ok) metrics.probe.ok++;
  else metrics.probe.fail++;
  metrics.probe.lastAt = stamp(at) ?? metrics.probe.lastAt;
  return metrics;
}

/** 记一次 PAC 注入的结果。成功时清掉上一次的失败原因，避免界面一直挂着过期错误 */
export function noteApply(metrics, { ok, error, at } = {}) {
  touch(metrics, at);
  if (ok) {
    metrics.apply.ok++;
    metrics.apply.lastError = null;
  } else {
    metrics.apply.fail++;
    metrics.apply.lastError = error == null ? null : String(error);
  }
  metrics.apply.lastAt = stamp(at) ?? metrics.apply.lastAt;
  return metrics;
}

/** 把一批键的量并入 retired 并删除它们 */
function retire(metrics, map, ids, fold) {
  for (const id of ids) {
    fold(metrics.retired, map[id]);
    delete map[id];
  }
}

/**
 * 剪掉已不存在的节点/规则，把它们的历史量并入 retired；再按硬上限收口。
 *
 * 这是「体积不随时间增长」这条保证的落地点：每次落盘前调用一次，perNode / perRule 的
 * 键数就恒等于当前配置里的实体数（外加上限兜底）。
 *
 * @param {object} metrics 就地修改
 * @param {{nodeIds?: string[], ruleIds?: string[]}} present 当前配置里还在的 id
 */
export function pruneMetrics(metrics, present = {}) {
  const foldNode = (retired, stat) => {
    if (!stat) return;
    retired.nodeUsed += stat.used;
    retired.nodeOk += stat.ok;
    retired.nodeFail += stat.fail;
  };
  const foldRule = (retired, stat) => {
    if (stat) retired.ruleHits += stat.hits;
  };

  // 拿不到 id 列表（比如读配置失败）时什么都不删 —— 宁可多留几个键，
  // 也不能因为一次读取失败就把用户的统计抹掉
  if (Array.isArray(present.nodeIds)) {
    const alive = new Set(present.nodeIds);
    retire(metrics, metrics.perNode, Object.keys(metrics.perNode).filter((id) => !alive.has(id)), foldNode);
  }
  if (Array.isArray(present.ruleIds)) {
    const alive = new Set(present.ruleIds);
    retire(metrics, metrics.perRule, Object.keys(metrics.perRule).filter((id) => !alive.has(id)), foldRule);
  }

  // 兜底上限：按用量升序丢弃多出来的部分
  const nodeIds = Object.keys(metrics.perNode);
  if (nodeIds.length > MAP_CAP) {
    const doomed = nodeIds
      .sort((a, b) => metrics.perNode[a].used - metrics.perNode[b].used)
      .slice(0, nodeIds.length - MAP_CAP);
    retire(metrics, metrics.perNode, doomed, foldNode);
  }
  const ruleIds = Object.keys(metrics.perRule);
  if (ruleIds.length > MAP_CAP) {
    const doomed = ruleIds
      .sort((a, b) => metrics.perRule[a].hits - metrics.perRule[b].hits)
      .slice(0, ruleIds.length - MAP_CAP);
    retire(metrics, metrics.perRule, doomed, foldRule);
  }

  return metrics;
}

/** 百分比，保留一位小数；分母为 0 时是「无」而不是 0 —— 两者含义完全不同 */
function rate(part, total) {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

/** 按量降序，量相同则按名字，保证渲染顺序稳定（否则每次刷新表格都在跳） */
function byAmountThenName(key) {
  return (a, b) => (b[key] - a[key]) || String(a.name).localeCompare(String(b.name));
}

/**
 * 把计数器加工成可直接渲染的视图模型。不修改传入的 metrics。
 *
 * @param {object} metrics
 * @param {{nodes?: object[], rules?: object[]}} config 用于补名字、标出「已删除」、列出零命中项
 */
export function summarizeMetrics(metrics, { nodes = [], rules = [] } = {}) {
  const m = normalizeMetrics(metrics);
  const req = m.requests;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  // 当前配置里的实体全部列出（含零命中），再补上计数器里残留的已删除实体
  const nodeIds = [...new Set([...nodeById.keys(), ...Object.keys(m.perNode)])];
  const ruleIds = [...new Set([...ruleById.keys(), ...Object.keys(m.perRule)])];

  const nodeTotal = Object.values(m.perNode).reduce((sum, s) => sum + s.used, 0) + m.retired.nodeUsed;
  const ruleTotal = Object.values(m.perRule).reduce((sum, s) => sum + s.hits, 0) + m.retired.ruleHits;

  const nodeRows = nodeIds.map((id) => {
    const stat = m.perNode[id] ?? { used: 0, ok: 0, fail: 0 };
    const node = nodeById.get(id);
    return {
      id,
      name: node?.name || id,
      exists: Boolean(node),
      used: stat.used,
      ok: stat.ok,
      fail: stat.fail,
      successRate: rate(stat.ok, stat.used),
      share: rate(stat.used, nodeTotal) ?? 0,
    };
  }).sort(byAmountThenName('used'));

  const ruleRows = ruleIds.map((id) => {
    const stat = m.perRule[id] ?? { hits: 0 };
    const rule = ruleById.get(id);
    return {
      id,
      name: rule?.name || id,
      type: rule?.type ?? null,
      pattern: rule?.pattern ?? '',
      exists: Boolean(rule),
      hits: stat.hits,
      share: rate(stat.hits, ruleTotal) ?? 0,
    };
  }).sort(byAmountThenName('hits'));

  return {
    since: m.since,
    requests: {
      total: req.total,
      ok: req.ok,
      fail: req.fail,
      unattributed: req.unattributed,
      // 对端 IP 属于某个节点的次数。分不出具体是哪个节点（多个节点共用一个地址）时
      // 它照样成立 —— 「真的从代理回来了」和「是哪个节点」是两个问题
      viaNodeIp: req.viaNodeIp,
      // 命中了规则、却因为 https 剥掉了 path/query 而必然直连的次数。
      // 这一项不为零就说明有规则写成了 PAC 判定不了的形态 —— 是最值得先查的信号
      blind: req.blind,
      routed: Math.max(0, req.total - req.blind),
      successRate: rate(req.ok, req.total),
      avgLatencyMs: req.latencyCount ? Math.round(req.latencySum / req.latencyCount) : null,
    },

    nodes: { rows: nodeRows, totalUsed: nodeTotal, retiredUsed: m.retired.nodeUsed },
    rules: { rows: ruleRows, totalHits: ruleTotal, retiredHits: m.retired.ruleHits },
    probe: {
      ok: m.probe.ok,
      fail: m.probe.fail,
      total: m.probe.ok + m.probe.fail,
      successRate: rate(m.probe.ok, m.probe.ok + m.probe.fail),
      lastAt: m.probe.lastAt,
    },
    apply: {
      ok: m.apply.ok,
      fail: m.apply.fail,
      total: m.apply.ok + m.apply.fail,
      lastAt: m.apply.lastAt,
      lastError: m.apply.lastError,
    },
  };
}
