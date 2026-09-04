# LAN / 手机验收清单

这份清单用于完成 `todo/lan-web-optimization.md` 中无法在本地单元测试替代的验收。每次
测试都应使用可信家庭/个人网络，不要把端口映射到公网；测试结束后执行
`node src/launcher.js stop`。

## 启动前记录

- [ ] 记录电脑实际 LAN 地址、操作系统、防火墙配置和手机型号/系统版本。
- [ ] 确认 Bridge 仍监听 `127.0.0.1:8787`，LAN 入口仅监听指定地址的 `18787`。
- [ ] 若使用 Caddy，先按 [`Caddyfile.lan.example`](Caddyfile.lan.example) 配置 HTTPS，确认
      `allowedOrigin` 与实际 origin 完全一致；HTTP-only 测试保持 `cookieSecure=false`。
- [ ] 确认二维码和日志中没有长期 token；token 仅通过本机安全终端读取。

## 网络与 VPN

- [ ] VPN 关闭：手机打开 LAN URL，完成登录、状态查看、输出读取、聚焦和控制。
- [ ] VPN 开启且打开 “Allow LAN / 允许局域网 / Bypass private networks”：重复上述流程。
- [ ] VPN 开启且关闭 LAN bypass：确认页面给出路由/VPN 提示，而不是无限重试或泄露凭据。
- [ ] 从不在同一 Wi‑Fi 的第三台设备验证 ACL/防火墙拒绝结果；内置 proxy 应直接关闭 TCP。

## 认证与生命周期

- [ ] 错误 token 返回 401；错误 CSRF 返回 403；频率过高返回 429 和 `Retry-After`。
- [ ] 重启 Bridge 或断开 SSE 后，页面显示 stale/offline，并在恢复后完整同步状态。
- [ ] 关闭窗格后，输出/控制请求返回可理解的 404 提示。
- [ ] 代理端口被占用时，launcher 明确报告端口冲突并清理旧 marker。

## 响应式与辅助技术

- [ ] 在 320、375、390 CSS px、桌面宽屏和 200% 字体缩放下截图确认无水平滚动。
- [ ] 仅用键盘完成 tab 切换、登录、复制、刷新、聚焦和控制；焦点指示清晰。
- [ ] 使用 VoiceOver/TalkBack/NVDA 等读屏检查标题、tab、错误提示、连接状态和日志摘要。
- [ ] 触摸控件可稳定点击，主要目标不小于 44×44 CSS px。

## PWA / 推送 / 安全配置

- [ ] HTTPS origin 下允许通知并注册推送；普通 HTTP 下应显示浏览器限制说明。
- [ ] Service Worker 更新后按“重新加载新版”进入新资源，不继续使用旧缓存。
- [ ] 安装到主屏幕后检查图标、名称、启动 URL 和离线/恢复行为。
- [ ] 主机防火墙只放行可信 LAN 网段的 `18787/tcp`，从非允许网段验证拒绝。
- [ ] 记录 `cookieSecure`、`allowedOrigin` 的最终值和实际浏览器行为，避免把 HTTP 与 HTTPS
      配置混用。

## 结果记录

将每项的日期、设备、网络/VPN 状态、结果和截图路径写回 TODO 文件或项目 issue；不要把
token、Cookie、推送密钥或完整终端输出保存进仓库。
