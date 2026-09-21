/**
 * server/http.ts — HTTP 层
 *
 * - 静态资源：web/（PWA 手机壳）
 * - POST /api/auth/login   —— 密码 + 可选 TOTP → { token, deviceId, otpauthUri? }
 * - POST /api/auth/revoke  —— 吊销设备（携带 token）
 * - GET  /api/auth/devices —— 设备列表（携带 token）
 * - POST /api/dsh/launch-token —— PC 软件上报 DSH 进程 launch token（携带 x-dsh-agent-key）
 * - GET  /healthz
 *
 * 生产部署：本服务应置于 Caddy/Nginx TLS 之后（或自行套 TLS），仅暴露 443。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { AuthService } from '../auth/index.ts';
import type { TunnelHealth } from '../tunnel/server.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export interface HttpOptions {
  webDir: string;
  /**
   * DSH launch token 上报通道的共享密钥（config.agentKey）。
   * 为空时通道关闭（404）——避免未配置密钥的部署把 token 写入接口暴露出去。
   */
  agentKey?: string;
  /** 收到 token 后的注入动作（由 app.ts 绑定到 DSH 适配器的热更新） */
  onDshLaunchToken?: (token: string) => Promise<void>;
  /** 内置隧道状态（/healthz 暴露；未启用时不传） */
  tunnelState?: () => TunnelHealth | null;
}

export class GatewayHttpServer {
  readonly server: Server;
  private auth: AuthService;
  private opts: HttpOptions;

  constructor(auth: AuthService, opts: HttpOptions) {
    this.auth = auth;
    this.opts = opts;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;

    try {
      if (req.method === 'POST' && path === '/api/auth/login') {
        await this.login(req, res);
        return;
      }
      if (req.method === 'POST' && path === '/api/auth/revoke') {
        await this.revoke(req, res);
        return;
      }
      if (req.method === 'GET' && path === '/api/auth/devices') {
        await this.devices(req, res);
        return;
      }
      if (path === '/api/dsh/launch-token') {
        await this.dshLaunchToken(req, res);
        return;
      }
      if (req.method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        // 键序不可乱：version 必须是 JSON 里第一个 "version" 字面量
        // （deploy.sh 的 first_field 取首个字面量做部署版本校验；tunnel 块内不得出现 "version" 键）
        res.end(JSON.stringify({ ok: true, version: gatewayVersion(), tunnel: this.opts.tunnelState?.() ?? null }));
        return;
      }
      if (path === '/tunnel') {
        // WebSocket 升级端点：普通 GET 若落进 static 会命中 SPA 兜底返回 200 index.html，排障时误导
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('upgrade required');
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        this.static(path, res);
        return;
      }
      res.writeHead(404).end('not found');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  // ── 登录 / 设备 ─────────────────────────────────────────────────────

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const { username, password, totp, deviceName } = body as {
      username?: string; password?: string; totp?: string; deviceName?: string;
    };
    if (!username || !password) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'username/password required' }));
      return;
    }
    const ip = req.socket.remoteAddress ?? '';
    const result = await this.auth.login(username, password, totp, deviceName ?? 'phone', ip);
    res.writeHead(result.ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const token = (body as { token?: string }).token ?? '';
    const info = token ? this.auth.validateToken(token) : null;
    if (!info) {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const deviceId = (body as { deviceId?: string }).deviceId ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: this.auth.revokeDevice(deviceId) }));
  }

  private async devices(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
    const info = token ? this.auth.validateToken(token) : null;
    if (!info) {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: this.auth.listDevices() }));
  }

  // ── DSH launch token 上报（PC 软件 → 网关）───────────────────────────
  /**
   * DSH 0.1.2+ 的 /api 需要浏览器会话 cookie，而换 cookie 的 launch token
   * 由 DSH 进程启动时随机生成、不落盘。网关必须由 PC 端在上报后热更新，
   * 因此这条通道是整条链路可用性的前提。
   *
   * 鉴权：共享密钥（x-dsh-agent-key，内容为 frp token，PC 与服务器都持有）。
   */
  private async dshLaunchToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const expected = this.opts.agentKey ?? '';
    if (!expected || !this.opts.onDshLaunchToken) {
      json(404, { ok: false, error: 'launch-token channel disabled' });
      return;
    }
    if (req.method !== 'POST') {
      json(405, { ok: false, error: 'use POST' });
      return;
    }
    const key = String(req.headers['x-dsh-agent-key'] ?? '');
    // 定长比较，避免时序侧信道（密钥长度相同才逐字节比较）
    if (key.length !== expected.length || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      json(401, { ok: false, error: 'unauthorized' });
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      json(400, { ok: false, error: 'body is not JSON' });
      return;
    }
    const token = (body as { token?: unknown }).token;
    if (typeof token !== 'string' || token.length === 0) {
      json(400, { ok: false, error: 'token required' });
      return;
    }
    try {
      await this.opts.onDshLaunchToken(token);
      json(200, { ok: true, applied: true });
    } catch (e) {
      json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── 静态文件 ────────────────────────────────────────────────────────

  private static(pathname: string, res: ServerResponse): void {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = normalize(join(this.opts.webDir, rel));
    if (!file.startsWith(normalize(this.opts.webDir))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      // SPA 兜底：无匹配时回 index.html
      const fallback = join(this.opts.webDir, 'index.html');
      if (existsSync(fallback)) {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(readFileSync(fallback));
        return;
      }
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 读 package.json 的 version（healthz 返回，便于确认部署版本） */
function gatewayVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
