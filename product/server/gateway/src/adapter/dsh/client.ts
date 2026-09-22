/**
 * adapter/dsh/client.ts — DSH Typert Remote HTTP 客户端
 *
 * 上行：POST {base}/api/<ns>/<method>（body = {type:'client-request',rpcId,method,payload:{args}}）
 *      → {type:'server-response',rpcId,result:{ok,value}|{ok,error}}
 * 应答：POST {base}/api/$events/result（args = {clientId,eventId,outcome}）
 *
 * 注意（DSH 0.1.2+ 回归点）：
 *   - 端点是 `/api/<ns>/<method>`（`/` 分隔），不是 0.1.1 的 `/api/<ns>.<method>`；
 *   - payload 必须是 `{ args: {...} }`，HTTP 层会拒绝其它形状
 *     （"Remote payload must contain exactly one plain-object args field"）；
 *   - args 的键名 = 生成描述符的 wire 名（绝大多数是 `request`，session/list 是 `_request`）。
 *
 * 信任栅栏：请求的 Host 须为 loopback 权威或匹配 DSH 侧 trustedHosts。
 *   隧道回环（127.0.0.1:3080）→ 默认满足 loopback；
 *   直连远程 DSH → 需在 DSH 侧 --trusted-host 声明网关地址。
 *
 * 认证（BrowserAuth）：`/api` 与 `/api/remote.mux` 均强制浏览器会话 cookie。
 * 本客户端按官方流程模拟：用 DSH 启动时打印的 launch token 经 GET /?token= 换 cookie，
 * 之后所有请求（含 WebSocket 升级）带该 cookie。cookie 绑定 Host authority，
 * 因此换 cookie 与后续请求必须使用同一个 authority（同为 baseUrl 的 host）。
 */

import type {
  DshClientRequest, DshRemoteArgs, DshRemoteEventResultArgs, DshRpcError, DshRpcResult, DshServerResponse,
} from './types.ts';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface DshApiClientOptions {
  /** DSH Host 基址，如 http://127.0.0.1:3080 */
  baseUrl: string;
  /** 请求超时（ms），默认 60s */
  timeoutMs?: number;
  /** DSH 进程的 launch token（启动时打印；提供则自动模拟 cookie 认证） */
  authToken?: string;
  authority?: string;
}

export class DshApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authToken?: string;
  private readonly authority?: string;
  private cookie: string | null = null;

  constructor(opts: DshApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.authToken = opts.authToken;
    this.authority = opts.authority;
  }

  /** 当前 baseUrl（供 WebSocket 下行流复用同一 authority） */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * 确保已认证：用 DSH launch token 经 GET /?token= 交换 Cookie（每次进程、每次 baseUrl 一次）。
   * Cookie 绑定请求的 Host authority，须与后续 /api 请求的 Host 一致（同为 baseUrl 的 host）。
   */
  async ensureAuthenticated(): Promise<void> {
    if (!this.authToken) return;      // 未提供 token：按无认证直连（仅 0.1.1 或已放行的部署）
    if (this.cookie) return;          // 已换到 cookie，复用
    const res = await this.fetch(`${this.baseUrl}/?token=${encodeURIComponent(this.authToken)}`, {
      method: 'GET',
      headers: this.authority ? { host: this.authority } : undefined,
      redirect: 'manual',             // DSH 返回 303 + Set-Cookie；需读 header
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // DSH 成功时 303（换 cookie 重定向）；携带 Set-Cookie。部分实现可能直接 200。
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];   // 取 "name=value" 主体
      return;
    }
    // 若未返回 Set-Cookie（可能已认证/其它状态），不阻塞；让后续请求自行暴露认证问题。
    this.cookie = '';
  }

  /** 当前认证 cookie（供 WebSocket 下行流复用；未认证则为 null） */
  getCookie(): string | null {
    return this.cookie;
  }

  /** 丢弃已换到的 cookie（DSH 重启后 token 变化，需重新交换） */
  resetAuth(): void {
    this.cookie = null;
  }

  /**
   * 调用一个 unary 方法：POST /api/<method>，args = 描述符 wire 名的参数对象。
   * 业务失败不 throw，返回 result 分支。
   */
  async call<T = unknown>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<DshRpcResult<T>> {
    return this.post<T>(`/api/${method}`, method, { args }, signal);
  }

  /** 应答一条 $events waterfall（审批/提问）：POST /api/$events/result */
  async respondEvent(args: DshRemoteEventResultArgs): Promise<DshRpcResult<unknown>> {
    return this.post('/api/$events/result', '$events/result', { args } satisfies DshRemoteArgs<DshRemoteEventResultArgs>, undefined);
  }

  private async post<T>(path: string, method: string, payload: unknown, signal?: AbortSignal): Promise<DshRpcResult<T>> {
    await this.ensureAuthenticated();
    const req: DshClientRequest = {
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload,
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.authority) headers.host = this.authority;
    if (this.cookie) headers.cookie = this.cookie;

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch (e) {
      return fail('transport-error', `DSH 请求失败：${e instanceof Error ? e.message : String(e)}`);
    }

    if (!res.ok) {
      // 401 = 未认证/launch token 过期；403 = Host 未被 DSH 信任；404 = 端点不存在（协议版本不符）
      const hint = res.status === 401
        ? '（DSH 需 launch token 认证：请确认 PC 端已上报 token）'
        : res.status === 403
          ? '（Host 未被 DSH 信任：需 --trusted-host 声明网关访问的 authority）'
          : res.status === 404
            ? '（端点不存在：DSH 版本与适配器协议不符）'
            : '';
      if (res.status === 401) this.cookie = null;   // 下次调用重新交换
      return fail('dsh-http-error', `DSH ${path} 返回 HTTP ${res.status}${hint}`);
    }

    let body: DshServerResponse<T>;
    try {
      body = (await res.json()) as DshServerResponse<T>;
    } catch (e) {
      return fail('transport-error', `DSH 响应不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!body || typeof body !== 'object' || !('result' in body)) {
      return fail('transport-error', 'DSH 响应缺少 result 字段');
    }
    return body.result;
  }

  /** Node fetch rewrites Host; tunnel requests must preserve the PC cookie authority. */
  private async fetch(url: string, init: RequestInit): Promise<Response> {
    if (!this.authority) return fetch(url, init);
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      headers.host = this.authority!;
      const request = url.startsWith('https:') ? httpsRequest : httpRequest;
      const req = request(url, { method: init.method, headers, signal: init.signal ?? undefined }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(new Error('DSH response too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          const out = new Headers();
          for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) out.set(name, Array.isArray(value) ? value.join(', ') : value);
          const status = res.statusCode ?? 502;
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: out }));
        });
      });
      req.on('error', reject);
      req.end(typeof init.body === 'string' ? init.body : undefined);
    });
  }
}

function fail<T>(code: string, message: string): DshRpcResult<T> {
  const error: DshRpcError = { code, message, details: {} };
  return { ok: false, error };
}
