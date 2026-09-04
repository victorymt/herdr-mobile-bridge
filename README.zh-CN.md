# Herdr Mobile Bridge

[English](README.md) · [简体中文](README.zh-CN.md)

`Herdr Mobile Bridge` 是一个仅支持 Linux 的 Herdr 插件，提供私有的移动端控制面板，
并在智能体状态变化时发送 Web Push 通知。它监听 Herdr 的插件事件，不把终端输出放进
通知内容；经过身份验证的浏览器可以查看最近输出、聚焦工作区或窗格、向智能体发送任务，
也可以输入受限制的交互式终端内容。

这个插件就是一组普通的可执行代码。它以当前用户身份运行，但桥接客户端只暴露下文列出的
明确白名单方法，不提供通用的 socket 方法代理。链接或安装前请先阅读源代码。

## 要求

- Linux
- Herdr 0.7.0 或更高版本
- Node.js 20 或更高版本，以及 npm
- 手机与主机之间有可信的局域网连接。可以使用内置 LAN proxy，或手动启动 `socat`
  转发。需要浏览器 Web Push 时，可以把 HTTPS 反向代理绑定到 LAN/VPN 网卡；不需要
  暴露公网端点。

服务默认监听 `127.0.0.1:8787`。建议保持网关只监听回环地址，由反向代理提供 HTTPS；
普通的局域网 HTTP 来源会被浏览器禁用 Web Push。`127.0.0.1` 是运行服务的电脑的回环地址，
所以在手机上打开它时，指向的是手机自己，而不是这台电脑上的服务。

## 安装并链接

在此目录执行：

```bash
npm ci
herdr plugin link /data/project/herdr-mobile-bridge
herdr plugin config-dir herdr.mobile-bridge
herdr plugin list --plugin herdr.mobile-bridge
```

Herdr 启动时，插件的启动钩子会幂等地启动本地网关。钩子会很快退出，网关则由
`src/launcher.js` 作为独立进程管理。

## 首次设置

首次设置会在 Herdr 的插件配置目录中生成高熵浏览器令牌、私有事件桥接密钥和 VAPID 密钥。
如需明确打印设置详情，请执行以下命令（令牌不会写入插件日志）：

```bash
node src/launcher.js setup
node src/launcher.js status
node src/launcher.js token
```

在手机浏览器的登录表单中输入打印出的令牌。登录后，可以从通知控件申请通知权限并注册
Web Push 订阅。

如需在局域网内使用 HTTPS，可以配置本地反向代理（例如 Caddy），把 LAN 地址上的 HTTPS
请求转发到 `http://127.0.0.1:8787`。监听器只能绑定到 LAN/VPN 网卡，不要发布到互联网。
如果代理会改写 `Host` 请求头，请显式设置代理来源：

可以直接从 [`docs/Caddyfile.lan.example`](docs/Caddyfile.lan.example) 开始，替换其中的
LAN 地址，并让手机信任 Caddy 的本地 CA。示例只绑定指定的 LAN 地址，Basic Auth 仍然是
可选项；证书安装、手机信任和主机防火墙需要根据实际环境完成。

```json
{
  "allowedOrigin": "https://192.168.1.20",
  "cookieSecure": true
}
```

将上述内容保存为 `bridge.json`，位置就是
`node src/launcher.js setup` 输出的目录，然后重启网关。多个可信代理来源可以用逗号分隔。
网关仍应只监听回环地址，绝不要直接把网关发布到公网。

如果只是临时建立可信局域网控制连接，可以用 `socat` 把主机的某个 LAN 地址转发到回环网关：

```bash
socat TCP-LISTEN:18787,bind=192.168.1.20,reuseaddr,fork TCP:127.0.0.1:8787
```

将 `192.168.1.20` 替换为电脑的 LAN 地址，然后在手机上打开
`http://192.168.1.20:18787`。这是原始 HTTP 转发，只能用于可信网络；请限制主机防火墙，
用完后停止转发。需要通知时，应改用 HTTPS 代理。
HTTP 是明文传输，能够观察局域网流量的设备可能读取 Bridge 令牌、会话 Cookie，以及（如果在
其他代理中启用）Basic Auth 凭据。`lanProxyAllowedCidrs` 只对内置 Node proxy 生效；`socat`
不会执行该 ACL，因此必须在主机防火墙或受信反向代理中重复限制来源。
对于这条纯 HTTP 链路，请不要设置 `cookieSecure`，或将其设为 `false`。如果显式配置了
`allowedOrigin`，请加入准确的 LAN 来源（例如 `http://192.168.1.20`）；也可以删除该覆盖项，
让同主机访问使用默认值。

启动器也可以直接管理内置 LAN proxy，不必另起一个 `socat` 进程。它会把 LAN 监听器转发到
回环网关，而网关负责代理健康检查和生命周期清理：

```bash
node src/launcher.js ensure --lan-host 192.168.1.20 --lan-port 18787
node src/launcher.js status --lan-host 192.168.1.20 --lan-port 18787
node src/launcher.js stop
```

在手机上使用 `http://192.168.1.20:18787` 地址。代理是可选功能，应绑定到可信的 LAN 网卡；
它不提供 HTTPS，需要 Web Push 时请使用本地 HTTPS 反向代理。

`--lan-host` 和 `--lan-port` 只对本次命令生效，launcher 不会把它们写入 `bridge.json`。
如果希望 Herdr 重启后仍启用 LAN proxy，请将它们写入
`node src/launcher.js setup` 输出目录中的 `bridge.json`，或设置
`HERDR_LAN_PROXY_HOST` 和 `HERDR_LAN_PROXY_PORT`：

```json
{
  "lanProxyHost": "192.168.1.20",
  "lanProxyPort": 18787
}
```

如果使用一次性的 CLI 参数，请在 `status` 中重复相同的监听器和安全参数。`status` 的 `url`
字段始终描述回环 Bridge（`http://127.0.0.1:8787`）；手机应使用单独的 LAN proxy 地址。
`ensure` 会异步启动 detached 进程，因此 `started:true` 只表示子进程已创建，并不表示监听器
已经就绪。请轮询 `status`，直到看到 `running:true`，并在启用代理时看到
`lan_proxy_running:true`。如果一直为 false，请检查插件日志和端口冲突。`pending:true` 表示
另一个 launcher 调用当前持有启动锁；请稍等后轮询 `status`，不要再启动一个副本。

### LAN ACL、限流和请求体超时

内置 Node LAN proxy 可以在 TCP 层根据真实 socket 来源限制网段。在 `bridge.json` 中配置
时，`lanProxyAllowedCidrs` 必须是非空数组；省略这个字段则保持兼容行为，也就是只依靠绑定
地址和主机防火墙：

```json
{
  "lanProxyHost": "192.168.1.20",
  "lanProxyPort": 18787,
  "lanProxyAllowedCidrs": ["192.168.1.0/24", "fd00:1234::/64"],
  "rateLimitPerMinute": 120,
  "rateLimitBurst": 30,
  "rateLimitMaxEntries": 4096,
  "requestBodyTimeoutMs": 10000
}
```

CIDR 也可以通过 `HERDR_LAN_PROXY_ALLOWED_CIDRS`（逗号分隔）、其
`BRIDGE_LAN_PROXY_ALLOWED_CIDRS` 别名或重复使用 `--lan-allow-cidr` 传入。限流相关环境变量分别是
`HERDR_BRIDGE_RATE_LIMIT_PER_MINUTE`、`HERDR_BRIDGE_RATE_LIMIT_BURST`、
`HERDR_BRIDGE_RATE_LIMIT_MAX_ENTRIES` 和
`HERDR_BRIDGE_REQUEST_BODY_TIMEOUT_MS`（对应的 `BRIDGE_*` 别名也支持）。请求体超时上限为
60 秒，`rateLimitMaxEntries` 至少为 2（API 会同时维护来源和凭据两个 bucket）。显式提供的
ACL 或这四个安全整数如果为空或非法，启动会被拒绝。

登录请求按来源固定限制为每分钟 5 次。受保护的 API 使用 IP 和已认证会话分别维护令牌桶；
超过限制时返回 `429`、`error.code=rate_limited` 以及 `Retry-After`。速度过慢或过大的 JSON
请求体分别返回 `408 request_body_timeout` 或 `413 body_too_large`，然后关闭连接。

内置 proxy 是透明的 L4 转发，不信任 `X-Forwarded-For`。经过这条路径时，Bridge 通常只能
看到来自 loopback 的请求。因此，按真实手机 IP 进行的连接级限制由 proxy 执行，HTTP 请求级
限制由 Bridge 的 IP/会话 bucket 执行。如果需要 L7 的客户端 IP 语义，必须让外部 Caddy 等
受信代理自行清理转发头，并实施 ACL/限流。修改这些启动配置后，launcher 不会复用旧进程；
请先执行 `node src/launcher.js stop`，再执行 `ensure`。

打开你选择的访问地址：需要通知时使用 HTTPS 代理地址，只做控制时使用 LAN 地址，不要打开
`http://127.0.0.1:8787`。首次访问时，在登录页输入
`node src/launcher.js token` 打印的令牌。浏览器会保持已认证会话；来源为 HTTPS 时，
还可以通过 **开启提醒** 按钮申请推送权限。

## 手机端控制

控制面板只允许操作一个 Herdr 会话，提供以下功能：

- 查看经过清理的工作区、标签页、窗格和智能体状态；
- 认证后查看所选窗格最近最多 80 行输出；
- 聚焦工作区或窗格；
- 通过 Herdr 的 `agent.prompt` API 发送有长度限制的任务；
- 通过 `pane.send_input` 发送受长度限制的文本，并使用少量允许的交互按键（Enter、Escape、
  Tab、方向键、Backspace 以及指定的控制键）。

桥接服务不会暴露通用的 socket 方法代理、关闭窗格/工作区的操作，也不会持久化终端输出。
提交任务前浏览器会要求确认，每个修改操作都需要已认证会话的 CSRF 令牌。推送消息只包含
打开对应窗格所需的智能体、状态和位置。

### 从通知直接处理

点击“需要介入”或“任务完成”通知后，浏览器会打开对应的**待处理**行动面板。面板在同一页
显示通知状态、智能体/窗格位置、最近 80 行输出，以及任务和终端输入控件；不需要先在
“最近输出”中查找窗格，再切换到“控制”。输出是在登录后的请求中即时读取的，不会写入推送
内容、通知 URL 或桥接状态文件。

行动面板只会预选通知对应的窗格，不会自动改变电脑上的 Herdr 聚焦；如有需要，点击
“聚焦电脑窗格”。输出首次打开时加载一次，之后可以使用面板内的“刷新输出”按钮手动更新。
如果通知对应的窗格已经关闭，面板会保留通知摘要并明确提示无法读取，避免把操作误发到其他
窗格。

如果手机还没有登录，通知链接会先显示登录页；登录成功后会自动恢复原通知目标，不必再次
寻找窗格。旧版只带 `pane` 参数的链接仍会打开“最近输出”页面。

HTTP 控制端点如下：

```text
POST /api/control/prompt  { "pane_id": "<public pane id>", "text": "..." }
POST /api/control/input   { "pane_id": "<public pane id>", "text": "...", "keys": ["enter"] }
```

Herdr 接受请求后，两个端点都会返回 `202`。任务文本上限为 32 KiB，终端文本上限为 8 KiB；
每次请求最多可带 8 个允许的输入按键。如果智能体被阻塞或尚未准备好，请使用交互输入控件，
不要重复发送任务。

在控制面板中打开 **控制** 标签，选择目标窗格，然后任选一种方式：

1. 在 **发送任务给智能体** 下输入任务并确认；Herdr 会将它作为智能体请求提交；或
2. 在 **交互输入** 中输入终端文本，或者点击按键按钮。具有破坏性的控制键还会要求再次确认。

控制路由与其他修改路由使用相同的已认证会话和 CSRF 保护。它们有意不提供通用的 Herdr
socket 代理。

## 生命周期与故障排查

```bash
node src/launcher.js status
node src/launcher.js stop
herdr plugin log list --plugin herdr.mobile-bridge
```

在禁用或解除链接插件前，可以先执行 `stop`。Herdr v1 的插件钩子没有关机回调，因此禁用
插件不会追溯终止已经脱离的网关进程。再次启动 Herdr 时会运行 `ensure`：如果进程健康就
复用它，并刷新 socket 路径。

如果监听器、ACL、限流或请求体超时设置与正在运行的进程不同，`ensure` 会返回
`reason=config_mismatch` 和 `restartRequired:true`，但不会杀掉旧进程。请先显式运行 `stop`，
再用新设置运行 `ensure`。

如果控制面板报告 Herdr 不可用，请确认会话正在运行，并检查 `status` 显示的 socket 路径是否
仍然存在。如果推送发送因订阅已失效而失败，网关会删除该订阅；之后可以在浏览器中通过通知
按钮重新注册。升级已有的 PWA 后，请重新加载一次控制面板，让 service worker 安装最新的
应用外壳；这也会让设备显示新加入的控件，而不是继续使用缓存的旧 JavaScript bundle。

本地检查命令：

```bash
node src/launcher.js status
curl -fsS http://127.0.0.1:8787/healthz
```

`status` 应报告 `running: true` 和 `socket_present: true`。原始的 `socat` 或 TCP 隧道可以
把页面暴露给可信 LAN，但不提供 HTTPS；浏览器会因此在该来源上禁用 Web Push。需要通知时，
请使用只绑定到 LAN/VPN 网卡的 HTTPS 反向代理，绝不要把桥接端口转发到公网。

## 开发

```bash
npm ci
npm test
npm run check
```

测试使用 Node 内置的测试运行器和一个伪 Unix socket，不需要运行中的 Herdr 服务或真实的推送
服务商。可以在一次性的 Herdr 环境中用
`herdr plugin link <path> --disabled` 校验插件清单。

## 配置文件

运行时配置放在 `HERDR_PLUGIN_CONFIG_DIR` 下；PID/锁数据和浏览器订阅放在
`HERDR_PLUGIN_STATE_DIR` 下。这两个目录由插件/Herdr 环境创建，并且位于受管理的插件检出目录之外。
请把令牌、桥接密钥和 VAPID 私钥视为凭据。你可以在 `vapid.json` 中提供一对 VAPID 密钥
（字段名为 `publicKey`/`privateKey`），也可以让网关在首次启动时自动生成。如果通过
`HERDR_BRIDGE_VAPID_PUBLIC_KEY` 和 `HERDR_BRIDGE_VAPID_PRIVATE_KEY` 配置密钥，必须同时
提供两个值。

如果需要非默认目录或监听设置，launcher 还支持上文提到的 `--host`、`--port`、`--socket`、
`--config-dir`、`--state-dir` 以及 LAN 参数。对应的环境变量包括
`HERDR_BRIDGE_HOST`/`BRIDGE_HOST`、`HERDR_BRIDGE_PORT`/`BRIDGE_PORT`、
`HERDR_SOCKET_PATH`/`BRIDGE_SOCKET_PATH`、`HERDR_PLUGIN_CONFIG_DIR`（或
`HERDR_MOBILE_BRIDGE_CONFIG_DIR`/`BRIDGE_CONFIG_DIR`），以及
`HERDR_PLUGIN_STATE_DIR`（或 `HERDR_MOBILE_BRIDGE_STATE_DIR`/`BRIDGE_STATE_DIR`）。
除非写入 `bridge.json` 或导出为环境变量，命令行值只对本次调用生效。

事件钩子通常会从 `runtime.json` 找到回环网关并向其发送请求。如果确实要把事件路由到远程
网关，请设置 `HERDR_BRIDGE_EVENT_URL`，并通过 `HERDR_BRIDGE_EVENT_ALLOWED_ORIGINS` 显式
允许准确的 HTTPS 来源（多个来源用逗号分隔）。浏览器的 `allowedOrigin` 设置不能替代这个
钩子来源白名单。

默认情况下，推送订阅只允许严格的 HTTPS 服务商来源。私有地址、本地地址、元数据地址和明文
端点会在持久化及发送前被拒绝。自定义 relay 必须显式启用，并且应保持在 LAN 范围内：

```text
HERDR_BRIDGE_ALLOW_PUSH_RELAY=true
HERDR_BRIDGE_ALLOW_CUSTOM_PUSH_ENDPOINTS=true
HERDR_BRIDGE_PUSH_ENDPOINT_ALLOWLIST=relay.example.test
HERDR_BRIDGE_PUSH_TIMEOUT_MS=5000
```

超时时间上限为 60 秒。不要在不可信网络中启用 relay 或自定义端点开关；浏览器令牌只能保护
控制 API，不能代替 HTTPS 或主机防火墙。

静态端点校验不会替自定义 hostname 做 DNS 解析，这样可以避免校验与实际连接之间的 TOCTOU
问题，但也意味着它无法单独保证 DNS rebinding 不会把域名解析到内网。启用自定义端点时，
请使用固定解析的受信 relay，并在出口防火墙或代理层拒绝私网、回环和云元数据网段；不要把
`allowCustomPushEndpoints` 当作公网 SSRF 防护边界。
