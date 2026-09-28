# Batona — 三端工程导航与共享契约

截至 2026-09-25，生产网关为 Batona Gateway 0.3.5（部署 commit `92417dd`）；本机运行 Batona PC 0.5.20，已复用 Codex Desktop 当前共享回环 WebSocket；PC 0.5.20 加入交接输出隔离、只读连接核验和现有共享连接复用，安装版与便携版已构建。测试 AVD `dsh_hosted_qa` 已覆盖安装 Batona Mobile 0.3.13。共享权限直接后台切换已构建并切换，手机及 Desktop 持有任务的下一轮执行仍待现场复测。生产发布、迁移与回退先读 [托管接入运维](server/hosted-access-operations.md)，验收记录见 [实施证据](../docs/plans/hosted-access/evidence.md)。

PC 0.5.6 源码含并行 Codex 测试 profile：在 `product/pc/` 执行 `npm run start:codex-test` 会创建独立 `%APPDATA%\Batona PC Codex Test`、监听 3181/3182，并跳过 DSH。首次登录需使用独立测试账号，保留常规实例的授权和隧道。

本次改名同时更新了 PC appId、Android applicationId、本地安全存储别名、配对 URI、账号密钥前缀和服务器运行标识。Batona PC 与 Batona Mobile 使用新的本地数据空间；2026-09-23 已完成服务器运行标识迁移并保留现有托管授权，迁移证据见运维记录。

Batona 让 Android 手机或 iPhone 上安装的 PWA 通过公网网关远程操控笔记本上的 DeepSeek Harness（DSH）或 Codex。
Agent、LLM 与工具执行始终留在 PC；服务器只提供认证、会话路由与 PC 出站隧道转发。用户主动订阅 iOS PWA 通知后，服务器还可向 Apple Push 发送不含正文或标识符的事件类别。

## 文档边界

`docs/` 只保留项目的外部研究和需求依据：

- [调查-DSH手机远程操控插件.md](docs/调查-DSH手机远程操控插件.md)
- [需求-Batona远程接入网关.md](docs/需求-Batona远程接入网关.md)

实现记忆、端内操作、发布、排错与历史决策不再放入 `docs/`：端内信息进入各目录的 `AGENTS.md`，本文件保留跨端架构、契约与联调规则。

## Coding Agent：按改动路径读取记忆

开始分析、修改或验证前，必须先按待改路径读取对应文件；不要把另一个端的约束当成当前端的事实。

| 待改路径 | 必读记忆 |
|---|---|
| `android/**` | [android/AGENTS.md](android/AGENTS.md) |
| `pc/**` | [pc/AGENTS.md](pc/AGENTS.md) |
| `server/**` | [server/AGENTS.md](server/AGENTS.md) |
| `docs/**` 或本文件 | 本文件及保留的调查/需求文件 |
| 同时涉及两端或三端 | 所有受影响端的 `AGENTS.md`，再读本文件的跨端契约 |

## 目录

| 范围 | 位置 | 工作入口 |
|---|---|---|
| Android 客户端 | [android/](android/) | [android/AGENTS.md](android/AGENTS.md) |
| Windows PC 客户端 | [pc/](pc/) | [pc/AGENTS.md](pc/AGENTS.md) |
| 网关与服务器部署 | [server/](server/) | [server/AGENTS.md](server/AGENTS.md) |
| 调查与需求依据 | [docs/](docs/) | [调查](docs/调查-DSH手机远程操控插件.md) · [需求](docs/需求-Batona远程接入网关.md) |

## 跨端架构与职责

```
Batona Mobile ── HTTPS / WSS ──▶ Batona Gateway ◀── WSS 隧道 ── Batona PC（本地 Agent）
```

| 端 | 负责 | 不负责 |
|---|---|---|
| Android | 绑定、登录、按后端分组的会话/工作区/模型 UI，消费网关 RPC | 直连 PC、保存 launch token、执行 Agent |
| PC | 启动本地 DSH、托管本地 Codex App Server 桥、安全保存 PC 授权、维持出站隧道、上报 launch token | 对公网监听 Agent 服务、把特权能力给 renderer |
| 服务器 | TLS 后认证、设备管理、协议适配、会话路由、隧道服务端 | 执行 Agent/LLM/工具、主动连入用户内网 PC |

- 公网只暴露反向代理后的 TLS 入口；网关监听 `127.0.0.1:3090`，DSH 只在 PC 回环地址运行。
- 每台 PC 的隧道、适配器、会话路由与推送独立，服务器分配动态回环端口；PC 常规本机服务为 3080/3081/3082，Codex-only 测试 profile 使用 3181/3182。仅使用自研 WSS。
- `trustedHosts` 仅是 DSH 的防重绑栅栏，不是认证；认证由独立的管理员密钥、账号接入密钥和 PC/手机设备授权承担，三者不可互用。

## 跨端绑定与连接契约

### 邀请密钥与手机配对

管理员在 `/access-admin` 用单独管理员密钥登录，创建、查看、备注、永久禁用、重置或删除账号；仅显示滚动 24 小时手机请求受理数。测试用户在 PC 输入账号接入密钥，不输入用户名密码。PC 保存 Windows safeStorage 加密后的设备授权与设备身份，不持久保存账号原始接入密钥。

PC 登录并连通隧道后打开手机配对页，显示随机手动码和 `batona-pair://<code>` 二维码；它不包含账号密钥。手机输入/扫描后必须由 PC 明确批准。PC 页面维持 20 秒可续期租约，4 秒轮询续租；最小化继续，关闭、断线、拒绝或成功后旧码不可再次使用。成功结果允许原请求凭证明文在内存保留 60 秒供手机安全领取；不写日志/数据库。

每账号暂限一台 PC、一部手机，以独立设备 ID 和账号所有权关联；设备授权不能跨角色、账号或 PC 路由。换电脑必须确认替换并让手机重新配对；换手机须先在 PC 解绑旧手机。PC 退出保留手机绑定和授权，同机同密钥登录后恢复；手机退出只撤销授权并保留名额，原手机重新配对仍需 PC 批准。管理员禁用不可恢复，重置创建新身份，删除清除登记；上述操作只终止远程访问，不取消 PC 本地任务。

新版客户端固定使用 `https://117.72.10.87`，遵循系统 CA 与 IP 身份校验。旧连接串、TOTP、共享 agentKey、浏览器远程入口不再是托管入口；旧 REST 返回 410，WS 查询参数不授予权限。旧授权资料不自动转换。

### 手机 ↔ 网关 RPC

手机连接 `wss://117.72.10.87/ws`，设备令牌仅在首帧 `auth.hello.payload.token` 传递；认证前无业务推送。协议版本为 v1，使用四象限信封：`client-request`、`server-response`、`server-request`、`client-response`。

- 上行：`auth.hello`、`session.list/create/resume/prompt/cancel/history/rename`、`interaction.pendingList`、`workspace.*`（含 `workspace.rename`）、`model.*`、`agent.profile.list`、`respond`；设备管理仅走 PC 的 `/api/access/*` REST。`interaction.pendingList` 在认证后的 WS 连接上返回网关进程内尚未解决的审批/提问帧，供手机重连或页面重载后恢复；待处理帧不持久化。
- 下行：`session/event`、`approval/requested`、`question/requested`。审批/提问必须用原始 `serverRequestRpcId` 经 `respond` 回答。
- `session/event.payload.sessionId` 是网关会话 ID；`workspace.tree` 中的 `sessions[].sessionId` 是后端会话 ID。Android 须使用已恢复会话的 `backendSessionId` 映射状态，聊天事件仍按网关 ID 路由。Codex 的 `session/thinking` 来自实际推理事件，`session/reconnecting` 来自 App Server `error.willRetry`；只有后端提供次数时才带 `attempt/maxAttempts`。
- `workspace.tree` 返回真实工作区 `items[]` 和可选的 `ungroupedSessions[]`。两者中的会话互斥，未分组集合不是工作区；旧客户端可忽略此字段。`model.select` 成功响应带后端确认后的 `model`，手机应核对模型和思考强度后再显示所选值。
- `workspace.rename` 接收 `workspaceId` 与新 `title`，只改工作区显示名称，不移动或重命名目录。DSH 使用原生 `workspace/rename`；Codex 共享连接使用已核验的实验 `project/list/create/read/update/delete` 接口，按目录匹配真实项目 ID，回读确认后才更新手机缓存。工作区新建、移除和共享重命名均要求 PC 已启用共享写入；旧版不支持项目接口时明确失败。独立界面控制模式的重命名保留已签名 Desktop 的 UI Automation 兼容路径。
- 实验共享 Codex 审批另发 `interaction/resolved`，携带当前网关会话的 `requestRpcIds[]`；原生 Desktop 先处理时，手机只关闭编号匹配的待审批/提问卡。此事件不携带批准结果，也不表示已授权。
- 任何字段、方法、事件或兼容策略变更都必须同步检查 Android、PC、服务器，并更新本文件与受影响端的 `AGENTS.md`。

### Codex 接入边界

- `session.create/resume/list` 的会话对象可携带 `model: { provider, model, reasoningEffort?, displayName? }`。该值来自后端会话快照，缺失表示尚未同步；手机打开或切换会话时刷新此值，不能沿用上一会话的选择或拿模型目录第一项冒充。旧客户端忽略可选字段，旧网关下新版手机显示“模型未同步”。

- PC 的 `codex-bridge.js` 仅绑定 loopback：常规实例监听 `127.0.0.1:3082`，隔离测试 profile 监听 `127.0.0.1:3182`；两者都经本机 Codex `app-server` 工作，网关按 PC 服务名与独立隧道路由访问。不能配置公网 listener，也不能把 App Server 原始帧、认证资料或未脱敏工具输出转给服务器。
- Codex 会话与 DSH 会话是不同 backend；手机切换后只显示当前 backend 的工作区树。共享服务支持 `project/list` 时，以该列表作为工作区的唯一来源，即使列表为空也不补入本地登记或旧 Desktop 根目录。不支持该接口的只读模式使用 Desktop 根目录，绝不按会话 `cwd` 创建工作区。新建工作区将所选现有目录加入真实 Codex 项目；移除工作区删除项目登记，均不创建或删除磁盘目录。共享连接新建任务要求匹配现有项目并传递实际 `projectId`；当前 CLI 使用兼容的 `legacy` 历史模式，设置会话标题并确认空会话可读取后返回成功。手机只有收到成功响应才关闭新建弹窗；失败保留路径和错误说明。
- Codex 会话有 `projectId` 时按对应项目归组；旧 Desktop 会话的 `projectId` 为空时，只允许通过 `cwd` 匹配已存在的项目根目录，无法匹配时进入未分组集合。DSH 从未被工作区 `sessionIds` 关联的非归档会话进入同一集合。手机把未分组会话显示在真实工作区之后，可展开较早会话，但不提供工作区管理操作。
- Codex App Server 的 `thread/list` 发现桌面端已有任务，打开/历史浏览使用 `thread/read` 与 `thread/turns/list`，不取得第二个 writer。未共享模式仍经已绑定原生窗口代理操作；失败时保留手机草稿或原设置。Batona 自建任务仍由其 app-server 写入。原生任务的审批/提问交互与运行中增量同步尚未接入；不能将历史可读或文本发送成功视为完整双向同步，也不能以 fork、抢锁或 `codex exec` 替代。详见 [ADR 0003](../docs/adr/0003-native-codex-window-control.md)。
- 实验分支另提供**同一**回环 WebSocket app-server 的共享传输：Desktop 与 Batona 可同时订阅原生任务。本机显式开关下，模型/强度和权限档/审批策略分别通过单次 `thread/settings/update` 原子修改；目标任务由 `threadId` 指定，无需 Desktop 显示该任务。后台设置由匹配的 `thread/settings/updated` 或共享服务回读确认，再同步到手机。完全访问需手机二次确认。隔离任务实测后台权限改变了下一轮工作区外写入的执行结果；Desktop 持有任务的下一轮执行与标签刷新仍待现场验收。该设置接口是实验协议，共享写入默认关闭。详见 [共享传输探针](pc/tools/shared-transport-probe/README.md) 与 [ADR 0003](../docs/adr/0003-native-codex-window-control.md)。
- 手机上的 `请求批准`、`帮我审批`、`完全访问` 是 PC 校验后的固定档；Batona 自建任务映射到允许的 App Server permission profile，共享模式下 Desktop 原生任务按 `threadId` 修改后台权限；未共享模式仍经窗口权限控件选择。手机选择“完全访问”须先二次确认，PC 仅在收到该确认标记后写入后台；确认失败不报告切换成功。手机不能自定义底层权限。所有镜像事件先在 PC 脱敏，且只接受文本输入。
- `session.permissionMenu`（`{sessionId,open}`）与 `session.permissionSelect`（`{sessionId,profileId,confirmed}`）通过网关转至 PC 桥；共享模式从 `thread/resume` 读取当前权限，选择固定档后须由共享服务设置事件或回读确认后台档位和审批策略才返回 `{profileId}`。未共享模式由原生窗口确认。`full-access` 要求 `confirmed:true`，该值只由手机二次确认动作发出；旧客户端缺少标记时明确拒绝。模型与思考强度沿用 `model.select`。
- DSH 的 `session.permissionPresetList` / `session.permissionPresetSelect` 独立于 Codex 权限档：按当前 DSH 会话读取 `permissions` 投影，只提供只读、工作区写入、完全访问三个固定预设。网关校验投影选项与 DSH `/permission` 命令后再提交，并读取新投影确认切换成功；没有投影或未开放的预设不可切换。完全访问要求 Android 二次确认，网关也拒绝缺少确认标记的请求。
- DSH 的 `model.list` 按 `session/modelCatalog` 中每个模型实际支持的 `reasoning.efforts` 返回同一模型的强度变体；支持强度的模型通常提供 `off / low / high / max`，不支持的模型只返回一个无强度选项。Android 将模型与思考强度分开选择，二者都调用 `model.select`；网关通过 DSH `session/selectModel` 返回的 `selected` 核对模型及强度后才报告成功。
- Codex 的 `session/settings` 会话事件携带模型/强度及可识别的权限档 ID；网关更新会话模型快照并把事件推送给手机。未知权限组合清除手机端旧档位，避免显示过期的权限状态。该事件不包含原始 `threadSettings`、工作目录或审批详情。
- iOS PWA 的推送操作仅供已绑定手机使用：`POST /api/access/push-key` 与 `push-status` 读取配置，`push-subscribe` / `push-unsubscribe` 管理订阅；订阅在手机退出、解绑、电脑替换或账号禁用时清理。系统通知只包含 `approval`、`question`、`completed`、`failed` 类别，不包含会话正文。
- 手机只在本地缓存每个工作区最近 5 个 Codex 会话和每个会话最多 200 条已脱敏历史；断网只能浏览、不可排队发送，注销或重新绑定会清空缓存。iOS PWA 只缓存应用外壳，不缓存会话数据。通知仅提示等待审批、等待回答、完成或失败，且不含对话、命令、路径或凭据。

### PC ↔ 服务器隧道与 launch token

PC 以 `wss://117.72.10.87/tunnel` 建立出站隧道，使用 `Authorization: Bearer <PC-device-token>`。同一 PC 授权调用 `POST /api/access/launch-token` 上报临时 DSH launch token，服务器只更新该 PC 的适配器。管理员密钥、账号密钥与手机令牌不能登录隧道。

隧道帧见 [PC 协议](pc/tunnel/protocol.js) 和 [服务器协议](server/gateway/src/tunnel/protocol.ts)，两端黄金向量必须一致。无 FRP 回退。DSH HTTP、Cookie 交换和 WS 使用 PC authority `127.0.0.1:3080`，不能让服务器动态端口变成 Cookie 身份。

## 三端构建、发布与联调

| 任务 | 执行位置 | 权威步骤 |
|---|---|---|
| 服务器首次接入、Git 更新、回滚、宝塔配置 | Linux 服务器 | [server/AGENTS.md](server/AGENTS.md) |
| Windows 运行、打包与更新 | PC | [pc/AGENTS.md](pc/AGENTS.md) |
| APK 构建、安装、UI/真机验证 | Android 工程 | [android/AGENTS.md](android/AGENTS.md) |

跨端发布遵循：先改动并验证受影响端 → 服务器网关版本递增并部署 → 确认 PC 隧道/launch-token 上报 → 用手机完成登录、会话流式消息、审批和提问测试。服务器更新不会删除 `/etc/batona-gateway` 或 `/var/lib/batona-gateway`，因此同一托管模式正常更新后 PC/手机无需重新绑定；从旧认证升级则必须执行单独迁移和重新接入。

最小端到端验收：

1. 管理员发密钥，PC 登录，DSH 与隧道均在线；
2. 手机输配对码，PC 确认，能读取会话与工作区；
3. 新建/恢复会话、流式消息、审批与提问可往返；
4. Codex Desktop 已登录时，手机能查看现有 Codex 工作区/会话、创建或恢复会话、选择真实模型和固定权限档，并从 PC/手机任一端看到状态变化；
5. 手机断网后恢复，PC 隧道可重连；
6. 服务器 `batona-deploy --status` 显示健康检查、版本和端口安全检查均正常。

## 设计边界与演进

- 网关以 `AgentAdapter` 为扩展点：DSH、Codex 与 mock 遵守同一会话与事件契约；Claude Code 尚未接入，后续适配器必须遵守相同的本地执行、隧道和脱敏边界。
- DSH 官方协议没有稳定版本保证。升级 DSH 后，先跑网关冒烟、协议/隧道向量测试与真实回归探针，再发布。
- 工作区与会话的关联以 DSH `WorkspaceView.sessionIds` 为准；会话“删除”应表述为归档，因为 DSH 没有硬删除语义。
- 历史会话回放必须限制并聚合事件，避免把大量流式 chunk 直接转发到手机或耗尽服务器内存。
