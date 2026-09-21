#!/usr/bin/env bash
# ============================================================================
# DSH Link — 服务器端一键部署（git 拉取 + 更新）
#
# 用法（服务器上以 root 执行）：
#   bash product/server/deploy.sh                 # 拉取当前分支最新并部署
#   bash product/server/deploy.sh --tag v0.1.31   # 部署指定 tag（或任意 commit）
#   bash product/server/deploy.sh --rollback      # 回退到上次成功部署的版本
#   bash product/server/deploy.sh --status        # 只报告状态，不做任何改动
#   bash product/server/deploy.sh --force         # 跳过"工作区无本地改动"检查
#
# 与 install.sh 的分工：
#   install.sh 负责"装什么"（Node/frps/网关/systemd/健康检查）；本脚本负责
#   "装哪一版"（从 git 取指定版本 → 调 install.sh → 校验 → 失败自动回滚）。
#   部署主体完全复用 install.sh --update，本脚本不重复实现任何部署逻辑。
#
# 为什么不再需要"用新 install.sh 覆盖旧 install.sh"：
#   旧流程里 install.sh 与 gateway/ 是两条独立上传路径，沿用服务器上的旧
#   install.sh 跑 --update，会导致新版 systemd 配置（--max-old-space-size=512）
#   静默丢失。现在两者来自同一个 commit，天然同步，该问题结构性消失。
#
# 目录布局：
#   本文件所在仓库          git 工作区（本脚本只在此 fetch/checkout）
#   /opt/dsh-gateway/app    运行时（install.sh 每次整体替换）
#   /etc/dsh-gateway        配置/连接串（保留）
#   /var/lib/dsh-gateway    数据 + 本脚本的部署状态文件（保留）
# ============================================================================
set -euo pipefail

# ── 常量 ───────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATEWAY_REL="product/server/gateway"
INSTALL_SH="$REPO_ROOT/product/server/install.sh"

STATE_DIR="/var/lib/dsh-gateway"
STATE_FILE="$STATE_DIR/.deploy-state"

BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE="dsh-gateway"
HEALTH_URL="http://127.0.0.1:3090/healthz"
SERVICE_UNIT="/etc/systemd/system/dsh-gateway.service"

# 回滚递归保护：回滚路径自身不再触发回滚
ROLLED_BACK=0

# ── 输出 ───────────────────────────────────────────────────────────────
log()  { echo ">>> $*"; }
warn() { echo "!!! $*" >&2; }
err()  { echo "!!! $*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
DSH Link — 服务器端一键部署（git 拉取 + 更新）

用法（服务器上以 root 执行）：
  bash product/server/deploy.sh                拉取当前分支最新并部署
  bash product/server/deploy.sh --tag v0.1.31  部署指定 tag（或任意 commit）
  bash product/server/deploy.sh --rollback     回退到上次成功部署的版本
  bash product/server/deploy.sh --status       只报告状态，不做任何改动
  bash product/server/deploy.sh --force        跳过"工作区无本地改动"检查

环境变量：
  DEPLOY_BRANCH=main       默认跟踪的分支
  SKIP_HEAP_CHECK=1        跳过 systemd 堆上限复核（默认必须命中）
  NPM_REGISTRY=...         传给 install.sh 的 npm 镜像

部署成功后回滚点记录在 /var/lib/dsh-gateway/.deploy-state
EOF
}

# ── 参数解析 ───────────────────────────────────────────────────────────
ACTION="deploy"
TAG=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --status)   ACTION="status" ;;
    --rollback) ACTION="rollback" ;;
    --force)    FORCE=1 ;;
    -h|--help)  usage; exit 0 ;;
    --tag)
      TAG="${2:-}"
      if [ -z "$TAG" ]; then
        die "--tag 需要一个版本号或 commit，如 --tag v0.1.31"
      fi
      shift
      ;;
    *) die "未知参数: $1（用 --help 查看用法）" ;;
  esac
  shift
done

# ── 工具函数 ───────────────────────────────────────────────────────────

# 从 stdin 的 JSON 文本中取第一个 "<key>": "<value>" 的 value。
# 纯 bash 实现：不用 sed|head，避免 pipefail 下 head 提前退出导致 SIGPIPE 误判失败。
first_field() {
  local key="$1" text
  text="$(cat)"
  case "$text" in
    *"\"$key\""*) ;;
    *) return 0 ;;
  esac
  text="${text#*\"$key\"}"
  text="${text#*:}"
  text="${text#*\"}"
  printf '%s' "${text%%\"*}"
}

# 读指定 commit 的网关版本号（不依赖 node，未部署也能读）
gateway_version_at() {
  local rev="${1:-HEAD}"
  { git -C "$REPO_ROOT" show "${rev}:${GATEWAY_REL}/package.json" 2>/dev/null || true; } \
    | first_field version
}

# 当前线上网关版本（读 /healthz，由 gateway/src/server/http.ts 提供）
health_version() {
  { curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true; } | first_field version
}

# 当前隧道模式（读 /healthz 的 tunnel.enabled；取不到按 false）
health_tunnel_enabled() {
  { curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true; } | node -e '
    let s = "";
    process.stdin.on("data", (d) => s += d).on("end", () => {
      try { const j = JSON.parse(s); process.stdout.write(j.tunnel && j.tunnel.enabled ? "true" : "false"); }
      catch (e) { process.stdout.write("false"); }
    });
  ' 2>/dev/null || echo false
}

# 部署状态文件（JSON）读写。键：currentCommit / previousCommit / version / deployedAt
state_get() {
  [ -f "$STATE_FILE" ] || return 0
  first_field "$1" < "$STATE_FILE"
}

state_write() {
  local current="$1" previous="$2" version="$3"
  mkdir -p "$STATE_DIR"
  cat > "$STATE_FILE" <<EOF
{
  "currentCommit": "${current}",
  "previousCommit": "${previous}",
  "version": "${version}",
  "deployedAt": "$(date -Iseconds)"
}
EOF
  chmod 600 "$STATE_FILE"
}

short() { echo "${1:0:7}"; }

# 列出某端口上"非回环"的监听地址（输出为空 = 未对公网开放）。
# 必须覆盖 frps 的通配绑定：它绑的是 `*:3080` 而非 `0.0.0.0:3080`，
# 早先只匹配 0.0.0.0/:: 的写法对这种绑定会漏报成 [OK]。
public_bind_on() {
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ":$1\$" | grep -vE '^127\.' || true
}

# ── 前置检查 ───────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  die "请用 root 运行（install.sh 需要 root）"
fi
if ! command -v git >/dev/null 2>&1; then
  die "未安装 git：apt-get install -y git"
fi
if ! command -v curl >/dev/null 2>&1; then
  die "未安装 curl：apt-get install -y curl"
fi
if [ ! -d "$REPO_ROOT/.git" ]; then
  die "$REPO_ROOT 不是 git 工作区。首次接入请按 product/server/AGENTS.md 的“服务器获取与更新代码”执行 clone。"
fi
if [ ! -f "$INSTALL_SH" ]; then
  die "未找到 $INSTALL_SH，仓库结构可能不完整"
fi

cd "$REPO_ROOT"

# ── --status：只报告 ───────────────────────────────────────────────────
if [ "$ACTION" = "status" ]; then
  HEAD_REV="$(git rev-parse HEAD)"
  HEAD_VER="$(gateway_version_at "$HEAD_REV")"
  STATE_REV="$(state_get currentCommit)"
  STATE_VER="$(state_get version)"
  STATE_AT="$(state_get deployedAt)"

  echo "── 部署状态 ──"
  echo "  仓库路径   : $REPO_ROOT"
  echo "  仓库 commit: $(short "$HEAD_REV")  $(git log -1 --format=%s)"
  echo "  仓库版本   : v${HEAD_VER:-未知}"
  if [ -n "$STATE_REV" ]; then
    echo "  上次部署   : $(short "$STATE_REV")  v${STATE_VER:-未知}  ${STATE_AT}"
  else
    echo "  上次部署   : （无记录 —— 尚未用本脚本部署过）"
  fi

  echo ""
  echo "── 线上服务 ──"
  if systemctl is-active --quiet "$SERVICE"; then
    echo "  [OK] $SERVICE"
  else
    echo "  [FAIL] $SERVICE"
  fi
  TUN_EN="$(health_tunnel_enabled)"
  if [ "$TUN_EN" = "true" ]; then
    if systemctl is-active --quiet frps; then
      echo "  [注意] frps 仍在运行（内置隧道已启用，属双跑；建议 bash product/server/install.sh --tunnel on 收尾）"
    else
      echo "  [OK] 隧道模式：builtin（内置，frps 已停用）"
    fi
  else
    if systemctl is-active --quiet frps; then
      echo "  [OK] 隧道模式：frp（frps 运行中）"
    else
      echo "  [FAIL] frps（未运行，且内置隧道未启用 → 隧道不可用）"
    fi
  fi
  LIVE_VER="$(health_version)"
  if [ -n "$LIVE_VER" ]; then
    echo "  线上版本   : v$LIVE_VER"
    if [ "$LIVE_VER" != "$HEAD_VER" ]; then
      echo "  [注意] 线上版本与仓库版本不一致 —— deploy.sh 可同步，deploy.sh --rollback 可回退"
    fi
  else
    echo "  [FAIL] 网关无响应（$HEALTH_URL）"
  fi

  echo ""
  echo "── 工作区 ──"
  if git diff --quiet; then
    echo "  [OK] 无未提交改动"
  else
    echo "  [警告] 以下未提交改动会阻止部署（除非 --force）："
    git status --short | sed 's/^/    /'
  fi
  if grep -q 'max-old-space-size' "$SERVICE_UNIT" 2>/dev/null; then
    echo "  [OK] systemd 已设置堆上限 --max-old-space-size=512"
  else
    echo "  [警告] systemd 未设置堆上限（2GB 机器拉大 history 时可能 OOM）"
  fi

  echo ""
  echo "── 安全核查（3080/3081 不得对公网开放）──"
  for port in 3080 3081; do
    bad="$(public_bind_on "$port")"
    if [ -n "$bad" ]; then
      if [ "$TUN_EN" = "true" ]; then
        echo "  [严重] $port 绑定公网（$bad），请立即封禁公网访问！"
      else
        # frp 模式下 frps 通配绑定是已知行为（靠防火墙兜底），不按故障报"严重"
        echo "  [注意] $port 由 frps 通配绑定（$bad）——frp 模式已知行为；建议切内置隧道后关闭 7000"
      fi
    else
      echo "  [OK] $port 无公网绑定"
    fi
  done
  exit 0
fi

# ── 工作区洁净检查（防止 pull 冲突 / 覆盖服务器上的临时热修）────────────
if [ "$FORCE" != "1" ] && ! git diff --quiet; then
  err "工作区有未提交改动，拒绝部署（避免与 git pull 冲突或覆盖临时修复）："
  git status --short | sed 's/^/    /' >&2
  err "处理方式：改动若不再需要 → git checkout -- <文件>；确需保留 → 先提交；"
  err "          确认要强制覆盖 → 重跑并加 --force"
  exit 1
fi

# 记录起点：首次部署时它就是当前线上版本，用作回滚点
START_REV="$(git rev-parse HEAD)"
OLD_STATE_COMMIT="$(state_get currentCommit)"

# ── 取目标版本 ─────────────────────────────────────────────────────────
case "$ACTION" in
  deploy)
    if [ -n "$TAG" ]; then
      log "拉取 tag/ref：$TAG"
      if ! git fetch --tags --prune origin; then
        die "git fetch 失败（无法连接 Gitee？检查网络与部署密钥）。线上未做任何改动。"
      fi
      if ! git checkout "$TAG"; then
        die "checkout $TAG 失败（该 tag/commit 不存在？）。线上未做任何改动。"
      fi
    else
      log "拉取 origin/$BRANCH"
      if ! git fetch --prune origin; then
        die "git fetch 失败（无法连接 Gitee？检查网络与部署密钥）。线上未做任何改动。"
      fi
      if ! git checkout "$BRANCH"; then
        die "checkout $BRANCH 失败（分支不存在？Gitee 默认分支是 master 时，用 DEPLOY_BRANCH=master 重跑）。线上未做任何改动。"
      fi
      if ! git merge --ff-only "origin/$BRANCH"; then
        die "无法快进到 origin/$BRANCH（本地分支有分叉）。线上未做任何改动。"
      fi
    fi
    ;;

  rollback)
    ROLLBACK_TARGET="$(state_get previousCommit)"
    if [ -z "$ROLLBACK_TARGET" ]; then
      die "没有可回滚的版本（状态文件无 previousCommit，通常是尚未成功部署过一次）"
    fi
    if [ "$ROLLBACK_TARGET" = "$START_REV" ]; then
      log "当前已在回滚目标 $(short "$ROLLBACK_TARGET")，无需操作"
      exit 0
    fi
    log "回滚到 $(short "$ROLLBACK_TARGET")（v$(gateway_version_at "$ROLLBACK_TARGET")）"
    if ! git checkout "$ROLLBACK_TARGET"; then
      die "checkout $ROLLBACK_TARGET 失败"
    fi
    ;;
esac

TARGET_REV="$(git rev-parse HEAD)"
TARGET_VER="$(gateway_version_at "$TARGET_REV")"
if [ -z "$TARGET_VER" ]; then
  die "无法从 $TARGET_REV 读取网关版本号（$GATEWAY_REL/package.json 异常）"
fi

BEFORE_VER="$(health_version)"
START_TIME="$(date +%s)"

log "部署 v${TARGET_VER}（commit $(short "$TARGET_REV")），线上当前 v${BEFORE_VER:-未知}"

# ── 回滚 ───────────────────────────────────────────────────────────────
# 部署失败时回到 previousCommit 并重装；自身失败则明确要求人工介入。
# ROLLED_BACK 保证不会二次回滚（回滚也失败时不再递归）。
rollback_to() {
  local reason="$1"
  if [ "$ROLLED_BACK" = "1" ]; then
    err "回滚后仍未通过校验（$reason），已停止自动处置，需人工介入"
    exit 1
  fi
  ROLLED_BACK=1

  local prev
  prev="$(state_get previousCommit)"
  if [ -z "$prev" ]; then
    err "部署失败（$reason），且无可用回滚点（首次部署？）"
    err "排查：journalctl -u $SERVICE -n 50 --no-pager"
    exit 1
  fi

  warn "部署失败（$reason）→ 回滚到 $(short "$prev")（v$(gateway_version_at "$prev")）"

  if ! git checkout "$prev"; then
    err "回滚 checkout 失败，需人工介入"
    exit 1
  fi
  if ! bash "$INSTALL_SH" --update; then
    err "回滚部署同样失败，需人工介入"
    err "排查：journalctl -u $SERVICE -n 50 --no-pager"
    exit 1
  fi

  # 交换 current/previous：再次 --rollback 可回到刚才失败的版本（便于对比排查）
  state_write "$prev" "$TARGET_REV" "$(gateway_version_at "$prev")"

  err "已回滚到 v$(health_version)（commit $(short "$prev")），线上服务已恢复"
  err "刚才失败的版本是 $(short "$TARGET_REV")（v$TARGET_VER）。如需回去对比：bash $0 --rollback"
  exit 1
}

# ── 部署主体：完全复用 install.sh --update ─────────────────────────────
# 不带 --source：install.sh 的 GATEWAY_DEFAULT_SRC 自动解析为
# "$(dirname install.sh)/gateway"，正是本仓库的 $GATEWAY_REL。
if ! bash "$INSTALL_SH" --update; then
  rollback_to "install.sh --update 返回失败（构建或健康检查未通过）"
fi

# ── 部署后校验 ─────────────────────────────────────────────────────────
log "校验部署结果…"

if ! systemctl is-active --quiet "$SERVICE"; then
  rollback_to "$SERVICE 服务未处于 active"
fi

ACTUAL_VER="$(health_version)"
if [ -z "$ACTUAL_VER" ]; then
  rollback_to "网关无响应（$HEALTH_URL）"
fi
if [ "$ACTUAL_VER" != "$TARGET_VER" ]; then
  rollback_to "版本不符：期望 v$TARGET_VER，实际 v$ACTUAL_VER（新代码/新脚本未真正生效）"
fi

# systemd 堆上限：旧流程中最容易静默丢失的配置，这里独立复核一次。
# 用 SKIP_HEAP_CHECK=1 可跳过（例如后续版本有意调整该策略时）。
HEAP_OK=1
if ! grep -q 'max-old-space-size' "$SERVICE_UNIT" 2>/dev/null; then
  HEAP_OK=0
  if [ "${SKIP_HEAP_CHECK:-0}" != "1" ]; then
    rollback_to "systemd 单元缺少 --max-old-space-size（旧流程的典型静默回归）"
  fi
  warn "systemd 单元缺少 --max-old-space-size，已按 SKIP_HEAP_CHECK=1 跳过"
fi

# ── 记录状态 ───────────────────────────────────────────────────────────
# 回滚点：优先用状态文件里的上一版；首次部署则用本次部署前的 HEAD。
NEW_PREV="$OLD_STATE_COMMIT"
if [ -z "$NEW_PREV" ]; then
  NEW_PREV="$START_REV"
fi
if [ "$NEW_PREV" = "$TARGET_REV" ]; then
  # 重复部署同一版本（没有新提交）时，回滚点会等于目标版本 —— 此时必须沿用
  # 原有回滚点，否则"再跑一次 dsh-deploy"就会把回滚能力悄悄清空。
  NEW_PREV="$(state_get previousCommit)"
fi
state_write "$TARGET_REV" "$NEW_PREV" "$TARGET_VER"

# ── 摘要 ───────────────────────────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TIME ))
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  部署成功"
echo "════════════════════════════════════════════════════════════"
printf "  版本    v%s → v%s\n" "${BEFORE_VER:-未知}" "$TARGET_VER"
printf "  commit  %s\n" "$(short "$TARGET_REV")"
printf "  耗时    %s 秒\n" "$ELAPSED"
printf "  回滚点  %s\n" "${NEW_PREV:-（无，本次为首个版本）}"
echo "  ── 校验 ──"
echo "  [OK] $SERVICE 服务运行中"
echo "  [OK] /healthz 版本 = v$ACTUAL_VER"
if [ "$HEAP_OK" = "1" ]; then
  echo "  [OK] systemd 堆上限 --max-old-space-size=512"
fi
echo "  [OK] 配置与数据保留（/etc/dsh-gateway、/var/lib/dsh-gateway）→ PC/手机无需重新绑定"
echo "════════════════════════════════════════════════════════════"
echo ""
if [ -n "$NEW_PREV" ]; then
  echo "  回退本次部署：bash $0 --rollback"
  echo ""
fi
