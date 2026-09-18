/**
 * DSH Link — Electron 主进程
 *
 * 职责：
 *  1. 绑定管理：dsh-gw:// 连接串解析/存储、手机配对二维码
 *  2. 服务编排：检测/启动 DSH web(3080) → 启动 frpc 隧道 → 在线状态机
 *  3. frpc 管理：下载/定位 frpc.exe、写配置、spawn 守护（崩溃重启）
 *  4. 托盘常驻 + 开机自启 + 日志
 *
 * 渲染进程通过 preload 暴露的 window.dshLink（contextBridge + IPC）与主进程通信。
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, session } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const http = require('node:http');
const QRCode = require('qrcode');
const AdmZip = require('adm-zip');

const FRP_VERSION = '0.68.0';
const DSH_HOST = '127.0.0.1';
const DSH_PORT_DEFAULT = 3080;   // DSH web 默认端口；实际端口从 stdout 的 dsh web: URL 捕获
const FRP_REMOTE_PORT = 3080;
const DIR_SERVICE_PORT = 3081;   // 目录浏览服务（读笔记本本地目录），经 frp 映射到服务器供网关代理
const DIR_REMOTE_PORT = 3081;    // frp 把该服务映射到服务器的端口（需服务器放行）

// ── 状态 ──────────────────────────────────────────────────────────────
const state = {
  binding: null,          // { serverIp, frpPort, gwPort, frpToken, gwUser, gwPass, pair, createdAt }
  dshRunning: false,
  dshPort: null,          // DSH web 实际端口
  dshToken: null,         // DSH launch token（0.1.2+ 的 /api 认证凭据，DSH 重启即变）
  dshCookie: null,        // { key, value } 用 token 换到的浏览器会话 cookie 缓存
  dshAuthed: false,       // 最近一次认证探测结果
  frpcRunning: false,
  frpcConnected: false,   // frpc 是否登录服务器成功
  frpcRestarts: 0,
  logs: [],
};

const MAX_LOG = 500;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  state.logs.push(line);
  if (state.logs.length > MAX_LOG) state.logs.shift();
  console.log(line);
}

// ── 绑定存储 ──────────────────────────────────────────────────────────
function bindingPath() {
  return path.join(app.getPath('userData'), 'binding.json');
}

function loadBinding() {
  try {
    state.binding = JSON.parse(fs.readFileSync(bindingPath(), 'utf8'));
  } catch { state.binding = null; }
  return state.binding;
}

function saveBinding(b) {
  state.binding = b;
  fs.writeFileSync(bindingPath(), JSON.stringify(b, null, 2), 'utf8');
  log(`binding saved: ${b.serverIp}`);
}

/** 解析 dsh-gw:// 连接串 → 绑定对象；格式非法返回 null */
function parseDshGw(text) {
  const t = String(text || '').trim();
  const m = /^dsh-gw:\/\/([^/?#]+)(?:\?(.*))?$/i.exec(t);
  if (!m) return null;
  const host = m[1];
  const params = new URLSearchParams(m[2] || '');
  const serverIp = host.split(':')[0];
  if (!serverIp) return null;
  const b = {
    serverIp,
    frpPort: Number(params.get('frpPort') || 7000),
    gwPort: Number(params.get('gwPort') || 443),
    frpToken: params.get('frpToken') || '',
    gwUser: params.get('gwUser') || 'admin',
    gwPass: params.get('gwPass') || '',
    pair: params.get('pair') || '',
    createdAt: Date.now(),
  };
  return b.frpToken ? b : null;
}

function connectionString(b = state.binding) {
  if (!b) return '';
  const p = new URLSearchParams({
    frpPort: String(b.frpPort),
    gwPort: String(b.gwPort),
    frpToken: b.frpToken,
    gwUser: b.gwUser,
    gwPass: b.gwPass,
    pair: b.pair,
  });
  return `dsh-gw://${b.serverIp}?${p.toString()}`;
}

// ── frpc 定位/下载 ────────────────────────────────────────────────────
function frpcCandidates() {
  return [
    path.join(app.getPath('userData'), 'frpc', 'frpc.exe'),
    path.join(__dirname, 'frpc-bin', 'frpc.exe'),
  ];
}

function findFrpc() {
  return frpcCandidates().find((p) => fs.existsSync(p)) || null;
}

/** 容错删除：Windows 杀毒可能锁定刚下载的文件，删除失败不致命 */
function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (e) { log(`(cleanup skipped: ${p} ${e.code || e.message})`); }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(() => safeUnlink(dest));
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        file.close(() => safeUnlink(dest));
        return reject(new Error(`download failed HTTP ${res.statusCode}: ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', (e) => { file.close(() => safeUnlink(dest)); reject(e); });
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}

/** 下载 frpc.exe 到 userData/frpc/；镜像可经 DSHLINK_FRP_MIRROR 指定 */
async function ensureFrpc() {
  const existing = findFrpc();
  if (existing) return existing;
  const dir = path.join(app.getPath('userData'), 'frpc');
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, `frp_${FRP_VERSION}_windows_amd64.zip`);
  const mirror = process.env.DSHLINK_FRP_MIRROR || '';
  const base = mirror
    ? `${mirror.replace(/\/+$/, '')}/v${FRP_VERSION}/frp_${FRP_VERSION}_windows_amd64.zip`
    : `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_windows_amd64.zip`;
  log(`downloading frpc: ${base}`);
  try {
    await download(base, zipPath);
  } catch (e) {
    log(`frpc 下载失败：${e.message}（可用浏览器手动下载放到 pc/frpc-bin/frpc.exe）`);
    return null;
  }
  const target = path.join(dir, 'frpc.exe');
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith('frpc.exe'));
    if (!entry) throw new Error('frpc.exe not found in archive');
    fs.writeFileSync(target, entry.getData());
  } catch (e) {
    log(`frpc 解压失败（可能是杀毒锁定刚下载的 zip）：${e.message}`);
    return null;
  } finally {
    // EPERM：杀毒/安全软件可能锁定刚下载的 zip；清理失败不影响功能
    try { fs.unlinkSync(zipPath); } catch (e) { log(`(zip 未清理: ${e.code || e.message})`); }
  }
  log('frpc ready: ' + target);
  return target;
}

// ── frpc 运行 ─────────────────────────────────────────────────────────
function writeFrpcConfig(exePath) {
  const b = state.binding;
  if (!b) return null;
  const conf = [
    `serverAddr = "${b.serverIp}"`,
    `serverPort = ${b.frpPort || 7000}`,
    '',
    'auth.method = "token"',
    `auth.token = "${b.frpToken}"`,
    '',
    '[[proxies]]',
    'name = "dsh"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${state.dshPort || DSH_PORT_DEFAULT}`,
    `remotePort = ${FRP_REMOTE_PORT}`,
    'transport.useEncryption = true',
    '',
    '[[proxies]]',
    'name = "dir"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${DIR_SERVICE_PORT}`,
    `remotePort = ${DIR_REMOTE_PORT}`,
    'transport.useEncryption = true',
    '',
  ].join('\n');
  const confPath = path.join(path.dirname(exePath), 'frpc.toml');
  fs.writeFileSync(confPath, conf, 'utf8');
  return confPath;
}

let frpcProc = null;
let frpcRestartTimer = null;

async function startFrpc() {
  if (frpcProc) return true;
  if (!state.binding) return false;
  try {
    startDirService();   // 目录服务须先于 frpc 启动，供第二条代理映射
    const exe = await ensureFrpc();
    if (!exe) { log('frpc 不可用（未下载/解压 frpc.exe），跳过启动'); return false; }
    const conf = writeFrpcConfig(exe);
    log(`starting frpc: ${exe}`);
    frpcProc = spawn(exe, ['-c', conf], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    state.frpcRunning = true;
    state.frpcConnected = false;
    frpcProc.stdout.on('data', (d) => {
      const s = String(d);
      log(`[frpc] ${s.trim()}`);
      if (/login to server success|start proxy success|success/i.test(s)) {
        const first = !state.frpcConnected;
        state.frpcConnected = true;
        // 隧道刚通：补报一次 launch token（网关可能刚重启，或上次上报时隧道还没起来）
        if (first) void reportLaunchToken();
      }
    });
    frpcProc.stderr.on('data', (d) => log(`[frpc!] ${String(d).trim()}`));
    frpcProc.on('exit', (code) => {
      log(`frpc exited (${code}), restarting in 5s...`);
      state.frpcRunning = false;
      state.frpcConnected = false;
      frpcProc = null;
      frpcRestartTimer = setTimeout(() => { void startFrpc(); }, 5000);
    });
    return true;
  } catch (e) {
    log(`frpc start failed: ${e.message}`);
    return false;
  }
}

function stopFrpc() {
  if (frpcRestartTimer) clearTimeout(frpcRestartTimer);
  frpcRestartTimer = null;
  if (frpcProc) { frpcProc.kill(); frpcProc = null; }
  state.frpcRunning = false;
}

// ── DSH 探测/启动 ─────────────────────────────────────────────────────
function dshTokenPath() {
  return path.join(app.getPath('userData'), 'dsh-token.json');
}

/** 载入上次捕获的 launch token（仅用于"重启前先探测"，DSH 重启后 token 会变） */
function loadDshToken() {
  state.dshToken = process.env.DSHLINK_DSH_TOKEN || null;
  try {
    const j = JSON.parse(fs.readFileSync(dshTokenPath(), 'utf8'));
    if (!state.dshToken) state.dshToken = j.token || null;
    state.dshPort = Number(j.port) || null;
  } catch { /* 首次运行没有缓存 */ }
}

function saveDshToken() {
  try {
    fs.writeFileSync(dshTokenPath(), JSON.stringify({ port: state.dshPort, token: state.dshToken, savedAt: Date.now() }, null, 2), 'utf8');
  } catch (e) { log(`token 缓存写入失败：${e.message}`); }
}

function dshBase() {
  return `http://${DSH_HOST}:${state.dshPort || DSH_PORT_DEFAULT}`;
}

/**
 * 用 launch token 换浏览器会话 cookie（DSH 0.1.2+：/api 与 /api/remote.mux 均强制会话认证）。
 * cookie 绑定 Host authority，因此换 cookie 与后续请求必须使用同一个 base。
 */
async function dshCookie(base, timeoutMs = 5000) {
  const key = `${base}|${state.dshToken}`;
  if (state.dshCookie && state.dshCookie.key === key) return state.dshCookie.value;
  let value = null;
  try {
    const res = await fetch(`${base}/?token=${encodeURIComponent(state.dshToken)}`, {
      redirect: 'manual',   // DSH 返回 303 + Set-Cookie，需读 header
      signal: AbortSignal.timeout(timeoutMs),
    });
    const setCookie = res.headers.get('set-cookie');
    value = setCookie ? setCookie.split(';')[0] : null;
  } catch { value = null; }
  state.dshCookie = { key, value };
  return value;
}

/**
 * 调一次 DSH 的 Typert Remote unary 端点（0.1.2+ 协议）：
 *   POST /api/<ns>/<method>，信封 {type:'client-request',rpcId,method,payload:{args}}
 * 返回 { status, body }；连不上时 status = 0。
 */
async function dshCall(method, args = {}, timeoutMs = 5000) {
  const base = dshBase();
  const headers = { 'content-type': 'application/json' };
  if (state.dshToken) {
    const cookie = await dshCookie(base, timeoutMs);
    if (cookie) headers.cookie = cookie;
  }
  try {
    const res = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'client-request', rpcId: randomUuid(), method, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  } catch { return { status: 0, body: '' }; }
}

function randomUuid() {
  return require('node:crypto').randomUUID();
}

/** TCP 端口存活探测（只判断是否有服务在监听，不做协议交互） */
function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * DSH 是否可用。0.1.2+ 起 /api 强制会话认证，未认证探测（旧的 host.describe）恒 401，
 * 所以先换 cookie 再调 session/list；拿不到 200 时退化为端口存活探测，
 * 避免把"端口上已有 DSH"误判成"没在跑"而重复拉起实例。
 */
async function detectDsh() {
  state.dshAuthed = false;
  if (state.dshToken) {
    const r = await dshCall('session/list', { _request: {} });
    if (r.status === 200) { state.dshAuthed = true; return true; }
    if (r.status === 401) state.dshCookie = null;   // token 可能已过期，下次重新交换
  }
  return portOpen(DSH_HOST, state.dshPort || DSH_PORT_DEFAULT);
}

/** DSH 启动时打印 "dsh web: http://127.0.0.1:<port>/?token=<token>" */
const DSH_WEB_LINE = /dsh web:\s*(https?:\/\/[^\s/?]+)\/?\?token=([\w.~-]+)/g;
let dshOutBuf = '';

/**
 * 从 stdout 抓 launch token：输出可能被分片，用滚动缓冲拼接后再匹配。
 * 取缓冲里**最后一次**匹配——同一 PC 会话内 DSH 重启（旧 token 行仍在缓冲里）时才能拿到新 token。
 */
function captureDshToken(chunk) {
  dshOutBuf = (dshOutBuf + chunk).slice(-4096);
  const m = [...dshOutBuf.matchAll(DSH_WEB_LINE)].pop();
  if (!m) return;
  let port = DSH_PORT_DEFAULT;
  try { port = Number(new URL(m[1]).port) || DSH_PORT_DEFAULT; } catch { /* 保持默认端口 */ }
  if (state.dshToken === m[2] && state.dshPort === port) return;
  state.dshPort = port;
  state.dshToken = m[2];
  state.dshCookie = null;
  saveDshToken();
  log(`捕获 DSH launch token（port=${port}）`);
  void reportLaunchToken();
}

let dshProc = null;

async function startDsh() {
  if (await detectDsh()) { state.dshRunning = true; return true; }
  const cmd = process.env.DSHLINK_DSH_CMD || 'dsh';
  // DSH 0.1.2+ 的 /api 有 browser-trust fence：默认只信任 loopback/LAN。
  // 网关经 frp 隧道从服务器访问（Host 为 127.0.0.1:3080），需显式声明 trusted-host 才放行。
  const defaultArgs = '--profile web --no-open --trusted-host 127.0.0.1:3080';
  const args = (process.env.DSHLINK_DSH_ARGS || defaultArgs).split(/\s+/);
  log(`starting DSH: ${cmd} ${args.join(' ')}`);
  try {
    // dsh 是 .cmd（npm 全局 bin），经 cmd 启动；Windows cmd 默认代码页 GBK，
    // 会导致 DSH 输出的 UTF-8 中文被以 GBK 渲染成乱码（锟斤拷）。先 chcp 65001 强制 UTF-8。
    const cmdLine = `${cmd} ${args.join(' ')}`;
    dshProc = spawn('cmd.exe', ['/c', `chcp 65001 >nul && ${cmdLine}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    dshProc.stdout?.on('data', (d) => {
      const s = String(d);
      log(`[dsh] ${s.trim()}`);
      captureDshToken(s);   // 0.1.2+ 的 launch token 只在这里出现一次
    });
    dshProc.stderr.on('data', (d) => log(`[dsh!] ${String(d).trim()}`));
    dshProc.on('exit', (code) => { state.dshRunning = false; log(`dsh exited (${code})`); });
    // 等待就绪：须同时拿到 launch token 且 /api 认证通过（未认证探测恒 401，不能只看端口）
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (state.dshToken && (await detectDsh())) { state.dshRunning = true; log('DSH web ready'); return true; }
    }
    log('DSH web 启动超时（可手动运行 dsh web）');
    return false;
  } catch (e) {
    log(`dsh start failed: ${e.message}（可用 DSHLINK_DSH_CMD 指定命令）`);
    return false;
  }
}

function stopDsh() {
  if (dshProc) { dshProc.kill(); dshProc = null; }
  state.dshRunning = false;
}

// ── launch token 上报 ─────────────────────────────────────────────────
const TOKEN_REPORT_INTERVAL = 5 * 60 * 1000;
let tokenReportTimer = null;

/** 发一个 JSON 请求并取回文本（服务器多为自签证书，忽略校验） */
function jsonRequest(url, method, headers, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 把 DSH 的 launch token 上报给网关：手机端连的是服务器，链路的最后一段
 * （网关 → frp → 本机 DSH）需要这个 token 换 cookie，DSH 重启即失效。
 * 认证用绑定串里的 frpToken（网关侧配置项 agentKey）。
 */
async function reportLaunchToken() {
  const b = state.binding;
  if (!b || !state.dshToken) return false;
  const url = `https://${b.serverIp}:${b.gwPort || 443}/api/dsh/launch-token`;
  try {
    const res = await jsonRequest(url, 'POST', {
      'content-type': 'application/json',
      'x-dsh-agent-key': b.frpToken,
    }, JSON.stringify({ token: state.dshToken }));
    if (res.status === 200) { log('launch token 已上报网关'); return true; }
    log(`launch token 上报被拒：HTTP ${res.status} ${String(res.body).slice(0, 120)}`);
    return false;
  } catch (e) {
    log(`launch token 上报失败：${e.message}`);
    return false;
  }
}

/** 周期兜底：网关重启或网络抖动后，无需人工干预即可恢复链路 */
function startTokenReportTimer() {
  if (tokenReportTimer) clearInterval(tokenReportTimer);
  tokenReportTimer = setInterval(() => { void reportLaunchToken(); }, TOKEN_REPORT_INTERVAL);
}

// ── 目录浏览服务（读笔记本本地目录，供手机端浏览/选择工作区路径）──────
let dirServer = null;

/** 列出某目录的磁盘挂载根（Windows 盘符）或子目录 */
function listDir(p) {
  const base = p || null;   // null → 返回盘符根
  if (!base) {
    return { path: '', roots: ['C:\\', 'D:\\', 'E:\\', 'F:\\'] };   // 常见盘符
  }
  const resolved = path.resolve(base);
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return { path: resolved, dirs: entries };
}

function startDirService() {
  if (dirServer) return true;
  try {
    dirServer = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/list') {
          const p = u.searchParams.get('p') || '';
          const data = listDir(p);
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ ok: true, ...data }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    dirServer.listen(DIR_SERVICE_PORT, '127.0.0.1', () => log(`目录服务就绪 http://127.0.0.1:${DIR_SERVICE_PORT}`));
    return true;
  } catch (e) {
    log(`目录服务启动失败: ${e.message}`);
    return false;
  }
}

function stopDirService() {
  if (dirServer) { try { dirServer.close(); } catch {} dirServer = null; }
}

// ── 状态汇总 ──────────────────────────────────────────────────────────
/** 探测 HTTPS（Node fetch 不信任自签证书，改用 https.request 并忽略证书校验） */
function probeHttps(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

async function status() {
  const dshUp = await detectDsh();
  let gatewayUp = false;
  if (state.binding) {
    const port = state.binding.gwPort || 443;
    gatewayUp = await probeHttps(`https://${state.binding.serverIp}:${port}/healthz`);
  }
  return {
    bound: !!state.binding,
    serverIp: state.binding?.serverIp || null,
    dsh: dshUp,
    dshToken: !!state.dshToken,       // 是否已捕获 launch token（未捕获则手机端链路必断）
    dshAuthed: state.dshAuthed,       // token 是否当前有效
    frpc: !!frpcProc && state.frpcConnected,
    gateway: gatewayUp,
  };
}

// ── 窗口 / 托盘 ───────────────────────────────────────────────────────
let win = null;
let tray = null;

function createWindow() {
  win = new BrowserWindow({
    width: 960, height: 680,
    minWidth: 480, minHeight: 560,
    title: 'DSH Link PC',
    icon: appIcon(),   // 任务栏/窗口图标
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

/** 应用/任务栏图标：内嵌 SVG 圆点（打包时可用 assets 目录的真实 .ico 覆盖） */
function appIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#4f8cff"/><circle cx="32" cy="32" r="12" fill="#0f1115"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function trayIcon() {
  // 托盘图标（同款圆点）
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#4f8cff"/><circle cx="16" cy="16" r="6" fill="#0f1115"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('DSH Link');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DSH Link', click: () => { if (win) win.show(); else createWindow(); } },
    { label: '状态', click: () => { if (win) win.show(); } },
    { type: 'separator' },
    { label: '退出', click: () => { stopFrpc(); stopDsh(); app.quit(); } },
  ]));
  tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
}

// ── IPC ───────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('binding:get', () => loadBinding());
  ipcMain.handle('binding:save', async (_e, text) => {
    const b = parseDshGw(text);
    if (!b) return { ok: false, error: '连接串格式无效（应为 dsh-gw://...）' };
    saveBinding(b);
    void reportLaunchToken();   // 换绑后立刻把 token 报到新服务器
    return { ok: true, binding: b };
  });
  ipcMain.handle('binding:clear', () => { stopFrpc(); state.binding = null; try { fs.unlinkSync(bindingPath()); } catch {} return { ok: true }; });
  ipcMain.handle('binding:connString', () => connectionString());
  ipcMain.handle('service:start', async () => {
    const dsh = await startDsh();
    const frpc = await startFrpc();
    void reportLaunchToken();
    return { dsh, frpc };
  });
  ipcMain.handle('service:startFrpc', async () => ({ ok: await startFrpc() }));
  ipcMain.handle('service:stop', () => { stopFrpc(); stopDsh(); stopDirService(); return { ok: true }; });
  ipcMain.handle('service:status', () => status());
  ipcMain.handle('log:tail', () => state.logs.slice(-200));
  ipcMain.handle('qr:pair', async () => {
    const s = connectionString();
    if (!s) return { ok: false, error: '未绑定' };
    return { ok: true, dataUrl: await QRCode.toDataURL(s, { width: 480, margin: 1 }) };
  });
  ipcMain.handle('settings:autostart:get', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('settings:autostart:set', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on });
    return { ok: true, on: !!on };
  });
}

// ── 生命周期 ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // 自签证书场景（无域名服务器）：忽略证书校验（仅主进程健康探测与后续请求使用）
  session.defaultSession.on('certificate-error', (event, _wc, _url, _error, _cert, callback) => {
    event.preventDefault();
    callback(true);
  });

  registerIpc();
  loadBinding();
  loadDshToken();
  startTokenReportTimer();
  createWindow();
  createTray();
  log('DSH Link ready');

  // 冒烟模式：启动 2 秒后退出（用于 CI/验证）
  if (process.env.DSHLINK_SMOKE) {
    console.log('[smoke] DSH Link main OK, binding=' + JSON.stringify(state.binding));
    setTimeout(() => app.quit(), 2000);
    return;
  }

  // 已绑定 → 自动拉起服务
  if (state.binding) {
    const dsh = await startDsh();
    const frpc = await startFrpc();
    log(`auto-start: dsh=${dsh}, frpc=${frpc}`);
    void reportLaunchToken();
  }
});

app.on('window-all-closed', (e) => {
  // 常驻托盘：关闭窗口不退出（保持隧道）
  if (process.platform !== 'darwin') { /* 不退出 */ }
});

app.on('before-quit', () => { stopFrpc(); stopDirService(); stopDsh(); });

app.on('activate', () => { if (!win) createWindow(); });
