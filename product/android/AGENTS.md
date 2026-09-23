# Android 端工作记忆

## 适用范围与优先级

本文件仅约束 `product/android/**`。开始 Android 任务前阅读它；跨端改动还必须阅读 [../README.md](../README.md) 的路由规则与“跨端绑定和连接契约”。不要根据 PC 或服务器的实现猜测 Android 行为。

## 当前实现

- 原生 Android：Kotlin、Jetpack Compose、单模块 `app`；包名 `com.batona.mobile`。
- 环境基线：`compileSdk` / `targetSdk` 34，`minSdk` 26，Java/Kotlin 17；版本号在 `app/build.gradle.kts` 中维护。
- 网络层使用 OkHttp：REST 登录和 WebSocket RPC 都集中在 `app/src/main/java/com/batona/mobile/data/GatewayClient.kt`。
- 底部导航固定为「DSH / Codex / Claude Code / 设置」：DSH、Codex 各自保留工作区树、当前会话、输入草稿、模型与待审批状态；模型选择位于各自聊天页内。Claude Code 仅为空白占位页，不初始化后端或复用 DSH/Codex 内容；设备管理页面及其自动列表请求已移除，绑定与认证保留。共享网关推送按已恢复/创建的网关会话 ID 路由到所属入口。Codex 的权限档、模型与状态都来自网关/PC 的能力查询，手机不构造底层 permission profile 或直连 Codex。
- 历史连接串与二维码解析在 `data/ConnectionParser.kt`；持久化设置与凭据在 `SettingsStore.kt`；数据模型在 `data/Models.kt`。
- UI 入口为 `MainActivity.kt` 与 `ui/App.kt`；手机配对使用 `ui/PairScreen.kt`，主页为 `ui/HomeScreen.kt`；旧 Bind/Login 页面不再由 App 挂载。

## 托管接入候选版

生产网关已于 2026-09-23 迁移到 Batona Gateway 0.3.1；手测 AVD `dsh_hosted_qa` 已覆盖安装 Batona Mobile 0.3.3（versionCode 39）并保留原有配对。手机不输入 admin 密码/TOTP，也不读取旧绑定资料；确认配对后写入新授权并清理旧缓存。普通断网/重启保留授权；明确失效才清除。退出需服务端撤销确认（或明确 401），网络错误保留状态；设备身份在退出后保留。TLS 使用系统 CA/身份校验。测试可注入专用 CA，正式 App 使用默认安全客户端，无用户可变入口。

2026-09-22 公网联调：独立 AVD 上 ProductionEntryTest 通过真实 HTTPS 健康检查、无效配对码拒绝及可重试；另有 2 项导航/控件测试通过。本轮用户要求跳过 PC 本地测试，完整生产配对/聊天需 PC 登录并人工批准后再验证。主 AVD 可覆盖安装，保留应用数据；禁止将仅入口通过记为完整聊天通过。

## 端内约束

- 连接串、配对二维码、认证字段、RPC 信封或事件名称以 `../README.md` 的跨端契约为准；不得只改客户端来“兼容”未定义的新字段。
- 托管版固定预设网关 117.72.10.87:443（非秘密）；账号/管理员密钥不进入手机。设备授权与设备身份使用 AndroidKeyStore 加密保存，关闭备份；敏感值不进入源码/日志。
- Android 只能连接网关的 HTTPS/WSS 入口，不能假设手机可访问 PC 的 `localhost:3080` 或服务器内部端口。
- Codex 仅发送文本请求；工具调用、结果与审批/提问由 PC 脱敏后经网关镜像。每个工作区默认显示最近 5 个会话，展开后才显示更早记录。
- Codex 手机镜像缓存仅保存最近 5 个会话/工作区和已脱敏的最近 200 条历史事件/会话；它只支持断网浏览、绝不排队发送，并由 `SettingsStore.clear()` 在注销或重新绑定时清除。
- Codex 原生任务以 Windows Codex 窗口为唯一写入面；实现发送、审批或同步前先读 [ADR 0003](../../docs/adr/0003-native-codex-window-control.md)。Android 用结构化只读数据展示历史，用原生界面代理的增量事件刷新运行中内容并执行输入和交互；代理不可用时保留草稿并显示失败，不能改投第二个 `app-server` 或引导用户改用官方手机端。
- Codex 聊天页的模型与思考强度分别选择，均调用 `model.select`；权限弹窗打开/关闭调用 `session.permissionMenu`，选择调用 `session.permissionSelect`，只在 PC 原生窗口确认后更新当前权限。发送未显式选择权限时沿用电脑端档位。
- 系统通知只允许“等待审批、等待回答、完成、失败”四种不带正文的状态。Android 13+ 必须取得通知权限；应用或 WebSocket 未运行时不能伪造后台推送。
- 保持 UI 状态与网络 I/O 分层：Composable 不直接持有网络连接或执行阻塞请求；断线、重连、审批/提问事件须经 `GatewayClient` 的既有模型处理。
- 修改 Manifest、网络安全配置、CameraX 扫码或权限时，要同时检查首次绑定与拒绝权限时的可恢复路径。

## 验证

在 `product/android/` 运行：

```powershell
.\gradlew.bat :app:assembleDebug
```

若改动了扫码、绑定、登录、WebSocket 或会话 UI，按下方的 **Android Studio 模拟器基线** 验证：首次配对与 PC 确认、断网重连、流式对话和审批/提问应答。Codex 还要验证三档权限、目录选取、缓存离线浏览、通知权限拒绝后的可恢复状态。构建产生的 APK 是发布物，不要把新的 APK、`build/`、`.gradle/` 或 IDE 状态作为源码提交。

## Android Studio 模拟器基线

- 手测机固定为 `dsh_hosted_qa`，保留用户的配对、登录和应用数据；隔离自动化固定使用 `dsh_test`。完成可供用户体验的 Android 改动后，主动运行 `tools/update-test-device.ps1`：它构建 Debug APK、按 AVD 名定位或启动手测机、执行 `adb install -r` 覆盖安装并打开 App。完成条件是脚本核验手测机中的 applicationId、versionName 和 versionCode。包名或签名变化会形成新的数据空间，须明确报告需要重新配对。
- 自动化测试 APK 和 `connectedDebugAndroidTest` 只在 `dsh_test` 上运行。不要把它们装入 `dsh_hosted_qa`，不要卸载或清空手测机 App；普通更新只用 `adb install -r`。
- 当前完整功能验收固定在 Android Studio Emulator 上进行；不要将真机开发者模式、USB 调试或物理相机作为验收前提。
- 用 Android Studio 打开 `product/android/`，选择模拟器并运行 Debug 变体。模拟器联网后应通过服务器的 HTTPS/WSS 公网入口联调，不应访问 PC 或服务器的回环地址。
- 配对页使用“输入电脑配对码 → 请求配对 → 电脑确认”路径；扫码单独验收，拒绝相机权限仍可输码。授权由服务器发给请求方，不由二维码携带。
- 模拟器验收覆盖：首次配对与 PC 确认、会话/工作区读取、新建会话、流式回复、审批与提问应答，以及关闭/恢复模拟器网络后的重连。完成条件是恢复网络后仍可继续发送消息。

## 产品 UI 与历史决策

### 会话列表与聊天视图

视觉参考为根目录 `output/mobile-ui-demo/mobile-overview-chat-v1.png`。工作区卡片与会话菜单由 `WorkspaceCard.kt` 渲染，展开状态保存在各后端的 `HomeState`；聊天采用独立滚动消息区、内嵌审批卡及固定模型/权限/输入区。`DesignUiTest` 与 `BackendNavigationTest` 用隔离数据覆盖菜单、历史展开、审批禁用与后端状态隔离，截图存于测试 App 的 external files；这些截图不是生产配对或模型调用证据。

聊天输入区右侧模型按钮显示恢复响应 `GatewaySession.model`，用同 provider/model 的目录名称补足显示名。进入另一会话先清空旧模型；未知值显示“模型未同步”。模型选择成功才更新按钮。回归覆盖打开已有会话、切换到未知模型会话及两后端隔离。

目标交互是两级视图：未选择会话时，工作区/会话列表占满主体；选择会话后，进入独立聊天视图，顶部持续显示“工作区 · 会话标题”，底部固定输入框，对话流独立滚动，返回按钮清除当前会话并回列表。不要继续维护“树和聊天上下并排、下半空白”的布局。

`currentId == null` 应是列表/聊天视图切换的唯一开关；选会话时记录工作区名与标题，恢复会话后拉取历史。若 UI 已切换但历史为空，先核查网关 `session.resume` 与 `session.history`，不要用 Compose 重组来掩盖协议或数据问题。

### 工作区 → 会话树

DSH 的权威关联是 `workspace.list` 返回的 `WorkspaceView.sessionIds`；`session.list` 本身不保证携带工作区归属。树形 UI 应按工作区展开/折叠、展示未分组会话，并使用“归档会话”而不是“删除会话”（DSH 没有硬删除）。

若实施完整树形改造，这是跨端任务：服务器要提供聚合的 `workspace.tree`（`workspace.list` 与 `session.list` 按 `sessionIds` join）并转发创建、删除工作区/归档会话等操作；Android 再在 `GatewayClient` 和主页状态中消费。先读 [../server/AGENTS.md](../server/AGENTS.md)，不要单端伪造工作区归属。

### 已解决的历史回放问题

列表、恢复和历史 RPC 失败必须区别于正常空列表：`GatewayFailure` 映射为安全错误提示，列表刷新失败保留旧树，恢复失败留在聊天页提供重试，发送失败保留草稿。不得用 `emptyList()` / `null` 吞掉这三条链路的失败。模拟器已登录时只做 `adb install -r` 覆盖安装；Gradle `connectedDebugAndroidTest` 默认可能在收尾卸载应用，真实绑定回归应使用独立测试 AVD，避免清掉用户登录数据。

历史消息为空曾有两个根因，二者都在网关而非 Compose：DSH `session.history` 的返回字段是 `events`，不是 `entries`；大量 `assistant/chunk` 原始事件会让 2GB 服务器的网关 OOM。当前约束是网关只回放受限、聚合后的历史（忽略重复 chunk，保留 user/assistant message 和工具调用/结果），systemd 的 Node 堆上限为 512MB。若问题复发，优先在服务器检查网关版本、`events` 映射、聚合/上限及 systemd，而不是修改 App 的历史渲染。

会话标题由 DSH `session/title` 事件产生，`session.list` 未必带标题；UI 必须保留 `title ?: sessionId` 的兜底。标题缺失时由网关缓存/历史提取修复，不能在客户端编造标题。

## 模拟器验收：DSH 提问

每次改动 WebSocket、会话状态或提问 UI，至少在模拟器验证一次：在会话中要求 agent 使用 `ask_user_question` 给出“方案 A / 方案 B”选择题，模拟器应显示提问卡片和选项，会话状态显示 `waiting-question` 黄点；选择后以 `respond` 回答，agent 继续执行，状态恢复为 done/idle。也应验证无选项的文本问题。

提问卡片不出现时按顺序检查：网关是否归一化 `question/requested`、App 是否收到推送并反序列化、响应是否携带原始请求 RPC id；查看服务器 `journalctl -u batona-gateway` 与 Android `logcat`，不要通过本地伪造状态点解决。

## 构建、安装与更新

用 Android Studio 打开 `product/android/`，完成 Gradle Sync 后在模拟器运行 Debug 变体；命令行构建使用本文件的 `assembleDebug`。版本号仅在 `app/build.gradle.kts` 的 `versionCode` / `versionName` 递增。模拟器重装后仍须回归首次配对、断网重连和真实会话流；Camera 权限拒绝仅在单独验证扫码 UI 时检查。
