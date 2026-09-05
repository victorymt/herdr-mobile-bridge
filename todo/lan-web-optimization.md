# Herdr Mobile Bridge：纯局域网与 Web 优化 TODO

> 目标：只通过手机和电脑所在的局域网使用 Bridge。手机可能长期开启其他 VPN，因而不依赖 Tailscale；不使用 VPS、公网映射、Cloudflare 或可配置路由器。
>
> 建立日期：2026-09-03
>
> 当前状态：代码实现基本完成，待真实手机/VPN、主机防火墙和辅助技术验收。默认交付路径是可信局域网 HTTP；不包含公网映射或公网托管。若需要浏览器推送，可在同一局域网内另行配置 HTTPS 反向代理。

## 1. 目标架构与边界

```text
手机浏览器
    │  http://<电脑 LAN IP>:18787
    ▼
内置 Node LAN proxy（推荐）
    │
    ▼
Bridge 127.0.0.1:8787
    │
    ▼
Herdr Unix socket
```

| 项目 | 约定 |
| --- | --- |
| Bridge 监听 | LAN 部署必须保持 `127.0.0.1:8787`（这是默认值）；不得把 Bridge 直接绑定到 LAN 或 `0.0.0.0` |
| 手机入口 | 电脑 LAN IP 的 `18787` 端口，例如 `http://192.168.1.20:18787` |
| 入口代理 | 设置 `lanProxyHost` 后由内置 Node proxy 监听 `18787`；Caddy/socat 仅作为可选替代，不要同时占用该端口 |
| 身份验证 | 入口 Basic Auth（可选）+ Bridge browser token/session/CSRF |
| 使用范围 | 个人、可信局域网；不承诺公网安全 |
| 明确不做 | Tailscale、VPS、公网隧道、Cloudflare、端口映射、路由器改造 |

### 局域网安全边界

- 普通 LAN HTTP 下，Basic Auth 和 Bridge token 都可能被同网设备抓包；Basic Auth 只增加登录门槛，不提供加密。
- 在不可信 Wi-Fi 或共享网络上使用时，另行配置 LAN HTTPS，并在手机上信任对应证书；不要把 HTTP 入口暴露到公网。
- 代理只绑定电脑实际 LAN 地址，并在主机防火墙中仅允许家庭/个人网段访问 `18787`。
- 二维码只放 URL，不放长期 token。
- VPN 客户端若没有“允许局域网 / Allow LAN traffic / Bypass private networks”，应用无法绕过系统路由策略；只能关闭 VPN 或打开该开关。

### 推送端点安全策略

- 默认只接受 HTTPS 的已知浏览器推送服务域名（FCM、Mozilla、Apple、WNS 等），拒绝
  `localhost`、私网/环回/链路本地 IP、云元数据地址、非标准端口和明文 HTTP，避免
  已认证的浏览器请求把 Bridge 变成任意 HTTP 客户端（SSRF）。
- 自定义 relay/provider 必须显式设置 `allowCustomPushEndpoints=true`（或环境变量
  `HERDR_BRIDGE_ALLOW_CUSTOM_PUSH_ENDPOINTS=true`），且仍拒绝私有/本地目标；relay
  发送默认关闭，需显式设置 `allowPushRelay=true`。
- 推送发送有超时：默认 `pushTimeoutMs=5000`，上限 `60000` 毫秒；超时返回可识别的
  `push_timeout`，不会无限占用事件处理。
- 端点策略同时在 StateStore 注册/加载、PushManager 通知循环和最终 HTTP 发送边界复核，
  不能通过注入旧状态或直接调用发送适配器绕过。
- 自定义 hostname 不做运行时 DNS 解析，因而不能单独抵御 DNS rebinding；启用自定义端点时
  必须使用固定解析的受信 relay，并在出口防火墙/代理层重复阻断私网、环回和元数据网段。

## 2. 分阶段实施清单

### 阶段 1：LAN MVP（最高优先级）

- [x] 在 `src/config.js` 支持 LAN 绑定地址/端口配置（设置 host 即启用，默认入口端口 `18787`），并校验端口范围及其不能与 Bridge 端口相同。
- [x] 增加显式允许网段 ACL 配置；内置 Node proxy 按真实 TCP 来源执行 CIDR deny-by-default，拒绝直接关闭连接。主机防火墙规则仍需按系统手工配置。
- [x] 默认 Bridge 保持监听 `127.0.0.1:8787`；LAN 入口默认使用 `18787`，避免与内部端口混淆。
- [x] 在 `src/launcher.js` 与 `src/index.js` 管理内置 LAN proxy 生命周期：启动、停止、重复启动复用、异常退出记录和清理。
- [x] 为内置 proxy 增加健康检查，确认端口已监听且后端 Bridge 可达后再报告成功。
- [x] 启动进程使用 PID 身份校验（进程启动时间/入口匹配），避免旧 runtime marker 误复用。
- [x] 增加 LAN 地址发现/展示和最小连通性检查；地址变化时在向导中重新列出候选地址。
- [x] 入口实现：内置 Node LAN proxy 绑定指定 LAN IP，转发到 `127.0.0.1:8787`。
  - [x] 已提供可选 Caddy LAN HTTPS/Basic Auth 配置示例（`docs/Caddyfile.lan.example`）；实际证书信任和部署仍需用户验收。
  - [x] 可选 socat：文档提供 `TCP-LISTEN:18787,bind=<LAN_IP>,reuseaddr,fork` 转发命令。
- [x] 已更新 `README.md` 与 `docs/socat-phone-connection.html`，统一 `18787 → 8787` 的说明、启动/停止命令和故障排查。
- [ ] 用手机在 VPN 关闭、VPN 开启两种状态验证 LAN 访问；记录 VPN 的 “Allow LAN traffic / 允许局域网 / Bypass private networks / 本地网络共享” 开关。
- [x] 已明确记录：若 VPN 客户端没有 LAN bypass，应用代码无法绕过系统路由限制。

### 阶段 2：手机连接向导与二维码

- [x] 将登录页改为“手机连接向导”，显示 Bridge 状态、LAN 地址、入口端口和当前连接状态。
- [x] 展示可直接点击的手机 URL：`http://<LAN_IP>:18787`。
- [x] 增加二维码（仅编码 URL，不编码长期 token）。
- [x] 增加“复制地址”和“局域网连接测试”按钮，测试结果区分成功、超时、拒绝和 VPN 拦截。
- [x] 在向导中提供 VPN/LAN bypass 的逐项提示和重新测试入口。
- [x] 登录后保留 token/session 的安全提示；二维码不携带长期凭据。
- [x] 增加短时一次性配对码，进一步减少手动粘贴 token 的需要；使用 `node src/launcher.js pair` 生成。
- [x] 对 `401/403/404/429` 和网络断开提供面向用户的中文错误说明及下一步操作。

### 阶段 3：后端安全、生命周期与实时性

- [x] `src/server.js` output 接口建立 DTO allowlist，禁止透传原始 `read` 对象。
- [x] `src/server.js` focus 接口建立 DTO allowlist，禁止透传原始 `result`。
- [x] `src/auth.js` 默认关闭 SSE query token；正常浏览器连接使用 cookie/session，避免长期 token 出现在历史记录、日志和代理 URL 中。
- [x] `/healthz` 默认只返回最小 `ok/service` 状态；详细运行信息必须显式开启 `healthDetails`。
- [x] 登录尝试按来源限流；控制请求有按窗格/全局 in-flight 上限；Herdr socket 请求有超时；SSE 客户端数量和队列有界。
- [x] 按 session/IP 的统一令牌桶限流及 HTTP 请求体绝对超时已实现：API 默认 120 次/分钟、突发 30，登录每来源 5 次/分钟，body 默认 10 秒且上限 60 秒；透明 L4 proxy 的真实手机 IP 连接级限制与外部 L7 proxy 边界已记录。
- [x] `src/event-hook.js` 修复 Bridge 启动竞态；启动失败或连接断开时最多有限重试，并输出脱敏原因。
- [x] `src/event-bus.js` 在 replay 超出 256 条事件窗口时显式返回 `resync_required`，不静默丢事件。
- [x] SSE 序号携带进程代次/generation，避免 Bridge 重启后序号重置造成误判。
- [x] `src/server.js` 实现有界 SSE 队列和背压；连接建立后立即注册 close listener，并在所有退出路径清理监听器。
- [x] 对断线客户端提供完整状态重同步，不依赖无限 replay。
- [x] 控制操作增加前端 busy、后端按窗格去重/幂等保护，避免重复提交 prompt 或 pane input。
- [x] 状态、事件、推送和持久化路径均使用 allowlist/有界字段，不写入完整终端输出、browser token、Bridge secret 或推送凭据。
- [x] 推送端点默认 allowlist、私网/元数据地址拦截、自定义 relay 显式开关和发送超时已实现并有回归测试。

### 阶段 4：桌面端、手机端与 PWA

#### 桌面端

- [x] 保留双栏结构：主区域（状态、输出、聚焦、控制）+ 侧栏（连接信息、快捷入口、推送状态）。
- [x] 增加 LAN 连接状态、最后同步时间，以及 offline/stale/session expired 状态。
- [x] 输出区增加“复制”和“跳到最新”；长输出保持可滚动且不阻塞主线程。
- [x] 控制请求显示 busy 状态，提交期间禁用重复点击并在完成/失败后恢复。
- [x] tabs 使用完整键盘 ARIA 交互（`role=tablist/tab/tabpanel`、方向键、焦点和选中状态）。
- [x] 连接向导和二维码在桌面宽屏仍保持清晰、可复制。

#### 手机端

- [x] 所有主要可点击控件触摸目标至少 `44×44px`；通用按钮、退出按钮、登录向导复制/测试按钮、`select` 和 keypad 均有 44px 最小触控尺寸。
- [x] 小屏 topbar 允许换行，移除 `nowrap` 挤压风险。
- [x] 320px、375px、390px 下保持单列布局、无水平滚动，并提供底部快捷操作（已用 BrowserOS 做尺寸回归）。
- [x] 离线时保留最近一次安全状态缓存，禁用写操作并解释原因；恢复网络、页面重新可见时自动同步。
- [x] 输出区增加复制、刷新和跳到最新；刷新时尽量保持用户当前阅读位置。
- [x] 将整块日志的 `aria-live` 改为只播报摘要/状态变化，避免读屏重复朗读大段输出。
- [x] focus 操作增加 busy 状态、重复点击去重和成功/失败反馈。
- [x] 前后端统一长度单位：前端按 UTF-8 字节限制输入，并在超限时截断/提示。
- [x] 明确处理 401（需重新登录）、403（CSRF/权限）、404（窗格已关闭）、429（稍后重试）和网络错误。

#### PWA 资源

- [x] `public/manifest.webmanifest` 增加 PNG/多尺寸图标（保留 SVG 作为现代浏览器 fallback）。
- [x] `public/sw.js` 使用可追踪版本号，提供更新提示和安全的旧缓存淘汰。
- [x] service worker 更新流程提供“重新加载新版”按钮，并在自动化/桌面浏览器中验证新 JavaScript/CSS 可安装；真实手机仍需验收。

> 浏览器安全策略说明：`http://<LAN_IP>:18787` 通常不是 secure context。普通 HTTP 下，
> 浏览器可能拒绝注册 Service Worker，离线“重新打开页面”不能承诺使用缓存 App Shell，
> `Notification`/Web Push 也会被禁用；这是浏览器策略，不是 LAN proxy 故障。HTTP 仍可用于
> 登录、查看状态、读取输出和控制操作。需要 PWA 离线壳或 Web Push 时，在同一 LAN 内配置
> 仅绑定 LAN 地址的 HTTPS 反向代理，并将 `cookieSecure=true` 与精确 `allowedOrigin` 一并配置。

## 3. SSE 与状态同步设计

- [x] 监听 `pane_output_changed`；输出只对当前窗格做延迟刷新，其他状态事件合并为一次状态同步。
- [x] 对状态刷新做约 `280ms` debounce，并合并 in-flight `/api/state` 请求。
- [x] 连接建立、断线恢复、页面重新可见和手动刷新都会触发一次完整同步。
- [x] replay 窗口不足时发送 `resync_required`，前端清理过期游标后重新拉取 `/api/state`。
- [x] 慢客户端使用有界队列和背压；超过上限时断开并要求重新同步，不能无限占用内存。
- [x] 前端展示“实时 / 延迟 / 已断开”状态和最后同步时间。

## 4. 建议修改的文件/模块

| 文件 | 责任 |
| --- | --- |
| `src/config.js` | LAN 开关、绑定地址/端口、CIDR ACL、限流/请求体超时配置和启动指纹 |
| `src/launcher.js` | LAN proxy 生命周期、健康检查、PID 身份和运行标记 |
| `src/lan-proxy.js`（已实现） | 用 Node 实现跨平台 LAN 转发，作为默认入口；外部 socat/Caddy 为可选替代 |
| `src/server.js` | DTO allowlist、healthz、session/IP 限流、请求体超时、SSE 背压 |
| `src/auth.js` | query token 限制、session/CSRF、一次性配对码 |
| `src/event-hook.js` | 启动竞态重试、错误和日志脱敏 |
| `src/event-bus.js` | replay gap、`resync_required` 和重启代次 |
| `public/index.html` | 连接向导、二维码、无障碍结构 |
| `public/app.js` | LAN 检测、SSE debounce、离线状态、busy 状态、错误提示 |
| `public/styles.css` | 去除重复覆盖、响应式布局、触控尺寸和 topbar 换行 |
| `public/manifest.webmanifest` | PWA 图标和显示元数据 |
| `public/sw.js` | 缓存版本、更新提示和旧缓存清理 |
| `README.md`、`docs/socat-phone-connection.html` | 纯 LAN 安装、VPN 排查和安全边界 |

## 5. 测试与验收基线

### 已知基线

- [x] `npm run check`：通过。
- [x] `npm audit --offline --omit=dev --audit-level=moderate`：本地缓存审计为 0 vulnerabilities（联网审计需在可访问 registry 的环境复核）。
- [x] `npm test`：默认并行 runner 已通过全部自动化回归（含 CIDR ACL、代理连接限流、令牌桶、配置指纹和请求体超时）。
- [x] 已修复 `test/config-launcher.test.js` 的固定 PID `1234` 冲突：测试注入 `processInspector`，没有放宽生产身份校验。

### 功能验收

- [x] 代码级约束已覆盖：Bridge 默认监听 `127.0.0.1:8787`，内置 LAN 入口仅绑定显式电脑地址的 `18787`。
- [ ] 真机验收：同一 Wi-Fi 下，手机 VPN 关闭时可打开向导、登录、查看状态、读取输出和执行控制。
- [ ] 真机验收：手机 VPN 开启且启用 LAN bypass 时行为相同；未启用时显示明确的路由/VPN 提示。
- [ ] 真机/代理验收：Basic Auth（如启用）和 Bridge token 均能拒绝错误凭据；凭据不出现在 URL、二维码、日志或推送内容中。
- [x] 自动化覆盖：Bridge/代理重启后可通过 generation、replay gap 和完整 `/api/state` resync 恢复；仍需在真实手机观察 stale 提示。
- [ ] 真机/视觉验收：320px、375px、390px、桌面宽屏及 200% 字体缩放下无水平滚动，主要控件满足 44px 触控目标（BrowserOS 设备仿真已完成初筛，仍需真实手机）。
- [ ] 键盘、读屏和错误状态的实际辅助技术验收；代码和 DOM/ARIA 初筛已完成，仍需实际读屏器。
- [ ] 真机验收：service worker 更新后不会继续显示旧界面，PWA 图标在主流手机浏览器可用（资源/注册已在 BrowserOS 初筛）。
- [x] 自动化验收：推送服务域名 allowlist、私网/元数据地址拒绝、relay 显式开关、超时和直接发送边界复核均已覆盖。

### 建议测试矩阵

| 场景 | 预期 |
| --- | --- |
| LAN IP 正常、VPN 关闭 | URL 可访问并完成登录 |
| LAN IP 正常、VPN 开启且允许 LAN | 与上项一致 |
| VPN 禁止 LAN | 向导显示“关闭 VPN 或开启允许局域网” |
| 代理端口被占用 | launcher 明确报错，不伪装成 Bridge 故障 |
| Bridge 重启/SSE 断线 | 前端显示 stale，恢复后自动同步 |
| replay 超过窗口 | 返回 `resync_required`，不静默丢状态 |
| 窗格已关闭 | 输出/控制返回 404，并保留通知摘要 |
| 慢 SSE 客户端 | 队列有界，必要时断开并要求 resync |
| 错误 token/CSRF/频率过高 | 分别返回 401/403/429 和可理解提示 |

## 6. 运行与排障备忘

```bash
# 查看本机 LAN 地址（选择与手机同一网段的地址）
ip -4 addr

# 查看 Bridge 状态
node src/launcher.js status

# 初始化/查看 token（不要写入二维码或日志）
node src/launcher.js setup
node src/launcher.js token

# 启用内置 Node LAN proxy（把 <LAN_IP> 替换成电脑地址；host 明确指定后才监听）
node src/launcher.js ensure --lan-host <LAN_IP> --lan-port 18787

# 或仅在可信 LAN 临时使用外部 socat（不要与内置 proxy 同时占用 18787）
socat TCP-LISTEN:18787,bind=<LAN_IP>,reuseaddr,fork TCP:127.0.0.1:8787

# 本机检查 Bridge（不是给手机打开的地址）
curl -fsS http://127.0.0.1:8787/healthz

# 停止 Bridge/proxy
node src/launcher.js stop
```

- [ ] 在主机防火墙放行 `18787/tcp` 仅给家庭/个人 LAN 网段（需按操作系统实际配置并验证）。
- [x] 若 `cookieSecure` 为 `true`，服务端会根据实际请求协议生成 Cookie：HTTPS 仍使用 `Secure`，
  HTTP-only LAN 访问不会因静态 `Secure` 属性而在登录后立刻失效；仍建议 HTTP-only 路径不要启用该选项。
- [ ] 若显式设置 `allowedOrigin`，必须包含精确的 LAN origin（例如 `http://192.168.1.20`），否则应移除该覆盖值以使用同源访问。

真机、辅助技术和防火墙验收可按 [`docs/lan-acceptance-checklist.md`](../docs/lan-acceptance-checklist.md)
逐项记录；这些项目不能由本地自动化测试代替。

## 7. 完成定义与优先级

1. **P0（代码已完成，待真机）：** loopback + 指定 LAN proxy、健康检查、文档和 VPN 验证。
2. **P1（代码已完成，待真机）：** 连接向导、二维码、复制/测试和错误引导。
3. **P1（代码已完成）：** DTO、query token 风险修复、SSE resync/backpressure、生命周期重试和控制限流。
4. **P2（代码已完成，待辅助技术/手机回归）：** 桌面/手机响应式、无障碍、离线体验、PWA 资源和浏览器回归测试。

只有同时满足“手机可在同一 LAN 稳定访问”“VPN LAN bypass 场景有明确反馈”“Bridge 未直接暴露到 LAN”“控制和实时状态在重启/断线后可恢复”时，才算本计划完成。

## 8. 当前工作树注意事项

`public/icon.svg` 有用户已有修改，必须保留，严禁覆盖或提交。其余实现文件可能处于
未提交状态；合并或继续开发前以 `git status`/`git diff` 为准，不要使用 reset/checkout
回滚其他改动。提交时将实现、测试和文档拆分成可审阅的小提交，并确保不把凭据、二维码
中的长期 token 或完整终端输出写入仓库。

### 实现提交记录

- 实现提交 hash：`94293d5`（LAN 生命周期、配置与推送安全）、`1880fc3`
  （推送策略别名兼容）和 `eb5ebe0`（桌面/手机 Web、PWA 与视觉回归）；
  文档提交另行记录。三个提交均明确排除用户已有的 `public/icon.svg` 修改。
