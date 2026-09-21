/**
 * tunnel/session.ts — 一条隧道 WS 连接的服务端会话
 *
 * 职责：
 *   - 握手：等待 hello（超时 10s）→ 校验（由 TunnelServer 注入）→ 发 welcome
 *   - 流表：sid 分配 / 查找 / 注销；连接级预算（GLOBAL_BUDGET，两方向各自计数）
 *   - 层 3 传输水位：inflight 超 WS_INFLIGHT_HIGH 全局暂停各流读，回落 LOW 恢复
 *   - 心跳：20s ping，60s 无 pong 判死（半死 TCP 不产生 close 事件，只能靠 pong）
 *
 * 预算不变量：任一方向上 Σ(流的 recvAvail) ≤ GLOBAL_BUDGET。
 * 流关闭时经 releaseBudget 归还剩余额度，并唤醒等待中的流（否则预算只减不增，最终全隧道饿死）。
 */

import type { WebSocket } from 'ws';
import {
  GLOBAL_BUDGET, HEARTBEAT_MS, HANDSHAKE_TIMEOUT_MS, INITIAL_WINDOW, MAX_STREAMS, MAX_STREAM_WINDOW,
  OPEN_TIMEOUT_MS, PONG_TIMEOUT_MS,
  TUNNEL_ERROR, WS_INFLIGHT_HIGH, WS_INFLIGHT_LOW,
  decodeDataFrame, encodeControl, encodeDataFrame, parseClientFrame,
  type ClientFrame, type ClientInfo, type ServerFrame, type StreamDir,
} from './protocol.ts';
import { TunnelStream, type StreamSession } from './stream.ts';

export interface HelloResult {
  ok: boolean;
  code?: string;
  message?: string;
  /** 服务交集：服务名 → 网关侧绑定端口 */
  services?: Map<string, number>;
}

export interface TunnelSessionOptions {
  ws: WebSocket;
  tunnelId: string;
  /** 校验 hello（含 enabled / 版本 / 服务交集 / 顶替旧会话），由 TunnelServer 注入 */
  validateHello: (hello: Extract<ClientFrame, { t: 'hello' }>) => HelloResult;
  /** 会话就绪（welcome 已发）；服务端在此登记为活动会话 */
  onReady: (session: TunnelSession) => void;
  /** 会话关闭（任何原因）；服务端在此注销 */
  onClose: (session: TunnelSession) => void;
  log: (msg: string) => void;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  openTimeoutMs?: number;
  globalBudget?: number;
  maxStreams?: number;
}

export class TunnelSession implements StreamSession {
  readonly tunnelId: string;
  clientInfo: ClientInfo = {};
  /** hello 确定的最终服务交集：服务名 → 网关侧绑定端口（openStream 前据此校验） */
  readonly services = new Map<string, number>();
  readonly connectedAt = Date.now();

  private ws: WebSocket;
  private opts: TunnelSessionOptions;
  private state: 'awaiting-hello' | 'open' | 'closed' = 'awaiting-hello';

  private streams = new Map<number, TunnelStream>();
  private globalAvail: Record<StreamDir, number> = { c2s: 0, s2c: 0 };
  private waiting = new Set<TunnelStream>();
  private sidSeq = 0;

  private inflight = 0;
  private paused = false;

  private bytesIn = 0;
  private bytesOut = 0;
  private lastPong = Date.now();
  private timers: ReturnType<typeof setInterval>[] = [];
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TunnelSessionOptions) {
    this.ws = opts.ws;
    this.opts = opts;
    this.tunnelId = opts.tunnelId;

    this.ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    this.ws.on('pong', () => { this.lastPong = Date.now(); });
    this.ws.on('error', (e) => this.opts.log(`[tunnel] ws error: ${(e as Error).message}`));
    this.ws.on('close', (code) => this.shutdown(`ws-close(${code})`));

    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.state === 'awaiting-hello') this.terminate(TUNNEL_ERROR.protocolError, 'handshake timeout');
    }, opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  }

  // ── 状态查询（/healthz 与测试）──────────────────────────────────────

  isOpen(): boolean {
    return this.state === 'open';
  }

  isClosed(): boolean {
    return this.state === 'closed';
  }

  streamCount(): number {
    return this.streams.size;
  }

  getStream(sid: number): TunnelStream | undefined {
    return this.streams.get(sid);
  }

  streamSnapshots(): ReturnType<TunnelStream['snapshot']>[] {
    return [...this.streams.values()].map((s) => s.snapshot());
  }

  availTotal(dir: StreamDir): number {
    return this.globalAvail[dir];
  }

  /** 测试用：注入一条已 accept 的本地连接（生产路径是 TunnelServer 的监听器调用） */
  openStream(service: string, socket: import('node:net').Socket): TunnelStream | null {
    if (this.state !== 'open') {
      socket.destroy();
      return null;
    }
    if (this.streams.size >= (this.opts.maxStreams ?? MAX_STREAMS)) {
      this.opts.log(`[tunnel] 流数超限（${this.streams.size}），拒绝新连接`);
      socket.destroy();
      return null;
    }
    const sid = this.allocSid();
    if (sid === 0) {
      socket.destroy();
      return null;
    }
    const stream = new TunnelStream({
      sid,
      service,
      socket,
      session: this,
      produceDir: 's2c',
      openTimeoutMs: this.opts.openTimeoutMs ?? OPEN_TIMEOUT_MS,
    });
    this.streams.set(sid, stream);
    this.sendControl({ t: 'open', sid, service });
    return stream;
  }

  private allocSid(): number {
    // u32 递增，0 是保留哨兵；跳过在用值（并发上限内回绕不可达，但代码不依赖这一点）
    for (let i = 0; i < 2 * (this.opts.maxStreams ?? MAX_STREAMS); i++) {
      this.sidSeq = (this.sidSeq + 1) >>> 0;
      if (this.sidSeq === 0) this.sidSeq = 1;
      if (!this.streams.has(this.sidSeq)) return this.sidSeq;
    }
    return 0;
  }

  // ── StreamSession 接口（供 TunnelStream 反向调用）────────────────────

  log(msg: string): void {
    this.opts.log(msg);
  }

  sendControl(frame: ServerFrame): void {
    if (this.state === 'closed') return;
    if (this.ws.readyState !== 1 /* OPEN */) return;
    this.ws.send(encodeControl(frame));
  }

  sendBinary(sid: number, buf: Buffer): void {
    if (this.state === 'closed' || this.ws.readyState !== 1) return;
    this.bytesOut += buf.length;
    if (!this.paused && this.inflight + buf.length > WS_INFLIGHT_HIGH) {
      this.paused = true;
      for (const s of this.streams.values()) s.pauseLocalRead();
    }
    this.inflight += buf.length;
    // 必须经 encodeDataFrame 加 4 字节 sid 头——直接 ws.send(buf) 会把裸字节当作已封帧数据发出去
    this.ws.send(encodeDataFrame(sid, buf), (err?: Error) => {
      this.inflight -= buf.length;
      if (err) { this.terminate('transport-error', err.message); return; }
      if (this.paused && this.inflight <= WS_INFLIGHT_LOW) {
        this.paused = false;
        for (const s of this.streams.values()) s.resumeLocalRead();
      }
    });
  }

  /** 连接级预算裁剪（单流窗口由 TunnelStream 自行裁剪后传入 want） */
  grantBudget(dir: StreamDir, want: number): number {
    const room = (this.opts.globalBudget ?? GLOBAL_BUDGET) - this.globalAvail[dir];
    const n = Math.min(want, room);
    if (n <= 0) return 0;
    this.globalAvail[dir] += n;
    return n;
  }

  releaseBudget(dir: StreamDir, n: number): void {
    if (n <= 0) return;
    this.globalAvail[dir] = Math.max(0, this.globalAvail[dir] - n);
    if (this.waiting.size > 0) this.pumpWaitingGrants();
  }

  noteWaiting(stream: TunnelStream): void {
    this.waiting.add(stream);
  }

  freeStream(sid: number, stream: TunnelStream): void {
    this.streams.delete(sid);
    this.waiting.delete(stream);
  }

  /** 预算释放后唤醒此前被饿住的流（单趟即可：仍饿着的会重新登记） */
  private pumpWaitingGrants(): void {
    const pending = [...this.waiting];
    this.waiting.clear();
    for (const s of pending) {
      if (!s.isClosed()) s.kickGrant();
    }
  }

  terminate(code: string, message: string): void {
    if (this.state === 'closed') return;
    this.opts.log(`[tunnel] 会话终止 code=${code} message=${message}`);
    this.sendControl({ t: 'error', code, message });
    this.shutdown(`terminate(${code})`);
    try { this.ws.close(1008, code.slice(0, 100)); } catch { /* ignore */ }
  }

  // ── 消息处理 ─────────────────────────────────────────────────────────

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.state === 'closed') return;
    if (isBinary) {
      const frame = decodeDataFrame(data);
      if (!frame) { this.terminate(TUNNEL_ERROR.protocolError, '非法数据帧'); return; }
      this.bytesIn += frame.payload.length;
      const stream = this.streams.get(frame.sid);
      if (!stream) return;   // 未知 sid：静默丢弃（流刚关闭时的在途数据是正常竞态）
      stream.onRemoteData(frame.payload);
      return;
    }

    const text = data.toString('utf8');
    const frame = parseClientFrame(text);
    if (!frame) { this.terminate(TUNNEL_ERROR.protocolError, `非法控制帧：${text.slice(0, 80)}`); return; }

    if (this.state === 'awaiting-hello') {
      if (frame.t !== 'hello') { this.terminate(TUNNEL_ERROR.protocolError, 'hello 之前收到其它帧'); return; }
      this.onHello(frame);
      return;
    }

    switch (frame.t) {
      case 'hello':
        this.terminate(TUNNEL_ERROR.protocolError, '重复 hello');
        return;
      case 'open-result': {
        const stream = this.streams.get(frame.sid);
        if (!stream) return;   // 10s open 超时后收到迟到的应答是正常竞态 → 静默丢弃
        stream.onOpenResult(frame.ok, frame.err);
        return;
      }
      case 'close': {
        const stream = this.streams.get(frame.sid);
        if (!stream) return;
        stream.onRemoteClose(frame.half);
        return;
      }
      case 'reset': {
        const stream = this.streams.get(frame.sid);
        if (!stream) return;
        stream.onRemoteReset(frame.reason);
        return;
      }
      case 'win': {
        const stream = this.streams.get(frame.sid);
        if (!stream) return;
        stream.onRemoteWin(frame.n);
        return;
      }
      default:
        this.terminate(TUNNEL_ERROR.protocolError, `未知帧类型`);
    }
  }

  private onHello(hello: Extract<ClientFrame, { t: 'hello' }>): void {
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
    const result = this.opts.validateHello(hello);
    if (!result.ok) {
      this.terminate(result.code ?? TUNNEL_ERROR.badHello, result.message ?? 'hello rejected');
      return;
    }
    this.clientInfo = hello.client ?? {};
    this.services.clear();
    for (const [name, port] of result.services ?? []) this.services.set(name, port);
    this.state = 'open';
    this.sendControl({
      t: 'welcome',
      v: 1,
      tunnelId: this.tunnelId,
      heartbeatSec: (this.opts.heartbeatMs ?? HEARTBEAT_MS) / 1000,
      window: {
        initial: INITIAL_WINDOW,
        max: MAX_STREAM_WINDOW,
        global: this.opts.globalBudget ?? GLOBAL_BUDGET,
      },
      services: [...(result.services ?? new Map<string, number>())].map(([name, port]) => ({ name, bind: ['127.0.0.1', port] as [string, number] })),
    });
    this.startHeartbeat();
    this.opts.onReady(this);
  }

  private startHeartbeat(): void {
    const hb = this.opts.heartbeatMs ?? HEARTBEAT_MS;
    const timeout = this.opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.timers.push(setInterval(() => {
      if (this.state === 'closed') return;
      try { this.ws.ping(); } catch { /* close 路径会收尾 */ }
    }, hb));
    this.timers.push(setInterval(() => {
      if (this.state === 'closed') return;
      if (Date.now() - this.lastPong > timeout) {
        // 半死 TCP：不产生 close 事件，只能靠 pong 缺失判定
        this.terminate('idle-timeout', `超过 ${timeout}ms 未收到 pong`);
      }
    }, hb));
  }

  snapshot(): {
    tunnelId: string; client: ClientInfo; connectedAt: number; streams: number;
    bytesIn: number; bytesOut: number; inflight: number; globalAvail: Record<StreamDir, number>;
    waiting: number; open: boolean;
  } {
    return {
      tunnelId: this.tunnelId,
      client: this.clientInfo,
      connectedAt: this.connectedAt,
      streams: this.streams.size,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      inflight: this.inflight,
      globalAvail: { ...this.globalAvail },
      waiting: this.waiting.size,
      open: this.state === 'open',
    };
  }

  // ── 收尾 ─────────────────────────────────────────────────────────────

  private shutdown(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of [...this.streams.values()]) s.destroy('session-closed', false);
    this.streams.clear();
    this.waiting.clear();
    this.opts.log(`[tunnel] 会话关闭（${reason}）tunnelId=${this.tunnelId} bytesIn=${this.bytesIn} bytesOut=${this.bytesOut}`);
    this.opts.onClose(this);
  }
}
