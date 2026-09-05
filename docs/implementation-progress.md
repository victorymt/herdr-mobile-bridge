# Herdr Mobile Bridge 实现进度

最后更新：2026-09-05

本文档用于下次继续开发时快速恢复上下文。当前改动尚未提交为 Git commit；请保留工作区中已有的用户修改，尤其是 `public/icon.svg`。

## 当前状态

已完成批准方案中的代码实现，主要包括：

- LAN 代理显式 CIDR ACL：支持 JSON、环境变量和 CLI，严格校验地址，拒绝连接时直接关闭 TCP。
- 统一限流：API、登录和 LAN 连接使用 token bucket；返回 `429` 与 `Retry-After`，有容量上限和凭据哈希隔离。
- 请求体防护：绝对读取超时、大小限制、`408 request_body_timeout`、`413 body_too_large`，并关闭未消费请求连接。
- 配置指纹：基于有效非秘密配置计算；父子进程配置不一致时返回 `restartRequired/config_mismatch`。
- 启动器与嵌入式启动：传播 ACL、限流、请求体、VAPID、凭据及内部解析后的绝对路径；注入配置可绕过旧 `bridge.json`，避免父子配置分叉。
- Loopback、IPv4/IPv6（含映射地址）识别、IPv6 URL 展示、代理目标地址和 SSRF/请求边界校验已补强。
- 追加边界修复：CLI 显式空值会进入统一校验，`config:null`/继承的文件隔离标记在父子进程保持一致；`stop`/`status` 与 `ensure` 共用配置类型语义。
- 直接构造 `BridgeServer` 时也拒绝 `false`、字符串、数组等伪配置；launcher 注入配置的相对
  `configDir/stateDir/runtime/lock/subscriptions/dedup/socket` 及显式环境别名统一按
  `options.cwd` 解析，避免 detached child 与父进程寻址漂移。
- 推送端点补充展开/映射 IPv6、保留/文档网段、NAT64/6to4 字面量与重定向阻断；自定义持久化路径会自动创建父目录，事件钩子会读取 launcher 传播的 runtime marker 路径。
- 最终边界审计补充：直接 `BridgeServer` 与 loader 对显式空 listener、`lanProxyTargetHost:null`、`~`/相对
  `socketPath` 保持一致；`HerdrSocketClient` 的单次 socket 覆盖值不再把显式空值/非字符串静默回退到默认路径。
- 启动器不会把文件读取的长期 token/secret 无条件放入 detached child 环境；只有注入配置、显式环境/选项或
  不持久化生成场景才传播凭据，并会清除旧别名。推送订阅的 `expirationTime` 现在仅接受有限的非负数标量。
- 启动器注入配置对 `host`、`port`、`lanProxyHost`、`lanProxyPort` 和 `socketPath` 的显式空值统一
  fail-closed，与异步/同步配置加载及直接 `BridgeServer` 构造保持一致，不再静默套用默认监听值。
- 输出接口支持显式的 `source`、`format` 和 `strip_ansi` 读取参数；移动端使用 Herdr 的
  `recent_unwrapped` ANSI 快照，并通过安全的文本节点渲染器保留常见颜色、粗体、下划线等样式，
  复制时自动还原为纯文本。光标移动、备用屏幕和其他未支持的终端控制会降级为可读文本。
- Cookie 的 `Secure` 属性按实际请求协议生成；全局启用 `cookieSecure` 时，HTTPS 仍保持安全属性，
  HTTP-only LAN 访问也不会在登录成功后因浏览器拒发 Cookie 而立即回到登录页。
- README、README.zh-CN.md、socat 连接文档及 TODO 清单已同步更新；两份 README 均说明
  LAN CLI 参数的非持久性、`status` 的 loopback URL 与 detached 启动状态。
- 已提供可选的 Caddy LAN HTTPS 示例和独立的真机/辅助技术验收清单。
- 推送可靠性已补齐：已接收事件先写入有界持久化队列，网络/超时/429/5xx 按退避重试，重启后恢复；
  404/410 会移除失效订阅，状态变化会取消未发送的旧提醒，并提供受保护的 `/api/push/status`。
- 一次性配对码已补齐：`node src/launcher.js pair` 在本机生成 8 位、5 分钟有效、最多使用一次的数字码；
  手机登录页默认使用配对码，访问令牌登录仍可回退。

## 验证结果

最近一次验证结果：

```text
npm test                         163/163 通过
npm run check                    通过
git diff --check                 通过
npm audit --offline --omit=dev --audit-level=moderate  0 vulnerabilities
```

代码知识图谱已在本轮源码状态重新索引（977 nodes / 2746 edges）。

另已做过父进程/ detached child 模拟，确认默认配置、空值回退、旧配置隔离、VAPID/凭据传播，以及自定义相对 `runtime/lock/subscriptions/dedup` 路径和显式环境别名的指纹、路径一致；直接 `BridgeServer` 构造边界、直接/单次 socket 覆盖值和订阅元数据边界也有回归覆盖。

本轮新增推送可靠性和配对回归测试；当前全量测试为 `163/163` 通过。

BrowserOS 本地浏览器初筛也已完成：在 320、375、390 CSS px 以及 200% 根字号下，向导没有水平
溢出；可见按钮、链接和输入框的高度均为 44px；可见图片没有缺失 `alt`；标题层级存在；
`manifest.webmanifest`、PNG/SVG 图标和已激活的 Service Worker 均可从页面读取。该结果只代表桌面
浏览器的设备仿真，不替代真实手机、VPN 路由、安装到主屏幕或读屏器验收。

## 仍未完成或需要人工验收

以下项目不适合仅靠本地单元测试完成，仍需真实主机、手机或浏览器环境：

- 手机 VPN 关闭/开启时的真实 LAN 连接验证。
- 一次性配对码在真实 LAN 上的 CLI 生成、手机输入和过期提示体验。
- 同 Wi‑Fi、VPN 绕行、Basic Auth/token 代理等真实设备访问验证。
- 真实手机上的 320/375/390/桌面/200% 缩放视觉检查（BrowserOS 仿真已通过初筛）。
- 键盘操作与屏幕阅读器可访问性检查（DOM/ARIA 初筛已完成，仍需实际辅助技术）。
- 主流手机浏览器中的 PWA、Service Worker、图标安装行为检查（资源与注册初筛已完成）。
- 主机防火墙端口 `18787` 验证。
- `cookieSecure` 在 HTTP 场景下的人工确认。
- `allowedOrigin` 精确 LAN Origin 的人工确认。

这些项目对应 `todo/lan-web-optimization.md` 中尚未勾选的条目；代码侧 ACL、限流和请求体超时条目已经勾选完成。

## 建议的后续顺序

1. 按 [`docs/lan-acceptance-checklist.md`](lan-acceptance-checklist.md) 在真实手机/同网环境完成
   网络、登录、控制和 VPN 验收。
2. 配置侧已将 `rateLimitMaxEntries` 的下限设为 2（认证 API 同时维护来源与凭据 bucket），并将
   `config:null` 明确定义为“未注入配置”；通用 `TokenBucketLimiter` 仍可供单 bucket 的嵌入场景使用。
3. 自定义 hostname 的推送端点不做运行时 DNS 解析；若启用 `allowCustomPushEndpoints`，需在
   受信 relay 与出口防火墙/代理层固定解析并重复阻断内网目标，不能把静态校验当作 DNS
   rebinding 的充分防护。
4. 运行完整测试和静态检查后，再提交 Git commit；不要覆盖 `public/icon.svg` 的现有用户修改。

## 关键文件

- 配置与指纹：`src/config.js`
- 启动器：`src/launcher.js`
- HTTP 服务与请求体/限流：`src/server.js`
- ACL：`src/network-acl.js`
- 限流器：`src/rate-limit.js`
- TODO 清单：`todo/lan-web-optimization.md`
