# 兜底代理：把「最后一道防线」从 URL 改写换成传输层

2026-08-24 · 取代 1.4.x 的「兜底图片代理」（决策 D23）

## 要解决的问题

1.4.x 的兜底是 **URL 改写**：轮询节点全试过之后，内容脚本把 `<img>` 的地址改成
`模板(原图地址)`，请求于是走一个按 query 取图的服务（wsrv.nl / imgproxy / 自建 Worker）。

这个形态排除了一整类用户已经有的东西 —— **一个自建的 HTTP 正向代理**。两者的协议不同：

| | 收到的请求行 | 谁会这么发 |
|---|---|---|
| 改写型图片服务 | `GET /?url=https%3A%2F%2F… HTTP/1.1`（源站形式） | 浏览器加载 `img.src` |
| HTTP 正向代理 | `GET http://target/path HTTP/1.1`（绝对形式）或 `CONNECT host:443` | 被配置为代理的浏览器 |

把正向代理填进模板框，实测四种 URL 写法全部 `HTTP 400`：

```
http://10.0.0.3:37581/?url=…      → 400, 0 字节
http://10.0.0.3:37581/{绝对URL}   → 400, 0 字节
http://10.0.0.3:37581/            → 400, 0 字节
http://10.0.0.3:37581/proxy?url=… → 400, 0 字节

对照 curl -x http://10.0.0.3:37581 → CONNECT 200 ✅
```

而 `validateTemplate()` 只查「有没有占位符 / 能不能被 `new URL()` 解析 / 协议是不是
http(s)」，这三项它全过 —— 于是 `enabled` 保持 true，界面不给任何提示，只在真的用到时
静默失败。这正是本项目最反感的那类故障。

## 为什么当年选了 URL 改写，以及那条理由现在怎么处理

决策 D23 的原话：HTTP 代理只能通过 PAC 表达，而 PAC 里的兜底会在**重试之前**生效 ——
`return "PROXY a; PROXY fb"` 时浏览器连不上 a 就当场切到 fb 并成功，图片根本不派发
`error`，于是「先换几个轮询节点再说」那一段永远执行不到。兜底从「最后一道防线」变成
「第二个选项」，而轮询计数器对失败一无所知，fb 会替所有挂掉的节点干活。

**这条理由完全成立，本设计不推翻它。** 新方案不用 PAC 链，用的是 PAC 里已经存在的另一个
东西：`force`。

## 唯一可用的机制：按「源」强制，而不是按请求

测速早就要解决同一个问题 —— 让某个特定请求走某个特定节点。它的做法是重新生成一份带
`force` 的 PAC：

```js
if (PP.force && url.indexOf(PP.force.pre) === 0) return PP.force.tok;
```

`pac-generator.js:40` 把代价写得很直白：

> 可 https 的 query 到不了 PAC，所以标记不能放在 query 里 —— 只能按「源」来认。
> 代价是测速期间对该源的所有请求都会被定向到目标节点；测速地址是专用探针端点，
> 不会有别的流量。

最后半句是测速能用而兜底不能照抄的原因：`i.nhentai.net` 上一次并发几十张图。所以

**「针对单张图的额外一次重试走指定代理」在 MV3 里表达不出来。** PAC 对 https 只看得到
`https://host/`，同一个源的两次请求在它眼里完全一样，无法区分「首次」与「用尽后的重试」。

能表达的最接近的东西是：**用尽后开一个短暂的时间窗，窗口内该源的全部请求都走兜底代理。**
这就是本设计采用的语义，也是它与用户原始描述之间唯一的差距，必须在设置页写明。

这个差距在实践中比听起来小：兜底触发的前提本来就是「这个源上的轮询节点刚刚连续失败了
N 次」，此时把同源的其他请求也送去兜底代理，往往正是当下最该做的事。

## 架构

```
内容脚本                后台                                    PAC
────────              ────                                    ───
图裂了
  └─ imageRetryAsk ──▶ planRetry()
                         ├─ matchPacUrl 不中 ──▶ give-up not-routed
                         ├─ decideRetry() 判定 retry ──▶ retry（换节点重发）
                         └─ decideRetry() 判定 fallback
                              └─ openFallbackWindow(url)
                                   ├─ 冷却中 ──▶ give-up exhausted（记 cooldown）
                                   ├─ 窗口已开 ──▶ 复用，不重注入
                                   └─ 开窗 ──▶ applyProxy() ──▶ force: [{pre, tok, until}]
  ◀── {action:'fallback'} ──┘
  └─ 原地重发（不改地址）
  └─ imageRetryResult ──▶ noteFallbackProxy({ok})
```

关键点：**内容脚本这一侧不再改写任何地址。** 兜底与普通重试在页面里是同一个动作
（重新赋 `src` / 重发 fetch / 重开 XHR），区别只在后台是否已经把这个源指向了兜底代理。

### 窗口自失效：过期时间写进 PAC

`force` 条目带上绝对时间戳，PAC 自己判断：

```js
{ pre: 'https://i.nhentai.net/', tok: 'PROXY 10.0.0.3:37581', until: 1787500000000 }
```

这一条是本设计里最重要的取舍。若过期只靠后台的定时器去重注入一份干净 PAC，那么
**Service Worker 在窗口期内被回收就会把这个源永久钉在兜底代理上** —— 没有任何东西会来
撤销它，而用户看到的是「扩展好像不轮询了」。把过期时间编进 PAC 之后：

- SW 死了也无所谓，PAC 到点自己失效
- 不需要为了正确性去持久化窗口状态
- 后台到点的重注入降级为「清理」而不是「必须」，失败也不影响正确性

代价：PAC 里多一次 `Date.now()` 比较。PAC 的 JS 环境提供标准内建对象，`Date.now()` 可用。

### 冷却只在内存里

窗口关闭后该源进入冷却期，冷却期内用尽的图直接 `give-up exhausted` 并记一笔
`fallbackProxy.cooldown`，活动日志说明原因。

冷却状态**不持久化**：SW 重启后冷却记录丢失，兜底可能比预期更早地再次开窗。方向是
「偏向可用」而不是「偏向抑制」，这是有意的 —— 冷却是保护措施，不是正确性约束。

### 为什么要有冷却

没有冷却，轮询池长时间大面积失败时窗口会几乎一直开着，整个图源长期只走一个代理。
这是这个扩展存在意义的反面（把流量摊到多个 IP 上躲速率限制），而且图源可能转而对
兜底代理的出口 IP 限速。冷却把「持续失败」的形态钉成 `开窗 N 秒 → 冷却 M 秒` 的循环，
上界可预测，也能在文档里说清。

## 组件

### `src/lib/proxy-token.js`（新）

`proxyToken({protocol, host, port})` → `'PROXY host:port'` / `'HTTPS host:port'` / `null`。

从 `node-model.pacToken()` 里抽出来的纯函数。抽它的唯一理由是**避免出现第二个 token
格式化实现** —— 兜底代理不是节点，走不了 `pacToken(node)`，但它在 PAC 里的写法必须与
节点完全一致（Punycode、IPv6 方括号、协议关键字）。

依赖只有 `constants.js` 与 `ascii.js`，因此 `fallback-proxy.js` 与 `node-model.js`
都能引它而不产生循环导入。

### `src/lib/fallback-proxy.js`（新）

- `parseFallbackProxy(text)` → `{ok, value}` / `{ok:false, reason}`
- `fallbackProxyToken(fp)` → PAC token，不可用时 `null`
- `fallbackProxyWarnings(fp)` → 设置页要展示的中文提示

只依赖 `constants.js`、`ascii.js`、`proxy-token.js` —— 不能引 `schema.js`，否则与
`node-parser.js → schema.js` 形成循环。

### `src/background/fallback-window.js`（新）

进程内状态：`Map<origin, expiresAt>` 与 `Map<origin, cooldownUntil>`。

- `openFallbackWindow(url)` → `{ok:true, reused}` / `{ok:false, reason:'cooldown'|'unconfigured'}`
- `fallbackForceEntries(config)` → 供 `generatePac()` 用的 `[{pre, tok, until}]`
- `resetFallbackWindows()` → 供测试

### 改动面

| 文件 | 改什么 |
|---|---|
| `src/lib/image-proxy.js` | **删除**（连同 `tests/image-proxy.test.js`） |
| `src/lib/constants.js` | `defaultFallbackImage` → `defaultFallbackProxy`；新增窗口/冷却时长 |
| `src/lib/schema.js` | `normalizeFallbackImage` → `normalizeFallbackProxy` |
| `src/lib/pac-generator.js` | `force` 单槽 → 列表且带 `until`；删掉 `templateHost` 绕过 |
| `src/lib/retry.js` | `decideRetry` 去掉 `fallbackTemplate`，`fallback` 不再带 url |
| `src/lib/metrics.js` | `fallbackImage` → `fallbackProxy`，新增 `cooldown` 口径 |
| `src/background/retry-coordinator.js` | 用尽时开窗；去掉「fetch/XHR 不能兜底」的限制 |
| `src/background/proxy-controller.js` | 把 force 条目喂给 `generatePac()` |
| `src/background/auth-provider.js` | 兜底代理的凭据也要应答 |
| `src/background/messaging.js` | 删 `previewFallbackImage` |
| 设置页 / 弹窗 | 模板输入框 → 代理地址输入框；文案与统计口径 |

### 一个附带的能力提升

旧兜底只有 `<img>` 与 `new Image()` 能用 —— 把一个 JSON 接口套进 `?url=` 毫无意义，
所以 `retry-coordinator` 里有一行 `canFallback = via !== 'fetch' && via !== 'xhr'`。

传输层兜底没有这个限制：换代理对 fetch 和 XHR 同样有效。这一行随之删除，**fetch 与 XHR
第一次获得兜底能力**。

## 数据流：一次兜底的完整时序

1. 图片在第 `maxAttempts` 个节点上仍然失败，内容脚本报 `imageRetryAsk`
2. `planRetry` 查 `matchPacUrl` 命中、查失败原因是 `network`/`proxy`
3. `decideRetry` 返回 `{action:'fallback'}`（attempt 已达上限且兜底已启用）
4. `openFallbackWindow(url)`：
   - 冷却中 → 记 `cooldown`、写一条 info 日志、返回 `give-up exhausted`
   - 否则开窗（或复用），必要时 `applyProxy()` 重注入带 force 的 PAC
5. 记 `fallbackProxy.used`，返回 `{action:'fallback', delayMs}`
6. 内容脚本等 `delayMs`，原地重发
7. 浏览器再跑一次 PAC → 命中 force → 走兜底代理
8. `imageRetryResult` 回报 → `noteFallbackProxy({ok})`
9. 窗口到点：后台重注入干净 PAC，该源进入冷却

## 错误处理

| 情况 | 行为 |
|---|---|
| 兜底代理没配 / 协议不支持 | `normalizeFallbackProxy` 强制 `enabled=false`，设置页说明原因；`decideRetry` 走 `exhausted` |
| 开窗时 `applyProxy()` 失败 | 不返回 `fallback`，降级为 `give-up exhausted`，写 error 日志 —— 绝不能让页面以为已经切好了 |
| 兜底那一次又失败了 | `attempt > maxAttempts` → `give-up exhausted`，不再套娃（旧版靠 `isProxiedUrl` 防递归，现在由次数天然防住） |
| 冷却期内用尽 | `give-up exhausted` + `cooldown` 计数 + info 日志 |
| SW 在窗口期被回收 | PAC 里的 `until` 到点自失效；冷却记录丢失，下次可能更早开窗 |
| 测速与兜底同时想 force | `force` 是列表，两者共存；探针条目排在前面，测速优先 |

## 测试

- `tests/fallback-proxy.test.js` —— 解析、token、警示语；不支持的协议必须落到 `enabled=false`
- `tests/fallback-window.test.js` —— 开窗/复用/冷却/过期，用假时钟
- `tests/pac-generator.test.js` —— force 列表、`until` 生效、探针优先、纯 ASCII 不破
- `tests/retry.test.js` —— `decideRetry` 的 fallback 分支不再带 url
- `tests/retry-coordinator.test.js` —— 用尽 → 开窗 → `fallback`；冷却 → `exhausted`；fetch/XHR 也能兜底
- `tests/content-retry.test.js` / `tests/deep-patch.test.js` —— 兜底分支变成「原地重发」，不再改地址
- `tests/metrics.test.js` —— `fallbackProxy` 四个口径

## 不做的事

- **不做迁移。** 旧的 `settings.fallbackImage` 直接丢弃（`normalizeSettings` 不认这个键）。
  用户显式要求不保留兼容层。
- **不把兜底代理放进节点列表。** 它不测速、不自动禁用、不参与轮询、不进 `perNode` 统计。
- **不做多个兜底代理。** 一个就够；要多个就该用节点池。
- **不试图为 http 图源做更精细的 force。** http 的 path 对 PAC 可见，理论上能按 URL
  精确 force，但那会让同一个功能在 http 与 https 下行为不同，比现在更难解释。
