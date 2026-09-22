/**
 * CodexBridgeClient — 网关到 PC 回环桥的窄客户端。
 *
 * baseUrl 实际指向服务器 127.0.0.1:3082；内置隧道或 frp 将该 TCP 流透明送回
 * PC 的 127.0.0.1:3082。这里不保存 Codex 凭据、不直连用户电脑公网地址。
 */

import { WebSocket } from 'ws';

export interface BridgeThread {
  id: string;
  title?: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  state?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface BridgeEvent {
  type: 'agent-event';
  threadId: string;
  event: unknown;
}

export interface BridgeStatus {
  type: 'thread-status';
  thread: BridgeThread;
}

export type CodexBridgeMessage = BridgeEvent | BridgeStatus | { type: 'bridge-status'; available: boolean };

export class CodexBridgeClient {
  private readonly baseUrl: string;
  private ws: WebSocket | null = null;
  private listeners = new Set<(message: CodexBridgeMessage) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async connect(): Promise<boolean> {
    // PC 是可随时休眠、断网或尚未启动 Batona 的本地 Agent Host。网关启动时
    // 不能因为它暂时离线而退出；事件 WS 会在连接可用后自行重连，具体操作则
    // 返回 codex-offline 供手机明确展示，而不是把服务端伪装成健康的 Codex 会话。
    this.stopped = false;
    this.openEvents();
    return true;
  }

  onEvent(listener: (message: CodexBridgeMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async get<T>(pathname: string): Promise<T> {
    const res = await this.request(`${this.baseUrl}${pathname}`, { signal: AbortSignal.timeout(8_000) });
    const body = await readBody(res);
    if (!res.ok) throw bridgeError(body);
    return body as T;
  }

  async post<T>(pathname: string, value: unknown = {}): Promise<T> {
    const res = await this.request(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await readBody(res);
    if (!res.ok) throw bridgeError(body);
    return body as T;
  }

  async delete<T>(pathname: string): Promise<T> {
    const res = await this.request(`${this.baseUrl}${pathname}`, { method: 'DELETE', signal: AbortSignal.timeout(8_000) });
    const body = await readBody(res);
    if (!res.ok) throw bridgeError(body);
    return body as T;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
  }

  private openEvents(): void {
    if (this.stopped || this.ws) return;
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/v1/events';
    const ws = new WebSocket(url.toString());
    this.ws = ws;
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(String(data)) as CodexBridgeMessage;
        if (message && typeof message === 'object' && typeof (message as { type?: unknown }).type === 'string') {
          for (const listener of this.listeners) listener(message);
        }
      } catch { /* PC bridge drops malformed events; never crash the gateway */ }
    });
    const reconnect = (): void => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openEvents();
      }, 2_000);
      this.reconnectTimer.unref?.();
    };
    ws.on('close', reconnect);
    ws.on('error', () => {});
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch {
      throw Object.assign(new Error('Codex PC 当前不在线'), { code: 'codex-offline' });
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  try { return await res.json() as unknown; } catch { return {}; }
}

function bridgeError(body: unknown): Error {
  const value = body as { error?: { code?: string; message?: string } };
  return Object.assign(new Error(value?.error?.message ?? 'Codex PC bridge request failed'), {
    code: value?.error?.code ?? 'codex-bridge-error',
  });
}
