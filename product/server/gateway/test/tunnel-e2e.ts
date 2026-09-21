/**
 * test/tunnel-e2e.ts — 内置隧道端到端测试
 *
 * 拓扑（全部本机、同一进程内，端口一律动态取空闲口，避开开发机的 3080/3081）：
 *
 *   [假 DSH：HTTP + WS 回显 + TCP 多模式]   ← 隧道客户端要连的"PC 侧上游"
 *          ▲ 最小测试客户端（TestClient，协议对端参考实现）
 *          ▼
 *   [GatewayHttpServer + TunnelServer（真实实现）] ← 测试直接打 127.0.0.1:<隧道端口>
 *
 * 覆盖（实施方案 §六）：A 端点共存 · B 鉴权与开关 · C Host 透明与 WS 透传 ·
 *                      D 流/半关闭/拒绝/超时 · E 背压 · F 顶替/重连/心跳判死
 *
 * 运行：node test/tunnel-e2e.ts（npm run tunnel）
 */

import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer as createHttpServer, get as httpGetRaw, request as httpRequest,
  type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer,
} from 'node:http';
import { createServer as createNetServer, connect as netConnect, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

import { AuthService } from '../src/auth/index.ts';
import { AdapterRegistry } from '../src/adapter/registry.ts';
import { createMockAdapter } from '../src/adapter/mock/adapter.ts';
import { SessionRouter } from '../src/session/router.ts';
import { GatewayHttpServer } from '../src/server/http.ts';
import { GatewayWsServer } from '../src/server/ws.ts';
import { createUpgradeRouter } from '../src/server/upgrade.ts';
import { TunnelServer } from '../src/tunnel/server.ts';
import {
  GLOBAL_BUDGET, INITIAL_WINDOW, MAX_STREAM_WINDOW, TUNNEL_PATH, READ_CHUNK,
  decodeDataFrame, encodeControl, encodeDataFrame, parseServerFrame,
  type ClientFrame, type ServerFrame, type StreamDir,
} from '../src/tunnel/protocol.ts';

const HERE = resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name} ${detail}`); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

/** 已被测试占用的端口：防止 freePort 把刚释放的端口又发出去（撞上隧道监听口会造成递归建流） */
const takenPorts = new Set<number>();

/** 取一个空闲端口（listen 0 → 读端口 → 关闭；并去重，测试专用） */
async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const p = await new Promise<number>((res, rej) => {
      const srv = createNetServer();
      srv.once('error', rej);
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        srv.close(() => res(port));
      });
    });
    if (!takenPorts.has(p)) {
      takenPorts.add(p);
      return p;
    }
  }
  throw new Error('freePort: 无法取到未占用端口');
}

/** 确定无人监听的端口（9 = discard，本机/服务器均不应有监听；offline-test.ts 同款约定） */
const DEAD_PORT = 9;

/** 用 node:http 直连（Connection: close，避免 keep-alive 在进程退出时触发 libuv 断言） */
function httpGet(port: number, path: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolveP, rejectP) => {
    const req = httpGetRaw({ host: '127.0.0.1', port, path, headers: { connection: 'close' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', rejectP);
  });
}

/** 与隧道端口做 WS 握手（成功返回连接的 WS；失败 reject） */
function wsHandshake(url: string, headers: Record<string, string>, autoPong = true): Promise<WebSocket> {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 5000, autoPong });
    const t = setTimeout(() => rejectP(new Error('handshake timeout')), 8000);
    ws.once('open', () => { clearTimeout(t); resolveP(ws); });
    ws.once('error', (e) => { clearTimeout(t); rejectP(e); });
  });
}

// ── 最小测试客户端（协议对端参考实现，与 protocol.ts 同构）──────────────────

interface CStreamOpts {
  /** 旁路消费钩子：提供时数据不再写入本地 socket，由钩子自行处理（统计/校验用） */
  onData?: (buf: Buffer) => void;
}

class CStream {
  readonly sid: number;
  readonly produceDir: StreamDir = 'c2s';
  readonly consumeDir: StreamDir = 's2c';
  state: 'opening' | 'active' | 'closed' = 'opening';
  credit = 0;
  recvAvail = 0;
  acc = 0;
  bp = false;
  private bpQueued = 0;
  private client: TestClient;
  private socket: Socket;
  private opts: CStreamOpts;
  private localEnded = false;
  private peerEnded = false;

  constructor(client: TestClient, sid: number, socket: Socket, opts: CStreamOpts = {}) {
    this.client = client;
    this.sid = sid;
    this.socket = socket;
    this.opts = opts;
    socket.pause();
    socket.on('readable', () => this.pump());
    socket.on('end', () => {
      this.localEnded = true;
      client.sendControl({ t: 'close', sid: this.sid, half: this.produceDir });
      this.finish();
    });
    socket.on('drain', () => {
      // 积压字节此刻已交给内核：先结算再回补（与网关侧 stream.ts 同规则，漏记会死锁）
      this.acc += this.bpQueued;
      this.bpQueued = 0;
      this.bp = false;
      this.grant();
    });
    socket.on('error', () => this.destroy(true));
    socket.on('close', () => {
      // 正常半边关闭（双方都结束）不必再通知对端；异常断开则发 reset。
      // 注意必须走 destroy()：直接置 state='closed' 会跳过流表清理（曾导致 client.streams 泄漏）
      if (this.state !== 'closed') this.destroy(!(this.localEnded && this.peerEnded));
    });
  }

  activate(): void {
    this.state = 'active';
    this.acc = INITIAL_WINDOW;
    this.grant();
    this.pump();
  }

  private pump(): void {
    if (this.state !== 'active' || this.socket.destroyed) return;
    while (this.credit > 0) {
      const avail = this.socket.readableLength;
      if (avail <= 0) break;
      const n = Math.min(READ_CHUNK, this.credit, avail);
      const buf = this.socket.read(n) as Buffer | null;
      if (!buf || buf.length === 0) break;
      this.credit -= buf.length;
      this.client.sendData(this.sid, buf);
    }
    if (this.credit <= 0 && !this.socket.isPaused()) this.socket.pause();
  }

  onData(payload: Buffer): void {
    if (this.state === 'closed') return;
    if (payload.length > this.recvAvail) {
      this.client.violations.push(`超窗发送 ${payload.length} > ${this.recvAvail}`);
      this.client.terminateNow();
      return;
    }
    this.recvAvail -= payload.length;
    if (this.opts.onData) { this.opts.onData(payload); this.acc += payload.length; this.grant(); return; }
    if (this.socket.destroyed || this.socket.writableEnded) { this.acc += payload.length; this.grant(); return; }
    const ok = this.socket.write(payload);
    if (ok) {
      this.acc += payload.length;
      if (this.bp) { this.bp = false; this.acc += this.bpQueued; this.bpQueued = 0; }
      this.grant();
    } else {
      this.bp = true;
      this.bpQueued += payload.length;
    }
  }

  private grant(): void {
    if (this.state === 'closed' || this.bp || this.acc <= 0) return;
    const want = Math.min(this.acc, MAX_STREAM_WINDOW - this.recvAvail);
    if (want <= 0) return;
    this.recvAvail += want;
    this.acc -= want;
    this.client.sendControl({ t: 'win', sid: this.sid, dir: this.consumeDir, n: want });
  }

  onWin(n: number): void {
    if (this.state === 'closed') return;
    this.credit += n;
    if (this.state === 'active' && this.socket.isPaused() && this.credit > 0) {
      this.socket.resume();
      this.pump();
    }
  }

  onPeerClose(half: StreamDir): void {
    if (this.state === 'closed' || half !== this.consumeDir) return;
    this.peerEnded = true;
    if (!this.socket.destroyed && !this.socket.writableEnded) this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.localEnded && this.peerEnded && !this.socket.destroyed && !this.socket.writableEnded) this.socket.end();
  }

  destroy(notify: boolean): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (notify) this.client.sendControl({ t: 'reset', sid: this.sid, reason: 'local-closed' });
    if (!this.socket.destroyed) this.socket.destroy();
    this.client.streams.delete(this.sid);
  }
}

interface TestClientOpts {
  ignoreOpen?: boolean;
  autoPong?: boolean;
  streamOpts?: (service: string) => CStreamOpts;
}

class TestClient {
  ws!: WebSocket;
  welcome: Extract<ServerFrame, { t: 'welcome' }> | null = null;
  streams = new Map<number, CStream>();
  violations: string[] = [];
  errorCodes: string[] = [];
  closed = false;
  s2cBytes = 0;
  private url: string;
  private token: string;
  /** 服务名 → 本端（PC 侧）目标端口；运行期可变（测试要模拟"目标不可达"） */
  servicePorts: Record<string, number>;
  opts: TestClientOpts;

  constructor(url: string, token: string, servicePorts: Record<string, number>, opts: TestClientOpts = {}) {
    this.url = url;
    this.token = token;
    this.servicePorts = servicePorts;
    this.opts = opts;
  }

  get tunnelId(): string | null { return this.welcome?.tunnelId ?? null; }

  sendControl(frame: ClientFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeControl(frame));
  }

  sendData(sid: number, buf: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeDataFrame(sid, buf));
  }

  terminateNow(): void { this.ws.terminate(); }

  connect(): Promise<Extract<ServerFrame, { t: 'welcome' }>> {
    return new Promise((resolveP, rejectP) => {
      const ws = new WebSocket(this.url, {
        headers: { authorization: `Bearer ${this.token}` },
        handshakeTimeout: 5000,
        autoPong: this.opts.autoPong ?? true,
      });
      this.ws = ws;
      let settled = false;
      ws.on('error', (e) => { if (!settled) { settled = true; rejectP(e); } });
      ws.on('close', () => { this.closed = true; if (!settled) { settled = true; rejectP(new Error('closed before welcome')); } });
      ws.on('open', () => {
        ws.send(encodeControl({
          t: 'hello', v: 1,
          client: { app: 'tunnel-e2e', appVersion: '0', os: 'test' },
          services: Object.entries(this.servicePorts).map(([name, localPort]) => ({ name, localPort })),
        }));
      });
      ws.on('message', (data, isBinary) => {
        const buf = data as Buffer;
        if (isBinary) {
          const f = decodeDataFrame(buf);
          if (!f) { this.violations.push('非法数据帧'); return; }
          this.s2cBytes += f.payload.length;
          const st = this.streams.get(f.sid);
          if (st) st.onData(f.payload);
          return;
        }
        const f = parseServerFrame(buf.toString('utf8'));
        if (!f) { this.violations.push('非法控制帧'); return; }
        switch (f.t) {
          case 'welcome':
            this.welcome = f;
            if (!settled) { settled = true; resolveP(f); }
            return;
          case 'error':
            this.errorCodes.push(f.code);
            if (!settled) { settled = true; rejectP(new Error(`error frame: ${f.code}`)); }
            return;
          case 'open': this.onOpen(f.sid, f.service); return;
          case 'close': { const st = this.streams.get(f.sid); if (st) st.onPeerClose(f.half); return; }
          case 'reset': { const st = this.streams.get(f.sid); if (st) st.destroy(false); return; }
          case 'win': { const st = this.streams.get(f.sid); if (st) st.onWin(f.n); return; }
          default: return;
        }
      });
    });
  }

  private onOpen(sid: number, service: string): void {
    if (this.opts.ignoreOpen) return;
    const port = this.servicePorts[service];
    if (!port) {
      this.sendControl({ t: 'open-result', sid, ok: false, err: 'unknown-service' });
      return;
    }
    const socket = netConnect({ host: '127.0.0.1', port, allowHalfOpen: true });
    const st = new CStream(this, sid, socket, this.opts.streamOpts?.(service) ?? {});
    this.streams.set(sid, st);
    socket.once('connect', () => {
      this.sendControl({ t: 'open-result', sid, ok: true });
      st.activate();
    });
    socket.once('error', (e: Error) => {
      const code = (e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'connect-refused' : 'connect-failed';
      this.streams.delete(sid);
      this.sendControl({ t: 'open-result', sid, ok: false, err: code });
    });
  }
}

// ── 假 DSH（隧道客户端要连的"PC 侧上游"）──────────────────────────────────

const BIG_SIZE = 32 * 1024 * 1024;
const CHUNK = 64 * 1024;
const PATTERN_MOD = 251;

/** /big 的确定性字节模式：绝对偏移 pos 处的字节 = (pos % CHUNK) % PATTERN_MOD */
function patternByte(pos: number): number {
  return (pos % CHUNK) % PATTERN_MOD;
}

interface FakeDsh {
  httpPort: number;
  tcpPort: number;
  requests: { url: string; host: string; headers: IncomingHttpHeaders }[];
  bigBytesWritten: () => number;
  tcpReceived: (sock: Socket) => Buffer[];
  tcpClosedCount: () => number;
  sockets: Set<Socket>;
  close: () => Promise<void>;
}

function listenOn(server: HttpServer | NetServer): Promise<number> {
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port));
  });
}

async function startFakeDsh(): Promise<FakeDsh> {
  const requests: FakeDsh['requests'] = [];
  const receivedBySock = new Map<Socket, Buffer[]>();
  const sockets = new Set<Socket>();
  let bigWritten = 0;
  let tcpClosed = 0;

  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push({ url: req.url ?? '', host: String(req.headers.host ?? ''), headers: req.headers });

    if (url.pathname === '/echo-headers') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abc123; HttpOnly' });
      res.end(JSON.stringify({ host: req.headers.host }));
      return;
    }
    if (url.pathname === '/big') {
      const size = Number(url.searchParams.get('size') ?? 0);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(CHUNK);
      for (let i = 0; i < CHUNK; i++) chunk[i] = patternByte(i);
      let sent = 0;
      const pump = (): void => {
        while (sent < size) {
          const n = Math.min(CHUNK, size - sent);
          const ok = res.write(chunk.subarray(0, n));
          sent += n;
          bigWritten = sent;
          if (!ok) { res.once('drain', pump); return; }
        }
        res.end();
      };
      pump();
      return;
    }
    // 默认：无 content-length 的分块响应
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('ok');
    res.end();
  });

  // 隧道内再跑一次真正的 WS 升级（模拟 DSH 的 /api/remote.mux）
  const wss = new WebSocketServer({ server: httpServer, path: '/echo-ws' });
  wss.on('connection', (c) => { c.on('message', (m) => c.send(`echo:${String(m)}`)); });

  // TCP 多模式：首行决定行为（ECHO 回显 / HALF 先回话并 FIN 但继续读）
  const tcpServer = createNetServer({ allowHalfOpen: true }, (sock) => {
    sockets.add(sock);
    const received: Buffer[] = [];
    receivedBySock.set(sock, received);
    let mode = '';
    let buf = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      if (!mode) {
        buf = Buffer.concat([buf, d]);
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        mode = buf.subarray(0, nl).toString('utf8').trim();
        const rest = buf.subarray(nl + 1);
        if (rest.length) (mode === 'ECHO' ? sock.write(rest) : received.push(rest));
        if (mode === 'HALF') { sock.write('hello-from-dsh'); sock.end(); }
        return;
      }
      if (mode === 'ECHO') sock.write(d);
      else received.push(d);
    });
    sock.on('error', () => { /* ignore */ });
    sock.on('end', () => { if (!sock.writableEnded) sock.end(); });   // 对端 FIN 后回 FIN，让半关闭闭环（真实服务端行为）
    sock.on('close', () => { tcpClosed++; });
  });

  const httpPort = await listenOn(httpServer);
  const tcpPort = await listenOn(tcpServer);

  return {
    httpPort,
    tcpPort,
    requests,
    bigBytesWritten: () => bigWritten,
    tcpReceived: (sock) => receivedBySock.get(sock) ?? [],
    tcpClosedCount: () => tcpClosed,
    sockets,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => tcpServer.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

// ── 网关（真实 GatewayHttpServer + TunnelServer 装配，app.ts 同款）─────────

interface GatewayHandle {
  port: number;
  tunnel: TunnelServer;
  close: () => Promise<void>;
}

async function startGateway(opts: {
  tunnelEnabled: boolean;
  services: Record<string, number>;
  agentKey: string;
  timings?: { heartbeatMs?: number; pongTimeoutMs?: number; handshakeTimeoutMs?: number; openTimeoutMs?: number; globalBudget?: number };
}): Promise<GatewayHandle> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-e2e-'));
  const auth = new AuthService(dataDir, { initialUser: { username: 'admin', password: 'pass' } });
  const registry = await AdapterRegistry.assemble({ mock: createMockAdapter }, { mock: { enabled: true } });
  const router = new SessionRouter(registry);
  const tunnel = new TunnelServer(
    { enabled: opts.tunnelEnabled, services: opts.services, maxStreams: 128 },
    { agentKey: opts.agentKey, log: process.env.TUNNEL_DEBUG ? (m: string) => console.log('[gw]', m) : () => {}, ...opts.timings },
  );
  if (opts.tunnelEnabled) {
    const r = await tunnel.start();
    if (!r.ok) throw new Error(`tunnel.start 失败：${r.error}`);
  }
  const http = new GatewayHttpServer(auth, { webDir: join(HERE, 'web'), tunnelState: () => tunnel.state() });
  const ws = new GatewayWsServer(auth, registry, router);
  ws.attach(http.server);
  createUpgradeRouter(http.server, [
    { path: '/ws', handle: ws.handleUpgrade },
    { path: TUNNEL_PATH, handle: tunnel.handleUpgrade },
  ]);
  await new Promise<void>((r) => http.server.listen(port, '127.0.0.1', r));
  return {
    port,
    tunnel,
    close: async () => {
      tunnel.stop();
      await new Promise<void>((r) => http.server.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ── 测试主体 ─────────────────────────────────────────────────────────────

/** 简易 TCP 回显（可带前缀），用于"顶替后流量走新连接"的区分性断言 */
function startEchoServer(prefix: string): Promise<number> {
  return new Promise((res) => {
    const srv = createNetServer({ allowHalfOpen: true }, (sock) => {
      sock.on('data', (d: Buffer) => sock.write(`${prefix}${d.toString('utf8')}`));
      sock.on('error', () => { /* ignore */ });
    });
    void listenOn(srv).then(res);
  });
}

/** 裸 TCP 往返：写入 payload（首行为模式行），读满 expectBytes 后返回 */
function rawTcpRoundTrip(port: number, payload: Buffer, expectBytes: number): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    const sock = netConnect({ host: '127.0.0.1', port, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let got = 0;
    const timer = setTimeout(() => { sock.destroy(); rejectP(new Error('tcp round-trip timeout')); }, 8000);
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (d: Buffer) => {
      chunks.push(d);
      got += d.length;
      if (got >= expectBytes) {
        clearTimeout(timer);
        sock.destroy();
        resolveP(Buffer.concat(chunks).subarray(0, expectBytes));
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); rejectP(e); });
  });
}

/** 裸 TCP 连接（返回已连接的 socket）；halfOpen=false 时对端 FIN 会直接触发 'close'（真实 HTTP 客户端语义） */
function tcpConnect(port: number, halfOpen = true): Promise<Socket> {
  return new Promise((resolveP, rejectP) => {
    const sock = netConnect({ host: '127.0.0.1', port, allowHalfOpen: halfOpen });
    sock.once('connect', () => resolveP(sock));
    sock.once('error', rejectP);
  });
}

async function main(): Promise<void> {
  const fake = await startFakeDsh();
  const dshPort = await freePort();   // 网关侧隧道监听：dsh（HTTP/WS 透明转发）
  const tcpPort = await freePort();   // 网关侧隧道监听：tcp（裸 TCP 多模式）
  const gw = await startGateway({
    tunnelEnabled: true,
    services: { dsh: dshPort, tcp: tcpPort },
    agentKey: 'test-key',
    timings: { heartbeatMs: 1000, pongTimeoutMs: 3000, handshakeTimeoutMs: 2000, openTimeoutMs: 700 },
  });
  const url = `ws://127.0.0.1:${gw.port}${TUNNEL_PATH}`;
  const client = new TestClient(url, 'test-key', { dsh: fake.httpPort, tcp: fake.tcpPort });

  // ── A. 握手与状态 ───────────────────────────────────────────────────
  const welcome = await client.connect();
  check('A1 握手成功并收到 welcome', welcome.v === 1 && welcome.tunnelId.length > 0, JSON.stringify(welcome));
  check(
    'A2 welcome 声明回环绑定',
    welcome.services.length === 2 && welcome.services.every((s) => s.bind[0] === '127.0.0.1' && s.bind[1] > 0),
    JSON.stringify(welcome.services),
  );
  check('A3 tunnel.state().active', await waitFor(() => gw.tunnel.state().active, 1000));

  // ── B. 鉴权与开关 ───────────────────────────────────────────────────
  let b1 = '';
  try { await wsHandshake(url, {}); } catch (e) { b1 = (e as Error).message; }
  check('B1 无凭据升级被拒（401）', b1.includes('401'), b1);
  let b2 = '';
  try { await wsHandshake(url, { authorization: 'Bearer wrong-key' }); } catch (e) { b2 = (e as Error).message; }
  check('B2 错误凭据升级被拒（401）', b2.includes('401'), b2);

  const offDshPort = await freePort();
  const gwOff = await startGateway({
    tunnelEnabled: false,
    services: { dsh: offDshPort },
    agentKey: 'test-key',
    timings: { handshakeTimeoutMs: 2000 },
  });
  const offClient = new TestClient(`ws://127.0.0.1:${gwOff.port}${TUNNEL_PATH}`, 'test-key', { dsh: fake.httpPort });
  let offErr = '';
  try { await offClient.connect(); } catch (e) { offErr = (e as Error).message; }
  check('B3 tunnel.enabled=false → tunnel-disabled', offErr.includes('tunnel-disabled'), offErr);

  let offBound = false;
  await new Promise<void>((r) => {
    const s = netConnect({ host: '127.0.0.1', port: offDshPort });
    s.once('connect', () => { offBound = true; s.destroy(); r(); });
    s.once('error', () => r());
    setTimeout(r, 800);
  });
  check('B4 禁用时不绑隧道端口', offBound === false);

  // ── C. Host 透明与 WS 透传（信任栅栏的红线）──────────────────────────
  const echo = await httpGet(dshPort, '/echo-headers');
  const echoJson = JSON.parse(echo.body.toString('utf8')) as { host: string };
  check('C1 Host 逐字节保持（127.0.0.1:<隧道端口>）', echoJson.host === `127.0.0.1:${dshPort}`, echoJson.host);
  check('C2 Set-Cookie 透传', String(echo.headers['set-cookie'] ?? '').includes('sid=abc123'), JSON.stringify(echo.headers));
  const plain = await httpGet(dshPort, '/');
  check('C3 分块响应正文一致', plain.status === 200 && plain.body.toString() === 'ok', `${plain.status} ${plain.body.toString()}`);

  const innerWs = await wsHandshake(`ws://127.0.0.1:${dshPort}/echo-ws`, {});
  const innerReply = await new Promise<string>((r) => {
    innerWs.once('message', (m) => r(String(m)));
    innerWs.send('hi-tunnel');
    setTimeout(() => r(''), 4000);
  });
  check('C4 隧道内 WS 升级并双向收发', innerReply === 'echo:hi-tunnel', innerReply);
  innerWs.close();

  // ── D. 流、半关闭、拒绝与超时 ───────────────────────────────────────
  const payloads = Array.from({ length: 16 }, (_, i) => Buffer.alloc(8192, i + 1));
  const echoed = await Promise.all(payloads.map((p) => rawTcpRoundTrip(tcpPort, Buffer.concat([Buffer.from('ECHO\n'), p]), p.length)));
  check('D1 16 条并发流互不串扰（校验和）', echoed.every((r, i) => r.equals(payloads[i])));

  // 半关闭：DSH 先回话并 FIN，但仍继续读 —— 客户端写侧必须保持可用（allowHalfOpen 红线）
  const halfSock = await tcpConnect(tcpPort);
  let halfGot = Buffer.alloc(0);
  let halfEnded = false;
  halfSock.on('data', (d: Buffer) => { halfGot = Buffer.concat([halfGot, d]); });
  halfSock.on('end', () => { halfEnded = true; });
  halfSock.write('HALF\n');
  await waitFor(() => halfEnded, 3000);
  check('D2a 收到 DSH 数据与 FIN', halfGot.toString() === 'hello-from-dsh' && halfEnded, `${halfGot.toString()} ended=${halfEnded}`);
  const wroteAfterFin = halfSock.write('ping-after-fin');
  await sleep(400);
  const dshSide = [...fake.sockets].find((s) => Buffer.concat(fake.tcpReceived(s)).toString().includes('ping-after-fin'));
  check('D2b FIN 之后客户端写侧仍可用且 DSH 收到', wroteAfterFin && !!dshSide, `wrote=${wroteAfterFin} received=${!!dshSide}`);
  halfSock.destroy();

  const sess = gw.tunnel.activeSession();
  if (!sess) throw new Error('活动会话丢失');
  const streamsBefore = sess.streamCount();
  const dying = await tcpConnect(tcpPort);
  dying.write('ECHO\nx');
  await sleep(100);
  dying.destroy();
  check('D3 本地 socket 被 destroy → 流表回收', await waitFor(() => sess.streamCount() <= streamsBefore, 2000), `streams=${sess.streamCount()}`);

  client.servicePorts.tcp = DEAD_PORT;          // 指向无人监听的端口
  const refused = await tcpConnect(tcpPort, false);   // 真实客户端语义：对端销毁 → FIN → close
  let refusedClosed = false;
  refused.on('error', () => { /* RST 由 close 统一观察 */ });
  refused.on('close', () => { refusedClosed = true; });
  refused.write('ECHO\n');
  check(
    'D4 目标不可达 → 建流失败且网关侧 socket 被销毁',
    await waitFor(() => refusedClosed, 3000),
    JSON.stringify({ serverStreams: sess.streamCount(), clientStreams: client.streams.size, violations: client.violations }),
  );
  client.servicePorts.tcp = fake.tcpPort;

  client.opts.ignoreOpen = true;                // 模拟客户端无响应 → 服务端 open 超时（700ms）
  const openTimeoutSock = await tcpConnect(tcpPort, false);
  let openTimeoutClosed = false;
  openTimeoutSock.on('error', () => { /* ignore */ });
  openTimeoutSock.on('close', () => { openTimeoutClosed = true; });
  openTimeoutSock.write('ECHO\n');
  check('D5 open 超时回收（不泄漏 fd）', await waitFor(() => openTimeoutClosed, 3000));
  client.opts.ignoreOpen = false;

  // ── E. 背压（32 MiB 灌入 + 消费端停读）───────────────────────────────
  const rssBefore = process.memoryUsage().rss;
  const bigReq = httpRequest({ host: '127.0.0.1', port: dshPort, path: `/big?size=${BIG_SIZE}` });
  bigReq.end();                                  // http.request 不会自动 flush：不 end() 请求根本发不出去
  let received = 0;
  let patternOk = true;
  const bigRes = await new Promise<IncomingMessage>((res, rej) => {
    bigReq.on('response', res);
    bigReq.on('error', rej);
  });
  bigRes.on('data', (c: Buffer) => {
    const base = received;
    received += c.length;
    if (patternOk) {
      for (let i = 0; i < c.length; i++) {
        if (c[i] !== patternByte(base + i)) { patternOk = false; break; }
      }
    }
  });
  bigRes.pause();                               // 立即停读，模拟消费端卡死

  await sleep(1500);
  const recv1 = received;
  const written1 = fake.bigBytesWritten();
  await sleep(700);
  const recv2 = received;
  const written2 = fake.bigBytesWritten();

  check('E1 停读后数据基本停滞', recv2 - recv1 < 1024 * 1024 && recv2 < BIG_SIZE / 2, `${recv1} → ${recv2}`);
  check('E2 假 DSH 被背压压住（未写完全量）', written2 < BIG_SIZE && written2 === written1, `${written1} → ${written2}`);
  check(
    'E3 服务端已授予信用不超 GLOBAL_BUDGET',
    sess.availTotal('c2s') <= GLOBAL_BUDGET,
    `${sess.availTotal('c2s')} vs ${GLOBAL_BUDGET}`,
  );
  const rssDelta = process.memoryUsage().rss - rssBefore;
  check('E4 背压期间 RSS 增量 < 64 MiB', rssDelta < 64 * 1024 * 1024, `${(rssDelta / 1048576).toFixed(1)} MiB`);

  bigRes.resume();
  const drained = await waitFor(() => received >= BIG_SIZE, 60000);
  check('E5 恢复读取后收满 32 MiB 且字节模式正确', drained && received === BIG_SIZE && patternOk, `${received}/${BIG_SIZE} patternOk=${patternOk}`);

  // ── F. 顶替、心跳判死与重连 ─────────────────────────────────────────
  const echoBPort = await startEchoServer('B:');
  const clientB = new TestClient(url, 'test-key', { dsh: fake.httpPort, tcp: echoBPort });
  const welcomeB = await clientB.connect();
  check('F1a 旧连接被顶替（superseded）', await waitFor(() => client.closed, 2000) && client.errorCodes.includes('superseded'), JSON.stringify(client.errorCodes));
  check('F1b 新会话生效', (await waitFor(() => gw.tunnel.state().tunnelId === welcomeB.tunnelId, 1500)), String(gw.tunnel.state().tunnelId));
  const viaB = await rawTcpRoundTrip(tcpPort, Buffer.from('xyz'), 5);   // 简易回显服务不需要模式行
  check('F1c 隧道流量走新连接', viaB.toString() === 'B:xyz', viaB.toString());

  const deaf = new TestClient(url, 'test-key', { dsh: fake.httpPort }, { autoPong: false });
  await deaf.connect();                          // 顶替 clientB
  check('F2 客户端不回 pong → 服务端判死（3s 超时）', await waitFor(() => deaf.closed, 9000), `closed=${deaf.closed}`);

  const again = new TestClient(url, 'test-key', { dsh: fake.httpPort, tcp: fake.tcpPort });
  await again.connect();
  const viaAgain = await rawTcpRoundTrip(tcpPort, Buffer.from('ECHO\nre'), 2);
  check('F3 断线后重连可用', viaAgain.toString() === 're', viaAgain.toString());

  // ── G. 流表不泄漏（全部用例结束后归零）──────────────────────────────
  await sleep(800);
  const sessEnd = gw.tunnel.activeSession();
  check('G1 用例结束后服务端流表归零', !sessEnd || sessEnd.streamCount() === 0, `streams=${sessEnd?.streamCount()}`);

  // ── 收尾 ────────────────────────────────────────────────────────────
  again.ws.terminate();
  await sleep(150);
  await gw.close();
  await gwOff.close();
  await fake.close();
  await sleep(200);

  console.log(`\n[tunnel-e2e] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[tunnel-e2e] fatal:', e);
  process.exit(1);
});



