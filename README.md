# Herdr Mobile Bridge

`Herdr Mobile Bridge` is a small Linux-only Herdr plugin that adds a private,
mobile-first dashboard and Web Push notifications for agent state changes.
It listens to Herdr's plugin events, keeps the notification payload free of
terminal output, and lets an authenticated browser inspect recent output,
focus a workspace/pane, send an agent task, or provide bounded interactive
terminal input.

The plugin is ordinary executable code. It runs as your user and can call the
full Herdr socket API. Read the source before linking or installing it.

## Requirements

- Linux
- Herdr 0.7.0 or newer
- Node.js 20 or newer and npm
- A trusted LAN connection from the phone; use the included LAN proxy or a
  manually started `socat` forward. An HTTPS reverse proxy may be bound to a
  LAN/VPN interface when browser Web Push is required, but no public endpoint
  is needed.

The service binds to `127.0.0.1:8787` by default. Keep it on loopback and let
the reverse proxy provide HTTPS; Web Push is disabled by browsers on an
ordinary LAN HTTP origin. `127.0.0.1` is the computer's loopback address, so
opening it on a phone points at the phone itself rather than this service.

## Install and link

From this directory:

```bash
npm ci
herdr plugin link /data/project/herdr-mobile-bridge
herdr plugin config-dir herdr.mobile-bridge
herdr plugin list --plugin herdr.mobile-bridge
```

When Herdr starts, the plugin's startup hook idempotently starts the local
gateway. The hook exits quickly; the gateway is a separate process managed by
`src/launcher.js`.

## First setup

The first setup creates a high-entropy browser token, a private event-bridge
secret, and VAPID keys in Herdr's plugin config directory. Print the setup
details explicitly (the token is never written to plugin logs):

```bash
node src/launcher.js setup
node src/launcher.js status
node src/launcher.js token
```

Use the printed token in the mobile browser's login form. The browser then
asks for notification permission and registers a Web Push subscription.

For optional HTTPS inside the LAN, configure a local reverse proxy (such as
Caddy) to forward an HTTPS LAN address to `http://127.0.0.1:8787`. Keep its
listener restricted to the LAN/VPN interface and do not publish it to the
internet. Set the proxy origin explicitly when it rewrites the `Host` header:

```json
{
  "allowedOrigin": "https://herdr.example.ts.net",
  "cookieSecure": true
}
```

Save that as `bridge.json` in the directory printed by
`node src/launcher.js setup`, then restart the gateway. Multiple trusted proxy
origins can be supplied as a comma-separated value. Keep the gateway bound to
loopback; never publish the gateway directly to the public internet.

For a temporary, trusted-LAN control connection, `socat` can forward a
specific host LAN address to the loopback gateway:

```bash
socat TCP-LISTEN:18787,bind=192.168.1.20,reuseaddr,fork TCP:127.0.0.1:8787
```

Replace `192.168.1.20` with the computer's LAN address and open
`http://192.168.1.20:18787` on the phone. This is a raw HTTP forward: use it
only on a trusted network, restrict the host firewall, stop it when finished,
and use an HTTPS proxy instead when notifications are required.
For this HTTP-only path, leave `cookieSecure` unset or set it to `false`. If
`allowedOrigin` is configured explicitly, include the exact LAN origin (for
example `http://192.168.1.20`) or remove the override for same-host access.

The launcher can manage the built-in LAN proxy without a separate `socat`
process. It forwards a LAN listener to the loopback gateway, and the gateway
performs the proxy health check and lifecycle cleanup:

```bash
node src/launcher.js ensure --lan-host 192.168.1.20 --lan-port 18787
node src/launcher.js status
node src/launcher.js stop
```

Use the resulting `http://192.168.1.20:18787` URL on the phone. The proxy is
opt-in, should be bound to a trusted LAN interface, and does not provide HTTPS;
use a local HTTPS reverse proxy when Web Push is required.

Open the URL for the path you chose—your HTTPS proxy URL for notifications, or
the LAN URL for controls only—not `http://127.0.0.1:8787`. On the first visit,
enter the token printed by `node src/launcher.js token`. The dashboard then
keeps an authenticated browser session and can request push permission from
the **开启提醒** button when the origin is HTTPS.

## Mobile controls

The dashboard is constrained to a single Herdr session:

- view sanitized workspace, tab, pane, and agent status;
- view up to 80 recent lines for a selected pane (only after authentication);
- focus a workspace or pane;
- send a bounded task through Herdr's `agent.prompt` API;
- send bounded text plus a small allowlist of interactive keys through
  `pane.send_input` (Enter, Escape, Tab, arrows, Backspace, and selected
  control keys).

The bridge never exposes a generic socket-method proxy, pane/workspace close
operations, or terminal-output persistence. Prompt submission is confirmed in
the browser, and every mutation requires the authenticated session's CSRF
token. Push messages contain only the agent, status, and location needed to
open the matching pane in the dashboard.

### 从通知直接处理

点击“需要介入”或“任务完成”通知后，浏览器会打开对应的**待处理**行动面板。
面板会在同一页显示通知状态、智能体/窗格位置、最近 80 行输出以及任务和终端
输入控件，因此不需要先在“最近输出”里查找窗格再切换到“控制”。输出是在登录
后的请求中即时读取的，不会写入推送内容、通知 URL 或桥接状态文件。

行动面板只会预选通知对应的窗格，不会自动改变电脑上的 Herdr 聚焦；需要时可
点击“聚焦电脑窗格”。输出首次打开时加载一次，后续使用面板内的“刷新输出”
按钮手动更新。若通知对应的窗格已经关闭，面板会保留通知摘要并明确提示无法
读取，避免把操作误发到其他窗格。

如果手机尚未登录，通知链接会先显示登录页；登录成功后会自动恢复原通知目标，
无需再次寻找窗格。旧版只带 `pane` 参数的链接仍会打开“最近输出”页面。

The HTTP control endpoints are:

```text
POST /api/control/prompt  { "pane_id": "<public pane id>", "text": "..." }
POST /api/control/input   { "pane_id": "<public pane id>", "text": "...", "keys": ["enter"] }
```

Both endpoints return `202` after Herdr accepts the request. Prompt text is
limited to 32 KiB and terminal text to 8 KiB; input keys are limited to eight
allowlisted values per request. A blocked or not-yet-ready agent should be
handled with the interactive input controls instead of another prompt.

In the dashboard, use the **控制** tab, choose a target pane, and then either:

1. enter a task under **发送任务给智能体** and confirm the prompt; Herdr submits
   it as an agent request; or
2. enter terminal text under **交互输入**, or tap one of the key buttons. The
   destructive control keys ask for an additional confirmation.

The control routes require the same authenticated session and CSRF protection
as the other mutation routes. They are intentionally not a generic Herdr
socket proxy.

## Lifecycle and troubleshooting

```bash
node src/launcher.js status
node src/launcher.js stop
herdr plugin log list --plugin herdr.mobile-bridge
```

`stop` is useful before disabling or unlinking the plugin. Herdr v1 plugin
hooks do not provide a shutdown callback, so disabling a plugin does not
retroactively terminate a detached gateway process. Starting Herdr again runs
`ensure`, which reuses a healthy process and refreshes its socket path.

If the dashboard reports that Herdr is unavailable, check that the session is
running and that the socket path shown by `status` still exists. If push
delivery fails with a gone subscription, the gateway removes that subscription
and the browser can register it again from the notification button.
After upgrading an existing installed PWA, reload the dashboard once so the
service worker can install the latest app shell; this also makes newly added
controls appear on devices that had cached an older JavaScript bundle.

Useful local checks are:

```bash
node src/launcher.js status
curl -fsS http://127.0.0.1:8787/healthz
```

`status` should report `running: true` and `socket_present: true`. A raw
`socat` or TCP tunnel can expose the page to a trusted LAN, but it does not
provide HTTPS; browsers will therefore disable Web Push on that origin. Use
an HTTPS reverse proxy bound only to the LAN/VPN interface when notifications
are needed; never forward the bridge port to the public internet.

## Development

```bash
npm ci
npm test
node --check src/server.js
node --check src/launcher.js
node --check src/event-hook.js
```

The tests use Node's built-in test runner and a fake Unix socket; no running
Herdr server or real push provider is required. The manifest can be validated
with `herdr plugin link <path> --disabled` in a disposable Herdr environment.

## Configuration files

Runtime configuration belongs under `HERDR_PLUGIN_CONFIG_DIR`; PID/lock data
and browser subscriptions belong under `HERDR_PLUGIN_STATE_DIR`. Both are
created by Herdr and are kept outside the managed plugin checkout. Treat the
token, bridge secret, and VAPID private key as credentials. You may provide a
VAPID pair in `vapid.json` (the `publicKey`/`privateKey` fields), or let the
gateway generate one on first start. If you configure a pair through
`HERDR_BRIDGE_VAPID_PUBLIC_KEY` and
`HERDR_BRIDGE_VAPID_PRIVATE_KEY`, provide both values together.

The event hook normally posts to the loopback gateway discovered from
`runtime.json`. If you intentionally route events to a remote gateway, set
`HERDR_BRIDGE_EVENT_URL` and explicitly allow its exact HTTPS origin with
`HERDR_BRIDGE_EVENT_ALLOWED_ORIGINS` (comma-separated for multiple origins).
The browser `allowedOrigin` setting does not replace this hook allowlist.
