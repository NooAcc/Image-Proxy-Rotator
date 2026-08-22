# 开发者调试日志 —— 设计说明

日期：2026-08-22　·　状态：已实现（1.3.0 之后）

## 要解决的问题

现有的 `lib/logger.js` 是**给用户看的活动日志**：200 条环形缓冲、中文整句、分 info/warn/error，
回答「刚才那张图走了哪个节点、成功了吗、为什么失败」。它是功能的一部分，弹窗里常驻显示。

开发者要的是另一种东西：**逐环节的结构化现场** —— URL 原文、两次匹配各自的结论、归因的
中间量、重试判定的全部入参、PAC 编译产物的尺寸。把这些塞进活动日志会毁掉它：一个漫画页
几秒钟就能把 200 条的窗口冲干净，用户再也看不到「哪个节点在干活」。

所以：**新开一路日志，活动日志一个字节都不动。**

## 边界（先说不做什么）

- **不输出到浏览器控制台。** 唯一出口是导出成文件。
- **不做脱敏层。** 全量记、全量导出，只在文件头写一行警告。这是明确的取舍：D16 那类
  「HTTPS 下路径被剔掉」的 bug 必须看到完整 URL，掩码会让这一整类问题永久查不了。
  但也**不主动记凭据** —— 认证相关只记「有无凭据」这个布尔与挑战次数。这是调用点纪律，
  不是一层代码。
- **不分级。** debug 日志里区分 info/warn 没有意义，你要么全看要么不看。分级是活动日志的事。
- **不写 `storage.local`。** 缓冲写 `storage.session`：跨 Service Worker 回收不丢，浏览器
  重启自动清空。一份诊断日志不该在用户机器上无限期留着，也不该跟 `config` / `metrics`
  抢同一份配额。
- **默认关闭。** 关着的时候它是一个内存布尔判断，热路径零开销。

## 架构

```
内容脚本 (content)           设置页 / 弹窗 (ui)
  攒 20 行或 1 秒 flush         同左
        └────── debugPush{rows} ──────┬────┘
                                      ▼
  ┌──────────────────────────────────────────────────┐
  │ background/debug-store.js   ← 缓冲的唯一持有者     │
  │   开关：storage.local 的 `debug` 键 + onChanged    │
  │   缓冲：lib/debug-log.js（纯环形 + 条数/字节双上限）│
  │   落盘：节流写 storage.session 的 `debugLog` 键     │
  └──────────────────────────────────────────────────┘
        ▲ pac / probe / request / retry / config / msg
        └── SW 内各模块直接调 dbg()
```

**开关为什么不进 `config`。** 两个理由：它不该被「导出配置」带给别人（那是配置，不是你的
调试状态）；而放在 `storage.local` 的独立键上，内容脚本与 UI 页面能**直接读并监听变更**，
不必为「我现在该不该记」再往后台发一次消息。

**缓冲为什么只有一份。** 备选方案是各上下文各存各的，省掉跨进程回传。但内容脚本的存储是
页面级的 —— 每个 tab、每个 iframe 一份，页一关就没，导出时你根本不知道该去哪些 tab 收。
而重试链的价值恰恰在于把「后台判定」和「页面执行」拼成一条时间线，分散存储等于放弃这件事。
汇聚到后台还有个附带好处：内容脚本继续保持「很笨」（决策 D21 的纪律），它只管发，不管存。

## 八个命名空间

| ns | 记什么 |
|---|---|
| `pac` | 编译产物字节数、节点池、摘要、`mandatory`、注入成败与原文错误 |
| `probe` | 定向 PAC 的注入与恢复、每节点耗时、超时、自动禁用与恢复、互斥锁被拒 |
| `request` | URL、资源类型、状态码、对端 IP、`matchPacUrl` 与 `matchUrl` **两个结论分开记**、归因结果与共用地址数 |
| `retry` | 判定的全部入参（url / attempt / observedFailure / settings）与结论及原因 |
| `config` | 规范化丢弃了什么、版本迁移、保存与导入的实体数 |
| `msg` | 消息 type、耗时、ok/error |
| `content` | 页面侧：捕获 error、等待、重发、load/error 回报、预算触顶、冷却 |
| `ui` | 页面发出的消息与结果、分区切换、轮询周期 |

命名空间是**闭集合**，在 `lib/debug-log.js` 里以 `DEBUG_NS` 常量登记。`push()` 收到集合外的
名字时归到 `misc` 而不是新建一个 —— 否则导出的文件名就成了任意字符串，而文件名是要落到
用户磁盘上的东西。

## 一条硬限制：PAC 内部永远看不到

PAC 脚本跑在浏览器的 PAC 沙箱里，没有 `console`，也没有任何回传通道（`alert()` 只进
net-log，扩展读不到）。所以 `pac` 命名空间能告诉你「编译出了什么、注没注进去」，
**永远告诉不了你「第 37 个请求选了哪个节点」**。

想验后者只有两条路：`request` 里的对端 IP，和代理服务商后台的分端口流量。这条要写进
`LIMITATIONS.md` —— 不然下一个人会花半天去找一个不存在的开关。

## 模块与接口

新增两个文件，其余都是调用点。

| 文件 | 职责 |
|---|---|
| `src/lib/debug-log.js` | 纯逻辑：环形缓冲、条数与字节双上限、按命名空间分组、格式化成文本。零 `chrome.*`，`now` 可注入 |
| `src/background/debug-store.js` | 唯一持有者：读开关、接消息、节流落盘、SW 唤醒后 restore、产出导出文件 |

```js
// lib/debug-log.js
createDebugLog({ limit = 2000, byteBudget = 512 * 1024, now })
  → {
      on,                     // 布尔，热路径守卫用
      enable(v),              // 关闭时顺手清空缓冲
      push(ns, ev, data),     // 关闭时立即 return
      pushRows(rows),         // 批量接入（内容脚本 / UI 回传）
      list(ns?), groups(),    // 读取与「每个 ns 各多少条」
      stats(),                // { count, bytes, limit, byteBudget, since }
      format(ns, meta),       // 单个命名空间 → 可落盘的文本
      clear(), restore(rows),
    }
```

一条记录是 `{ at, ns, ev, data }`：`ev` 是短事件名（英文 kebab-case），`data` 是普通对象，
格式化推迟到导出那一刻 —— 记录时拼字符串等于在热路径上白干活。

## 消息契约

五条新消息。`npm run check` 的第 4b 条会强制它们都有 handler（契约只靠字符串维系，
写错一个字母浏览器不报错、只会静默什么都不做）。

| type | 用途 |
|---|---|
| `getDebug` | 返回 `{ enabled, since, stats, groups }`，诊断面板显示 |
| `setDebug` | 开 / 关。写 `storage.local` 的 `debug` 键，关闭时清空缓冲并删掉 session 键 |
| `debugPush` | 内容脚本 / UI 批量回传，单条消息最多 64 行，超出截断 |
| `exportDebug` | 返回 `{ files: [{ name, text }], merged: { name, text } }` |
| `clearDebug` | 只清 debug 缓冲，不碰活动日志与统计 |

**关闭时顺手清空**是有意的：「开关是关的，但导出还有东西」是最容易被误读的状态 ——
你会以为看到的是刚才那次复现，其实是上周的残留。

## 记录格式与导出

每个命名空间一个文件，文件名 `ipr-debug-<ns>-<YYYYMMDD-HHMM>.log`。空的命名空间不出文件。

```
# Image-Proxy-Rotator 1.3.0 调试日志
# namespace : request
# exported  : 2026-08-22 22:41:07
# entries   : 431 条（缓冲共 1200 条 / 118.4 KB）
# 警告：本文件含你访问过的图片地址与代理服务器地址，贴到公开 issue 前请自行确认。

22:40:58.117  observed        url=https://cdn.x.com/001.jpg type=image status=200 ip=1.2.3.4 pac=hit rule=r_1a2b node=n_9f3c
22:40:58.203  observed        url=https://cdn.x.com/002.jpg type=image status=200 ip=1.2.3.5 pac=miss rule=r_1a2b blind=true
```

- 时刻用本地时间 `HH:MM:SS.mmm`（跨文件对齐靠它），事件名左对齐 16 列
- 值的序列化：数字与布尔原样；字符串含空格时加引号；`null` 写 `-`；对象与数组走 `JSON.stringify`
- 除文件头的 5 行 `#` 外没有任何装饰，`grep` 得动

**两个导出按钮**：

1. **「导出全部（每个命名空间一个文件）」** —— 逐个触发下载。Chrome 会就「允许下载多个
   文件」问一次，同意后不再问。这是主路径，也是你要的形态。
2. **「合并为一个文件」** —— `ipr-debug-all-<stamp>.log`，行首多一列 `ns`。贴 issue 时
   一个文件比八个附件省事，跨环节的时间线也只有合并文件才连得起来。

下载复用 `pages/shared/api.js` 已有的 `downloadText()`（给它加一个可选的 MIME 参数，
默认值不变），**不引入 `downloads` 权限** —— 这是个代理扩展，权限列表越短越好过审。

## 上限与开销

**双上限：20000 条 + 4 MB，先到先限，超出丢最老的。**

`chrome.storage.session` 在 Chrome / Edge **112 起配额是 10 MB**，目标环境（最新版 Edge）
远在这条线之上，所以预算给得宽 —— 一整话漫画几百个请求跑下来，`request` 加 `content`
两个命名空间也就几百 KB，20000 条足够覆盖「打开阅读器到读完」的完整过程而不丢头。
剩下的 6 MB 留给活动日志与 runtime。

> `minimum_chrome_version` 仍是 108，而 112 之前 session 配额只有 1 MB。那些老版本上
> 落盘会失败 —— 本模块吞掉错误、缓冲留在内存里，表现为「debug 日志不跨 SW 回收」。
> 只影响这一个诊断功能，分流本身不受影响。这是有意的降级，不是疏忽。

**单值截断与预算无关，必须保留。** 任何字符串值超过 2000 字符就截断并标注省了多少 ——
防的是 `data:image/png;base64,…` 这类病态值，一条能有几 MB，宽预算也扛不住。

**落盘节流：3 秒或 200 条**，沿用决策 D15 的手法。代价同样明确：SW 被回收时最多丢一个
窗口。debug 日志是诊断信息，不是账本。

**关着的时候的开销必须是零。** `push()` 在关闭时立即 return，但那还不够 —— 调用点写成
`dbg('request', 'observed', { ...十个字段 })` 的话，那个对象字面量在关着时照样要构造。
一个漫画页几百个请求，这不是可以忽略的量。所以**调用点一律用 `if (dbg.on)` 守卫**。

**页面侧的自我约束**：内容脚本单页最多 2000 行（超出静默丢弃，与 `PAGE_BUDGET` 同一种
思路），攒 20 行或 1 秒 flush 一次；UI 页面攒 10 行或 1 秒（弹窗随时会被关掉，批小一点）。
两侧都在 `visibilitychange` 转 hidden 时补一次 —— `beforeunload` 在 MV3 里不可靠。

## 自噬：必须显式打断的两个环

1. UI 的 `send()` 包装若无差别地记 `ui` 日志，`debugPush` 自己也会被记一笔 → 下次 flush
   把它发出去 → 又记一笔 → 由 1 秒定时器驱动，**永不收敛**。
2. 后台的 `msg` 命名空间若无差别地记每条消息，`debugPush` / `getDebug` 会在面板每次刷新时
   把缓冲写满自己的噪音。

所以两侧都要排除这 5 个 type。这不是优化，是正确性 —— 少一个排除，日志里就全是日志自己。

## 测试

| 文件 | 覆盖 |
|---|---|
| `tests/debug-log.test.js` | 条数上限、**字节预算先于条数触发**、关闭时不记、`enable(false)` 清空、分组、格式化（含 `null` / 对象 / 带空格的字符串）、未知 ns 归 `misc`、restore |
| `tests/debug-store.test.js` | 开关取自 `storage.local`、`onChanged` 同步、节流落盘、SW 唤醒后 restore、`debugPush` 的 64 行截断、导出的文件名与分组、`clearDebug` 删掉 session 键、关闭时不接受 push |
| 既有 `tests/ui-contract.test.js` | 新增控件的 id 契约与可访问名（无需改测试，新 id 自动纳入断言） |
| `npm run check` | 第 4b 条自动校验 5 个新消息类型都有 handler；第 7 条保证内容脚本里的 mini logger 没有 `import` |

`tests/helpers/chrome-stub.js` 要补 `chrome.storage.onChanged`（`set` 时派发），
这是开关同步这条链路唯一的传导机制，没有替身就断言不了。

## 文档改动

- `docs/ARCHITECTURE.md`：新增决策 **D25**（为什么另开一路日志、为什么汇聚到后台、
  为什么开关不进 config）；模块职责表加两行；数据结构一节补 `debug` 键与 `debugLog` 键
- `docs/LIMITATIONS.md`：新增一节「PAC 内部不可观测」，并说明 SW 回收与 session 配额
- `docs/VERIFICATION.md`：新增一条人工验收（开关 → 复现 → 导出 → 文件里能不能看出问题）
- `README.md`：「诊断」一节补一句这个功能的存在与用途
