# DSH Link — 产品化三端

> 手机 App 随时随地操控笔记本上的 DeepSeek Harness；配置全部收敛到软件内。
> 绑定协议见 [docs/绑定协议.md](docs/绑定协议.md)。

## 拓扑

```
手机 App ──HTTPS──▶ 服务器（网关 + 内置隧道服务端） ◀──WSS 隧道── PC 软件（DSH web）
```

- **agent / LLM / 工具执行全部在 PC**；服务器（2核2G 足够）只跑 Node 网关（内置隧道服务端同进程）；
  灰度期可回退 frps（见 docs/服务器部署-git.md「内置隧道切换」），稳定后再彻底移除；
- 绑定：服务器安装输出连接串 `dsh-gw://IP?frpToken=…&gwUser=…&gwPass=…&pair=…`，
  PC 软件粘贴/扫码 → 自动起隧道；手机扫 PC 二维码 → 自动填充登录 → 绑定完成。

## 目录

| 端 | 位置 | 交付物 |
|---|---|---|
| 服务器 | [server/install.sh](server/install.sh) | 首次安装脚本；日常更新用 [server/deploy.sh](server/deploy.sh)（宝塔终端运行） |
| PC（Win11） | [pc/](pc/) | Electron 软件（本机构建验证通过） |
| 手机（Android） | [android/](android/) | 原生 Kotlin+Compose 工程（本地构建 APK） |
| 协议 | [docs/绑定协议.md](docs/绑定协议.md) | dsh-gw:// 连接串 + 配对流程 + 三端契约 |

## 快速开始

### 1. 服务器（一次性，之后只跑更新）

```bash
# 代码从 Gitee 私有仓库 clone 到 /www/wwwroot/117.72.10.87/26-009DSHlink
# 首次接入（部署密钥 + clone）见 docs/服务器部署-git.md
cd /www/wwwroot/117.72.10.87/26-009DSHlink
bash product/server/install.sh --install --ip 你的公网IP --admin admin --password 强密码
# 输出连接串（PC/手机绑定用）；服务自启，systemd 托管
```

更新（频繁迭代场景，数据/配置保留）：

```bash
git push                # 本机：提交并推送（先递增 gateway/package.json 的 version）
dsh-deploy              # 服务器：拉取 + 构建 + 校验，失败自动回滚
dsh-deploy --status     # 部署状态 + 服务/工作区/3080 安全核查
dsh-deploy --rollback   # 回退到上一次成功部署的版本
```

完整流程见 **[docs/服务器部署-git.md](docs/服务器部署-git.md)**。

### 2. PC 软件（Windows 11）

```powershell
cd product/pc
npm install
npm start                 # 开发运行
npm run dist              # 打包安装包（NSIS + 便携版，输出 dist/）
```

首次使用：粘贴服务器安装输出的连接串（或摄像头扫服务器页二维码）→ 软件自动
启动 DSH（未运行时）与 frpc 隧道 → 生成手机配对二维码。frpc.exe 首次自动下载
（GitHub；慢可设 `$env:DSHLINK_FRP_MIRROR` 或用 `npm run fetch-frpc` 预下载）。

验证：`npm run smoke`（主进程启动自检）。

### 3. 手机 App（Android）

用 **Android Studio** 打开 `product/android/` → Sync（首次会下载 Gradle/依赖）→
Build → Build APK(s)，安装到手机。

- 首次打开：扫 PC 软件的配对二维码（或粘贴连接串）→ 自动绑定服务器与账号 →
  输入 TOTP（首次需在 Authenticator 录入 otpauthUri）→ 进入主页；
- 功能：会话（新建/恢复/历史/流式对话/审批/提问）、工作区、模型切换、设备管理；
- 安全：连接串含网关账号密码，请妥善保管；吊销设备在「设备」页一键完成。

## 服务器更新流程（用户高频场景）

代码托管在 **Gitee 私有仓库**（单仓 monorepo，三端同仓）。日常发布两步：

1. 本机：改 `product/server/gateway/` → 递增 `gateway/package.json` 的 `version` →
   `git add -A && git commit && git push`（pre-push 钩子自动跑 typecheck + build）；
2. 服务器：`dsh-deploy` —— git 拉取 → 替换 `/opt/dsh-gateway/app` → `npm ci` + 构建 →
   重启 → 比对 `/healthz` 版本号 → 不符则**自动回滚**；
   `/etc/dsh-gateway`（配置/连接串）与 `/var/lib/dsh-gateway`（账号/设备数据）**不丢失**；
3. 手机/PC 无需重新绑定（frpToken 保留）。

> 旧流程（本机 `tar` 打包 → 宝塔文件管理器上传 → 服务器解压后 `install.sh --update`）已废弃。
> 它的问题是 `install.sh` 与 `gateway/` 分属两条上传路径，容易版本错位——沿用服务器上的旧
> `install.sh` 会让 systemd 限堆配置静默丢失。现在两者同一 commit，且部署脚本会独立复核该配置。

发布用二进制（PC 安装包 83MB / APK 20MB）**不入 git**，将由服务器静态目录托管分发（下一阶段）。

## 安全要点

- 服务器防火墙：**内置隧道模式下只需放行 443**（隧道走 wss，复用网关端口）；灰度期 frp 回退模式另需 7000；
  **3080/3081 任何模式下都严禁对公网开放**；
- 内置隧道把 3080/3081 只绑在服务器的 **127.0.0.1**（frps 时代是 `*:3080` 通配绑定，靠防火墙兜底）；
- 网关监听 127.0.0.1:3090，TLS 由宝塔/Nginx 反代终结；无域名用自签证书（手机需信任）；
- 认证 = 账号密码 + TOTP；设备可远程吊销；`trustedHosts` 不是认证。

## 与既有产物的关系

- `server/gateway/` 是网关核心（Node）；本产品化使用其构建产物 `dist/app.mjs`；
- 仓库为单仓 monorepo：`server` / `pc` / `android` / `docs` 同仓管理，三端共享
  [docs/绑定协议.md](docs/绑定协议.md) 一份契约，改动可原子提交、单个 tag 锁定三端一致版本。
