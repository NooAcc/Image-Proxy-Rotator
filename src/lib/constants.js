/**
 * 全局常量与默认配置。
 *
 * 本文件（以及 src/lib/ 下所有文件）不得引用 `chrome.*`，
 * 以保证纯逻辑层可以在 Node 下直接单元测试（见 plan.md 决策 D6）。
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

/** 无可用节点时的兜底行为 */
export const FALLBACKS = ['direct', 'block'];

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

/** @returns 全新的默认设置对象 */
export function defaultSettings() {
  return {
    strategy: 'round-robin',
    fallback: 'direct',
    rotateEvery: 1,
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
