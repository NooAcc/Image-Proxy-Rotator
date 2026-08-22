# 架构说明

## 总览

```
┌──────────────────────────────────────────────────────────────┐
│ 设置页 (options)                 状态弹窗 (popup)             │
│  统计 / 节点 / 规则 / 分流 / 诊断  开关 / 测速 / 节点 / 规则 /  │
│                                   活动 / 统计                 │
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
│      state.js（配置缓存 + 运行时态）                           │
│      metrics-store.js（统计计数器 + 节流落盘）                  │
└─────────────────────────────┬────────────────────────────────┘
                              │ 复用
┌─────────────────────────────▼────────────────────────────────┐
│ src/lib/（纯 JS，零 chrome 依赖，全量单测）                    │
│  constants  hash  schema  storage  ascii  pac-url             │
│  node-parser  node-model  rule-matcher  scheduler             │
│  pac-generator  logger  metrics                               │
└─────────────────────────────┬────────────────────────────────┘
                              │ 生成 PAC 字符串（纯 ASCII，只依赖 scheme+host+port）
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
| **D3** | 测速 = 为目标节点**单独注入一份 PAC**，把测速地址所在的源强制路由到它，且**不加直连兜底**；测完恢复 | 测的是「浏览器经该代理到公网」的真实端到端链路，与图片请求同一条通路；没有兜底所以失败是真失败。定向信息不能放在 URL 的 query 里 —— https 的 query 根本到不了 PAC（D16），旧版正是因此每次测速都测到了直连的延迟。代价是一份 PAC 只能定向一个节点，测速由并发改为**串行** |
| **D4** | **只支持 HTTP / HTTPS 代理**，其余类型识别但不接纳 | 见 [LIMITATIONS.md](LIMITATIONS.md) 第 1 节。不支持的类型仍被识别，只为给出准确的中文提示 —— 识别而不接纳，比静默丢弃更不容易让用户困惑 |
| **D5** | 可用性判定收敛到 **`pacToken()` 单一出口** | 只有 `SUPPORTED_PROTOCOLS`（http/https）能拿到 token，其余返回 `null`。`isSelectable`、PAC 节点池、状态统计全都建立在它之上，因此不存在「某个不支持的协议从别的路径漏进轮询」的可能 |
| **D6** | 纯逻辑与 Chrome API **物理隔离**：`src/lib/` 不出现 `chrome.` | 让 PAC 生成、节点解析、规则匹配、调度这些最易错的部分能在 Node 里 TDD。`npm run check` 强制这条约束 |
| **D7** | PAC 生成器用 `node:vm` 沙箱**真的执行**生成出来的脚本来测 | 断言「脚本行为正确」而不是「字符串长得对」。字符串断言会在重构时全线崩溃 |
| **D8** | 自动禁用**只由测速结果驱动**；线上请求失败仅记日志 | 图片 404、站点 5xx、用户断网都会造成请求失败，据此禁用节点会把好节点全禁掉 |
| **D9** | 规则可绑定节点子集（空数组=全部） | 支持「A 图源用这批节点、B 图源用那批」；绑定的节点全不可用时自动回落到全部可用节点，避免图片直接裂开 |
| **D10** | 兜底可配 `fallback: direct \| block`，默认 `direct` | 默认让图片「至少能加载」优于「彻底裂图」；追求严格分流的用户可切 `block` |
| **D11** | 零构建、零依赖、原生 ESM | clone 后直接「加载解压缩的扩展」即可，没有 node_modules 供应链风险 |
| **D12** | 注入 PAC 时 `mandatory: false`，PAC 顶层 `try/catch` 兜底返回 `DIRECT` | 最坏结果是「不走代理」，绝不会是「整个浏览器断网」 |
| **D13** | 生成的 PAC **必须是纯 ASCII**：注释只写英文，数据经 `asciiJson()` 转义，域名经 `toAsciiHost()` 转 Punycode | `chrome.proxy` 会因为一个非 ASCII 字节就**整体**拒绝 `pacScript.data`，而拒绝之后浏览器照旧直连、图片照样加载 —— 故障表现为「扩展安静地什么都没做」，极难自查。见 [LIMITATIONS.md](LIMITATIONS.md) 第 11 节 |
| **D14** | 统计**只存聚合计数器，不存请求明细** | 事件流的体积随使用时长无界增长，早晚要配淘汰策略甚至 IndexedDB。而「总量 / 成功率 / 哪个节点在干活 / 哪条规则从没命中」全都能用 O(1) 的整数回答。于是占用只随节点数与规则数增长，与运行时长无关 |
| **D15** | 计数写入**节流落盘**（≥5 秒或攒够 50 次改动），日志写入同样节流（3 秒） | 计数发生在 `webRequest.onCompleted` 上，一个漫画页能打出几百个图片请求。代价是 Service Worker 被回收时最多丢一个窗口的数据 —— 统计不是账本，用这点精度换掉几百倍写放大是划算的 |
| **D16** | **一切判定只能依赖 scheme + host + port**：URL 形态的规则一律附带退化形式；测速改为「串行 + 为单个节点单独注入定向 PAC」 | Chromium 在调用 PAC 前会清掉 https/wss 的 path 与 query（`SanitizeUrl`，52 起，无法关闭）。依赖路径的规则和「把节点 id 写进测速 URL query」这两件事因此双双静默失效：规则不命中就直连、图片照样加载，测速则测到的是直连延迟 —— 表现为「统计说走了 277 次代理，代理后台一条连接都没有」。详见 [LIMITATIONS.md](LIMITATIONS.md) 第 12 节 |
| **D17** | 「命中规则」与「真的走代理」是**两个不同的量**，统计里分别记为 `total` 与 `routed`，差值单列为 `blind` | 这两个量在 1.2.0 里是同一个数字，于是统计成了故障的帮凶而不是线索。分开之后，`blind` 不为零就直接指向「有规则写成了 PAC 判定不了的形态」 |
| **D18** | 归因**只在对端 IP 唯一指向一个节点时**才落到该节点；匹配到多个就计入 `unattributed` 并说明原因。另设 `viaNodeIp` 回答「是不是真从代理回来的」 | `webRequest` 只给对端 IP，不给端口。而「一台机器几十个端口、每个端口一个出口」是最常见形态，这种配置下节点的 `host` 全都相同。取第一个匹配会把全部用量记到列表里第一个节点上，面板显示「1 个节点 100%、其余全 0」，看起来像轮询坏了 —— 分不出来就该说分不出来。见 [LIMITATIONS.md](LIMITATIONS.md) 第 13 节 |
| **D19** | 测速全程持一把**互斥锁**，重复触发直接拒绝 | 串行定向之后一份 PAC 只能指向一个节点，两轮测速重叠时后一轮会覆盖前一轮的定向，「测 A 的请求」实际走了 B。而串行测速可能要跑几十秒，用户重复点击很正常 —— 宁可明确拒绝，也不要给出一个错的延迟 |

---

## 一次图片请求的完整生命周期

1. 页面发起 `https://cdn.manga.com/001.jpg` 的图片请求。
2. 浏览器**净化** URL，然后调用 PAC 的 `FindProxyForURL(url, host)`。
   https 请求到这一步只剩 `https://cdn.manga.com/` —— path 与 query 已被剥掉（决策 D16）。
3. PAC 依次判断：
   1. 有测速定向且 URL 属于测速地址所在源 → 强制返回该节点的 token（无兜底，见 D3）
   2. 总开关关闭 → `DIRECT`
   3. 主机命中绕过列表 / 单段主机名 / 私有网段 → `DIRECT`
   4. 逐条匹配规则池：先按规则字面语义匹配，未命中且 URL 被净化过时再试一次退化形式；
      命中则取出该规则对应的节点 token 数组
   5. 用模块作用域的计数器取一个 token，按 `rotateEvery` 决定是否前进
   6. `fallback === 'direct'` 时返回 `"PROXY 1.2.3.4:8080; DIRECT"`，否则不带兜底
4. 网络栈按返回值连接代理。若代理要求认证 → `onAuthRequired` 按主机端口匹配节点并自动应答。
5. 请求完成 → `webRequest.onCompleted` 观测到状态码与**对端 IP**（走代理时对端就是代理本身）。
   这里拿到的是**完整** URL，所以要做两次匹配：`matchPacUrl()` 回答「真的走代理了吗」，
   `matchUrl()` 回答「用户想代理它吗」。前者不中、后者中的记为 `blind`（决策 D17）。
   归因按对端 IP 反查节点，唯一命中才落到该节点；多个节点共用地址时只记 `viaNodeIp`（决策 D18）。
6. 状态弹窗每 2 秒拉一次日志与统计并刷新展示；设置页只在「统计」那一屏可见时每 5 秒拉一次。

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
    egressIp: ?string,       // 测速时观测到的对端 IP（走代理时就是代理本身），用于给线上请求归因
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

运行时状态（日志、轮询起点、控制权）存 `chrome.storage.session`，丢了不影响功能。

统计计数器另存在 `chrome.storage.local` 的 `metrics` 键下，**跨浏览器重启累计**：

```js
Metrics {
  since: ?number,              // 首次计数的时刻，面板显示「自 X 起累计」
  requests: {                  // 只统计命中了用户规则的请求
    total, ok, fail,
    latencySum, latencyCount,  // 分开存，才能既算平均值又不把「没测到」当 0
    unattributed,              // 走了代理但按对端 IP 认不出是哪个节点的次数
    blind,                     // 命中规则、但 PAC 判定不了因而必然直连的次数（决策 D17）
    viaNodeIp,                 // 对端 IP 属于某个节点的次数 —— 分不出是哪个时照样成立（决策 D18）
  },
  perNode: { [nodeId]: { used, ok, fail } },
  perRule: { [ruleId]: { hits } },   // 只记真的路由出去的命中
  retired: { nodeUsed, nodeOk, nodeFail, ruleHits },  // 已删除实体的历史量
  probe:  { ok, fail, lastAt },
  apply:  { ok, fail, lastAt, lastError },
}
```

**为什么有 `retired`（决策 D14）。** 节点或规则被删掉后，它的键会在落盘前被剪掉，
量并入 `retired`。这同时解决两个问题：

1. **体积不随时间增长。** `perNode` / `perRule` 的键数恒等于当前配置里的实体数。
   若不剪枝，反复更换订阅列表会让已删节点的键永久堆积 —— 那才是真正无界的部分。
2. **占比的分母诚实。** 直接丢弃的话，各节点占比加起来不到 100%，用户会以为统计算错了。

满配（500 节点 + 500 规则，即 `MAP_CAP` 上限）实测 31.5 KB。`storage.local` 的配额是 10 MB
（Chrome 113 及更早为 5 MB），所以即便按下限算也只占 0.6% —— 不需要 `unlimitedStorage` 权限。

**规范化原则**：`schema.js` 保证「任何输入都能得到一份合法 Config」，`metrics.js` 的
`normalizeMetrics()` 对统计做同样的事。无法修补的单条记录直接丢弃（如端口越界的节点、
无法编译的正则），而不是让整份配置失效。

---

## 模块职责

| 文件 | 职责 |
|---|---|
| `lib/constants.js` | 默认配置、`SUPPORTED_PROTOCOLS`、统一提示文案 |
| `lib/hash.js` | FNV-1a 稳定哈希与 id 生成（不用随机数，保证重复导入 id 不变） |
| `lib/ascii.js` | ASCII 安全化：`asciiJson()` 转义、`toAsciiHost()` 转 Punycode（守护 D13） |
| `lib/pac-url.js` | 复刻浏览器交给 PAC 之前的 URL 净化，并从 URL 形态的规则里提取退化形式（守护 D16） |
| `lib/schema.js` | 持久化结构规范化，永不抛异常 |
| `lib/storage.js` | 读写、版本迁移、导入导出（StorageArea 注入，便于测试） |
| `lib/node-parser.js` | 节点链接与订阅解析；把每行分类为 节点 / 不支持 / 非法 / 注释 |
| `lib/node-model.js` | `pacToken()`（可用性唯一闸门）、`isSelectable()`、提示语生成 |
| `lib/rule-matcher.js` | 规则构造、校验、编译、匹配、退化形式、`matchPacUrl()`、`ruleWarnings()` |
| `lib/scheduler.js` | 节点池计算、轮询与哈希选择（PAC 之外的可测实现） |
| `lib/pac-generator.js` | 把配置编译成 PAC 脚本字符串（保证纯 ASCII） |
| `lib/logger.js` | 环形日志缓冲 |
| `lib/metrics.js` | 统计计数器：累加、剪枝、汇总成视图模型（纯逻辑） |
| `background/state.js` | 配置缓存与运行时态 |
| `background/metrics-store.js` | 统计的持久化：节流落盘 + 落盘前剪枝 |
| `background/proxy-controller.js` | 全扩展唯一写浏览器代理设置的地方 |
| `background/health-monitor.js` | 测速、超时判定、自动禁用、定时任务 |
| `background/request-logger.js` | 只读观测请求结果，并把结果计入统计 |
| `background/auth-provider.js` | 代理认证自动应答 |
| `background/messaging.js` | UI 与后台之间唯一的契约 |
| `background/service-worker.js` | 事件注册与启动流程 |

**一条纪律**：任何改动了节点、规则、开关或健康状态的代码路径，结束前都必须调用
`applyProxy()`，否则 PAC 里的节点池会和实际配置脱节。

---

## 测试策略

```bash
npm test    # 308 个测试（单元 + 集成 + 后台编排 + SW 冒烟 + 打包 + UI 契约）
npm run check
```

五层测试，逐层放大覆盖面：

| 层 | 文件 | 手法 |
|---|---|---|
| 纯逻辑单元 | `tests/{storage,node-parser,node-model,rule-matcher,scheduler,logger,ascii,metrics,pac-url}.test.js` | 直接调 `src/lib/`，零依赖 |
| PAC 行为 | `tests/pac-generator.test.js` | `node:vm` 沙箱**真的执行**生成的脚本 |
| 主链路集成 | `tests/integration.test.js` | 从「用户粘贴的文本」一路跑到「PAC 做出路由决策」 |
| 后台编排 | `tests/background.test.js`、`tests/service-worker.test.js` | `tests/helpers/chrome-stub.js` 提供 `chrome.*` 与 `fetch` 替身 |
| UI 契约 | `tests/ui-{tokens,contract,status,components}.test.js` | 静态解析 CSS/HTML/JS；组件构造器用极小 DOM 替身 |
| 打包产物 | `tests/pack.test.js` | 用另写一份的 zip 解析器把包拆回来逐字节比对 |

**一条不可违反的纪律（决策 D16 的教训）**：任何调用 `FindProxyForURL` 的断言都必须先经
`tests/helpers/pac-sandbox.js` 的 `browserUrl()` 走一遍。浏览器不会把完整的 https URL 交给
PAC，直接手写 `pac.find('https://a.com/1.jpg', 'a.com')` 的测试会给出与线上**相反**的结论。
1.2.0 就是这样发布的：271 个测试全绿，扩展一个请求都没代理出去。`browserUrl()` 刻意不复用
`src/lib/pac-url.js`，两套独立实现互为对照。

UI 这一层大部分没有 DOM 环境，所以只测**能静态判定、且出错时浏览器不会报警**的东西：

- `ui-tokens`：解析 `tokens.css`，对两套主题的关键配色对逐一算 WCAG 对比度
  （正文 ≥ 4.5:1、控件边框与焦点环 ≥ 3:1）。深色盘的亮绿 `#22C55E` 放到白底上
  当文字只有约 1.9:1 —— 这类「看着还行、实际读不清」的退化只有断言拦得住。
  同时检查页面 CSS 里 `var()` 引用的变量都有定义。
- `ui-contract`：HTML 与 JS 之间只靠 id 字符串维系，改名不会报错、只会安静地
  少渲染一块。断言 JS 取的 id 都存在、HTML 里没有孤儿 id、每个表单控件都有
  可访问名、不出现内联样式、侧栏 hash 与 `options.js` 的分区表逐项对齐，
  以及弹窗分段控件的按钮数 / CSS 列数 / `VIEWS` 表三处一致
  （漏改 CSS 的 `repeat(N)` 不会报错，只会把最后一个按钮挤出容器）。
- `ui-status`：节点状态必须「颜色 + 字形 + 文字」三重编码，断言任何两个状态的
  「字形 + 色调」组合都不重复。
- `ui-components`：装一个约 30 行的 `document` 替身（不引 jsdom，本项目零依赖），
  验 `kpi()` / `shareBar()` / `kvRow()` 的产物结构。重点是占比条：它用原生
  `<progress>`，填充量走 `value`/`max` **IDL 属性**；如果 `el()` 把它们写成
  attribute，条子会永远是空的而页面不报任何错。

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

