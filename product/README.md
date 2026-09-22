# DSH Link — 三端工程导航与共享契约

DSH Link 让 Android 手机通过公网网关远程操控笔记本上的 DeepSeek Harness（DSH）或 Codex。
Agent、LLM 与工具执行始终留在 PC；服务器只提供认证、会话路由和 PC 的出站隧道。

## 文档边界

`docs/` 只保留项目的外部研究和需求依据：

- [调查-DSH手机远程操控插件.md](docs/调查-DSH手机远程操控插件.md)
- [需求-DSH远程接入网关.md](docs/需求-DSH远程接入网关.md)

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
| 调查与需求依据 | [docs/](docs/) | [调查](docs/调查-DSH手机远程操控插件.md) · [需求](docs/需求-DSH远程接入网关.md) |

## 跨端架构与职责

```
Android 手机 App ── HTTPS / WSS ──▶ 服务器网关 ◀── WSS 隧道 ── PC Electron（本地 DSH）
```

| 端 | 负责 | 不负责 |
|---|---|---|
| Android | 绑定、登录、按后端分组的会话/工作区/模型/设备 UI，消费网关 RPC | 直连 PC、保存 launch token、执行 Agent |
| PC | 启动本地 DSH、托管本地 Codex App Server 桥、保管连接串、维持出站隧道、上报 launch token | 对公网监听 Agent 服务、把特权能力给 renderer |
| 服务器 | TLS 后认证、设备管理、协议适配、会话路由、隧道服务端 | 执行 Agent/LLM/工具、主动连入用户内网 PC |

- 公网只暴露反向代理后的 TLS 入口；网关监听 `127.0.0.1:3090`，DSH 只在 PC 回环地址运行。
- 内置隧道将服务器 3080/3081/3082 仅绑定到回环；旧 frp 回退模式另有 7000，不能将 Agent 端口暴露公网。
- `trustedHosts` 仅是 DSH 的防重绑栅栏，不是认证；认证由账号密码、TOTP、设备令牌和连接串内共享密钥承担。

## 跨端绑定与连接契约

### 连接串与二维码

服务器安装输出的连接串及二维码载荷相同：

```text
dsh-gw://<serverIp>?frpPort=7000&gwPort=443&frpToken=<token>&gwUser=<admin>&gwPass=<password>&pair=<code>
```

`frpToken` 是连接串的必填共享密钥；PC 和 Android 的解析器必须保留 `frpPort`（默认 7000）、`gwPort`（默认 443）、`gwUser`、`gwPass` 与 `pair`。它包含凭据，不能提交、记录、截图公开或写入诊断日志。

绑定路径：服务器安装生成连接串 → PC 扫码/粘贴后保存连接并启动 DSH 与隧道 → PC 显示同载荷二维码 → 手机扫码/粘贴，预填网关账号并完成 TOTP 登录。`pair` 是服务器生成的绑定标识；设备授权的真实安全边界仍是网关登录与设备令牌。

### 手机 ↔ 网关 RPC

手机连接 `wss://<server>:<gwPort>/ws?token=…`，也可在首帧 `auth.hello` 完成握手。协议版本为 v1，使用四象限信封：`client-request`、`server-response`、`server-request`、`client-response`。

- 上行：`auth.hello`、`session.list/create/resume/prompt/cancel/history/rename`、`workspace.*`、`model.*`、`agent.profile.list`、`respond`、`device.*`。
- 下行：`session/event`、`approval/requested`、`question/requested`。审批/提问必须用原始 `serverRequestRpcId` 经 `respond` 回答。
- 任何字段、方法、事件或兼容策略变更都必须同步检查 Android、PC、服务器，并更新本文件与受影响端的 `AGENTS.md`。

### Codex 接入边界

- PC 的 `codex-bridge.js` 仅监听 `127.0.0.1:3082`，通过本机 Codex `app-server` 的 stdio JSON-RPC 工作；网关只能经既有隧道访问它。不能配置公网 listener，也不能把 App Server 原始帧、认证资料或未脱敏工具输出转给服务器。
- Codex 会话与 DSH 会话是不同 backend；手机切换后只显示当前 backend 的工作区树。Codex 工作区按 PC 上会话的 `cwd` 分组；用户通过现有目录浏览服务选择任意本机目录，新建空工作区仅登记路径，不创建或删除磁盘目录。
- Codex App Server 的 `thread/list` 发现桌面端已有会话，`thread/resume`/`turn/start` 继续原生会话；PC 轮询持久状态并把运行状态同步到手机。若 App Server 能力/版本不可用，网关应明确显示不可用，不得降级为不受控的 `codex exec`。
- 手机上的 `请求批准`、`帮我审批`、`完全访问` 是 PC 校验后的固定档，分别只会映射到已允许的 `:workspace`/`:danger-full-access` App Server permission profile 与对应 approval policy；手机不能自定义底层权限。所有镜像事件先在 PC 脱敏，且只接受文本输入。
- 手机只在本地缓存每个工作区最近 5 个 Codex 会话和每个会话最多 200 条已脱敏历史；断网只能浏览、不可排队发送，注销或重新绑定会清空缓存。通知仅提示等待审批、等待回答、完成或失败，且不含对话、命令、路径或凭据。

### PC ↔ 服务器隧道与 launch token

PC 默认以 `wss://<server>:<gwPort>/tunnel` 建立出站隧道，使用 `Authorization: Bearer <frpToken>`。服务器的 `agentKey` 与连接串 `frpToken` 保持一致；PC 启动 DSH 后以同一密钥调用 `POST /api/dsh/launch-token` 上报每个进程临时的 launch token。

隧道线格式在 [pc/tunnel/protocol.js](pc/tunnel/protocol.js) 与 [server/gateway/src/tunnel/protocol.ts](server/gateway/src/tunnel/protocol.ts) 有两份实现，必须同步修改，并运行两端共同消费的黄金向量测试。内置隧道不可用时，PC 在 `auto` 模式可回退 frp；切换服务器到内置隧道前必须确认 PC 已升级。

## 三端构建、发布与联调

| 任务 | 执行位置 | 权威步骤 |
|---|---|---|
| 服务器首次接入、Git 更新、回滚、宝塔配置 | Linux 服务器 | [server/AGENTS.md](server/AGENTS.md) |
| Windows 运行、打包与更新 | PC | [pc/AGENTS.md](pc/AGENTS.md) |
| APK 构建、安装、UI/真机验证 | Android 工程 | [android/AGENTS.md](android/AGENTS.md) |

跨端发布遵循：先改动并验证受影响端 → 服务器网关版本递增并部署 → 确认 PC 隧道/launch-token 上报 → 用手机完成登录、会话流式消息、审批和提问测试。服务器更新不会删除 `/etc/dsh-gateway` 或 `/var/lib/dsh-gateway`，因此正常更新后 PC/手机无需重新绑定。

最小端到端验收：

1. PC 导入连接串，DSH 与隧道均在线；
2. 手机完成 TOTP 登录，能读取会话与工作区；
3. 新建/恢复会话、流式消息、审批与提问可往返；
4. Codex Desktop 已登录时，手机能查看现有 Codex 工作区/会话、创建或恢复会话、选择真实模型和固定权限档，并从 PC/手机任一端看到状态变化；
5. 手机断网后恢复，PC 隧道可重连；
6. 服务器 `dsh-deploy --status` 显示健康检查、版本和端口安全检查均正常。

## 设计边界与演进

- 网关以 `AgentAdapter` 为扩展点：DSH、Codex 与 mock 遵守同一会话与事件契约；Claude Code 尚未接入，后续适配器必须遵守相同的本地执行、隧道和脱敏边界。
- DSH 官方协议没有稳定版本保证。升级 DSH 后，先跑网关冒烟、协议/隧道向量测试与真实回归探针，再发布。
- 工作区与会话的关联以 DSH `WorkspaceView.sessionIds` 为准；会话“删除”应表述为归档，因为 DSH 没有硬删除语义。
- 历史会话回放必须限制并聚合事件，避免把大量流式 chunk 直接转发到手机或耗尽服务器内存。
