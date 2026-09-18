# DeepSeek Harness 远程接入网关设计文档

> 版本：v0.1（草案）· 日期：2026-08 · 状态：评审中
> 关联文档：[调查-DSH手机远程操控插件.md](./调查-DSH手机远程操控插件.md)（开源方案盘点）
> 本文协议描述均基于本机安装的 `@deepseek-ai/dsh 0.1.1-rc.2` 源码核实（`dsh-client-connection` / `dsh-api-gateway` / `dsh-typert-protocol` / `dsh-host-apiproxy` / `dsh-api-remotes` 等包）。
>
> ⚠️ **2026-09 补充：DSH 0.1.2+ 已换成 Typert Remote 协议，本文 §3 的 0.1.1 细节仅作历史对照。**
> 0.1.2 起一次性改了四处：端点 `/api/<ns>.<method>` → `/api/<ns>/<method>`；body 信封
> `{type:'client-request',rpcId,method,payload:{args}}`；`/api` 与 `/api/remote.mux` 一律强制**浏览器会话认证**
> （用进程启动时的 launch token 经 `GET /?token=` 换 cookie，无 API-key、无开关）；事件下行由 `events.mux` 换成
> `$events`（waterfall 应答走 `POST /api/$events/result`，会话增量走 `session/follow`）。
> 网关适配器已按此迁移（`product/server/gateway/src/adapter/dsh/*`）；launch token 由 PC 端自动上报，
> 见 [部署指导.md](./部署指导.md)。差异速查见**附录 E**。

---

## 1. 背景与目标

### 1.1 需求

- **核心需求**：在手机上随时随地远程操控笔记本电脑上的 DeepSeek Harness（DSH）。
- **基础设施**：拥有一台带公网 IP 的服务器（可作为接入点/中继/网关载体）。
- **扩展需求（本次设计的关键约束）**：
  1. 未来接入**语音模态**（调用声学模型实现对话式交流）；
  2. 未来接入 **Codex、Claude Code 等其他 agent** 作为后端；
  3. 无论自研还是采用开源组件，架构必须保留上述扩展性。

### 1.2 已核实的硬约束（决定架构形态的事实）

| 事实 | 来源 | 对设计的影响 |
|---|---|---|
| `dsh web` 拒绝 `--host 0.0.0.0`，有意不支持绑定所有网卡 | `dsh-web-app` README、[官方 Discussion #76](https://github.com/deepseek-ai/deepseek-harness/discussions/76) | DSH 不能直接暴露公网，必须经隧道/网关 |
| 官方明确"remote access 直到有认证层才支持 0.0.0.0" | `dsh-client-connection` README | 认证层是网关的第一职责 |
| DSH 本身就是"Host ↔ 浏览器客户端"架构，有完整 RPC 协议（Typert + `/api`） | `dsh-client-connection`、`dsh-host-apiproxy` 源码 | **远程客户端 = 复用官方客户端协议**，无需屏幕抓取 |
| `trustedHosts`（`cordis.yml` / `--trusted-host`）只是防重绑栅栏，**不是认证** | `dsh-client-connection` README | 认证必须由网关完成 |
| `host.describe` 无协议版本号（官方注释：仅当出现独立发布的客户端才引入） | `dsh-host-apiproxy` 源码 | **网关自建协议版本号**，防 DSH 升级破坏 |
| DSH 已内置 MCP 客户端（`dsh-mcp-client`，stdio / streamable-http） | 本地包源码 | 多 agent 统一接入可用 MCP 作为标准 |

### 1.3 设计目标与原则

1. **协议中立**：前端协议（手机 ↔ 网关）与后端 agent 协议解耦，互不渗透。
2. **适配器可插拔**：每个后端 agent 一个适配器，实现同一契约；新增后端 = 新增适配器。
3. **模态分离**：语音（ASR/TTS/声学模型）作为模态层，会话层永远是文本协议。
4. **最小暴露面**：DSH 永不直接暴露公网，只出站连接网关；公网入口只有网关。
5. **安全前置**：认证（MFA）、TLS、设备管理在第一版实现，不是后置补丁。

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────────────┐
│ 手机端（PWA / Android App / 语音客户端）                              │
│   └─ 前端协议：单条 WebSocket 全双工，四象限 RPC 信封（见 §4.2）        │
└───────────────────────────┬────────────────────────────────────────┘
                            │ TLS（公网）
┌───────────────────────────▼────────────────────────────────────────┐
│ 接入网关 Gateway（自研核心，部署于公网服务器）                          │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────────────┐ │
│  │ 认证层        │ │ 会话/路由层    │ │ 模态层（可插拔）                 │ │
│  │ 账号+密码      │ │ gatewaySession│ │ 文本 I/O（v1）                 │ │
│  │ TOTP MFA     │ │ ↔ {backend,  │ │ ASR / TTS / 声学模型（v2）      │ │
│  │ 设备注册       │ │  backendSid} │ │ 全双工音频通道                   │ │
│  │ 限速/封禁      │ │ 队列/取消     │ │                              │ │
│  └─────────────┘ └──────┬───────┘ └──────────────────────────────┘ │
│                         │                                          │
│              ┌──────────▼───────────┐                              │
│              │ 适配器注册表 AdapterRegistry                          │
│              │ 统一契约 AgentAdapter（见 §5.1）                      │
│              └──┬────────┬─────────┬──┘                            │
└─────────────────┼────────┼─────────┼───────────────────────────────┘
                  │        │         │
   ┌──────────────▼─┐ ┌────▼─────┐ ┌─▼──────────────┐
   │ DSH Adapter    │ │Codex      │ │ Claude Code    │   ← 后端适配层
   │ 官方 /api 协议  │ │Adapter    │ │ Adapter        │     （可不断新增）
   │ + trustedHosts │ │headless   │ │ MCP server 封装 │
   └──────┬─────────┘ │API        │ │ 或官方 SDK      │
          │           └────┬──────┘ └────┬──────────┘
   ┌──────▼───────────────┴─────┐        │
   │ 笔记本（内网）                │        │
   │ DSH Host（loopback:3080）    │        │
   │ 出站反向隧道 → 网关            │        │
   └────────────────────────────┘        │
                                    （远端或本机）
```

**关键拓扑决策**：网关部署在公网服务器；笔记本上的 DSH **主动出站**连接网关（frpc / `ssh -R` / cloudflared / WireGuard 隧道任选），DSH 保持内网 loopback 绑定，公网只暴露网关的 443 端口。

---

## 3. 已核实的 DSH 官方客户端协议（DSH Adapter 的对接基础）

> 本节是设计的事实基础。以下全部内容来自本地 0.1.1-rc.2 源码类型定义，供实现时对照。

### 3.1 四象限 RPC 消息模型（信封）

所有逻辑消息是四成员判别联合（channel 无关，HTTP / WebSocket / 进程内 SSE 只是物理载体）：

| 消息 | 形状 | 物理载体 |
|---|---|---|
| `ClientRequest` | `{type:'client-request', rpcId, method, payload}` | `POST /api/<method>` 请求体 |
| `ServerResponse` | `{type:'server-response', rpcId, result}` | 该 POST 的响应体 |
| `ServerRequest` | `{type:'server-request', rpcId, method, payload}` | 下行流帧（WebSocket） |
| `ClientResponse` | `{type:'client-response', rpcId, result}` | `POST /api/respond` 请求体 |

- `rpcId`：发起方铸 UUID；响应**回显**请求的 rpcId，绝不新铸。审批/提问帧的 rpcId 是稳定逻辑 id（重放复用）；纯推送帧每次新铸。
- `result`：`{ok:true, value} | {ok:false, error}`；`error = {code, message, details}`，code 是封闭联合（见附录 C），业务方法**永不 throw**。
- 审批/提问应答：`POST /api/respond` 返回 `RpcReceipt = {accepted:true} | {accepted:false, reason:'not-pending'|'bad-response'}`。

### 3.2 HTTP / WebSocket 载体（浏览器 carrier 的物理布局）

- `API_PATH = /api`；`MUX_EVENTS_PATH = /api/events.mux`；`HOST_EVENTS_PATH = /api/events.host`。
- **上行**（客户端 → Host）：HTTP POST unary。
- **下行**（Host → 客户端）：每个事件流一条**仅下行** WebSocket；客户端在 socket 上不发任何应用数据。
- **信任栅栏**：`/api` 下每个请求必须满足 `loopback 权威` 或匹配 `trustedHosts` 条目（`host:port` 精确 / 无端口即任意端口，WHATWG 归一化防 DNS 重绑）；带 `Origin` 时必须等于 Host 权威；`sec-fetch-site: cross-site` 直接拒绝。
- **连接代际**：任一下行 socket 断开 → 当前连接代失败，重建两条流；就绪要求两条 WS 均打开且 `host.describe` 成功。官方重连语义 = **重开流 + 重新拉取 history**（`events.mux` 的 `since` 参数 v1 未实现）。
- **传输可替换钩子**：页面全局 `__DSH_TRANSPORT__` 可整体替换浏览器载体（`createApiClient` + `fetch` + `loadBundle`）——官方为"非标准传输"预留的接入点。
- 默认最大请求体 300 MiB（图片 base64 膨胀余量），网关侧如需流式大文件需自行扩展。
- **无协议版本号**：`host.describe` 返回 `{version /* apps/cli 版本 */, cwd, ...}`，注释明言"仅当出现独立发布的客户端才引入 protocolVersion"。

### 3.3 端点清单（client-request 方法，POST `/api/<method>`）

完整 `RpcMethodMap`（共 55 个方法，实现时以此为基准）：

```
session.*      list search create history models selectModel rename fork
               prompt attachment updateQueue cancel
subagent.*     list history prompt interrupt
host.*         describe pickDirectory listDirectory createDirectory openPath
workspace.*    list create rename delete insertBefore insertSessionBefore archiveSession
skill.*        list
agentPreset.*  list select read copy openDocument remove
goal.*         create edit pause resume complete clear
settings.*     describe openDocument update replace mutate
credentials.*  describe set unset
llm.*          providers models discoverModels
respond        POST /api/respond（ClientResponse，非 unary 方法）
```

要点：
- `session.create` 支持 `agentPreset`（agent 预设，如 code / standard / minimal），即**会话级 agent 切换**；`session.prompt` 是核心对话入口（payload 支持文本 + base64 图片 part）；`session.updateQueue` 是官方队列操作（排队/置顶/取消排队项）；`session.fork`、`session.history`（分页，`HistoryEntry = event + view?`）。
- 敏感面（`host.openPath`、`settings.*`、`credentials.*`、`agentPreset.read/copy/openDocument/remove`）在官方 node 半区**仅限 loopback**——远程访问必须等真实认证层（官方原文），这正是网关存在的理由。

### 3.4 事件词汇（下行流）

**`events.mux`（全会话聚合流）帧：**

```
session/subscribed   {sessionId, lastSeq}          // 打开时基线，每附加会话一帧
session/event        {sessionId, event, view?}     // 原始 SessionEvent 透传
approval/requested   {sessionId, approvalId, toolName, callId?, reason?}   // 可应答
approval/resolved    {sessionId, approvalId, outcome}
question/requested   {sessionId, questions[]}      // 可应答
question/resolved    {sessionId, questionRpcId, outcome}
session/queue        {sessionId, items[]}          // 收件箱全量快照（排队/steering/context）
session/jobs         {sessionId, jobs[]}           // 后台任务全量快照
session/projection   （投影帧，sessionListMetadata / imageLimits 等）
```

**`events.host`（主机级流）：** 会话创建/销毁、运行状态翻转、无回合位置的 agent 失败。

**`SessionEvent` 原始事件词汇**（`session/event` 帧内，DSH 会话日志的持久事件类型）：

```
user/message  assistant/message  assistant/chunk
tool/call     tool/result
turn/start    turn/end    step/start    step/end
approval/asked  approval/decided  approval/policy
command/run   command/done
compaction/start  compaction/end  compaction/prune  compaction/summary
goal/change   plan/mode   sandbox/mode   todo/write
session/title  session/created  session/disposed  session/flush
subagent/descriptor  team/member  team/task
hook/invoked  hook/result  llm/retry  feedback/record
request/context  request/header  permission/preset  schedule/change  internal/dispatch
```

**应答载荷**：
- 审批：`{sessionId, approvalId, outcome:'allowed-once'|'rejected'}`（`cancelled/unavailable` 是 Host 侧结局，客户端不可给）。
- 提问：`{sessionId, answer}`（一次 ask 的整批答案）。

### 3.5 另一条官方通道：Typert Remote（插件级 RPC）

除浏览器 `/api` 协议外，DSH 还有插件级 Host↔Client RPC（`dsh-api-gateway` + `dsh-typert-protocol`）：
- Host 侧 `ctx.typertGateway.invoke()`（业务服务方法打 `@Remote` / `@RemoteScope` 注解）；Client 侧 `ctx.remote.$mount()/$on()/$dispatch()`。
- `dsh-api-remotes` 已挂载：Goal Remote、只读插件清单、**Agent/Session 身份解析（复用活跃 agent、resume 冷会话、去重并发 resume、subagent 属主栅栏）**；`API_REMOTE_FORWARDED_EVENTS` 白名单转发 Host 事件。
- 含义：**在 DSH 内写插件（cordis patch）可拿到比浏览器协议更深的能力**，但绑定 DSH 版本与内部类型。

---

## 4. 网关（Gateway）设计

### 4.1 模块划分

```
gateway/
├─ auth/           认证：账号密码、TOTP MFA、设备注册表、限速、会话 Cookie
├─ session/        会话路由：gatewaySession ↔ {backend, backendSid, state}
├─ adapter/        适配器契约 + 注册表 + 各后端实现（dsh / codex / claude-code）
├─ modality/       模态层：文本（v1）；语音 ASR/TTS（v2，独立 SpeechProvider 接口）
├─ transport/      TLS 终结、WebSocket 网关、限流、审计日志
└─ proto/          前端协议信封（复用 DSH 四象限形状，见 §4.2）
```

### 4.2 前端协议（手机 ↔ 网关）

**推荐：单条 WebSocket 全双工 + 四象限信封**。理由：网关在公网，全双工 WS 一个通道同时承载上行调用、下行推送与应答，比"HTTP unary + 两条下行 WS"简单得多；信封形状与 DSH 一致，心智负担低、未来可平移为 DSH 原生协议。

```
client-request   {type, rpcId, method, payload}        // 方法：auth.login, session.*, agent.*, respond...
server-response  {type, rpcId, result}
server-request   {type, rpcId, method, payload}        // 推送：session/event, approval/requested, question/requested, audio/output...
client-response  {type, rpcId, result}                 // 应答：approval/question
```

- **版本化**：WS 握手或 `auth.hello` 带 `protoVersion: 1`；网关与 DSH `host.describe` 的 version 做兼容矩阵（见 §10 风险）。
- **会话模型**：手机只感知 `gatewaySessionId`；网关维护 `gatewaySession ↔ {backend, backendSessionId, state}` 映射，`session.create` 时可选择 `backend: 'dsh' | 'codex' | 'claude-code'` 与 `agentPreset`。
- **状态快照语义**：沿用 DSH 的"全量快照"哲学（`session/queue`、`session/jobs` 均为全量，重连收敛），网关推送同样用全量快照，避免增量对账。

### 4.3 认证与安全边界

第一版即实现（不可后置）：

1. **账号 + 密码 + TOTP MFA** 登录，`HttpOnly` + `SameSite=Strict` 会话 Cookie（参考 [dsh-remote-link](https://github.com/BotonJ/dsh-remote-link) 的 Cookie 会话与设备注册表思路）。
2. **设备注册**：每台手机首次登录需配对确认；设备可吊销；`remote_devices` 类管理工具可在会话内操作（网关侧实现）。
3. **登录限速 + IP 封禁**：公网入口必然被扫描（见调查报告 §三）。
4. **TLS 终结于网关**（Caddy 自动 HTTPS / 自有证书），网关与 DSH 之间走隧道 + `trustedHosts` 声明。
5. **审计日志**：谁、何时、从哪个设备、对哪个会话做了什么（DSH 侧工具调用含真实 RCE 能力，必须可审计）。

### 4.4 传输拓扑（利用公网服务器）

```
手机 ──TLS──▶ 网关(公网服务器:443)
                    │
  笔记本 DSH(loopback:3080) ──出站隧道──▶ 网关隧道端口
     （frpc / ssh -R / cloudflared / WireGuard 任选其一）
```

- 笔记本在 NAT 后 → 必须**出站**连接；隧道把笔记本 `127.0.0.1:3080` 映射到网关内部地址。
- 网关侧对 DSH 的 HTTP 请求带 `Host: 127.0.0.1:3080`（或隧道地址），匹配 DSH `trustedHosts` 或 loopback 权威，通过信任栅栏。
- 备选：若服务器配置足够，Phase 3 后可将 DSH 直接跑在服务器（配合 `dsh-remote-tunnel` 类工具管理），笔记本仅作客户端——但这是拓扑变更，不影响本文分层。

---

## 5. 适配器层（核心扩展点）

### 5.1 统一契约 `AgentAdapter`

```ts
/** 一个后端 agent 的统一接入面。新增后端 = 新增一个实现，网关零改动。 */
interface AgentAdapter {
  readonly id: 'dsh' | 'codex' | 'claude-code' | string;
  readonly capabilities: {
    text: boolean; images: boolean;
    approvals: boolean;            // 是否产生审批/提问 server-request
    resume: boolean;               // 是否支持断线后恢复会话
    concurrency: 'single' | 'queue' | 'parallel';
    voice: 'none' | 'forward';     // 语音=透传模态（v2），agent 不感知
  };

  connect(cfg: AdapterConfig): Promise<void>;
  listSessions(): Promise<AgentSessionRef[]>;
  createSession(opts: CreateSessionOpts): Promise<AgentSessionRef>;
  resumeSession(id: string): Promise<AgentSessionRef>;   // 冷会话恢复
  prompt(session: AgentSessionRef, parts: PromptPart[], opts?): AsyncIterable<AgentEvent>;
  respond(session: AgentSessionRef, serverRequestRpcId: string, payload: unknown): Promise<void>;
  cancel(session: AgentSessionRef, itemId?: string): Promise<void>;
  dispose(): Promise<void>;
}

/** 归一化后的 agent 事件流（网关对外推送的词汇，对齐 DSH SessionEvent） */
type AgentEvent =
  | { type: 'user/message' | 'assistant/message' | 'assistant/chunk' | 'tool/call' | 'tool/result'
      | 'turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'session/title' | 'done'
      | 'approval/requested' | 'approval/resolved' | 'question/requested' | 'question/resolved'
      | 'error', ... };
```

网关只依赖该契约；`AgentEvent` 词汇以 DSH 为准（其他 agent 的差异在适配器内归一化），保证手机端协议长期稳定。

### 5.2 DSH Adapter（官方 `/api` 协议直连）

**对接方式（推荐路线 A）**：网关扮演官方协议的"远程浏览器客户端"，不做任何屏幕抓取、不打 DSH 补丁。

- **上行**：`POST {base}/api/<method>`，body = `ClientRequest`；解析 `ServerResponse`。
- **下行**：两条仅下行 WebSocket `events.mux` / `events.host`；实现重连代际语义（任一流断开 → 重建双流 + 重拉 history）。
- **应答**：审批/提问 → `POST {base}/api/respond`，body = `ClientResponse`（rpcId 回显帧的 rpcId）。
- **信任**：网关地址加入 DSH 的 `--trusted-host`（或 `cordis.yml` 的 `trustedHosts`）；隧道回环时天然 loopback。
- **会话映射**：`session.create` 返回的 `SessionId` 即 `backendSessionId`；网关持久化 `gatewaySessionId ↔ (backend, backendSessionId)`，重连后 `session.history` + `events.mux` 基线重建 UI。
- **并发/队列**：DSH 有 `agent-busy` 错误码与官方 `session.updateQueue` —— 网关将多设备并发请求排入官方队列，而不是自己乱发。
- **能力深挖（路线 B，Phase 3 可选）**：在 DSH 内写 cordis 插件暴露 Typert Remote 额外端点（如文件桥、Host 级通知、`ctx.typertGateway` 内部服务），经 `--trusted-host` 授权给网关。收益是更深的集成，代价是绑定 DSH 版本——默认不做。

**协议核对基准**：实现时以 §3 的 `RpcMethodMap`、`MuxFrame`、`SessionEvent` 词汇为测试基线（55 个 unary 方法 + 2 条事件流 + respond），与官方 Web 前端行为对齐。

### 5.3 Codex Adapter

- **对接面**：Codex CLI v0.130+ 的 headless remote-control API（[Codex CLI v0.130: Building Headless Agent Services](https://codex.danielvaughan.com/2026/05/09/codex-cli-v0130-remote-control-headless-agent-services-thread-pagination/)），或经其 MCP 接口。
- **归一化**：把 Codex 的会话/线程/事件翻译为 `AgentSessionRef` / `AgentEvent`（turn/step/tool 语义与 DSH 接近，映射成本低）。
- **运行位置**：Codex CLI 可跑在网关服务器或笔记本（经同一隧道），由 AdapterConfig 决定。

### 5.4 Claude Code Adapter

- **对接面**：Claude Code 官方 SDK（[SDK 概览](https://github.com/quepasajefe/claude-code-manual/blob/main/sdk-overview.md)），或把它包成 MCP server 后经 HTTP 暴露（社区已有先例，如 PyPI 的 [sk8](https://pypi.org/project/sk8/)）。
- **归一化**：将 MCP 的通知/工具回调翻译为 `AgentEvent`；审批类交互若 Claude Code 无对应机制，则由适配器降级为"网关本地策略（allow/deny/手动）"。

### 5.5 为什么以 MCP 作为"接入其他 agent"的统一标准

| 参与者 | MCP 支持 | 说明 |
|---|---|---|
| DSH | ✅ 内置 MCP 客户端（`dsh-mcp-client`） | DSH 可消费外部 MCP 服务器工具 |
| Codex | ✅ | 原生 MCP 支持 + headless API |
| Claude Code | ✅ | 原生 MCP + SDK |

结论：**未来接任何新 agent 只有两条路**——实现 `AgentAdapter`（深度集成）或暴露 MCP server（轻量接入）。两者都只需几十到几百行，不动手机端协议与网关核心。

---

## 6. 模态层（语音对话，v2）

**核心原则：会话层永远是文本；语音只是 I/O 模态。**

```
手机 ──音频帧(Opus/WebRTC)──▶ 网关模态层
                              ├─ ASR（语音→文本）→ session.prompt（文本）
                              └─ TTS（文本→语音）← assistant/message 等事件
```

- **前端协议扩展**：新增 `server-request` 帧 `audio/output`（TTS 片段）与 `client-request` 帧 `audio/input`（音频分片），或直接走 WebRTC 媒体通道；会话层消息（`user/message`、`assistant/*`）形状不变。
- **SpeechProvider 可插拔接口**（网关侧）：

```ts
interface SpeechProvider {
  transcribe(audio: AudioChunk, ctx): Promise<string>;   // ASR
  synthesize(text: string, voice: VoiceId): AsyncIterable<AudioChunk>; // TTS
}
```

- **声学模型部署自由**：本地（Whisper.cpp / sherpa-onnx，隐私好）或云端 API；换模型只换 SpeechProvider 实现。
- **"对话式交流"**：全双工 WS 已具备；语音助手态 = 模态层持续 ASR + 会话层按端点词触发/打断，无需改适配器。

---

## 7. 安全设计（威胁模型与对策）

| 威胁 | 后果 | 对策 |
|---|---|---|
| 公网入口被匿名访问 | 任何人可驱动 DSH 在笔记本上执行工具（RCE） | MFA + 设备注册 + 限速 + 封禁（§4.3） |
| 中间人窃听/篡改 | 泄露凭据与会话内容 | 全链路 TLS；网关与 DSH 隧道加密 |
| `trustedHosts` 误当认证 | 重绑/伪造 Host 头 | 明确分层：`trustedHosts` 只防重绑，认证在网关 |
| 设备丢失 | 会话被接管 | 设备吊销、会话 Cookie 短期、远程强制登出 |
| DSH 升级破坏协议 | 网关失联/错乱 | 协议版本矩阵 + 适配器版本锁 + 回归测试基线（§3） |
| 恶意 agent 工具调用 | 数据破坏 | DSH 侧既有审批机制经网关透传（approval/requested）；网关侧策略叠加 |

---

## 8. 核心数据模型（TypeScript 草案）

```ts
// 会话路由
interface GatewaySession {
  id: string;                       // 手机可见的 gatewaySessionId
  backend: string;                  // 'dsh' | 'codex' | 'claude-code'
  backendSessionId: string;         // 后端原生会话 id
  agentPreset?: string;             // DSH agent 预设
  state: 'idle' | 'running' | 'waiting-approval' | 'waiting-question' | 'done';
  createdAt: number; lastActiveAt: number;
}

// 适配器配置（存网关 secrets 存储）
interface AdapterConfig {
  baseUrl?: string;                 // DSH /api 基址（经隧道）
  trustedHost?: string;             // 写入 DSH --trusted-host 的权威
  codex?: { cwd: string; apiMode: 'remote-control' | 'mcp' };
  claudeCode?: { transport: 'sdk' | 'mcp-http'; url?: string };
}

// 前端协议信封（网关对外，v1）
type GatewayRpcMessage =
  | { type: 'client-request';  rpcId: string; method: string; payload: unknown }
  | { type: 'server-response'; rpcId: string; result: RpcResult<unknown> }
  | { type: 'server-request';  rpcId: string; method: string; payload: unknown }
  | { type: 'client-response'; rpcId: string; result: RpcResult<unknown> };
```

---

## 9. 实施路线图

| 阶段 | 内容 | 交付物 | 依赖 |
|---|---|---|---|
| **Phase 0** | 隧道（frp/ssh -R）+ Caddy TLS + 简单口令；手机浏览器直接访问 DSH Web UI | 先解决"随时随地能连" | 现有开源件 |
| **Phase 1** | 网关骨架：认证（MFA）+ 会话路由 + 前端协议 v1；**DSH Adapter**（官方 `/api` 协议）；PWA 手机壳 | 核心闭环：手机 → 网关 → DSH | Phase 0 隧道 |
| **Phase 2** | Codex Adapter、Claude Code Adapter；会话级后端切换；多设备并发（官方队列） | 多 agent 能力 | Phase 1 |
| **Phase 3** | 模态层：ASR/TTS + 全双工音频；可选 DSH 内插件（路线 B）暴露深度能力 | 语音对话 | Phase 1/2 |

建议 Phase 1 优先实现以下测试基线（与官方 Web 前端对齐）：
`session.create → session.prompt → 事件流(assistant/chunk,tool/call) → approval/requested → /api/respond → 会话 resume`。

---

## 10. 风险与未决问题

1. **DSH 协议未版本化**（`host.describe` 无 protocolVersion）：**该风险已发生**——DSH 0.1.2 一次性改掉上行端点/信封/认证/事件流（见文首补充与附录 E），旧适配器整条链路失效。
   对策：协议面收在单个适配器内（换版本只改 `adapter/dsh/*`）；升级 DSH 前跑回归基线（`gateway/test/probe-live.ts` 直连探针、`gateway/test/e2e-dsh.ts` 网关端到端）；
   版本不符时从 HTTP 状态码暴露（401=认证未就绪、403=Host 未被信任、404=端点不存在）。这仍是本项目**最大技术风险**。
2. **`events.mux` 的 `since` 参数 v1 未实现**：断线重连 = 重开流 + 重拉 history，网关需实现该语义并承担重放成本。
3. **社区插件质量参差**（调查报告 §一.E 的 ⚠️ npm 包）：本项目尽量只用官方协议直连 + 少量经审阅的开源件（隧道、TLS、认证参考），核心层自研。
4. **待决策**：语音模态走"网关内 ASR/TTS"还是"手机端本地 ASR"（隐私 vs 延迟）；Codex/Claude Code 运行位置（网关 vs 笔记本）；是否 Phase 3 引入 DSH 内插件（路线 B）。
5. **多 agent 会话互操作**：不同后端的会话历史格式不一，跨后端"继续同一话题"需要网关层的上下文摘要/搬运——v1 不做，记录为扩展点。

---

## 附录 A：DSH `/api` 端点速查（55 unary + respond）

见 §3.3 `RpcMethodMap` 全表。实现文件：`dsh-host-apiproxy/lib/types/api/rpc-map.d.ts`。

## 附录 B：事件词汇速查

- Mux 帧：`session/subscribed` `session/event` `approval/requested` `approval/resolved` `question/requested` `question/resolved` `session/queue` `session/jobs` `session/projection`。
- SessionEvent（`session/event` 内）：见 §3.4 全表。

## 附录 C：RPC 错误码（封闭联合）

```
bad-request  cancelled  session-not-found  model-unavailable  session-conflict
invalid-time-zone  workspace-attach-failed  workspace-not-found  workspace-invalid-path
workspace-name-conflict  workspace-move-invalid  directory-unreadable  directory-exists
directory-create-failed  directory-picker-unavailable  agent-preset-read-only  agent-preset-locked
agent-preset-conflict  agent-preset-not-found  agent-preset-invalid  agent-busy  attachment-error
queue-item-not-found  steer-unavailable  command-error  unknown-command  settings-rejected
settings-conflict  credential-rejected  model-discovery-failed  title-invalid  fork-unavailable
subagent-parent-unavailable  subagent-not-found  subagent-catalog-diagnostic  subagent-not-resumable
subagent-unauthorized  subagent-delivery-unavailable  internal
```

## 附录 D：参考项目（仅作借鉴，不直接依赖）

- 认证/网关：BotonJ/dsh-remote-link（Cookie 会话、设备注册、限速）
- 认证思路：xgone/dsh-remote（账号密码 + TOTP MFA）
- 手机壳：saya-ch/dsh-mobile（Android）、hongshuxifan321/dsh-mobile-app（PWA 通用客户端）
- 隧道：frp / cloudflared / `ssh -R`（通用件）；wikdd/dsh-remote-access-web（frpc 驱动参考）
- 多 agent 编排参考：NanmiCoder/dsh-agent-teams（DSH 内 agent 团队插件）

## 附录 E：DSH 0.1.2+（Typert Remote）协议差异速查

以下均为 2026-09 在本机 `@deepseek-ai/dsh 0.1.5-rc.1` 实测核实（源码为准，`dsh-typert-protocol` / `dsh-api-gateway` /
`dsh-api-session-controller` / `dsh-api-workspace-controller` / `dsh-api-remotes`）。

| 维度 | 0.1.1 | 0.1.2+ |
|---|---|---|
| unary 端点 | `POST /api/<ns>.<method>` | `POST /api/<ns>/<method>`（HTTP 层强校验 `method === endpoint`） |
| 请求信封 | `{type:'client-request',rpcId,method,payload}` | `{type:'client-request',rpcId,method,payload:{args}}`（`payload` 必须恰好一个 plain-object `args`） |
| args 键名 | 按方法形参 | 生成描述符的 wire 名：多数是 `request`，`session/list` 是 **`_request`** |
| 认证 | 无（仅 trustedHosts 栅栏） | **强制浏览器会话 cookie**：`GET /?token=<launch-token>` → 303 + `Set-Cookie: dsh-auth-<hash>`；cookie 绑定 Host authority |
| 事件下行 | `events.mux`（WS） | `WS /api/remote.mux`，帧 `{type:'open',streamId,endpoint,payload:{args}}` → 服务端 `{type:'item',streamId,value}` / `{type:'end'}` / `{type:'error'}`；同 socket 重复 streamId 会被 close 1008 |
| 全局事件流 | — | `$events`（开流 args 必须为 `{}`），首帧 `{type:'ready',clientId,host}`；waterfall 帧带 `eventId`、`agentId`（= sessionId）；应答 `POST /api/$events/result`，args 为 `{clientId,eventId,outcome}` |
| 会话增量 | `session/event` 推送 | `session/follow`（快照 `snapshot{events,hasMore}` + 增量 `event{type,seq,time,data}`；开窗参数 `maxMessages`/`assistantStream`；历史翻页走 `session/page`） |
| 工作区 | — | `workspace/follow`（`baseline`/`upsert`/`remove`/`order`/`archived`） |
| 审批 | `approval/requested` + `/api/respond` | `$events` waterfall `approval/request` → 应答 value `'allowed-once'\|'rejected'\|'cancelled'\|'unavailable'`；**应答后不再有 resolved 事件**（需适配器本地合成） |
| 提问 | `question/requested` | `$events` waterfall `user-questions/request` → `{answers:[{id,selected:string[],custom?}]}` |
| 发消息 | — | `session/prompt` 必填客户端铸造的 `requestId` |
| 建会话 | — | `session/create` 的 `workspaceId` 与 `cwd` **互斥**（同时给报 bad-request） |

PC 端自动上报 launch token：从 DSH stdout 抓 `dsh web: http://127.0.0.1:<port>/?token=<token>`，
再 `POST https://<服务器>:<gwPort>/api/dsh/launch-token`（头 `x-dsh-agent-key` = 绑定串 `frpToken`），
网关热更新 token 并重建连接（DSH 重启即自愈，无需重新部署）。
