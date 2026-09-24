# Batona iOS PWA 扩展方案与平台能力核验

> 研究日期：2026-09-24
> 范围：核验 iOS/iPadOS Safari 与主屏幕 Web App 的安装形态、Web Push、离线缓存/本地存储、后台生命周期和安装引导，并结合仓库当前实现给出扩展方案。仅作架构分析，不修改客户端、网关或部署配置。

> **当前决策提示（2026-09-24）：** 本文保留平台能力与原始架构调研；实际实施范围以同目录的 `implementation-spec.md` 为准。已采纳的方案将 PWA 静态文件发布到 DSH Link 同源路径 `/projects/dsh-link/pwa/`，首发包含 Web Push，离线仅缓存应用外壳。本文早先对 Gateway 静态托管路径、Codex 离线历史镜像和推送分阶段上线的建议已由实现规格取代。

## 结论摘要

- iOS/iPadOS 可把网站加入主屏幕并以独立、无浏览器工具栏的 Web App 形态打开；Safari 当前操作路径为“分享 → 添加到主屏幕 → 打开为 Web App → 添加”。自 iOS/iPadOS 26 起，Safari 将主屏幕项目默认作为 Web App 打开，即使网站没有 Web App Manifest；用户仍可关闭“打开为 Web App”改为书签。[Apple《在 iPhone 上将网站变成 App》](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27)；[WebKit：Safari 26 新功能](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- Service Worker 与 Cache API 可以缓存应用外壳及已选资源，使它们在离线时加载；它们不能让未缓存的服务器端功能离线可用。缓存和 IndexedDB 属于受 WebKit 管理的站点存储，默认是 best-effort：存储压力、总体配额或长期未交互可能触发回收。持久化请求由 WebKit 启发式决定，不是无限期保留保证。[WebKit：存储策略更新](https://webkit.org/blog/14403/updates-to-storage-policy/)；[W3C Service Workers](https://www.w3.org/TR/service-workers/)
- Web Push 在 iOS/iPadOS 16.4 起向已添加至主屏幕的 Web App 开放；从 Safari 普通标签页请求不到该能力。订阅必须由用户手势触发且需要通知授权。传统 Web Push 依赖 Service Worker 并要求每条推送展示用户可见通知。使用 APNs 的 Web Push 不要求加入 Apple Developer Program。[WebKit：iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)；[Apple：发送 Web Push 通知](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers?language=objc)
- iOS 会在页面失活时节流或暂停网页；WebKit 明确说明 iOS 标签页在可能时会完全挂起。Service Worker 也是事件驱动的短生命周期上下文，规范允许浏览器在没有待处理事件时终止它。因此，后台长期运行的页面 JavaScript 或 WebSocket 不能作为平台保证。[WebKit：网页如何影响耗电](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/)；[W3C Service Workers 生命周期](https://www.w3.org/TR/service-workers/#service-worker-lifetime)
- Safari 不提供可由网页脚本调用的安装弹窗流程；iOS 安装由用户在 Safari 分享菜单中手动完成。Apple 当前支持文档仍给出这一路径。WebKit 对 `beforeinstallprompt` 的功能请求记录了 Safari 没有自动或站点触发安装提示，且该 API 未得到实现。[Apple 支持操作步骤](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27)；[WebKit 功能请求 193959](https://bugs.webkit.org/show_bug.cgi?id=193959)

## 1. 主屏幕安装与 standalone 形态

| 平台版本 | 官方资料确认的行为 |
| --- | --- |
| iOS/iPadOS 18 及之前版本 | 添加到主屏幕后，带有 Web App Manifest `display: "standalone"` / `"fullscreen"` 或旧式 app-capable meta 标记的网站按 Home Screen Web App 打开；没有相应标记时可只是书签并在默认浏览器打开。[WebKit 2023](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) |
| iOS/iPadOS 26 及之后版本 | 主屏幕添加流程默认启用“打开为 Web App”，任何网站都可按 Web App 打开；用户可关闭该选项创建打开于默认浏览器的书签。Manifest 仍用于声明名称、图标、启动 URL、范围等配置；Service Worker 可增强离线体验，但不再是获得 app-like 打开方式的条件。[WebKit Safari 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) |
| 当前 Apple 支持指南（iOS 27 页面） | Safari → 页面菜单/分享 → 添加到主屏幕；若未显示该动作，可在“编辑操作”中启用；开启“打开为 Web App”后添加，主屏幕图标会像 App 一样打开。[Apple 支持](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27) |

Safari 16.4 起，具备相应 iOS entitlement 的第三方浏览器也可把 Add to Home Screen 放进系统分享菜单；这要求浏览器应用自行集成，不能假设所有浏览器或内嵌浏览器均提供同一入口。[WebKit：iOS/iPadOS Web Push 与主屏幕 Web App](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)；[Apple WWDC23：What’s new in web apps](https://developer.apple.com/videos/play/wwdc2023/10120/)

主屏幕 Web App 的站点存储与 Safari 浏览器上下文分开。Safari 标签页中的 Cookie、localStorage 等登录或应用状态不能默认视为会出现在主屏幕 Web App 中；需在目标 iOS 版本上实测登录流程和深链行为。[Apple WWDC23](https://developer.apple.com/videos/play/wwdc2023/10120/)

## 2. Web Push 与系统通知

- **可用版本和安装前提：** iOS/iPadOS 16.4 起，Web Push 支持范围是已添加至主屏幕的 Home Screen Web App；普通 Safari 页面不具备这一入口。用户必须从 Web App 中执行直接手势（例如点按“启用通知”按钮）来触发订阅/权限申请。[WebKit 2023](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- **传统 Web Push：** 使用 Push API、Notifications API 和 Service Worker；通知权限由用户明确授权，且 iOS 设置中可按 Web App 管理。WebKit 要求订阅声明 `userVisibleOnly: true`，并要求处理推送时展示可见通知；静默推送不受支持，未履行可见通知承诺可能导致订阅被撤销。[WebKit：Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)；[Apple Developer 文档](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers?language=objc)
- **开发者账号：** Apple 明确说明此标准 Web Push 使用 APNs，但发送 Web Push 不要求加入 Apple Developer Program。若服务器有出站域名限制，需允许 `*.push.apple.com`。[WebKit 2023](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- **较新选项：** Declarative Web Push 于 iOS/iPadOS 18.4 面向主屏幕 Web App 提供，可让规范格式的通知无需 Service Worker JavaScript 也能展示；18.4 之前的兼容路径仍是传统 Service Worker Web Push。它解决通知显示路径，不改变必须主屏幕安装、由用户授权等基本前提。[WebKit：Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)；[WebKit：Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)

## 3. 离线缓存与站点数据

Service Worker 的 fetch 处理和 Cache API 可为网络请求返回缓存响应，使已缓存的网页与资源在离线时加载。IndexedDB 可存结构化站点数据。是否离线可用取决于应用实际预缓存/运行时缓存了哪些 URL；Service Worker 不会自动下载或永久保留整站内容，也不会让未缓存的 API、实时会话或远端操作离线工作。[W3C Service Workers：离线应用设计](https://www.w3.org/TR/service-workers/#motivations)；[WebKit：存储策略更新](https://webkit.org/blog/14403/updates-to-storage-policy/)

### 配额与回收

- WebKit 将 Cache API、IndexedDB、Service Worker 注册及其他脚本可写存储纳入站点存储策略。Safari 17 / iOS 17 起，单个 origin 的容量上限和所有 origin 的总容量上限按设备磁盘空间计算；Home Screen Web App 使用与浏览器 App 相同的 quota 档位。文档给出的额度是“最高可达”值，不是应用可以预留或获得的固定容量；可用额度还会随实际用量、访问频率等因素变化。[WebKit：存储策略更新](https://webkit.org/blog/14403/updates-to-storage-policy/)
- 达到 origin quota 时写入可能以 `QuotaExceededError` 失败。总体配额超限、系统存储压力或 ITP 所述长期未交互等条件可能触发按 origin 的数据回收，且可能删除该 origin 的整组数据。默认存储为 best-effort，持久性不保证。[WebKit：存储策略更新](https://webkit.org/blog/14403/updates-to-storage-policy/)
- Safari 17 / iOS 17 起完整支持 Storage API。应用可用 `navigator.storage.estimate()` 查看估算用量和 quota，并用 `navigator.storage.persisted()` 查询状态、`navigator.storage.persist()` 申请 persistent mode。WebKit 说明是否批准由启发式决定，例如是否作为主屏幕 Web App 打开；批准可让 origin 免于常规自动回收，但不是备份，也不阻止用户主动清理。[WebKit：存储策略更新](https://webkit.org/blog/14403/updates-to-storage-policy/)
- **关于“七天清理”的版本界限：** WebKit 在 2020 年解释，ITP 对 Safari 中的脚本可写存储采用“连续七天 Safari 使用且该站点未发生用户交互后删除”的策略；其当时说明主屏幕 Web App 有独立的使用计数器，第一方 Web App 数据不预期因此被删除。该文章描述的是 iOS/iPadOS 13.4 / Safari 13.1 的当时政策；2023 年较新的存储政策改为概述“长期未交互”等回收条件，没有承诺所有当前系统均以同一个七天期限处理。因此不应把七天当作当前主屏幕 Web App 的固定保留期或固定清除期。[WebKit：2020 ITP 存储政策](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)；[WebKit：2023 存储策略更新](https://webkit.org/blog/14403/updates-to-storage-policy/)

**平台含义：** 缓存可以显著减少重复下载并支持部分离线启动，但必须能在缓存被清除/回收后从服务器重建；重要用户数据不应只存在于 Cache API 或 IndexedDB。此为上述配额与回收规则的工程含义。

## 4. 后台页面、Service Worker 与 WebSocket

- WebKit 对失活网页的省电策略包括停止 `requestAnimationFrame`、暂停 CSS/SVG 动画、节流计时器；iOS 标签页“在可能时完全挂起”。该资料没有规定切入后台后 WebSocket 可保持多久，也没有给 Home Screen Web App 持续后台执行的时限承诺。[WebKit：网页如何影响耗电](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/)
- Service Worker 是事件驱动的 worker，不是常驻进程。W3C 规范规定其生命期跟随事件处理；浏览器在没有待处理事件时可以终止 worker。`event.waitUntil()` 只延长当前事件处理的生命期，不是后台 keep-alive API。[W3C Service Workers §2.1.1、§4.4.1](https://www.w3.org/TR/service-workers/#service-worker-lifetime)
- **工程推论：** 网络切换、页面挂起或应用被退出时，不能依赖现存 WebSocket 或前台 JavaScript 保持实时连通；前台恢复后应允许重连并从服务端校准状态。Web Push 可唤起 Service Worker 处理受限的、用户可见通知事件，不能替代静默的常驻计算或连续双向流。

## 5. 安装引导 API

Apple 当前给用户的安装步骤是 Safari 内手动操作“分享 → 添加到主屏幕 → 打开为 Web App → 添加”，操作菜单若缺失可通过“编辑操作”加回来。[Apple 支持](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27)

WebKit 没有实现网页可拦截/调用的 `beforeinstallprompt` 安装提示事件。该 WebKit 功能请求记载 Safari 没有自动或站点触发的安装弹窗；请求已关闭且未实现。[WebKit Bug 193959](https://bugs.webkit.org/show_bug.cgi?id=193959) 因而不能依靠网页内按钮直接弹出 iOS 系统“安装”确认框；应用可提供说明卡片或动图，指导用户执行 Safari 分享菜单路径。`beforeinstallprompt` 属非标准 API，MDN 仅作为其兼容性索引，不代表 W3C 安装标准。[MDN: BeforeInstallPromptEvent](https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent)

## 6. 来源与适用范围

| 来源 | 日期 / 适用范围 | 本文引用范围 |
| --- | --- | --- |
| [Apple iPhone 用户指南：将网站变成 App](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27) | 当前 iOS 27 指南，访问于 2026-09-24 | 最新 Safari 手动安装步骤 |
| [WebKit：Safari 27.0 新功能](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/) | 2026-09-17 | 当前 Safari 主版本；此版本说明未宣布本文所述安装/推送/存储规则变更 |
| [WebKit：Safari 26.0 新功能](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) | 2025-09-15，iOS/iPadOS 26 | 任意站点默认以主屏幕 Web App 打开 |
| [WebKit：iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) | 2023-02-16，iOS/iPadOS 16.4 | Home Screen Web App、Web Push 用户手势、APNs 与 Developer Program 要求 |
| [Apple WWDC23：What’s new in web apps](https://developer.apple.com/videos/play/wwdc2023/10120/) | 2023-06-06，演讲逐字稿 | iOS Home Screen Web App 独立存储上下文、manifest display、链接范围 |
| [WebKit：存储策略更新](https://webkit.org/blog/14403/updates-to-storage-policy/) | 2023-08-10，Safari 17 / iOS/iPadOS 17 起的策略 | quota、回收条件与 Storage API |
| [WebKit：Safari 18.4 新功能](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/) | 2025-03-31，iOS/iPadOS 18.4 | Declarative Web Push 发布版本 |
| [WebKit：网页如何影响耗电](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/) | 2019-03-25，WebKit 一般省电策略 | 页面失活时节流以及 iOS 页面挂起；不作为精确后台超时承诺 |
| [W3C Service Workers](https://www.w3.org/TR/service-workers/) | 2026-09-17 Candidate Recommendation Draft | Service Worker 是事件驱动且可被终止；规范版本为工作草案 |

## 7. Batona 项目适配评估

### 7.1 判断

**建议将 iOS 客户端做成同源路径下的主屏幕 PWA。** 现有服务器、PC 隧道、账户/设备授权和手机 RPC 已经构成合适的远程控制后端；核心会话功能不必另建 API 或把 Agent 搬到服务器。Safari 提供主屏幕独立窗口形态；标准 Web Push 可补上重要状态提醒，且不需要加入 Apple Developer Program。用户仍须先在 Safari 中手动添加到主屏幕。

这能覆盖前台打开应用时的会话操作、断线恢复和有限的离线查看。它不能保证 PWA 在后台持续运行 WebSocket，也不具备原生 Android 客户端使用 Android Keystore 的同等凭据隔离。产品目标宜定为“前台体验接近原生，后台通过系统推送提醒，离线只读”，不要承诺原生应用级后台常连或永久本地存储。后台页面挂起与 Service Worker 短生命周期的约束见前文及 [W3C Service Workers](https://www.w3.org/TR/service-workers/#service-worker-lifetime)。

### 7.2 仓库现状

- 跨端职责已符合 PWA 方案：手机调用网关；Agent、模型、工具和文件操作留在 PC；服务器做认证、会话路由和出站隧道。PWA 应继续遵守[三端架构与连接契约](../../../product/README.md)及[手机镜像、离线缓存和通知约束](../../../CONTEXT.md)。
- 当前 Android 手机端是 Kotlin/Jetpack Compose，HTTP 与 WSS 客户端在 [`GatewayClient.kt`](../../../product/android/app/src/main/java/com/batona/mobile/data/GatewayClient.kt)，绑定凭据和 Codex 离线投影在 [`SettingsStore.kt`](../../../product/android/app/src/main/java/com/batona/mobile/SettingsStore.kt)，凭据加密依赖 Android Keystore（[`DeviceSecrets.kt`](../../../product/android/app/src/main/java/com/batona/mobile/DeviceSecrets.kt)）。这些实现不能直接在浏览器运行；可以复用流程、协议语义和视觉规范，界面及浏览器网络层需要重写。
- 仓库中的 [`gateway/web/`](../../../product/server/gateway/web/index.html) 页面是早期 PWA 壳，不是当前 hosted 手机客户端。它使用 `/api/auth/login`、`localStorage` 令牌和 `/ws?token=...`；现行手机配对及 hosted WS 则使用 `/api/access/pair-request`、电脑确认、`pair-result` 证明领取，以及 WSS 首帧 `auth.hello` 令牌。早期页面还缺少 Service Worker，manifest 图标为空。
- 当前生产入口已停用旧 Web 手机入口：[`nginx-batona-gateway-routes.conf`](../../../product/server/nginx-batona-gateway-routes.conf) 将 `/remote/` 返回 410；Nginx 的 `/` 由另一站点项目提供。[`HostedGateway`](../../../product/server/gateway/src/hosted/gateway.ts) 只提供 `/access-admin` 静态页和 hosted API，其他 HTTP 路径走 410。因此旧页面不能靠打开 `/remote/` 变成可用 PWA，发布需要明确增加新的静态资源路由。
- 当前 Android 的限量离线数据契约是 Codex 镜像：每工作区最近 5 个会话、每会话最近 200 条已脱敏事件；断网只浏览、不排队，退出或重新绑定时清理镜像。PWA 建议先保持相同范围，不自行把完整历史或 DSH 数据复制到浏览器。
- 功能成熟度仍受 PC/网关能力约束。PWA 只会呈现 `auth.hello` 公布的后端能力；当前 Claude Code 仍为空白占位，Codex 原生桌面会话的运行中交互/审批同步也有未完成项。换客户端不会补齐这些后端缺口。

### 7.3 推荐拓扑与部署

```text
iPhone 主屏幕 PWA（https://<现有主机>/mobile/）
  ├─ 静态页面、manifest、Service Worker、图标：同源 /mobile/*
  ├─ 配对、注销等：HTTPS POST /api/access/*
  └─ 手机业务：WSS /ws，首帧 auth.hello
                       │
                       ▼
             Batona Gateway ── WSS 出站隧道 ── Batona PC / Agent
                       │
                       └─ 后续阶段：状态事件 → 标准 Web Push → APNs
```

推荐把 PWA 静态产物放在 `product/server/gateway/web/mobile/`，由 hosted 网关通过明确的静态文件白名单提供，并在 Nginx 路由中增加 `/mobile/` 到 `127.0.0.1:3090` 的同源代理。`start_url` 与 `scope` 设为 `/mobile/`，Service Worker 也放在该子路径；`/api/*` 和 `/ws` 仍使用现有入口。这样 PWA、协议及其静态文件随同一网关版本部署，避免依赖另一个首页仓库的发布。实现时须避免把静态路径误送入当前 410 fallback，并分别配置缓存头：指纹化 JS/CSS/图标可长期缓存，入口 HTML、manifest 和 Service Worker 应可快速重新验证，认证和 API 始终 `no-store`。

选择同主机路径还有协议原因：当前 hosted REST 会拒绝与请求 Host 不同的浏览器 Origin；放到独立子域名需另外设计允许 Origin/CORS 与 WebSocket 来源校验。使用 `/mobile/` 同源可直接沿用目前 HTTPS/WSS 和认证边界。当前 Nginx 根路径归首页站点所有，不能只把文件放进 Gateway 仓库而不加网关静态处理和 Nginx 路由。

### 7.4 复用边界与前端范围

| 可复用 | 需要新增或重写 |
| --- | --- |
| `/api/access/*` 配对/注销语义、手机设备授权、`/ws` 四象限消息协议、会话和事件模型、能力门控、PC 脱敏事件、后端限量缓存规则 | HTML/CSS/交互组件、路由和前端状态管理、浏览器 `fetch`/`WebSocket` RPC 客户端、断线重连、IndexedDB 持久层、Service Worker、manifest/图标、PWA 安装说明、Web Push 注册与通知处理 |
| Android 已定的页面流程和产品文案/品牌规范 | Compose UI、Android Keystore、DataStore、OkHttp、Android 通知代码不能直接复用；旧版 `gateway/web/app.js` 的用户名/TOTP/查询参数令牌不适用于 hosted 版 |

前端建议用 TypeScript 实现一个轻量的移动 Web 客户端，把认证、RPC、会话状态、缓存、渲染分层。是否采用 UI 框架可按仓库依赖偏好决定；关键是不要把 RPC 发送藏在视图组件里，并以 `auth.hello.adapters` 与 profile/capability 响应决定可见操作。第一版覆盖配对、DSH/Codex 导航、会话列表/恢复/创建、流式事件、审批/提问、取消、工作区与模型/权限；未知或后端未支持的动作应明确禁用。

### 7.5 配对、凭据和设备名额

PWA 按当前 Android 流程接入：用户输入电脑配对码；浏览器生成并持久化设备秘密；向 `/api/access/pair-request` 提交码和设备秘密；使用临时 `requestId`/`proof` 轮询 `/api/access/pair-result`；电脑确认后收到手机设备令牌，令牌只经 WSS 首个 `auth.hello` 帧提交。浏览器 WebSocket 不应把令牌放入 URL。审批/提问应答仍经 RPC 返回，不能通过通知动作直接授权。

**引导顺序必须是先添加到主屏幕，再配对。** iOS 主屏幕 Web App 与 Safari 浏览上下文的 Cookie、localStorage 等存储分离；Safari 标签页里生成的设备秘密/令牌不会自动成为主屏幕 App 的同一份状态。[Apple WWDC23 对独立存储上下文的说明](https://developer.apple.com/videos/play/wwdc2023/10120/)。若先在 Safari 页面配对，之后安装的 PWA 会像另一台设备一样开始配对，可能撞上当前“一账号一部手机”的名额。安装引导页要明确写出“添加到主屏幕后再配对”。

现行契约每账号暂限一台 PC 与一部手机；iOS PWA 会占用这一个手机名额。已有 Android 手机不能在同一账号下与 iOS PWA 并行绑定；更换时须先由 PC 解绑 Android 再给 PWA 配对。若产品目标是同一账号同时保留 Android 与 iPhone 两部手机，应先扩展账号设备槽位、配对流程、订阅/吊销规则和测试，不属于只增加一个网页客户端的工作。

Android 用 Keystore 包装并保存手机设备秘密与令牌；浏览器没有等价的硬件 Keychain 接口。建议将短小的设备秘密、授权令牌放在该 PWA origin 的 IndexedDB，不放在 URL、Service Worker Cache、日志或普通 `localStorage`；为静态内容上严格 CSP、少用第三方脚本，并对会话富文本做安全渲染。IndexedDB 同源脚本仍可访问，不能宣称达到 Android Keystore 的隔离等级。浏览器站点数据也可能被系统回收或用户清除；PWA 应能提示重新登录/配对。设备秘密一旦丢失而服务器仍保留旧手机槽位，须按现有 PC 解绑流程恢复，不能以相同设备名冒充原设备。WebKit 允许用 `navigator.storage.persist()` 申请持久模式，但是否批准由启发式决定，仍不等于备份或绝不丢失。[WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/)。

### 7.6 缓存和断网规则

| 内容 | 存储位置 | 策略 |
| --- | --- | --- |
| HTML 外壳、JS/CSS、字体、图标 | Service Worker Cache API | 首次联网安装后预缓存；按版本更新；提供离线入口页 |
| 最近会话的离线投影 | IndexedDB | 仅保存 PC 已脱敏、数量有上限的事件；按现有 Codex 镜像上限淘汰；显示最后同步时间 |
| 设备秘密和授权令牌 | IndexedDB | 与业务镜像分 store；普通退出撤销并清除授权令牌和镜像，但保留设备秘密以便同一 PWA 重新配对；更换设备身份时再重置秘密 |
| RPC、审批/提问答案、Agent 实时事件 | 不缓存、不队列 | 必须在线请求；断网禁用写操作；恢复后经 `session.list`、历史/快照重同步 |

Service Worker 仅对明确列出的同源静态资源采用 cache-first/预缓存策略；`/api/access/*`、`/ws` 和任何授权/动态 JSON 响应不进入离线缓存。对聊天历史只做有限只读镜像，写操作不得在重新联网时自动重放，以免重复提交或迟到审批。`navigator.storage.estimate()`、`persist()` 只作为诊断/尽力而为，代码仍需处理数据库缺失、写入失败、配额错误和整站存储被清理。

### 7.7 后台通知阶段

前台会话能力可以先上线，不以后台常驻连接为前提。若要接近当前 Android 的审批/提问/完成/失败提醒，再增加 Web Push 阶段：PWA 提供用户点击后触发的“启用通知”，注册 Service Worker 与 Push Subscription；网关为已配对手机安全保存 endpoint/密钥；PC 事件进入网关后，仅对等待审批、等待回答、完成、失败等有限状态发送可见通知。通知正文不含用户消息、命令、路径、工具参数或审批内容，点开后让 PWA 重连并从权威 PC 状态校准。

该阶段需要网关 Push Subscription API/吊销清理、VAPID 密钥生命周期、Web Push 加密发送、Apple push 服务出站连通、事件去重与失败清理，以及 iOS 主屏幕安装/授权后的实机验收。通知不是可靠的任务传输：后台不能连续消费 Agent 流；打开 PWA 后仍应重新连接 WSS 并拉取状态。iOS 16.4+ 可作为 Web Push 的最低平台门槛；当前 iOS 18.4+ 的 Declarative Web Push 可以评估为优化项，不宜作为唯一实现路径。[Apple Web Push 规范要求](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers?language=objc)。

### 7.8 建议交付顺序和验收点

1. **静态安装壳与同源路由：** 确认 PWA 发布 URL、Gateway 静态白名单、`/mobile/` Nginx 路由、manifest 名称/范围/启动 URL、`apple-touch-icon` 和完整图标，加入 Safari 分享菜单操作说明。Safari 安装由用户手动完成；不做 App Store、签名或原生壳。
2. **在线手机客户端：** 在已安装的主屏幕 PWA 中完成首次配对、电脑批准、WSS 首帧认证，以及当前已支持的主要工作区/会话/审批流程。确保网络切换后重连、错误不被伪装为空状态、未受理消息不会暗中排队。
3. **离线查看：** 缓存完整 app shell 与当前规定的 Codex 限量脱敏镜像；断网时显示缓存状态并禁止所有会改变 Agent 状态的控件。清除站点数据后仍能从配对流程恢复。
4. **Web Push：** 在首次前台流程稳定后单独实现和验收；确认从主屏幕 PWA 的用户手势订阅、通知权限拒绝、锁屏提醒、设备解绑/退出清理、通知点击后状态同步，以及推送端点失效恢复。
5. **上线门槛：** 在真实 iPhone Safari 和主屏幕 PWA 分别验证安装、存储隔离、扫码/手输码路径、虚拟键盘、安全区、网络断续、缓存清理与版本更新；如果声明支持通知，要覆盖 iOS 16.4+ 的支持基线和当前目标 iOS。服务端检查要验证正式 TLS 证书链与自动续期，并确认出站可访问 `*.push.apple.com`。仓库运维记录最近一次核验写明 IP 证书截至 2026-09-29 有效、自动续期尚未独立验证；发布前需重新核验此时状态（见[服务器运维边界](../../../product/server/AGENTS.md)）。

### 7.9 结论

PWA 是本项目拓展到 iPhone 的合理路线，能省掉 App Store 上架和 Apple Developer Program，也不要求单独开发 Swift 应用。它可以沿用现有 hosted 网关与手机控制协议，但需要一个新的浏览器客户端、受控静态托管路径、基于 IndexedDB 的本地状态，以及第二阶段的 Web Push 服务端链路。最大的产品边界不是屏幕 UI，而是 **iOS 不提供后台 WebSocket 常连保证、浏览器存储不是 Android Keychain、当前账号只给一部手机留名额**。按“安装优先、在线控制、限量离线只读、Web Push 提醒”的目标推进，可以获得可靠的类 App 前台体验；如果要求两部手机同时绑定或原生级后台持续控制，则须先扩大设备模型或改变技术路线。
