# Android 端工作记忆

## 适用范围与优先级

本文件仅约束 `product/android/**`。开始 Android 任务前阅读它；跨端改动还必须阅读 [../README.md](../README.md) 的路由规则与“跨端绑定和连接契约”。不要根据 PC 或服务器的实现猜测 Android 行为。

## 当前实现

- 原生 Android：Kotlin、Jetpack Compose、单模块 `app`；包名 `com.dshlink.app`。
- 环境基线：`compileSdk` / `targetSdk` 34，`minSdk` 26，Java/Kotlin 17；版本号在 `app/build.gradle.kts` 中维护。
- 网络层使用 OkHttp：REST 登录和 WebSocket RPC 都集中在 `app/src/main/java/com/dshlink/app/data/GatewayClient.kt`。
- 连接串与二维码解析在 `data/ConnectionParser.kt`；持久化设置与凭据在 `SettingsStore.kt`；数据模型在 `data/Models.kt`。
- UI 入口为 `MainActivity.kt` 与 `ui/App.kt`；绑定、登录、主页分别位于 `ui/BindScreen.kt`、`ui/LoginScreen.kt`、`ui/HomeScreen.kt`。

## 端内约束

- 连接串、配对二维码、认证字段、RPC 信封或事件名称以 `../README.md` 的跨端契约为准；不得只改客户端来“兼容”未定义的新字段。
- 不在客户端硬编码网关地址、账号、密码、TOTP 秘钥、设备令牌或 PC 的 DSH launch token；敏感值应走现有绑定/安全存储流程，并避免写入日志。
- Android 只能连接网关的 HTTPS/WSS 入口，不能假设手机可访问 PC 的 `localhost:3080` 或服务器内部端口。
- 保持 UI 状态与网络 I/O 分层：Composable 不直接持有网络连接或执行阻塞请求；断线、重连、审批/提问事件须经 `GatewayClient` 的既有模型处理。
- 修改 Manifest、网络安全配置、CameraX 扫码或权限时，要同时检查首次绑定与拒绝权限时的可恢复路径。

## 验证

在 `product/android/` 运行：

```powershell
.\gradlew.bat :app:assembleDebug
```

若改动了扫码、绑定、登录、WebSocket 或会话 UI，按下方的 **Android Studio 模拟器基线** 验证：首次绑定、TOTP 登录、断网重连、流式对话和审批/提问应答。构建产生的 APK 是发布物，不要把新的 APK、`build/`、`.gradle/` 或 IDE 状态作为源码提交。

## Android Studio 模拟器基线

- 当前完整功能验收固定在 Android Studio Emulator 上进行；不要将真机开发者模式、USB 调试或物理相机作为验收前提。
- 用 Android Studio 打开 `product/android/`，选择模拟器并运行 Debug 变体。模拟器联网后应通过服务器的 HTTPS/WSS 公网入口联调，不应访问 PC 或服务器的回环地址。
- 绑定页使用“粘贴连接串 → 解析并绑定”路径；扫码是独立的相机 UI 验收，不阻塞模拟器端到端测试。连接串只通过受控渠道输入模拟器，绝不硬编码、提交、输出到日志或发送到聊天。
- 模拟器验收覆盖：首次绑定和 TOTP、会话/工作区读取、新建会话、流式回复、审批与提问应答，以及关闭/恢复模拟器网络后的重连。完成条件是恢复网络后仍可继续发送消息。

## 产品 UI 与历史决策

### 会话列表与聊天视图

目标交互是两级视图：未选择会话时，工作区/会话列表占满主体；选择会话后，进入独立聊天视图，顶部持续显示“工作区 · 会话标题”，底部固定输入框，对话流独立滚动，返回按钮清除当前会话并回列表。不要继续维护“树和聊天上下并排、下半空白”的布局。

`currentId == null` 应是列表/聊天视图切换的唯一开关；选会话时记录工作区名与标题，恢复会话后拉取历史。若 UI 已切换但历史为空，先核查网关 `session.resume` 与 `session.history`，不要用 Compose 重组来掩盖协议或数据问题。

### 工作区 → 会话树

DSH 的权威关联是 `workspace.list` 返回的 `WorkspaceView.sessionIds`；`session.list` 本身不保证携带工作区归属。树形 UI 应按工作区展开/折叠、展示未分组会话，并使用“归档会话”而不是“删除会话”（DSH 没有硬删除）。

若实施完整树形改造，这是跨端任务：服务器要提供聚合的 `workspace.tree`（`workspace.list` 与 `session.list` 按 `sessionIds` join）并转发创建、删除工作区/归档会话等操作；Android 再在 `GatewayClient` 和主页状态中消费。先读 [../server/AGENTS.md](../server/AGENTS.md)，不要单端伪造工作区归属。

### 已解决的历史回放问题

历史消息为空曾有两个根因，二者都在网关而非 Compose：DSH `session.history` 的返回字段是 `events`，不是 `entries`；大量 `assistant/chunk` 原始事件会让 2GB 服务器的网关 OOM。当前约束是网关只回放受限、聚合后的历史（忽略重复 chunk，保留 user/assistant message 和工具调用/结果），systemd 的 Node 堆上限为 512MB。若问题复发，优先在服务器检查网关版本、`events` 映射、聚合/上限及 systemd，而不是修改 App 的历史渲染。

会话标题由 DSH `session/title` 事件产生，`session.list` 未必带标题；UI 必须保留 `title ?: sessionId` 的兜底。标题缺失时由网关缓存/历史提取修复，不能在客户端编造标题。

## 模拟器验收：DSH 提问

每次改动 WebSocket、会话状态或提问 UI，至少在模拟器验证一次：在会话中要求 agent 使用 `ask_user_question` 给出“方案 A / 方案 B”选择题，模拟器应显示提问卡片和选项，会话状态显示 `waiting-question` 黄点；选择后以 `respond` 回答，agent 继续执行，状态恢复为 done/idle。也应验证无选项的文本问题。

提问卡片不出现时按顺序检查：网关是否归一化 `question/requested`、App 是否收到推送并反序列化、响应是否携带原始请求 RPC id；查看服务器 `journalctl -u dsh-gateway` 与 Android `logcat`，不要通过本地伪造状态点解决。

## 构建、安装与更新

用 Android Studio 打开 `product/android/`，完成 Gradle Sync 后在模拟器运行 Debug 变体；命令行构建使用本文件的 `assembleDebug`。版本号仅在 `app/build.gradle.kts` 的 `versionCode` / `versionName` 递增。模拟器重装后仍须回归首次绑定、TOTP、断网重连和真实会话流；Camera 权限拒绝仅在单独验证扫码 UI 时检查。
