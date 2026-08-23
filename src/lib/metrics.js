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

import { isSelectable } from './node-model.js';

/** chrome.storage.local 里存放统计的键名 */
export const METRICS_KEY = 'metrics';

/** perNode / perRule 各自的键数硬上限 */
export const MAP_CAP = 500;

/**
 * 延迟直方图的桶上界（毫秒），最后再加一个「更慢」的溢出桶。
 *
 * **为什么要直方图而不是只留平均值。** 真实数据里首次请求 p50 是 1.2s、p90 是 15.8s ——
 * 一个 3.6s 的平均值把「大部分图其实还行、但每十张就有一张要等十几秒」这件事完全抹平了。
 * 平均值对长尾毫无抵抗力，而长尾恰恰是用户唯一会抱怨的部分。
 *
 * 桶是固定的，所以这仍然满足决策 D14：占用与运行时长无关（10 个整数，恒定）。
 * 代价是分位数只精确到桶内插值 —— 落在溢出桶时只报下界，不编一个精确值。
 */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** 直方图的桶数 = 上界数 + 1 个溢出桶 */
const BUCKET_COUNT = LATENCY_BUCKETS_MS.length + 1;

/** 一个耗时落在第几个桶 */
function bucketOf(latencyMs) {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (latencyMs <= LATENCY_BUCKETS_MS[i]) return i;
  }
  return LATENCY_BUCKETS_MS.length;
}

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
    requests: {
      total: 0, ok: 0, fail: 0, latencySum: 0, latencyCount: 0,
      unattributed: 0, blind: 0, viaNodeIp: 0,
      /**
       * 从浏览器缓存直接返回、没有走网络的次数。
       *
       * 必须单列，否则它会同时污染四个数字：总量（一张图被翻回来看九次就记九次）、
       * 成功率（缓存永远成功）、平均耗时（2ms 的缓存读把长尾拉平）、以及
       * 「对端确认是代理」—— 缓存命中时浏览器给的仍是**上一次**的对端 IP，
       * 看起来像一次新的代理往返，其实一个字节都没出去。
       */
      cached: 0,
    },

    /** 延迟直方图，见 LATENCY_BUCKETS_MS。只收真实网络请求，不收缓存命中 */
    latency: new Array(BUCKET_COUNT).fill(0),

    /**
     * 重试。**全是观测值，没有一个是推断的**（决策 D24）：重试由本扩展的内容脚本
     * 亲自发起，重发之后是 load 还是 error 也由它回报，所以 recovered 是「真的收到了
     * load 事件」而不是「大概成功了」。
     *
     * `abandoned` 与 `unseen` 补的是两个曾经无处可查的缺口，见 noteRetry 的注释。
     */
    retry: {
      attempted: 0, recovered: 0, exhausted: 0, skipped: 0, abandoned: 0, unseen: 0,
      /**
       * 主世界补丁问过后台多少次（决策 D31 的那条路）。
       *
       * 口径刻意与 `attempted` 不同：这一格要回答的是「补丁到底装上没有、在不在干活」，
       * 而不是「重发了几次」。补丁装不上（站点自己抢先包了 fetch、注册失败、CSP 拦截）
       * 时它恒为 0，而 `retry.unseen` 会继续涨 —— 两个数字放在一起才能指认那种失败。
       */
      deep: 0,
    },
    /**
     * 兜底代理：轮询节点全试过之后接手了多少次，以及它自己的成败。
     *
     * `cooldown` 是第四个口径，1.5.0 新增：该源正处在冷却期，于是这次用尽**没有**
     * 交给兜底。不单列它，用户会看到「用尽仍失败」在涨而「兜底接管」不动，读起来
     * 像兜底坏了 —— 实际是冷却在按设计抑制它。
     */
    fallbackProxy: { used: 0, ok: 0, fail: 0, cooldown: 0 },

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

  // 桶数是代码里定死的，存储里读到的长度一律不信：多了截断、少了补零。
  // 否则改一次桶边界就会把历史直方图读成一个错位的形状
  if (Array.isArray(raw.latency)) {
    for (let i = 0; i < BUCKET_COUNT; i++) base.latency[i] = count(raw.latency[i]);
  }

  for (const bucket of ['retry', 'fallbackProxy']) {
    if (raw[bucket] && typeof raw[bucket] === 'object') {
      for (const key of Object.keys(base[bucket])) base[bucket][key] = count(raw[bucket][key]);
    }
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
 * @param {boolean} [event.cached] 浏览器直接从缓存返回，一个字节都没出去
 * @param {boolean} [event.responded] 这次请求收到了响应（于是**有**对端 IP 可供归因）。
 *   连接层就失败的请求（ERR_CONNECTION_CLOSED）没有对端 IP，谈不上「归因失败」——
 *   把它们算进 unattributed 会让那一格等于请求总数，看起来像归因彻底失灵。
 * @param {number} [event.at] 事件时刻
 * @returns {object} 同一个 metrics，便于链式调用
 */
export function noteRequest(metrics, {
  ok, latencyMs, nodeId, viaNodeIp = false, ruleId, blind = false, cached = false, responded = true, at,
} = {}) {
  touch(metrics, at);
  const req = metrics.requests;

  // 缓存命中在这里就走人：它不是一次网络请求，更不是一次代理往返。
  // 与 blind 的提前返回同一个道理 —— 这次「请求」没有路由任何东西，
  // 让它进总量/耗时/归因只会让四个数字一起失真
  if (cached) {
    req.cached++;
    return metrics;
  }

  req.total++;
  if (ok) req.ok++;
  else req.fail++;

  // 只有真正测到的耗时才进平均值。把缺失当 0 会把平均耗时越算越低，
  // 那种「数字很好看但没有意义」的指标比没有指标更糟。
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    req.latencySum += Math.round(latencyMs);
    req.latencyCount++;
    metrics.latency[bucketOf(latencyMs)]++;
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
  } else if (responded) {
    // 按出口 IP 归因本身会漏（代理未转发、IP 未知），诚实单列，不硬塞给某个节点。
    // 但**没收到响应**就没有对端 IP，那不叫归因失败，那叫压根没得归因
    req.unattributed++;
  }

  if (ruleId) {
    const stat = metrics.perRule[ruleId] || (metrics.perRule[ruleId] = { hits: 0 });
    stat.hits++;
  }

  return metrics;
}


/**
 * 记一次重试判定的结果。
 *
 * 三个**判定**口径互不重叠，合起来等于「后台被问过多少次『这张图该怎么办』」：
 *   · attempted —— 判定为重发，内容脚本真的重新赋值了 src
 *   · exhausted —— 用尽 maxAttempts 仍失败（不论后面有没有兜底接手）
 *   · skipped   —— 不该重试：URL 不归本扩展管、原因不是代理故障、或压根查不到原因
 *
 * 两个**结局**口径描述 attempted 那些后来怎么了（`recovered + abandoned ≤ attempted`，
 * 差额是「重发又失败了，已经进入下一轮判定」）：
 *   · recovered —— 重发之后收到了 load。**这是回报值，不是推断值**（决策 D24）
 *   · abandoned —— 重发出去了，却既没 load 也没 error。元素被页面换掉或导航走了，
 *     渲染进程不会再派发任何事件，这次重发的结局**永远不会有人回报**。真实数据里
 *     attempted=7 / recovered=6，差的那 1 次就是它：`ERR_ABORTED` 在网络层出现，
 *     img 上却什么都没派发。不单列它，面板上四个格子加起来就是 6，那 1 次无处可查。
 *
 * 还有一个口径根本不在上面的账里，因为它连「被问过」都没发生：
 *   · unseen —— 网络层失败了，但页面侧压根没捕获到。阅读器常用 `new Image()` 预加载，
 *     不在 DOM 上的 Image 不会经过 document 的捕获阶段，内容脚本永远看不见。真实数据里
 *     13 次失败有 3 次属于此类，而旧面板「未重试」显示 0 —— 读起来像「每次失败都重试了」。
 *
 * @param {object} metrics 就地修改
 * @param {{kind: 'attempted'|'recovered'|'exhausted'|'skipped'|'abandoned'|'unseen', at?: number}} event
 */
export function noteRetry(metrics, { kind, at } = {}) {
  touch(metrics, at);
  if (typeof kind === 'string' && Object.hasOwn(metrics.retry, kind)) metrics.retry[kind]++;
  return metrics;
}

/**
 * 记一次兜底代理的动作。
 *
 * `used` 与 `ok` / `fail` 是两个时刻：开窗放行时记 used，浏览器加载完之后内容脚本
 * 再回报一次成败。所以 `used` 会先于 `ok + fail` 增长，短暂对不上是正常的。
 *
 * `cooldown` 与三者都不重叠：它记的是「本该交给兜底，但该源在冷却期，于是没交」。
 *
 * @param {object} metrics 就地修改
 * @param {{used?: boolean, ok?: ?boolean, cooldown?: boolean, at?: number}} event
 */
export function noteFallbackProxy(metrics, { used = false, ok = null, cooldown = false, at } = {}) {
  touch(metrics, at);
  if (used) metrics.fallbackProxy.used++;
  if (cooldown) metrics.fallbackProxy.cooldown++;
  if (ok === true) metrics.fallbackProxy.ok++;
  else if (ok === false) metrics.fallbackProxy.fail++;
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

/**
 * 从直方图估一个分位数。
 *
 * 桶内按线性插值，所以结果是**估计值**，精度就是桶宽。落进溢出桶时只返回最后一个
 * 上界（含义是「≥ 这个数」）—— 那一段没有上界，插值等于凭空编一个精确值。
 *
 * @param {number[]} buckets
 * @param {number} q 0..1
 * @returns {?number} 没有样本时是 null，不是 0
 */
function percentile(buckets, q) {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (!total) return null;

  const target = q * total;
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    const before = cumulative;
    cumulative += buckets[i];
    if (cumulative < target || buckets[i] === 0) continue;

    const lower = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1];
    // 溢出桶没有上界，插不了值，只说下界
    if (i >= LATENCY_BUCKETS_MS.length) return lower;
    const upper = LATENCY_BUCKETS_MS[i];
    return Math.round(lower + (upper - lower) * ((target - before) / buckets[i]));
  }
  return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1];
}

/** 按量降序，量相同则按名字，保证渲染顺序稳定（否则每次刷新表格都在跳） */
function byAmountThenName(key) {
  return (a, b) => (b[key] - a[key]) || String(a.name).localeCompare(String(b.name));
}

/**
 * 哪些地址被多个节点共用。
 *
 * **归因的物理上限。** `webRequest` 只给对端 IP、不给对端端口，所以「一台机器开几十个
 * 端口、每个端口一个上游出口」这种常见形态下，「是哪个节点」根本无法回答。真实配置就是
 * 19 个节点全在 10.0.0.3 上 —— 面板于是渲染出 19 行 0/0/0/—/0%，解释文字是对的，
 * 但那张全零的表本身就是噪音。
 *
 * 判断放在这里而不是页面里：设置页与弹窗都要用，而「这张表还有没有意义」是一个
 * 关于数据的结论，不是一个关于排版的结论。
 *
 * 只看**能进轮询池**的节点：协议不支持的那些压根不会被选中，拿它们去论证
 * 「这张���分不开」是错的。
 */
function sharedHostsOf(nodes) {
  const byHost = new Map();
  for (const node of nodes) {
    if (!isSelectable(node)) continue;
    byHost.set(node.host, (byHost.get(node.host) ?? 0) + 1);
  }
  const shared = [...byHost.entries()]
    .filter(([, count]) => count > 1)
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => (b.count - a.count) || String(a.host).localeCompare(String(b.host)));

  const selectable = [...byHost.values()].reduce((sum, n) => sum + n, 0);
  const sharedCount = shared.reduce((sum, s) => sum + s.count, 0);

  return {
    sharedHosts: shared,
    // 一个节点都没配时是「还没有数据」，不是「分不开」—— 两者该走不同的界面
    allShared: selectable > 0 && sharedCount === selectable,
  };
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
      // 从浏览器缓存直接返回、没有走网络的次数。翻回去重看一页漫画会大量命中这里 ——
      // 它是「扩展没在工作」的反面证据，不是问题，但必须与真实请求分开数
      cached: req.cached,
      // 对端 IP 属于某个节点的次数。分不出具体是哪个节点（多个节点共用一个地址）时
      // 它照样成立 —— 「真的从代理回来了」和「是哪个节点」是两个问题
      viaNodeIp: req.viaNodeIp,
      // 命中了规则、却因为 https 剥掉了 path/query 而必然直连的次数。
      // 这一项不为零就说明有规则写成了 PAC 判定不了的形态 —— 是最值得先查的信号
      blind: req.blind,
      routed: Math.max(0, req.total - req.blind),
      successRate: rate(req.ok, req.total),
      avgLatencyMs: req.latencyCount ? Math.round(req.latencySum / req.latencyCount) : null,
      // 平均值对长尾没有抵抗力，这两个才是用户实际的体感。见 LATENCY_BUCKETS_MS
      latencyP50: percentile(m.latency, 0.5),
      latencyP90: percentile(m.latency, 0.9),
    },

    /**
     * 重试。注意 `requests.total` 是**含重试**的 —— 重发就是一次新请求，webRequest
     * 会照实再记一笔。所以开启重试之后成功率会比以前低，`attempted` 就是用来对账的。
     */
    retry: {
      attempted: m.retry.attempted,
      recovered: m.retry.recovered,
      exhausted: m.retry.exhausted,
      skipped: m.retry.skipped,
      abandoned: m.retry.abandoned,
      unseen: m.retry.unseen,
      // 其中有多少次是主世界补丁问的。它与 unseen 是一对：补丁在干活时 unseen 会明显
      // 下降，而 deep 恒为 0、unseen 照旧居高不下就说明补丁根本没装上
      deep: m.retry.deep,
      // 重发了却还没有结论的次数。不为零本身是有用的信号：要么还在路上，要么页面
      // 在重发之后被换掉了而「结果未知」的超时还没到。上一版没有这一格，于是
      // 「重发 7 次、救回 6 次」里那 1 次差额在面板上完全找不到
      pending: Math.max(0, m.retry.attempted - m.retry.recovered - m.retry.abandoned - m.retry.exhausted),
      recoveryRate: rate(m.retry.recovered, m.retry.attempted),
    },
    fallbackProxy: {
      used: m.fallbackProxy.used,
      ok: m.fallbackProxy.ok,
      fail: m.fallbackProxy.fail,
      // 本该兜底却因为该源在冷却期而没兜的次数。不为零说明轮询池正在持续大面积失败，
      // 而冷却在按设计抑制「整个图源长期只走一个代理」
      cooldown: m.fallbackProxy.cooldown,
      successRate: rate(m.fallbackProxy.ok, m.fallbackProxy.ok + m.fallbackProxy.fail),
    },

    nodes: { rows: nodeRows, totalUsed: nodeTotal, retiredUsed: m.retired.nodeUsed, ...sharedHostsOf(nodes) },
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
