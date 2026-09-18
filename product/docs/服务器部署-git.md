# 服务器部署 — git 流程

> 本文是**服务器代码部署的唯一权威说明**。旧的手工打 tar 包上传流程已由本流程取代
> （旧流程见 [部署指导](./部署指导.md#六日常更新与维护服务器高频更新场景) 历史章节，仅作排错参考）。
>
> 相关：[部署指导](./部署指导.md) · [三端部署与构建指南](./三端部署与构建指南.md) · [宝塔操作说明](./宝塔操作说明.md)

---

## 一、概览：日常只需两条命令

```powershell
# 本地：改代码 + 提交 + 推送
cd D:\_Projects\26-009DSHplugin
git add -A && git commit -m "修复 xxx" && git push
```

```bash
# 服务器：拉取 + 部署
dsh-deploy
```

输出形如：

```
>>> 部署 v0.1.31（commit a1b2c3d），线上当前 v0.1.30
>>> 网关健康检查 OK（网关版本 v0.1.31）
════════════════════════════════════════════════════════════
  部署成功
════════════════════════════════════════════════════════════
  版本    v0.1.30 → v0.1.31
  commit  a1b2c3d
  耗时    47 秒
  回滚点  f9e8d7c
  ── 校验 ──
  [OK] dsh-gateway 服务运行中
  [OK] /healthz 版本 = v0.1.31
  [OK] systemd 堆上限 --max-old-space-size=512
  [OK] 配置与数据保留（/etc/dsh-gateway、/var/lib/dsh-gateway）→ PC/手机无需重新绑定
════════════════════════════════════════════════════════════
```

**为什么这样更好**：旧流程里 `install.sh`（部署逻辑，含 systemd 限堆配置）和 `gateway/`（业务代码）
是**两条独立的上传路径**，容易出现"代码更新了、脚本没更新"的错位——文档曾专门用加粗警告提醒，
因为沿用服务器上的旧 `install.sh` 会让 `--max-old-space-size=512` 静默丢失，表现为 2GB 机器
拉大 history 时 `JavaScript heap out of memory` 崩溃重启。现在两者来自**同一个 commit**，
且 `deploy.sh` 会在部署后独立复核该配置，这类问题结构性消失。

---

## 二、一次性接入

### 2.1 建 Gitee 私有仓库

浏览器打开 [gitee.com](https://gitee.com) → 新建仓库：

| 项 | 值 |
|---|---|
| 仓库名称 | 任意，如 `dsh-link` |
| 开源/私有 | **私有** |
| 初始化仓库 | **不勾选**任何初始化选项（本地已有代码，勾了会冲突） |

> ⚠️ 必须私有：仓库虽已排除密钥文件，但业务源码不宜公开。服务器连入的 frp 通道
> 一旦被人拿到 token，等于可以直接对笔记本 DSH 执行命令。

### 2.2 本地初始化并首次推送

> 若仓库已初始化过（`D:\_Projects\26-009DSHplugin\.git` 已存在），跳到"推送"一步。

```powershell
cd D:\_Projects\26-009DSHplugin

# ── 安全闸门：以下四条必须全绿才能 push ──────────────────────
git init
git config core.hooksPath .githooks      # 启用推送前 typecheck+build 校验

git add -A
git ls-files | grep -i frpc              # ① 必须为空 ← frpc.toml 含真实 token
git ls-files | wc -l                     # ② 预期 < 600（源码文件数）
du -sh .git                              # ③ 预期 < 20MB（漏配 .gitignore 会到 GB 级）
git check-ignore -v product/pc/frpc-bin/frpc.toml product/pc/dist product/android/app/build
                                         # ④ 三条都要命中 .gitignore

git commit -m "初始化仓库"
git branch -M main
git remote add origin git@gitee.com:<你的用户名>/<仓库名>.git
git push -u origin main
```

**闸门 ① 是硬性门槛**：`product/pc/frpc-bin/frpc.toml` 含真实 frp token 与服务器 IP，
入库即等于把笔记本 DSH 的公网入口凭证公开。若它出现在 `git ls-files` 里，
立刻 `git rm --cached product/pc/frpc-bin/frpc.toml` 并检查 `.gitignore`，
**在 push 之前**处理完（已 push 的话需改写历史，且应轮换 token）。

**闸门 ③ 超限**：说明 `.gitignore` 漏项，此时 `rm -rf .git` 重新来过成本最低。

### 2.3 服务器接入（首次）

服务器上以 root 执行（宝塔「终端」或 SSH）：

```bash
# ① 旧的手工上传目录移开备份（保留退路，确认新流程可用后再删）
mv /www/wwwroot/117.72.10.87/26-009DSHlink /www/wwwroot/117.72.10.87/26-009DSHlink-old

# ② 装 git（宝塔一般已自带）
command -v git || apt-get install -y git

# ③ 生成只读部署密钥（专用密钥，不影响服务器上其它用途的 key）
ssh-keygen -t ed25519 -f ~/.ssh/gitee_dsh -N ""
cat ~/.ssh/gitee_dsh.pub
```

把上面打印的**公钥**贴到：Gitee 仓库 → 管理 → **部署公钥管理** → 添加部署公钥 →
勾选**只读**（启用后该服务器只能拉取，无法推送或访问你的其它仓库）。

```bash
# ④ 配置 SSH 使用该密钥
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat >> ~/.ssh/config <<'EOF'
Host gitee.com
  IdentityFile ~/.ssh/gitee_dsh
  StrictHostKeyChecking accept-new
EOF
chmod 600 ~/.ssh/config

# ⑤ 验证连通（出现 "Welcome to Gitee.com" 即成功）
ssh -T git@gitee.com

# ⑥ 克隆到原路径
git clone git@gitee.com:<你的用户名>/<仓库名>.git /www/wwwroot/117.72.10.87/26-009DSHlink
```

### 2.4 首次部署 + 建便利命令

```bash
cd /www/wwwroot/117.72.10.87/26-009DSHlink

# 先空跑看状态：确认路径解析正确、能读到线上版本，不做任何改动
bash product/server/deploy.sh --status

# 正式部署（此刻仓库代码 == 线上代码，属幂等重装，版本号不应变化）
bash product/server/deploy.sh

# 建便利命令 dsh-deploy（用包装脚本而非软链，避免切到旧 commit 时链接悬空）
cat > /usr/local/bin/dsh-deploy <<'EOF'
#!/usr/bin/env bash
exec bash /www/wwwroot/117.72.10.87/26-009DSHlink/product/server/deploy.sh "$@"
EOF
chmod +x /usr/local/bin/dsh-deploy
```

之后服务器上直接：

```bash
dsh-deploy              # 部署最新
dsh-deploy --status     # 看状态
dsh-deploy --rollback   # 回滚
```

---

## 三、日常发布

```powershell
# 本地
cd D:\_Projects\26-009DSHplugin
# ① 改 product/server/gateway/ 下的代码
# ② 递增 product/server/gateway/package.json 里的 version（如 0.1.30 → 0.1.31）
# ③ 提交推送（pre-push 钩子会自动跑 typecheck + build）
git add -A && git commit -m "网关：xxx" && git push
git tag v0.1.31 && git push --tags      # 建议打 tag，便于 --tag 定版与回滚
```

```bash
# 服务器
dsh-deploy
```

### 版本号契约（重要）

`gateway/package.json` 的 `version` 是**部署验证的依据**：`deploy.sh` 读仓库里目标 commit 的版本号，
部署后再读 `/healthz` 返回的版本号，两者不一致就判定部署失败并自动回滚。

因此**每次发布必须递增 version**，否则无法区分"部署成功"与"部署了但代码没生效"。

核对命令：

```bash
curl -s http://127.0.0.1:3090/healthz        # {"ok":true,"version":"0.1.31"}
journalctl -u dsh-gateway -n 5 | grep version # [gateway] version: 0.1.31
```

---

## 四、指定版本与回滚

```bash
dsh-deploy --tag v0.1.30    # 部署到指定 tag（或任意 commit sha）
dsh-deploy --rollback       # 回退到上一次成功部署的版本
```

`--rollback` 依据 `/var/lib/dsh-gateway/.deploy-state` 里记录的 `previousCommit`，
并会在回滚成功后**交换** current/previous —— 所以再执行一次 `--rollback` 就能回到
刚才那个失败的版本，便于对比排查。状态文件长这样：

```json
{
  "currentCommit": "a1b2c3d...",
  "previousCommit": "f9e8d7c...",
  "version": "0.1.31",
  "deployedAt": "2026-09-18T14:22:05+08:00"
}
```

**自动回滚**：`deploy.sh` 在以下任一情况下会**自动**回滚并退出非零——
`install.sh --update` 失败、服务未 active、`/healthz` 无响应、版本号不符、
systemd 单元缺少 `--max-old-space-size`（可用 `SKIP_HEAP_CHECK=1` 跳过该项）。
回滚自身失败时不再递归，会明确提示需要人工介入。

**执行顺序保证**：`git fetch` 失败、工作区有未提交改动、`--ff-only` 无法快进——
这些情况都在改动线上之前就中止，不会留下半成品。

---

## 五、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `git fetch 失败（无法连接 Gitee？）` | 部署密钥没配好 / 网络不通 | 服务器上 `ssh -T git@gitee.com`；检查 `~/.ssh/config` 与 Gitee 部署公钥是否启用 |
| `工作区有未提交改动，拒绝部署` | 有人在服务器上直接改了文件 | `git status --short` 看是哪些；不需要就 `git checkout -- <文件>`；确需保留先提交；急事可 `--force` |
| `无法快进到 origin/main（本地分支有分叉）` | 服务器上产生过本地提交 | 在服务器上 `git log --oneline origin/main..HEAD` 找出多余提交，确认无用后 `git reset --hard origin/main` |
| `npm ci 报 package.json 与 package-lock.json 不同步` | 本地改了依赖没更新 lock | 本机 `cd product/server/gateway && npm install` 更新 lock 并提交；急事可 `NPM_CI=0 bash product/server/install.sh --update` |
| 部署后版本号没变 | 忘了递增 `gateway/package.json` 的 version | 递增 version 后重新推送部署 |
| 脚本报 `\r: command not found` | 换行符被转成 CRLF | 确认 `.gitattributes` 已入库且含 `*.sh text eol=lf`；服务器上 `git rm --cached -r . && git checkout .` 重新检出 |
| 部署卡在 npm 安装 | 服务器访问 npm 源慢 | 已默认走 npmmirror；如需换源 `NPM_REGISTRY=https://registry.npmjs.org dsh-deploy` |
| 服务起不来 | 代码/配置问题 | `journalctl -u dsh-gateway -n 50 --no-pager`；必要时 `dsh-deploy --rollback` |

---

## 六、仓库里不该有的东西

以下文件已在 `.gitignore` 中，**任何时候都不应出现在 `git ls-files` 里**：

| 路径 | 原因 |
|---|---|
| `product/pc/frpc-bin/frpc.toml` | 含真实 frp token 与服务器 IP —— 泄露即可远程操控笔记本 DSH |
| `product/pc/frpc-bin/frpc.exe` | 16MB 自动下载的二进制 |
| `product/pc/dist/` | Electron 打包产物，安装包 83MB；Gitee 免费仓库单文件上限 100MB |
| `product/android/app/build/` | Gradle 构建产物 |
| `product/server/gateway/dist/` | 网关构建产物（服务器侧构建，不入库） |
| `product/android/local.properties` | 含本机 SDK 绝对路径 |

**发布用二进制（exe / apk）永远不进 git**：它们由服务器静态目录托管分发
（`latest.json` 版本清单 + 下载页），下一阶段实现，仓库已预留 `tools/release/`。

随手自查：

```bash
git ls-files | grep -iE 'frpc|\.exe$|\.apk$|node_modules'   # 必须为空
```

---

## 七、与旧流程对照

| | 旧流程（tar 手工上传） | 新流程（git） |
|---|---|---|
| 本机 | `npm run build` → `tar --exclude=...` | `git push` |
| 上传 | 宝塔文件管理器拖拽 / scp | 无（git 自带） |
| 服务器 | 解压到 `/tmp/gw-new` → `bash /tmp/gw-new/server/install.sh --update` | `dsh-deploy` |
| install.sh 与代码一致性 | **靠人工保证**（文档专门警告过） | **同一 commit，天然一致** |
| 版本确认 | 肉眼看终端输出的版本号 | 自动比对 `/healthz`，不符即回滚 |
| 回滚 | 无（只能重新打包旧版上传） | `dsh-deploy --rollback` |
| 变更历史 | 无 | `git log` |
| 定版 | 无 | `git tag` + `dsh-deploy --tag` |
