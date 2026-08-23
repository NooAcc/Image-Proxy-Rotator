# 深度重试（主世界补丁）—— 设计说明

日期：2026-08-23　·　状态：已实现（待发版）

## 要解决的问题

现在的重试只救得回 DOM 里的 `<img>`（[LIMITATIONS.md](../../LIMITATIONS.md) 第 16 节）。
缺口是结构性的，而且实测很大：2026-08-23 那轮里阅读器大图占 481 次请求中的 301 次，
用的是 `new Image()` 预加载，**重试对它是零覆盖**；页面自己用 `fetch` / `XHR` 取的
JSON 接口与 blob 图片同样一次都进不了重试。

要做的事：**给用户显式勾选的站点**打一层主世界补丁，让 `fetch`、`XMLHttpRequest`、
`new Image()` 三条路上的网络层失败也能换个代理重发一次。

已确认的三个取舍（本次讨论定的）：

| 项 | 结论 |
|---|---|
| 包住哪些 | `fetch` + `XMLHttpRequest` + `new Image()` 三个都包 |
| 重发哪些方法 | **只重发 GET / HEAD**，非幂等请求一律原样报错给页面 |
| 站点清单放哪 | **独立的「深度重试站点」列表**，与分流规则解耦 |

导航请求（地址栏直接打开的地址）**不在范围内**：那时页面里没有任何脚本，补丁无从下手。

## 为什么第 16 节的结论要改

第 16 节当年写的是「代价明显大于收益，所以本扩展不做」，理由是主世界补丁
「会与站点自己的封装、其他扩展、严格 CSP 冲突，出错时可能直接把站点搞坏」。

那个判断的前提是**全局注入**。本设计把前提换掉了：补丁只注册到用户逐条勾选的站点上，
没勾的站点里连补丁代码都不存在。于是「可能把无关网站搞坏」这一条不再成立 ——
剩下的风险被收敛成「可能把你自己勾的那个站点搞坏」，而那是用户自己按下的开关。

第 16 节的表格与结论段落需要改写，第 19 节（内容脚本注入面）需要补一段说明现在有
两个世界的注入。

## 为什么不是「manifest 静态声明 world: MAIN + `<all_urls>`」

那样不需要 `scripting` 权限、也没有注册状态要同步，但两个问题都是硬的：

1. **所有页面都被注入了主世界代码**，用一个 `if (在列表里)` 假装收窄 —— 第 16、19 节
   担心的事一件没少。
2. 补丁要知道「这个站点勾了没有」就得跨桥异步问后台，而 `document_start` 这个时机
   **等不起**：页面脚本完全可能在那之前就把原始 `fetch` 取走存起来，补丁装上去也晚了。
   补丁必须在自己被执行的第一个同步 tick 里就完成包装，这要求「装不装」由**注册时机**
   决定，不能由运行时判断决定。

## 采用的机制

Service Worker 按「深度重试站点」列表用 `chrome.scripting.registerContentScripts()`
动态注册两个脚本，两个都 `runAt: 'document_start'`、`allFrames: true`：

| 脚本 | 世界 | 职责 |
|---|---|---|
| `src/content/deep-bridge.js` | ISOLATED | 唯一持有 `chrome.runtime` 的一侧，转发消息 |
| `src/content/deep-patch.js` | MAIN | 包住 `fetch` / `XHR` / `Image`，重发 |

主世界拿不到 `chrome.runtime`（它就是一段普通的页面脚本），所以桥不是设计选择而是硬性
要求。两侧靠 `window.postMessage` 通信。

```
页面 fetch('https://nhentai.net/api/v2/galleries/674439')
   │
   │ 补丁包住的 fetch 调原始 fetch，代理连不上 → reject
   ▼
补丁捕获 reject（页面的 .catch 还没跑到 —— 页面 await 的是补丁返回的 promise）
   │
   │ postMessage {kind:'ask', id, url, attempt, via:'fetch'}
   ▼
桥（隔离世界）→ chrome.runtime.sendMessage {type:'imageRetryAsk', url, attempt, via}
   │
   ▼
后台 planRetry()：matchPacUrl 判归属 → observedFailure 查真实原因（D22）→ 给 plan
   │
   │ postMessage {kind:'plan', id, plan}
   ▼
补丁等 plan.delayMs，再调一次原始 fetch（PAC 轮询下标已前进 → 落到下一个节点）
   │
   ▼
把第二次的 response 作为原始 promise 的结果交给页面；顺手回报 result
```

判定仍然一条都不下放（决策 D21 不破）：补丁不认识规则、不知道上限是多少、也不判断
失败原因，只报告「这里失败了、这是第几次」然后照回复执行。

## 三个包装点的语义不一样，必须分别说清

**`fetch` —— 干净。** 页面 `await` 的是补丁返回的 promise，第一次失败被补丁吞掉，
页面**完全看不到**。重试成功时页面只感觉这次请求慢了一点。这是三条路里唯一真正透明的。

**`XMLHttpRequest` —— 页面会先看到失败。** 浏览器在 XHR 对象上派发 `error` 是同步的，
补丁没有位置插在页面自己的 `onerror` 前面。所以补丁的做法是：失败事件照常派发给页面，
补丁随后在**同一个 XHR 对象**上重新 `open()` + `send()`，成功时页面的 `onload`
会再跑一次。这与现有 `<img>` 重试是同一种取舍（页面已经看到 error 了，但我们再发一次），
代价是页面若在 `onerror` 里做了「永久标记失败」或「自己也重试一次」，会出现双重处理。
风险写进 LIMITATIONS。

**`new Image()` —— 与 `<img>` 完全同构。** 页面的 `onerror` 先跑，补丁再重新赋 `src`，
成功时 `onload` 跑。现有 `<img>` 路径已经这样工作了一个版本，语义一致。

## 只重发 GET / HEAD

其余方法一律原样报错给页面，补丁连问都不问后台。理由是重复提交的代价不对称：漫画站的
图源与列表接口几乎全是 GET，覆盖率损失极小，而一次被重发的「发评论」「加收藏」是用户
账号上真实发生了两次的事，且事后极难归因。

判断依据按调用点取：`fetch` 看 `init.method` 或 `Request.method`（缺省 GET）；
XHR 看 `open()` 的第一个参数；`Image` 天然是 GET。

**主动取消不算失败**：`AbortError`、`signal.aborted`、XHR 的 `abort()` 一律不重发。
翻页时取消掉一批预加载是漫画阅读器的常态，把它当失败会凭空制造一批重发。

## 桥的信任模型：不做 nonce，做限流

主世界补丁和页面脚本共享同一个 JS 环境 —— 页面能读到补丁的一切，任何在补丁里生成或
接收的 nonce 页面同样能读到。所以 nonce 在这里是安全剧场，不做。

改为把桥收到的消息**一律当不可信输入**处理：

- 校验 `event.source === window` 且 `event.data.__ppDeep === 1`，丢弃其余
- URL 一律交给后台的 `matchPacUrl` 裁决归属（`planRetry` 本来就做这件事）
- 桥自己带一个每页硬上限（沿用 `retry.js` 的 `PAGE_BUDGET` / `MAX_INFLIGHT` 思路），
  防止页面脚本把桥当成打 Service Worker 的放大器

残余风险：勾了的站点可以探测某个 URL 是否命中用户的规则，也可以刷高统计计数。两者都
只在用户显式勾选的站点上成立，且不泄露节点、凭据或配置内容。这个取舍写进 LIMITATIONS。

## 新增设置

```jsonc
"settings": {
  "deepRetry": {
    "enabled": false,
    // 一行一条。裸域名自动展开成 *://*.<域名>/*；也接受完整 match pattern
    "sites": ["nhentai.net", "https://noymanga.com/read/*"]
  }
}
```

规范化规则（`src/lib/deep-retry.js`，纯逻辑）：

- 裸域名 `nhentai.net` → `*://*.nhentai.net/*`
- 已含 `://` 的按 match pattern 校验后原样使用
- **拒绝** `<all_urls>`、主机为 `*` 的模式、以及 http/https 之外的 scheme ——
  那等于绕回被否决的全局注入
- 非法条目**不静默丢弃**：`deepRetryPatterns()` 同时返回 `skipped: [{raw, reason}]`，
  设置页逐行显示原因（与 `normalizeFallbackImage` 保留用户文本同一条纪律）
- 沿用 `fallbackImage` 的做法：一条可用模式都没有时强制 `enabled = false`，
  不让「开关显示开着、实际什么都不会发生」这种状态被持久化

上限 50 条，避免一份导入的配置注册出几百个内容脚本。

## 注册生命周期

新模块 `src/background/deep-retry-injector.js`，导出 `syncDeepRetryScripts()`：

1. 读配置 → `deepRetryPatterns()` 拿到 patterns
2. `chrome.scripting.getRegisteredContentScripts()` 查已注册的两个固定 id
3. 关闭或无可用模式 → `unregisterContentScripts`；否则 `updateContentScripts`
   （已注册）或 `registerContentScripts`（未注册）

调用点与 `applyProxy()` 完全一致：配置变更、`onStartup`、`onInstalled`。**必须与
`applyProxy` 同点调用**，否则会出现「规则改了、注入范围没跟上」的偏差 —— 又一种静默失效。

`persistAcrossSessions` 用默认的 `true`：浏览器重启后注册立即生效，不必等 SW 醒来。
代价是扩展更新后可能残留旧注册，所以 `onInstalled` 里无条件 sync 一次。

注册失败（权限被裁、Chrome 版本过低）**必须写进活动日志并在设置页顶栏告警**，
不能只留一个 `catch {}`。这是本项目反复强调的那条：宁可吵，不可静默。

## 清单变更

- `permissions` 增加 `"scripting"`
- `minimum_chrome_version` 从 `108` 抬到 `111`（`world: "MAIN"` 的动态注册是 111 起）
- `deep-bridge.js` / `deep-patch.js` **不进** `content_scripts` 静态声明，只由
  `chrome.scripting` 动态注册 —— 静态声明就等于全局注入

## 统计

新增一格 `retry.deep`：**由补丁问过后台的次数**（不论后台答不答应重发）。口径刻意与
`attempted` 不同 —— 它要回答的是「补丁到底装上没有、在不在干活」，而不是「重发了几次」。
其余口径不变，补丁触发的重发照旧计入 `attempted` / `recovered` / `exhausted` / `skipped`。

只加一个整数是刻意的：D14 要求占用与运行时长无关，而「深度重试到底有没有在干活」
一个计数就能回答。面板上放在重试那一块，标注「其中来自深度重试」。

`retry.unseen` 的含义在勾了的站点上会变化 —— 以前它数的是「网络层失败了但页面没捕获」，
现在补丁把其中一大部分变成了「捕获到了」。这是预期效果，不是口径漂移，但要在面板的
说明文字里讲清楚，否则用户会以为统计坏了。

## 新增决策（写入 ARCHITECTURE.md）

- **D31**：主世界补丁**只按站点动态注册**，绝不静态声明。理由见上文「为什么不是
  manifest 静态声明」—— 运行时判断在 `document_start` 这个时机来不及，装不装必须由
  注册时机决定。
- **D32**：桥把页面来的消息**当不可信输入**，不做 nonce。主世界与页面共享 JS 环境，
  任何密钥页面都读得到，nonce 是安全剧场；真正的防线是「归属由后台的 `matchPacUrl`
  裁决」+ 每页限流。
- **D33**：补丁**只重发 GET / HEAD**。重复提交的代价不对称，覆盖率损失极小。

## 覆盖面缺口（已知，非缺陷）

- CSS 背景图、canvas 里画的图：没有任何脚本可见的失败信号，补丁也救不回来
- 地址栏直接打开的地址（main_frame）：页面里没有脚本
- 站点在补丁之前就把 `fetch` 存到了别处：`document_start` 已经是扩展能拿到的最早时机，
  再早就只有浏览器自己了
- Service Worker / Web Worker 里发起的 fetch：那是另一个 JS 环境，本次不覆盖

## 顺带修掉的一个轮询 bug

生成的 PAC 里轮询下标 `PP_I` 由所有规则共用，但推进时按**当前这条规则的池长度**取模：

```js
if (PP_N % PP.rotateEvery === 0) PP_I = (PP_I + 1) % tokens.length;
```

单节点池（规则绑定了一个节点）一命中，`(PP_I + 1) % 1` 恒等于 0 —— 共享下标被清零。
用真实配置（15 个节点）实测：把主域名规则钉死在一个节点上之后，图片轮询塌缩成只在
头两个节点之间打转，13 个节点全程闲着。而这个扩展存在的唯一理由就是把请求摊到多个 IP 上。

改成 `% 1000000`，取模只在挑选时做。回归测试在 `tests/pac-generator.test.js`
（「绑定单节点的规则不会把别的规则的轮询压死在少数几个节点上」）。

注意共享计数器本身的性质没变：夹在中间的其他请求同样推进下标，所以某条规则是隔几个
取一个。池大小与步长互质时仍能走遍全部节点 —— 15 个节点、步长 2 实测 15/15 全覆盖。

## 涉及文件

新增：

| 文件 | 说明 |
|---|---|
| `src/lib/deep-retry.js` | 站点条目 → match pattern 的规范化与校验（纯逻辑，可单测） |
| `src/background/deep-retry-injector.js` | 动态注册/注销两个内容脚本 |
| `src/content/deep-bridge.js` | 隔离世界的桥（classic script，无 import） |
| `src/content/deep-patch.js` | 主世界补丁（classic script，无 import） |
| `tests/deep-retry.test.js` | `deep-retry.js` 的单测 |
| `tests/deep-patch.test.js` | 用 `node:vm` 真的执行补丁，验三条路的行为 |
| `tests/deep-injector.test.js` | 注册生命周期（用 chrome-stub） |

改动：

| 文件 | 改动 |
|---|---|
| `src/lib/constants.js` | `defaultDeepRetry()`、条目数上限 |
| `src/lib/schema.js` | `normalizeDeepRetry()` 并接进 `normalizeSettings` |
| `src/lib/metrics.js` | `retry.deep` 计数与 `summarizeMetrics` 输出 |
| `src/background/messaging.js` | `imageRetryAsk` / `imageRetryResult` 接受 `via` |
| `src/background/retry-coordinator.js` | 按 `via` 记 `retry.deep`；`fetch`/`xhr` 不给兜底 |
| `src/background/service-worker.js` | 在 applyProxy 的每个调用点旁 sync 注入 |
| `src/pages/options/options.{html,js}` | 「深度重试站点」编辑区 + 逐行错误 + 顶栏告警 |
| `manifest.json` | `scripting` 权限、`minimum_chrome_version: 111` |
| `docs/LIMITATIONS.md` | 改写第 16 节，补第 19 节，新增「桥的信任模型」一节 |
| `docs/ARCHITECTURE.md` | D31 / D32 / D33，模块职责表 |
| `README.md` | 设置说明与风险提示 |

## 测试

沿用项目既有手法：**真的执行它，而不是断言字符串**（决策 D7 的同一条纪律）。

`tests/deep-patch.test.js` 用 `node:vm` 把补丁装进一个极小的替身环境（照
`tests/content-retry.test.js` 的 `mount()` 写法，接管 `setTimeout` 用假时钟），
至少覆盖：

1. GET 的 fetch 失败一次 → 问了后台 → 重发一次 → 页面拿到第二次的 response
2. POST 的 fetch 失败 → **一次都不问后台**，原样 reject
3. `AbortError` → 不问后台
4. 后台回 `give-up` → 原样 reject，且只发了一次请求
5. XHR 失败 → 重新 open+send，且记录过的请求头被重新应用
6. `new Image()` 失败 → 重新赋 `src`；`plan.action === 'fallback'` 时改用兜底地址
7. fetch/XHR 拿到 `action:'fallback'` → 当 give-up 处理（不套兜底图片代理）
8. 桥收到伪造消息（`__ppDeep` 缺失、`source` 不是 window）→ 不转发
9. 每页上限触发后 → 不再问后台

`tests/deep-injector.test.js` 验注册状态机：关→开注册、改列表更新、关掉注销、
注册抛错时写日志。

`npm run check` 仍须通过：`src/lib/deep-retry.js` 里不得出现 `chrome.`（决策 D6）。

