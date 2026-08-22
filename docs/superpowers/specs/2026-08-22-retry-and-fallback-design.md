# 重试与兜底代理 —— 设计说明

日期：2026-08-22　·　状态：已实现（1.3.0）

## 要解决的问题

1. 轮询到的代理连不上时，自动换一个代理**重新发送这次请求**；重试次数可配，默认 3。
2. 多次重试仍然失败时，改用一个独立的**兜底代理**。
3. 相应完善统计。

原始需求里还有一条「某个代理短时间内多次失败就禁用它」，讨论后**移除** ——
在线请求路径上认不出是哪个代理失败（见下文「为什么不能按在线失败禁用节点」），
自动禁用继续只由测速驱动（决策 D8 不变）。

## 为什么不是「PAC 返回一串代理」

PAC 可以返回 `PROXY a; PROXY b; PROXY c; DIRECT`，浏览器会在连不上 a 时自动改用 b。
这是最省事的实现，但它有一个致命缺陷：

> 链 `[A,B,C]` 里 A 挂了的话，**A 名下所有请求都会压到 B**。同时 PAC 的轮询计数器
> 不知道发生过失败，下一个请求的链首正好也是 B。于是 B 干两份活、C 干一份。

而这个扩展存在的唯一理由就是把请求摊到多个 IP 上以绕过单 IP 速率限制。链式兜底
恰好在最需要均匀的时候把流量堆到一个节点上，所以否决。

## 采用的机制

**一个请求只挂一个代理；失败后由扩展重新发一次，落到轮询里的下一个节点。**

```
页面 <img src="https://cdn.manga.com/001.jpg">
   │
   │ PAC 返回单个轮询节点，不附加 DIRECT
   ▼
节点 A 连接失败 → 浏览器在 <img> 上派发 error
   │
   │ 内容脚本（隔离世界）在 document 捕获阶段收到 error
   ▼
问后台 imageRetryAsk{url, attempt}
   │
   ├─ 不匹配任何启用的规则     → give-up（不是我们路由的图，不干预）
   ├─ 失败原因不是代理故障     → give-up（404 / 403 换代理也一样）
   ├─ attempt >= maxAttempts   → fallback（改写成兜底图片代理）
   └─ 其余                     → retry
   │
   ▼
内容脚本重新赋值 img.src（同一个 URL，不加任何参数）
   │
   │ 浏览器重新调用 FindProxyForURL → 轮询下标已前进 → 节点 B
   │ 且 Chromium 自己的坏代理表已把刚失败的 A 拉黑约 5 分钟
   ▼
成功 → imageRetryResult{ok:true}；仍失败 → 再问一次
```

### 为什么「跳过已用过的代理」不需要实现

两件既有机制叠加起来已经做到了：

- 轮询下标每次 `FindProxyForURL` 调用都前进，重发请求必然拿到下一个节点
- Chromium 自带的坏代理列表会把刚刚连不上的代理排除约 5 分钟
  （见 [LIMITATIONS.md](../../LIMITATIONS.md) 第 5 节 —— 原本被当成干扰项的机制在这里帮上忙）

所以不需要在扩展里维护「本次请求已试过哪些节点」的集合。

### 为什么必须靠内容脚本

扩展没有任何办法拦下一个正在失败的请求并改写它的代理：

- MV3 收走了阻塞式 `webRequest`（`webRequestBlocking` 只对 policy 强制安装的扩展开放）
- `declarativeNetRequest` 只能改 URL，不能改传输层
- Service Worker 自己的 `fetch` 指定不了代理（决策 D1）
- `onErrorOccurred` 是纯观测的，通知到手时请求已经死了

「重新发送」只能由页面里的代码做。代价是新增 `content_scripts`，以及只有能派发
`error` 事件的资源才救得回来。

### 只重试真正的代理故障

内容脚本只知道「图裂了」，分不清是代理连不上还是图源回了 404。后台知道：
`request-logger` 已经在 `onErrorOccurred` 上看到错误码、在 `onCompleted` 上看到状态码。

所以 `request-logger` 多维护一张短命的失败原因表 `Map<url, {kind, at}>`
（30 秒过期、有容量上限），重试协调器查它来决定：

| 观测到的结果 | 判定 |
|---|---|
| `ERR_PROXY_CONNECTION_FAILED` / `ERR_TUNNEL_CONNECTION_FAILED` / `ERR_PROXY_CERTIFICATE_INVALID` / `ERR_PROXY_AUTH_UNSUPPORTED` / `ERR_UNEXPECTED_PROXY_AUTH` / `ERR_MANDATORY_PROXY_CONFIGURATION_FAILED` | 重试（代理层故障） |
| `ERR_CONNECTION_RESET` / `ERR_CONNECTION_CLOSED` / `ERR_CONNECTION_ABORTED` / `ERR_CONNECTION_REFUSED` / `ERR_TIMED_OUT` / `ERR_EMPTY_RESPONSE` / `ERR_SSL_PROTOCOL_ERROR` | 重试（走代理时这些多半是代理侧的问题） |
| HTTP 4xx / 5xx | **不**重试 —— 换代理也是一样的结果 |
| `ERR_ABORTED` / `ERR_BLOCKED_BY_CLIENT` | 不重试 —— 是用户或别的扩展主动取消的 |
| 表里查不到 | 不重试，计入 `retry.skipped` 并写日志 |

最后一条是因为 `onErrorOccurred` 与渲染进程派发 `error` 之间没有顺序保证。
协调器会短暂等一次（150ms）再查，仍然没有就保守放弃 —— 宁可少救一张图，
也不要盲目重刷。

## `settings.fallback` 的含义必须重新讲清

`fallback: 'direct'` 会让整套重试与兜底**永不触发**：代理连不上时浏览器静默改走
直连，图片正常显示、不派发 `error`，内容脚本什么都收不到 —— 而真实 IP 已经暴露
给图源了。

所以两个选项重新措辞，把后果写在做选择的地方：

- **连不上代理就直连原图** —— 图一定能显示，但会暴露真实 IP，重试与兜底都不会生效
- **不直连** —— 连不上就报错，交给重试与兜底处理（想让本功能生效必须选这个）

新装默认仍是 `direct`（安全优先，决策 D12），不偷偷替用户改。配了重试之后 UI 会
明确提示这个组合是矛盾的。

`pac-generator.js` 因此几乎零改动：它今天在 `fallback === 'block'` 时就已经只返回
单个 token。

## 兜底代理

存成 **URL 模板**而不是 host/port。理由：需求要求的顺序是「重试 N 次 → 仍失败 →
兜底」，而把兜底当 HTTP 代理放进 PAC 会把顺序倒过来（连接失败会当场切到兜底并成功，
图片根本不报 `error`，于是「重试 N 个轮询节点」那一段永远不会执行）。URL 改写型
图片代理是逐请求生效的，顺序完全正确，且不碰全局代理设置、不需要互斥锁。

```js
settings.fallbackImage = {
  enabled: false,
  template: '',      // 例如 https://wsrv.nl/?url={url}
}
```

- 占位符两个：`{url}` 填百分号编码后的原图地址（默认该用这个），`{raw}` 填原样。
  两个都给是为了省掉「这家服务要不要编码」的猜测。
- 校验：必须是 http/https，必须含至少一个占位符。
- 改写逻辑放 `src/lib/image-proxy.js`，纯函数、零 chrome 依赖、可单测（决策 D6）。
- 兜底请求走的是**兜底服务自己的域名**，命不中图源规则，所以它自然直连、不经轮询池
  —— 即使所有代理全挂了兜底照样能用。
- 设置页给一个「试一下」按钮：填一个图片 URL，当场显示改写结果，不真的加载。

**隐私提示要写进设置页而不是只写进文档**：兜底代理会拿到你的图片 URL，
用公共服务就等于把图源地址交给第三方。

用尽重试、兜底也失败（或没配）之后就是裂图 —— 没有办法回到「直连原图」，
因为 PAC 分不出「这是第几次尝试」（决策 D16）。想让某个域名彻底放行只能把它
加进绕过列表。

## 新增设置

```js
settings.retry = {
  maxAttempts: 3,   // 每张图最多尝试几个节点（含首次）。1 = 不重试。范围 1..10
  delayMs: 300,     // 重发前等多久，留时间让坏代理表登记。范围 0..5000
}
settings.fallbackImage = {
  enabled: false,
  template: '',
}
```

「默认 3」= 首次 + 2 次重试，一共 3 个节点。UI 标签写成「每张图最多尝试几个节点」，
语义无歧义。

## 统计

重试由扩展自己发起，所以下面全是观测值，没有一个是推断出来的：

```js
retry: {
  attempted,   // 发起重试的次数
  recovered,   // 重试后加载成功的次数（内容脚本回报 load）
  exhausted,   // 用尽 maxAttempts 仍失败
  skipped,     // **你的**图片里判定不该重试的：原因不是代理故障 / 查不到原因
},
fallbackImage: { used, ok, fail },
```

`skipped` 刻意**不含**「不匹配任何规则」那一类。用户随手逛的任何网站上的裂图都会走到
那条判定，把它记进来会让这一格变成与配置无关的噪音计数 —— 看到「未重试 47 次」
只会以为哪里出了问题。这一格的含义必须是「**你的**图片里有几张我们决定不重试」。

**口径变化要写在统计页上**：重试会让 `requests.total` 变大（重发就是一次新请求，
`webRequest` 会照实记一笔），所以成功率会比现在低。`retry.attempted` 就是用来对账的。

## 为什么不能按在线失败禁用节点

原始需求第 2 条被移除的原因，记在这里免得以后又被提出来：

一旦让浏览器承担任何形式的失败切换，链内的中间失败对扩展就是不可见的
（节点 A 失败、B 成功时只有一次 `onCompleted`，对端 IP 是 B）。而本设计里
根本不给浏览器多个代理，所以 `onErrorOccurred` 报的就是「当前这个节点失败了」
—— 但 `onErrorOccurred` 不带对端 IP（连接压根没建立），所以仍然认不出是哪个节点。

`details.ip` 只在 `onCompleted` 上有，且多个节点共用一台机器的不同端口时无法区分
（决策 D18）。而按状态码 ≥ 400 计入节点失败会把图片 404、站点 5xx 都算成节点的错，
从而禁掉好节点 —— 这正是决策 D8 当初刻意避开的。

自动禁用因此继续只由测速驱动：测速能强制走指定节点（决策 D3），归因是确定的。

## 覆盖面缺口（已知，非缺陷）

只有派发可捕获 `error` 事件的资源救得回来：`<img>`、`<picture>`/`<source>`。
救不回来的：

- CSS 背景图（`background-image`）
- `<canvas>` 里画的图
- 页面 JS 用 `fetch` / `XMLHttpRequest` 拿 blob 再喂给 `<img>` 的阅读器

补上后两类需要向**主世界**注入代码去包住 `window.fetch` 与 `XMLHttpRequest`，
会与站点自己的封装、其他扩展、严格 CSP 冲突，出错时可能直接搞坏站点。
本设计刻意不做，缺口写进设置页。

## 新增决策（写入 ARCHITECTURE.md）

| # | 决策 | 理由 |
|---|---|---|
| **D20** | 重试 = **内容脚本重新赋值 `img.src`**，而不是 PAC 返回代理列表 | 列表式失败切换会把挂掉节点的全部流量堆到列表里的下一个节点上，同时轮询计数器察觉不到失败 —— 恰好在最需要均匀的时候破坏均匀性。重发请求会触发一次新的 `FindProxyForURL`，轮询下标已前进，Chromium 的坏代理表也已排除刚失败的那个 |
| **D21** | 只在**后台**判定该不该重试，内容脚本不持有规则 | 规则匹配、失败原因分类、次数上限全在 SW 一处。内容脚本只报「这张图裂了」并执行回复，与 UI「不维护第二份状态」是同一条纪律 |
| **D22** | 重试只针对**代理层失败**，HTTP 4xx/5xx 一律不重试 | 换个代理拿到的还是同一个 404。区分依据来自 `webRequest` 观测到的错误码/状态码，查不到就保守放弃 |
| **D23** | 兜底代理是 **URL 改写型图片代理**，不是 HTTP 代理 | HTTP 代理只能通过 PAC 表达，而 PAC 里的兜底会在重试之前生效，把需求要求的顺序倒过来。URL 改写逐请求生效，顺序正确，且不碰全局代理设置、不与测速抢互斥锁（决策 D19） |
| **D24** | 统计只记内容脚本回报的观测值，不推断重试链 | `retry.recovered` 来自重发后真的收到 `load`，不是「大概成功了」。同时明说重试会抬高 `requests.total` |

## 涉及文件

**新增**

- `src/content/retry.js` —— 内容脚本（隔离世界，classic script）
- `src/lib/image-proxy.js` —— 兜底模板的校验与改写，纯函数
- `src/lib/retry.js` —— 失败原因分类与重试判定，纯函数
- `src/background/retry-coordinator.js` —— 编排：凑齐入参、写统计、写日志

判定逻辑放 `src/lib/` 而不是塞进 coordinator：这样「什么情况下该重发」能在 Node 里
逐条钉死，不需要 chrome 替身（决策 D6）。coordinator 只负责把三样东西凑齐
（规则是否命中、失败原因、设置项）然后调它。

**改动**

- `manifest.json` —— `content_scripts`
- `src/lib/constants.js` —— 新设置默认值与上限
- `src/lib/schema.js` —— `normalizeRetrySettings` / `normalizeFallbackImage`
- `src/lib/metrics.js` —— `retry` / `fallbackImage` 计数器
- `src/background/request-logger.js` —— 失败原因表 + `observedFailure()` / `forgetFailure()`
- `src/background/metrics-store.js` —— 两个新的 note 入口
- `src/background/messaging.js` —— `imageRetryAsk` / `imageRetryResult` / `previewFallbackImage`
- `src/pages/options/{options.html,options.js}` —— 「重试与兜底」两张卡片
- `src/pages/popup/popup.js` —— 统计视图新增一段
- `tools/check-manifest.mjs` —— 校验 `content_scripts` 引用的文件存在、内容脚本里没有
  `import`/`export`（MV3 不支持 ESM，有一句就整块静默失效）、消息契约扫描扩到 `src/content/`
- `tools/pack.mjs` —— `manifestRefs()` 加上 `content_scripts`，漏打包会让功能整块消失
- `docs/ARCHITECTURE.md` —— D20–D24、重试链时序图、模块职责、数据结构
- `docs/LIMITATIONS.md` —— 新增第 14–17 节
- `docs/VERIFICATION.md` —— 新增第 13–15 条人工验收
- `README.md` —— 上手第 7 步、设置表、统计说明、权限说明

## 测试

| 文件 | 覆盖 |
|---|---|
| `tests/image-proxy.test.js`（新） | 模板校验（协议、占位符）、`{url}` 百分号编码正确、`{raw}` 原样、防自套娃 |
| `tests/retry.test.js`（新） | 失败原因分类的每一类、次数上限、兜底移交、脏输入 |
| `tests/retry-coordinator.test.js`（新） | 后台编排：观测→查表→判定→计数→日志的完整往返、失败原因表的过期与容量、日志节流、模板预览 |
| `tests/content-retry.test.js`（新） | `node:vm` + DOM 替身**真的执行**内容脚本：捕获阶段挂载、`src`/`srcset`/`<picture>` 三种重发路径、结果回报、防套娃、单页预算 |
| `tests/metrics.test.js` | 新计数器的累加、读回、汇总与剪枝 |
| `tests/storage.test.js` | 新设置项的规范化、夹取、导出导入往返 |
| `tests/pack.test.js` | `content_scripts` 引用的文件必须在包内 |

`npm run check` 的静态校验从六条加到八条。全量：**405 个测试**。
