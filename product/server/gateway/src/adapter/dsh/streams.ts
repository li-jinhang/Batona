/**
 * adapter/dsh/streams.ts — DSH 逻辑流客户端（WS /api/remote.mux）
 *
 * DSH 0.1.2+ 把所有流式 Remote 方法（session/follow、workspace/follow）以及
 * 内部事件流（$events）都多路复用到一条 WebSocket 上：
 *
 *   客户端 → Host：{type:'open',streamId,endpoint,payload:{args}} | {type:'cancel',streamId}
 *   Host → 客户端：{type:'item',streamId,value} | {type:'error',streamId,error} | {type:'end',streamId}
 *
 * 键集合是精确匹配（服务端 exactKeys 校验），不得附带多余字段。
 * 升级握手与 /api 一样受 BrowserAuth 保护：须带 dsh-auth-<authority> cookie。
 *
 * 连接语义：socket 断开 → 本代所有逻辑流失效 → 指数退避重连（500ms 起，上限 30s）
 * 后按注册顺序重新 open（每条流的首个 item 是 Host 提供的 baseline/snapshot，
 * 消费方据此重新对齐状态）。401 时先重新交换 cookie 再重连。
 *
 * 使用 `ws` 包（而非 Node 全局 WebSocket），兼容 Node 18+。
 */

import { WebSocket } from 'ws';
import type { DshRpcError, DshStreamClientMessage, DshStreamServerMessage } from './types.ts';

/** 逻辑流认证来源（由 DshApiClient 提供） */
export interface DshMuxAuth {
  authority?: string;
  /** 当前认证 cookie（未认证为 null） */
  getCookie(): string | null;
  /** 载体被拒（401）时调用：重新用 launch token 交换 cookie */
  onUnauthorized(): Promise<void>;
}

export interface DshStreamHandlers {
  /** 诊断名（日志用） */
  readonly name: string;
  /** 一条流数据 */
  onItem(value: unknown): void;
  /** 该流失败（服务端 error 帧或载体丢失）；实现方可选择重开 */
  onError?(error: DshRpcError): void;
  /** 服务端正常结束该流 */
  onEnd?(): void;
}

interface RegisteredStream {
  readonly endpoint: string;
  readonly args: Record<string, unknown>;
  readonly handlers: DshStreamHandlers;
}

export interface DshRemoteMuxOptions {
  /** 连接状态回调（connecting / open / reconnecting / closed） */
  onStateChange?: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
  /** 连接代次回调：每次物理连接建立时调用（消费方可用作日志锚点） */
  onGeneration?: () => void;
}

export class DshRemoteMux {
  private readonly wsUrl: string;
  private readonly auth: DshMuxAuth;
  private readonly opts: DshRemoteMuxOptions;
  private readonly streams = new Map<string, RegisteredStream>();
  private socket: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(baseHttpUrl: string, auth: DshMuxAuth, opts: DshRemoteMuxOptions = {}) {
    const wsBase = baseHttpUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
    this.wsUrl = `${wsBase}/api/remote.mux`;
    this.auth = auth;
    this.opts = opts;
  }

  /** 打开载波并（重）开所有已注册逻辑流；幂等 */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /**
   * 注册并打开一条逻辑流（幂等：同 endpoint+args 可重复调用，但 streamId 由调用方持有）。
   * @returns streamId（用于 cancel）
   */
  open(endpoint: string, args: Record<string, unknown>, handlers: DshStreamHandlers): string {
    const streamId = crypto.randomUUID();
    this.streams.set(streamId, { endpoint, args, handlers });
    this.sendOpen(streamId);
    return streamId;
  }

  /** 取消一条逻辑流（同时从重连列表移除） */
  cancel(streamId: string): void {
    if (!this.streams.delete(streamId)) return;
    this.send({ type: 'cancel', streamId });
  }

  /** 该逻辑流是否仍在册（用于判断是否需要重开） */
  has(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.streams.clear();
    this.closeSocket();
    this.opts.onStateChange?.('closed');
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    this.closeSocket();
    this.opts.onStateChange?.(this.retry === 0 ? 'connecting' : 'reconnecting');
    this.generation += 1;

    const cookie = this.auth.getCookie();
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (this.auth.authority) headers.host = this.auth.authority;
    const wsOpts = { headers };
    const socket = new WebSocket(this.wsUrl, wsOpts);
    this.socket = socket;

    // ws 库：'error' 必须监听，否则后端离线（ECONNREFUSED 等）会直接崩溃进程。
    socket.on('error', () => { /* 由 close 统一处理重连 */ });
    // 握手被拒（401/403）：读取状态码后交由 close/error 路径处理
    socket.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      if (status === 401) {
        console.warn('[dsh-stream] remote.mux 401：重新交换 launch token cookie');
        void this.auth.onUnauthorized().catch(() => { /* 下次重连再试 */ });
      } else {
        console.warn(`[dsh-stream] remote.mux 升级被拒 HTTP ${status}`);
      }
      socket.terminate();
    });

    socket.on('open', () => {
      this.retry = 0;
      this.opts.onStateChange?.('open');
      // 先取本代需要补开的流（onGeneration 中新建的流在自己的 open() 里已下发，
      // 不得在下面重复下发：同一 socket 上重复 streamId 会被服务端以 1008 断开）
      const known = [...this.streams.keys()];
      this.opts.onGeneration?.();
      for (const streamId of known) this.sendOpen(streamId);
    });

    // 陈旧代次（已被替换/停止）的事件一律丢弃
    const current = (): boolean => this.socket === socket && !this.stopped;

    socket.on('message', (data) => {
      if (!current()) return;
      this.onMessage(data);
    });
    socket.on('close', (code, reason) => {
      if (!current()) return;
      this.socket = null;
      console.warn(`[dsh-stream] remote.mux 关闭 code=${code} reason=${String(reason).slice(0, 120)}`);
      this.scheduleReconnect();
    });
  }

  private onMessage(data: unknown): void {
    let msg: DshStreamServerMessage;
    try {
      msg = JSON.parse(String(data)) as DshStreamServerMessage;
    } catch {
      console.warn('[dsh-stream] 忽略非法帧（非 JSON）');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.streamId !== 'string') return;
    const stream = this.streams.get(msg.streamId);
    if (!stream) return;   // 已取消 / 旧代次的迟到帧

    switch (msg.type) {
      case 'item':
        try {
          stream.handlers.onItem(msg.value);
        } catch (e) {
          console.error(`[dsh-stream] ${stream.handlers.name} 处理帧异常：${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      case 'error':
        console.warn(`[dsh-stream] ${stream.handlers.name} 出错：${msg.error?.code} ${msg.error?.message}`);
        this.streams.delete(msg.streamId);
        stream.handlers.onError?.(msg.error ?? { code: 'stream-error', message: 'unknown', details: {} });
        break;
      case 'end':
        console.log(`[dsh-stream] ${stream.handlers.name} 结束`);
        this.streams.delete(msg.streamId);
        stream.handlers.onEnd?.();
        break;
      default:
        break;
    }
  }

  private sendOpen(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.send({ type: 'open', streamId, endpoint: stream.endpoint, payload: { args: stream.args } });
  }

  private send(msg: DshStreamClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;   // 未连接：重连时会重开
    if (process.env.DSH_DEBUG_STREAMS) console.log(`[dsh-stream][send] ${JSON.stringify(msg).slice(0, 200)}`);
    socket.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(500 * 2 ** this.retry, 30_000);
    this.retry = Math.min(this.retry + 1, 8);
    this.opts.onStateChange?.('reconnecting');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    // 保留 error 监听（EventEmitter 无 error 监听时会抛），仅 terminate；
    // 其 close/error 回调因 this.socket 已变化而被 current() 丢弃。
    try { socket.terminate(); } catch { /* ignore */ }
  }
}
