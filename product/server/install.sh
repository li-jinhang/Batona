#!/usr/bin/env bash
# ============================================================================
# DSH Link — 服务器端一键安装 / 升级脚本（Ubuntu/Debian，宝塔环境）
#
# 用法：
#   bash install.sh --install [--ip 公网IP] [--admin 用户名] [--password 密码]
#   bash install.sh --update  [--source 网关包路径或URL]
#   bash install.sh --status
#   bash install.sh --show-binding            # 仅 root 在受控终端显式导出绑定串
#   bash install.sh --tunnel on|off|status   # 内置隧道（自研）与 frps 的切换；on 会停用 frps
#   bash install.sh --selfsigned <公网IP>   # 无域名时生成自签证书（含 IP SAN）
#   bash install.sh --uninstall
#
# 注意：日常更新不要直接调 --update，请用同目录的 deploy.sh —— 它负责从 git 取
#   指定版本、校验部署结果并在失败时自动回滚。--update 是它的底层执行体。
#   直接调 --update 只会用当前工作区的代码，没有版本校验与回滚保护。
#
# 设计目标（用户硬性要求）：
#   - 宝塔终端一条命令安装；之后全部 GUI 操作
#   - 支持频繁更新：--update 幂等重部署，保留数据(/var/lib/dsh-gateway)与配置(/etc/dsh-gateway)
#   - 绑定凭据仅保存在 root 可读配置；日常安装/更新日志绝不输出连接串
#
# 目录布局：
#   /opt/dsh-gateway/app     网关代码（每次更新整体替换）
#   /etc/dsh-gateway/        config.json + server-info.json（保留）
#   /var/lib/dsh-gateway     数据（auth.json 等，保留）
#   /usr/local/frp           frps（极少更新）
# ============================================================================
set -euo pipefail

APP_DIR="/opt/dsh-gateway/app"
CONF_DIR="/etc/dsh-gateway"
DATA_DIR="/var/lib/dsh-gateway"
FRP_DIR="/usr/local/frp"
FRP_VERSION="${FRP_VERSION:-0.68.0}"
GATEWAY_DEFAULT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gateway"

INFO_FILE="$CONF_DIR/server-info.json"
CONFIG_FILE="$CONF_DIR/config.json"

# ── 参数解析 ───────────────────────────────────────────────────────────
ACTION=""
IP=""
ADMIN="admin"
PASSWORD=""
SOURCE=""
TUNNEL_MODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --install) ACTION="install" ;;
    --update)  ACTION="update" ;;
    --status)  ACTION="status" ;;
    --show-binding) ACTION="show-binding" ;;
    --selfsigned)
      ACTION="selfsigned"
      IP="${2:-}"
      shift
      ;;
    --tunnel)
      ACTION="tunnel"
      TUNNEL_MODE="${2:-}"
      shift
      ;;
    --uninstall) ACTION="uninstall" ;;
    --ip)      IP="$2"; shift ;;
    --admin)   ADMIN="$2"; shift ;;
    --password) PASSWORD="$2"; shift ;;
    --source)  SOURCE="$2"; shift ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
  shift
done

[ -z "$ACTION" ] && { echo "用法: bash install.sh --install | --update | --status | --show-binding | --tunnel on|off|status | --uninstall" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] && { echo "请用 root 运行" >&2; exit 1; }

log() { echo ">>> $*"; }
err() { echo "!!! $*" >&2; }

# ── 工具函数 ───────────────────────────────────────────────────────────
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "unknown" ;;
  esac
}

info_get() {
  # 从 server-info.json 读字段；文件不存在返回空（不触发 set -e）
  if [ -f "$INFO_FILE" ]; then
    node -e "const s=require('$INFO_FILE');process.stdout.write(String(s['$1']??''))" 2>/dev/null || true
  fi
}

# 列出某端口上"非回环"的监听地址（输出为空 = 未对公网开放）。
# 必须覆盖 frps 的通配绑定：它绑的是 `*:3080` 而非 `0.0.0.0:3080`，
# 早先只匹配 0.0.0.0/:: 的写法对这种绑定会漏报成 [OK]。
public_bind_on() {
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ":$1\$" | grep -vE '^127\.' || true
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' 2>/dev/null; then
    log "Node $(node --version) OK"
    return
  fi
  log "安装 Node.js 24（NodeSource）"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
  else
    err "需要 Node ≥18，请手动安装"; exit 1
  fi
}

ensure_frps() {
  # 二进制缺失时才下载；已存在则跳过下载（支持手动放置后重跑）
  if [ ! -x "$FRP_DIR/frps" ]; then
    local arch; arch="$(detect_arch)"
    [ "$arch" = "unknown" ] && { err "不支持的架构"; exit 1; }
    log "下载 frps v${FRP_VERSION} (${arch})"
    mkdir -p "$FRP_DIR" /etc/frp
    local url="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${arch}.tar.gz"
    # 镜像支持：FRP_MIRROR=https://mirror.ghproxy.com/ （前缀 + 原完整 URL）
    if [ -n "${FRP_MIRROR:-}" ]; then
      url="${FRP_MIRROR%/}/${url#https://}"
    fi
    if ! curl -fL --retry 5 --retry-all-errors --connect-timeout 20 -o /tmp/frp.tar.gz "$url"; then
      err "frp 下载失败（网络原因）。两种处理："
      err "  1) 用镜像重跑：FRP_MIRROR=https://mirror.ghproxy.com/ bash install.sh --install ..."
      err "  2) 手动下载后重跑（脚本会自动跳过下载）："
      err "     cd /tmp && curl -fL -o frp.tar.gz https://mirror.ghproxy.com/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${arch}.tar.gz"
      err "     tar xzf frp.tar.gz && mkdir -p ${FRP_DIR} && cp frp_${FRP_VERSION}_linux_${arch}/frps ${FRP_DIR}/frps && chmod +x ${FRP_DIR}/frps"
      exit 1
    fi
    tar xzf /tmp/frp.tar.gz -C /tmp
    cp "/tmp/frp_${FRP_VERSION}_linux_${arch}/frps" "$FRP_DIR/frps"
    chmod +x "$FRP_DIR/frps"
    rm -rf /tmp/frp.tar.gz "/tmp/frp_${FRP_VERSION}_linux_${arch}"
  else
    log "frps 二进制已存在：$FRP_DIR/frps（跳过下载）"
  fi

  # 服务已运行则跳过配置
  if systemctl is-active --quiet frps 2>/dev/null; then
    log "frps 服务已运行，跳过"
    return
  fi

  # token 必须已存在于 server-info（install 流程先写入）；兜底再生成并写回
  local token; token="$(info_get frpToken)"
  if [ -z "$token" ]; then
    token="$(openssl rand -hex 16)"
    node -e "const f='$INFO_FILE';const fs=require('fs');const s=JSON.parse(fs.readFileSync(f,'utf8'));s.frpToken='$token';fs.writeFileSync(f,JSON.stringify(s,null,2))"
  fi
  cat > /etc/frp/frps.toml <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "${token}"
# frp v0.68+ 默认支持 TLS；force 才是服务端只接受 TLS 的有效配置键。
transport.tls.force = true
webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "$(openssl rand -hex 8)"
EOF
  chmod 600 /etc/frp/frps.toml

  cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server (DSH Link)
After=network.target
[Service]
Type=simple
ExecStart=/usr/local/frp/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now frps
  log "frps 已启动"
}

deploy_gateway() {
  local src="$1"
  if [ -z "$src" ] || [ ! -d "$src/src" ]; then
    err "网关源码目录无效: ${src:-（空）}（应包含 src/ 与 package.json）"
    exit 1
  fi
  log "部署网关代码 → $APP_DIR"
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR"
  cp -r "$src/." "$APP_DIR/"
  rm -rf "$APP_DIR/node_modules"

  # 完整安装（含 esbuild 等 devDependency，构建需要）
  #
  # npm ci 而非 npm install：严格按 package-lock.json 安装，结果可复现；
  # package.json 与 lock 不一致时快速失败，而不是静默装出与本地不同的依赖树。
  # 国内机器默认走 npmmirror，避免每次部署都在 npm 官方源上耗时（可用 NPM_REGISTRY 覆盖）。
  local registry="${NPM_REGISTRY:-https://registry.npmmirror.com}"
  local install_cmd="npm ci"
  if [ "${NPM_CI:-1}" = "0" ]; then
    # 应急退路：lock 与 package.json 不同步而线上急需修复时
    #   NPM_CI=0 bash install.sh --update
    install_cmd="npm install"
  fi

  if ! (cd "$APP_DIR" && $install_cmd --registry="$registry" && npm run build); then
    err "网关依赖安装或构建失败。"
    err "  若为 npm ci 报 package.json 与 package-lock.json 不同步："
    err "    在本机 product/server/gateway 下执行 npm install 更新 lock 并提交后重试；"
    err "    或在服务器上临时退化为 npm install：NPM_CI=0 bash install.sh --update"
    exit 1
  fi
  log "网关构建完成"
}

write_gateway_config() {
  local admin="$1" pass="$2"
  # DSH 0.1.2+ 的 /api 需浏览器会话认证：网关用 DSH 进程的 launch token 模拟 cookie 交换。
  # token 由 PC 端自动上报（POST /api/dsh/launch-token）；这里只留一个静态回退，
  # 需要时用 DSH_AUTH_TOKEN 指定（如 DSH 跑在别的机器、无法自动上报）。
  local auth_token="${DSH_AUTH_TOKEN:-}"
  # 上报通道的共享密钥：直接复用 frpToken（PC 绑定串里已有），免额外配置
  local agent_key; agent_key="$(info_get frpToken)"
  cat > "$CONFIG_FILE" <<EOF
{
  "host": "127.0.0.1",
  "port": 3090,
  "dataDir": "$DATA_DIR",
  "webDir": "$APP_DIR/web",
  "agentKey": "$agent_key",
  "tunnel": { "enabled": false, "services": { "dsh": 3080, "dir": 3081 }, "maxStreams": 128 },
  "auth": { "initialUser": { "username": "$admin", "password": "$pass" } },
  "adapters": {
    "mock": { "enabled": false },
    "dsh": { "enabled": true, "cfg": { "baseUrl": "http://127.0.0.1:3080"${auth_token:+, "authToken": "$auth_token"} } }
  }
}
EOF
  chmod 600 "$CONFIG_FILE"
}

# 读取 config.json 的 tunnel.enabled（true/false；读不到按 false）
gateway_tunnel_enabled() {
  [ -f "$CONFIG_FILE" ] || { echo "false"; return; }
  node -e '
    const fs=require("fs");
    try { const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.tunnel&&c.tunnel.enabled?"true":"false"); }
    catch(e){ process.stdout.write("false"); }
  ' "$CONFIG_FILE" 2>/dev/null || echo "false"
}

# 写 tunnel.enabled（只改这一个键，其余原样保留；失败返回非 0）
set_gateway_tunnel_flag() {
  local want="$1"   # true|false
  node -e '
    const fs=require("fs");
    const f=process.argv[1], want=process.argv[2]==="true";
    const c=JSON.parse(fs.readFileSync(f,"utf8"));
    c.tunnel = Object.assign({ services: { dsh: 3080, dir: 3081 }, maxStreams: 128 }, c.tunnel||{}, { enabled: want });
    fs.writeFileSync(f, JSON.stringify(c,null,2)+"\n");
  ' "$CONFIG_FILE" "$want" && chmod 600 "$CONFIG_FILE"
}

ensure_gateway_config_keys() {
  # 升级场景专用：config.json 已存在时不会整体重写（要保留密码等），
  # 但**新增的配置项必须补上**，否则新功能在已安装的服务器上是静默关闭的。
  #
  # 具体案例：agentKey 是 DSH launch token 上报通道的共享密钥。缺省时网关日志会打印
  #   [gateway] DSH launch token 上报通道：未配置 agentKey，已关闭
  # 而 PC 端仍在往 /api/dsh/launch-token 上报 → 被 404 拒绝 → DSH 0.1.2+ 的
  # 会话认证链断裂，表现为手机端拿到 401/历史为空。
  # 老版本 install.sh 没有这个配置项，所以从旧版本升级上来的机器必然缺它。
  [ -f "$CONFIG_FILE" ] || return 0

  local key; key="$(info_get frpToken)"
  if [ -z "$key" ]; then
    err "server-info.json 缺少 frpToken，跳过 agentKey 补写"
    return 0
  fi

  # 已存在且非空则不动（可能被有意改过），仅提示差异
  if node -e '
      const fs=require("fs");
      let c; try { c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch(e){ process.exit(2); }
      if (c.agentKey) { process.exit(0); } else { process.exit(1); }
    ' "$CONFIG_FILE" 2>/dev/null; then
    local cur; cur="$(node -p 'require(process.argv[1]).agentKey||""' "$CONFIG_FILE" 2>/dev/null || echo '')"
    if [ "$cur" != "$key" ]; then
      log "agentKey 已存在且与 frpToken 不同（保留现值，若 PC 端上报被拒请手工对齐）"
    fi
    return 0
  fi

  if node -e '
      const fs=require("fs");
      const f=process.argv[1], key=process.argv[2];
      const c=JSON.parse(fs.readFileSync(f,"utf8"));
      c.agentKey=key;
      fs.writeFileSync(f, JSON.stringify(c,null,2)+"\n");
    ' "$CONFIG_FILE" "$key" 2>/dev/null; then
    chmod 600 "$CONFIG_FILE"
    log "已补写 agentKey（DSH launch token 上报通道开启）"
  else
    err "agentKey 补写失败，请手工在 $CONFIG_FILE 加入 \"agentKey\": \"<frpToken>\""
  fi
}

ensure_gateway_tunnel_key() {
  # 升级场景：给老机器补 tunnel 配置块（**默认关闭**）。
  # 为什么不默认打开：老服务器上 frps 正占着 0.0.0.0:3080/3081，网关若同时去绑回环同端口会 EADDRINUSE。
  # 切换到内置隧道由显式命令完成：bash install.sh --tunnel on
  [ -f "$CONFIG_FILE" ] || return 0
  if node -e 'const c=require(process.argv[1]); process.exit(c.tunnel?0:1)' "$CONFIG_FILE" 2>/dev/null; then
    return 0
  fi
  if node -e '
      const fs=require("fs");
      const f=process.argv[1];
      const c=JSON.parse(fs.readFileSync(f,"utf8"));
      c.tunnel={ enabled:false, services:{ dsh:3080, dir:3081 }, maxStreams:128 };
      fs.writeFileSync(f, JSON.stringify(c,null,2)+"\n");
    ' "$CONFIG_FILE" 2>/dev/null; then
    chmod 600 "$CONFIG_FILE"
    log "已补写 tunnel 配置（默认关闭；启用内置隧道：bash install.sh --tunnel on）"
  else
    err "tunnel 配置补写失败，请手工在 $CONFIG_FILE 加入 \"tunnel\": {\"enabled\":false,\"services\":{\"dsh\":3080,\"dir\":3081},\"maxStreams\":128}"
  fi
}

ensure_gateway_service() {
  cat > /etc/systemd/system/dsh-gateway.service <<'EOF'
[Unit]
Description=DSH Link Gateway
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/dsh-gateway/app
# 2GB 机器：限制 Node 堆，避免 DSH 大 history 回放时 OOM（默认堆约 1GB 会超）
Environment=NODE_OPTIONS=--max-old-space-size=512
ExecStart=/usr/bin/node --max-old-space-size=512 dist/app.mjs
Environment=GATEWAY_CONFIG=/etc/dsh-gateway/config.json
Restart=always
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable dsh-gateway
  systemctl restart dsh-gateway

  # 等待网关就绪后再判定。
  # 不能只 sleep 2 探一次：网关在绑定 HTTP 端口之前会先建立 DSH 事件流连接
  # （remote.mux / remote.host），若 DSH 侧不可达（例如 PC 端 frpc 隧道未连），
  # 重连循环会让端口绑定推迟到约 8~10 秒 —— 单次探测会把它误判为部署失败。
  # 这里最多等 30 秒，每 2 秒探一次，成功即返回。
  local ready=0 i
  for i in $(seq 1 15); do
    if curl -fsS --max-time 3 http://127.0.0.1:3090/healthz >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done

  if [ "$ready" = "1" ]; then
    local gw_ver
    gw_ver="$(node -p "try{require('/opt/dsh-gateway/app/package.json').version}catch(e){'unknown'}" 2>/dev/null || echo unknown)"
    log "网关健康检查 OK（网关版本 v${gw_ver}）"
  else
    err "网关未通过健康检查（已等待 30 秒）：journalctl -u dsh-gateway -n 30"
    exit 1
  fi
}

print_binding() {
  local ip="$1"
  local token; token="$(info_get frpToken)"
  local admin; admin="$(info_get gwUser)"
  local pass; pass="$(info_get gwPass)"
  local pair; pair="$(info_get pair)"
  # 网关 HTTPS 端口（宝塔反代端口；默认 443，非标准的如 8443 用 GW_PORT 或 server-info.gwPort）
  local gwPort; gwPort="${GW_PORT:-$(info_get gwPort)}"; [ -z "$gwPort" ] && gwPort="443"

  local conn="dsh-gw://${ip}?frpPort=7000&gwPort=${gwPort}&frpToken=${token}&gwUser=${admin}&gwPass=${pass}&pair=${pair}"

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  DSH Link 绑定连接串（PC 软件 / 手机 App 扫码或粘贴）"
  echo "════════════════════════════════════════════════════════════"
  echo "  ${conn}"
  echo ""
  echo "  仅限受控 root 终端；请勿粘贴到聊天、日志或仓库。"
  echo "════════════════════════════════════════════════════════════"
  echo ""
}

remove_legacy_pair_page() {
  # 旧版会把完整连接串写进随网关公开提供的 pair.html。该页面并非绑定所必需：
  # PC/Android 仍可通过受控渠道导入连接串，故升级时立即移除历史文件。
  local legacy="$APP_DIR/web/pair.html"
  if [ -f "$legacy" ]; then
    rm -f "$legacy"
    log "已移除旧版公开绑定页"
  fi
}

binding_stored_notice() {
  log "绑定凭据已保存在 root-only 配置；日常日志不回显。需要时仅在受控 root 终端运行：bash install.sh --show-binding"
}

# ── 内置隧道切换（--tunnel on|off|status）───────────────────────────────

wait_gateway_health() {
  local i
  for i in $(seq 1 15); do
    if curl -fsS --max-time 3 http://127.0.0.1:3090/healthz >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

healthz_tunnel_enabled() {
  curl -fsS --max-time 5 http://127.0.0.1:3090/healthz 2>/dev/null | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const j=JSON.parse(s); process.stdout.write(j.tunnel && j.tunnel.enabled ? "true" : "false"); }
      catch(e){ process.stdout.write("unknown"); }
    });
  ' 2>/dev/null || echo unknown
}

ports_in_use_tunnel() {
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':(3080|3081|3082)$' || true
}

rollback_to_frps() {
  err "→ 自动回退到 frps 模式…"
  set_gateway_tunnel_flag false || true
  systemctl enable --now frps 2>/dev/null || true
  systemctl restart dsh-gateway 2>/dev/null || true
  if wait_gateway_health; then err "已回退，线上服务恢复（frps 模式）"; else err "回退后网关仍未就绪，请 journalctl -u dsh-gateway -n 50 排查"; fi
}

set_tunnel_mode() {
  local mode="$1"
  case "$mode" in
    on)
      log "切换内置隧道：启用（将停用 frps）"
      log "  前置确认：PC 端 DSH Link 须已升级到含内置隧道的版本——旧版只会 frpc，frps 停用后无法连接。"
      cp -f "$CONFIG_FILE" "$CONFIG_FILE.bak" 2>/dev/null || true
      # 顺序是刻意的：先写 config 再停 frps。反过来的话，中间窗口内网关（启动时读一次 config）
      # 不会绑端口，隧道彻底不可用且无自动恢复。
      set_gateway_tunnel_flag true || { err "写入 tunnel.enabled=true 失败，未做任何改动"; exit 1; }
      systemctl stop frps 2>/dev/null || true
      systemctl disable frps 2>/dev/null || true
      sleep 1
      if [ -n "$(ports_in_use_tunnel)" ]; then
        err "3080/3081/3082 仍有监听（frps 未停干净）：$(ports_in_use_tunnel)"
        rollback_to_frps
        exit 1
      fi
      systemctl restart dsh-gateway
      if ! wait_gateway_health; then
        err "网关健康检查失败"
        rollback_to_frps
        exit 1
      fi
      local en; en="$(healthz_tunnel_enabled)"
      if [ "$en" != "true" ]; then
        err "网关未进入内置隧道模式（/healthz tunnel.enabled=${en}）"
        rollback_to_frps
        exit 1
      fi
      if [ -n "$(public_bind_on 3080)$(public_bind_on 3081)$(public_bind_on 3082)" ]; then
        err "3080/3081/3082 出现公网绑定（内置隧道应仅绑 127.0.0.1）"
        rollback_to_frps
        exit 1
      fi
      log "内置隧道已启用：3080/3081/3082 仅绑回环；frps 已停用。"
      log "  防火墙的 7000 端口现在可以关闭；PC 端会在 ≤30s 内自动切到内置隧道（无需重新绑定）。"
      ;;
    off)
      log "切换内置隧道：关闭（恢复 frps）"
      set_gateway_tunnel_flag false || { err "写入 tunnel.enabled=false 失败，未做任何改动"; exit 1; }
      systemctl enable --now frps 2>/dev/null || err "frps 启动失败，请检查 /etc/frp/frps.toml"
      systemctl restart dsh-gateway
      if ! wait_gateway_health; then err "网关健康检查失败，请 journalctl -u dsh-gateway -n 50 排查"; exit 1; fi
      local en; en="$(healthz_tunnel_enabled)"
      if [ "$en" != "false" ]; then err "网关未退出内置隧道模式（tunnel.enabled=${en}）"; exit 1; fi
      log "已恢复 frps 模式；PC 端会自动回退 frpc（无需操作）。"
      ;;
    status|"")
      echo "── 隧道模式 ──"
      echo "  config.tunnel.enabled : $(gateway_tunnel_enabled)"
      echo "  /healthz tunnel.enabled: $(healthz_tunnel_enabled)"
      for svc in dsh-gateway frps; do
        systemctl is-active --quiet "$svc" 2>/dev/null && echo "  [OK] $svc 运行中" || echo "  [--] $svc 未运行"
      done
      if [ -n "$(ports_in_use_tunnel)" ]; then
        echo "  3080/3081/3082 监听  : $(ports_in_use_tunnel | tr '\n' ' ')"
      else
        echo "  3080/3081/3082 监听  : （无）"
      fi
      ;;
    *)
      err "未知 --tunnel 参数：$mode（应为 on|off|status）"
      exit 1
      ;;
  esac
}

# ── 动作 ───────────────────────────────────────────────────────────────
case "$ACTION" in
  install)
    [ -z "$IP" ] && IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '你的公网IP')"
    log "安装开始（IP=${IP} admin=${ADMIN}）"

    # 1) 确定/生成 server-info（保留旧 frpToken，避免重装后 PC 需重新绑定）
    tok="$(info_get frpToken)"; [ -z "$tok" ] && tok="$(openssl rand -hex 16)"
    pair="$(info_get pair)"; [ -z "$pair" ] && pair="$(openssl rand -hex 4)"
    gwPass="$PASSWORD"; [ -z "$gwPass" ] && gwPass="$(info_get gwPass)"; [ -z "$gwPass" ] && gwPass="$(openssl rand -hex 8)"
    mkdir -p "$CONF_DIR"
    cat > "$INFO_FILE" <<EOF
{
  "serverIp": "$IP",
  "frpPort": 7000,
  "frpToken": "$tok",
  "gwUser": "$ADMIN",
  "gwPass": "$gwPass",
  "pair": "$pair",
  "pairExpiresAt": "$(($(date +%s) + 86400))",
  "installedAt": "$(date -Iseconds)"
}
EOF
    chmod 600 "$INFO_FILE"

    # 2) 组件安装
    ensure_node
    ensure_frps
    deploy_gateway "${SOURCE:-$GATEWAY_DEFAULT_SRC}"
    write_gateway_config "$ADMIN" "$gwPass"
    ensure_gateway_service
    remove_legacy_pair_page
    binding_stored_notice
    ;;

  update)
    log "升级网关（数据与配置保留）"
    ensure_node
    src="$SOURCE"
    if [ -z "$src" ]; then
      src="$GATEWAY_DEFAULT_SRC"
    elif [[ "$src" == http* ]]; then
      log "从 URL 拉取网关包: $src"
      curl -fL --retry 3 -o /tmp/gw.tar.gz "$src"
      rm -rf /tmp/gw-src && mkdir -p /tmp/gw-src
      tar xzf /tmp/gw.tar.gz -C /tmp/gw-src
      src="/tmp/gw-src/$(ls /tmp/gw-src | head -1)"
    fi
    deploy_gateway "$src"
    if [ ! -f "$CONFIG_FILE" ]; then
      write_gateway_config "$(info_get gwUser || echo admin)" "$(info_get gwPass || echo change-me)"
    else
      # 已安装的机器：整体保留配置，但补上新增配置项（如 agentKey、tunnel）
      ensure_gateway_config_keys
      ensure_gateway_tunnel_key
    fi
    ensure_gateway_service
    remove_legacy_pair_page
    log "升级完成"
    binding_stored_notice
    ;;

  show-binding)
    [ -f "$INFO_FILE" ] || { err "尚未找到服务器绑定资料"; exit 1; }
    print_binding "$(info_get serverIp)"
    ;;

  status)
    echo "── 服务状态 ──"
    for svc in dsh-gateway frps; do
      systemctl is-active --quiet "$svc" && echo "  [OK] $svc" || echo "  [FAIL] $svc"
    done
    echo "── 网关健康 ──"
    curl -fsS http://127.0.0.1:3090/healthz && echo "" || echo "  网关未响应"
    echo "── 隧道模式 ──"
    tun_en="$(gateway_tunnel_enabled)"
    if [ "$tun_en" = "true" ]; then
      echo "  [OK] 内置隧道已启用（frps 应为停用；3080/3081/3082 仅绑回环，7000 可关闭）"
    else
      echo "  [--] frps 模式（内置隧道未启用；切换：bash install.sh --tunnel on）"
    fi
    echo "── 安全核查（3080/3081/3082 不得对公网开放）──"
    for port in 3080 3081 3082; do
      bad="$(public_bind_on "$port")"
      if [ -n "$bad" ]; then
        if [ "$tun_en" = "true" ]; then
          echo "  [严重] $port 绑定公网（$bad），请立即封禁公网访问！"
        else
          # frp 模式下 frps 通配绑定 0.0.0.0 是已知行为，靠防火墙兜底；不当作故障报"严重"，
          # 否则灰期天天假报警，检查就没人看了
          echo "  [注意] $port 由 frps 通配绑定（$bad）——frp 模式已知行为；建议切内置隧道后关闭 7000"
        fi
      else
        echo "  [OK] $port 无公网绑定"
      fi
    done
    ;;

  tunnel)
    set_tunnel_mode "$TUNNEL_MODE"
    ;;

  selfsigned)
    ssl_ip="${IP:-}"
    [ -z "$ssl_ip" ] && ssl_ip="$(info_get serverIp)"
    [ -z "$ssl_ip" ] && { echo "用法: bash install.sh --selfsigned <公网IP>" >&2; exit 1; }
    mkdir -p /etc/nginx/ssl
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
      -keyout /etc/nginx/ssl/dsh-gateway.key \
      -out /etc/nginx/ssl/dsh-gateway.crt \
      -subj "/CN=$ssl_ip" \
      -addext "subjectAltName=IP:$ssl_ip"
    chmod 600 /etc/nginx/ssl/dsh-gateway.key
    chmod 644 /etc/nginx/ssl/dsh-gateway.crt
    log "自签证书已生成（SAN=IP:$ssl_ip）"
    log "  cert: /etc/nginx/ssl/dsh-gateway.crt"
    log "  key : /etc/nginx/ssl/dsh-gateway.key"
    log "在宝塔 SSL → 其他证书 中粘贴两者内容；手机需安装信任该证书"
    ;;

  uninstall)
    log "卸载（保留 $DATA_DIR 与 $CONF_DIR）"
    systemctl disable --now dsh-gateway frps 2>/dev/null || true
    rm -f /etc/systemd/system/dsh-gateway.service /etc/systemd/system/frps.service
    systemctl daemon-reload
    log "已停止并移除服务"
    ;;
esac
