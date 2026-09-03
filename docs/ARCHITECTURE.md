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
│         │                 │          ┌───────▼───────────┐   │
│         │                 │          │ retry-coordinator │◄──┼── src/content/retry.js
│         │                 │          │ 该不该换个代理重发 │   │   （隔离世界，<img>）
│         │                 │          │                   │◄──┼── deep-bridge.js ◄─ deep-patch.js
│         └─────────────────┴──────────┴───────┬───────────┘   │   （隔离世界的桥）  （主世界补丁·D31）
│      state.js（配置缓存 + 运行时态）                           │
│      metrics-store.js（统计计数器 + 节流落盘）                  │
│      debug-store.js（开发者调试日志，默认关闭 · 决策 D25）     │
│      deep-retry-injector.js（按站点装卸主世界补丁 · 决策 D31）  │
└─────────────────────────────┬────────────────────────────────┘
                              │ 复用
┌─────────────────────────────▼────────────────────────────────┐
│ src/lib/（纯 JS，零 chrome 依赖，全量单测）                    │
│  constants  hash  schema  storage  ascii  pac-url             │
│  node-parser  node-model  rule-matcher  scheduler             │
│  pac-generator  logger  metrics  retry  fallback-proxy  debug-log│
│  deep-retry                                                   │
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
| **D10** | 全部失败后的行为可配 `fallback: block \| direct`，**默认 `block`（不直连）** | 1.4.3 及更早默认 `direct`，理由是「宁可图能显示，也不要一上来就整屏裂图」。这个默认值是错的，而且错得很安静：`direct` 让 PAC 返回 `PROXY a; DIRECT`，连不上代理时浏览器**静默改走直连** —— 图片照常显示、不派发 `error`，于是重试（D20）、深度重试（D31）、兜底代理（D23）**三样一次都不会触发**，而真实 IP 已经交给图源了。用户看到「一切正常」，实际上这个扩展存在的唯一理由已经失效。「装上之后什么都没发生」正是本项目反复吃过亏的那类故障（同 D13、D16），所以默认改成让失败**可见**：代理不通就裂图，再由重试链去救。代价是节点配错时会看到整屏裂图 —— 那是准确的反馈，不是缺陷。改默认只影响**新装与缺字段的配置**：`normalizeSettings` 保留显式写着的取值，老用户存的 `direct` 不动。见 [LIMITATIONS.md](LIMITATIONS.md) 第 17 节 |
| **D11** | 零构建、零依赖、原生 ESM | clone 后直接「加载解压缩的扩展」即可，没有 node_modules 供应链风险 |
| **D12** | 注入 PAC 时 `mandatory: false`，PAC 顶层 `try/catch` 兜底返回 `DIRECT` | 最坏结果是「不走代理」，绝不会是「整个浏览器断网」 |
| **D13** | 生成的 PAC **必须是纯 ASCII**：注释只写英文，数据经 `asciiJson()` 转义，域名经 `toAsciiHost()` 转 Punycode | `chrome.proxy` 会因为一个非 ASCII 字节就**整体**拒绝 `pacScript.data`，而拒绝之后浏览器照旧直连、图片照样加载 —— 故障表现为「扩展安静地什么都没做」，极难自查。见 [LIMITATIONS.md](LIMITATIONS.md) 第 11 节 |
| **D14** | 统计**只存聚合计数器，不存请求明细** | 事件流的体积随使用时长无界增长，早晚要配淘汰策略甚至 IndexedDB。而「总量 / 成功率 / 哪个节点在干活 / 哪条规则从没命中」全都能用 O(1) 的整数回答。于是占用只随节点数与规则数增长，与运行时长无关 |
| **D15** | 计数写入**节流落盘**（≥5 秒或攒够 50 次改动），日志写入同样节流（3 秒） | 计数发生在 `webRequest.onCompleted` 上，一个漫画页能打出几百个图片请求。代价是 Service Worker 被回收时最多丢一个窗口的数据 —— 统计不是账本，用这点精度换掉几百倍写放大是划算的 |
| **D16** | **一切判定只能依赖 scheme + host + port**：URL 形态的规则一律附带退化形式；测速改为「串行 + 为单个节点单独注入定向 PAC」 | Chromium 在调用 PAC 前会清掉 https/wss 的 path 与 query（`SanitizeUrl`，52 起，无法关闭）。依赖路径的规则和「把节点 id 写进测速 URL query」这两件事因此双双静默失效：规则不命中就直连、图片照样加载，测速则测到的是直连延迟 —— 表现为「统计说走了 277 次代理，代理后台一条连接都没有」。详见 [LIMITATIONS.md](LIMITATIONS.md) 第 12 节 |
| **D17** | 「命中规则」与「按规则送去代理」是**两个不同的量**，统计里分别记为 `total` 与 `routed`，差值单列为 `blind` | 这两个量在 1.2.0 里是同一个数字，于是统计成了故障的帮凶而不是线索。分开之后，`blind` 不为零就直接指向「有规则写成了 PAC 判定不了的形态」 |
| **D18** | 归因**只在对端 IP 唯一指向一个节点时**才落到该节点；匹配到多个就计入 `unattributed` 并说明原因。另设 `viaNodeIp` 回答「是不是真从代理回来的」 | `webRequest` 只给对端 IP，不给端口。而「一台机器几十个端口、每个端口一个出口」是最常见形态，这种配置下节点的 `host` 全都相同。取第一个匹配会把全部用量记到列表里第一个节点上，面板显示「1 个节点 100%、其余全 0」，看起来像轮询坏了 —— 分不出来就该说分不出来。见 [LIMITATIONS.md](LIMITATIONS.md) 第 13 节 |
| **D19** | 测速全程持一把**互斥锁**，重复触发直接拒绝 | 串行定向之后一份 PAC 只能指向一个节点，两轮测速重叠时后一轮会覆盖前一轮的定向，「测 A 的请求」实际走了 B。而串行测速可能要跑几十秒，用户重复点击很正常 —— 宁可明确拒绝，也不要给出一个错的延迟 |
| **D20** | 重试 = **内容脚本重新给 `<img>` 赋值 `src`**，而不是让 PAC 返回一串代理 | PAC 可以返回 `PROXY a; PROXY b; DIRECT` 让浏览器自己往下试，但那样 a 挂掉时它名下的**全部**流量都会压到 b 上，而 PAC 的轮询计数器根本不知道发生过失败，下一个请求的链首恰好也是 b —— b 干两份活。这个扩展存在的唯一理由就是把请求摊到多个 IP 上，链式兜底偏偏在最需要均匀的时候破坏均匀性。重新发一次请求会触发一次新的 `FindProxyForURL`：轮询下标已经前进，而 Chromium 自带的坏代理列表也已经把刚连不上的那个排除掉了（第 5 节）。于是「跳过已经试过的代理」不需要在扩展里维护任何状态 |
| **D21** | 该不该重试**只在后台判定**，内容脚本一条规则都不持有 | 规则匹配、失败原因分类、次数上限全在 SW 一处。页面侧存一份规则副本的话，规则一改副本就过期，而过期的表现是「重试悄悄按旧规则在跑」—— 与 UI「不维护第二份状态」是同一条纪律 |
| **D22** | 重试只针对**代理层与连接层失败**；HTTP 4xx / 5xx 一律不重试 | 换个代理拿到的还是同一个 404，重发只是白给图源添一次请求。内容脚本只看得到「图裂了」，真正的原因在 `request-logger` 的失败原因表里（按 URL 暂存 30 秒）。查不到就保守放弃 —— `onErrorOccurred` 与渲染进程派发 `error` 没有顺序保证，宁可少救一张图 |
| **D23** | 兜底是**把该图源临时指向一个独立的 HTTP 代理**（定长 force 窗口 + 冷却），不是 URL 改写 | 1.4.x 的兜底是 URL 改写型图片服务（`?url=` 取图），那形态排除了用户手里最常见的东西 —— 一个自建的 HTTP 正向代理。两者协议不同：改写型服务收到的是源站形式的 `GET /?url=…`，正向代理等的是绝对形式的 `GET http://target/path` 或 `CONNECT`。把正向代理填进模板框，四种 URL 写法实测全是 `HTTP 400`，而旧的 `validateTemplate()` 三项检查全过 —— 开关显示开着、真用到时静默失败。<br>**为什么不用 PAC 链。** `PROXY a; PROXY fb` 会在重试**之前**生效：连不上 a 就当场切 fb 并成功，图片不派发 `error`，「先换几个轮询节点」永远执行不到，兜底退化成「第二个选项」，而轮询计数器对失败一无所知。这条老理由仍然成立，所以新方案走 PAC 里另一个东西 —— `force`（测速用的就是它）。<br>**代价是按「源」生效，不是按单张图。** https 的 path/query 到不了 PAC，同源的两次请求在它眼里一模一样，「只让这一张图换代理」表达不出来。所以兜底触发后开一扇 `FALLBACK_WINDOW_MS` 的窗口，窗口内该源的**所有**请求都走兜底代理，随后进入 `FALLBACK_COOLDOWN_MS` 冷却。冷却是必需的：否则轮询池持续失败时窗口几乎一直开着，整个图源长期只走一个 IP —— 这个扩展存在意义的反面。差距写在设置页上，不藏着 |
| **D34** | 兜底窗口的**过期时间写进 PAC**（`force[i].until`），不只靠后台定时器 | Service Worker 随时会被回收。若撤销只靠定时器，SW 死在窗口期内就等于「这个源被永久钉在兜底代理上」，而且没有任何东西会来撤销它 —— 用户看到的是「扩展好像不轮询了」。把绝对时间戳编进 PAC 之后，PAC 自己到点失效，后台的重注入降级成清理而非正确性依赖。测速条目用 `until: 0`（不过期），它的生命周期由 `applyProbePac` 显式控制。冷却状态只在内存里，SW 重启后丢失 —— 方向刻意偏向「可用」而不是「抑制」 |
| **D24** | 重试统计**只记内容脚本回报的观测值** | `retry.recovered` 是「重发之后真的收到了 load 事件」，不是「大概成功了」。同时必须明说重试会抬高 `requests.total` —— 重发就是一次新请求，`webRequest` 会照实再记一笔，于是成功率会比不开重试时低 |
| **D25** | 开发者调试日志**另开一路**，不动 `lib/logger.js` 那份活动日志；缓冲**只在后台**一份，页面侧批量回传；开关存 `storage.local` 的独立键、**不进 `config`**；默认关闭且调用点用 `if (dbg.on)` 守卫 | 活动日志是给用户看的功能（200 条、中文整句、弹窗常驻），把几百个请求的调试细节灌进去，几秒钟就会把「哪个节点在干活」冲干净。缓冲不能分散到页面侧：页面级存储每个 tab / iframe 一份，页一关就没，而这套日志的价值恰恰是把「后台判定」与「页面执行」拼成一条时间线。开关不进 `config` 有两个理由 —— 它不该被「导出配置」带给别人，而放在独立键上内容脚本与 UI 能直接读并监听变更，不必每写一行先问一次后台。守卫是必须的：只在函数里判断的话，关着时那个 `{ ...十个字段 }` 照样要构造，而热路径上一个漫画页有几百个请求 |
| **D26** | 统计**排除浏览器缓存命中**（`details.fromCache`），单列一格 | 缓存命中照样触发 `onCompleted`，而且 `details.ip` 给的是**上一次**连接的对端地址 —— 一次连网络都没走的读取看起来和一次成功的代理往返一模一样。1.4.0 没读这个字段，代价是同时污染了四个数字：总量（481 条事件只对应 236 个不同 URL）、成功率（缓存永远成功）、平均耗时（2ms 与 16s 搅成 1903ms）、以及「对端确认是代理」。缓存命中也**不计规则命中** —— 路由这次请求的是缓存，不是规则，与 `blind` 提前返回同一个道理。见 [LIMITATIONS.md](LIMITATIONS.md) 第 14 节 |
| **D27** | 耗时除平均值外**存固定桶的直方图**，面板主推 p50 / p90 | 平均值对长尾没有抵抗力：实测首次请求 p50 是 1243ms、p90 是 15788ms，而平均值 3579ms 既不代表典型体验也不反映最糟情况。直方图是 10 个整数、桶边界写死在代码里，所以 D14「体积与运行时长无关」仍然成立。代价是分位数只精确到桶内插值，落进溢出桶时只报下界 —— **不编一个精确值**。见 [LIMITATIONS.md](LIMITATIONS.md) 第 15 节 |
| **D28** | 「网络层失败了但页面没来问」计为 `retry.unseen`，由后台在宽限期（3 秒）后判定 | 只有 DOM 里的 `<img>` 会派发可捕获的 error，而阅读器常用 `new Image()` 预加载 —— 那种失败内容脚本永远看不见。实测 13 次失败有 3 次属于此类，而这类失败以前**不产生任何计数**：既不是「重试了」也不是「判定为不重试」，于是面板「未重试」显示 0，读起来像「每次失败都重试了」。判定必须由后台做，因为页面根本没有机会开口。**两条路径没有顺序保证，所以要挡两个方向**：页面后到 → `planRetry` 入口撤销计时；页面先到 → 记一条时间戳，失败落地时看到它就不再计时（只挡后者会稳稳数出一个不存在的「没人来问」）。SW 被休眠吃掉个别计数是可接受的 —— 这一格要回答的是「重试对这个站点是不是整体无效」，是量级信号不是账本 |
| **D29** | 重发之后既无 `load` 也无 `error` 的，由内容脚本超时（25 秒）判定为 `retry.abandoned`；未定案的单列 `retry.pending` | 元素被页面换掉或导航走之后，渲染进程不再派发任何事件，这次重发的结局**永远不会有人回报**。实测 attempted=7 / recovered=6，差的那 1 次正是如此。不单列的话四个格子加起来比 attempted 少 1，而那 1 次在面板上无处可查。阈值取 25 秒是因为实测最慢的真实请求是 18.2 秒 —— 必须明显大于它，否则会把「只是很慢」误判成「没有结论」。页面切到后台时额外结清一次：导航走是这类悬空最常见的成因，等满 25 秒往往等不到 |
| **D30** | 连接层就失败的请求**不计入 `unattributed`** | 那一格的含义是「拿到了响应却认不出是哪个节点」。`ERR_CONNECTION_CLOSED` 压根没有对端 IP，谈不上归因失败。1.4.0 把 13 次这样的失败也算了进去，于是那一格显示 481、恰好等于请求总数，看起来像归因彻底失灵 |
| **D31** | 深度重试的主世界补丁**只按站点动态注册**（`chrome.scripting`），绝不静态声明 | 静态声明只能写死 `matches`，要按用户清单收窄就只有 `<all_urls>` + 运行时自查一条路 —— 那样所有页面都被注入了主世界代码，[LIMITATIONS.md](LIMITATIONS.md) 第 16、19 节担心的事一件没少。更硬的问题是时机：补丁必须在自己被执行的第一个同步 tick 里就包住 `window.fetch`（页面脚本随时会把它取走存到别处），而「这个站点勾了没有」得跨桥异步问后台，等答案回来早就晚了。所以**装不装必须由注册时机决定，不能由运行时判断决定**。注册状态由 `applyProxy()` 统一同步，而不是散落在十几个改配置的 handler 里 —— 那样漏掉一处的表现是「清单改了、注入范围没跟上」 |
| **D32** | 桥把页面来的消息**当不可信输入**处理，**不做 nonce** | 主世界补丁与页面脚本共享同一个 JS 环境：页面读得到补丁里的一切，任何在补丁里生成或接收的密钥页面同样读得到 —— nonce 在这里是安全剧场。真正的防线是两条：**归属由后台裁决**（`planRetry()` 一进门就 `matchPacUrl()`，不是本扩展路由出去的一律 give-up），以及**每页 500 次硬上限**（防止页面把桥当成打 SW 的放大器）。残余风险（能探测某地址是否命中规则、能刷高计数）写进了 [LIMITATIONS.md](LIMITATIONS.md) 第 20 节，且只在用户显式勾选的站点上成立 |
| **D33** | 补丁**只重发 GET / HEAD** | 重复提交的代价不对称：漫画站的图源与列表接口几乎全是 GET，覆盖率损失极小，而一次被重发的「发评论」是用户账号上真实发生了两次的事，且事后极难归因。判断按调用点取（`init.method` / `Request.method` / `open()` 的第一个参数），`Image` 天然是 GET。<br>1.4.x 还额外禁止 `fetch` / `XHR` 走兜底 —— 那条限制随 D23 一起消失了：旧兜底按 `?url=` 取图，把一个 JSON 接口套进去毫无意义；新兜底是传输层换代理，对接口和图片一样有效，于是三条路（`fetch` / `XHR` / `Image`）在兜底面前一视同仁 |
| **D35** | 「规则之外的流量」是一项**显式设置**（`settings.defaultProxy`），默认直连；PAC 的无命中分支返回它而不是硬 `DIRECT` | `chrome.proxy.settings.set()` 替换的是浏览器**整份**代理配置，包括「使用系统代理设置」。所以 PAC 里那句「没命中就 `return 'DIRECT'`」不是一个无关紧要的默认值 —— 它替用户撤掉了他原来的上网通路。对靠本机代理客户端上网的人，症状是**图片站一切正常、其余网站全部 `ERR_CONNECTION_TIMED_OUT`**，而扩展一个错都不报（它确实按规则做了该做的事）。这又是一次「装上之后看起来正常，实际上坏了别的东西」，同 D10、D13、D16。<br>**为什么必须由用户填。** Chrome 对 `mode: 'system'` 只回一个 `'system'` 字符串，**不给服务器地址**（刻意的隐私设计），没有任何扩展 API 读得到系统代理指向哪里 —— 自动继承这条路根本不存在。<br>**默认仍是直连**，因为改默认等于给每个老用户凭空插一个代理出口；不用代理客户端的人本来就该直连。代价是这个坑对新用户仍存在一次，所以补了第二道：从「未接管」变成「接管」的那一刻读一次原有 `mode`（**只有这一个瞬间读得到**，之后 `get()` 永远回 `pac_script`），原来不是 `direct` 而又没配默认代理时写一条 warn 日志说出会看到什么现象，状态页也单列一行「规则之外的流量」。<br>**绕过列表与私有网段仍然硬直连**，排在默认代理之前：把 `127.0.0.1` / `192.168.*` 送进代理是纯粹的错误，这也保证了用户自己的代理客户端与节点主机始终可达。兜底代理（D23）是另一件事 —— 它只在一张图用尽重试后对该源短暂开窗，两者只共用地址语法与 token 格式化。见 [LIMITATIONS.md](LIMITATIONS.md) 第 6.1 节 |
| **D36** | 慢图看门狗：内容脚本捕获 `<img>` 的 `loadstart`，真实请求超过 `retry.slowTimeoutMs`（默认 12 秒）仍无结果时以 `cause:'slow'` 问后台并换节点 | 代理“慢但活着”不会派发 error，失败驱动重试（D20）整条链都碰不到它；测速只能量“连上代理要多久”，量不出“一张图多久才下得完”，而且节点多时串行测速本身就很慢。所以看门狗直接量真实图片请求的墙钟时间，并沿用后台同一套规则/次数/兜底判定（D21）。它只覆盖 DOM `<img>` —— 游离 `new Image()`、fetch/XHR 仍由深度重试（D31）覆盖；CSS 背景图与 canvas 依旧无解。**自己换节点会中止旧请求，旧请求的 abort/error 必须压到新请求的 `loadstart` 之后**，否则一次切换会被错记成一次失败。统计里单独记 `retry.slow`，与失败驱动的 `attempted` 正交 |

---

## 一次图片请求的完整生命周期

1. 页面发起 `https://cdn.manga.com/001.jpg` 的图片请求。
2. 浏览器**净化** URL，然后调用 PAC 的 `FindProxyForURL(url, host)`。
   https 请求到这一步只剩 `https://cdn.manga.com/` —— path 与 query 已被剥掉（决策 D16）。
3. PAC 依次判断：
   1. `force` 列表里有条目的前缀匹配当前 URL、且未到 `until` → 强制返回该条目的 token（无兜底）。
      测速定向（`until: 0`，见 D3）与兜底窗口（`until` 为绝对时间戳，见 D23 / D34）共用这一格
   2. 总开关关闭 → 「规则之外的流量」那一项（配了默认代理就是它，否则 `DIRECT`）。
      走到这一步只可能是测速用的 PAC —— `applyProxy()` 在关闭时直接撤销设置，一个字节都不注入
   3. 主机命中绕过列表 / 单段主机名 / 私有网段 → **硬 `DIRECT`**，不受默认代理影响（D35）
   4. 逐条匹配规则池：先按规则字面语义匹配，未命中且 URL 被净化过时再试一次退化形式；
      命中则取出该规则对应的节点 token 数组
   5. **一条都没命中 → 「规则之外的流量」那一项**（决策 D35）。这一格决定的是用户其余所有
      流量的出口 —— 返回硬 `DIRECT` 会把浏览器原有的系统代理整块顶掉
   6. 用模块作用域的计数器取一个 token，按 `rotateEvery` 决定是否前进
   7. `fallback === 'direct'` 时返回 `"PROXY 1.2.3.4:8080; DIRECT"`，否则不带兜底。
      这里是字面 `DIRECT` 而不是默认代理：那个设置的选项写着「直连原图」，改道等于让它名不副实
4. 网络栈按返回值连接代理。若代理要求认证 → `onAuthRequired` 按主机端口匹配节点、兜底代理
   或默认代理并自动应答。
5. 请求完成 → `webRequest.onCompleted` 观测到状态码与**对端 IP**（走代理时对端就是代理本身）。
   先看 `details.fromCache`：命中缓存的直接单列一格走人 —— 它一个字节都没出去，而浏览器
   给的 `ip` 还是上一次连接的地址，不拦住就会同时污染总量、成功率、耗时与「对端确认是代理」
   （决策 D26）。
   剩下的做两次匹配：`matchPacUrl()` 回答「真的走代理了吗」，`matchUrl()` 回答「用户想代理它吗」。
   前者不中、后者中的记为 `blind`（决策 D17）。
   归因按对端 IP 反查节点，唯一命中才落到该节点；多个节点共用地址时只记 `viaNodeIp`（决策 D18）。
   耗时同时进平均值与固定桶直方图，面板由后者算 p50 / p90（决策 D27）。
   请求在连接层就失败时走 `onErrorOccurred`：照常计入总量与失败数，但**不进 `unattributed`**
   （没有对端 IP，谈不上归因失败，决策 D30），并开始计时等内容脚本来问（决策 D28）。
6. 状态弹窗每 2 秒拉一次日志与统计并刷新展示；设置页只在「统计」那一屏可见时每 5 秒拉一次。

---

## 一张图裂了之后（重试链，决策 D20–D24、D28–D29）

```
① 节点 A 连不上 → 浏览器在 <img> 上派发 error
        │
        │ src/content/retry.js 在 document 捕获阶段收到（error 不冒泡，只能这样挂）
        │
        │ ⚠ 只有 DOM 里的 <img> 会走到这一步。new Image() 预加载、canvas、
        │   fetch 取 blob 的阅读器都收不到 —— 后台等 3 秒没人来问就记 retry.unseen
        │   （决策 D28）。实测某漫画站主要流量正属于这一类
        ▼
② 问后台 imageRetryAsk{url, attempt}
        │
        │ retry-coordinator 先撤销上面那个「没人来问」的判定，再凑齐三件事：
        │   · matchPacUrl() —— 这张图真的是本扩展路由出去的吗
        │   · observedFailure() —— webRequest 看到的失败原因（表里查不到就等 150ms 再查）
        │   · settings.retry / settings.fallbackProxy
        │ 判定本身在 lib/retry.js（纯函数）
        ▼
③ ├─ 不匹配规则               → give-up，**不计数**（别人网站的裂图不该进你的统计）
  ├─ 原因是 404 / 原因不明   → give-up，计入 retry.skipped
  ├─ attempt < maxAttempts   → retry，计入 retry.attempted
  └─ attempt >= maxAttempts  → 兜底可用则开窗 + 注入 PAC 后回 fallback，否则 give-up；
                               该源在冷却期内一律 give-up（记 fallbackProxy.cooldown）。
                               三种结局都计入 retry.exhausted
        │
        ▼
④ 内容脚本等 delayMs（默认 300ms，让 Chromium 把坏代理登记进它自己的列表），然后
   · retry    → img.src = img.src（同值赋值也会触发全新请求，**不加缓存穿透参数**）
   · fallback → 一模一样的原地重发；换的是**后台那一侧**（该源已被 force 指向兜底代理）
   同时挂一个 25 秒的超时，兜住「既没 load 也没 error」的情况（决策 D29）
        │
        ▼
⑤ 新请求 → 浏览器重新调用 FindProxyForURL → retry 走轮询下标（已前进）→ 节点 B
                                          → fallback 命中 force 条目 → 兜底代理
        │
        ▼
⑥ load     → imageRetryResult{ok:true}  → retry.recovered / fallbackProxy.ok
   error    → imageRetryResult{ok:false} → 回到 ②（兜底自己失败时到此为止，不再套娃）
   都没有   → 超时或页面切到后台时 imageRetryResult{ok:null} → retry.abandoned
```

三条结局路径都经过内容脚本的 `settle()`，而它**只结算一次** —— load 与超时撞车时
同一次重发会有两个结论，那会让 recovered 与 abandoned 一起变成假数字。

**一个请求始终只挂一个代理**，所以重试不会让轮询变得不均匀 —— 这正是不用 PAC 代理列表的原因（D20）。

**页面侧有两道刹车**：单页最多重试 500 次（触顶会上报一次，写进活动日志，不悄悄停下）；
同时挂起的询问不超过 16 个。后台侧还有一道：同一域名的重试日志每分钟只写一行，
次数去统计里看 —— 不然一个漫画页几秒就能把环形日志冲干净。

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
  fallback: 'direct'|'block',      // 全部失败后：直连原图 / 不直连
  rotateEvery: number,
  retry: {
    maxAttempts: number,           // 每张图最多尝试几个节点，**含首次**。1 = 不重试
    delayMs: number,               // 重发前等多久（给坏代理列表留登记时间）
    slowTimeoutMs: number,         // 图片加载看门狗（0=关闭，默认 12000ms；决策 D36）
  },
  fallbackProxy: {                 // 兜底代理（独立于节点列表，决策 D23）
    enabled: boolean,              // 地址不可用时规范化会强制置 false
    raw: string,                   // 用户填的原文，例如 http://10.0.0.3:37581
    protocol: 'http'|'https',
    host: string,
    port: number,
    username: string,              // 认证走 onAuthRequired，PAC 里写不了凭据
    password: string,
  },
  defaultProxy: {                  // 规则之外的流量走谁（决策 D35）。形状与 fallbackProxy 完全相同
    enabled: boolean,              // false = 直连（默认）。地址不可用时同样强制置 false
    raw, protocol, host, port, username, password,
  },
  probe: { url, timeoutMs, intervalMinutes, autoDisable, failureThreshold, recoverProbe },
  logLimit: number,
  bypassList: string[],
}
```

**`fallback: 'direct'` 与重试是互斥的。** 选「直连原图」时，代理连不上会被浏览器静默改走
直连 —— 图片正常显示、不派发 `error`，于是内容脚本什么都收不到，重试与兜底代理一次都不会
触发，而真实 IP 已经交给图源了。设置页对这个组合有一条常亮的告警（`renderRetryWarning()`），
新装默认仍是 `direct`（安全优先，D12），不替用户偷偷改。

运行时状态（日志、轮询起点、控制权）存 `chrome.storage.session`，丢了不影响功能。

**开发者调试日志**（决策 D25）分两处存放，刻意都不在 `config` 里：

```js
// chrome.storage.local 的 `debug` 键 —— 只有开关，不进配置导出
{ enabled: boolean, since: ?number }

// chrome.storage.session 的 `debugLog` 键 —— 缓冲快照，浏览器重启即清空
[{ at: number, ns: string, ev: string, data: object }, …]
```

`ns` 取自八个闭集合命名空间：`pac` / `probe` / `request` / `retry` / `config` / `msg` /
`content` / `ui`（外加兜底的 `misc`）。上限 20000 条 + 4 MB，先到先限，超出丢最早的；
落盘同样节流（3 秒或 200 条）。开关放在 `storage.local` 是为了让内容脚本与 UI 页面能
**直接读并监听 `onChanged`** —— 否则每写一行都要先问一次后台「现在该记吗」。

统计计数器另存在 `chrome.storage.local` 的 `metrics` 键下，**跨浏览器重启累计**：

```js
Metrics {
  since: ?number,              // 首次计数的时刻，面板显示「自 X 起累计」
  requests: {                  // 只统计命中了用户规则、且**真的走了网络**的请求
    total, ok, fail, aborted,  // aborted = 页面/用户主动取消（ERR_ABORTED），不算失败
    latencySum, latencyCount,  // 分开存，才能既算平均值又不把「没测到」当 0
    unattributed,              // 拿到了响应、却按对端 IP 认不出是哪个节点的次数（决策 D18/D30）
    blind,                     // 命中规则、但 PAC 判定不了因而必然直连的次数（决策 D17）
    viaNodeIp,                 // 对端 IP 属于某个节点的次数 —— 分不出是哪个时照样成立（决策 D18）
    cached,                    // 缓存命中，一个字节都没出去。不进上面任何一项（决策 D26）
  },
  latency: number[10],         // 耗时直方图，桶边界见 LATENCY_BUCKETS_MS。面板由它算 p50/p90（决策 D27）
  perNode: { [nodeId]: { used, ok, fail } },
  perRule: { [ruleId]: { hits } },   // 只记真的路由出去的命中（缓存命中不算规则在干活）
  retired: { nodeUsed, nodeOk, nodeFail, ruleHits },  // 已删除实体的历史量

  // 重试（决策 D24）。全是观测值，没有一个是推断出来的
  retry: {
    // 三个「判定」口径互不重叠，合起来 = 后台被问过多少次
    attempted,   // 判定为重发并交给页面执行（执行前被移除时由 abandoned 结清）
    exhausted,   // 轮询节点已用尽（独立判定；兜底是否救回由 fallbackProxy 另记）
    skipped,     // 不该重试：不归本扩展管 / 原因不是代理故障 / 查不到原因

    // 两个「结局」口径，描述 attempted 那些后来怎么了
    recovered,   // 重发之后收到了 load —— 不是「大概成功了」
    abandoned,   // 重发/计划重发没等到结果：元素被换掉、页面导航走或看门狗换下一轮（决策 D29）

    // 这一个根本不在上面的账里 —— 它连「被问过」都没发生
    unseen,      // 网络层失败了，但页面侧压根没捕获到（决策 D28）
    slow,        // 看门狗触发后真的换了节点/兜底代理的次数（决策 D36）
  },
  // 开窗放行时记 used；冷却期内本该兜底却没兜的记 cooldown（两者不重叠）
  fallbackProxy: { used, ok, fail, cooldown },

  probe:  { ok, fail, lastAt },
  apply:  { ok, fail, lastAt, lastError },
}
```

`recovered + abandoned ≤ attempted`，差额就是面板上的 `retry.pending`。
`exhausted` 是「用尽」的独立判定，不属于某次 attempted 的结局，不能从差额里再扣。
**上一版没有 `abandoned` 与 `pending`**，
于是实测「重发 7 次、救回 6 次」里那 1 次差额在界面上完全找不到（决策 D29）。

**`latency` 是直方图而不是样本。** 10 个整数、桶边界写死在代码里，所以 D14「体积与
运行时长无关」仍然成立；代价是分位数只精确到桶内插值，落进溢出桶时只报下界。
之所以值得加，是因为平均值对长尾没有抵抗力：实测 p50 是 1243ms、p90 是 15788ms，
而平均值 3579ms 两头都不代表（决策 D27）。

**开启重试会抬高 `requests.total`。** 重发就是一次全新的请求，`webRequest` 会照实再记一笔，
所以成功率会比不开重试时低。`retry.attempted` 就是用来对账的，这句话也写在了统计页上 ——
统计口径变了却不说，比数字难看得多。

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
| `lib/debug-log.js` | 开发者调试日志的缓冲：条数与字节双上限、按命名空间分组、格式化成可落盘的文本（纯逻辑，决策 D25） |
| `lib/metrics.js` | 统计计数器：累加、剪枝、汇总成视图模型（纯逻辑） |
| `lib/retry.js` | 失败原因分类与重试判定（纯函数，决策 D22） |
| `lib/fallback-proxy.js` | 兜底代理地址的解析、校验与 PAC token（纯函数，决策 D23） |
| `lib/default-proxy.js` | 默认代理：规则**没**命中时走谁。解析、校验与 PAC token（纯函数，决策 D35） |
| `lib/proxy-address.js` | 「一行地址」→ 代理对象的唯一解析实现，兜底代理与默认代理共用（只有两处措辞按角色不同） |
| `lib/proxy-token.js` | 代理地址 → PAC token 的唯一实现，节点、兜底代理与默认代理共用 |
| `lib/deep-retry.js` | 深度重试站点清单 → match pattern 的规范化与校验；非法条目带原因单列（纯函数，决策 D31） |
| `background/state.js` | 配置缓存与运行时态 |
| `background/metrics-store.js` | 统计的持久化：节流落盘 + 落盘前剪枝 |
| `background/debug-store.js` | 调试日志缓冲的唯一持有者：读开关、接页面回传、节流落盘、产出导出文件（决策 D25） |
| `background/proxy-controller.js` | 全扩展唯一写浏览器代理设置的地方 |
| `background/health-monitor.js` | 测速、超时判定、自动禁用、定时任务 |
| `background/request-logger.js` | 只读观测请求结果，计入统计，并按 URL 暂存失败原因供重试判定查询 |
| `background/retry-coordinator.js` | 内容脚本的唯一对话人：凑齐入参、调用判定、写统计与日志（决策 D21） |
| `background/deep-retry-injector.js` | 主世界补丁的装卸：按站点清单动态注册/注销两个内容脚本，由 `applyProxy()` 统一驱动（决策 D31） |
| `background/auth-provider.js` | 代理认证自动应答 |
| `background/messaging.js` | UI / 内容脚本与后台之间唯一的契约 |
| `background/service-worker.js` | 事件注册与启动流程 |
| `content/retry.js` | 页面侧执行端：捕获 `<img>` 的加载生命周期，为超时未完成的图启动看门狗（决策 D36）、捕获 error、问后台、重新赋值 `src`、回报结果。**classic script，不能有 import**（MV3 的 content_scripts 不支持 ESM） |
| `content/deep-bridge.js` | 隔离世界的桥：把主世界的消息转给后台。唯一持有 `chrome.runtime` 的一侧，也是信任边界（决策 D32）。**classic script** |
| `content/deep-patch.js` | **主世界**补丁：包住页面的 `fetch` / `XMLHttpRequest` / `Image`，失败时隔着桥问后台再重发。只重发 GET/HEAD（决策 D33）。**classic script** |

**一条纪律**：任何改动了节点、规则、开关或健康状态的代码路径，结束前都必须调用
`applyProxy()`，否则 PAC 里的节点池会和实际配置脱节 —— 深度重试的注入范围也挂在
同一处同步（决策 D31），道理相同。

---

## 测试策略

```bash
npm test    # 710 个测试（单元 + 集成 + 后台编排 + SW 冒烟 + 打包 + UI 契约）
npm run check
```

五层测试，逐层放大覆盖面：

| 层 | 文件 | 手法 |
|---|---|---|
| 纯逻辑单元 | `tests/{storage,node-parser,node-model,rule-matcher,scheduler,logger,ascii,metrics,pac-url,retry,fallback-proxy,debug-log}.test.js` | 直接调 `src/lib/`，零依赖 |
| PAC 行为 | `tests/pac-generator.test.js` | `node:vm` 沙箱**真的执行**生成的脚本 |
| 内容脚本行为 | `tests/content-retry.test.js` | `node:vm` 沙箱 + 约 50 行 DOM 替身，**真的执行**内容脚本 |
| 主链路集成 | `tests/integration.test.js` | 从「用户粘贴的文本」一路跑到「PAC 做出路由决策」 |
| 后台编排 | `tests/background.test.js`、`tests/retry-coordinator.test.js`、`tests/service-worker.test.js` | `tests/helpers/chrome-stub.js` 提供 `chrome.*` 与 `fetch` 替身 |
| 调试日志 | `tests/debug-store.test.js`、`tests/debug-wiring.test.js`、`tests/ui-debug.test.js` | 前者验编排（开关传导、节流、导出形状），中间那份走真实链路后**从导出的文件正文里**断言调用点真的在记，最后一份钉住页面侧的自噬防护 |
| UI 契约 | `tests/ui-{tokens,contract,status,components,density}.test.js` | 静态解析 CSS/HTML/JS；组件构造器用极小 DOM 替身 |
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
1. `manifest.json` 合法且是 MV3，引用的每个文件真实存在（含 `content_scripts`）
2. `src/` 下所有相对 `import` 路径都能解析
3. **命名导入必须真的被目标模块导出**（删除/重命名导出时最容易留下悬空导入，
   而浏览器只会静默不启动 SW）
4. `src/lib/` 里没有 `chrome.*`（守护 D6）
5. **UI 与内容脚本发出的每个消息类型都有对应的后台 handler**（契约只靠字符串维系，写错浏览器不报错）
6. HTML 引用的 css/js 都存在
7. **内容脚本里没有 `import` / `export`** —— MV3 的 `content_scripts` 不支持 ESM，
   有一句就整个脚本注入失败，而失败的表现是「重试功能安静地不生效」

最关键的测试是 `tests/pac-generator.test.js`：它用 `node:vm` 建沙箱、注入 PAC 内置函数的桩，
然后**真的执行**生成出来的脚本，逐项断言轮询顺序、测速路由、禁用节点被跳过、
不支持的协议绝不出现、非法正则被隔离、异常兜底等行为。

后台层的测试同样不满足于「函数被调用过」：`tests/background.test.js` 会把
`chrome.proxy.settings.set` 收到的 PAC 原文取出来，丢进同一个 `node:vm` 沙箱执行，
以此断言「测速连续失败 → 节点被自动禁用 → 重新注入的 PAC 真的不再选中它」这条链路。
`src/background/` 的模块在导入时就会读 `chrome.storage.local`，所以测试必须**先装替身再动态导入**。
