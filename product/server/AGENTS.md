# 服务器端工作记忆

## 适用范围与优先级

本文件仅约束 `product/server/**`，包括网关源码、内置隧道服务端和 Linux 部署脚本。开始服务器任务前阅读它；接口或配对流程变更还必须阅读 [../README.md](../README.md) 的跨端契约。不要从 PC/Android 代码反推服务器认证或部署行为。

## 当前实现

- 网关核心位于 `gateway/`：Node.js ESM + 原生 TypeScript 源码，生产构建为 `gateway/dist/app.mjs`；Node 基线为 18+。
- 托管入口/加密账号库/按 PC 隔离运行时在 `gateway/src/hosted/`，共享 WS 在 `gateway/src/server/`；旧 `gateway/src/auth/` 仅供旧基线测试，生产 App 不挂载它，会话路由在 `gateway/src/session/`，DSH、Codex 与 mock 适配器在 `gateway/src/adapter/`。
- 内置 WSS 隧道服务端在 `gateway/src/tunnel/`；它是 PC 出站隧道的对端，不依赖对公网开放 DSH 端口。
- `install.sh` 负责首次安装与运行时配置，`deploy.sh` 负责 Git 拉取、构建、健康检查、失败回滚；两者必须来自同一提交。
- 持久配置在 `/etc/batona-gateway`，数据与部署状态在 `/var/lib/batona-gateway`，运行应用在 `/opt/batona-gateway/app`；更新时不得误删配置或数据。

## 托管接入发布边界

托管 v0.2.0 已于 2026-09-22 获准切换生产；Batona Gateway 0.3.0 是源码中的改名目标，尚未据此迁移或核验生产运行目录、systemd 单元、部署命令与 Nginx include。执行任何生产部署前，必须先按 [hosted-access-operations.md](hosted-access-operations.md) 完成联合迁移，不能直接把新的 Batona 路径当成线上现状。管理员密钥与 AES-GCM 主密钥分开保存在配置目录的受保护文件，账号库 `access.vault` 在首次持久化变更后保存至数据目录（空账号时可能尚无文件）。损坏/缺少主密钥时停止，不创建空库或替代密钥。每个 PC 的隧道、适配器、路由与推送域独立；失效授权在 HTTP、WS 输入/输出及隧道连接时检查。

## 已登记生产服务器（脱敏）

最近核验：2026-09-22 20:04（网关 v0.2.0，部署 commit `793af05`，工作树为 detached HEAD）。这是改名前生产基线，并不是 Batona 运行标识已迁移的证据；此段只记录运维定位信息，**不得**加入私钥、连接串、令牌、账号密码、设备令牌或证书私钥。

- SSH 目标：本机 SSH 别名 `dsh-server`，对应 `root@117.72.10.87`。认证依赖本机已有的专用部署密钥；不得将其复制至仓库或服务器工作树。
- 代码：工作树为 `/www/wwwroot/117.72.10.87/26-009DSHlink`，远程为 `git@gitee.com:li-jinhang7/26-010-dshplugin.git`，跟踪 `main`，并且只稀疏检出 `product/server`。
- 运行时：应用 `/opt/batona-gateway/app`；配置与服务器登记 `/etc/batona-gateway`；持久数据与部署回滚状态 `/var/lib/batona-gateway`；systemd 服务为 `batona-gateway` 与 Nginx。历史 `frps` 服务已停用，不是当前链路依赖。
- HTTPS：宝塔主虚拟主机 `/www/server/panel/vhost/nginx/117.72.10.87.conf`；首页静态根目录为 `/www/wwwroot/117.72.10.87/00-001WebMainIndex`，对应本机 `D:\_Projects\00-001WebMainIndex`。DSH 反代 include `/www/server/panel/vhost/nginx/proxy/117.72.10.87/batona-gateway.conf` 使用 [nginx-batona-gateway-routes.conf](nginx-batona-gateway-routes.conf)：`/api/`、`/ws`、`/tunnel`、`/healthz` 及 `/access-admin`（含 JS/CSS）转发至 `127.0.0.1:3090`；旧 `/remote/` 返回 410。80 端口仅重定向至 HTTPS；`/pair.html` 保持 404。
- 网络：443 是唯一网关公网 TLS 入口；内置 WSS 隧道经 `/tunnel` 连接。3080、3081、3082 与 3090 仅供服务器回环使用，7500 与 7000 不得对公网开放；`frps` 已停用。云安全组中遗留的 7000 规则应在下次云控制台维护时关闭。
- 日常只读核验：`batona-deploy --status`、`curl -k https://127.0.0.1/healthz`、`systemctl is-active batona-gateway nginx`。日常更新用 `batona-deploy`，代码回退用 `batona-deploy --rollback`。

### 首页与下载站点

WebMainIndex 负责面向用户的首页及后续 PC/Android 下载入口；后台网关继续承担认证、RPC 和隧道。更新首页时保留客户端接口的路径、端口、WebSocket 升级头以及既有其他项目的反代规则。DSH 全站 `location /` 反代会遮住首页，应使用上述分流配置。

2026-09-22 已恢复首页，并同步本机 WebMainIndex 的 `index.html`、`scripts/index.js`、`data/updates.json`。切换前备份在服务器 `/var/backups/dsh-homepage/20260922-134152/`，包括原 DSH include 和这三个静态文件。此次仅平滑重载 Nginx，网关与 frps 的 PID 均保持不变；已核验首页文件哈希、静态依赖、HTTP→HTTPS、未授权接口响应、`/ws` 101 握手以及 `/remote/`。未进行真实手机登录或模型调用。既有 `/Easyplay/` 和 `/RateConverter/` 在切换前后均为 502，应作为独立上游问题排查。

修改 Nginx 后先运行 `nginx -t`，再平滑重载并复核首页和上述客户端接口。首页/路由回退使用该备份；`batona-deploy --rollback` 只回退网关应用，不恢复站点配置。

## 服务器获取与更新代码

服务器不需要 Android、PC、文档或发布产物。首次接入时，在服务器以 root 身份使用部署公钥对 monorepo 做 **sparse checkout**，工作区只检出 `product/server/**`：

```bash
git clone --filter=blob:none --no-checkout git@gitee.com:<你的用户名>/<仓库名>.git /www/wwwroot/117.72.10.87/26-009DSHlink
cd /www/wwwroot/117.72.10.87/26-009DSHlink
git sparse-checkout init --cone
git sparse-checkout set product/server
git checkout main
```

`deploy.sh` 仍在这个 monorepo 工作区的根目录执行，能够读取同一提交内的 `product/server/deploy.sh`、`install.sh` 和 `gateway/`，但不会把 `product/android/`、`product/pc/` 检出到服务器工作树。

已有完整检出的服务器可在确认工作区没有本地改动后，于仓库根目录运行 `git sparse-checkout init --cone` 与 `git sparse-checkout set product/server` 转为同样布局；之后运行 `batona-deploy --status` 确认状态。

日常更新只执行 `batona-deploy`（初次安装便利命令前用 `bash product/server/deploy.sh`）；**不要先手工 `git pull`，也不要直接调用 `install.sh --update`**。`batona-deploy` 会拉取目标版本、快进工作树、以同一提交安装网关，校验 `/healthz` 与 systemd，并在失败时自动回滚。可用 `batona-deploy --status` 查看状态，或用 `batona-deploy --rollback` 回退上一次成功部署。

### 首次生产接入

服务器必须使用 Gitee 私有仓库的**只读部署公钥**。以 root 在服务器生成专用 key（例如 `~/.ssh/gitee_dsh`），将公钥配置为该仓库的只读部署公钥，并在 `~/.ssh/config` 为 `gitee.com` 指定该 `IdentityFile`；先以 `ssh -T git@gitee.com` 验证连通，再执行上面的 sparse checkout。不要把个人可写 SSH key 或任何连接串密钥复制到服务器工作树。

第一次安装在仓库根目录执行：

```bash
bash product/server/deploy.sh --status
bash product/server/install.sh --install
```

安装完成后创建 `/usr/local/bin/batona-deploy` 包装命令，内容只执行固定工作树中的 `bash product/server/deploy.sh "$@"`。它不是软链接，避免切换旧 commit 时失效。托管首次安装会生成权限为 600 的 `access-admin.key` 与 `access-vault.key`，不输出值。管理员从受控终端读取管理员密钥并进入 `/access-admin`；手机通过 PC 配对。旧版迁移不能直接重跑首次安装。

### 发布、版本与回滚

发布网关前，本地在 `product/server/gateway/` 至少运行 `npm run typecheck`、`npm run smoke`、`npm run tunnel-protocol`、`npm run tunnel`；改隧道时还运行 PC 的 `test/tunnel-protocol.test.js`。递增 `gateway/package.json` 的 `version`，提交并推送，建议为可回退版本打 tag。服务器运行 `batona-deploy` 后，它会将 Git 目标版本与 `/healthz` 返回的版本比对；版本不一致、服务不活动、健康检查或堆上限检查失败都会自动回滚。

`batona-deploy --tag <tag-or-commit>` 部署指定版本；`batona-deploy --rollback` 根据 `/var/lib/batona-gateway/.deploy-state` 回到上次成功部署。同一托管版本的代码回退使用 `batona-deploy --rollback`，保留当前账号库，防止恢复已经撤销的授权。认证代际变化要联合回退程序、配置、数据与 Nginx，不能只退代码；新版无 FRP 模式。

### 内置隧道与宝塔/Nginx

生产已确认 Windows PC 使用内置隧道；日常仅核验状态：

```bash
bash product/server/install.sh --tunnel status
```

PC 通过 443 的 `/tunnel` 出站连接，服务器 3080/3081/3082 只绑定回环；7000 不参与当前链路。3080、3081、3082、3090 均不能对公网放行。

在宝塔或 Nginx 中，按 [nginx-batona-gateway-routes.conf](nginx-batona-gateway-routes.conf) 将客户端接口分流到 `http://127.0.0.1:3090`；首页由 WebMainIndex 提供。接口反代必须保留 WebSocket 头：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

防火墙与云安全组放行 443，保留证书验证/HTTP 跳转所需 80；关闭 7000。2026-09-22 实测续签已生效：IP SAN 匹配，Let's Encrypt YR2，至 2026-09-29 02:44:20 UTC 有效；Node 与 Android 默认 CA 校验通过。用户负责本次续签，自动续期仍未独立核验。不能固定叶证书指纹；`curl -k` 只能诊断，不能作为 TLS 验收。

### 运行排错与仓库卫生

常用只读排查：`batona-deploy --status`、`journalctl -u batona-gateway -n 50 --no-pager`、`bash product/server/install.sh --tunnel status`。`git fetch` 失败先检查部署公钥和网络；工作区脏或无法快进时先确认服务器没有需要保留的热修，再按脚本提示处理，`--force` 只用于明确接受覆盖时。`npm ci` 失败通常是本地 `package.json` 与 lock 不同步，应在本机更新 lock 后提交，不要把临时依赖状态留在线上。

Git 永不提交 `frpc.toml`、frpc/exe、APK、PC `dist/`、`node_modules/`、网关 `dist/` 或 Android `local.properties`；发布二进制与凭据都不属于源码。历史回放异常或服务器 OOM 时，检查网关是否读取 DSH 返回的 `events`、是否聚合/限制历史，以及 systemd 是否仍带 `--max-old-space-size=512`。

## 端内约束

- 会话模型须经 `AgentSessionRef.model` → `GatewaySession.model` 透传；Codex 取 PC `thread/read` 的模型，DSH 取公开 `modelSelection.next/lastUsed` 投影，只复制模型字段。模型缺失时清除旧快照，不用模型目录猜测。`node test/session-model.ts` 覆盖桥→适配器→路由及投影白名单。

- 服务器只做 TLS 后的认证、会话路由、协议适配和隧道转发。不得把 Agent、LLM 或工具执行迁到服务器，也不能令服务器主动接入用户内网 PC。
- 托管 Codex adapter 的 `baseUrl` 由该 PC 运行时分配为服务器动态回环端口，隧道目标仍是 PC 的 3082；PC 需具备桥和可枚举的 App Server。不能把 3082 加入公网监听或安全组，也不能用 `codex exec` 代替桌面会话控制。
- 公网入口只应为反向代理后的 TLS；网关服务监听 `127.0.0.1:3090`，各 PC 的动态隧道端口只绑定回环。`trustedHosts` 不是认证；管理员、账号与设备授权严格分域。
- 不记录或回显账号密码、连接串、`agentKey`、launch token、TOTP 秘钥或设备令牌。更改认证、限速、吊销或数据结构时要考虑已有数据的迁移与失效策略。
- 跨端 RPC、连接串、二维码、launch-token 上报和隧道帧以 `../README.md` 的跨端契约为准。修改协议须同步检查 Android 与 PC 的兼容性，并保持旧客户端的明确行为。
- 部署更改必须维持：从同一 Git commit 安装 `install.sh` 与 `gateway/`、健康检查版本一致、失败自动回滚、配置/数据保留。不要用手工 tar 覆盖流程替代 `deploy.sh`。

## 验证

在 `product/server/gateway/` 运行：

```bash
npm run typecheck
npm run build
npm run smoke
npm run tunnel-protocol
npm run tunnel
```

涉及安装或部署脚本时，还应在隔离环境验证 `--status`、部署和回滚路径。真实 DSH 探针会调用模型，不得纳入常规 CI 或无意执行。

## 相关资料

- [gateway/README.md](gateway/README.md)：网关模块、适配器与测试细节。
- [../README.md](../README.md)：跨端架构、绑定、隧道与联调契约。
- [../docs/需求-Batona远程接入网关.md](../docs/需求-Batona远程接入网关.md)：需求依据。
