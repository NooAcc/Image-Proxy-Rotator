# 漫画图片代理分流扩展 —— 实施计划（plan.md）

> **需求来源（按优先级）：**
> 1. `task-change.md` —— 【任务目标变更 · 立即生效】**与下方 1.2 一致，冲突时以本文件为准**
> 2. `task.md` —— 原始需求与本计划文件的维护规则
>
> **当前状态：全部 17 个有效任务已完成**（Task 7 已按变更取消），后台编排层已补齐自动化测试，
> 并追加了 zip 打包与 CI 自动构建。自动化验证 `npm run verify` 全绿：**169 个测试 + manifest 静态校验**。
> 剩余未完成项只有**需要真实网络与真实浏览器渲染的人工验证**
> （见第 8 节，本环境无浏览器自动化能力，必须由用户执行）。

**Goal：** 交付一个 Manifest V3 的 Edge/Chromium 扩展 `漫画图片代理分流`，把命中规则的漫画图片请求
按轮询方式分散到多个 **HTTP / HTTPS** 代理节点上，绕过站点的单 IP 速率限制。

**Architecture：** 后台 Service Worker 把「节点列表 + URL 规则 + 健康状态」编译成一段 **PAC 脚本**，
经 `chrome.proxy.settings` 注入浏览器；PAC 内部维护轮询计数器，对命中请求逐个吐出不同节点，
不命中的请求返回 `DIRECT`。所有纯逻辑（解析 / 匹配 / 调度 / PAC 生成）放在 `src/lib/`，
是零浏览器依赖的 ESM 模块，用 `node --test` 全量单测；`src/background/` 只做 Chrome API 编排，
`src/pages/` 只做 UI。

**Tech Stack：** Manifest V3、`chrome.proxy`（PAC 模式）、`chrome.storage.local/session`、
`chrome.alarms`、`chrome.webRequest`（非阻塞观测 + `onAuthRequired` 认证）、原生 ESM、
零运行时依赖、`node:test` + `node:assert` + `node:vm` 做测试。

---

## Global Constraints（全局约束，每个任务都隐含包含）

| 约束 | 精确值 |
|---|---|
| Manifest 版本 | `manifest_version: 3` |
| 目标浏览器 | Edge / Chrome ≥ 108（`chrome.proxy` + MV3 SW） |
| **可用代理协议** | **仅 `http` 与 `https`**。其余一律不进入轮询池（见 D4、D5） |
| 不支持时的提示文案 | 固定为 `本程序不支持该代理类型，仅支持 HTTP/HTTPS 代理`（常量 `UNSUPPORTED_PROTOCOL_MESSAGE`，不得改写） |
| 运行时依赖 | **零**。`package.json` 的 `dependencies` 必须为空 |
| 构建步骤 | **无**。`src/` 下的代码即最终加载产物，可直接「加载解压缩的扩展」 |
| 模块格式 | 全部 ESM。SW 用 `"type": "module"`；`package.json` 设 `"type": "module"` |
| 语言 | 所有 UI 文案、注释、文档一律**简体中文** |
| 代码风格 | 2 空格缩进；单引号；语句结尾带分号；文件末尾留一个换行 |
| 测试命令 | `npm test` → `node --test tests/*.test.js`（**glob 不加引号**，理由见 O2） |
| 存储键 | 配置固定存于 `chrome.storage.local` 的键 `config`；运行时态存于 `chrome.storage.session` |
| 配置版本 | `config.version = 1`；读取必须走迁移函数，未知版本不得崩溃 |
| 扩展名 | `漫画图片代理分流`（manifest `name`）；内部标识 `page-proxy` |
| id 前缀 | 节点 `n_` + 8 位 hex；规则 `r_` + 8 位 hex（稳定哈希，非随机） |
| 探测标记参数 | `__pp_node`（PAC 依赖此字面量，不得改名） |
| 日志上限 | 默认 200 条，环形缓冲，最新在前 |
| 禁止行为 | 不得把代理账号密码写进 PAC；不得使用 `eval` / `new Function`；`src/lib/` 不得出现 `chrome.*`；不得请求已声明之外的权限 |

---

## 1. 总体目标与范围

### 1.1 在范围内（本计划交付，均已完成）

| # | 需求 | 交付方式 | 状态 |
|---|---|---|---|
| F1 | 设置页：代理节点列表增删改、排序、批量导入 | `src/pages/options/` | ✅ |
| F2 | 设置页：URL 规则增删改（精确 / 前缀 / 域名 / 通配 / 正则） | 同上 + `rule-matcher.js` | ✅ |
| F3 | 配置导入 / 导出（JSON 文件 + 文本框） | `storage.js` + Options | ✅ |
| F4 | 配置持久化 `chrome.storage.local` | `storage.js` + `state.js` | ✅ |
| F5 | **仅 HTTP / HTTPS 代理可用**，完整参与分流 | PAC + `chrome.proxy` | ✅ |
| F6 | 非 HTTP/HTTPS（SOCKS、VLESS、Hysteria2、Trojan、SS 等及未知协议）：**识别但不接纳**，逐条给出规定中文提示，绝不进入轮询池 | `node-parser.js` + `node-model.pacToken()` + UI 红条 | ✅ |
| F7 | 轮询（Round-Robin）分流，可配「每 N 个请求换一次」 | PAC 内计数器 + `scheduler.js` | ✅ |
| F8 | 手动启用 / 禁用单个节点 | Options + Popup | ✅ |
| F9 | 延迟测试：一键 + 定时（`chrome.alarms`） | `health-monitor.js` | ✅ |
| F10 | 超时 / 失败节点自动禁用并在轮询中跳过 | `health-monitor.js` + PAC 池过滤 | ✅ |
| F11 | 手动重新启用被自动禁用的节点（重置健康状态） | Options + Popup | ✅ |
| F12 | 规则可单独启用 / 禁用，可绑定节点子集 | `rule-matcher.js` + PAC pools | ✅ |
| F13 | 状态页：节点数 / 可用数 / 最近请求（节点·延迟·成败·出口 IP）/ 总开关 / 一键测速 / 生效规则 | `src/pages/popup/` | ✅ |
| F14 | 错误处理 + 日志（状态页可看，可按类型过滤、可清空） | `logger.js` + 全链路 `guard()` | ✅ |
| F15 | 使用说明文档 | `README.md` + `docs/` | ✅ |

### 1.2 明确不在范围内

**由 `task-change.md` 取消（原计划曾包含，现已从代码、测试、文档、UI 中彻底移除）：**

- ❌ **任何高级协议的可用路由**：VLESS / VMess / Hysteria2（含 `hy2`）/ Trojan / Shadowsocks(SSR) / TUIC。
- ❌ **SOCKS4 / SOCKS5 的可用路由**（连 PAC 关键字 `SOCKS`/`SOCKS5` 都不再出现在生成的脚本里）。
- ❌ **本地网桥端口分配**（`bridge` 字段、`BRIDGE_PORT_BASE`、`assignBridgePorts()` 全部删除）。
- ❌ **sing-box（或同类内核）配置导出**（`src/lib/singbox-export.js` 与 13 个测试已删除，UI 区块与文档章节已移除）。
- ❌ 任何「非 HTTP/HTTPS 也能正常分流」的验收标准。
- 主链路**不依赖**任何本地客户端或第三方内核。

**原本就不在范围内：**

- 不做订阅链接的定时自动更新（只支持一次性粘贴订阅内容导入）。
- 不做流量统计 / 计费 / 限速。
- 不做 i18n 多语言（按约束只做简体中文）。

**用户后续追加、已完成的（原本写在「不在范围内」）：**

- ✅ **zip 打包 + GitHub Actions 自动构建**（Task 18）：`npm run pack` 产出可直接分发／上架的 zip；
  CI 在推送与打 tag 时自动跑测试并产出产物。
- ❌ **仍然不做 `.crx` 签名与自托管分发**：用户在了解「开发人员模式解锁的是加载解压缩、
  不等于安装本地 crx，自签名 crx 会被现代 Chromium 以缺少商店签名为由拒绝」之后，
  明确要求去掉 crx。相关代码、测试、CI 步骤已全部移除，只在
  [docs/PACKAGING.md](docs/PACKAGING.md) 留一段说明，避免日后重复踩坑。
- 仍不做商店素材（截图 / 宣传图 / 隐私政策文案）。

> 说明：用户手上只有高级协议节点时，可自行用本机客户端开一个 HTTP 入口再加进本扩展 ——
> 这属于用户自建环境，`docs/LIMITATIONS.md` 第 1 节据实说明，但**本扩展不再提供任何相关配置生成能力**。

---

## 2. 当前阶段与进度

**当前阶段：阶段 6 已完成 —— 全部自动化工作交付完毕｜状态：等待用户在浏览器里做真实环境验收**

| 阶段 | 内容 | 任务 | 状态 |
|---|---|---|---|
| 阶段 0 | 需求分析、架构决策、计划编写 | — | **已完成** |
| 阶段 1 | 工程骨架 + 核心纯逻辑库（可全量单测） | Task 1–8 | **已完成**（Task 7 已取消） |
| 阶段 2 | 后台 Service Worker 编排 | Task 9–11 | **已完成** |
| 阶段 3 | Manifest + 图标 + 两个 UI 页面 | Task 12–14 | **已完成** |
| 阶段 4 | 文档 + 全量验证 | Task 15–16 | **已完成**（自动化）／**待用户执行**（浏览器人工验证） |
| 变更 | 按 `task-change.md` 收窄至仅 HTTP/HTTPS | 全量返工 | **已完成** |
| 阶段 5 | 后台编排层自动化测试（把原本只能人工验证的链路搬进 Node） | Task 17 | **已完成** |
| 阶段 6 | zip 打包器 + GitHub Actions 自动构建（用户追加） | Task 18 | **已完成** |

**总进度：17 / 17 个有效任务（100%）**，Task 7 已取消。

**最近一次验证结果**（`npm run verify`）：

```
ℹ tests 169
ℹ pass 169
ℹ fail 0
✔ manifest 校验通过（检查了 20 个 JS 文件、2 个 HTML 文件）
```

**尚未完成、且本环境无法完成的事项**（据实记录，不含糊过去）：
只剩下**依赖真实网络与真实浏览器渲染**的部分 —— 真实代理的连通性、同一话漫画的多个真实出口 IP、
HTTP/2 连接复用的实际表现、浏览器真的弹不弹代理认证框、与其他代理扩展抢控制权、
以及两个页面的实际渲染与交互。本环境没有浏览器，**这些我都没有执行过**，清单见第 8 节。

后台编排层原本也属于「只能人工验证」，Task 17 已把它搬进 Node 自动化（27 + 7 个测试），
因此人工清单比变更前短了一截。

---

## 3. 架构与数据结构

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

> 决策编号（D1–D12）与 `docs/ARCHITECTURE.md` **完全一致**，代码注释里引用的编号也已同步，
> 详细理由见第 5 节。

### 3.1 共享数据结构（**所有模块严格遵守**；实现见 `src/lib/schema.js`）

```js
// ---------- Config（持久化于 chrome.storage.local["config"]） ----------
/**
 * @typedef {Object} Config
 * @property {1} version
 * @property {boolean} enabled            总开关，false = 完全不接管代理
 * @property {Node[]} nodes
 * @property {Rule[]} rules
 * @property {Settings} settings
 */

/**
 * @typedef {Object} Settings
 * @property {'round-robin'|'hash'} strategy   默认 'round-robin'
 * @property {'direct'|'block'} fallback       默认 'direct'
 * @property {number} rotateEvery              每 N 个请求换一个节点，默认 1
 * @property {ProbeSettings} probe
 * @property {number} logLimit                 默认 200
 * @property {string[]} bypassList             默认 ['localhost','127.0.0.1','[::1]','<local>']
 */

/**
 * @typedef {Object} ProbeSettings
 * @property {string}  url                默认 'https://cp.cloudflare.com/generate_204'
 * @property {number}  timeoutMs          默认 5000
 * @property {number}  intervalMinutes    默认 15；0 = 关闭定时探测
 * @property {boolean} autoDisable        默认 true
 * @property {number}  failureThreshold   连续失败达到该值则自动禁用，默认 2
 * @property {boolean} recoverProbe       定时探测也探测被自动禁用的节点，默认 true
 */

/**
 * @typedef {Object} Node
 * @property {string}  id            'n_' + 8 位 hex（由 protocol|host|port 稳定哈希得出）
 * @property {string}  name          显示名，默认 `${protocol}-${host}:${port}`
 * @property {string}  protocol      'http'|'https' = 可用
 *                                   | 'socks5'|'vless'|… = 能识别但**不可用**，仅用于提示
 *                                   | 'unknown'
 * @property {string}  host
 * @property {number}  port          1–65535，越界则整条丢弃
 * @property {string}  username      无则 ''（只存 storage，绝不进 PAC）
 * @property {string}  password      无则 ''（同上）
 * @property {boolean} enabled       用户手动开关
 * @property {boolean} autoDisabled  测速失败自动禁用
 * @property {Health}  health
 * @property {string}  raw           原始链接
 * @property {Object}  meta          链接里的额外 query 参数
 */
```

```js
/**
 * @typedef {Object} Health
 * @property {'unknown'|'ok'|'slow'|'fail'} status   latency > 2000ms 记为 'slow'
 * @property {?number} latencyMs
 * @property {?number} lastCheckedAt      epoch ms
 * @property {number}  consecutiveFailures
 * @property {?string} lastError
 * @property {?string} egressIp           探测请求实际出口 IP（分流生效的硬证据）
 */

/**
 * @typedef {Object} Rule
 * @property {string}  id           'r_' + 8 位 hex
 * @property {string}  name
 * @property {'exact'|'prefix'|'host'|'wildcard'|'regex'} type
 * @property {string}  pattern
 * @property {boolean} enabled
 * @property {string[]} nodeIds     绑定的节点子集；空数组 = 使用全部可用节点
 */

// ---------- Runtime（chrome.storage.session，丢了不影响功能） ----------
/**
 * @typedef {Object} LogEntry
 * @property {string}  id
 * @property {number}  at           epoch ms
 * @property {'info'|'warn'|'error'} level
 * @property {string}  kind         'probe'|'request'|'proxy'|'config'|'system'
 * @property {string}  message
 * @property {?string} nodeId
 * @property {?string} url
 * @property {?number} latencyMs
 * @property {?boolean} ok
 */
// 另有：runtime.stats（每节点 used/ok/fail）、runtime.startIndex（轮询起点）
```

**规范化原则**：`schema.js` 保证「任何输入都能得到一份合法 Config」。无法修补的**单条**记录直接丢弃
（端口越界的节点、无法编译的正则），而不是让整份配置失效。
`bridge` 字段已随变更删除；历史配置里的该字段在规范化时被自然忽略。

---

## 4. 已发现的问题与风险

| # | 风险 | 影响 | 缓解措施 | 状态 |
|---|---|---|---|---|
| R1 | 浏览器代理设置是**独占资源**，其他扩展或企业策略可能已占用 | 注入 PAC 静默失败 | 每次注入后读 `levelOfControl`，非 `controlled_by_this_extension` 时在设置页与弹窗顶部红条告警，并写 `warn` 日志 | ✅ 已缓解 |
| R2 | Chrome 可能重建 PAC 解释器，导致轮询计数器归零 | 分布仍均匀，但不严格连续 | 接受。每次注入把 `runtime.startIndex` 前进一格并存入 session，避免总是从 0 号节点起步 | ✅ 已接受 |
| R3 | Chromium 内置**坏代理列表**：连接失败的代理被浏览器自行拉黑约 5 分钟 | 本扩展的调度被绕过 | 视为双重保护而非缺陷，`docs/LIMITATIONS.md` 第 5 节说明；自动禁用仍只以探测结果为准 | ✅ 已文档化 |
| R4 | PAC 的 `PROXY h:p` 语法**无法内嵌账号密码** | 带认证的代理会弹认证框 | `chrome.webRequest.onAuthRequired` + `webRequestAuthProvider` 按「主机:端口」匹配节点自动应答；同一请求第二次挑战即放手，避免无限重试 | ✅ 已缓解 |
| R5 | **历史配置里残留的非 HTTP/HTTPS 节点可能静默参与分流** | 违反 `task-change.md` 的硬要求 | 可用性收敛到 `pacToken()` 单一出口（D5）：非 http/https 一律返回 `null`，因此进不了 PAC 池；加载时后台写告警日志，UI 标红并禁用开关，提供「清除不支持的节点」一键清理。`tests/integration.test.js` 专门守着这条 | ✅ 已缓解（有测试） |
| R6 | HTTPS 图片经 HTTP 代理需要代理支持 `CONNECT` | 节点看似在线但图片全失败 | 默认探测 URL 是 `https://`，一次测速等价于验证 CONNECT 通路 | ✅ 已缓解 |
| R7 | MV3 SW 会休眠，定时探测可能不触发 | 健康数据过期 | 用 `chrome.alarms`（能唤醒 SW）而非 `setInterval`；周期不足 1 分钟时提升到 1 | ✅ 已缓解 |
| R8 | 同一 host 的 **HTTP/2 连接复用**让多张图片走同一条已建立的代理连接 | 分流粒度下降 | 网络栈行为，PAC 层无法否决。`rotateEvery` 默认 1；文档建议节点数 ≥ 4；用「出口 IP 是否出现多个值」作为判据 | ✅ 已文档化 |
| R9 | 用户填的正则可能非法或有灾难性回溯 | PAC 抛异常 → 全站异常 | 三重防护：保存前 `new RegExp()` 预校验并给中文原因；生成 PAC 时逐条 `try/catch` 编译，失败的规则永不命中；PAC 顶层 `try/catch` 兜底 `DIRECT`；注入用 `mandatory: false` | ✅ 已缓解 |
| R10 | 探测请求若被当作普通请求会走轮询 | 测不出单节点延迟 | PAC 最先识别 `__pp_node=<id>`，强制走该节点且**不加 DIRECT 兜底**；`PP.tokens` 收录全部可表达节点，所以被自动禁用的节点仍能被单独测速恢复 | ✅ 已缓解 |
| R11 | ~~高级协议在浏览器内无法实现~~ | — | **已随 `task-change.md` 退役**：不再把高级协议当作交付目标，`docs/LIMITATIONS.md` 第 1 节只据实解释「为什么做不到」，不再给折中方案 | ⛔ 已退役 |
| R12 | ~~Chromium 不支持 SOCKS5 用户名密码认证~~ | — | **已随 `task-change.md` 退役**：SOCKS 整体不再支持，该风险不复存在 | ⛔ 已退役 |
| R13 | 探测频繁会给探测站带来额外流量 | 被限流 | 默认 15 分钟；单次全量探测内部并发上限 5 | ✅ 已缓解 |
| R14 | 节点名来自用户粘贴的订阅，可能含 HTML | UI XSS | UI 只用 `el()` 构造 DOM，且 `el()` **在收到 `html` 属性时直接抛错**；全程只写 `textContent` | ✅ 已缓解 |

---

## 5. 已做出的决策与优化记录

### 5.1 架构决策（D1–D12，与 `docs/ARCHITECTURE.md` 同号）

| # | 决策 | 理由 | 被否方案 |
|---|---|---|---|
| **D1** | 路由核心用 `chrome.proxy` 的 **PAC 脚本模式** | 这是扩展唯一能让**浏览器网络栈**真正走不同代理的 API | ① SW 内 `fetch` 转发（`fetch` 无法指定代理，且破坏图片流式加载与 CORS）② `declarativeNetRequest` redirect（只能改 URL，不是代理）③ `mode:'fixed_servers'`（只能配单个代理，无法轮询） |
| **D2** | 轮询计数器放在 **PAC 脚本的模块作用域** | PAC 上下文在多次 `FindProxyForURL` 之间保持变量（已用 `node:vm` 实验验证），无需每请求与 SW 通信 —— PAC 也没有这个能力 | 每请求 `sendMessage` 问 SW 要节点 |
| **D3** | 测速 = 给探测 URL 加内部参数 `__pp_node=<节点id>`，PAC 认出后**强制**走该节点且**不加直连兜底** | 测的是「浏览器经该代理到公网」的真实端到端链路，与图片请求同一条通路；没有兜底所以失败是真失败。顺带能从 `webRequest.onCompleted.ip` 拿到出口 IP | ① 直接 `fetch(节点地址)`（只测到代理的 TCP 可达性）② TCP ping（浏览器无此能力） |
| **D4** | **只支持 HTTP / HTTPS 代理**，其余类型「识别但不接纳」 | `task-change.md` 的硬要求。识别而不接纳，比静默丢弃更不容易让用户困惑 —— 能准确说出「这是 VLESS 节点，本程序不支持」 | ① 假装支持然后静默失败 ② 直接把无法解析的行都归为「格式错误」（用户会以为是自己粘错了） |
| **D5** | 可用性判定收敛到 **`pacToken()` 单一出口** | 只有 `SUPPORTED_PROTOCOLS`（http/https）能拿到 token，其余返回 `null`。`isSelectable`、PAC 节点池、状态统计全建立在它之上，因此**不存在**「某个不支持的协议从别的路径漏进轮询」的可能 | 在每个用到节点的地方各写一次协议判断（漏一处就出安全问题） |
| **D6** | 纯逻辑与 Chrome API **物理隔离**：`src/lib/` 不出现 `chrome.` | 让 PAC 生成、节点解析、规则匹配、调度这些最易错的部分能在 Node 里 TDD。`npm run check` 强制这条约束 | 逻辑写在 SW 里，只能人肉点浏览器验证 |
| **D7** | PAC 生成器用 `node:vm` 沙箱**真的执行**生成出来的脚本来测 | 断言「脚本行为正确」而不是「字符串长得对」。字符串断言会在重构时全线崩溃 | 快照 / 子串断言 |
| **D8** | 自动禁用**只由测速结果驱动**；线上请求失败仅记日志 | 图片 404、站点 5xx、用户断网都会造成请求失败，据此禁用节点会把好节点全禁掉 | 用 `webRequest.onErrorOccurred` 直接禁用节点 |
| **D9** | 规则可绑定节点子集（空数组 = 全部） | 支持「A 图源用这批节点、B 图源用那批」；绑定的节点全不可用时自动回落到全部可用节点，避免图片直接裂开 | 全局共用一个池 |
| **D10** | 兜底可配 `fallback: direct \| block`，默认 `direct` | 默认让图片「至少能加载」优于「彻底裂图」；追求严格分流的用户可切 `block` | 硬编码其中一种 |
| **D11** | 零构建、零依赖、原生 ESM | clone 后直接「加载解压缩的扩展」，没有 node_modules 供应链风险 | Vite / webpack + TypeScript |
| **D12** | 注入 PAC 时 `mandatory: false`，PAC 顶层 `try/catch` 兜底 `DIRECT` | 最坏结果是「不走代理」，绝不会是「整个浏览器断网」 | `mandatory: true`（PAC 出错即断网） |

### 5.2 执行期的优化与偏离记录（含原因）

| # | 优化 / 偏离 | 原因 |
|---|---|---|
| O1 | **计划外新增 2 个库文件**（原计划 9 个 lib → 实际 10 个，含删除 1 个后）：`src/lib/hash.js`、`src/lib/schema.js` | 消除重复。原计划让 `node-model`/`rule-matcher`/`storage` 各自实现哈希 → 会出现三份；规范化默认值原计划塞在 `storage.js`，但 `createNode` 也需要同一套 → 会出现两套默认值。抽出后 id 生成与默认值语义各自唯一 |
| O2 | `npm test` 最终定为 `node --test tests/*.test.js`（**glob 不加引号**） | 三次调整才收敛：① `node --test tests/` 在 Windows 上报 `Cannot find module '...\tests'`（已实测复现）；② 改成加引号的 `"tests/*.test.js"` 后 Windows 正常，但**首次 CI 就在 Linux + Node 20 上挂了** —— 引号阻止 shell 展开，而 Node 的 `--test` 自带 glob 支持要到 Node 22 才有；③ 去掉引号后四种组合全通：Linux/Git Bash 由 shell 展开，Windows 的 cmd 不展开则由 Node 22+ 自己展开。顺带仍然排除了 `tests/helpers/` |
| O3 | `createRule` 不再复用 `normalizeRule` | 复用会**静默丢弃**非法规则，UI 就拿不到「哪里错了」。改为 `createRule` 只构造形状（宽松），`validateRule` 作为唯一裁决者并返回可展示的中文原因 |
| O4 | **不执行 `git init` 与任何 `git commit`** | 当前目录不是 git 仓库，用户也未要求版本控制。各任务的检查点改为「跑一次 `npm run verify` 确认全绿」。用户若需要版本控制，`git init` 后一次性提交即可 |
| O5 | `tools/check-manifest.mjs` 增加 **2 项静态检查**：③ 命名导入必须真的被目标模块导出；④ UI 侧每个 `send('type')` 都必须有对应 handler | 这两类错误浏览器**只会静默不启动 SW / 什么都不做**，极难排查。本次变更中它们真的各抓到一次：删掉 `needsBridge` 后残留的导入、删掉 `getSingbox` 后残留的调用 |
| O6 | `check-manifest.mjs` 检查 `chrome.*` 前先把块注释挖空（用空格替换、保留换行以维持行号） | 原实现把 JSDoc 里「不得引用 `chrome.*`」这句解释本身报成违规，出现 5 个误报。注释里提到 chrome 恰恰是解释「为什么不能用」的地方，必须允许 |
| O7 | 重画图标 | 第一版渲染出来读起来像字母「E」。用 `Read` 直接看生成的 PNG 确认后重设计（圆点起点 + 三条分叉线 + 端点方块），并在 128px 与 16px 两个尺寸下再次目视确认 |
| O8 | 去掉两处不必要的动态 `import('./state.js')`（`proxy-controller.js` 的 `saveStartIndex`、`request-logger.js` 的 `noteEgressIp`） | 两处都不存在循环依赖，动态导入只是徒增复杂度与首次调用延迟 |
| O9 | `messaging.js` 的导入全部起别名（`probeNode as runProbeNode` 等） | handler 方法名与导入的函数同名。虽然对象字面量里的方法名不会真的遮蔽外层作用域（原代码可以工作），但读代码时极易误判，别名后意图明确 |
| O10 | 新增 `tests/integration.test.js`（10 个测试） | 单元测试各自绿了，不等于串起来是对的。这组测试从「用户粘贴的原始文本」出发，经解析 → 建模 → 规范化 → 持久化 → 生成 PAC → 在 `node:vm` 里**真的执行 PAC**，把 `task-change.md` 要求优先保证的主链路整条跑一遍 |
| O11 | `buildStats` 的 `available` 改用 `isSelectable`，并新增 `unsupported` 计数 | 变更前它只看 `enabled && !autoDisabled`，会把不支持的节点算成「可用」，与实际参与分流的节点数不符 —— 这正是最容易骗到用户的地方 |
| O12 | 节点解析入口从 `parseNodeLine` 升级为 `classifyNodeLine`，把每行分成 节点 / **不支持** / 非法 / 注释 四类 | `task-change.md` 要求「其他类型给出明确不支持提示」。若沿用「返回 null」的旧接口，不支持的协议和真正的乱码会混成同一类错误，提示不出规定文案 |
| O13 | 订阅条目拆分改用前瞻正则 | 原来按 `,` / `;` 直接切分，会把 `alpn=h2,http/1.1` 这类 URL 参数里的逗号误当分隔符，一条好节点被撕成两条垃圾 |
| O14 | 统一决策编号 | 代码注释里原本引用「plan.md 决策 D5 / D7」，而 `docs/ARCHITECTURE.md` 重编号后同一决策变成 D6 / D8。已把 `constants.js`、`check-manifest.mjs`、`health-monitor.js`、`request-logger.js` 里的引用同步为 D6 / D8，三处（plan / docs / 代码）现在编号一致 |
| O15 | 计划外补做 `src/background/` 的自动化测试（Task 17，+34 个测试） | 交付时后台层只有静态校验，行为全靠人工点浏览器 —— 而「测速失败 → 自动禁用 → 重新注入 PAC」是最易错也最难人工复现的链路。用 `chrome.*` 替身把它搬进 Node，并且**断言注入的 PAC 原文在沙箱里的真实路由行为**，而不是「函数被调用过」。附带把「SW 能否被求值、事件是否注册齐」这类原本只能看控制台的检查也变成了断言 |
| O16 | 用两次「故意破坏 → 确认测试变红 → 恢复」验证新测试的有效性 | 一次写完就全绿的测试有可能只是摆设。删掉 `recordProbeResult` 末尾的 `applyProxy()`、以及让 `pacToken()` 给不支持的协议也发 token，两次各有 2 个测试如期失败 —— 说明它们真的守在关键位置上 |

---

## 6. 文件结构（与磁盘实际一致）

```
page-proxy/
├── plan.md                       # 本计划（持续更新）
├── task.md  task-change.md       # 需求与变更（只读）
├── README.md                     # 安装 / 使用说明
├── package.json                  # 仅脚本，dependencies 为空
├── .gitignore
├── manifest.json                 # MV3 清单
├── .github/workflows/build.yml   # CI：测试 + 静态校验 + 打包 + 打 tag 时建 Release
├── src/
│   ├── lib/                      # 纯逻辑，零 chrome 依赖，全量单测
│   │   ├── constants.js          # 默认配置、SUPPORTED_PROTOCOLS、统一提示文案
│   │   ├── hash.js               # FNV-1a 稳定哈希与 id 生成
│   │   ├── schema.js             # 持久化结构规范化，永不抛异常
│   │   ├── storage.js            # 读写 / 迁移 / 导入导出（StorageArea 注入）
│   │   ├── node-parser.js        # 节点链接与订阅解析、四类分诊
│   │   ├── node-model.js         # pacToken()（可用性唯一闸门）、isSelectable()、提示语
│   │   ├── rule-matcher.js       # 规则构造、校验、编译、匹配
│   │   ├── scheduler.js          # 节点池计算、轮询与哈希（PAC 之外的可测实现）
│   │   ├── pac-generator.js      # 把配置编译成 PAC 脚本字符串
│   │   └── logger.js             # 环形日志缓冲
│   ├── background/               # 只做 Chrome API 编排
│   │   ├── service-worker.js     # 事件注册与启动流程
│   │   ├── state.js              # 配置缓存 + 运行时态（session）
│   │   ├── proxy-controller.js   # 全扩展唯一写浏览器代理设置的地方
│   │   ├── health-monitor.js     # 测速、超时判定、自动禁用、alarms
│   │   ├── request-logger.js     # webRequest 只读观测 → 日志（含出口 IP）
│   │   ├── auth-provider.js      # onAuthRequired 自动应答
│   │   └── messaging.js          # UI 与后台之间唯一的契约（20 个 handler）
│   ├── pages/
│   │   ├── shared/{theme.css, api.js}
│   │   ├── options/{options.html, options.css, options.js}
│   │   └── popup/{popup.html, popup.css, popup.js}
│   └── assets/icons/             # icon16/32/48/128.png（脚本生成）
├── tools/
│   ├── make-icons.mjs            # 零依赖 PNG 编码器 + 图标绘制
│   ├── check-manifest.mjs        # 加载扩展之前的 7 项静态校验
│   └── pack.mjs                  # 零依赖 zip 打包器（可复现构建）
├── tests/                        # 11 个测试文件 + 2 个助手，共 169 个测试
│   ├── integration.test.js       # ★ 主链路集成测试（真的执行 PAC）
│   ├── background.test.js        # ★ 后台编排（chrome.* 替身 + 执行注入的 PAC）
│   ├── service-worker.test.js    # ★ SW 启动冒烟（单独进程，因为导入即 boot）
│   ├── pack.test.js              # ★ 打包产物（另写一份 zip 解析器逐字节比对）
│   ├── {storage,node-parser,node-model,rule-matcher}.test.js
│   ├── {scheduler,pac-generator,logger}.test.js
│   └── helpers/
│       ├── pac-sandbox.js        # node:vm PAC 沙箱执行器
│       └── chrome-stub.js        # chrome.* 与 fetch 替身
└── docs/
    ├── ARCHITECTURE.md           # 决策 D1–D12、请求生命周期、模块职责
    ├── LIMITATIONS.md            # 10 条技术限制（为什么只支持 HTTP/HTTPS 等）
    └── PACKAGING.md              # 打包、CI、为什么不做 crx
```

> 已删除：`src/lib/singbox-export.js`、`tests/singbox-export.test.js`（Task 7 取消）。

---

## 7. 详细执行步骤

> 每个任务的检查点都是「跑一次自动化验证并全绿」。下方记录的是**实际交付的接口与实测结果**，
> 而不是当初的预想 —— 计划与代码不一致时，以代码为准并回写此处。
> 复核命令：`npm run verify`（= `npm test` + `npm run check`）。

### Task 1: 工程骨架 + 常量 + 存储层 —— **已完成**

- [x] `package.json`（零依赖，`type: module`，4 个脚本：`test` / `check` / `icons` / `verify`）、`.gitignore`
- [x] `src/lib/constants.js`：`SUPPORTED_PROTOCOLS=['http','https']`、`KNOWN_PROTOCOLS`、`PROTOCOL_ALIASES`、
      `PROTOCOL_LABELS`、`UNSUPPORTED_PROTOCOL_MESSAGE`、`PAC_KEYWORDS={http:'PROXY',https:'HTTPS'}`、
      `DEFAULT_PORTS`、`RULE_TYPES`、`defaultProbeSettings()` / `defaultSettings()` / `defaultConfig()`（均返回新对象）
- [x] `src/lib/hash.js`（O1）：`fnv1a32` / `hashHex8` / `stableId` / `isValidId`
- [x] `src/lib/schema.js`（O1）：`normalizeProtocol` / `normalizeNode` / `normalizeRule` / `normalizeSettings` / `normalizeConfig` 等，**永不抛异常**，单条修不好就丢这一条
- [x] `src/lib/storage.js`：`createStore(area)`（StorageArea 注入，便于测试）、`migrateConfig`、
      `exportConfig`（保留密码，清空 `health.egressIp`/`lastError`）、`importConfig`（失败抛 `配置解析失败：…`）、`appendNodes`
- [x] 检查点：`node --test tests/storage.test.js` → **9 passed**

### Task 2: 节点链接与订阅解析器 —— **已完成**（按变更返工）

- [x] `classifyNodeLine(line)` → `{kind:'comment'}` | `{kind:'node',node}` | `{kind:'unsupported',protocol,label,reason,line}` | `{kind:'invalid',reason,line}`（O12）
- [x] `parseNodeLine(line)` → 只在 http/https 时返回节点，其余一律 `null`
- [x] `parseNodeList(text)` → `{nodes, unsupported, errors}`；`decodeSubscription` / `tryBase64` 兼容 URL-safe base64 与缺失 padding
- [x] 不支持提示固定为 `` `${label} 节点：${UNSUPPORTED_PROTOCOL_MESSAGE}` ``
- [x] 裸 `host:port` 与 `host:port:user:pass` 按 http 处理；IPv6 字面量去方括号；端口越界整条丢弃
- [x] 已删除全部 vless / hy2 / trojan / ss 的 meta 解析分支
- [x] 检查点：`node --test tests/node-parser.test.js` → **21 passed**

### Task 3: 节点模型（可用性唯一闸门）—— **已完成**（按变更返工）

- [x] `pacToken(node)`：查 `PAC_KEYWORDS`，**查不到就返回 `null`** —— 这是 D5 的落点，
      也是「不支持的协议不可能漏进轮询」的唯一保证
- [x] `isSelectable(node)` = `enabled !== false && autoDisabled !== true && pacToken(node) !== null`
- [x] `isSupported` / `protocolLabel` / `unsupportedNodes(nodes)`
- [x] `nodeWarnings(node)`：不支持的协议**首先**产出规定文案并直接返回（不再叠加其他无意义提示）
- [x] `makeNodeId`（稳定哈希，重复导入 id 不变）/ `defaultNodeName` / `createNode`（重名追加 `(2)`）/ `dedupeNodes`
- [x] 已删除 `needsBridge` / `assignBridgePorts`
- [x] 检查点：`node --test tests/node-model.test.js` → **15 passed**

### Task 4: URL 规则匹配器 —— **已完成**

- [x] `makeRuleId` / `createRule`（只构形状，宽松，见 O3）/ `validateRule` → `{ok, reason}`（中文原因）
- [x] `wildcardToRegexSource`：只有 `*` 是通配符，`?` 与 `.` 按字面量处理
- [x] `compileRule`：非法正则返回 `test: () => false`，**永不抛异常**
- [x] `hostOf` / `matchUrl`：第一条命中的**启用**规则胜出（顺序即优先级）
- [x] `host` 类型判定 `h === pattern || h.endsWith('.' + pattern)`，因此 `notmanga.com` 不会误命中 `manga.com`
- [x] 检查点：`node --test tests/rule-matcher.test.js` → **15 passed**

### Task 5: 调度器 —— **已完成**

- [x] `selectablePool(nodes, nodeIds)`：用 `isSelectable` 过滤，绑定子集全不可用时回落到全部可用节点（D9）
- [x] `createRoundRobin(startIndex)`（先取后进，`startIndex` 语义正确，池长度变化不越界）
- [x] `hashPick(pool, key)` / `distribute(pool, count, strategy)`（UI 预览用）
- [x] 补充 2 个测试：不支持的协议不得进池、混合协议时只留 http/https
- [x] 检查点：`node --test tests/scheduler.test.js` → **15 passed**

### Task 6: PAC 脚本生成器（**本项目最关键**）—— **已完成**

- [x] `generatePac(config, {startIndex})` / `pacSummary(config)` → `{nodeCount, ruleCount, skipped:{nodes,rules}}`
- [x] 全部用户数据经 `JSON.stringify` 注入，无字符串拼接；脚本内无 `eval` / `new Function`
- [x] 判定顺序：总开关 → `__pp_node` 测速强制路由（无兜底）→ 绕过列表/单段主机名/私有网段 → 规则池 → 取 token → 按 `fallback` 决定是否加 `; DIRECT`
- [x] **`PP.tokens` 收录全部可表达节点（含被禁用的，供测速恢复），`PP.pools[].tokens` 只收 `isSelectable` 的** —— 「禁用节点从轮询消失但仍可单独测速」两个要求同时成立的关键
- [x] 正则在加载时逐条 `try/catch` 预编译进 `PP_RX`，非法的被隔离；顶层 `try/catch` 兜底 `DIRECT`（D12）
- [x] 私有网段逐条列出（PAC 的 `shExpMatch` 不支持数字区间），含 172.16–172.31、`::1`、`fe80:*`、`fc*`、`fd*`
- [x] 变更返工：删除 socks/vless/bridge 相关测试，改为「不支持的协议绝不进 PAC」「生成的脚本里不出现 SOCKS 关键字」「混合协议只留 http/https」
- [x] 检查点：`node --test tests/pac-generator.test.js` → **34 passed**

### Task 7: ~~sing-box 配置导出~~ —— **已取消**

- [x] 按 `task-change.md` 取消。删除 `src/lib/singbox-export.js` 与 `tests/singbox-export.test.js`（13 个测试），
      移除设置页的 sing-box 区块、`getSingbox` 消息、README 与文档相关章节

### Task 8: 环形日志缓冲 —— **已完成**

- [x] `createLogger({limit, now})` → `add` / `list` / `clear` / `size` / `setLimit` / `restore`
- [x] 最新在前；超限丢最旧；`limit` 非正数回落 200；`list` 返回浅拷贝（外部改不动内部）
- [x] 检查点：`node --test tests/logger.test.js` → **11 passed**

### Task 9: 后台 —— 运行时状态、PAC 注入、消息路由、SW 入口 —— **已完成**

- [x] `state.js`：`getConfig` / `setConfig` / `updateConfig` / `getLogger` / `getRuntime` /
      `bumpNodeStat` / `resetStats` / `saveRuntime` + 从 `chrome.storage.session` 恢复
- [x] `proxy-controller.js`：`applyProxy()` / `clearProxy()` / `readControl()` / `previewPac()`。
      `mandatory: false`；控制权非本扩展时写 `warn` 日志；每次注入让 `runtime.startIndex` 前进一格
- [x] `service-worker.js`：顶层**同步**注册 `onMessage`（返回 `true` 以支持异步响应）、`onInstalled`、
      `onStartup`、`alarms.onAlarm`，并 `installRequestLogger()` / `installAuthProvider()`；`boot()` 串行化
- [x] 启动时若发现历史配置里有非 HTTP/HTTPS 节点，写一条告警日志（`task-change.md` 的历史配置要求）
- [x] **一条纪律**：任何改动节点/规则/开关/健康状态的路径，结束前必须 `await applyProxy()`
- [x] 消息契约（20 个 handler，`tools/check-manifest.mjs` 第 ④ 项静态守护）：

| `type` | 载荷 | 返回 |
|---|---|---|
| `getState` | — | `{config, control, summary, stats, warnings, unsupportedIds, logs}` |
| `setEnabled` | `{enabled}` | `{ok, config, control}` |
| `saveConfig` | `{config}` | `{ok, config, summary}` |
| `addNodes` | `{text, merge}` | `{ok, added, unsupported, errors, config}` |
| `updateNode` / `deleteNode` / `deleteNodes` / `reorderNodes` | `{id\|ids\|patch}` | `{ok, config}` |
| `deleteUnsupportedNodes` | — | `{ok, removed, config}` |
| `saveRule` / `deleteRule` / `reorderRules` | `{rule\|id\|ids}` | `{ok, config, error?}` |
| `probeNode` / `probeAll` | `{id}` / — | `{ok, result(s), config}` |
| `resetNodeState` | `{id}` | `{ok, config}` |
| `getLogs` / `clearLogs` | `{kind, level, limit}` / — | `{ok, logs, stats}` |
| `exportConfig` / `importConfig` | — / `{text, merge}` | `{ok, text}` / `{ok, config, error?}` |
| `getPacPreview` | — | `{ok, pac, summary}` |

- [x] 每个 handler 都被 `try/catch` 包住，失败返回 `{ok:false, error}` 并写 `error` 级日志 —— **绝不静默失败**
- [x] 检查点：`npm run check` 通过（相对路径、命名导出、消息契约、`src/lib` 无 `chrome.*` 全部合格）
- [x] 检查点：`tests/background.test.js` + `tests/service-worker.test.js` 覆盖注入行为、
      控制权降级、注入失败、启动流程、消息契约异常路径（见 Task 17）

### Task 10: 后台 —— 延迟测速与自动禁用 —— **已完成**

- [x] `probeNode(id)`：给探测 URL 加 `__pp_node=<id>` 与 `_pp_t` 防缓存参数，`AbortController` 超时，
      `performance.now()` 计时。**不支持的协议直接拒绝**并返回规定中文提示 + `unsupported: true`
- [x] `recordProbeResult`：成功清零失败计数并解除自动禁用（>2000ms 记 `slow`）；
      失败累加，达到 `failureThreshold` 且开启 `autoDisable` 时置 `autoDisabled`，随后 `applyProxy()`
- [x] `probeAll()`：只测 `isSupported` 的节点，并发上限 5；全部节点都不支持时给专门的中文说明
- [x] `scheduleProbeAlarm()` / `onAlarm()`：`chrome.alarms` 最小周期 1 分钟，填更小的值提升到 1
- [x] `describeError`：把 `Failed to fetch` 翻译成「探测地址不支持跨域」并建议换回默认地址
- [x] 检查点：探测路由行为由 `pac-generator` 与 `integration` 两组测试覆盖（强制路由、无兜底、禁用节点仍可测速）
- [x] 检查点：`tests/background.test.js` 覆盖不支持协议拒测、成功落库、连续失败自动禁用+PAC 重注入、
      超时识别、自动恢复、`probeAll` 过滤、全不支持时的提示、定时任务重建与触发（见 Task 17）
- [ ] 真实代理的连通性与真实延迟数字：**需要真实网络，未执行（见第 8 节）**

### Task 11: 后台 —— 请求观测日志与代理认证 —— **已完成**

- [x] `request-logger.js`：非阻塞 `onBeforeRequest` / `onCompleted` / `onErrorOccurred`；
      **只记日志，绝不改节点状态**（D8）；记录 `details.ip` 作为出口 IP 证据；`seen` map 超 500 条清空防泄漏
- [x] `noteEgressIp`（把测速完成时的出口 IP 落到节点上）、`findNodeByIp`（给线上请求归因）
- [x] `auth-provider.js`：`onAuthRequired` + `asyncBlocking`，只处理 `details.isProxy`；
      按「主机:端口」匹配**且仅匹配 `isSupported` 的节点**；同一 `requestId` 只应答一次（凭据错误时交还浏览器，避免无限重试）
- [x] 地址匹配上但协议不支持时，日志明确写出「该节点是 X 类型，本程序仅支持 HTTP/HTTPS 代理」
- [x] **凭据只存 `chrome.storage.local`，绝不进 PAC** —— 由 `pac-generator` 与 `integration` 两处测试守着
- [x] 检查点：`tests/background.test.js` 覆盖认证应答、二次挑战不重试、站点 401 不受影响、
      地址匹配但协议不支持时的说理日志；观测层「只记日志绝不改节点状态」有专项测试（见 Task 17）
- [ ] 浏览器真实认证框行为（弹不弹框）：**需真实 Basic 认证代理，未执行（见第 8 节）**

### Task 12: manifest + 图标 + 清单校验脚本 —— **已完成**

- [x] `manifest.json`：MV3、`minimum_chrome_version: 108`、
      `permissions: ["proxy","storage","alarms","webRequest","webRequestAuthProvider"]`、
      `host_permissions: ["<all_urls>"]`、SW `type: module`、`options_page`、`action.default_popup`、4 个尺寸图标
- [x] `tools/make-icons.mjs`：零依赖 PNG 编码器（自算 CRC32 + IHDR/IDAT/IEND + `deflateSync`），
      3×3 超采样、圆角底 + 分叉线图形，生成 16/32/48/128
- [x] `tools/check-manifest.mjs`：7 项静态校验（见第 6 节），任一失败 `exit 1` 并打印中文原因
- [x] 反向验证：故意删掉一个导出、故意改错一个消息名，两项新检查各自如期报错，恢复后通过（O5）
- [x] 检查点：`npm run icons` 生成 4 个合法 PNG；`npm run check` → `✔ manifest 校验通过`

### Task 13: 设置页（Options）—— **已完成**（按变更返工）

- [x] `src/pages/shared/api.js`：`send()`（`ok:false` 抛中文 Error 并挂 `error.response`）、
      `fmtTime` / `fmtLatency` / `fmtAgo` / `healthLabel` / `healthDotClass` / `clear` / `showBanner` /
      `debounce` / `downloadText` / `copyText` / `fileStamp`、
      `el(tag, props, ...children)` —— **收到 `html` 属性直接抛错**（R14）
- [x] `src/pages/shared/theme.css`：CSS 变量 + `prefers-color-scheme: dark`、组件类、720px 断点、字体栈含 `"Microsoft YaHei"`
- [x] `options.html/css/js` 四个分区：总开关与告警条 / 节点（批量导入 + 表格 + 批量操作）/
      规则（表单 + 表格 + 预设 + 规则测试器）/ 设置与备份（导入导出 + PAC 预览）
- [x] 单向数据流：所有写操作走消息，成功后用返回的 `config` 整段重渲染，前端不维护第二份状态
- [x] `guard()` 包住每个交互，错误一律显示在对应区域，**不许静默**
- [x] `reportImport()` 逐行列出「不支持」与「无法识别」，不支持的节点在表格里标红、开关禁用、
      顶部红条汇总，并提供 `#btnDeleteUnsupported` 一键清除
- [x] 已移除 sing-box 区块；文案改为「仅支持 HTTP / HTTPS 代理」并列出不支持的类型
- [ ] **浏览器人工验证（未执行，见第 8 节）**

### Task 14: 状态页（Popup）—— **已完成**（按变更返工）

- [x] 380px 宽；状态圆点 + 总开关；错误 / 控制权 / 不支持三种告警条
- [x] 四宫格统计（总数 / 可用 / 已禁用 / 平均延迟），`available` 用 `isSelectable` 计算（O11）
- [x] 节点列表（单节点开关 + 单节点测速；不支持的节点标「不支持」徽标且开关禁用）、生效规则列表、
      可过滤的日志列表
- [x] 打开时拉一次完整状态，之后每 2 秒只拉日志与统计（轻量，不重建列表以免打断操作），
      `unload` 时清掉 interval —— 否则会让 SW 一直被唤醒
- [ ] **浏览器人工验证（未执行，见第 8 节）**

### Task 15: 文档 —— **已完成**（按变更返工）

- [x] `README.md`：解决什么问题 / 安装 / 5 分钟上手 / 节点格式 / 规则类型 / 分流与测速设置 /
      常见问题 / 权限逐条说明 / 开发命令
- [x] `docs/LIMITATIONS.md`：10 节 —— 只支持 HTTP/HTTPS（含逐类型「为什么不支持」）、CONNECT、
      凭据不能进 PAC、HTTP/2 复用降低粒度、坏代理列表、代理设置独占、探测 CORS、
      `mandatory:false` 的行为、SW 休眠、历史配置里的不支持节点
- [x] `docs/ARCHITECTURE.md`：架构图、D1–D12、一次图片请求的完整生命周期、数据结构、模块职责表、测试策略
- [x] 已删除所有 sing-box / 网桥 / SOCKS 可用 的表述
- [x] 检查点：文档内部相对链接全部有效（脚本校验通过）

### Task 16: 全量验证与交付检查 —— **自动化已完成 / 人工待执行**

- [x] `npm test` → **130 passed, 0 failed**；`npm run check` → 通过（20 个 JS、2 个 HTML）
- [x] 需求走查：F1–F15 与 `task-change.md` 的「必须保留 / 不再作为目标」逐条对照，见第 1 节表格
- [x] 边界与健壮性由测试覆盖：无节点 / 全部不支持 / 全部被自动禁用 → 直连不报错；
      非法正则被隔离；截断 JSON 报「配置解析失败」且原配置不丢；总开关关闭时一律直连
- [ ] **端到端浏览器验证（未执行）** —— 见第 8 节清单

### Task 17: 后台编排层自动化测试 —— **已完成**（计划外补做）

**动机**：Task 9–11 交付后，`src/background/` 7 个模块只有静态校验，行为全靠人工点浏览器；
而「测速失败 → 自动禁用 → 重新注入 PAC」恰恰是最容易出错、又最难人工复现的一条链路。

- [x] `tests/helpers/chrome-stub.js`：`chrome.storage.local/session`、`chrome.proxy.settings`、
      `chrome.alarms`、`chrome.runtime` 与 `chrome.webRequest` 的替身，外加可替换的 `fetch`；
      暴露调用记录（`proxyCalls` / `fetchCalls` / `alarms` / `listeners`）与 `lastPac()`
- [x] **关键手法**：断言的不是「函数被调用过」，而是把 `chrome.proxy.settings.set` 收到的
      **PAC 原文取出来丢进 `node:vm` 沙箱执行**，验证注入后的真实路由行为
- [x] `tests/background.test.js`（27 个）：注入行为与 `mandatory:false`、总开关关闭撤销设置、
      全不可用时的 warn、注入失败不假装成功、控制权降级为 warn、起点每次前进；
      不支持协议拒测（且不发请求）、成功落库、连续失败自动禁用**且 PAC 不再选中它**、
      超时识别、自动恢复、`probeAll` 只测支持的协议、全不支持时的提示、定时任务重建与触发；
      `addNodes` 混合粘贴、全不支持时明确失败、`deleteUnsupportedNodes` 清理死引用、
      `getState` 统计口径、`setEnabled`、未知类型与 handler 异常、`resetNodeState`、`getPacPreview`；
      认证应答与二次挑战、协议不支持时的说理日志、观测层只记日志不改节点状态、探测请求只补出口 IP
- [x] `tests/service-worker.test.js`（7 个，单独进程 —— 导入 `service-worker.js` 即触发 `boot()`）：
      顶层 8 类事件是否注册齐、冷启动是否真的注入可用 PAC、历史 socks5 节点是否被挡在分流之外、
      启动日志与不支持节点告警是否写进 session、定时任务是否建立、`onMessage` 是否返回 `true` 并异步回传
- [x] **导入顺序约束**：`state.js` 在模块顶层就读 `chrome.storage.local`，
      所以测试必须先装替身再 `await import()`，不能用顶层 `import` 语句（已写进两个测试文件的注释）
- [x] **反向验证（确认测试真的能发现回归）**：
      ① 删掉 `recordProbeResult` 末尾的 `applyProxy()` → 2 个测试如期失败；
      ② 让 `pacToken()` 给不支持的协议也发 token → 2 个测试如期失败；两次都恢复后全绿
- [x] 检查点：`npm run verify` → **164 passed / 0 failed** + manifest 校验通过

### Task 18: zip 打包器 + GitHub Actions 自动构建 —— **已完成**（用户追加）

**背景**：用户问「能否用 GitHub Action 自动构建 crx」。我先说明了「开发人员模式解锁的是
加载解压缩，不等于安装本地 crx；自签名 crx 会被现代 Chromium 以缺少商店签名为由拒绝」，
用户据此决定**不要 crx**，只保留 zip 与自动构建。

- [x] `tools/pack.mjs`：零依赖 zip 打包器（只用 `node:zlib`），`--out` / `--check-version` 两个参数
- [x] 三条刻意设计：**可复现**（时间戳固定 1980-01-01，同源码必得字节相同的包）、
      **只装该装的**（仅 `manifest.json` + `src/`，并校验 manifest 引用的文件都在包内）、
      **压不小就退回存储**（避免产物比原文更大）
- [x] `tests/pack.test.js`（5 个）：用**另写一份**的 zip 解析器（读中央目录 → 定位本地头 → inflate）
      把包拆回来逐字节比对，避免「用同一个 bug 验证自己」；覆盖排除清单、可复现性、
      存储回退、空文件与中文路径
- [x] 用 Python 的 `zipfile` 独立复核过产物：CRC 全通过、30 个条目内容与源文件完全一致、
      未混入 `tests/` `tools/` `docs/` `*.md`
- [x] `.github/workflows/build.yml`：
      `verify` job 在 Node 24 上跑 `npm test` + `npm run check`，并额外校验
      **依赖表保持为空**、**图标可复现**（重新生成后不得有 diff）；
      `package` job 打 zip → 用 Python 复核可解压 → 传 Artifacts；
      打 `v*` 标签时先校验 tag 与 manifest 版本一致，再用预装的 `gh` CLI 建 Release
- [x] 刻意不跑 `npm install` / `npm ci`（零依赖、无 lockfile，`npm ci` 只会失败）；
      刻意不自动改版本号，只校验并在不一致时失败
- [x] 发 Release 用 `gh` CLI 而非第三方 action，少一份供应链依赖
- [x] `npm run pack` / `npm run release` 两个脚本；`.gitignore` 加 `dist/`
- [x] `docs/PACKAGING.md`：产物用途、本地打包、CI 触发规则、发版步骤、以及**为什么不做 crx**
- [x] 本地逐条模拟过工作流的 shell 步骤（零依赖检查、版本读取、版本一致/不一致两条分支、产物校验）
- [x] 检查点：`npm run release` → **169 passed / 0 failed** + manifest 校验通过 + zip 产出成功

---

## 8. 下一步行动

代码、文档与自动化测试已交付完毕。Task 17 把后台编排层搬进了 Node 自动化，因此下面只剩
**必须有真实网络 / 真实浏览器渲染才能判定**的部分。本环境没有浏览器，**以下每一条我都没有执行过**。

已经自动化、**不需要**再人工确认的（出问题的话 `npm test` 会先红）：
PAC 注入参数与路由决策、测速强制路由、连续失败自动禁用后 PAC 不再选中该节点、自动恢复、
定时任务重建、混合粘贴的分类与提示文案、不支持节点被挡在分流之外、消息契约的成功与异常路径、
认证应答与二次挑战、观测层不改节点状态、SW 冷启动流程与事件注册。

**需要用户在浏览器里走一遍的清单：**

1. **加载扩展**：Edge 打开 `edge://extensions` → 开启「开发人员模式」→「加载解压缩」→ 选仓库根目录
   （Chrome 同理，地址是 `chrome://extensions`）。预期：无红色报错，SW 控制台干净。
2. **两个页面的实际渲染**：设置页四个分区、弹窗 380px 布局、深色模式、720px 窄屏；
   粘贴下面这段确认提示逐条正确 ——
   ```
   http://1.2.3.4:8080#好节点
   https://5.6.7.8:8443#另一个好节点
   socks5://user:pass@9.9.9.9:1080#SOCKS节点
   vless://11111111-2222-3333-4444-555555555555@v.example.com:443?security=tls#VLESS节点
   这是垃圾行
   ```
   预期：入库 2 个；3 条显示 `本程序不支持该代理类型，仅支持 HTTP/HTTPS 代理` 且开关变灰；1 条「无法识别」。
3. **真实测速**：填入至少 2 个**真实可用**的 HTTP/HTTPS 代理 → 点「一键测速」。
   预期：显示真实毫秒数与出口 IP；不可用节点连续失败 2 次后变灰并标「已自动禁用」。
4. **规则 + 总开关**：插入预设规则并启用「常见图片扩展名」→ 打开总开关。
   预期：弹窗状态变「已生效（N 个节点 / M 条规则）」。
5. **★ 分流硬证据**：打开一话漫画（几十张图）→ 看弹窗「最近活动」里的**出口 IP**。
   预期：同一批图片出现**多个不同 IP**。若全是同一个 IP，多半是 HTTP/2 连接复用（R8），
   可增加节点数或换多域名图源再看。这是唯一无法在 Node 里模拟的判据。
6. **真实认证节点**：用一个需要 Basic 认证的 HTTP 代理访问命中规则的图片。
   预期：**不弹认证框**，图片正常加载，日志出现「已为节点「X」自动提供代理凭据」。
7. **控制权争夺**：装第二个代理扩展并让它接管 → 预期本扩展顶部出现红色「代理设置被占用」告警；
   关闭总开关 → `chrome.proxy.settings.get({incognito:false})` 回到 `mode: 'direct'`，上网恢复正常。
8. **持久化与卸载**：改配置 → 重启浏览器 → 配置仍在；卸载扩展 → 浏览器代理设置自动恢复。

任何一条不符合预期，回到对应 Task 修复；能在 Node 里复现的，先给它补一个测试再改代码。

---

## 9. 文件统计与进度追踪

**统计口径**：「完成」= 文件已写入磁盘且所属任务的自动化检查点通过。

| 类别 | 文件数 | 已完成 | 完成率 |
|---|---|---|---|
| 配置与清单（`package.json` / `.gitignore` / `manifest.json`） | 3 | 3 | 100% |
| 纯逻辑库 `src/lib/` | 10 | 10 | 100% |
| 后台 `src/background/` | 7 | 7 | 100% |
| UI `src/pages/` | 8 | 8 | 100% |
| 图标 `src/assets/icons/` | 4 | 4 | 100% |
| 工具 `tools/` | 3 | 3 | 100% |
| 测试 `tests/`（11 个测试文件 + 2 个助手） | 13 | 13 | 100% |
| 文档（`README.md` / `docs/*`） | 4 | 4 | 100% |
| CI（`.github/workflows/build.yml`） | 1 | 1 | 100% |
| 计划 `plan.md` | 1 | 1 | 100% |
| **合计** | **54** | **54** | **100%** |

| 任务 | 名称 | 状态 | 测试数 |
|---|---|---|---|
| 1 | 骨架 + 常量 + 存储 | **已完成** | 9 |
| 2 | 节点解析器 | **已完成**（返工） | 21 |
| 3 | 节点模型 | **已完成**（返工） | 15 |
| 4 | 规则匹配 | **已完成** | 15 |
| 5 | 调度器 | **已完成** | 15 |
| 6 | PAC 生成器 | **已完成**（返工） | 34 |
| 7 | ~~sing-box 导出~~ | **已取消** | −13 |
| 8 | 日志缓冲 | **已完成** | 11 |
| 9 | 后台编排 | **已完成** | 27 + 7（Task 17）+ `npm run check` |
| 10 | 测速与自动禁用 | **已完成** | 同上（真实网络验证待执行） |
| 11 | 请求日志与认证 | **已完成** | 同上（真实认证框待执行） |
| 12 | 清单 + 图标 + 校验脚本 | **已完成** | 脚本 |
| 13 | 设置页 | **已完成**（返工） | 渲染与交互待人工验证 |
| 14 | 状态页 | **已完成**（返工） | 渲染与交互待人工验证 |
| 15 | 文档 | **已完成**（返工） | 脚本 |
| 16 | 全量验证 | 自动化**已完成** / 人工**待执行** | 169 |
| 17 | 后台编排层自动化测试 | **已完成**（计划外补做） | 34 |
| 18 | zip 打包器 + CI 自动构建 | **已完成**（用户追加） | 5 |
| — | 主链路集成测试 | **已完成** | 10 |

**自动化测试总数：169**（`background 27` / `service-worker 7` / `integration 10` / `logger 11` /
`node-model 15` / `node-parser 21` / `pac-generator 34` / `pack 5` / `rule-matcher 15` /
`scheduler 15` / `storage 9`），失败 0。

**需求覆盖自检**

| 需求 | 承载任务 | 覆盖 |
|---|---|---|
| F1 节点管理 | 1, 3, 13 | ✅ |
| F2 规则管理 | 4, 13 | ✅ |
| F3 导入导出 | 1, 13 | ✅ |
| F4 持久化 | 1, 9 | ✅ |
| F5 HTTP/HTTPS 可用 | 2, 3, 6 | ✅ |
| F6 其余类型识别但不接纳 + 规定提示 | 2, 3, 9, 13, 14 | ✅（`integration.test.js` 专项守护） |
| F7 轮询分流 | 5, 6 | ✅ |
| F8 手动启停节点 | 13, 14 | ✅ |
| F9 测速（一键 + 定时） | 10, 14, 17 | ✅（真实网络验证待执行） |
| F10 自动禁用并跳过 | 6, 10, 17 | ✅（含「禁用后 PAC 真的不再选中」的自动化断言） |
| F11 手动重新启用 | 10, 13, 14, 17 | ✅ |
| F12 规则启停 + 绑定子集 | 4, 6, 13 | ✅ |
| F13 状态页要素 | 14 | ✅（渲染待人工验证） |
| F14 错误处理与日志 | 8, 9, 11, 13, 14, 17 | ✅ |
| F15 使用说明 | 15 | ✅ |

---

## 10. 变更日志

> 历史条目按当时的记录保留。**注意**：`2026-08-21 · 收窄范围` 那次变更重编了决策号，
> 更早条目里的编号是**当时的旧编号**，已在括号里标注对应的新编号。

### 2026-08-21 —— 初始计划创建

- 阅读 `task.md`，拆出 15 条功能需求（F1–F15）与 4 类交付物。
- **验证性实验**：用 `node:vm` 执行一段 PAC 风格脚本，确认 ① 模块作用域变量在多次 `FindProxyForURL`
  调用间保持（轮询计数器可行）② 生成的 PAC 可在 Node 里单测。这直接决定了 D1 / D2 / D7（原 D6）三个决策。
- 确定核心架构：`chrome.proxy` PAC 模式 + PAC 内轮询计数器（D1、D2）。
- 确定延迟探测方案：探测 URL 带 `__pp_node` 参数，由 PAC 强制路由到指定节点（D3）。
- 就 VLESS/Hysteria2 作出当时的决策（**旧 D4**）：浏览器扩展无原始 socket 能力，改为「解析纳管 +
  生成 sing-box 网桥配置 + 扩展轮询本地入口」。**此决策已于本日后续变更中整体废弃。**
- 确定纯逻辑与 Chrome API 物理隔离（旧 D5 → **现 D6**）。
- 识别并登记 12 项风险（R1–R12），拆出 16 个任务，完成 F1–F15 覆盖自检。

### 2026-08-21 —— 阶段 1 完成（Task 1–8，纯逻辑层）

- **计划外新增 2 个库文件**：`src/lib/hash.js`（FNV-1a 稳定哈希与 id 生成）、`src/lib/schema.js`
  （持久化结构规范化）。原因是消除重复：否则会出现三份哈希实现与两套默认值（见 O1）。
- **修正 `npm test` 命令**：`node --test tests/` 在本机 Windows + Node 24 下报
  `Cannot find module '...\tests'`，改为 `node --test "tests/*.test.js"` 后正常（见 O2）。
- **`createRule` 语义调整**：改为只构造形状，由 `validateRule` 单独裁决并返回中文原因（见 O3）。
- **新增决策（旧 D11）**：不执行 `git init` / `git commit`，检查点改为跑测试（现记为 O4）。
- 测试数从计划的 113 增至 132，补充了 PAC 探测参数在 query 末尾、`rotateEvery=2` 的换节点节奏、
  `startIndex` 生效、规则为空时不误代理全部流量、172.16–172.31 私有段绕过等边界用例。
- **PAC 生成器关键实现**：`PP.tokens` 收录所有可表达节点（含被禁用的，供测速与恢复），
  `PP.pools[].tokens` 只收当前可轮询的 —— 这是「禁用节点从轮询消失但仍可单独测速」同时成立的关键。

### 2026-08-21 —— 阶段 2–4 完成（后台编排、清单与图标、两个 UI 页面、文档）

- **Task 9–11**：7 个 `src/background/` 模块落地。确立「任何改动节点/规则/开关/健康状态的路径，
  结束前必须 `applyProxy()`」这条纪律；`proxy-controller.js` 是全扩展唯一写代理设置的地方。
- **Task 12**：`manifest.json` + 零依赖 PNG 编码器生成 4 个尺寸图标。第一版图标渲染出来
  读起来像字母「E」，用 `Read` 直接看 PNG 确认后重画，并在 128px 与 16px 下再次目视确认（O7）。
- **`tools/check-manifest.mjs` 增加 2 项静态检查**（O5）：命名导入必须真的被目标模块导出；
  UI 侧每个 `send('type')` 都必须有 handler。用「故意破坏再恢复」的方式反向验证过两项都真的会报错。
- 修掉 `chrome.*` 检查的 5 个误报：先把块注释挖空（用空格替换、保留换行以维持行号）再检查（O6）。
- **Task 13–14**：两个页面采用单向数据流（写操作后用返回的 `config` 整段重渲染），
  `el()` 拒绝 `html` 属性，杜绝用户粘贴的节点名走到 `innerHTML`（R14）。
- 去掉两处不必要的动态 `import('./state.js')`（O8）；`messaging.js` 的导入统一起别名（O9）。
- **Task 15**：`README.md` + `docs/ARCHITECTURE.md` + `docs/LIMITATIONS.md`，内部链接脚本校验通过。

### 2026-08-21 —— **按 `task-change.md` 收窄范围：仅支持 HTTP / HTTPS**（本次变更的核心）

**范围变更**

- **完全取消高级协议**：VLESS / VMess / Hysteria2（含 `hy2`）/ Trojan / Shadowsocks(SSR) / TUIC
  不再作为可用类型；**SOCKS4 / SOCKS5 一并移出支持范围**。
- **取消本地网桥与 sing-box 导出**：删除 `src/lib/singbox-export.js` 与 `tests/singbox-export.test.js`
  （13 个测试），删除 `bridge` 字段、`BRIDGE_PORT_BASE`、`needsBridge()`、`assignBridgePorts()`、
  `getSingbox` 消息与设置页的 sing-box 区块。主链路不再依赖任何本地客户端或第三方内核。
- **决策 D4 改写**：由「高级协议走 sing-box 网桥」改为「**只支持 HTTP/HTTPS，其余识别但不接纳**」。
- **新增决策 D5**：可用性判定收敛到 `pacToken()` 单一出口 —— 非 http/https 一律返回 `null`，
  `isSelectable`、PAC 节点池、状态统计全建立在它之上，因此**结构上不存在**漏进轮询的路径。
- 决策整体重编号为 D1–D12 并与 `docs/ARCHITECTURE.md` 对齐（旧 D5→D6、旧 D6→D7、旧 D7→D8、
  旧 D8→D9、旧 D9→D10、旧 D10→D11，新增 D12「`mandatory:false` + 顶层 try/catch」）。
- **风险 R11（高级协议无法实现）与 R12（SOCKS5 认证不被支持）退役**，
  新增 R5（历史配置里的不支持节点静默参与分流）与 R14（节点名 XSS）。

**代码改动**

- `constants.js`：新增 `SUPPORTED_PROTOCOLS=['http','https']`、`KNOWN_PROTOCOLS`、`PROTOCOL_LABELS`、
  `UNSUPPORTED_PROTOCOL_MESSAGE`；`PAC_KEYWORDS` 收缩为 `{http:'PROXY', https:'HTTPS'}`；
  删除 `PROTOCOLS` / `DIRECT_PROTOCOLS` / `BRIDGE_PROTOCOLS` / `BRIDGE_PORT_BASE`。
- `node-parser.js`：入口升级为 `classifyNodeLine()`，把每行分成 节点 / 不支持 / 非法 / 注释 四类（O12）；
  条目拆分改用前瞻正则，避免 `alpn=h2,http/1.1` 里的逗号被误当分隔符（O13）；
  删除全部高级协议 meta 解析。
- `node-model.js`：`pacToken()` 成为唯一闸门；`nodeWarnings()` 对不支持的协议**首先**产出规定文案。
- `health-monitor.js` / `auth-provider.js`：拒绝对不支持的协议测速与应答认证，并给出规定文案；
  地址匹配但协议不支持时日志写明「该节点是 X 类型」。
- `messaging.js`：新增 `deleteUnsupportedNodes` handler；删除 `getSingbox`；
  `buildStats.available` 改用 `isSelectable` 并新增 `unsupported` 计数（O11 —— 变更前会把不支持的
  节点算成「可用」，是最容易骗到用户的地方）；`stateSnapshot` 增加 `warnings` / `unsupportedIds`。
- `service-worker.js`：启动时若发现历史配置含非 HTTP/HTTPS 节点，写一条告警日志。
- 两个 UI 页面：不支持的节点标红徽标 + 开关禁用 + 顶部红条 + 一键清除；文案统一改为「仅支持 HTTP/HTTPS」。
- 顺手修掉变更中打错的一个全角括号 `（`（在 `messaging.js` 的模板拼接里，会直接导致语法错误）。

**测试与文档**

- **新增 `tests/integration.test.js`（10 个测试）**（O10）：从「用户粘贴的原始文本」出发，
  经解析 → 建模 → 规范化 → 持久化 → 生成 PAC → 在 `node:vm` 里真的执行 PAC，
  把 `task-change.md` 要求优先保证的主链路整条跑一遍。含专项断言：
  混合粘贴只接纳 http/https 且逐条提示、历史 socks/vless 节点不参与分流、
  全是不支持的节点时正常直连而不是断网、PAC 里绝不出现账号密码、导出再导入行为完全一致。
- `pac-generator.test.js` / `node-parser.test.js` / `node-model.test.js` / `scheduler.test.js` 按新范围返工，
  新增「生成的脚本里不出现 `SOCKS` 关键字与任何不支持节点的主机名」等断言。
- `README.md` / `docs/LIMITATIONS.md` / `docs/ARCHITECTURE.md` 重写，删除全部 sing-box / 网桥 /
  SOCKS 可用 的表述；`LIMITATIONS.md` 第 1 节据实解释每种类型「为什么做不到」。
- **验证结果**：`npm test` → **130 passed / 0 failed**；`npm run check` → 通过（20 个 JS、2 个 HTML）。

### 2026-08-21 —— 计划重写以对齐变更后的实际状态

- 按「检查代码与计划的**实际状态**」的要求，逐一核对磁盘文件、导出符号、handler 名单、
  每个测试文件的用例数，据此重写全部 10 节，而不是照旧任务编号改字。
- 第 1 节：F5/F6 改写为「仅 HTTP/HTTPS 可用」+「其余识别但不接纳」；1.2 节列出 5 项由变更取消的目标。
- 第 2 节：阶段 1–4 全部标「已完成」，并**明确写出唯一未完成项是浏览器人工验证、且我没有执行过**。
- 第 4 / 5 节：R11、R12 标为退役；新增 R5、R13、R14；决策表改为与 `docs/ARCHITECTURE.md` 同号的 D1–D12，
  并把执行期偏离单列为 5.2 节的 O1–O14（原「D11 不用 git」降级为 O4）。
- 第 6 节文件结构、第 9 节统计口径全部对齐磁盘实际：47 个文件、130 个测试、
  `src/lib/` 10 个模块（删 `singbox-export.js`、加 `hash.js`/`schema.js`）、`tests/` 增 `integration.test.js`。
- 第 7 节：Task 7 标「已取消」，其余任务记录**实际交付的接口**与实测检查点结果；
  Task 10/11/13/14/16 里依赖浏览器的步骤保留为未勾选，如实反映状态。
- 第 8 节：把原「下一步做什么」改为**9 条浏览器人工验证清单**（含混合粘贴的原样测试文本、
  分流硬证据的判读方法、自动禁用与恢复、认证节点、代理占用、历史配置）。
- **统一决策编号**（O14）：把 `constants.js`、`tools/check-manifest.mjs`、`health-monitor.js`、
  `request-logger.js` 注释里的「决策 D5 / D7」同步为 D6 / D8，使 plan / docs / 代码三处编号一致；
  同时补全 `check-manifest.mjs` 头部注释里遗漏的两项检查（3b、4b、6）。
- 复核：`npm run verify` 仍为 **130 passed / 0 failed** + `✔ manifest 校验通过`。


### 2026-08-21 —— 补做后台编排层自动化测试（Task 17）

**动机**：交付后复盘发现一处名不副实 —— `src/background/` 7 个模块只有静态校验，
所有行为都记在「浏览器人工验证」清单里。而这一层恰好包含最易错、又最难人工复现的链路：
测速连续失败 → 自动禁用 → **重新注入 PAC** → 该节点从轮询中消失。人工验证需要真实的坏节点、
等两轮测速、还要能看出「PAC 确实重新注入了」，实际上很难可靠执行。

**做法**

- 新增 `tests/helpers/chrome-stub.js`：`chrome.storage.local/session`、`chrome.proxy.settings`、
  `chrome.alarms`、`chrome.runtime`、`chrome.webRequest` 的替身 + 可替换的 `fetch`，
  并把调用记录（含注入的 PAC 原文）暴露给测试。
- **关键手法**：断言的不是「`chrome.proxy.settings.set` 被调用过」，而是把它收到的 **PAC 原文
  取出来丢进已有的 `node:vm` 沙箱执行**，验证注入后的真实路由决策。这样测的是行为，不是调用痕迹。
- 新增 `tests/background.test.js`（27 个）：注入参数与 `mandatory:false`、总开关关闭撤销设置、
  全不可用时的 warn、注入失败不假装成功、控制权降级、起点每次前进；不支持协议拒测且不发请求、
  连续失败自动禁用**且 PAC 不再选中它**、超时识别、自动恢复、`probeAll` 过滤、定时任务重建与触发；
  `addNodes` 混合粘贴、`deleteUnsupportedNodes` 清理死引用、`getState` 统计口径、
  未知消息类型与 handler 异常、认证应答与二次挑战、观测层只记日志不改节点状态。
- 新增 `tests/service-worker.test.js`（7 个，单独进程 —— 导入即触发 `boot()`）：
  8 类事件是否注册齐、冷启动是否注入可用 PAC、历史 socks5 节点是否被挡在分流外、
  启动告警是否写进 session、定时任务是否建立、`onMessage` 是否返回 `true` 并异步回传。
- **踩到并记录的约束**：`state.js` 在模块顶层就读 `chrome.storage.local`，
  所以测试必须先装替身再 `await import()`，不能用顶层 `import` 语句。

**验证测试本身有效**（O16）：做了两次「故意破坏 → 确认变红 → 恢复」——
① 删掉 `recordProbeResult` 末尾的 `applyProxy()` → 2 个测试失败；
② 让 `pacToken()` 给不支持的协议也发 token → 2 个测试失败。恢复后全绿。

**结果**：测试数 130 → **164**（+34），失败 0；`npm run check` 仍通过。
第 8 节的人工清单相应收缩为 8 条，只保留真正依赖真实网络与浏览器渲染的项
（真实连通性与延迟、多个真实出口 IP、HTTP/2 复用表现、真实认证框、控制权争夺、页面渲染、卸载恢复）。
同步更新 `README.md` 与 `docs/ARCHITECTURE.md` 的测试章节（新增四层测试表与后台测试手法说明）。

### 2026-08-21 —— 追加 zip 打包器与 GitHub Actions（Task 18）

**范围变化**：用户追加需求「能否用 GitHub Action 自动构建 crx」，原计划 1.2 节写的是
「不做打包上架」，本次据用户要求把**打包与自动构建**移入范围。

**关于 crx 的往复与最终结论**（记下来避免日后重复踩坑）

- 我先说明：`.crx` 已不能拖进浏览器安装（Chromium 会报 `CRX_REQUIRED_PROOF_MISSING`，
  即缺少应用商店签发的 publisher proof），因此建议 zip 为主、crx 为可选。
- 用户质疑「开发人员模式不是可以用外部 crx 吗」。我更正了区分：开发人员模式解锁的是
  **加载解压缩的本地目录**（以及「打包扩展程序」按钮，它是用来*生成* crx 的），
  **不等于**允许安装本地 crx；同时如实说明该行为随浏览器版本/渠道/平台而异，
  最快的判定方式是自己拖一次试试。
- 我先实现了 zip + crx 两套产物（crx3 手写 protobuf 头 + RSA 签名 + `updates.xml`），
  随后用户明确「不再需要打包为 crx」，于是**整套 crx 能力连同 6 个测试、CI 签名步骤、
  `*.pem` 忽略规则全部移除**，只在 `docs/PACKAGING.md` 留一段「为什么不做」的说明。

**最终交付**

- `tools/pack.mjs`：零依赖 zip 打包器（只用 `node:zlib`）。三条刻意设计 ——
  **可复现**（时间戳固定 1980-01-01，同源码必得字节相同的包）、
  **只装该装的**（仅 `manifest.json` + `src/`，并校验 manifest 引用的文件都在包内）、
  **压不小就退回存储**。参数只有 `--out` 与 `--check-version`。
- `tests/pack.test.js`（5 个）：用**另写一份**的 zip 解析器把包拆回来逐字节比对，
  刻意不复用 `pack.mjs` 的任何代码，避免「用同一个 bug 验证自己」。
  另用 Python `zipfile` 独立复核：CRC 全通过、30 个条目与源文件一致、无开发文件混入。
- `.github/workflows/build.yml`：`verify`（Node 24 跑测试与静态校验，
  外加**依赖表必须为空**、**图标必须可复现**两项守卫）→ `package`（打 zip、
  用 Python 复核可解压、传 Artifacts）→ 打 `v*` 标签时校验 tag 与 manifest 版本一致，
  再用预装的 `gh` CLI 建 Release。刻意不跑 `npm ci`（零依赖、无 lockfile），
  刻意不自动改版本号（只校验并在不一致时失败），刻意不用第三方 release action。
- `npm run pack` / `npm run release` 两个脚本；`.gitignore` 加 `dist/`；
  新增 `docs/PACKAGING.md` 并从 README 链过去。

**验证**：`npm run release` → **169 passed / 0 failed** + manifest 校验通过 + zip 产出成功；
工作流 YAML 用 `yaml.safe_load` 解析通过，其中每个 shell 步骤都在本地逐条模拟跑过
（含版本号一致与不一致两条分支）。

### 2026-08-21 —— 初始化 git 并公开发布到 GitHub

- **发布前安全扫描**：全仓扫过 IP:端口 与 `user:pass@` 形式的疑似真实凭据，
  命中的全部是占位示例（`1.2.3.4`、`10.0.0.x`、`*.example.com`、`user:pass`），确认无真实节点或密码。
- `git init -b main` → 首次提交 57 个文件 → `gh repo create` 建**公开**仓库
  <https://github.com/NooAcc/page-proxy> 并推送。过程文档（`plan.md` / `task.md` / `task-change.md`）
  按用户选择一并上传。
- **两处发布前修正**：
  - `.claude/settings.json`（本地工具配置）已从暂存区移除并加进 `.gitignore`。
  - 新增 `.gitattributes`（`* text=auto eol=lf`，PNG/ZIP 标 binary）。不加这条，
    Windows 上 clone 会把源码转成 CRLF，`tools/pack.mjs` 那句「同源码必得字节相同的包」就不成立了。
- **首次 CI 就抓到一个本地测不出来的问题**（正是加 CI 的价值）：
  `node --test "tests/*.test.js"` 在 Linux + Node 20 上报 `Could not find '.../tests/*.test.js'` ——
  引号阻止了 shell 展开，而 Node 自带的 `--test` glob 支持要到 Node 22 才有。
  去掉引号后四种组合全通（见 O2 已更新的记录）。
- **按用户要求升级 CI**：`actions/checkout@v4 → v7`、`actions/setup-node@v4 → v7`、
  `actions/upload-artifact@v4 → v7`（版本号是用 `gh api` 查的实际最新发布，不靠记忆），
  Node 版本矩阵收敛为单一 **Node 24**。
  升级时读了 v5 的 breaking changes，发现 `setup-node` v5 起会在检测到 `packageManager` 字段时
  **自动开启依赖缓存** —— 本项目零依赖、无 lockfile，因此显式设 `package-manager-cache: false`。
