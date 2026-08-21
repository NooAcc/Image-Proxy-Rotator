# 架构说明

## 总览

```
┌──────────────────────────────────────────────────────────────┐
│ 设置页 (options)                 状态弹窗 (popup)             │
│  节点 / 规则 / 导入导出 / 排障     开关 / 测速 / 日志 / 规则    │
└───────────────┬──────────────────────────┬───────────────────┘
                │  chrome.runtime.sendMessage（统一消息路由）
┌───────────────▼──────────────────────────▼───────────────────┐
│ Service Worker（src/background/）                             │
│  ┌──────────────┐ ┌───────────────┐ ┌────────────────────┐   │
│  │ proxy-       │ │ health-       │ │ request-logger     │   │
│  │ controller   │ │ monitor       │ │ + auth-provider    │   │
│  │ 编译并注入PAC │ │ 测速/自动禁用  │ │ 只读观测 + 认证应答 │   │
│  └──────┬───────┘ └───────┬───────┘ └────────┬───────────┘   │
│         └─────────────────┴──────────────────┘               │
│                    state.js（配置缓存 + 运行时态）             │
└─────────────────────────────┬────────────────────────────────┘
                              │ 复用
┌─────────────────────────────▼────────────────────────────────┐
│ src/lib/（纯 JS，零 chrome 依赖，全量单测）                    │
│  constants  hash  schema  storage                             │
│  node-parser  node-model  rule-matcher  scheduler             │
│  pac-generator  logger                                        │
└─────────────────────────────┬────────────────────────────────┘
                              │ 生成 PAC 字符串
┌─────────────────────────────▼────────────────────────────────┐
│ chrome.proxy.settings（mode: "pac_script"）                   │
│  浏览器网络栈按 FindProxyForURL 的返回值选择出口               │
└──────────────────────────────────────────────────────────────┘
```

---

## 关键决策

| # | 决策 | 理由 |
|---|---|---|
| **D1** | 路由核心用 `chrome.proxy` 的 **PAC 脚本模式** | 这是扩展唯一能让浏览器网络栈真正走不同代理的 API。`fetch` 无法指定代理；`declarativeNetRequest` 只能改 URL，不能改传输层；`mode:'fixed_servers'` 只能配单个代理，无法轮询 |
| **D2** | **轮询计数器放在 PAC 脚本的模块作用域** | PAC 上下文在多次 `FindProxyForURL` 调用之间保持变量，因此计数器可以驻留其中，无需每请求与 Service Worker 通信（PAC 也没有这个能力） |
| **D3** | 测速 = 给测速 URL 加内部参数 `__pp_node=<节点id>`，PAC 认出后**强制**走该节点且**不加直连兜底** | 测的是「浏览器经该代理到公网」的真实端到端链路，与图片请求同一条通路；没有兜底所以失败是真失败。顺带能从 `webRequest.onCompleted.ip` 拿到出口 IP，直接证明分流生效 |
| **D4** | **只支持 HTTP / HTTPS 代理**，其余类型识别但不接纳 | 见 [LIMITATIONS.md](LIMITATIONS.md) 第 1 节。不支持的类型仍被识别，只为给出准确的中文提示 —— 识别而不接纳，比静默丢弃更不容易让用户困惑 |
| **D5** | 可用性判定收敛到 **`pacToken()` 单一出口** | 只有 `SUPPORTED_PROTOCOLS`（http/https）能拿到 token，其余返回 `null`。`isSelectable`、PAC 节点池、状态统计全都建立在它之上，因此不存在「某个不支持的协议从别的路径漏进轮询」的可能 |
| **D6** | 纯逻辑与 Chrome API **物理隔离**：`src/lib/` 不出现 `chrome.` | 让 PAC 生成、节点解析、规则匹配、调度这些最易错的部分能在 Node 里 TDD。`npm run check` 强制这条约束 |
| **D7** | PAC 生成器用 `node:vm` 沙箱**真的执行**生成出来的脚本来测 | 断言「脚本行为正确」而不是「字符串长得对」。字符串断言会在重构时全线崩溃 |
| **D8** | 自动禁用**只由测速结果驱动**；线上请求失败仅记日志 | 图片 404、站点 5xx、用户断网都会造成请求失败，据此禁用节点会把好节点全禁掉 |
| **D9** | 规则可绑定节点子集（空数组=全部） | 支持「A 图源用这批节点、B 图源用那批」；绑定的节点全不可用时自动回落到全部可用节点，避免图片直接裂开 |
| **D10** | 兜底可配 `fallback: direct \| block`，默认 `direct` | 默认让图片「至少能加载」优于「彻底裂图」；追求严格分流的用户可切 `block` |
| **D11** | 零构建、零依赖、原生 ESM | clone 后直接「加载解压缩的扩展」即可，没有 node_modules 供应链风险 |
| **D12** | 注入 PAC 时 `mandatory: false`，PAC 顶层 `try/catch` 兜底返回 `DIRECT` | 最坏结果是「不走代理」，绝不会是「整个浏览器断网」 |

---

## 一次图片请求的完整生命周期

1. 页面发起 `https://cdn.manga.com/001.jpg` 的图片请求。
2. 浏览器网络栈调用 PAC 的 `FindProxyForURL(url, host)`。
3. PAC 依次判断：
   1. 总开关关闭 → `DIRECT`
   2. URL 里有 `__pp_node=` → 这是测速请求，强制返回该节点的 token（无兜底）
   3. 主机命中绕过列表 / 单段主机名 / 私有网段 → `DIRECT`
   4. 逐条匹配规则池，命中则取出该规则对应的节点 token 数组
   5. 用模块作用域的计数器取一个 token，按 `rotateEvery` 决定是否前进
   6. `fallback === 'direct'` 时返回 `"PROXY 1.2.3.4:8080; DIRECT"`，否则不带兜底
4. 网络栈按返回值连接代理。若代理要求认证 → `onAuthRequired` 按主机端口匹配节点并自动应答。
5. 请求完成 → `webRequest.onCompleted` 观测到状态码与**对端 IP**；若该 URL 命中规则则写一条日志
   （只记录，不改节点状态）。
6. 状态弹窗每 2 秒拉一次日志与统计并刷新展示。

---

## 数据结构

配置持久化在 `chrome.storage.local` 的 `config` 键下，结构版本 `1`。

```js
Config {
  version: 1,
  enabled: boolean,          // 总开关
  nodes: Node[],
  rules: Rule[],
  settings: Settings,
}

Node {
  id: 'n_' + 8位hex,         // 由 protocol|host|port 稳定哈希得出，重复导入不会变
  name: string,
  protocol: 'http'|'https'   // 可用
          | 'socks5'|'vless'|… // 能识别但不可用，只用于提示
          | 'unknown',
  host: string, port: number,
  username: string, password: string,
  enabled: boolean,          // 用户手动开关
  autoDisabled: boolean,     // 测速失败自动禁用
  health: {
    status: 'unknown'|'ok'|'slow'|'fail',
    latencyMs: ?number,
    lastCheckedAt: ?number,
    consecutiveFailures: number,
    lastError: ?string,
    egressIp: ?string,       // 测速请求实际出口 IP，是分流生效的硬证据
  },
  raw: string,               // 原始链接
  meta: object,              // 链接里的额外 query 参数
}

Rule {
  id: 'r_' + 8位hex,
  name: string,
  type: 'exact'|'prefix'|'host'|'wildcard'|'regex',
  pattern: string,
  enabled: boolean,
  nodeIds: string[],         // 空数组 = 使用全部可用节点
}

Settings {
  strategy: 'round-robin'|'hash',
  fallback: 'direct'|'block',
  rotateEvery: number,
  probe: { url, timeoutMs, intervalMinutes, autoDisable, failureThreshold, recoverProbe },
  logLimit: number,
  bypassList: string[],
}
```

运行时状态（日志、每节点使用次数、轮询起点）存 `chrome.storage.session`，丢了不影响功能。

**规范化原则**：`schema.js` 保证「任何输入都能得到一份合法 Config」。无法修补的单条记录
直接丢弃（如端口越界的节点、无法编译的正则），而不是让整份配置失效。

---

## 模块职责

| 文件 | 职责 |
|---|---|
| `lib/constants.js` | 默认配置、`SUPPORTED_PROTOCOLS`、统一提示文案 |
| `lib/hash.js` | FNV-1a 稳定哈希与 id 生成（不用随机数，保证重复导入 id 不变） |
| `lib/schema.js` | 持久化结构规范化，永不抛异常 |
| `lib/storage.js` | 读写、版本迁移、导入导出（StorageArea 注入，便于测试） |
| `lib/node-parser.js` | 节点链接与订阅解析；把每行分类为 节点 / 不支持 / 非法 / 注释 |
| `lib/node-model.js` | `pacToken()`（可用性唯一闸门）、`isSelectable()`、提示语生成 |
| `lib/rule-matcher.js` | 规则构造、校验、编译、匹配 |
| `lib/scheduler.js` | 节点池计算、轮询与哈希选择（PAC 之外的可测实现） |
| `lib/pac-generator.js` | 把配置编译成 PAC 脚本字符串 |
| `lib/logger.js` | 环形日志缓冲 |
| `background/state.js` | 配置缓存与运行时态 |
| `background/proxy-controller.js` | 全扩展唯一写浏览器代理设置的地方 |
| `background/health-monitor.js` | 测速、超时判定、自动禁用、定时任务 |
| `background/request-logger.js` | 只读观测请求结果 |
| `background/auth-provider.js` | 代理认证自动应答 |
| `background/messaging.js` | UI 与后台之间唯一的契约 |
| `background/service-worker.js` | 事件注册与启动流程 |

**一条纪律**：任何改动了节点、规则、开关或健康状态的代码路径，结束前都必须调用
`applyProxy()`，否则 PAC 里的节点池会和实际配置脱节。

---

## 测试策略

```bash
npm test    # 169 个测试（单元 + 集成 + 后台编排 + SW 冒烟 + 打包）
npm run check
```

四层测试，逐层放大覆盖面：

| 层 | 文件 | 手法 |
|---|---|---|
| 纯逻辑单元 | `tests/{storage,node-parser,node-model,rule-matcher,scheduler,logger}.test.js` | 直接调 `src/lib/`，零依赖 |
| PAC 行为 | `tests/pac-generator.test.js` | `node:vm` 沙箱**真的执行**生成的脚本 |
| 主链路集成 | `tests/integration.test.js` | 从「用户粘贴的文本」一路跑到「PAC 做出路由决策」 |
| 后台编排 | `tests/background.test.js`、`tests/service-worker.test.js` | `tests/helpers/chrome-stub.js` 提供 `chrome.*` 与 `fetch` 替身 |
| 打包产物 | `tests/pack.test.js` | 用另写一份的 zip 解析器把包拆回来逐字节比对 |

`npm run check` 做的静态校验：
1. `manifest.json` 合法且是 MV3，引用的每个文件真实存在
2. `src/` 下所有相对 `import` 路径都能解析
3. **命名导入必须真的被目标模块导出**（删除/重命名导出时最容易留下悬空导入，
   而浏览器只会静默不启动 SW）
4. `src/lib/` 里没有 `chrome.*`（守护 D6）
5. **UI 发出的每个消息类型都有对应的后台 handler**（契约只靠字符串维系，写错浏览器不报错）
6. HTML 引用的 css/js 都存在

最关键的测试是 `tests/pac-generator.test.js`：它用 `node:vm` 建沙箱、注入 PAC 内置函数的桩，
然后**真的执行**生成出来的脚本，逐项断言轮询顺序、测速路由、禁用节点被跳过、
不支持的协议绝不出现、非法正则被隔离、异常兜底等行为。

后台层的测试同样不满足于「函数被调用过」：`tests/background.test.js` 会把
`chrome.proxy.settings.set` 收到的 PAC 原文取出来，丢进同一个 `node:vm` 沙箱执行，
以此断言「测速连续失败 → 节点被自动禁用 → 重新注入的 PAC 真的不再选中它」这条链路。
`src/background/` 的模块在导入时就会读 `chrome.storage.local`，所以测试必须**先装替身再动态导入**。

