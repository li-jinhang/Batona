# DeepSeek Harness 手机远程操控插件调查报告

> 调查日期：2026-08 · 需求：**在手机上随时随地远程操控笔记本电脑端的 DeepSeek Harness（DSH）**
> 用户条件：拥有服务器 + 服务器公网 IP
> 核实方式：逐一抓取各项目 GitHub README 原文（沙箱内 curl 直连 raw.githubusercontent.com 成功），
> 部分项目信息来自搜索引擎索引并经多个独立 awesome 列表交叉印证。

---

## 〇、背景（为什么需要插件）

- 官方 `dsh web` 只允许 loopback 绑定，**明确拒绝 `--host 0.0.0.0`**（官方理由：会把远程代码执行暴露到网络）。
  已在本机安装的 dsh CLI（`@deepseek-ai/dsh 0.1.1-rc.2`）实测确认，`dsh --profile web --help` 仅提供
  `--host / --port / --trusted-host / --no-open`。
- 官方 web 服务器文档（`docs/subsystems/web-server.md`）：webserver 自身无 TLS/认证，`dsh web` 默认 loopback，
  由 connection 插件提供 Host/Origin 校验 + 浏览器会话认证。
- 结论：**"手机远程操控" 完全由社区插件生态承担**，且已相当成熟（多个独立 awesome 列表收录 100+ 仓库）。

## 一、符合核心需求的开源项目（已核实 README）

### A. 开箱即用的远程方案（无需自己处理网络/证书）

| 项目 | 远程方式 | 手机端 | 特点 / 注意 |
|---|---|---|---|
| [liguobao/deepseek-harness-remote](https://github.com/liguobao/deepseek-harness-remote) | 双向端到端加密通道，**无需任何公网端口**，走作者托管中继 r2049.cn（GitHub/知乎扫码或账号登录） | Android App + Remote Web（iOS 可用浏览器）+ 桌面端 | 手机客户端最完整（含图片提问、审批应答）；**不支持自建中继**（作者明确）；依赖第三方服务；插件 0.4.0 兼容 DSH 0.1.1-rc.2 / 0.1.2-alpha.1 |
| [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) | 局域网（默认，扫码配对）+ 远程（Tailscale Funnel 或 cpolar 隧道）双模式，独立 HTTPS + 证书固定 | Android App 10+（WebView 薄壳）或手机浏览器 | 功能最全：一键诊断、自动重连、`/mobile` 对话定制手机端；`publicUrl` 可配；README 建议**不要对其局域网网关做端口转发**（证书固定，自定义反代会破坏配对）；远程组件目前支持 Windows x64 |
| [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | 局域网扫码 + 公网 cloudflared 隧道（随机 URL 每次重启变化），8 位密码 + 登录限速 | 手机浏览器扫码 | 单包零依赖、设置页一条龙；公网密码存 `$DSH_HOME/dsh-pocket/token`；适合图省事，公网 IP 用不上 |
| [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) 的 `@linxin666/dsh-remote-web-ui` | 扫码配对（一次性令牌）+ 独立 `/m/` 移动端界面（可装 PWA）+ PC 远程配对（`/remote` 通道）+ 一键 cloudflared 隧道 | 手机浏览器/PWA | 功能最细：姿态探测、模型目录配对、SSE 实时状态、一键更新全家桶；`dsh web --host 0.0.0.0` 或配 `publicBaseUrl` 即可用 |

### B. 能利用你"服务器 + 公网 IP"的方案（自托管最优解）

| 项目 | 原理 | 你的公网 IP 怎么用 | 注意 |
|---|---|---|---|
| [BotonJ/dsh-remote-link](https://github.com/BotonJ/dsh-remote-link) | 认证反代网关（QR/HMAC 配对 + HttpOnly cookie 会话 + 设备注册表 + 限速封禁），网关独立端口反代到 loopback DSH；自称"被认可的远程暴露方式" | 网关默认绑 `0.0.0.0:3081`，配 `publicUrl` 指向你的域名/公网地址；前端再挂 Caddy/Nginx TLS（它自身无 TLS，README 明说 v2 才上 TLS relay） | 需自备 TLS 层；有 `remote_qr`/`remote_devices` 聊天工具管理设备；零依赖单插件 |
| [wikdd/dsh-remote-access-web](https://github.com/wikkd/dsh-remote-access-web) | frp 反向隧道（frpc 驱动），改编自官方 `@deepseek-ai/dsh-remote-access`（MIT） | 你的服务器正好当 **frps 服务端**，笔记本 DSH 出站连入 | 配 `--trusted-host` + 官方 remote-auth 配对；官方对应包在仓库中未直接探测到，属社区再发布，需自行审阅源码 |
| [Auxin-zn/dsh-mobile-remote](https://github.com/Auxin-zn/dsh-mobile-remote) | Tailscale tailnet（`tailscale serve` 发布 3080 + DSH `trustedHosts` patch） | 不需要公网端口；Tailscale 免费账号即可 | 手机浏览器直接打开 `https://<机器>.ts.net`；DSH 的 `trustedHosts` 只是 DNS 防重绑栅栏，**不是认证** |
| [Hongtwenfive1226/DSH-Mobile-for-Android](https://github.com/Hongtwenfive1226/DSH-Mobile-for-Android) | Tailscale + 自写转发器（forwarder.mjs，Host 重写过信任栅栏）+ React Native App | 同上，仅绑 Tailscale IP | RN 客户端体验最好（审批弹窗、文件桥上/下载、思维链、对话中切换 Agent 模式）；需打 2 处 DSH node_modules 补丁（`npm update` 后要重打） |
| [hongshuxifan321/dsh-mobile-app](https://github.com/hongshuxifan321/dsh-mobile-app) | Android WebView 壳 + **PWA 通用客户端（iPhone/鸿蒙）**；服务器端需配套部署 `dsh-plugin-mobile-remote`（认证代理 + 隧道脚本） | 填你自己的固定域名/完整地址 + 账号密码（Keystore 加密存储） | 用户名密码认证（Basic Auth），密码自动携带；PWA 版密码仅存内存 |
| [Linjiangxian0203/dsh-remote-tunnel](https://github.com/Linjiangxian0203/dsh-remote-tunnel) | 方向相反：**DSH 跑在远程 Linux 服务器上**，本地浏览器经 SSH 隧道访问；SSH 隧道 + systemd + 端口注册表，支持多用户共享 | 服务器装 DSH 后用它管理；你的笔记本作客户端 | 客户端是本地浏览器/CLI，不是手机；可与其手机方案组合使用；安全细节好（全绑 127.0.0.1，不存密钥） |

### C. 局域网/受限场景方案（远程需自配前置）

| 项目 | 说明 |
|---|---|
| [hchao3335-maker/dsh-lan-gate](https://github.com/hchao3335-maker/dsh-lan-gate) | 内网网关 3088→3080，本机审批 + 设备令牌 + Cookie 绑定 + 限流；单文件零依赖。README 明确：**不要直接暴露公网**，上外网必须前置 Cloudflare Tunnel+Access 或 Caddy+Authelia |
| [icodesign/orbis](https://github.com/icodesign/orbis) | iOS 侧稀缺选项：iOS TestFlight beta（Android 开发中），插件 `@orbisapp/remote-dsh`，设备配对 + 端到端加密 + 多设备实时同步 |

### D. 方向不同 / 易混淆（排除）

- [ZSeven-W/dsh-android](https://github.com/ZSeven-W/dsh-android)：让 DSH 在会话里通过 adb 操控 Android 设备/模拟器——**方向相反**。
- [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)：DSH **整个跑在手机里**（嵌入式 Termux 运行时，App 名 DeepCode）——不是远程操控笔记本。
- [railgun0325/dsh-phone](https://github.com/kingselyjoe/awesome-dsh-list)：agent 跑在手机里（Magisk root）——方向相反。
- [Phant0Meow/dsh-meow-smooth](https://github.com/Phant0Meow/dsh-meow-smooth)：手机通知推送 + 手机端 UI 优化，非完整操控，可作补充。

### E. ⚠️ 谨慎对待

- npm 上被搜索引擎标记警告的包：`dsh-coding-remote-kit`、`@xiaosenho/dsh-plugin-remote-access`、`@captain1275/dsh-remote-web-ui`（疑似仿冒/低质，沙箱无法调 registry 验证内容）。
- 建议一律以 GitHub 仓库为准安装。

## 二、按你的场景推荐路线

你的条件是：**笔记本跑 DSH（NAT 后）+ 手机随时随地访问 + 有服务器公网 IP**。

| 路线 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **① 最省事** | 笔记本装 [deepseek-harness-remote](https://github.com/liguobao/deepseek-harness-remote) 0.4.0，账号登录，手机 Android App / Web 直接连 | 零网络配置、端到端加密、客户端最完整 | 依赖作者托管中继 r2049.cn；不支持自建中继；你的服务器 IP 用不上 |
| **② 最贴你条件（自托管）** | 笔记本装 [dsh-remote-link](https://github.com/BotonJ/dsh-remote-link)（网关 3081）+ 笔记本→服务器的出站隧道（frp / SSH -R / WireGuard，因笔记本在 NAT 后）+ 服务器 Caddy 自动 HTTPS（你自己的域名 → 服务器公网 IP）→ 手机浏览器扫码配对 | 全部自有设施、无第三方依赖、无带宽限制、设备管理完善 | 需要自己搭隧道 + TLS；有网络工程成本 |
| **③ 平衡方案** | 笔记本装 [dsh-mobile](https://github.com/saya-ch/dsh-mobile) 0.3.1：局域网扫码 + 出门用 cpolar（国内稳）/ Tailscale Funnel | 功能最全、有原生 App、证书固定+配对 | 远程走第三方隧道（免费额度带宽受限：cpolar 1 Mbps） |
| **④ Tailscale 全家桶** | 笔记本 + 手机装 Tailscale（同账号），用 [dsh-mobile-remote](https://github.com/Auxin-zn/dsh-mobile-remote)（浏览器）或 [DSH-Mobile-for-Android](https://github.com/Hongtwenfive1226/DSH-Mobile-for-Android)（RN App） | 无公网暴露、WireGuard 端到端加密、App 体验好 | 需装 Tailscale；手机端体验依赖自写客户端成熟度 |
| **⑤ 服务器跑 DSH（备选）** | DSH 装服务器 + [dsh-remote-tunnel](https://github.com/Linjiangxian0203/dsh-remote-tunnel) 管理，手机再配 dsh-mobile 等 | 服务器 7×24 在线 | 与"笔记本端"需求不符，仅备选 |

## 三、安全红线（所有方案必读）

1. **DSH 能在宿主机上执行任意代码**——公网暴露 = 把 RCE 暴露出去。官方拒绝 `--host 0.0.0.0` 即此原因。
   社区有 [9.8 分 RCE 报道](https://agent.csdn.net/6a8d08f4662f9a54cba02b6a.html) 与 [插件模型第三方安全审计](https://github.com/deepseek-ai/deepseek-harness/discussions/454)。
2. 必须做到：HTTPS（自己的证书或插件证书固定）、强配对/强密码、登录限速、**防火墙只放行你的常用 IP**、
   不用时关闭远程开关、定期检查并吊销设备、服务器上不用 root 跑 DSH。
3. `trustedHosts`（`--trusted-host`）只是 DNS 防重绑栅栏，**不是认证**——认证必须由配对/网关层完成。
4. 有公网 IP = 会持续被互联网扫描；入口越隐蔽越好（隧道随机 URL / Tailscale 私有网络 / 防火墙白名单）。

## 四、版本兼容性（重要）

| 插件 | 兼容 DSH 版本 |
|---|---|
| dsh-mobile 0.3.1 | 0.1.0-rc.5 ~ 0.1.2-alpha.1（本机缓存 0.1.1-rc.2 ✅） |
| deepseek-harness-remote 0.4.0 | dsh-v0.1.1-rc.2 / v0.1.2-alpha.1（本机 ✅） |
| dsh-mobile-apk 0.13.0 | 自嵌运行时（与笔记本版本无关，方向不同） |

升级 DSH 后遇兼容提示，先升级对应插件；dsh-mobile 0.1.3 及更早的旧 App 需卸载重装并重新配对。

## 五、更多项目去哪里找

- [wgd753/awesome-dsh-plugin](https://github.com/wgd753/awesome-dsh-plugin)：每日自动抓取 `topic:dsh-plugin`，双语 + JSON/CSV
- [Dominic789654/awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness)、[NoWint/Oh-My-DSH](https://github.com/NoWint/Oh-My-DSH)、[kingselyjoe/awesome-dsh-list](https://github.com/kingselyjoe/awesome-dsh-list)（按 star 排序）
- [awesome-dsh-plugin/dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin)：会话内实时搜索 dsh-plugin 主题
- 中文社区文章：[什么值得买 Tailscale 路线对比](https://post.smzdm.com/p/anvq25nv/)、[53ai DSH 手机版报道](https://www.53ai.com/news/OpenSourceLLM/2026081848732.html)

## 六、核实限制

- 沙箱拦截 GitHub API / 部分 raw 直连，个别仓库（BotonJ/dsh-remote-link 的 main 分支等）以 master 分支或搜索索引内容为准；
- star 数、最近提交时间、实际可用性未逐一核实；npm 上带 ⚠️ 标记的包未验证内容；
- 安装部署前请以各仓库 README / Releases 最新版本为准。
