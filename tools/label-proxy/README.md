# 本地标签代理（可选工具）

解决扩展的一个已知边界：当多个代理节点是**同一台机器上的不同端口**时，扩展能轮询到
这些端口，却因为浏览器只回报对端 IP、不回报端口，而无法在统计面板里区分“哪个端口在干活”。

这个可选工具把每个上游端口映射成一个不同的本机回环地址，让浏览器看到不同的对端 IP：

```text
浏览器 -> http://127.0.0.2:8080 -> 本地工具 -> 10.0.0.3:24000
浏览器 -> http://127.0.0.3:8080 -> 本地工具 -> 10.0.0.3:24001
浏览器 -> http://127.0.0.4:8080 -> 本地工具 -> 10.0.0.3:24002
```

工具只做**透明 TCP 转发**，不解析 HTTP/CONNECT，也不要求修改扩展代码。

扩展可以自动联动：在 Easy Proxies 设置里填上本工具的 HTTP 服务地址后，
每次拉取 easy_proxies 都会自动转换并写回标签节点，见下文「与扩展自动联动」。

## 后台启动（推荐）

label-proxy 可以完全在后台运行，不占用、也不保留命令行窗口。项目根目录执行：

```bash
npm run label-proxy:start     # 后台启动
npm run label-proxy:status    # 查看是否在运行
npm run label-proxy:stop      # 停止
npm run label-proxy:restart   # 重启
```

Windows 也可以不依赖 npm，直接双击本目录下的脚本：

- `start-hidden.vbs`：后台启动，**完全没有命令行窗口**；
- `stop-hidden.vbs`：停止后台服务；
- `start.bat`：效果同上，启动窗口会在命令完成后自动关闭。

后台模式启动的是默认 HTTP 服务（等价于 `npm run label-proxy`，即
`cli.mjs --service`），**不需要任何配置文件**。日志与 pid 写在
`run/label-proxy.log` 与 `run/label-proxy.pid`；再次运行 start 会检测到服务
已在运行并跳过，不会重复拉起。

## 登录后自动启动（可选）

希望每次登录 Windows 后自动在后台运行，不需要手动点任何东西：

1. 双击本目录下的 `install-autostart.vbs`；
2. 下次登录时 label-proxy 会自动后台启动；
3. 不想自启时双击 `uninstall-autostart.vbs`。

自启只是往「启动」文件夹放一个快捷方式，不写注册表、不需要管理员权限。仓库
目录被移动后快捷方式会失效，重新双击一次 `install-autostart.vbs` 即可。

## 前台运行（调试）

需要看实时输出或按 Ctrl+C 停止时，仍然可以用前台方式：

```bash
npm run label-proxy
```

## 默认服务参数

后台与前台默认模式都会用下面的默认值启动 HTTP 服务：

- 服务地址：`http://127.0.0.1:19191`
- 标签起点：`127.0.0.2:8080`（之后自动递增到 `127.0.0.3/4…`）
- 无服务口令

启动后把 `http://127.0.0.1:19191` 填进扩展的“本地标签服务地址”，点
「立即拉取并同步」即可。需要改端口或加口令时，才需要看下面的配置文件方式。

## 它不能做什么

- 不改变上游代理的真实出口 IP。如果同一台代理机的不同端口本来就对应不同出口，
  分流效果已经存在，本工具只让扩展面板能分别记账；如果只有一个真实出口，
  任何本地工具都变不出多个公网 IP。
- v1 只适用上游为 **HTTP 代理**（`http://10.0.0.3:24000` 这类，easy_proxies 即是）。
  上游为 `https://` 代理时，浏览器需要对代理地址校验证书，本地别名无法满足。

## 环境要求

- Node.js 18 或更高版本（项目开发和 CI 使用 Node 24）。
- 系统可绑定 `127.0.0.x` 回环地址。Windows 回环接口默认是 `127.0.0.1/8`，
  无需虚拟网卡或管理员权限；若工具启动报 `EADDRNOTAVAIL`，说明该系统只配置了
  `/32`，需要先给回环接口添加别名。

## 配置

复制示例配置并填写真实上游：

```bash
cp tools/label-proxy/config.example.json tools/label-proxy/config.json
```

```json
{
  "local": {
    "baseAddress": "127.0.0.2",
    "port": 8080
  },
  "service": {
    "host": "127.0.0.1",
    "port": 19191,
    "token": ""
  },
  "upstreams": [
    { "name": "节点 A", "host": "10.0.0.3", "port": 24000 },
    { "name": "节点 B", "host": "10.0.0.3", "port": 24001 }
  ]
}
```

- `local.baseAddress`：第一个标签地址，之后按 `127.0.0.3`、`127.0.0.4`… 自动递增。
- `local.port`：所有标签共用同一个本地端口（不同 IP 可以共用端口）。
- `service`：可选 HTTP 服务。`port` 是扩展要填的地址；`token` 留空表示不需要认证，
  配置后扩展的“本地标签服务口令”必须填同一个值。
- `upstreams`：原节点列表，`name` 会保留为扩展节点名。

## 启动

```bash
node tools/label-proxy/cli.mjs --config tools/label-proxy/config.json
```

工具会打印每个映射，并给出可直接粘贴到扩展「批量导入」的节点行。只查看导入行而不启动：

```bash
node tools/label-proxy/cli.mjs --config tools/label-proxy/config.json --print-nodes
```

输出示例：

```text
http://127.0.0.2:8080#节点 A
http://127.0.0.3:8080#节点 B
```

## 与扩展自动联动

1. 在 `config.json` 填好 `service` 后启动：

   ```bash
   node tools/label-proxy/cli.mjs --config tools/label-proxy/config.json
   ```

2. 打开扩展设置页「Easy Proxies 自动拉取」：
   - 照旧填 easy_proxies 管理地址、密码、条数与同步间隔；
   - “本地标签服务地址”填 `http://127.0.0.1:19191`（与实际 `service.port` 一致）；
   - 工具配了 `service.token` 时，把同一个口令填进“本地标签服务口令”。
3. 点「立即拉取并同步」。流程：拉取 easy_proxies → `POST /api/convert` →
   工具分配 `127.0.0.x` 并启动中继 → 扩展用标签节点替换旧自动节点 → 重新注入 PAC。
4. 启动时/定时同步走同一条链路，之后统计面板即可按端口归因。

工具没启动或转换失败时，同步会报错且不清空现有节点。想退回原始行为，
把“本地标签服务地址”留空再同步一次即可。

## 在扩展中使用

1. 先启动本工具，保持运行。
2. 在设置页「节点 → 批量导入」粘贴 `--print-nodes` 的输出。
3. **删除或禁用原来的原始同 IP 节点**，否则它们仍会参与轮询并继续产生无法归因的流量。
4. 如果开着「Easy Proxies 自动拉取」，优先使用上面的自动联动；不使用联动时请先关闭它，
   否则自动同步会把原始同 IP 节点重新加回列表。
5. 正常测速与使用。由于每个节点 host 是唯一回环地址，统计面板会恢复按节点归因。

上游要求账号密码时，把凭据按扩展格式填进标签节点（如
`http://用户名:密码@127.0.0.2:8080#节点 A`）。认证发生在浏览器与本地标签这一环，
凭据头会随字节流原样透传给上游，不需要在本工具配置里重复填写。

> 工具停止后这些标签节点会全部失效：浏览器连不上 `127.0.0.x:8080`，图片会按失败处理。
> 不再使用本工具时，删除导入的本地标签节点即可。

## 验证

```bash
node --test tests/label-proxy-config.test.js tests/label-proxy-relay.test.js tests/label-proxy-cli.test.js tests/label-proxy-service.test.js
```

测试会用真实回环地址启动两个标签 listener，并断言各自只转发到对应的上游。
