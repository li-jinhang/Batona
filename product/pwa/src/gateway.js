export class GatewayClient {
  constructor(onFrame, onState) {
    this.onFrame = onFrame;
    this.onState = onState;
    this.socket = null;
    this.pending = new Map();
    this.token = '';
    this.closed = false;
    this.retry = 0;
    this.reconnectTimer = null;
  }

  async connect(token) {
    this.token = token;
    this.closed = false;
    return this.openSocket();
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}/ws`);
      this.socket = socket;
      let settled = false;
      socket.addEventListener('open', async () => {
        try {
          this.hello = await this.request('auth.hello', { token: this.token });
          this.retry = 0;
          this.onState(true);
          settled = true;
          resolve(this.hello);
        } catch (error) {
          settled = true;
          reject(error);
          socket.close();
        }
      }, { once: true });
      socket.addEventListener('message', event => {
        let frame;
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        if (frame.type === 'server-response' && this.pending.has(frame.rpcId)) {
          const item = this.pending.get(frame.rpcId);
          clearTimeout(item.timer);
          this.pending.delete(frame.rpcId);
          if (frame.result?.ok) item.resolve(frame.result.value);
          else item.reject(new Error(frame.result?.error?.message || frame.result?.error?.code || 'Gateway request failed'));
          return;
        }
        if (frame.type === 'server-request') this.onFrame(frame);
      });
      socket.addEventListener('error', () => {
        if (!settled) { settled = true; reject(new Error('网关暂时无法连接')); }
      });
      socket.addEventListener('close', event => {
        this.onState(false);
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('连接已中断，请重试')); }
        this.pending.clear();
        if (event.code === 1008 && /auth|required|unauthorized|revoked/i.test(event.reason)) {
          this.onFrame({ type: 'client-notice', method: 'authorization-revoked', payload: {} });
        }
        if (!this.closed && this.token) this.scheduleReconnect();
      });
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const wait = Math.min(6000, 400 * (2 ** Math.min(this.retry++, 4)));
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closed || !this.token) return;
      try { await this.openSocket(); this.onFrame({ type: 'client-notice', method: 'reconnected', payload: {} }); }
      catch { /* the socket close handler schedules the next attempt */ }
    }, wait);
  }

  request(method, payload = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('电脑未连接，请稍后重试'));
    const rpcId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rpcId); reject(new Error('请求超时，请稍后重试')); }, 30000);
      this.pending.set(rpcId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: 'client-request', rpcId, method, payload }));
    });
  }

  close() {
    this.closed = true;
    this.token = '';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, 'signed-out');
    this.socket = null;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('已退出登录')); }
    this.pending.clear();
  }
}
