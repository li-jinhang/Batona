# Batona Gateway（Phase 1 MVP）

DeepSeek Harness 手机远程接入网关 —— 手机通过**公网服务器上的网关**远程操控**笔记本上的 DSH**。
服务器只做转发（认证 / 会话路由 / 协议翻译），**agent、LLM 调用、工具执行全部留在笔记本**。

关联文档：
- [`../../docs/需求-Batona远程接入网关.md`](../../docs/需求-Batona远程接入网关.md) — 需求（PRD）
- [`../../README.md`](../../README.md) — 跨端架构、绑定与协议契约
- [`../../docs/调查-DSH手机远程操控插件.md`](../../docs/调查-DSH手机远程操控插件.md) — 开源方案盘点

## 架构

```
手机（PWA） ──TLS──▶ 网关（公网服务器:443）
                        │ 认证(MFA) · 会话路由 · 适配器
                        ▼
                  AgentAdapter 契约（新增后端 = 新增适配器）
                        ├─ dsh   （官方 /api 协议：HTTP unary + WS 下行 + respond）
                        └─ mock  （测试 / 扩展性演示）
                              │ 出站隧道（frp / ssh -R / cloudflared）
                              ▼
                        笔记本 DSH（loopback:3080）
```

## 快速开始（开发模式，Mock 后端）

```bash
cd gateway
npm install
cp config.example.json config.json   # 修改 admin 密码
npm start                             # node src/app.ts（需 Node ≥24，原生 TS）
# 生产/服务器部署（Node ≥18 即可）：
npm run build                         # esbuild → dist/app.mjs
npm run start:prod                    # node dist/app.mjs
```

浏览器打开 `http://127.0.0.1:3090`：
1. 用 config.json 里的账号登录（首次登录会返回 `otpauthUri`，用 Authenticator 录入；再登录一次输入动态码完成 TOTP 绑定）；
2. 「＋ 新会话」→ 在输入框发消息（含 `[ask]` 会触发提问剧本）→ 观察流式输出 → 点「允许一次」审批。

> Mock 后端可完整走通：建会话 → 对话 → 审批 → 提问 → 工作区 → 模型 → 历史 → 断线重连。

## 接入真实 DSH

1. 笔记本上启用 DSH 并通过隧道暴露（网关在公网，笔记本在 NAT 后需**出站**隧道，如 frp / `ssh -R` / cloudflared），使网关能访问 `http://127.0.0.1:3080`（隧道回环）或直连地址；
2. 若网关非回环访问 DSH，须在 DSH 侧声明可信权威：
   ```bash
   dsh web --trusted-host <网关地址> --port 3080
   # 或在 cordis.patch.yml 的 trustedHosts 中声明
   ```
3. 配置网关：
   ```json
   {
     "agentKey": "<与 PC 端约定的共享密钥>",
     "adapters": { "dsh": { "enabled": true, "cfg": { "baseUrl": "http://127.0.0.1:3080" } } }
   }
   ```
   或环境变量：`DSH_BASE_URL=http://127.0.0.1:3080 DSH_AGENT_KEY=<key> npm start`；
4. **DSH 0.1.2+ 的 launch token**：`/api` 与 `/api/remote.mux` 强制浏览器会话认证，token 每个进程随机生成且不落盘。
   Batona PC 会在 DSH 启动时抓取并上报：`POST /api/dsh/launch-token`，头 `x-dsh-agent-key: <agentKey>`，体 `{"token":"…"}`；
   网关热更新 token 并重建连接。未配 `agentKey` 时该端点返回 404（通道关闭）。云上部署由 `install.sh` 自动用 frp token 填充 `agentKey`，无需手工配置；
   无法自动上报时可用配置项 `cfg.authToken` 写死一个静态 token（DSH 重启即失效，仅作兜底）。
5. 生产部署：网关置于 **Caddy/Nginx TLS 之后**，仅暴露 443；`--trusted-host`/`trustedHosts` 只是防重绑栅栏，**认证由网关完成**（账号密码 + TOTP + 设备注册 + 限速）。

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `3090` | 监听地址（生产放 Caddy 后，勿直接绑 0.0.0.0） |
| `dataDir` | `./data` | auth.json（用户/设备/令牌哈希）持久化目录 |
| `webDir` | `./web` | PWA 静态资源 |
| `auth.initialUser` | 无（首启随机生成并打印） | 初始账号 |
| `adapters.*.enabled` | mock 开 / dsh 关 | 后端适配器开关 |
| `agentKey` | 空（通道关闭） | PC 上报 DSH launch token 的共享密钥（`x-dsh-agent-key`） |
| `webPush` | `null` | 可选 Web Push 配置；默认关闭，公钥与私钥文件路径应位于受保护目录 |

### iOS PWA Web Push

生产部署只在用户主动订阅后为该账号登记 iPhone 的 Apple Push 订阅。服务器推送只包含 `approval`、`question`、`completed` 或 `failed` 事件类别，不发送会话、工具、账号或问题正文。仅允许 HTTPS `*.push.apple.com` 订阅端点；404/410 会清除过期订阅，手机退出、电脑解绑手机及管理员禁用账号也会清理订阅。

部署网关代码后，以受控服务器终端运行一次 VAPID 密钥初始化脚本：

```bash
cd /www/wwwroot/117.72.10.87/26-009DSHlink
node product/server/gateway/scripts/init-web-push.mjs \
  /etc/batona-gateway/config.json \
  /etc/batona-gateway/web-push \
  'mailto:<实际运维邮箱>'
```

脚本会将密钥放入给定目录（权限 0700；密钥文件权限 0600），把文件路径与 VAPID subject 写入配置，并在首次修改前保存 `config.json.before-web-push`。重复运行会保留现有密钥；不匹配或位于受保护目录外的路径会被拒绝。不要把密钥文件、配置备份或私钥复制进 Git、静态网站或普通日志。账号库含有订阅密钥材料；VAPID 私钥应与 `/var/lib/batona-gateway/access.vault` 一起备份和恢复，遗失私钥会使已有订阅无法投递。

完成后平滑重启 Gateway，并用 HTTPS 健康检查核验服务恢复。部署主机须能通过出站 HTTPS 访问 Apple Push 服务。真实 iPhone 的 Web Push 投递、主屏幕安装及通知点击仍须按 iOS PWA 验收清单在设备上验证；浏览器端自动化不会证明 Apple 实机投递。

## 前端协议 v1 速查（WebSocket /ws?token=…）

四象限 RPC 信封（对齐 DSH 官方消息模型）。上行 `client-request` 方法：

| 方法 | 载荷要点 |
|---|---|
| `auth.hello` | `{protoVersion, token?}` → 服务端信息 / 适配器清单 |
| `session.list` / `session.create` / `session.resume` | 会话管理（create 支持 backend/agentPreset/workspacePath/model） |
| `session.prompt` | `{sessionId, parts[], queueAction}`（文本 + base64 图片） |
| `session.cancel` / `session.history` | 取消 / 历史（归一化 AgentEvent[]） |
| `interaction.pendingList` | `{}` → `{interactions: ServerRequest[]}`；返回当前网关进程内尚未解决的审批/提问帧，供已认证客户端重连后恢复 |
| `respond` | `{sessionId, serverRequestRpcId, payload}` — 审批 `{outcome}` / 提问 `{answer}` |
| `workspace.list` / `workspace.create` | 工作区（DSH: workspace.*；目录需已存在） |
| `model.list` / `model.select` | 模型目录 / 会话级选择 |
| `session.permissionPresetList` / `session.permissionPresetSelect` | DSH 当前会话原生权限预设；只读 DSH 投影并只允许固定三档，完全访问需二次确认 |
| `device.list` / `device.revoke` | 设备管理（吊销后令牌立即失效） |

下行 `server-request` 推送：`session/event`（归一化 AgentEvent，包含 DSH 权限预设状态更新）、`approval/requested`（可应答）、`question/requested`（可应答）。

## 测试

```bash
npm run typecheck   # tsc --noEmit
npm run smoke       # Mock 会话、工作区、模型与协议端到端断言
npm run test:hosted # Hosted 配对、隔离、数据保护与 Push 生命周期
npm run test:web-push-keys # VAPID 生成、幂等、保密输出与路径约束

# 需真实 DSH 的回归探针（显式传 launch token，会真实调用模型，故不进 CI）
node test/probe-live.ts <launch-token> http://127.0.0.1:3080 basic|approval|question
node test/e2e-dsh.ts   <launch-token> http://127.0.0.1:3080 3095
```

## 目录结构

```
src/
├─ proto/        四象限 RPC 信封 + RpcResult/错误码 + 协议版本
├─ auth/         scrypt 密码 + TOTP(RFC6238) + 设备注册 + 限速
├─ adapter/
│  ├─ contract.ts   AgentAdapter 统一契约（核心扩展点）
│  ├─ registry.ts   适配器注册表
│  ├─ mock/         测试后端（18 项冒烟测试依赖）
│  └─ dsh/          DSH 官方 /api 协议：types / client(HTTP) / downlink(WS) / adapter
├─ session/       gatewaySession ↔ 后端会话路由 + 事件扇出
├─ server/        HTTP（静态+登录）+ WS（信封分发+推送）
└─ app.ts         入口
web/              PWA 手机壳（登录/会话/对话/审批/工作区/模型/设备）
test/smoke.ts     端到端冒烟测试
```

## 安全提醒（FR-21~26）

- 网关必须置于 TLS 之后；公网 IP 会被持续扫描；
- 启用 TOTP；设备丢失后立即在「设备」页吊销；
- `trustedHosts` 不是认证 —— 认证只发生在网关；
- DSH 官方协议未版本化，升级 DSH 后先跑 `npm run smoke` 与协议回归基线（设计文档 §10）。

## 路线图（对应需求文档 §9）

- ✅ **Phase 1（本次）**：网关骨架（认证/会话路由/协议 v1）+ DSH/Mock 适配器 + PWA + 冒烟测试
- ⏳ Phase 2：Codex / Claude Code 适配器、会话级后端切换（FR-31~36）
- ⏳ Phase 3：语音模态（ASR/TTS、SpeechProvider 可插拔，FR-41~44）
