/**
 * 全局常量与默认配置。
 *
 * 本文件（以及 src/lib/ 下所有文件）不得引用 `chrome.*`，
 * 以保证纯逻辑层可以在 Node 下直接单元测试（见 docs/ARCHITECTURE.md 决策 D6）。
 */

/** chrome.storage.local 中存放配置的键名 */
export const CONFIG_KEY = 'config';

/** 当前配置结构版本 */
export const CONFIG_VERSION = 1;

/**
 * 延迟探测标记参数名。
 * PAC 脚本靠这个字面量识别「这是一次针对某个节点的探测请求」，
 * 从而强制路由到指定节点。改名会同时破坏 PAC 与 health-monitor，切勿修改。
 */
export const PROBE_PARAM = '__pp_node';

/** chrome.alarms 中定时探测任务的名字 */
export const ALARM_PROBE = 'pp-probe';

/** 延迟超过该值即标记为 slow（毫秒） */
export const SLOW_LATENCY_MS = 2000;

/**
 * 每张图最多能尝试几个节点的硬上限。
 * 上限存在的意义是防止误配把一张裂图变成几十次重刷 —— 图源的速率限制不会因为
 * 换了代理就消失，重试次数堆得越高越像在打人家的站点。
 */
export const RETRY_ATTEMPTS_CAP = 10;

/** 重发前的等待时长上限（毫秒） */
export const RETRY_DELAY_CAP_MS = 5000;

/**
 * 「失败原因」在后台留存多久（毫秒）。
 *
 * 内容脚本只知道「图裂了」，分不清是代理连不上还是图源回了 404；后台在 webRequest 上
 * 看到了真正的错误码，把它按 URL 暂存一小会儿供重试判定查询（决策 D22）。留 30 秒是
 * 因为渲染进程派发 error 与 webRequest 回调之间没有顺序保证，但也不会差出一整分钟。
 */
export const FAILURE_TTL_MS = 30000;

/**
 * 网络层失败之后，等多久还没被内容脚本问起，就断定「页面压根没捕获到」（毫秒）。
 *
 * 这一格补的是一个曾经完全看不见的缺口：只有 DOM 里的 `<img>` 才会派发可捕获的
 * error，而阅读器常用 `new Image()` 预加载 —— 那种 Image 对象不在 DOM 上，
 * `document` 的捕获阶段永远收不到它的 error。真实数据里 13 次失败有 3 次属于此类，
 * 而面板上「未重试」显示 0，读起来像「每次失败都重试了」。
 *
 * 3 秒远大于两条路径的正常时间差（`LOOKUP_GRACE_MS` 只等 150ms），又短到 Service
 * Worker 还醒着。真的被 SW 休眠吃掉一次计数也无所谓 —— 这一格是用来发现「重试对
 * 这个站点整体无效」的量级信号，不是精确账本。
 */
export const RETRY_ASK_GRACE_MS = 3000;

/**
 * **唯一**可用于分流的协议。
 *
 * 这是整个扩展的能力边界：浏览器扩展只能通过 PAC 表达代理，而本项目已收敛为只支持
 * HTTP/HTTPS 正向代理。任何其他协议（SOCKS、VLESS、Hysteria2、Trojan、SS 等）都不得
 * 进入轮询池 —— 该约束由 node-model.pacToken() 单点强制：非本列表的协议一律返回 null，
 * 于是 isSelectable、PAC 节点池、摘要统计会同时收紧，不存在绕过路径。
 */
export const SUPPORTED_PROTOCOLS = ['http', 'https'];

/**
 * 能被**识别**的协议名 —— 仅用于展示和给出「不支持」提示。
 * 出现在这里不代表可用；可用性只看 SUPPORTED_PROTOCOLS。
 */
export const KNOWN_PROTOCOLS = [
  'http', 'https',
  'socks4', 'socks5', 'vless', 'vmess', 'hysteria2', 'trojan', 'ss', 'ssr', 'tuic',
];

/** 协议别名归一化（同样只影响识别与展示） */
export const PROTOCOL_ALIASES = {
  socks: 'socks5',
  socks5h: 'socks5',
  socks4a: 'socks4',
  hy2: 'hysteria2',
  hysteria: 'hysteria2',
  shadowsocks: 'ss',
};

/** 协议 → 展示名 */
export const PROTOCOL_LABELS = {
  http: 'HTTP',
  https: 'HTTPS',
  socks4: 'SOCKS4',
  socks5: 'SOCKS5',
  vless: 'VLESS',
  vmess: 'VMess',
  hysteria2: 'Hysteria2',
  trojan: 'Trojan',
  ss: 'Shadowsocks',
  ssr: 'ShadowsocksR',
  tuic: 'TUIC',
  unknown: '未知协议',
};

/**
 * 不支持的代理类型的统一提示语。
 * 解析、节点警示、UI 三处共用这一份文案，避免出现口径不一致的提示。
 */
export const UNSUPPORTED_PROTOCOL_MESSAGE = '本程序不支持该代理类型，仅支持 HTTP/HTTPS 代理';

/** 各协议缺省端口（只有可用协议需要补默认值） */
export const DEFAULT_PORTS = {
  http: 80,
  https: 443,
};

/** 协议 → PAC 关键字。只有可用协议在此登记 */
export const PAC_KEYWORDS = {
  http: 'PROXY',
  https: 'HTTPS',
};

/** 支持的 URL 规则类型 */
export const RULE_TYPES = ['exact', 'prefix', 'host', 'wildcard', 'regex'];

/** 规则类型的中文显示名 */
export const RULE_TYPE_LABELS = {
  exact: '精确',
  prefix: '前缀',
  host: '域名',
  wildcard: '通配',
  regex: '正则',
};

/** 分流策略 */
export const STRATEGIES = ['round-robin', 'hash'];

/**
 * 无可用节点时的兜底行为。
 *
 * 顺序即语义上的推荐顺序：`block` 在前，因为它才是让重试与兜底真正生效的那个
 * （见 defaultSettings 的注释与 docs/LIMITATIONS.md 第 17 节）。
 */
export const FALLBACKS = ['block', 'direct'];

/** 默认探测地址：返回 204 的极小响应，且允许跨域 */
export const DEFAULT_PROBE_URL = 'https://cp.cloudflare.com/generate_204';

/** 默认绕过列表 */
export const DEFAULT_BYPASS_LIST = ['localhost', '127.0.0.1', '[::1]', '<local>'];

/** @returns {import('./schema.js').ProbeSettings} 全新的默认探测设置 */
export function defaultProbeSettings() {
  return {
    url: DEFAULT_PROBE_URL,
    timeoutMs: 5000,
    intervalMinutes: 15,
    autoDisable: true,
    failureThreshold: 2,
    recoverProbe: true,
  };
}

/** @returns 全新的默认重试设置 */
export function defaultRetrySettings() {
  return {
    /** 每张图最多尝试几个节点，**含首次**。1 = 不重试 */
    maxAttempts: 3,
    /**
     * 重发前等多久。留一小段时间让 Chromium 把刚失败的代理登记进它自己的坏代理列表
     * （见 docs/LIMITATIONS.md 第 5 节），否则重发很可能又落回同一个节点。
     */
    delayMs: 300,
  };
}

/**
 * 兜底代理与默认代理的存储形状完全相同（都是「一个 HTTP/HTTPS 正向代理 + 启用开关」），
 * 所以只留一份工厂 —— 第三处重复迟早会漏改一处字段。
 * 两者语义上毫不相干，见 lib/fallback-proxy.js 与 lib/default-proxy.js 的开头注释。
 */
function emptyProxyEntry() {
  return { enabled: false, raw: '', protocol: 'http', host: '', port: 0, username: '', password: '' };
}

/** @returns 全新的默认兜底代理设置 */
export function defaultFallbackProxy() {
  return emptyProxyEntry();
}

/**
 * @returns 全新的默认「默认代理」设置
 *
 * 名字确实叠了字：设置项叫 `defaultProxy`（规则之外的流量走谁），本文件里所有工厂都以
 * `default` 开头表示「该项的默认值」，于是拼出了 defaultDefaultProxy。
 *
 * **默认关闭，即规则外流量直连** —— 这是 1.5.0 及更早的行为，不能因为新增了这一项就
 * 悄悄改变现有用户的出口。而它也无法有一个有意义的默认地址：Chrome 不告诉扩展系统代理
 * 指向哪里（见 lib/default-proxy.js）。
 */
export function defaultDefaultProxy() {
  return emptyProxyEntry();
}

/**
 * 兜底窗口开着多久（毫秒）。
 *
 * **为什么是一段时间而不是一次请求。** 浏览器交给 PAC 的 https URL 只剩
 * `https://主机/`（见 lib/pac-url.js），同一个源的「首次」与「用尽后的重试」在 PAC 眼里
 * 完全一样。所以「只让这一张图走兜底代理」表达不出来，能表达的最接近的东西是
 * 「接下来这段时间该源的请求都走兜底代理」。
 *
 * 12 秒的依据：重发前要等 `retry.delayMs`（≤5s），而实测被限速的节点上一张图能拉十几秒。
 * 太短会让窗口在重发还没落地时就失效，等于兜底没生效；太长则把更多同源并发请求卷进来。
 */
export const FALLBACK_WINDOW_MS = 12000;

/**
 * 窗口关闭后该源的冷却时长（毫秒）。
 *
 * 没有冷却，轮询池长时间大面积失败时窗口会几乎一直开着 —— 整个图源长期只走一个代理，
 * 而这正是本扩展存在意义的反面（把流量摊到多个 IP 上躲速率限制），图源也可能转而对
 * 兜底代理的出口 IP 限速。冷却把「持续失败」钉成 `开窗 12s → 冷却 30s` 的循环，
 * 上界可预测，也能在设置页里说清。
 */
export const FALLBACK_COOLDOWN_MS = 30000;


/**
 * @returns 全新的默认深度重试设置
 *
 * 默认关闭且清单为空：它会向页面的**主世界**注入代码去包住 `fetch` / `XHR` / `Image`，
 * 这是本扩展权限面最大的一件事，必须由用户逐个站点显式打开（决策 D31）。
 */
export function defaultDeepRetry() {
  return { enabled: false, sites: [] };
}

/** @returns 全新的默认设置对象 */
export function defaultSettings() {
  return {
    strategy: 'round-robin',
    /**
     * 代理连不上时**不回落直连**。
     *
     * 1.4.3 及更早默认 `direct`，理由是「宁可图能显示，也不要一上来就整屏裂图」。
     * 实际用下来这个默认值是错的，而且错得很安静：选 `direct` 时浏览器会在连不上代理时
     * 静默改走直连 —— 图片照常显示、不派发 error，于是**重试、深度重试、兜底代理
     * 三样一次都不会触发**，而真实 IP 已经交给图源了。用户看到的是「一切正常」，
     * 实际上这个扩展存在的唯一理由已经失效了（详见 docs/LIMITATIONS.md 第 17 节）。
     *
     * 「装上之后什么都没发生」正是本项目反复吃过亏的那类故障，所以默认值改成让失败
     * **可见**：代理不通就裂图，然后由重试链去救。代价是节点配错时会看到整屏裂图 ——
     * 那是准确的反馈，不是缺陷。要旧行为的人可以在设置页改回「直连原图」。
     *
     * 注意这只影响**新装**与缺字段的配置：`normalizeSettings` 保留显式写着的取值，
     * 老用户存的 `direct` 不会被这次改动动到。
     */
    fallback: 'block',
    rotateEvery: 1,
    retry: defaultRetrySettings(),
    fallbackProxy: defaultFallbackProxy(),
    /**
     * 规则之外的流量走谁。默认关闭 = 直连。
     *
     * 这一项补的是一个静默且致命的缺口：注入 PAC 会替换掉浏览器**整份**代理配置，
     * 包括「使用系统代理」。靠本机代理客户端上网的人一启用本扩展，图片站按规则走节点、
     * 一切看着正常，而其余网站全部 ERR_CONNECTION_TIMED_OUT。详见 lib/default-proxy.js。
     */
    defaultProxy: defaultDefaultProxy(),
    deepRetry: defaultDeepRetry(),
    probe: defaultProbeSettings(),
    logLimit: 200,
    bypassList: [...DEFAULT_BYPASS_LIST],
  };
}

/** @returns 全新的默认配置对象（每次调用都是新对象，避免共享引用被意外修改） */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: false,
    nodes: [],
    rules: [],
    settings: defaultSettings(),
  };
}
