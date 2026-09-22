# 服务器端工作记忆

## 适用范围与优先级

本文件仅约束 `product/server/**`，包括网关源码、内置隧道服务端和 Linux 部署脚本。开始服务器任务前阅读它；接口或配对流程变更还必须阅读 [../README.md](../README.md) 的跨端契约。不要从 PC/Android 代码反推服务器认证或部署行为。

## 当前实现

- 网关核心位于 `gateway/`：Node.js ESM + 原生 TypeScript 源码，生产构建为 `gateway/dist/app.mjs`；Node 基线为 18+。
- HTTP/WS 入口在 `gateway/src/server/`，认证/TOTP/设备管理在 `gateway/src/auth/`，会话路由在 `gateway/src/session/`，DSH、Codex 与 mock 适配器在 `gateway/src/adapter/`。
- 内置 WSS 隧道服务端在 `gateway/src/tunnel/`；它是 PC 出站隧道的对端，不依赖对公网开放 DSH 端口。
- `install.sh` 负责首次安装与运行时配置，`deploy.sh` 负责 Git 拉取、构建、健康检查、失败回滚；两者必须来自同一提交。
- 持久配置在 `/etc/dsh-gateway`，数据与部署状态在 `/var/lib/dsh-gateway`，运行应用在 `/opt/dsh-gateway/app`；更新时不得误删配置或数据。

## 已登记生产服务器（脱敏）

最近核验：2026-09-21（网关 v0.1.31，仓库 commit `bdf8c4b`）。这是当前 DSH Link 生产入口；此段只记录运维定位信息，**不得**加入私钥、连接串、FRP token、账号密码、设备令牌或证书私钥。

- SSH 目标：本机 SSH 别名 `dsh-server`，对应 `root@117.72.10.87`。认证依赖本机已有的专用部署密钥；不得将其复制至仓库或服务器工作树。
- 代码：工作树为 `/www/wwwroot/117.72.10.87/26-009DSHlink`，远程为 `git@gitee.com:li-jinhang7/26-010-dshplugin.git`，跟踪 `main`，并且只稀疏检出 `product/server`。
- 运行时：应用 `/opt/dsh-gateway/app`；配置与服务器登记 `/etc/dsh-gateway`；持久数据与部署回滚状态 `/var/lib/dsh-gateway`；systemd 服务 `dsh-gateway`、`frps`，以及 Nginx。
- HTTPS：宝塔主虚拟主机 `/www/server/panel/vhost/nginx/117.72.10.87.conf`；DSH 反代 include `/www/server/panel/vhost/nginx/proxy/117.72.10.87/dsh-gateway.conf`，将根路径转发至 `127.0.0.1:3090` 并保留 WebSocket 升级头。80 端口仅重定向至 HTTPS。
- 网络：443 是网关公网 TLS 入口；当前处于 frps 兼容模式，7000 必须保持放行。7500、3090、3080、3081、3082 不得对公网开放；确认所有 PC 客户端支持内置隧道前，不得关闭 frps 或 7000。
- 日常只读核验：`dsh-deploy --status`、`curl -k https://127.0.0.1/healthz`、`systemctl is-active dsh-gateway frps nginx`。日常更新用 `dsh-deploy`，代码回退用 `dsh-deploy --rollback`。

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

已有完整检出的服务器可在确认工作区没有本地改动后，于仓库根目录运行 `git sparse-checkout init --cone` 与 `git sparse-checkout set product/server` 转为同样布局；之后运行 `dsh-deploy --status` 确认状态。

日常更新只执行 `dsh-deploy`（初次安装便利命令前用 `bash product/server/deploy.sh`）；**不要先手工 `git pull`，也不要直接调用 `install.sh --update`**。`dsh-deploy` 会拉取目标版本、快进工作树、以同一提交安装网关，校验 `/healthz` 与 systemd，并在失败时自动回滚。可用 `dsh-deploy --status` 查看状态，或用 `dsh-deploy --rollback` 回退上一次成功部署。

### 首次生产接入

服务器必须使用 Gitee 私有仓库的**只读部署公钥**。以 root 在服务器生成专用 key（例如 `~/.ssh/gitee_dsh`），将公钥配置为该仓库的只读部署公钥，并在 `~/.ssh/config` 为 `gitee.com` 指定该 `IdentityFile`；先以 `ssh -T git@gitee.com` 验证连通，再执行上面的 sparse checkout。不要把个人可写 SSH key 或任何连接串密钥复制到服务器工作树。

第一次安装在仓库根目录执行：

```bash
bash product/server/deploy.sh --status
bash product/server/install.sh --install --ip <公网IP> --admin <管理员> --password <强密码>
```

安装完成后创建 `/usr/local/bin/dsh-deploy` 包装命令，内容只执行固定工作树中的 `bash product/server/deploy.sh "$@"`。它不是软链接，避免切换旧 commit 时失效。安装会保留/生成权限为 `600` 的 `/etc/dsh-gateway/server-info.json`；日常安装与更新绝不回显连接串。只有在 root 的受控终端明确运行 `bash product/server/install.sh --show-binding` 时才导出，不能贴入 issue、日志或 Git。

### 发布、版本与回滚

发布网关前，本地在 `product/server/gateway/` 至少运行 `npm run typecheck`、`npm run smoke`、`npm run tunnel-protocol`、`npm run tunnel`；改隧道时还运行 PC 的 `test/tunnel-protocol.test.js`。递增 `gateway/package.json` 的 `version`，提交并推送，建议为可回退版本打 tag。服务器运行 `dsh-deploy` 后，它会将 Git 目标版本与 `/healthz` 返回的版本比对；版本不一致、服务不活动、健康检查或堆上限检查失败都会自动回滚。

`dsh-deploy --tag <tag-or-commit>` 部署指定版本；`dsh-deploy --rollback` 根据 `/var/lib/dsh-gateway/.deploy-state` 回到上次成功部署。代码回滚和隧道模式回滚彼此独立：前者用 `dsh-deploy --rollback`，后者必须显式用 `install.sh --tunnel off`。

### 内置隧道与宝塔/Nginx

默认优先内置隧道，切换前先确认 PC 已升级：

```bash
bash product/server/install.sh --tunnel on
bash product/server/install.sh --tunnel status
bash product/server/install.sh --tunnel off
```

启用内置隧道后，PC 通过 443 的 `/tunnel` 出站连接，服务器 3080/3081 只绑定回环，7000 可以关闭；切到 frp 回退模式才需要 7000。无论哪种模式，3080、3081、3090 都不能对公网放行。

在宝塔或 Nginx 中，HTTPS 站点反代目标为 `http://127.0.0.1:3090`，并必须保留 WebSocket 头：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

防火墙和云安全组两层均应：放行 443；有域名签发 Let's Encrypt 时放行 80；仅在 frp 回退时放行 7000。纯 IP 不能签发 Let's Encrypt，可执行 `install.sh --selfsigned <公网IP>` 生成含 IP SAN 的自签证书，并让手机显式信任。反代或证书变更后用 `curl -k https://127.0.0.1/healthz` 验证。

### 运行排错与仓库卫生

常用只读排查：`dsh-deploy --status`、`journalctl -u dsh-gateway -n 50 --no-pager`、`journalctl -u frps -n 30`。`git fetch` 失败先检查部署公钥和网络；工作区脏或无法快进时先确认服务器没有需要保留的热修，再按脚本提示处理，`--force` 只用于明确接受覆盖时。`npm ci` 失败通常是本地 `package.json` 与 lock 不同步，应在本机更新 lock 后提交，不要把临时依赖状态留在线上。

Git 永不提交 `frpc.toml`、frpc/exe、APK、PC `dist/`、`node_modules/`、网关 `dist/` 或 Android `local.properties`；发布二进制与凭据都不属于源码。历史回放异常或服务器 OOM 时，检查网关是否读取 DSH 返回的 `events`、是否聚合/限制历史，以及 systemd 是否仍带 `--max-old-space-size=512`。

## 端内约束

- 服务器只做 TLS 后的认证、会话路由、协议适配和隧道转发。不得把 Agent、LLM 或工具执行迁到服务器，也不能令服务器主动接入用户内网 PC。
- Codex adapter 的 `baseUrl` 只能是服务器回环的 `http://127.0.0.1:3082`，并且仅在 PC 已升级、桥健康且 App Server 能枚举会话/模型/profile 后才在生产配置显式启用。不能把 3082 加入公网监听或安全组，也不能用 `codex exec` 代替桌面会话控制。
- 公网入口只应为反向代理后的 TLS；网关服务监听 `127.0.0.1:3090`，内置隧道的 3080/3081 仅绑定回环。`trustedHosts` 不是认证，认证由账号密码、TOTP 和设备令牌承担。
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
- [../docs/需求-DSH远程接入网关.md](../docs/需求-DSH远程接入网关.md)：需求依据。
