/**
 * tunnel/server.ts — 内置隧道服务端（替代 frps）
 *
 * 职责：
 *   - start()：按 config.tunnel.services 在 127.0.0.1 上绑定回环监听（**只绑回环**，
 *     顺带修掉 frps 时代 `*:3080` 通配暴露的问题）；绑定失败不崩，记录 bindError，
 *     hello 校验时回 bind-failed，让 PC 回退 frp。
 *   - handleUpgrade()：Bearer 鉴权（agentKey，timing-safe）→ 交给 WSS（noServer 模式）
 *   - 单隧道策略：同 key 新连接顶替旧连接（先同步终结旧的、销毁其全部本地 socket，再登记新的）
 *   - state()：给 /healthz 的结构化状态（enabled 与 active 分开——区分"服务器没开"与"PC 没连"）
 *
 * 与网关其余部分的接缝：本模块只负责"把 127.0.0.1:3080/3081 的 TCP 流量透明地搬到 PC"，
 * 不解析 HTTP。DSH 的信任栅栏依赖 Host 头逐字节保持 127.0.0.1:3080，任何改写都会让它 401/403。
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  SUPPORTED_VERSIONS, TUNNEL_ERROR, WS_MAX_PAYLOAD,
  type ClientInfo, type ClientFrame,
} from './protocol.ts';
import { TunnelSession, type HelloResult } from './session.ts';

export interface TunnelConfig {
  enabled: boolean;
  services: Record<string, number>;
  maxStreams: number;
}

export interface TunnelHealth {
  enabled: boolean;
  binding: string[];
  bindError: string | null;
  active: boolean;
  tunnelId: string | null;
  client: ClientInfo | null;
  connectedAt: string | null;
  streams: number;
  bytesIn: number;
  bytesOut: number;
  lastError: string | null;
}

export interface TunnelServerDeps {
  /** 共享密钥（= install.sh 写入的 agentKey = 连接串 frpToken） */
  agentKey: string;
  authenticate?: (req: import('node:http').IncomingMessage) => boolean;
  onDisconnected?: () => void;
  log?: (msg: string) => void;
  /** 测试可覆盖时序参数 */
  heartbeatMs?: number;
  pongTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  openTimeoutMs?: number;
  globalBudget?: number;
}

export class TunnelServer {
  readonly wss: WebSocketServer;
  private cfg: TunnelConfig;
  private deps: TunnelServerDeps;
  private listeners = new Map<string, NetServer>();
  private sessions = new Set<TunnelSession>();
  private active: TunnelSession | null = null;
  private bindError: string | null = null;
  private lastError: string | null = null;
  private bound: string[] = [];
  private log: (msg: string) => void;

  constructor(cfg: TunnelConfig, deps: TunnelServerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.log = deps.log ?? ((m) => console.log(m));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  /**
   * 绑定回环监听。必须在 AdapterRegistry.assemble 之前调用——
   * 适配器装配时会立即去连 127.0.0.1:3080，端口没绑上首连必然 ECONNRESET。
   */
  async start(): Promise<{ ok: boolean; bound: string[]; error?: string }> {
    for (const [name, port] of Object.entries(this.cfg.services)) {
      const srv = createServer({ allowHalfOpen: true }, (socket) => this.onLocalConnection(name, socket));
      srv.maxConnections = this.cfg.maxStreams;
      try {
        await new Promise<void>((resolve, reject) => {
          const onErr = (e: Error): void => { srv.removeListener('listening', onOk); reject(e); };
          const onOk = (): void => { srv.removeListener('error', onErr); resolve(); };
          srv.once('error', onErr);
          srv.once('listening', onOk);
          srv.listen(port, '127.0.0.1');
        });
      } catch (e) {
        this.bindError = `${name} 127.0.0.1:${port} 绑定失败：${(e as Error).message}`;
        this.log(`[tunnel] ${this.bindError}（通常是 frps 未停干净；/tunnel 将回 bind-failed，PC 应回退 frpc）`);
        try { srv.close(); } catch { /* ignore */ }
        continue;
      }
      srv.on('error', (e: Error) => this.log(`[tunnel] 监听 ${name} 运行期错误：${e.message}`));
      this.listeners.set(name, srv);
      const address = srv.address();
      const actualPort = address && typeof address !== 'string' ? address.port : port;
      this.cfg.services[name] = actualPort;
      this.bound.push(`127.0.0.1:${actualPort}`);
    }
    return this.bindError
      ? { ok: false, bound: this.bound, error: this.bindError }
      : { ok: true, bound: this.bound };
  }

  stop(): void {
    for (const s of [...this.sessions]) s.terminate('server-stop', '网关停止');
    for (const [, srv] of this.listeners) { try { srv.close(); } catch { /* ignore */ } }
    this.listeners.clear();
    this.active = null;
    this.wss.close();
  }

  // ── 升级与鉴权 ────────────────────────────────────────────────────────

  handleUpgrade = (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    if (!this.authenticate(req)) {
      this.log(`[tunnel] 拒绝未授权升级：${req.socket.remoteAddress ?? '?'}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  };

  /** Bearer 共享密钥，定长比较（写法对齐 http.ts 的 launch-token 通道） */
  private authenticate(req: import('node:http').IncomingMessage): boolean {
    if (this.deps.authenticate) return this.deps.authenticate(req);
    const expected = this.deps.agentKey;
    if (!expected) return false;   // 未配置密钥 = 通道关闭（但此处仍回 401，hello 阶段的 tunnel-disabled 才是给 PC 的信号）
    const raw = String(req.headers.authorization ?? '');
    const prefix = 'Bearer ';
    if (!raw.startsWith(prefix)) return false;
    const key = raw.slice(prefix.length);
    if (key.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  }

  private onConnection(ws: WebSocket): void {
    const session = new TunnelSession({
      ws,
      tunnelId: randomUUID(),
      validateHello: (hello) => this.validateHello(hello),
      onReady: (s) => this.onReady(s),
      onClose: (s) => this.onSessionClose(s),
      log: this.log,
      heartbeatMs: this.deps.heartbeatMs,
      pongTimeoutMs: this.deps.pongTimeoutMs,
      handshakeTimeoutMs: this.deps.handshakeTimeoutMs,
      openTimeoutMs: this.deps.openTimeoutMs,
      globalBudget: this.deps.globalBudget,
      maxStreams: this.cfg.maxStreams,
    });
    this.sessions.add(session);
  }

  private validateHello(hello: Extract<ClientFrame, { t: 'hello' }>): HelloResult {
    if (!this.cfg.enabled) {
      return { ok: false, code: TUNNEL_ERROR.tunnelDisabled, message: '内置隧道未启用（服务器 tunnel.enabled=false）' };
    }
    if (!this.deps.agentKey) {
      return { ok: false, code: TUNNEL_ERROR.tunnelDisabled, message: '网关未配置 agentKey，隧道通道关闭' };
    }
    if (this.bindError) {
      return { ok: false, code: TUNNEL_ERROR.bindFailed, message: this.bindError };
    }
    if (!SUPPORTED_VERSIONS.includes(hello.v)) {
      return {
        ok: false,
        code: TUNNEL_ERROR.versionMismatch,
        message: `协议版本不匹配（客户端 v${hello.v}，服务端支持 ${SUPPORTED_VERSIONS.join(',')}）`,
      };
    }
    const declared = new Set((hello.services ?? []).map((s) => s.name));
    const services = new Map<string, number>();
    for (const [name, port] of Object.entries(this.cfg.services)) {
      if (declared.has(name) && this.listeners.has(name)) services.set(name, port);
    }
    if (services.size === 0) {
      return { ok: false, code: TUNNEL_ERROR.badHello, message: '服务无交集（客户端未声明任何本机可提供的服务）' };
    }
    return { ok: true, services };
  }

  private onReady(session: TunnelSession): void {
    const old = this.active;
    if (old && old !== session && !old.isClosed()) {
      // 顶替：先同步终结旧的（其 shutdown 会销毁全部本地 socket 与流），再登记新的
      this.log(`[tunnel] 新连接顶替旧会话 tunnelId=${old.tunnelId}`);
      old.terminate(TUNNEL_ERROR.superseded, '被同 key 的新连接顶替');
    }
    this.active = session;
    this.log(`[tunnel] PC 已连接 tunnelId=${session.tunnelId} client=${session.clientInfo.app ?? '?'}@${session.clientInfo.appVersion ?? '?'} services=${[...session.services.keys()].join(',')}`);
  }

  private onSessionClose(session: TunnelSession): void {
    this.sessions.delete(session);
    if (this.active === session) { this.active = null; this.deps.onDisconnected?.(); }
  }

  // ── 本地监听 → 流 ─────────────────────────────────────────────────────

  private onLocalConnection(service: string, socket: Socket): void {
    const session = this.active;
    if (!session || !session.isOpen() || !session.services.has(service)) {
      // 无隧道（PC 离线）或该服务未声明：立即拒绝，等价于 frps 时代 frpc 未连的表现
      socket.destroy();
      return;
    }
    session.openStream(service, socket);
  }

  // ── 状态（/healthz）───────────────────────────────────────────────────

  /** 当前活动会话（测试与排障用；生产路径只读 state()） */
  activeSession(): TunnelSession | null {
    return this.active;
  }

  state(): TunnelHealth {
    const s = this.active;
    const snap = s?.snapshot();
    return {
      enabled: this.cfg.enabled,
      binding: this.bound,
      bindError: this.bindError,
      active: !!(s && s.isOpen()),
      tunnelId: snap?.tunnelId ?? null,
      client: snap?.client ?? null,
      connectedAt: snap ? new Date(snap.connectedAt).toISOString() : null,
      streams: snap?.streams ?? 0,
      bytesIn: snap?.bytesIn ?? 0,
      bytesOut: snap?.bytesOut ?? 0,
      lastError: this.lastError,
    };
  }
}
