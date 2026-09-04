# Herdr Mobile Bridge

[English](README.md) · [简体中文](README.zh-CN.md)

`Herdr Mobile Bridge` is a small Linux-only Herdr plugin that adds a private,
mobile-first dashboard and Web Push notifications for agent state changes.
It listens to Herdr's plugin events, keeps the notification payload free of
terminal output, and lets an authenticated browser inspect recent output,
focus a workspace/pane, send an agent task, or provide bounded interactive
terminal input.

The plugin is ordinary executable code. It runs as your user, but its bridge
client exposes only the explicitly allowlisted Herdr methods described below;
it does not provide a generic socket-method proxy. Read the source before
linking or installing it.

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

## Quick configuration (recommended)

If you do not want to edit `bridge.json` by hand, run the interactive wizard:

```bash
npm run configure
```

The Chinese-language wizard asks for the access mode, ports, LAN interface, and
optional security settings. It detects local interfaces, writes the result
atomically, and keeps the previous `bridge.json` as `bridge.json.bak` when one
already exists, so it is safe to run again. The token, bridge secret, and VAPID
private key are still generated and stored separately rather than written into
the configuration file. When run from a normal shell, it automatically targets
the registered Herdr plugin directory; pass `--config-dir` and `--state-dir` if
you intentionally want a standalone instance. At the end it prints the
computer/LAN URL and token, shows the exact directories used, waits for the
Bridge to become ready, and reports the startup error instead of claiming
success when a port or proxy is unavailable.

## First setup

The first setup creates a high-entropy browser token, a private event-bridge
secret, and VAPID keys in Herdr's plugin config directory. Print the setup
details explicitly (the token is never written to plugin logs):

```bash
PLUGIN_CONFIG_DIR="$(herdr plugin config-dir herdr.mobile-bridge)"
PLUGIN_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/herdr.mobile-bridge"
node src/launcher.js setup --config-dir "$PLUGIN_CONFIG_DIR" --state-dir "$PLUGIN_STATE_DIR"
node src/launcher.js token --config-dir "$PLUGIN_CONFIG_DIR" --state-dir "$PLUGIN_STATE_DIR"
node src/launcher.js ensure --config-dir "$PLUGIN_CONFIG_DIR" --state-dir "$PLUGIN_STATE_DIR"
node src/launcher.js status --config-dir "$PLUGIN_CONFIG_DIR" --state-dir "$PLUGIN_STATE_DIR"
```

`setup` only creates or confirms the configuration and credentials; `ensure`
starts the Bridge. On the computer, open the `url` printed by `status`, which
defaults to `http://127.0.0.1:8787`. The service is ready only when `status`
reports `running:true`: `started:true` from `ensure` means that a detached
child was spawned, not that its listener is ready. If `running:false` appears,
check `startup-error.log` in the state directory for the last failure before
retrying. A `runtime_stale:true` result means the marker belongs to an exited
process and can be ignored after resolving the reported error.

Open `http://127.0.0.1:8787` in the computer's browser and enter the printed
token. This loopback address works only on the computer running Bridge; a
phone's `127.0.0.1` points back to the phone itself. After login, the browser
can request notification permission and register a Web Push subscription from
the notification controls.

If `status` reports `lan_proxy_host:null`, the optional LAN proxy is not
running. Do not open `http://computer-lan-address:18787` until the proxy has
been enabled with `--lan-host`/`--lan-port` or persisted in `bridge.json`.

For optional HTTPS inside the LAN, configure a local reverse proxy (such as
Caddy) to forward an HTTPS LAN address to `http://127.0.0.1:8787`. Keep its
listener restricted to the LAN/VPN interface and do not publish it to the
internet. Set the proxy origin explicitly when it rewrites the `Host` header:

You can start from [`docs/Caddyfile.lan.example`](docs/Caddyfile.lan.example), replace
the LAN address, and install Caddy's local CA on the phone. The example binds
only to the selected LAN address and leaves Basic Auth optional; certificate
installation, phone trust, and host-firewall rules still need to be completed
for your environment.

```json
{
  "allowedOrigin": "https://192.168.1.20",
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
HTTP is plaintext, so a device that can observe the LAN may read the bridge
token, session cookies, and (if configured elsewhere) Basic Auth credentials.
`lanProxyAllowedCidrs` applies only to the built-in Node proxy; `socat` does
not enforce that ACL, so repeat the source restriction in the host firewall or
in a trusted reverse proxy.
For this HTTP-only path, leave `cookieSecure` unset or set it to `false`. If it
is enabled globally, the bridge only adds `Secure` when the current request is
actually HTTPS, so an HTTP login does not succeed and then immediately lose its
session. If `allowedOrigin` is configured explicitly, include the exact LAN
origin (for example `http://192.168.1.20`) or remove the override for same-host
access.

The launcher can manage the built-in LAN proxy without a separate `socat`
process. It forwards a LAN listener to the loopback gateway, and the gateway
performs the proxy health check and lifecycle cleanup:

```bash
node src/launcher.js ensure --lan-host 192.168.1.20 --lan-port 18787
node src/launcher.js status --lan-host 192.168.1.20 --lan-port 18787
node src/launcher.js stop
```

Use `http://192.168.1.20:18787` on the phone. The proxy is opt-in, should be
bound to a trusted LAN interface, and does not provide HTTPS; use a local HTTPS
reverse proxy when Web Push is required.

The `--lan-host` and `--lan-port` values apply only to that invocation; the
launcher does not write them to `bridge.json`. To keep the LAN proxy enabled
when Herdr restarts, persist them in the `bridge.json` located in the directory
reported by `node src/launcher.js setup` (or set `HERDR_LAN_PROXY_HOST` and
`HERDR_LAN_PROXY_PORT`):

```json
{
  "lanProxyHost": "192.168.1.20",
  "lanProxyPort": 18787
}
```

If you use one-shot CLI values, pass the same listener and security options to
`status`. Its `url` field always describes the loopback Bridge
(`http://127.0.0.1:8787`); the phone URL is the separate LAN proxy address.
`ensure` starts a detached process asynchronously, so `started:true` means
that the child was spawned, not that its listeners are ready. Poll `status`
until `running:true` and (when enabled) `lan_proxy_running:true`. If they stay
false, inspect the plugin log and check for a port conflict. A `pending:true`
result means another launcher invocation currently holds the startup lock;
wait briefly and poll `status` instead of starting another copy.

### LAN ACL, rate limits, and request-body timeouts

The built-in Node LAN proxy can restrict source networks at the TCP layer
using the real socket address. Set a non-empty array in `bridge.json`; omit the
field to retain the compatible “binding address and host firewall only” mode:

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

CIDRs can also be supplied through `HERDR_LAN_PROXY_ALLOWED_CIDRS` (comma
separated), its `BRIDGE_LAN_PROXY_ALLOWED_CIDRS` alias, or repeated
`--lan-allow-cidr` flags. The four security settings use
`HERDR_BRIDGE_RATE_LIMIT_PER_MINUTE`, `HERDR_BRIDGE_RATE_LIMIT_BURST`,
`HERDR_BRIDGE_RATE_LIMIT_MAX_ENTRIES`, and
`HERDR_BRIDGE_REQUEST_BODY_TIMEOUT_MS` (with matching `BRIDGE_*` aliases).
The request-body timeout is capped at 60 seconds, and
`rateLimitMaxEntries` must be at least 2 because the API maintains both source
and credential buckets. Explicitly empty or invalid ACL values and these four
security integers reject startup.

Login attempts are fixed at five per source per minute. Protected APIs use
token buckets for the client IP and authenticated session; an exhausted bucket
returns `429`, `error.code=rate_limited`, and `Retry-After`. Slow or oversized
JSON bodies return `408 request_body_timeout` or `413 body_too_large`, then the
connection is closed.

The built-in proxy is a transparent L4 forwarder: it does not trust
`X-Forwarded-For`, so Bridge normally sees loopback as the source on this path.
The proxy therefore enforces connection-level limits using the phone's real
socket address, while Bridge enforces HTTP request-level IP/session buckets.
For L7 client-IP semantics, use a trusted external proxy such as Caddy and
have that proxy sanitize headers and enforce its own ACL/rate limits. After
changing these startup settings, the launcher will not reuse the old process;
run `node src/launcher.js stop` and then `ensure`.

Open the URL for the path you chose—your HTTPS proxy URL for notifications, or
the LAN URL for controls only—not `http://127.0.0.1:8787`. On the first visit,
enter the token printed by `node src/launcher.js token`. The dashboard then
keeps an authenticated browser session and can request push permission from
the **Enable notifications** button when the origin is HTTPS.

## Mobile controls

The dashboard is constrained to a single Herdr session:

- view sanitized workspace, tab, pane, and agent status;
- view up to 80 recent lines for a selected pane (only after authentication);
- focus a workspace or pane;
- send a bounded task through Herdr's `agent.prompt` API;
- send bounded text plus a small allowlist of interactive keys through
  `pane.send_input` (Enter, Escape, Tab, arrows, Backspace, and selected
  control keys).

The output view requests Herdr's `recent_unwrapped` snapshot with
`format=ansi` and renders common terminal colors and text styles safely in the
browser. Copying output always returns plain text without escape sequences.
The output endpoint keeps plain text as its default for compatibility; callers
that need styling can use `source=recent_unwrapped&format=ansi&strip_ansi=0`.
Complex cursor movement and alternate-screen controls are reduced to readable
text rather than emulating a full terminal.

The bridge never exposes a generic socket-method proxy, pane/workspace close
operations, or terminal-output persistence. Prompt submission is confirmed in
the browser, and every mutation requires the authenticated session's CSRF
token. Push messages contain only the agent, status, and location needed to
open the matching pane in the dashboard.

### Handle notifications directly

Clicking a **Needs attention** or **Task complete** notification opens the
matching **Pending action** panel. The panel shows the notification status,
agent/pane location, the most recent 80 output lines, and the task and terminal
input controls on one page. There is no need to find the pane under **Recent
output** and then switch to **Controls**. Output is fetched on demand after
login; it is never written into the push payload, notification URL, or bridge
state files.

The action panel only preselects the pane named by the notification; it does
not change Herdr's focus on the computer. Use **Focus computer pane** when
needed. Output loads once when the panel opens and can be refreshed manually
with **Refresh output**. If the pane has already closed, the panel keeps the
notification summary and clearly says that output cannot be read, preventing
an accidental action in another pane.

If the phone is not signed in, the notification link first opens the login
page. After login, the original notification target is restored automatically.
Older links that contain only a `pane` parameter still open **Recent output**.

The HTTP control endpoints are:

```text
POST /api/control/prompt  { "pane_id": "<public pane id>", "text": "..." }
POST /api/control/input   { "pane_id": "<public pane id>", "text": "...", "keys": ["enter"] }
```

Both endpoints return `202` after Herdr accepts the request. Prompt text is
limited to 32 KiB and terminal text to 8 KiB; input keys are limited to eight
allowlisted values per request. A blocked or not-yet-ready agent should be
handled with the interactive input controls instead of another prompt.

In the dashboard, use the **Controls** tab, choose a target pane, and then either:

1. enter a task under **Send task to agent** and confirm the prompt; Herdr submits
   it as an agent request; or
2. enter terminal text under **Interactive input**, or tap one of the key buttons. The
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
If the listener, ACL, rate-limit, or body-timeout settings differ from the
running process, `ensure` returns `reason=config_mismatch` and
`restartRequired:true` without killing the old process. Run `stop` explicitly,
then run `ensure` with the new settings.

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
npm run check
```

The tests use Node's built-in test runner and a fake Unix socket; no running
Herdr server or real push provider is required. The manifest can be validated
with `herdr plugin link <path> --disabled` in a disposable Herdr environment.

## Configuration files

Runtime configuration belongs under `HERDR_PLUGIN_CONFIG_DIR`; PID/lock data
and browser subscriptions belong under `HERDR_PLUGIN_STATE_DIR`. A failed
detached startup is recorded as `startup-error.log` in the state directory and
removed after a successful start. These
directories are created by the plugin/Herdr environment and kept outside the
managed plugin checkout. Treat the
token, bridge secret, and VAPID private key as credentials. You may provide a
VAPID pair in `vapid.json` (the `publicKey`/`privateKey` fields), or let the
gateway generate one on first start. If you configure a pair through
`HERDR_BRIDGE_VAPID_PUBLIC_KEY` and
`HERDR_BRIDGE_VAPID_PRIVATE_KEY`, provide both values together.

For a non-default layout, the launcher also accepts `--host`, `--port`,
`--socket`, `--config-dir`, `--state-dir`, and the LAN flags shown above.
Equivalent environment overrides are `HERDR_BRIDGE_HOST`/`BRIDGE_HOST`,
`HERDR_BRIDGE_PORT`/`BRIDGE_PORT`, `HERDR_SOCKET_PATH`/`BRIDGE_SOCKET_PATH`,
`HERDR_PLUGIN_CONFIG_DIR` (or `HERDR_MOBILE_BRIDGE_CONFIG_DIR`/
`BRIDGE_CONFIG_DIR`), and `HERDR_PLUGIN_STATE_DIR` (or
`HERDR_MOBILE_BRIDGE_STATE_DIR`/`BRIDGE_STATE_DIR`). Unless written to
`bridge.json` or exported in the environment, command-line values apply only
to that invocation.

The event hook normally posts to the loopback gateway discovered from
`runtime.json`. If you intentionally route events to a remote gateway, set
`HERDR_BRIDGE_EVENT_URL` and explicitly allow its exact HTTPS origin with
`HERDR_BRIDGE_EVENT_ALLOWED_ORIGINS` (comma-separated for multiple origins).
The browser `allowedOrigin` setting does not replace this hook allowlist.

Push subscriptions use a strict HTTPS provider allowlist by default. Private,
local, metadata and cleartext endpoints are rejected before persistence and
delivery. A custom relay is an explicit opt-in and should remain LAN-scoped:

```text
HERDR_BRIDGE_ALLOW_PUSH_RELAY=true
HERDR_BRIDGE_ALLOW_CUSTOM_PUSH_ENDPOINTS=true
HERDR_BRIDGE_PUSH_ENDPOINT_ALLOWLIST=relay.example.test
HERDR_BRIDGE_PUSH_TIMEOUT_MS=5000
```

The timeout is bounded to 60 seconds. Do not enable the relay or custom
endpoint flag for an untrusted network; the browser token protects the control
API, but it is not a substitute for HTTPS or a host firewall.

Static endpoint validation deliberately does not resolve custom hostnames at
runtime. This avoids a validation/connect-time TOCTOU gap, but it also means
the check alone cannot prevent DNS rebinding from resolving a hostname to an
internal network. If custom endpoints are enabled, use a trusted relay with
fixed resolution and repeat private, loopback, and cloud-metadata network
blocking at the egress firewall or proxy. Do not treat
`allowCustomPushEndpoints` as a public SSRF boundary.
