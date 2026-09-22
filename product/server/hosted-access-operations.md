# 托管接入候选版：迁移与运维

状态（2026-09-22）：代码与隔离测试已实施；**未切换生产，未向用户发放新密钥**。本文件不是上线授权。上线需要明确停机窗口，且按末尾门槛验收。

## 使用方式

1. 管理员通过受控 SSH 终端取得 `/etc/dsh-gateway/access-admin.key`，打开 `https://117.72.10.87/access-admin`。管理员密钥只用于后台，不交给测试用户。
2. 后台生成账号并填写备注，把账号接入密钥通过受控渠道交给用户。可查看完整密钥、永久禁用、重置为新账号或删除。不要把密钥放在截图、日志、聊天记录或仓库。
3. 用户 PC 输入接入密钥登录，启动本地服务/自研隧道，打开“手机配对”。Android 输入 PC 上的配对码，PC 核对手机名称后确认。无需 admin 密码、TOTP 或旧连接串。
4. PC 设备管理可查看手机在线状态/最近连接时间、改名和解绑。换手机先解绑；换电脑登录时确认替换，再配对手机。退出账号只停止远程访问，本地 Agent 任务继续。

## 定位与秘密边界

| 内容 | 位置/规则 |
|---|---|
| SSH | `dsh-server` → `root@117.72.10.87`，使用现有专用 SSH 认证，不复制私钥 |
| 工作树 | `/www/wwwroot/117.72.10.87/26-009DSHlink`，仅 `product/server` sparse checkout |
| 运行程序 | `/opt/dsh-gateway/app`，入口 `dist/app.mjs` |
| 配置 | `/etc/dsh-gateway/config.json`：`access.adminKeyFile`、`access.vaultKeyFile` 指向下述受保护文件 |
| 后台密钥 | `/etc/dsh-gateway/access-admin.key`，独立于账号密钥 |
| 账号库加密主密钥 | `/etc/dsh-gateway/access-vault.key`，不可放入后台/客户端；丢失则无法解密库 |
| 账号库 | `/var/lib/dsh-gateway/access.vault`，AES-256-GCM 加密，包含账号、设备授权摘要、滚动计数；不保存对话正文 |
| 回滚点 | `/var/lib/dsh-gateway/.deploy-state` 仅管理代码，不是账号库备份 |
| Nginx | `/www/server/panel/vhost/nginx/117.72.10.87.conf` 引入 `proxy/117.72.10.87/dsh-gateway.conf` |
| 服务/网络 | `dsh-gateway`、Nginx；公网 443，自研 `/tunnel`；各 PC 动态端口和 3090 仅回环。FRP/7000 不参与 |

账号库和加密主密钥必须作为一组保护并备份，文件 600、目录 700、备份不放 Web 根目录。禁止缺钥后重新生成替代主密钥或把损坏库视为空库。普通代码回退保留最新账号库，以保留撤销状态。

## 首次安装与旧版迁移

全新服务器使用同一版本的 `install.sh --install`，会生成独立管理员/主密钥并写入 config，不安装 FRP，也不输出密钥。

旧生产迁移必须按以下顺序，由获得授权的操作者完成；不得用重复“首次安装”覆盖旧配置：

1. 确认候选代码已受审、提交且在服务器可获取；记录当前部署 commit、三个客户端版本和 Nginx include 的 SHA256。通知停止远程提交。
2. 在获准窗口停止网关，保持本地 DSH/Codex 不动。将当前**程序、配置、数据、systemd 单元、Nginx include**一起备份到 Web 根目录之外的 root-only 目录；记录完整恢复清单。保留现有 TLS 自动续期配置和首页分流。
3. 核验 `frps` 已停用，7000 不开放；检查 IP 证书可信且续期机制有效。
4. 从候选源码执行 `node gateway/scripts/init-access.mjs /etc/dsh-gateway/config.json /etc/dsh-gateway`（在 `product/server` 目录）。仅初始化托管配置，保存 `.pre-hosted`；旧密码/连接串不导入新账号库。脚本不会输出秘密，重复执行保持既有密钥。
5. 统一用 `dsh-deploy --tag <已批准的候选提交>` 部署；新版安装器会在替换运行目录前验证配置/密钥/FRP 停用。不要手工 `git pull` 或直接 `install.sh --update`。
6. 将同版 `nginx-dsh-gateway-routes.conf` 应用于已有 DSH include，仅变更该 include，先 `nginx -t` 再平滑重载。保留首页及其他项目反代；新增 `/access-admin` 及 JS/CSS，旧 `/remote/` 返回 410。
7. 用受控后台发一组测试资格，用候选 PC/APK 重新接入。验证下列门槛后才能发给其他人。

### 回退规则

同一托管数据版本：`dsh-deploy --rollback` 回退程序，保留当前 `access.vault` 与密钥，复核已撤销设备仍为 401。

跨旧认证/托管认证的回退：先停止网关并关闭远程入口，联合恢复对应程序、配置、数据与 Nginx，先检查再开放。**不能把较旧的账号库直接覆盖回生产并恢复被撤销资格**；若必须恢复灾备快照，应在关闭入口期间撤销其中全部设备授权并重新发放资格，再开放。旧版回退还可能恢复旧 admin/共享凭据，须单独获准并轮换/撤销旧凭据，否则保持入口关闭。`dsh-deploy --rollback` 本身不恢复站点或做这些安全迁移。

## 可信 TLS

2026-09-22 只读核验：当前证书 IP SAN 为 117.72.10.87，发行者 Let's Encrypt YR1，标准 Node HTTPS 校验成功；证书有效期 2026-09-19 至 2026-09-26（UTC）。这里记录的是当时证据，不是以后仍有效的承诺。

证书路径由宝塔 vhost 引用 `/www/server/panel/vhost/cert/117.72.10.87/fullchain.pem`。客户端依赖系统 CA，不固定短期叶证书，也不允许 TrustAll/忽略主机名。上线前检查宝塔/ACME 的自动续期任务、最近成功结果及续期后 Nginx 重载；没有证据则不开放测试。可只读执行 `openssl x509 -in <fullchain路径> -noout -issuer -dates -ext subjectAltName`，不读取/打印证书私钥。

## 验收与日常巡检

```bash
dsh-deploy --status
curl --fail https://117.72.10.87/healthz
systemctl is-active dsh-gateway nginx
ss -lntp
```

检查 `/healthz` 的 `accessMode: hosted`、版本正确；3090 及所有动态隧道端口仅监听 127.0.0.1；443 正常，7000/7500 关闭。`curl -k` 仅作诊断，不计 TLS 验收。

放行门槛：两账号同时在线无目录/会话/审批/推送串线；未认证 WS 无推送；退出、替换、重置、禁用和服务重启后旧授权仍失效；旧 `/api/auth/login` 与共享上报 API 返回 410；`/ws?token=旧令牌` 不获得权限；旧 `/remote/` 不再可用；首页和其他路由不回归。

真实 DSH 回归包含工作区/历史、发送、流式、审批和提问；Codex 验证当前支持的读取、模型/权限与状态。Desktop writer 限制仍存在，不能把 mock 成功宣传成原桌面会话写入已解决。真实模型调用、生产重启和实际凭据迁移需独立授权。

隔离重现命令、APK/PC 包与测试证据见仓库 `docs/plans/hosted-access/evidence.md`（服务器 sparse checkout 不含该目录，可在开发机阅读）。
