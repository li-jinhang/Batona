/**
 * tunnel/stream.ts — 一条隧道流的生命周期 + 三层背压
 *
 * 方向语义（全文以"数据来源"命名）：
 *   produceDir —— 本端产出的数据方向（服务端 = 's2c'，客户端 = 'c2s'）
 *   consumeDir —— 本端消费的数据方向（对端产出）
 * 本地 socket 的 readable 侧产出 produceDir，writable 侧消费 consumeDir。
 *
 * 半关闭规则（协议核心，两侧对称）：
 *   - 本地 socket 'end'（readable 侧收到 FIN）        → 发 close{half: produceDir}
 *   - 收到 close{half: consumeDir}（对端不再产出）    → 本地 socket.end()（把 FIN 透传给下游）
 *   - 两侧都完成后，等本地 socket 自然 'close'（flush 完再关）→ 销毁；不能提前 destroy，否则截断尾段
 *
 * 背压三层（防 OOM，逐行对应设计文档 §背压）：
 *   层 1 流级信用（recvAvail/acc/grant）—— 约束"对端能给我发多少"，进而约束本端内存
 *   层 2 发送信用（credit）—— 约束"我从本地 socket 读多快"
 *   层 3 传输水位（由 session.sendBinary 承担）—— 约束 ws 缓冲
 */

import type { Socket } from 'node:net';
import {
  INITIAL_WINDOW, MAX_STREAM_WINDOW, OPEN_TIMEOUT_MS, READ_CHUNK,
  STREAM_ERROR, TUNNEL_ERROR,
  type ServerFrame, type StreamDir,
} from './protocol.ts';

/** 流对会话的反向依赖（session.ts 实现） */
export interface StreamSession {
  sendControl(frame: ServerFrame): void;
  /** 层 3：交给 ws 并计入 inflight；回调释放时可能触发全局 resume */
  sendBinary(sid: number, buf: Buffer): void;
  /** 从连接级预算里申请授予额度（已按单流窗口与全局预算裁剪） */
  grantBudget(dir: StreamDir, want: number): number;
  /** 归还该方向剩余的"已授予未消费"额度（流关闭时调用，否则预算只减不增） */
  releaseBudget(dir: StreamDir, n: number): void;
  /** 从会话注销该流 */
  freeStream(sid: number, stream: TunnelStream): void;
  /** 本流因预算耗尽暂时无法回补信用：登记等待（预算释放时会被 kickGrant 唤醒） */
  noteWaiting(stream: TunnelStream): void;
  /** 协议违规：终结整条隧道 */
  terminate(code: string, message: string): void;
  log(msg: string): void;
}

export type StreamState = 'opening' | 'active' | 'closed';

export class TunnelStream {
  readonly sid: number;
  readonly service: string;
  readonly produceDir: StreamDir;
  readonly consumeDir: StreamDir;

  private socket: Socket;
  private session: StreamSession;
  private state: StreamState = 'opening';

  /** 层 2：我可发送的剩余信用（对端 win 累加，发送时递减） */
  private credit = 0;
  /** 层 1：我已授予对端、尚未消费的字节数 */
  private recvAvail = 0;
  /** 层 1：已消费、待回补的字节数 */
  private acc = 0;
  /** 层 1：本地写积压（write() 返回 false 且未 drain）——积压期间拒不回补 */
  private bp = false;
  /** 积压期间已入写缓冲、尚未结算的字节数（drain/写回落后补记为已消费） */
  private bpQueued = 0;
  /** 层 3：被会话的全局水位暂停读 */
  private pausedBySession = false;

  private localEnded = false;
  private peerEnded = false;
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { sid: number; service: string; socket: Socket; session: StreamSession; produceDir: StreamDir; openTimeoutMs?: number }) {
    this.sid = opts.sid;
    this.service = opts.service;
    this.socket = opts.socket;
    this.session = opts.session;
    this.produceDir = opts.produceDir;
    this.consumeDir = this.produceDir === 's2c' ? 'c2s' : 's2c';

    // 建流完成（open-result）之前不读本地数据，先压住
    this.socket.pause();
    this.socket.on('readable', () => this.pumpLocalRead());
    this.socket.on('end', () => this.onLocalEnd());
    this.socket.on('drain', () => this.onLocalDrain());
    this.socket.on('error', (e) => this.destroy(`socket-error: ${(e as Error).message}`, true));
    this.socket.on('close', () => this.onLocalClose());

    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      if (this.state === 'opening') {
        this.session.log(`[tunnel] stream ${this.sid} open-timeout（对端未应答）`);
        this.destroy(STREAM_ERROR.openTimeout, true);
      }
    }, opts.openTimeoutMs ?? OPEN_TIMEOUT_MS);
  }

  snapshot(): { sid: number; service: string; state: StreamState; credit: number; recvAvail: number; acc: number; bp: boolean } {
    return { sid: this.sid, service: this.service, state: this.state, credit: this.credit, recvAvail: this.recvAvail, acc: this.acc, bp: this.bp };
  }

  isClosed(): boolean {
    return this.state === 'closed';
  }

  // ── 建流 ──────────────────────────────────────────────────────────────

  /** 对端应答 open-result */
  onOpenResult(ok: boolean, err?: string): void {
    if (this.state !== 'opening') return;
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null; }
    if (!ok) {
      this.session.log(`[tunnel] stream ${this.sid} 建流失败：${err ?? 'unknown'}`);
      this.destroy(err ?? STREAM_ERROR.connectFailed, false);
      return;
    }
    this.state = 'active';
    // 初始窗口：用 acc 承载"还未发出的授予"，由 maybeGrant 按预算裁剪后发出
    this.acc = INITIAL_WINDOW;
    this.maybeGrant();
    this.pumpLocalRead();
  }

  // ── 层 2：从本地 socket 读（只在有信用时读）────────────────────────────

  private pumpLocalRead(): void {
    if (this.state !== 'active' || this.pausedBySession || this.socket.destroyed) return;
    while (this.credit > 0) {
      const avail = this.socket.readableLength;
      if (avail <= 0) break;
      const n = Math.min(READ_CHUNK, this.credit, avail);
      const buf = this.socket.read(n) as Buffer | null;
      if (!buf || buf.length === 0) break;
      this.credit -= buf.length;
      this.session.sendBinary(this.sid, buf);
    }
    // 信用耗尽或没有更多数据：信用耗尽时必须真正停读（内核/上游自然背压）
    if (this.credit <= 0 && !this.socket.isPaused()) this.socket.pause();
  }

  /** 对端回补信用 */
  onRemoteWin(n: number): void {
    if (this.state === 'closed') return;
    this.credit += n;
    if (this.credit > MAX_STREAM_WINDOW) {
      // 对端是正确实现时不可能出现（它的 avail == 我的 credit，且受同一上限约束）
      this.session.terminate(TUNNEL_ERROR.flowControlViolation, `stream ${this.sid} 信用累计超上限（${this.credit}）`);
      return;
    }
    if (this.state === 'active' && !this.pausedBySession && this.socket.isPaused()) {
      this.socket.resume();
      this.pumpLocalRead();
    }
  }

  // ── 层 1：消费对端数据 ────────────────────────────────────────────────

  onRemoteData(payload: Buffer): void {
    if (this.state === 'closed') return;
    if (this.state !== 'active') {
      this.session.terminate(TUNNEL_ERROR.protocolError, `stream ${this.sid} 在 active 前收到数据`);
      return;
    }
    if (payload.length > this.recvAvail) {
      this.session.terminate(TUNNEL_ERROR.flowControlViolation, `stream ${this.sid} 超窗发送（${payload.length} > ${this.recvAvail}）`);
      return;
    }
    this.recvAvail -= payload.length;
    this.session.releaseBudget(this.consumeDir, payload.length);

    if (this.socket.destroyed || this.socket.writableEnded) {
      // 本地写侧已关闭（对端仍发了数据）：按"对端 FIN 后仍有在途数据"容错处理，丢弃但不报错
      this.acc += payload.length;
      this.maybeGrant();
      return;
    }
    const ok = this.socket.write(payload);
    if (ok) {
      this.acc += payload.length;
      // 写缓冲已回落到水位之下：之前积压的字节一并视为消费完成
      if (this.bp) { this.bp = false; this.acc += this.bpQueued; this.bpQueued = 0; }
      this.maybeGrant();
    } else {
      this.bp = true;
      this.bpQueued += payload.length;
    }
  }

  private onLocalDrain(): void {
    // 积压的字节此刻已交给内核（消费完成），先结算再回补信用——
    // 漏记这步会让 acc 恒为 0，信用永不再授予，背压后整条流死锁
    this.acc += this.bpQueued;
    this.bpQueued = 0;
    this.bp = false;
    this.maybeGrant();
  }

  /** 层 1：把已消费的字节折算成信用回补（受本地积压、单流窗口与本端预算约束） */
  private maybeGrant(): void {
    if (this.state === 'closed' || this.bp || this.acc <= 0) return;
    const want = Math.min(this.acc, MAX_STREAM_WINDOW - this.recvAvail);
    if (want <= 0) return;
    const n = this.session.grantBudget(this.consumeDir, want);
    if (n <= 0) {
      // 预算耗尽：留在 acc，登记等待，等预算释放时由会话统一唤醒重试
      this.session.noteWaiting(this);
      return;
    }
    this.recvAvail += n;
    this.acc -= n;
    this.session.sendControl({ t: 'win', sid: this.sid, dir: this.consumeDir, n });
  }

  /** 供会话在预算释放后唤醒（见 session.pumpWaitingGrants） */
  kickGrant(): void {
    this.maybeGrant();
  }

  // ── 层 3：被会话全局水位暂停/恢复 ─────────────────────────────────────

  pauseLocalRead(): void {
    this.pausedBySession = true;
    if (!this.socket.isPaused()) this.socket.pause();
  }

  resumeLocalRead(): void {
    this.pausedBySession = false;
    if (this.state === 'active' && !this.socket.destroyed && this.credit > 0 && this.socket.isPaused()) {
      this.socket.resume();
      this.pumpLocalRead();
    }
  }

  // ── 半关闭与销毁 ──────────────────────────────────────────────────────

  private onLocalEnd(): void {
    if (this.state === 'closed' || this.localEnded) return;
    this.localEnded = true;
    this.session.sendControl({ t: 'close', sid: this.sid, half: this.produceDir });
    this.finishIfDone();
  }

  /** 对端声明不再产出某方向数据 */
  onRemoteClose(half: StreamDir): void {
    if (this.state === 'closed') return;
    if (half !== this.consumeDir) return;   // 对端应当只声明它自己的产出方向；其它情况容错忽略
    this.peerEnded = true;
    if (!this.socket.destroyed && !this.socket.writableEnded) this.socket.end();
    this.finishIfDone();
  }

  /** 收到对端 reset：立即双向销毁，不回发 */
  onRemoteReset(_reason?: string): void {
    this.destroy(STREAM_ERROR.peerReset, false);
  }

  private finishIfDone(): void {
    if (this.state !== 'closed' && this.localEnded && this.peerEnded) {
      // 两侧都结束：写侧已 end()，等本地 socket flush 完自然 'close'（onLocalClose 收尾）
      if (!this.socket.destroyed && !this.socket.writableEnded) this.socket.end();
    }
  }

  private onLocalClose(): void {
    if (this.state === 'closed') return;
    // 本地 socket 完全关闭：若我们还没走完半关闭流程，说明是异常断开 → 通知对端 reset
    const needNotify = !(this.localEnded && this.peerEnded);
    this.destroy(STREAM_ERROR.localClosed, needNotify);
  }

  /** 立即销毁；notifyPeer 时向对端发 reset */
  destroy(reason: string, notifyPeer: boolean): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null; }
    if (notifyPeer) this.session.sendControl({ t: 'reset', sid: this.sid, reason });
    if (!this.socket.destroyed) this.socket.destroy();
    // 归还该方向剩余的"已授予未消费"额度，并催promote其它等待预算的流
    this.session.releaseBudget(this.consumeDir, this.recvAvail);
    this.recvAvail = 0;
    this.session.freeStream(this.sid, this);
  }
}
