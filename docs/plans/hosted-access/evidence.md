# 托管接入候选版：验收记录

## 2026-09-22 生产切换补充

用户在开发验收后明确授权“直接推送新版本、备份到工作区、部署服务器；跳过 PC 本地测试”。已推送并部署 `793af05`（网关 0.2.0），完整记录与备份校验值见 [运维记录](../../../product/server/hosted-access-operations.md)。下方为切换前的开发阶段记录，保留真实测试边界，不再代表“当前未上线”。

本轮额外通过：重新 typecheck、hosted 四组测试、构建产物启动/旧入口拒绝；推送钩子 smoke 25；生产 HTTPS 首页/后台及其 JS/CSS、旧 API/remote 拒绝、未认证 WSS 零业务数据；服务器内存读取管理员密钥后只读 API 验证成功（0 个账号）。用户续签证书生效，系统 CA 校验通过。

主模拟器已启动配对页并通过 Android 官方截图检查：标题、手动码输入、请求配对和扫码按钮可见，不再显示旧 admin 登录。截图 `output/dsh-hosted-deployed.png` 不含凭据；这不是扫码或完整聊天验收。

Android Studio API 34 独立 AVD：BackendNavigationTest 2 项通过（13.39s），新增显式启用的 ProductionEntryTest 1 项通过（10.29s），后者使用默认 OkHttp 信任链连接实际生产、验证健康及无效配对码可恢复，不含凭据、不调用 Agent。主 AVD emulator-5554 以 `adb install -r` 覆盖安装 0.2.0 并启动，未清应用数据。PC 只读确认用户安装于 D:\DSHLink\DSH Link 的版本为 0.4.0，未运行本地 PC 测试。

尚未完成：生产 PC 登录/手机审批配对与真实任务流（需用户 PC 操作）；扫码权限全流程；Windows/后台完整 GUI 验收；Linux 联合恢复演练；自动续期独立核验。这些未通过项没有被标记为通过。Windows 界面控制技能缺少启动模块，未绕过控制限制，手机验证使用 Android 官方 AVD/仪器测试。

## 开发阶段记录（切换前）

日期：2026-09-22。结论：候选功能已实现，隔离功能测试通过；**不能据此宣称已完成全部发布验收或已上线**。生产仍为旧认证，本轮未部署、重启生产服务、提交或推送 Git。原工作树已有变更，基线见 [baseline.md](baseline.md)。

## 交付范围

后台独立管理员密钥；用户访问密钥生成、查看、备注、永久禁用、重置与删除；PC 密钥登录、换电脑确认、手机管理；Android 输码/扫码、PC 确认配对；按账号/PC 隔离的自研 WSS 隧道；退出恢复与即时撤销；滚动 24h 受理请求计数。客户端使用系统 TLS 校验及操作系统加密存储，不再挂载旧连接串、密码/TOTP 入口。Claude Code 仅保留空白页。

版本组合：Gateway 0.2.0 / PC 0.4.0 / Android 0.2.0（versionCode 34）。这是同一协议组合，**新版客户端不能直接用于当前旧版生产网关**。发布顺序与服务器路径见 [运维和切换说明](../../../product/server/hosted-access-operations.md)。

## 自动化与真实验证

Windows、Node 24.14.1、Java 21、Android API 34。所有可变账号/令牌/证书均为临时合成数据；不记录其值。

| 边界 | 已执行结果 | 证据入口 |
|---|---|---|
| 实际 HTTP/WS + mock Agent | 管理员/用户/PC/手机权限域分离；配对与重放拒绝；45 次合法配对轮询；大于 8KiB 的正常请求；同 RPC 重试不重复计数；磁盘写入故障不谎报请求未受理 | gateway/test/hosted-access.ts |
| 两个真实 TunnelClient | 两用户目录与会话隔离、未认证及另一用户零业务推送；PC 退出恢复；手机退出原身份重新配对；解绑、改名、换 PC 取消/确认；禁用/重置/删除；重启撤销持久性；24h 可控时钟 | gateway/test/hosted-isolation.ts |
| 初始化与存储 | 首次初始化、幂等、配置备份；加密文件无明文密钥；快照恢复；错误/缺失保护密钥拒绝启动 | gateway/test/hosted-provision.ts |
| 编译后生产入口 | 未初始化非零退出；初始化后启动并报告正确版本；管理页 HTTP 200；旧 auth、共享令牌入口、remote 为 410 | gateway/test/hosted-bundle.ts |
| TLS | 可信 IP 成功、未知 CA/错误 IP/过期证书拒绝、合法证书与私钥轮换成功 | gateway/test/hosted-tls.ts |
| DSH 隧道 authority | HTTP cookie/API 与 WS 均使用 PC 原始 authority，动态服务器端口不破坏认证 | gateway/test/dsh-authority.ts |
| 真实 DSH/Codex，只读 | 经临时新版网关和真实 PC 隧道读到 DSH 5 工作区/11 模型/25 历史项，Codex 6 工作区/5 模型/20 历史项；权限档非空；计数 0 | gateway/test/hosted-live-readonly.ts |
| Windows Electron 原生存储 | 实际 safeStorage 加密；磁盘不含访问密钥/设备令牌/设备秘密明文；重启身份保留；网络错误保留登录；明确 401 可恢复或退出 | pc/test/access-client.test.cjs |
| 独立 Android 模拟器 | 手动输入码、等待 PC 确认、保存加密授权、真实 HTTPS/WSS 到 mock Agent、发送/提问应答/计数/解绑失效；默认客户端拒绝未知 CA；DSH/Codex/Claude 导航及模型/权限控件 | Android HostedAccessTest + BackendNavigationTest：最后复跑 OK (3 tests)，22.946s |

Android 使用新增 `dsh_hosted_qa`（emulator-5556），没有清除、安装或操作用户的 `dsh_test`（emulator-5554）。AVD 数据在 `C:\Users\QH\.android\avd\dsh_hosted_qa.avd`，索引在 `D:\android-avd\dsh_hosted_qa.ini`。测试网关只监听回环地址；CA 仅经测试依赖注入，正式 App 无测试信任或用户可变服务器入口。

回归通过：网关 typecheck/build、smoke 25、tunnel-protocol 74、tunnel-e2e 28（含 32MiB 背压，测试 RSS 增量阈值 64MiB）、session-model、codex-offline；PC tunnel-client、协议、目录服务、DSH launcher/token、software-status、codex-open；Android 7 个 JVM 测试及 debug/test APK 构建。`bash -n` 安装/部署脚本、`git diff --check` 通过。

小型账号 fixture 加密快照观测为 1003 字节，不据此推断多用户高负载内存/吞吐。计数只保存时间和数量、不保存请求正文；流/轮询/审批不计数。写入失败显示“暂不可用”，不把已受理请求改报失败；故障标志在后续成功快照时持久化。持续磁盘故障后进程崩溃仍有计数不确定性，不保证异常存储下精确一次持久入账。

## 重现命令

在 `product/server/gateway`：

```powershell
npm run typecheck
npm run build
npm run test:hosted
npm run test:tls
node test/hosted-bundle.ts
npm run smoke
npm run tunnel-protocol
npm run tunnel
npm run session-model
npm run codex-offline
```

真实后端只读探针 `node test/hosted-live-readonly.ts` 要求本机既有 DSH/Codex 正常运行；它不发送模型请求，不应为了测试启动/重启用户 Agent。

模拟器联调用 `node test/android-fixture.ts` 启动本地临时 TLS 网关，其输出只有端口、PID 和公开测试 CA 路径。把公开 CA 文件 Base64 作为 `fixtureCA` 参数传给独立 AVD 的 `am instrument -w -e fixtureCA ... com.dshlink.app.test/androidx.test.runner.AndroidJUnitRunner`。每轮重启 fixture 以清零测试计数。PC 原生凭据测试以该 CA 路径设置 `DSH_FIXTURE_CA`，在 `product/pc` 运行 `node node_modules/electron/cli.js test/access-client.test.cjs`。结束调用同一 fixture 的 `/_fixture/stop`，以该 CA 正常校验 HTTPS；不使用生产凭据。

Android 构建命令：在 `product/android` 设置 `JAVA_HOME=D:\_Programmes\Java21` 后运行 `./gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest`。PC 在 `product/pc` 运行 `npm run dist`。

## 两路审查与修复

| 审查方向 | 发现的问题与修复 |
|---|---|
| 仓库规范 | 失效 PC 授权导致退出界面卡住→明确 401 清理；合法配对轮询误触匿名限速→已认证/持有配对 proof 单独额度；业务 WS 被初始认证 8KiB 限制截断→认证后独立 1MiB 限额。修复后复查未报告剩余发布关键代码缺陷。 |
| 开发规格 | 初次握手超时停止长期重连→UI 等待期限与隧道生命周期分离；Android 未认证连接可能排队请求→认证成功前拒绝业务 RPC；设备最近连接时间被 PC 轮询刷新→仅手机真实认证更新。复查未报告已审路径的具体剩余阻塞缺陷。 |

测试额外发现并修复：Node 原生 fetch 不保留 DSH Host authority，改为显式受限 HTTP 请求；DSH 首次 baseline 尚未同步时返回空工作区，改为等待或明确重试错误；Android 配对页 Surface/安全区恢复；安装更新在切换程序前检查托管配置与密钥，自签证书旧生成入口拒绝并指向可信 CA 运维流程。

## 验收差距与开放门槛

AC01–AC10 已有实现与上述不同层次的证据，但未声称每个 UI/竞态/逐 RPC 场景均已签收。AC11 部分通过，AC12 部分通过，AC13 联合环境演练未执行。各任务完整验收清单保留未签收状态。

1. **真实 DSH 完整任务流**：本轮只读真实后端；实际发送、流式、审批、提问、断网后续发及吊销时本地任务继续，需要专用测试工作区/会话验收。mock 成功不替代此项。
2. **桌面/后台 GUI 与扫码权限**：Windows 安装器及后台浏览器人工/自动化全链路、最小化配对续租、相机拒绝/扫码恢复未完成。现有 UI 技能依赖的启动模块缺失，未绕过其工具要求。模拟器截图被系统通知权限窗口遮挡，不能作为配对页视觉验收证据。
3. **TLS 自动续期**：2026-09-22 只读核验公网 HTTPS 系统 CA 验证成功，IP SAN 为 117.72.10.87，Let's Encrypt YR1，证书到期为 **2026-09-26 05:33:49 UTC**。实际自动续期及 Nginx 重载尚未验证，开放前必须验证。
4. **隔离 Linux 联合迁移/恢复**：已测试应用初始化、快照恢复和编译产物；尚未在具备 systemd/Nginx 的独立 Linux 环境演练代码、数据、配置、证书、站点联合切换与回退。只读检查发现本机有 Ubuntu-26.04 WSL/systemd，但无 Node/Nginx，也未发现 Docker 命令；本轮未改装该用户环境。运维步骤不是演练结果。需确认可写的隔离 Linux 测试目标或同意在该 WSL 安装测试依赖，不能把生产当作未经批准的演练机。
5. **Codex 既有能力限制**：Desktop 持有 writer 的原会话仍可能拒绝手机发送；保留明确提示与草稿，不 fork/抢锁冒充原会话。此次身份改造未扩大这一能力。
6. **最终发布**：Windows 包未签名、Android 为 debug 测试 APK；签名、下载站点发布及生产认证切换需要单独批准。上线前全部门槛通过，备份后一次性切换并重新配对，不兼容保留旧认证旁路。

## 候选文件及 SHA256

仓库中的构建文件不作为源码提交：

| 文件 | SHA256 |
|---|---|
| product/pc/dist/DSH Link Setup 0.4.0.exe | 5D59D8D89AF1A7555F0DBCE27EA2AB04FCBEA975F701C0B0F32F4A57A969867E |
| product/pc/dist/DSH Link 0.4.0.exe | BB9908998CA0604840C45FD62BE0BB988E4EEBFE962C19B65A7EFFFD7F85758F |
| product/android/app/build/outputs/apk/debug/app-debug.apk | 2E56B0877979D92BBE8AB806B186F3CBD60C768CEFDD0E7F4C777569CF8DF026 |

Windows 打包后的 main.js、access-client.js、tunnel/startup.js、renderer/app.js 与当前源码一致；包内未包含 frpc 可执行文件。

收尾：已停止本轮本地 TLS fixture（由其清理自身临时账号/证书目录）及独立 emulator-5556，保留 AVD 供复测。两个早期失败的合成 TLS 临时目录 `dsh-tls-pY8DeP`、`dsh-tls-zjw05p` 的删除被执行策略拒绝，未绕过；它们位于当前用户 Temp，不含生产秘密。
