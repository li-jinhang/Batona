/**
 * Batona PC — Electron 主进程
 *
 * 职责：
 *  1. 托管账号：接入密钥登录、安全存储设备授权、手机配对确认
 *  2. 服务编排：检测/启动 DSH web(3080) → 启动隧道 → 在线状态机
 *  3. 隧道管理：仅使用内置 WSS 隧道（tunnel/client.js，跑在本进程内）
 *  4. 托盘常驻 + 开机自启 + 日志
 *
 * 渲染进程通过 preload 暴露的 window.batona（contextBridge + IPC）与主进程通信。
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, powerMonitor, clipboard, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const http = require('node:http');
const QRCode = require('qrcode');
const { DirectoryService } = require('./dir-service.js');
const { resolveDshLauncher, hasNodeRuntime, isDshAuthenticated, createDshOutputParser } = require('./dsh-launcher.js');
const { CodexBridge, redactText } = require('./codex-bridge.js');
const { launchSharedCodexDesktop } = require('./codex-handoff.js');
const { loadControlMode, saveControlMode } = require('./codex-control-mode.js');
const { probeSoftware, probeSharedDesktopConnection, clearSharedDesktopConnectionCache } = require('./software-status.js');
const { AccessClient } = require('./access-client.js');
const { awaitInitialConnection } = require('./tunnel/startup.js');
const { createRuntimeProfile, configureUserData, getTunnelServices } = require('./runtime-profile.js');
let access = null;
let activePair = null;
let activePairCode = null;

const runtimeProfile = createRuntimeProfile(process.env);
// 测试实例先切换 Electron 用户目录：它同时隔离授权凭据、设备身份与单实例锁。
// 该配置必须早于 requestSingleInstanceLock() 和 ready 事件。
configureUserData(app, runtimeProfile);

// 同一运行配置只允许一个实例，避免重复连接同一设备账号并互相顶替隧道。
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();

// 内置隧道客户端（依赖 ws；缺失时明确报告，不下载或启动外部隧道程序）
let TunnelClient = null;
let tunnelRequireError = null;
try {
  ({ TunnelClient } = require('./tunnel/client.js'));
} catch (e) {
  tunnelRequireError = e.message;
}

const DSH_HOST = '127.0.0.1';
const DSH_PORT_DEFAULT = runtimeProfile.ports.dsh;   // DSH web 默认端口；实际端口从 stdout 的 dsh web: URL 捕获
const DIR_SERVICE_PORT = runtimeProfile.ports.dir;   // 目录浏览服务，只绑定 loopback
const CODEX_SERVICE_PORT = runtimeProfile.ports.codex; // Codex App Server 本机桥，只绑定 loopback

// ── 状态 ──────────────────────────────────────────────────────────────
const state = {
  binding: null,          // 主进程专用：{ serverIp, gwPort, deviceToken, hosted }
  dshRunning: false,
  dshPort: null,          // DSH web 实际端口
  dshToken: null,         // DSH launch token（0.1.2+ 的 /api 认证凭据，DSH 重启即变）
  dshCookie: null,        // { key, value } 用 token 换到的浏览器会话 cookie 缓存
  dshAuthed: false,       // 最近一次认证探测结果
  tunnelKind: null,       // 'builtin' | null
  tunnelConnected: false, // 内置隧道是否已连通
  tunnelLastError: null,
  logs: [],
};

const MAX_LOG = 500;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${redactText(msg)}`;
  state.logs.push(line);
  if (state.logs.length > MAX_LOG) state.logs.shift();
  console.log(line);
}

// ── 邀请制账号：凭据只留主进程和 Windows 安全存储 ──
function loadBinding() { state.binding = access?.binding() || null; return state.binding; }

/** 内置隧道客户端实例（运行期） */
let tunnelClient = null;
/** 同一时刻只允许一次隧道启动：主进程自动启动、渲染 IPC 与重连回调会并发到达。 */
let tunnelStartPromise = null;

/** 隧道是否已连通（仅内置 WSS）。 */
function tunnelUp() {
  return state.tunnelConnected;
}

/** 本机可提供的服务（内置隧道用）。回调形式：DSH 端口是运行期从 stdout 抓的，重启会变 */
function tunnelServices() {
  return getTunnelServices(runtimeProfile, state.dshPort || DSH_PORT_DEFAULT);
}

/**
 * 启动内置隧道并等待首次握手。
 * fatal（tunnel-disabled / version-mismatch / bad-hello / bind-failed）→ 返回失败并保留明确状态。
 */
function attemptBuiltin(timeoutMs = 12000) {
  const b = state.binding;
  const client = new TunnelClient({
    host: b.serverIp, gwPort: b.gwPort || 443, token: b.deviceToken,
    services: tunnelServices, tls: true, log,
  });
  tunnelClient = client;
  const first = awaitInitialConnection(client, timeoutMs);
  client.on('connected', () => {
    if (tunnelClient !== client) return;
    state.tunnelConnected = true; state.tunnelLastError = null;
    void reportLaunchToken();
  });
  client.on('disconnected', info => {
    if (tunnelClient !== client) return;
    state.tunnelConnected = false;
    state.tunnelLastError = info.lastError?.message || info.reason || 'disconnected';
  });
  client.on('fatal', info => {
    if (tunnelClient !== client) return;
    state.tunnelConnected = false;
    state.tunnelLastError = `${info.code}: ${info.message}`;
    client.stop(); tunnelClient = null;
  });
  client.on('superseded', () => {
    if (tunnelClient !== client) return;
    state.tunnelConnected = false; tunnelClient = null;
    log('[tunnel] 连接已被替换，本连接停止重试');
  });
  client.start();
  return first;
}

/**
 * 启动内置隧道。函数名保留以兼容已发布渲染层 IPC，实际不会启动 frpc。
 */
function startFrpc() {
  if (tunnelStartPromise) return tunnelStartPromise;
  tunnelStartPromise = startFrpcOnce().finally(() => { tunnelStartPromise = null; });
  return tunnelStartPromise;
}

async function startFrpcOnce() {
  if (tunnelUp()) return true;
  if (tunnelClient) { tunnelClient.reconnectNow(); return false; }
  if (!state.binding) return false;
  // 两个本机桥都必须先起；端口冲突时不能继续把错误服务暴露给手机端。
  if (!(await startDirService())) return false;
  if (!(await startCodexBridge())) return false;

  if (!TunnelClient) {
    log(`自研隧道不可用（加载失败：${tunnelRequireError || '未知'}）`);
    return false;
  }
  state.tunnelKind = 'builtin';
  const r = await attemptBuiltin();
  if (r.ok) return true;
  log(`自研隧道不可用（${r.reason}${r.code ? ` / ${r.code}` : ''}）`);
  state.tunnelLastError = `${r.code || 'unavailable'}: ${r.reason}`;
  return false;
}

/**
 * 返回 true / false（网关已明确声明隧道状态）或 null（旧版/临时不可达）。
 * 只读取公开 health 字段，绝不记录请求头、连接串或响应全文。
 */
async function gatewayBuiltinTunnelEnabled() {
  const b = state.binding;
  if (!b) return null;
  try {
    const url = `https://${b.serverIp}:${b.gwPort || 443}/healthz`;
    const res = await jsonRequest(url, 'GET', {}, null, 5000);
    if (res.status !== 200) return null;
    const health = JSON.parse(res.body);
    return typeof health?.tunnel?.enabled === 'boolean' ? health.tunnel.enabled : null;
  } catch {
    return null;
  }
}


function stopFrpc() {
  if (tunnelClient) { tunnelClient.stop(); tunnelClient = null; }
  state.tunnelConnected = false;
  state.tunnelKind = null;
}

// ── DSH 探测/启动 ─────────────────────────────────────────────────────
function dshTokenPath() {
  return path.join(app.getPath('userData'), 'dsh-token.json');
}

/** 载入上次捕获的 launch token（仅用于"重启前先探测"，DSH 重启后 token 会变） */
function loadDshToken() {
  state.dshToken = runtimeProfile.dshEnabled ? process.env.BATONA_DSH_TOKEN || null : null;
  if (!runtimeProfile.dshEnabled) return;
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
 * 必须同时通过 session/list 认证；TCP 存活只用于防止重复启动，不能标为就绪。
 */
async function detectDsh() {
  state.dshAuthed = false;
  if (state.dshToken) {
    const r = await dshCall('session/list', { _request: {} });
    if (isDshAuthenticated(r)) { state.dshAuthed = true; return true; }
    if (r.status === 401) state.dshCookie = null;   // token 可能已过期，下次重新交换
  }
  return false;
}

/** DSH 启动时打印 "dsh web: http://127.0.0.1:<port>/?token=<token>" */
function captureDshToken({ port, token }) {
  if (state.dshToken === token && state.dshPort === port) return;
  state.dshPort = port;
  state.dshToken = token;
  state.dshCookie = null;
  saveDshToken();
  log(`捕获 DSH launch token（port=${port}）`);
  void reportLaunchToken();
}

let dshProc = null;
let dshStartPromise = null;

async function startDsh() {
  if (dshStartPromise) return dshStartPromise;
  dshStartPromise = startDshInternal();
  try { return await dshStartPromise; }
  finally { dshStartPromise = null; }
}

async function startDshInternal() {
  if (!runtimeProfile.dshEnabled) return false;
  if (await detectDsh()) { state.dshRunning = true; return true; }
  state.dshRunning = false;
  if (!hasNodeRuntime()) {
    log('DSH 启动失败：Node.js 未安装或无法运行。请安装 Node.js 后重试。');
    return false;
  }
  if (await portOpen(DSH_HOST, state.dshPort || DSH_PORT_DEFAULT)) {
    log('DSH 端口已占用但认证未通过：启动令牌已失效。请退出旧 DSH 后重新启动服务；不会重复启动或终止未知进程。');
    return false;
  }
  const launcher = resolveDshLauncher();
  if (!launcher) {
    log('DSH 启动失败：未找到 dsh 或 npx；请安装 DSH，或设置 BATONA_DSH_CMD');
    return false;
  }
  // DSH 0.1.2+ 的 /api 有 browser-trust fence：默认只信任 loopback/LAN。
  // 网关经 frp 隧道从服务器访问（Host 为 127.0.0.1:3080），需显式声明 trusted-host 才放行。
  const defaultArgs = '--profile web --no-open --trusted-host 127.0.0.1:3080';
  const args = [...launcher.prefixArgs, ...(process.env.BATONA_DSH_ARGS || defaultArgs).split(/\s+/)];
  log(`starting DSH (${launcher.source}): ${launcher.command} ${args.join(' ')}`);
  try {
    // dsh 是 .cmd（npm 全局 bin），经 cmd 启动；Windows cmd 默认代码页 GBK，
    // 会导致 DSH 输出的 UTF-8 中文被以 GBK 渲染成乱码（锟斤拷）。先 chcp 65001 强制 UTF-8。
    const cmdLine = `${launcher.command} ${args.join(' ')}`;
    dshProc = spawn('cmd.exe', ['/c', `chcp 65001 >nul && ${cmdLine}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = createDshOutputParser(captureDshToken, line => log(`[dsh] ${line}`));
    const stderr = createDshOutputParser(captureDshToken, line => log(`[dsh!] ${line}`));
    dshProc.stdout?.on('data', d => stdout(String(d)));
    dshProc.stderr.on('data', d => stderr(String(d)));
    dshProc.on('exit', (code) => { state.dshRunning = false; log(`dsh exited (${code})`); });
    // 等待就绪：须同时拿到 launch token 且 /api 认证通过（未认证探测恒 401，不能只看端口）
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (state.dshToken && (await detectDsh())) { state.dshRunning = true; log('DSH web ready'); return true; }
    }
    log('DSH web 启动超时（可手动运行 dsh web）');
    return false;
  } catch (e) {
    log(`dsh start failed: ${e.message}（可用 BATONA_DSH_CMD 指定命令）`);
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
      rejectUnauthorized: true,
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
 * （账号隔离的网关 → 自研隧道 → 本机 DSH）需要这个 token 换 cookie，DSH 重启即失效。
 * 认证使用 PC 独立设备授权；令牌只更新该 PC 运行时。
 */
async function reportLaunchToken() {
  const b = state.binding;
  if (!runtimeProfile.dshEnabled || !b || !state.dshToken) return false;
  if (!(await detectDsh())) { state.dshRunning = false; return false; }
  try { await access.call('launch-token', {token:state.dshToken}); return true; }
  catch { log('launch token 上报失败，请检查登录和隧道状态'); return false; }
}

/** 周期兜底：网关重启或网络抖动后，无需人工干预即可恢复链路 */
function startTokenReportTimer() {
  if (tokenReportTimer) clearInterval(tokenReportTimer);
  tokenReportTimer = setInterval(() => { void reportLaunchToken(); }, TOKEN_REPORT_INTERVAL);
}

// ── 目录浏览服务（读笔记本本地目录，供手机端浏览/选择工作区路径）──────
let dirService = null;

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
  if (!dirService) {
    dirService = new DirectoryService({
      host: '127.0.0.1',
      port: DIR_SERVICE_PORT,
      listDir,
      log,
    });
  }
  return dirService.start();
}

function stopDirService() {
  const service = dirService;
  dirService = null;
  if (service) void service.stop();
}

// ── Codex App Server 本机桥（只绑定回环，经隧道供网关适配）─────────────
let codexBridge = null;
let codexControl = null;
let codexControlSwitching = false;

function codexControlPath() {
  return path.join(app.getPath('userData'), 'codex-control-mode.json');
}

function startCodexBridge(config = codexControl) {
  if (!codexBridge) {
    try {
      codexBridge = new CodexBridge({
        host: '127.0.0.1',
        port: CODEX_SERVICE_PORT,
        userDataDir: app.getPath('userData'),
        websocketUrl: config?.websocketUrl,
        enableSharedWrites: config?.enableSharedWrites === true,
        log,
      });
    } catch {
      log('Codex 共享连接地址无效；桥未启动');
      return Promise.resolve(false);
    }
  }
  return codexBridge.start();
}

function stopCodexBridge() {
  const bridge = codexBridge;
  codexBridge = null;
  return bridge ? bridge.stop() : Promise.resolve();
}

async function applyCodexControl(next) {
  const previous = codexControl;
  await stopCodexBridge();
  try {
    if (!(await startCodexBridge(next)) || !codexBridge?.appServer?.ready) {
      throw new Error('Codex 本地桥未能以所选方式连接。');
    }
    saveControlMode(codexControlPath(), next);
    codexControl = next;
  } catch (error) {
    await stopCodexBridge();
    if (!(await startCodexBridge(previous)) || !codexBridge?.appServer?.ready) {
      log('Codex 控制方式回退后，本地桥仍未连接');
    }
    throw error;
  }
}

// ── 状态汇总 ──────────────────────────────────────────────────────────
/** 探测 HTTPS（Node fetch 不信任自签证书，改用 https.request 并忽略证书校验） */
function probeHttps(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { rejectUnauthorized: true }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

async function status() {
  if (access?.data.token) {
    try { if (!(await access.refresh()).loggedIn) { stopFrpc(); loadBinding(); } }
    catch { /* A transport failure is not revocation. Keep the binding for recovery. */ }
  }
  const [dshUp, software, codexSharedAttached, codexAuth] = await Promise.all([
    detectDsh(),
    probeSoftware(),
    codexControl?.mode === 'shared' ? probeSharedDesktopConnection(codexControl.websocketUrl) : Promise.resolve(null),
    codexBridge?.accountStatus() || Promise.resolve('unknown'),
  ]);
  let gatewayUp = false;
  if (state.binding) {
    const port = state.binding.gwPort || 443;
    gatewayUp = await probeHttps(`https://${state.binding.serverIp}:${port}/healthz`);
  }
  return {
    bound: !!state.binding,
    accountId: access?.data.accountId || null,
    serverIp: state.binding?.serverIp || null,
    dsh: dshUp,
    dshProcess: dshUp || software.dshProcess,
    codexDesktop: software.codexDesktop,
    codexBridge: !!codexBridge?.appServer?.ready,
    codexAuth,
    // The configured transport is only real after its app-server connection is ready.
    // Otherwise the overview badge and the open detail dialog could describe different states.
    codexTransport: codexBridge?.appServer?.ready ? codexBridge.transportMode : 'not-started',
    codexControlMode: codexControl?.mode || 'interface',
    codexSharedAttached,
    dshToken: !!state.dshToken,       // 是否已捕获 launch token（未捕获则手机端链路必断）
    dshAuthed: state.dshAuthed,       // token 是否当前有效
    // 键名 frpc 保持不变（渲染层只当布尔用）：语义 = "隧道已连通"（仅自研隧道）
    frpc: tunnelUp(),
    tunnelKind: state.tunnelKind,     // 'builtin' | null —— 供日志/后续文案区分
    tunnelLastError: state.tunnelLastError,
    gateway: gatewayUp,
  };
}

// ── 窗口 / 托盘 ───────────────────────────────────────────────────────
let win = null;
let tray = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800,
    minWidth: 480, minHeight: 560,
    title: runtimeProfile.kind === 'codex-test' ? 'Batona PC（Codex 测试实例）' : 'Batona PC',
    icon: appIcon(),   // 任务栏/窗口图标
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    if (activePair) { void access.call('pair-close', {pairId:activePair}).catch(()=>{}); activePair=null; activePairCode=null; }
    win = null;
  });
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
  tray.setToolTip('Batona PC');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Batona PC', click: () => { if (win) win.show(); else createWindow(); } },
    { label: '状态', click: () => { if (win) win.show(); } },
    { type: 'separator' },
    { label: '退出', click: () => { stopFrpc(); stopDsh(); app.quit(); } },
  ]));
  tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
}

// ── IPC ───────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('binding:get', () => ({ ...access.publicState(), appVersion: app.getVersion() }));
  ipcMain.handle('access:login', async (_e, key, replace) => {
    try { const r = await access.login(String(key), replace === true); stopFrpc(); loadBinding(); return r; }
    catch(e) { return {ok:false,error:e.code || e.message}; }
  });
  ipcMain.handle('binding:clear', async () => {
    try { await access.logout(); stopFrpc(); loadBinding(); return {ok:true}; }
    catch(e) { return {ok:false,error:e.code || e.message}; }
  });
  ipcMain.handle('access:call', async (_e, op, body) => {
    if (!['devices','rename-phone','unbind-phone','pair-open','pair-status','pair-confirm','pair-close'].includes(op)) return {ok:false,error:'不支持此操作'};
    try {
      const r = await access.call(op, body);
      if (op === 'pair-open') { activePair=r.pairId; activePairCode=r.code; r.dataUrl=await QRCode.toDataURL(r.qr,{width:300,margin:2}); }
      if (op === 'pair-status' && r.approved) activePairCode=null;
      if (op === 'pair-close') { activePair=null; activePairCode=null; }
      return r;
    } catch(e) { return {ok:false,error:e.code || e.message}; }
  });
  ipcMain.handle('pair:copy-code', () => {
    if (!activePair || typeof activePairCode !== 'string') return { ok: false, error: 'pair-invalid' };
    clipboard.writeText(activePairCode);
    return { ok: true };
  });
  ipcMain.handle('service:start', async () => {
    // Codex 桥不依赖 DSH web。若旧 DSH 正在重启、端口被遗留进程占用或
    // launch token 尚未刷新，不能让它的等待周期阻塞手机端的 Codex 通道。
    const [dsh, frpc] = await Promise.all([runtimeProfile.dshEnabled ? startDsh() : false, startFrpc()]);
    void reportLaunchToken();
    return { dsh, frpc };
  });
  ipcMain.handle('service:startFrpc', async () => ({ ok: await startFrpc() }));
  ipcMain.handle('dsh:start', async () => {
    if (!runtimeProfile.dshEnabled) return { ok: false, error: '当前运行配置未启用 DSH。' };
    if (await detectDsh()) return { ok: true, alreadyRunning: true };
    if (!hasNodeRuntime()) return { ok: false, error: '未检测到可运行的 Node.js。请安装 Node.js 后重试。' };
    const ok = await startDsh();
    if (ok) void reportLaunchToken();
    return ok ? { ok: true } : { ok: false, error: 'DSH 启动失败，请查看运行日志后重试。' };
  });
  ipcMain.handle('dsh:open', async () => {
    if (!runtimeProfile.dshEnabled || !await detectDsh() || !state.dshAuthed || !state.dshToken)
      return { ok: false, error: '请先启动 DSH 服务。' };
    const port = Number(state.dshPort || DSH_PORT_DEFAULT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'DSH 端口无效。' };
    await shell.openExternal(`http://${DSH_HOST}:${port}/?token=${encodeURIComponent(state.dshToken)}`);
    return { ok: true };
  });
  ipcMain.handle('service:stop', () => { stopFrpc(); return { ok: true }; });
  ipcMain.handle('service:status', () => status());
  ipcMain.handle('codex:control:set', async (_e, mode) => {
    if (mode !== 'interface' && mode !== 'shared') return { ok: false, error: '无效的控制方式。' };
    if (codexControlSwitching) return { ok: false, error: '控制方式正在切换，请稍候。' };
    if (codexControl?.mode === mode && codexBridge?.appServer?.ready
      && (mode === 'interface' || codexBridge.transportMode === 'shared-write')) {
      return { ok: true, mode };
    }
    codexControlSwitching = true;
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'native-handoff.ps1')
      : path.join(__dirname, 'tools', 'shared-transport-probe', 'native-handoff.ps1');
    const statePath = app.isPackaged
      ? path.join(app.getPath('userData'), 'native-handoff.json')
      : path.resolve(__dirname, 'tools', 'shared-transport-probe', '..', '..', '..', '..', 'output', '.shared-transport-probe', 'native-handoff.json');
    try {
      if (mode === 'interface') {
        await applyCodexControl({ mode: 'interface' });
        log('Codex control mode changed to native interface.');
        return { ok: true, mode };
      }
      const software = await probeSoftware();
      const handoff = await launchSharedCodexDesktop({ scriptPath, statePath, codexDesktop: software.codexDesktop, restart: true });
      if (handoff.reused) log('Codex Desktop already connected to the verified shared server.');
      if (handoff.recovered) log('Codex Desktop shared connection verified after handoff diagnostic.');
      clearSharedDesktopConnectionCache();
      await applyCodexControl({ mode: 'shared', websocketUrl: handoff.websocketUrl, enableSharedWrites: true });
      log('Codex control mode changed to shared connection.');
      return { ok: true, mode, portFallback: /was occupied by an unverified listener/i.test(handoff.output) };
    } catch (error) {
      log(`Codex control mode switch failed: ${error.code || 'codex-control-switch-failed'}`);
      return { ok: false, code: error.code || 'codex-handoff-failed', error: error.message };
    } finally {
      codexControlSwitching = false;
    }
  });
  ipcMain.handle('log:tail', () => state.logs.slice(-200));
  ipcMain.handle('settings:autostart:get', () => runtimeProfile.kind === 'codex-test' ? false : app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('settings:autostart:set', (_e, on) => {
    if (runtimeProfile.kind === 'codex-test') return { ok: false, error: 'disabled-in-test-profile' };
    app.setLoginItemSettings({ openAtLogin: !!on });
    return { ok: true, on: !!on };
  });
}

// ── 生命周期 ──────────────────────────────────────────────────────────
if (ownsSingleInstanceLock) app.whenReady().then(async () => {
  access = new AccessClient({userData:app.getPath('userData'),safeStorage});
  codexControl = loadControlMode(codexControlPath());
  registerIpc();
  loadBinding();
  loadDshToken();
  startTokenReportTimer();
  createWindow();
  createTray();

  // 系统唤醒 / 解锁：立即重连隧道（笔记本合盖唤醒后 TCP 半死，不能干等退避计时）
  powerMonitor.on('resume', () => {
    if (tunnelClient) { log('系统唤醒，立即重连隧道'); tunnelClient.reconnectNow(); }
  });
  powerMonitor.on('unlock-screen', () => {
    if (tunnelClient) tunnelClient.reconnectNow();
  });

  log('Batona PC ready');
  if (runtimeProfile.kind === 'codex-test') log('Codex-only test profile active: separate user data, ports 3181/3182, DSH disabled');
  if (tunnelRequireError) log('提示：自研隧道模块加载失败，远程服务不可用');

  // 冒烟模式：启动 2 秒后退出（用于 CI/验证）
  if (process.env.BATONA_SMOKE) {
    console.log('[smoke] Batona PC main OK, binding=' + (state.binding ? 'configured' : 'absent')
      + ', tunnelMode=' + (process.env.BATONA_TUNNEL || 'auto')
      + ', tunnelClient=' + (TunnelClient ? 'loaded' : 'UNAVAILABLE'));
    setTimeout(() => app.quit(), 2000);
    return;
  }

  // 已绑定 → 自动拉起服务
  if (state.binding) {
    // DSH 与隧道必须独立恢复：后者还承载 Codex App Server，不能等待 DSH。
    const [dsh, tunnel] = await Promise.all([runtimeProfile.dshEnabled ? startDsh() : false, startFrpc()]);
    log(`auto-start: dsh=${dsh}, tunnel=${tunnel}（kind=${state.tunnelKind || 'none'}）`);
    void reportLaunchToken();
  }
});

if (ownsSingleInstanceLock) app.on('second-instance', () => {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

if (ownsSingleInstanceLock) app.on('window-all-closed', (e) => {
  // 常驻托盘：关闭窗口不退出（保持隧道）
  if (process.platform !== 'darwin') { /* 不退出 */ }
});

if (ownsSingleInstanceLock) app.on('before-quit', () => { stopFrpc(); stopDirService(); stopCodexBridge(); stopDsh(); });

if (ownsSingleInstanceLock) app.on('activate', () => { if (!win) createWindow(); });
