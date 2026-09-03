# 本地标签代理工具设计

## 背景与问题

扩展的请求归因只能读取 `chrome.webRequest.onCompleted` 的 `details.ip`，拿不到端口。
当一批节点是同一台机器上的不同端口（`10.0.0.3:24000`、`10.0.0.3:24001`…）时，
多个节点共享同一个 IP，扩展无法把请求精确归因到某个端口，统计只能进入「无法归因」。

## 方案

提供一个可选的本地工具，为每个原始节点分配一个不同的回环地址：

```text
浏览器 -> http://127.0.0.2:8080 -> 本地工具 -> 10.0.0.3:24000
浏览器 -> http://127.0.0.3:8080 -> 本地工具 -> 10.0.0.3:24001
```

本地工具对每个 listener 做透明 TCP 转发：不解析 HTTP/CONNECT，只把浏览器连进来的
字节流原样中继到对应上游代理。扩展节点改为本地地址后，`details.ip` 变成
`127.0.0.2/3…`，现有归因逻辑（`host === ip`）无需任何改动即可精确区分节点。

## 边界

- 本工具只改变浏览器看到的代理地址，不改变上游代理的真实出口 IP。
- v1 只适用于上游为 HTTP 代理的场景（浏览器与上游之间不需要本地工具代答 TLS/证书）。
- 扩展代码与发布包不改：`tools/` 本来就不进入 `dist`。

## 组件

### `tools/label-proxy/lib/config.mjs`

纯函数：读取配置 JSON，产出 `plan`。

```js
plan = {
  listeners: [
    { localAddress: '127.0.0.2', localPort: 8080,
      upstreamHost: '10.0.0.3', upstreamPort: 24000, name: 'A' }
  ],
  importLines: ['http://127.0.0.2:8080#A']
}
```

配置格式：

```json
{
  "local": { "baseAddress": "127.0.0.2", "port": 8080 },
  "upstreams": [
    { "name": "A", "host": "10.0.0.3", "port": 24000 },
    { "name": "B", "host": "10.0.0.3", "port": 24001 }
  ]
}
```

### `tools/label-proxy/lib/relay.mjs`

运行层：

```js
const handle = await startRelays(plan, log?)
handle.close()
```

每个 listener 一个 `net.createServer`；每来一个连接就 `net.connect` 到上游并双向 pipe。

### `tools/label-proxy/cli.mjs`

CLI：

- `node tools/label-proxy/cli.mjs --config config.json`
- `node tools/label-proxy/cli.mjs --config config.json --print-nodes`

启动时打印映射表与扩展导入行；`--print-nodes` 只打印导入行。

### `tools/label-proxy/lib/service.mjs`（扩展联动）

配置含 `service` 时，CLI 额外监听一个仅绑定 `127.0.0.1` 的 HTTP 端口：

- `POST /api/convert`：接收 `{ upstreams: [{ name, host, port }] }`，按
  `buildPlan` 分配标签并启动/替换中继，返回 `{ ok, nodes: [...] }`。
- `GET /api/status`：返回服务状态与当前标签数。
- 可选 `service.token`，校验 `Authorization: Bearer <token>`。

扩展侧（`src/background/easy-proxies-sync.js`）：

- `settings.easyProxies.labelServiceUrl` 非空时，easy_proxies 拉取与选优完成后，
  先 `POST /api/convert`，再把返回节点经 `toLabelProxyNodes()` 转成带
  `meta.easyProxies` 标记的扩展节点，替换旧自动节点并重新注入 PAC。
- 服务失败时同步报错，**不清空现有节点**；easy_proxies 返回空列表时不调用转换。
- 设置页提供服务地址与服务口令两个字段；未填写时保持原「原始地址写回」行为。

## 测试

- config：默认地址分配、非法端口/空列表报错、导入行格式。
- relay：用真实回环地址开两个本地 listener，两个不同内容的上游服务器，
  分别连接 `127.0.0.2/3` 断言收到各自上游内容。
- CLI 由 relay/config 的测试覆盖核心；手动跑 `--print-nodes` 验证。
- service：真实 `POST /api/convert` 返回标签并转发到对应上游；token 与非法输入。
- e2e：真实 HTTP 服务 + easy_proxies 同步 stub 走完整“拉取→转换→写回→可用”链路。

## 文档

在工具目录、根 README 与 LIMITATIONS 第 13 节附近补充：

- 运行与配置方法；
- 扩展导入行生成方式；
- 关闭 Easy Proxies 自动同步的提醒；
- 「不改真实出口 IP」的边界。
- 扩展自动联动（Easy Proxies 设置里填本地标签服务地址）。
