# 漫画图片代理分流（Image-Proxy-Rotator）

[![构建与发布](https://github.com/NooAcc/Image-Proxy-Rotator/actions/workflows/build.yml/badge.svg)](https://github.com/NooAcc/Image-Proxy-Rotator/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个 Manifest V3 的 Edge / Chrome 扩展：把匹配规则的图片请求按**轮询**分散到多个
**HTTP / HTTPS 代理**上，绕过漫画站的单 IP 速率限制。

漫画站在阅读时会一次性预加载整章图片，几十个并发请求打在同一个出口 IP 上，很容易触发
站点限流，表现就是「部分图片一直转圈或裂图」。本扩展让这些请求轮流从不同代理出去，
把并发压力摊开。

> **支持范围：仅 HTTP / HTTPS 正向代理。**
> SOCKS4 / SOCKS5 / VLESS / VMess / Hysteria2 / Trojan / Shadowsocks 等类型**不受支持**，
> 粘贴后会被逐条提示并忽略，也绝不会参与分流。原因见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

---

## 安装

本扩展零依赖、零构建，源码即产物。两种装法任选：

**A. 下载现成的包**（推荐给只想用的人）

到 [Releases](https://github.com/NooAcc/Image-Proxy-Rotator/releases) 下载
`image-proxy-rotator-*.zip` 并解压。标着 `Pre-release` 的是每次提交自动构建的开发版，
不带该标记的是正式版。

**B. 直接克隆源码**

```bash
git clone https://github.com/NooAcc/Image-Proxy-Rotator.git
```

然后加载（两种方式都一样）：

**Edge**
1. 打开 `edge://extensions`
2. 打开左下角「开发人员模式」
3. 点「加载解压缩的扩展」，选择解压出来的目录 / 仓库根目录（含 `manifest.json` 的那一层）

**Chrome**：同理，地址是 `chrome://extensions`，按钮叫「加载已解压的扩展程序」。

装好后工具栏会出现一个分流图标，点它打开状态面板。

> `.crx` 不提供 —— 开发人员模式解锁的是「加载解压缩」，并不等于允许安装本地 crx，
> 自签名 crx 会被现代 Chromium 以缺少商店签名为由拒绝。详见 [docs/PACKAGING.md](docs/PACKAGING.md)。

---

## 5 分钟上手

1. **打开设置** —— 点扩展图标 →「打开设置」。

2. **添加节点** —— 在「批量导入」里每行粘贴一个代理，然后点「添加节点」：

   ```
   http://1.2.3.4:8080#节点A
   https://proxy.example.com:8443#节点B
   http://用户名:密码@5.6.7.8:3128#节点C
   10.0.0.5:3128
   ```

   节点数量建议 **≥ 4**，分流效果才明显。

3. **配置规则** —— 点「插入常用预设」，会加入 3 条常见的图片匹配规则（**默认关闭**）。
   打开「常见图片扩展名」那条即可。也可以自己加一条 `域名` 类型的规则，填漫画站的图片域名，
   这样更精准。

4. **测速** —— 点「一键测速」。每个节点会显示真实延迟；连接不上的节点在连续失败达到阈值后
   会被自动禁用并从轮询中剔除。

5. **打开总开关** —— 页面顶部的开关。

6. **验证生效** —— 打开一话漫画，然后点扩展图标看「最近活动」。
   如果同一批图片的日志里出现了**多个不同的出口 IP**，说明分流真的生效了。

---

## 节点格式

| 写法 | 说明 |
|---|---|
| `http://主机:端口` | HTTP 代理，缺端口默认 80 |
| `https://主机:端口` | HTTPS 代理（到代理本身的连接加密），缺端口默认 443 |
| `http://用户名:密码@主机:端口` | 带 Basic/Digest 认证，扩展会自动应答，不会弹框 |
| `主机:端口` | 按 HTTP 处理 |
| `主机:端口:用户名:密码` | 常见订阅格式，按 HTTP 处理 |
| `http://[2001:db8::1]:8080` | IPv6 需带方括号 |
| 行尾 `#名称` | 给节点命名，可选 |
| 行首 `#` / `//` / `;` | 注释行，会被跳过 |

也可以把整段 base64 订阅内容直接粘进去，扩展会先解码再逐行解析。
其中非 HTTP/HTTPS 的条目会被逐条列出并忽略。

---

## 规则类型

只有命中规则的请求才走代理，其余保持直连。规则**按列表顺序**匹配，命中第一条即生效。

| 类型 | 示例 | 命中 |
|---|---|---|
| 正则 | `\.(jpe?g\|png\|webp)(\?.*)?$` | 所有常见图片扩展名 |
| 域名 | `manga.com` | `manga.com` 及其所有子域（不会误命中 `notmanga.com`） |
| 前缀 | `https://cdn.manga.com/img/` | 该路径下的全部请求 |
| 通配 | `https://*.manga.com/img/*.jpg` | `*` 匹配任意字符 |
| 精确 | `https://cdn.manga.com/1.jpg` | 完全相同的 URL |

**规则测试器**：设置页底部可以输入一个图片 URL，立刻看到它会不会走代理、命中哪条规则、
会在哪些节点间轮询。配规则时用它验证比刷页面快得多。

每条规则还可以**绑定节点子集**（不选则使用全部可用节点），适合「A 图源用这几个节点、
B 图源用另外几个」的场景。绑定的节点全部不可用时会自动回落到全部可用节点。

---

## 分流与测速设置

| 设置 | 含义 |
|---|---|
| 分流策略 | `轮询`=每个请求换一个节点；`哈希`=同一 URL 固定走同一节点（便于缓存与排查） |
| 无可用节点时 | `直连`=图片至少能加载；`不兜底`=严格只走代理 |
| 每几个请求换一次节点 | 默认 1。调大可减少连接建立次数，但分流粒度变粗 |
| 测速地址 | 默认 `https://cp.cloudflare.com/generate_204`（返回 204 的极小响应，允许跨域） |
| 超时 | 超过该时间未响应即判为失败 |
| 定时测速间隔 | 分钟，`0` 关闭。最小生效值为 1 分钟（浏览器限制） |
| 连续失败几次后自动禁用 | 默认 2 |
| 绕过列表 | 这些主机永不走代理；本地地址与私有网段始终绕过 |

**测速原理**：扩展给测速地址加一个内部参数，PAC 脚本认出来后**强制**把这次请求路由到
指定节点，且不加直连兜底。所以测出来的是「浏览器经该代理到公网」的真实端到端延迟，
和图片请求走的是同一条通路；失败也是真失败，不会被静默直连掩盖。

---

## 常见问题

**图片还是加载失败？**
按顺序查：① 总开关是否打开；② 有没有节点显示可用延迟；③ 规则是否命中（用规则测试器验证）；
④ 弹窗「最近活动」里有没有 `request` 记录。四项都正常但仍失败，多半是代理本身不支持
到目标站的 `CONNECT`（HTTPS 图片必须经 CONNECT 隧道）。

**节点全被自动禁用了？**
说明它们都没通过测速。点「重置」可解除自动禁用；若确认代理本身可用，检查测速地址是否
被你的网络环境屏蔽，换一个（例如 `http://cp.cloudflare.com/generate_204`）。

**提示「代理设置被占用」？**
浏览器的代理设置是独占资源。请关闭其他代理类扩展（Proxy SwitchyOmega、各类机场客户端
扩展等）后重新打开总开关。企业策略强制代理时本扩展无法接管。

**测速报「不支持跨域」？**
你自定义的测速地址没有返回跨域响应头。换回默认地址即可。

**为什么有些图片还是走了同一个节点？**
浏览器会复用已建立的 HTTP/2 连接，同一批图片可能共享同一条到代理的连接。这是网络栈行为，
不是扩展缺陷。缓解办法：节点数 ≥ 4、「每几个请求换一次节点」保持为 1。详见
[docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

**我加的 SOCKS5 / VLESS 节点为什么用不了？**
本程序仅支持 HTTP/HTTPS 代理。这些类型会被明确标注为「不支持」，且不会参与分流。
可点「清除不支持的节点」一键删除。原因见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

**卸载后浏览器代理会不会残留？**
不会。扩展被卸载或禁用时，Chromium 会自动撤销它设置的代理。手动关闭总开关也会立即恢复直连。

---

## 权限说明

| 权限 | 为什么需要 |
|---|---|
| `proxy` | 注入 PAC 脚本实现分流。这是扩展唯一能让浏览器网络栈走不同代理的手段 |
| `storage` | 保存节点、规则与设置 |
| `alarms` | 定时测速（Service Worker 会休眠，必须用 alarms 唤醒） |
| `webRequest` | **只读观测**请求结果，用于状态页的日志与出口 IP 展示 |
| `webRequestAuthProvider` | 自动应答代理认证，避免每张图都弹认证框 |
| `<all_urls>` | 你可能给任意漫画站配规则，无法预先枚举域名 |

扩展不上传任何数据，配置只存在本机 `chrome.storage.local`。
代理账号密码**不会**写入 PAC 脚本（PAC 语法不支持凭据），只在浏览器要求认证时按需提供。

---

## 开发

```bash
npm test      # 运行全部 195 个测试（node --test，零依赖）
npm run check # 静态校验：manifest 引用、ESM 路径、命名导入、消息契约、架构约束
npm run icons # 重新生成图标 PNG
npm run verify # 上面两项一起跑
npm run pack  # 打包成 dist/image-proxy-rotator-<版本>.zip（分发 / 上架用）
npm run release # verify + pack
```

**目录结构**

```
manifest.json          MV3 清单
src/lib/               纯逻辑，零浏览器依赖，100% 单测覆盖
src/background/        Service Worker：只做 Chrome API 编排
src/pages/             设置页与状态弹窗
tools/                 图标生成、静态校验
tests/                 node:test 测试（单元 / 集成 / 后台编排 / SW 冒烟 / UI 契约）
docs/                  架构说明、技术限制、打包发布、人工验收清单
```

**架构约束**：`src/lib/` 下不得出现 `chrome.*` —— 这样 PAC 生成、节点解析、规则匹配、
调度这些最易错的部分可以在 Node 里直接 TDD，而不用靠人肉点浏览器。`npm run check` 会强制这条规则。

`src/background/` 虽然必须用 `chrome.*`，但同样有测试覆盖：`tests/helpers/chrome-stub.js`
提供 `chrome.*` 与 `fetch` 的替身，测试会把注入的 PAC 原文取出来在沙箱里执行，
用来验证「测速失败 → 自动禁用 → 重新注入的 PAC 不再选中该节点」这类跨模块行为。

细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；打包与自动构建见 [docs/PACKAGING.md](docs/PACKAGING.md)。

自动化测试跑不到的部分（真实代理连通性、多个真实出口 IP、代理认证框、控制权争夺等）
整理成了 [docs/VERIFICATION.md](docs/VERIFICATION.md)，需要在浏览器里人工走一遍。

---

## 许可证

[MIT](LICENSE) © 2026 NooAcc

可自由使用、修改、分发与商用，只需保留版权声明与许可声明。软件按「原样」提供，不含任何担保。
