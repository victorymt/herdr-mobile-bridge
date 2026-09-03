# Herdr Mobile Bridge：纯局域网与 Web 优化 TODO

> 目标：只通过手机和电脑所在的局域网使用 Bridge。手机可能长期开启其他 VPN，因而不依赖 Tailscale；不使用 VPS、公网映射、Cloudflare 或可配置路由器。
>
> 建立日期：2026-09-03
>
> 当前状态：已完成代码、文档、桌面/手机 Web 界面和局域网连接方式审查；以下实现项尚未全部落地。

## 1. 目标架构与边界

```text
手机浏览器
    │  http://<电脑 LAN IP>:18787
    ▼
Caddy（推荐）或 socat（临时/最小依赖）
    │
    ▼
Bridge 127.0.0.1:8787
    │
    ▼
Herdr Unix socket
```

| 项目 | 约定 |
| --- | --- |
| Bridge 监听 | 始终保持 `127.0.0.1:8787`，不得直接绑定 LAN 或 `0.0.0.0` |
| 手机入口 | 电脑 LAN IP 的 `18787` 端口，例如 `http://192.168.1.20:18787` |
| 入口代理 | Caddy 和 socat 二选一，不要同时占用 `18787` |
| 身份验证 | 入口 Basic Auth（可选）+ Bridge browser token/session/CSRF |
| 使用范围 | 个人、可信局域网；不承诺公网安全 |
| 明确不做 | Tailscale、VPS、公网隧道、Cloudflare、端口映射、路由器改造 |

### 局域网安全边界

- 普通 LAN HTTP 下，Basic Auth 和 Bridge token 都可能被同网设备抓包；Basic Auth 只增加登录门槛，不提供加密。
- 在不可信 Wi-Fi 或共享网络上使用时，另行配置 LAN HTTPS，并在手机上信任对应证书；不要把 HTTP 入口暴露到公网。
- 代理只绑定电脑实际 LAN 地址，并在主机防火墙中仅允许家庭/个人网段访问 `18787`。
- 二维码只放 URL，不放长期 token。

## 2. 分阶段实施清单

### 阶段 1：LAN MVP（最高优先级）

- [ ] 在 `src/config.js` 增加 LAN 配置：启用开关、绑定地址、LAN 端口、允许网段、端口和配置上限校验。
- [ ] 保持 Bridge 仅监听 `127.0.0.1:8787`；默认 LAN 入口固定为 `18787`，避免与内部端口混淆。
- [ ] 在 `src/launcher.js` 管理 LAN proxy 生命周期：启动、停止、重复启动复用、异常退出记录和清理。
- [ ] 为 proxy 增加健康检查，确认端口已监听且后端 Bridge 可达后再报告成功。
- [ ] 启动进程使用 PID 身份校验（不只检查 PID 是否存在），避免旧 runtime marker 误复用。
- [ ] 增加 LAN 地址发现/展示和最小连通性检查；地址变化时给出明确提示。
- [ ] 入口实现二选一：
  - [ ] Caddy：绑定 LAN IP，反代到 `127.0.0.1:8787`，按需启用 Basic Auth。
  - [ ] socat：使用 `TCP-LISTEN:18787,bind=<LAN_IP>,reuseaddr,fork` 转发到 `127.0.0.1:8787`。
- [ ] 更新 `README.md` 与 `docs/socat-phone-connection.html`，统一 `18787 → 8787` 的说明、启动/停止命令和故障排查。
- [ ] 用手机在 VPN 关闭、VPN 开启两种状态验证 LAN 访问；记录 VPN 的 “Allow LAN traffic / 允许局域网 / Bypass private networks / 本地网络共享” 开关。
- [ ] 明确记录：若 VPN 客户端没有 LAN bypass，应用代码无法绕过系统路由限制。

### 阶段 2：手机连接向导与二维码

- [ ] 将登录页改为“手机连接向导”，显示 Bridge 状态、LAN 地址、入口端口和当前连接状态。
- [ ] 展示可直接点击的手机 URL：`http://<LAN_IP>:18787`。
- [ ] 增加二维码（仅编码 URL，不编码长期 token）。
- [ ] 增加“复制地址”和“局域网连接测试”按钮，测试结果区分成功、超时、拒绝和 VPN 拦截。
- [ ] 在向导中提供 VPN/LAN bypass 的逐项提示和重新测试入口。
- [ ] 登录后保留 token/session 的安全提示；可选增加短时一次性配对码，避免在二维码中携带长期凭据。
- [ ] 对 `401/403/404/429` 和网络断开提供面向用户的中文错误说明及下一步操作。

### 阶段 3：后端安全、生命周期与实时性

- [ ] `src/server.js:696`：为 output 接口建立 DTO allowlist，禁止透传原始 `read` 对象。
- [ ] `src/server.js:717`：为 focus 接口建立 DTO allowlist，禁止透传原始 `result`。
- [ ] `src/auth.js:102`：限制或移除 SSE query token；优先使用 cookie/session 或一次性短时凭据，避免 token 出现在历史记录、日志和代理 URL 中。
- [ ] `src/server.js:501`：收敛 `/healthz` 返回内容；默认不鉴权时也不得泄露 PID、端口、socket 状态等运行细节，必要时只返回最小 `ok` 状态。
- [ ] 为登录、控制接口和 SSE 增加按 session/IP 的限流、请求超时和并发上限。
- [ ] `src/event-hook.js:137,225`：修复 Bridge 启动竞态；启动失败或连接断开时有限重试并记录脱敏原因。
- [ ] `src/event-bus.js:182`：replay 超出 256 条事件窗口时显式返回 `resync_required`，不要静默丢事件。
- [ ] 为 SSE 序号加入进程代次/重启标识，避免 Bridge 重启后序号重置造成误判。
- [ ] `src/server.js:814`：实现有界 SSE 队列和背压；连接建立后立即注册 close listener，并在所有退出路径清理监听器。
- [ ] 对断线客户端提供完整状态重同步，而不是依赖无限 replay。
- [ ] 控制操作增加 busy/去重/幂等保护，避免重复提交 prompt 或 pane input。
- [ ] 所有日志脱敏，不写入 browser token、Bridge secret、推送凭据或完整终端输出。

### 阶段 4：桌面端、手机端与 PWA

#### 桌面端

- [ ] 保留双栏结构：主区域（状态、输出、聚焦、控制）+ 侧栏（连接信息、快捷入口、推送状态）。
- [ ] 增加 LAN 连接状态、最后同步时间，以及 offline/stale/session expired 状态。
- [ ] 输出区增加“复制”和“跳到最新”；长输出保持可滚动且不阻塞主线程。
- [ ] 控制请求显示 busy 状态，提交期间禁用重复点击并在完成/失败后恢复。
- [ ] tabs 使用完整键盘 ARIA 交互（`role=tablist/tab/tabpanel`、方向键、焦点和选中状态）。
- [ ] 连接向导和二维码在桌面宽屏仍保持清晰、可复制。

#### 手机端

- [ ] 所有主要可点击控件触摸目标至少 `44×44px`；尤其是文字按钮、退出按钮和 keypad。
- [ ] 小屏 topbar 允许换行，修正 `public/styles.css:487` 的 `nowrap` 挤压风险。
- [ ] 320px、375px、390px 下保持单列布局，无水平滚动；底部提供常用快捷操作。
- [ ] 离线时保留最近一次数据，禁用写操作并解释原因；恢复网络、页面重新可见时自动同步。
- [ ] 输出区增加复制、刷新和跳到最新；避免刷新时跳动用户当前阅读位置。
- [ ] 将整块日志的 `aria-live`（`public/index.html:55,73`）改为只播报摘要/状态变化，避免读屏重复朗读大段输出。
- [ ] focus 操作增加 busy 状态、重复点击去重和成功/失败反馈。
- [ ] 前后端统一长度单位：前端 `maxlength` 按 UTF-8 字节限制，或在提交前按后端规则提示，而不是只按字符数。
- [ ] 明确处理 401（需重新登录）、403（CSRF/权限）、404（窗格已关闭）、429（稍后重试）和网络错误。

#### PWA 资源

- [ ] `public/manifest.webmanifest:9` 增加 PNG/多尺寸图标（保留 SVG 作为现代浏览器 fallback）。
- [ ] `public/sw.js:1` 使用可追踪版本号/构建哈希，提供更新提示和安全的旧缓存淘汰。
- [ ] service worker 更新后验证新 JavaScript/CSS 已生效；必要时提供“重新加载新版”按钮。

## 3. SSE 与状态同步设计

- [ ] 监听 `pane_output_changed`，不要对所有事件立即全量刷新。
- [ ] 对状态刷新做 `200–500ms` debounce，并合并 in-flight `/api/state` 请求。
- [ ] 连接建立、断线恢复、页面重新可见和手动刷新都触发一次完整同步。
- [ ] replay 窗口不足时发送 `resync_required`，前端清理过期游标后重新拉取 `/api/state`。
- [ ] 慢客户端使用有界队列和背压；超过上限时断开并要求重新同步，不能无限占用内存。
- [ ] 前端展示“实时 / 延迟 / 已断开”状态和最后同步时间。

## 4. 建议修改的文件/模块

| 文件 | 责任 |
| --- | --- |
| `src/config.js` | LAN 开关、绑定地址、LAN 端口、网段和上限校验 |
| `src/launcher.js` | LAN proxy 生命周期、健康检查、PID 身份 |
| `src/lan-proxy.js`（新增，可选） | 用 Node 实现跨平台 LAN 转发，替代外部 socat |
| `src/server.js` | DTO allowlist、healthz、限流、超时、SSE 背压 |
| `src/auth.js` | query token 限制、一次性配对码、session/CSRF |
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
- [x] `npm audit --omit=dev`：0 vulnerabilities。
- [ ] `npm test`：当前 50 个测试中 49 个通过，1 个失败。
- [ ] 修复 `test/config-launcher.test.js:23`：测试中的固定 PID `1234` 与当前容器真实 `/proc/1234` 冲突；应注入 `processInspector: () => undefined` 或改用不会冲突的高位 PID，不要放宽生产身份校验。

### 功能验收

- [ ] Bridge 仍只监听 `127.0.0.1:8787`，LAN 入口只监听指定电脑地址的 `18787`。
- [ ] 同一 Wi-Fi 下，手机 VPN 关闭时可打开向导、登录、查看状态、读取输出和执行控制。
- [ ] 手机 VPN 开启且启用 LAN bypass 时行为相同；未启用时显示明确的路由/VPN 提示。
- [ ] Basic Auth（如启用）和 Bridge token 均能拒绝错误凭据；凭据不出现在 URL、二维码、日志或推送内容中。
- [ ] Bridge/代理重启后，旧页面能提示 stale 并自动恢复状态；SSE replay gap 能触发完整 resync。
- [ ] 320px、375px、390px、桌面宽屏及 200% 字体缩放下无水平滚动，主要控件满足 44px 触控目标。
- [ ] 键盘、读屏和错误状态可操作；日志不会被整段重复播报。
- [ ] service worker 更新后不会继续显示旧界面，PWA 图标在主流手机浏览器可用。

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

# 仅在可信 LAN 临时使用 socat；把 <LAN_IP> 替换成电脑地址
socat TCP-LISTEN:18787,bind=<LAN_IP>,reuseaddr,fork TCP:127.0.0.1:8787

# 本机检查 Bridge（不是给手机打开的地址）
curl -fsS http://127.0.0.1:8787/healthz

# 停止 Bridge/proxy
node src/launcher.js stop
```

- [ ] 在主机防火墙放行 `18787/tcp` 仅给家庭/个人 LAN 网段。
- [ ] 若 `cookieSecure` 为 `true`，LAN HTTP 登录会失败；HTTP-only LAN 路径应保持未设置或设为 `false`。
- [ ] 若显式设置 `allowedOrigin`，必须包含精确的 LAN origin（例如 `http://192.168.1.20`），否则应移除该覆盖值以使用同源访问。

## 7. 完成定义与优先级

1. **P0：** 阶段 1 的 loopback + 指定 LAN proxy、健康检查、文档和 VPN 验证可用。
2. **P1：** 阶段 2 的连接向导、二维码、复制/测试和错误引导可用。
3. **P1：** 阶段 3 的 DTO、query token 风险修复、SSE resync/backpressure、生命周期重试和控制限流完成。
4. **P2：** 阶段 4 的桌面/手机响应式、无障碍、离线体验、PWA 资源和浏览器回归测试完成。

只有同时满足“手机可在同一 LAN 稳定访问”“VPN LAN bypass 场景有明确反馈”“Bridge 未直接暴露到 LAN”“控制和实时状态在重启/断线后可恢复”时，才算本计划完成。

## 8. 当前工作树注意事项

以下是已有用户修改，实施时必须保留并在其基础上调整，不能覆盖：

```text
M public/app.js
M public/icon.svg
M public/index.html
M public/manifest.webmanifest
M public/styles.css
M public/sw.js
M test/service-worker.test.js
?? docs/
```

