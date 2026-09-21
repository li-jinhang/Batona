/**
 * tunnel/client.js — DSH Link 内置隧道客户端（跑在 Electron 主进程内）
 *
 * 与服务端 src/tunnel/{protocol,server,session,stream}.ts 对端。设计要点：
 *   - wss://<serverIp>:<gwPort>/tunnel，Authorization: Bearer <frpToken>（= 网关 agentKey）
 *   - services 是**回调**而非快照：DSH 端口是运行期从 stdout 抓的，重启会变，open 到达时实时求值
 *   - 三层背压与半关闭规则与服务端逐条同构（见 protocol.js 头注释与 test/tunnel-protocol.test.js 向量）
 *   - 断线指数退避（1s→30s，±20% 抖动），系统唤醒可 reconnectNow() 立即重连
 *   - 致命错误（tunnel-disabled / version-mismatch / bad-hello / bind-failed）→ emit('fatal')，
 *     由 main.js 决定回退 frp（auto 模式）
 *
 * 事件：'connected'(welcome) · 'disconnected'(info) · 'fatal'({code,message}) · 'superseded'() · 'log'(msg)
 */

'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const P = require('./protocol.js');

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const SLOW_RETRY_MS = 60000;

/** 本应用版本（hello 里上报给网关，便于 /healthz 核对 PC 端版本） */
function pkgVersion() {
  try { return require('../package.json').version || ''; } catch { return ''; }
}

/** 需要回退 frp 的终止码（重试也不会好，交给 main.js 切换） */
const FATAL_CODES = [
  P.TUNNEL_ERROR.tunnelDisabled,
  P.TUNNEL_ERROR.versionMismatch,
  P.TUNNEL_ERROR.badHello,
  P.TUNNEL_ERROR.bindFailed,
];

class CStream {
  constructor(client, sid, socket) {
    this.client = client;
    this.sid = sid;
    this.socket = socket;
    this.consumeDir = 's2c';
    this.state = 'active';
    this.credit = 0;
    this.recvAvail = 0;
    this.acc = 0;
    this.bp = false;
    this.bpQueued = 0;
    this.localEnded = false;
    this.peerEnded = false;

    socket.pause();
    socket.on('readable', () => this.pump());
    socket.on('end', () => {
      this.localEnded = true;
      this.client.sendControl({ t: 'close', sid: this.sid, half: 'c2s' });
      this.finish();
    });
    socket.on('drain', () => {
      // 积压字节此刻已交给内核：先结算再回补（漏记这步会让 credit 永不再授予 → 背压后死锁）
      this.acc += this.bpQueued;
      this.bpQueued = 0;
      this.bp = false;
      this.grant();
    });
    socket.on('error', () => this.destroy(true));
    socket.on('close', () => {
      if (this.state === 'closed') return;
      this.destroy(!(this.localEnded && this.peerEnded));
    });
  }

  /** 层 2：有信用时从本地 socket 读并发送 */
  pump() {
    if (this.state === 'closed' || this.socket.destroyed) return;
    while (this.credit > 0) {
      const avail = this.socket.readableLength;
      if (avail <= 0) break;
      const n = Math.min(P.READ_CHUNK, this.credit, avail);
      const buf = this.socket.read(n);
      if (!buf || buf.length === 0) break;
      this.credit -= buf.length;
      this.client.sendData(this.sid, buf);
    }
    if (this.credit <= 0 && !this.socket.isPaused()) this.socket.pause();
  }

  /** 层 1：消费对端数据（写本地 socket，受积压约束） */
  onData(payload) {
    if (this.state === 'closed') return;
    if (payload.length > this.recvAvail) {
      this.client.protocolViolation(`stream ${this.sid} 超窗发送 ${payload.length} > ${this.recvAvail}`);
      return;
    }
    this.recvAvail -= payload.length;
    if (this.socket.destroyed || this.socket.writableEnded) {
      this.acc += payload.length;
      this.grant();
      return;
    }
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

  /** 层 1：回补信用（受积压与单流窗口约束；连接级预算由服务端裁剪，客户端不设总额） */
  grant() {
    if (this.state === 'closed' || this.bp || this.acc <= 0) return;
    const want = Math.min(this.acc, P.MAX_STREAM_WINDOW - this.recvAvail);
    if (want <= 0) return;
    this.recvAvail += want;
    this.acc -= want;
    this.client.sendControl({ t: 'win', sid: this.sid, dir: this.consumeDir, n: want });
  }

  onWin(n) {
    if (this.state === 'closed') return;
    this.credit += n;
    if (this.socket.isPaused() && this.credit > 0 && !this.socket.destroyed) {
      this.socket.resume();
      this.pump();
    }
  }

  onPeerClose(half) {
    if (this.state === 'closed' || half !== this.consumeDir) return;
    this.peerEnded = true;
    if (!this.socket.destroyed && !this.socket.writableEnded) this.socket.end();
    this.finish();
  }

  finish() {
    if (this.localEnded && this.peerEnded && !this.socket.destroyed && !this.socket.writableEnded) {
      this.socket.end();
    }
  }

  pauseRead() {
    if (!this.socket.destroyed && !this.socket.isPaused()) this.socket.pause();
  }

  resumeRead() {
    if (this.state === 'closed' || this.socket.destroyed) return;
    if (this.credit > 0 && this.socket.isPaused()) {
      this.socket.resume();
      this.pump();
    }
  }

  destroy(notify) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (notify) this.client.sendControl({ t: 'reset', sid: this.sid, reason: 'local-closed' });
    if (!this.socket.destroyed) this.socket.destroy();
    this.client.streams.delete(this.sid);
    this.client.emit('streams-changed');
  }
}

class TunnelClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host       服务器 IP/域名
   * @param {number} opts.gwPort     网关端口（默认 443）
   * @param {string} opts.token      共享密钥（连接串 frpToken）
   * @param {() => Array<{name: string, localPort: number}>} opts.services 实时服务清单回调
   * @param {boolean} [opts.tls]     true（默认，生产：Nginx 终结 TLS）/ false（仅测试与本地开发）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    super();
    this.host = opts.host;
    this.gwPort = opts.gwPort || 443;
    this.token = opts.token;
    this.servicesFn = opts.services;
    this.log = opts.log || (() => {});
    this.tls = opts.tls !== false;
    this.appVersion = opts.appVersion || pkgVersion();

    this.ws = null;
    this.stopped = true;
    this.state = 'idle';          // idle | connecting | connected | backoff
    this.streams = new Map();
    this.retry = 0;
    this.timer = null;
    this.inflight = 0;
    this.paused = false;
    this.tunnelId = null;
    this.welcome = null;
    this.lastError = null;
    this.restarts = 0;
    this.connectedOnce = false;
    this._slowRetry = false;
  }

  get connected() {
    return this.state === 'connected';
  }

  getStatus() {
    return {
      kind: 'builtin',
      connected: this.connected,
      state: this.state,
      tunnelId: this.tunnelId,
      streams: this.streams.size,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.retry = 0;
    this.connectOnce().catch(() => { /* 错误路径统一走 scheduleReconnect */ });
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.closeSocket();
    for (const st of [...this.streams.values()]) st.destroy(false);
    this.streams.clear();
    this.state = 'idle';
  }

  /** 系统唤醒/网络切换后立即重连（清零退避） */
  reconnectNow() {
    if (this.stopped) return;
    if (this.connected) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.retry = 0;
    this._slowRetry = false;
    this.closeSocket();
    this.connectOnce().catch(() => { /* ignore */ });
  }

  // ── 连接 ──────────────────────────────────────────────────────────────

  connectOnce() {
    return new Promise((resolve, reject) => {
      if (this.stopped) { resolve(); return; }
      this.state = 'connecting';
      const url = `${this.tls ? 'wss' : 'ws'}://${this.host}:${this.gwPort}${P.TUNNEL_PATH}`;
      this.log(`[tunnel] 连接 ${url}`);
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${this.token}` },
        // 自签证书场景：main.js 的 session.defaultSession 证书豁免对主进程 ws 无效，必须显式关闭校验
        rejectUnauthorized: false,
        handshakeTimeout: 8000,
      });
      this.ws = ws;
      let settled = false;
      const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

      ws.on('open', () => {
        ws.send(P.encodeControl({
          t: 'hello',
          v: P.PROTO_VERSION,
          client: { app: 'DSH Link', appVersion: this.appVersion, os: process.platform },
          services: this.servicesFn().map((s) => ({ name: s.name, localPort: s.localPort })),
        }));
      });
      ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
      ws.on('error', (e) => {
        this.lastError = { code: 'transport', message: e.message };
        settle(reject, e);
      });
      ws.on('close', (code, reason) => {
        this.ws = null;
        if (settled) this.onClosed(`ws-close(${code}) ${String(reason).slice(0, 80)}`);
        else settle(reject, new Error(`closed before welcome (${code})`));
      });

      // 首次收到 welcome 视为连接成功
      this.once('_welcome', (w) => {
        settle(resolve, w);
      });
    });
  }

  onClosed(reason) {
    if (this.stopped) return;
    this.state = 'backoff';
    for (const st of [...this.streams.values()]) st.destroy(false);
    this.streams.clear();
    this.tunnelId = null;
    this.welcome = null;
    this.emit('disconnected', { reason, lastError: this.lastError });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped || this.timer) return;
    let delay;
    if (this._slowRetry) delay = SLOW_RETRY_MS;
    else {
      const base = Math.min(BACKOFF_MIN_MS * 2 ** this.retry, BACKOFF_MAX_MS);
      delay = Math.round(base * (0.8 + Math.random() * 0.4));   // ±20% 抖动
      this.retry = Math.min(this.retry + 1, 8);
    }
    this.restarts += 1;
    this.log(`[tunnel] ${Math.round(delay / 1000)}s 后重连（第 ${this.restarts} 次）`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connectOnce().catch(() => { /* onClosed/scheduleReconnect 兜底 */ });
    }, delay);
  }

  closeSocket() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeAllListeners();
    // ws 在 TLS/HTTP 握手未完成时 terminate() 会异步 emit error；这是预期的
    // 主动关闭，不应因已移除业务监听器而变成 Electron 主进程未捕获异常。
    ws.once('error', () => {});
    try { ws.terminate(); } catch { /* ignore */ }
  }

  // ── 帧处理 ────────────────────────────────────────────────────────────

  sendControl(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(P.encodeControl(frame));
  }

  sendData(sid, buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // 层 3：传输层水位（约束本端 ws 缓冲）
    if (!this.paused && this.inflight + buf.length > P.WS_INFLIGHT_HIGH) {
      this.paused = true;
      for (const st of this.streams.values()) st.pauseRead();
    }
    this.inflight += buf.length;
    this.ws.send(P.encodeDataFrame(sid, buf), (err) => {
      this.inflight -= buf.length;
      if (err) { this.protocolViolation(`ws send: ${err.message}`); return; }
      if (this.paused && this.inflight <= P.WS_INFLIGHT_LOW) {
        this.paused = false;
        for (const st of this.streams.values()) st.resumeRead();
      }
    });
  }

  onMessage(data, isBinary) {
    const buf = data;
    if (isBinary) {
      const f = P.decodeDataFrame(buf);
      if (!f) { this.protocolViolation('非法数据帧'); return; }
      const st = this.streams.get(f.sid);
      if (st) st.onData(f.payload);
      return;
    }
    const f = P.parseServerFrame(buf.toString('utf8'));
    if (!f) { this.protocolViolation('非法控制帧'); return; }
    switch (f.t) {
      case 'welcome': {
        this.welcome = f;
        this.tunnelId = f.tunnelId;
        this.state = 'connected';
        this.retry = 0;
        this.restarts = 0;
        this._slowRetry = false;
        this.lastError = null;
        this.log(`[tunnel] connected tunnelId=${f.tunnelId} services=${f.services.map((s) => s.name).join(',')}`);
        if (!this.connectedOnce) { this.connectedOnce = true; this.emit('first-connect'); }
        this.emit('connected', f);
        this.emit('_welcome', f);
        return;
      }
      case 'error': {
        this.lastError = { code: f.code, message: f.message };
        this.log(`[tunnel] 服务端终止：${f.code} ${f.message}`);
        if (f.code === 'superseded') {
          this.stopped = true;                 // 被自己的另一条连接顶替：静默退出，不重连、不回退
          this.emit('superseded', f);
          return;
        }
        if (this._isFatal(f.code)) {
          this.stopped = true;
          this.emit('fatal', { code: f.code, message: f.message });
          return;
        }
        if (f.code === P.TUNNEL_ERROR.unauthorized) this._slowRetry = true;   // 密钥问题：慢速重试避免打服务器
        return;                                // 其余（protocol-error 等）走 close → 退避
      }
      case 'open': {
        this.onOpen(f.sid, f.service);
        return;
      }
      case 'close': {
        const st = this.streams.get(f.sid);
        if (st) st.onPeerClose(f.half);
        return;
      }
      case 'reset': {
        const st = this.streams.get(f.sid);
        if (st) st.destroy(false);
        return;
      }
      case 'win': {
        const st = this.streams.get(f.sid);
        if (st) st.onWin(f.n);
        return;
      }
      default:
        return;
    }
  }

  _isFatal(code) {
    return FATAL_CODES.includes(code);
  }

  protocolViolation(msg) {
    this.log(`[tunnel] 协议违规：${msg}`);
    this.lastError = { code: P.TUNNEL_ERROR.protocolError, message: msg };
    this.closeSocket();   // 触发 close → 退避重连
  }

  /** 服务端发起一条流：连本机对应端口并应答 open-result */
  onOpen(sid, service) {
    if (this.streams.has(sid)) {
      this.sendControl({ t: 'open-result', sid, ok: false, err: P.STREAM_ERROR.duplicateSid });
      return;
    }
    const svc = this.servicesFn().find((s) => s.name === service);
    if (!svc || !svc.localPort) {
      this.sendControl({ t: 'open-result', sid, ok: false, err: P.STREAM_ERROR.unknownService });
      return;
    }
    const socket = net.connect({ host: '127.0.0.1', port: svc.localPort, allowHalfOpen: true });
    const st = new CStream(this, sid, socket);
    this.streams.set(sid, st);
    this.emit('streams-changed');
    socket.once('connect', () => {
      this.sendControl({ t: 'open-result', sid, ok: true });
      // 初始窗口（本端消费方向 s2c）
      st.acc = P.INITIAL_WINDOW;
      st.grant();
      st.pump();
    });
    socket.once('error', (e) => {
      const code = e.code === 'ECONNREFUSED' ? P.STREAM_ERROR.connectRefused : P.STREAM_ERROR.connectFailed;
      this.streams.delete(sid);
      this.sendControl({ t: 'open-result', sid, ok: false, err: code });
    });
  }
}

module.exports = { TunnelClient };
