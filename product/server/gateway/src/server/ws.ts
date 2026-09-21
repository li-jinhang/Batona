/**
 * server/ws.ts — 网关 WebSocket 服务器（前端协议 v1）
 *
 * - 连接：URL ?token= 携带登录令牌（或首帧 auth.hello 提交）；未认证只能调 auth.hello
 * - 上行：client-request 方法分发（session.* / workspace.* / model.* / respond / device.*）
 * - 下行：server-request 推送（session/event、approval/requested、question/requested…）
 * - 审批/提问：推送帧携带网关侧稳定 rpcId，客户端应答经 respond 方法回传，映射回适配器 rpcId
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AuthService } from '../auth/index.ts';
import type { AdapterRegistry } from '../adapter/registry.ts';
import type { SessionRouter } from '../session/router.ts';
import {
  PROTO_VERSION, RpcId, type ClientRequest, type RpcMessage, type ServerRequest,
} from '../proto/envelope.ts';
import { err, foldError, ok, type RpcResult } from '../proto/result.ts';
import type { AgentEvent, AskUserQuestionItem } from '../adapter/contract.ts';

interface PendingAnswer {
  gatewaySessionId: string;
  adapterRpcId: string;
}

export class GatewayWsServer {
  private wss!: WebSocketServer;
  private pending = new Map<string, PendingAnswer>(); // 网关侧 rpcId → 适配器应答信息
  private auth: AuthService;
  private registry: AdapterRegistry;
  private router: SessionRouter;

  constructor(auth: AuthService, registry: AdapterRegistry, router: SessionRouter) {
    this.auth = auth;
    this.registry = registry;
    this.router = router;
  }

  /**
   * 创建 WSS（**noServer 模式**）。
   *
   * 不能再用 `new WebSocketServer({ server, path })`：ws 库在 path 不匹配时会
   * `abortHandshake(socket, 400)` 并销毁 socket，同一 http server 上并存两个这样的
   * 实例会让后注册的端点被先注册的 400 掉（表现为"随机某个端点连不上"）。
   * 所有 upgrade 统一由 src/server/upgrade.ts 路由后调用 handleUpgrade。
   *
   * @param _server 仅为兼容既有调用点保留，不再使用
   */
  attach(_server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws, req) => {
      const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
      const authInfo = token ? this.auth.validateToken(token) : null;
      const state = { authed: authInfo !== null, deviceId: authInfo?.deviceId ?? '' };

      ws.on('message', (data) => {
        void this.onMessage(ws, state, data);
      });

      ws.on('close', () => {
        // 骨架：会话与设备状态保留，仅断开推送
      });
    });

    // 事件扇出：所有已认证连接（单人场景；FR-18 多设备广播）
    this.router.onEvent((gatewaySessionId, event) => {
      this.broadcast(this.buildPushFrame(gatewaySessionId, event));
    });
  }

  /** upgrade 路由入口（src/server/upgrade.ts 的 /ws 处理器）。noServer 模式下必须手动 emit connection */
  handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  };

  private async onMessage(ws: WebSocket, state: { authed: boolean; deviceId: string }, data: unknown): Promise<void> {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(String(data)) as RpcMessage;
    } catch {
      this.send(ws, { type: 'server-response', rpcId: RpcId(''), result: err('bad-request', 'malformed json') });
      return;
    }
    if (msg.type !== 'client-request') return; // 只处理上行调用（push/应答为服务器内部使用）

    const { rpcId, method, payload } = msg;

    // 认证门
    if (!state.authed) {
      if (method !== 'auth.hello') {
        this.send(ws, { type: 'server-response', rpcId, result: err('auth-required', 'please auth.hello first') });
        return;
      }
      const t = (payload as { token?: string }).token ?? '';
      const info = t ? this.auth.validateToken(t) : null;
      if (!info) {
        this.send(ws, { type: 'server-response', rpcId, result: err('unauthorized', 'invalid token') });
        return;
      }
      state.authed = true;
      state.deviceId = info.deviceId;
    }

    const result = await this.dispatch(method, payload);
    this.send(ws, { type: 'server-response', rpcId, result });
  }

  private async dispatch(method: string, payload: unknown): Promise<RpcResult<unknown>> {
    try {
      switch (method) {
        case 'auth.hello': return ok(this.hello());
        case 'session.list': return ok({ sessions: this.router.list() });
        case 'session.create': {
          const p = payload as { backend?: string; title?: string; agentPreset?: string; workspacePath?: string; workspaceId?: string; model?: unknown };
          const backend = p.backend ?? this.registry.default()?.id;
          if (!backend) return err('adapter-not-found', 'no backend configured');
          const gs = await this.router.create(backend, {
            title: p.title, agentPreset: p.agentPreset, workspacePath: p.workspacePath, workspaceId: p.workspaceId,
            model: p.model as never,
          });
          return ok(gs);
        }
        case 'session.resume': {
          const p = payload as { backend?: string; backendSessionId: string };
          const backend = p.backend ?? this.registry.default()?.id;
          if (!backend) return err('adapter-not-found', 'no backend configured');
          return ok(await this.router.resume(backend, p.backendSessionId));
        }
        case 'session.prompt': {
          const p = payload as { sessionId: string; parts: unknown[]; queueAction?: 'prompt' | 'steer' | 'queue' };
          await this.router.prompt(p.sessionId, p.parts as never, { queueAction: p.queueAction });
          return ok({ accepted: true });
        }
        case 'session.cancel': {
          const p = payload as { sessionId: string; itemId?: string };
          await this.router.cancel(p.sessionId, p.itemId);
          return ok({ accepted: true });
        }
        case 'session.history': {
          const p = payload as { sessionId: string; beforeSeq?: number; limit?: number };
          const events = await this.router.history(p.sessionId, { beforeSeq: p.beforeSeq, limit: p.limit });
          return ok({ events });
        }
        case 'session.rename': {
          const p = payload as { sessionId: string; title: string; backend?: string };
          return ok(await this.router.rename(p.sessionId, p.title, p.backend));
        }
        case 'fs.listDir': {
          // 目录浏览：经 frp 的 dir 代理访问 PC 本地目录服务（笔记本 127.0.0.1:3081 → 服务器 127.0.0.1:3081）
          const p = payload as { path?: string };
          const r = await fetchDirList(p?.path ?? '');
          if (!r.ok) return err('bad-request', r.error ?? '');
          return ok(r.value);
        }
        case 'respond': {
          const p = payload as { sessionId: string; serverRequestRpcId: string; payload: unknown };
          const pending = this.pending.get(p.serverRequestRpcId);
          if (!pending) return err('bad-request', 'no pending interaction for rpcId');
          await this.router.respond(p.sessionId, pending.adapterRpcId, p.payload);
          this.pending.delete(p.serverRequestRpcId);
          return ok({ accepted: true });
        }
        case 'workspace.list': {
          const p = payload as { backend?: string };
          return ok({ items: await this.router.listWorkspaces(p.backend) });
        }
        case 'workspace.create': {
          const p = payload as { path: string; backend?: string };
          return ok(await this.router.createWorkspace(p.path, p.backend));
        }
        case 'workspace.tree': {
          const p = payload as { backend?: string };
          return ok(await this.router.workspaceTree(p.backend));
        }
        case 'workspace.delete': {
          const p = payload as { workspaceId: string; backend?: string };
          await this.router.deleteWorkspace(p.workspaceId, p.backend);
          return ok({ deleted: true });
        }
        case 'workspace.archiveSession': {
          const p = payload as { sessionId: string; backend?: string };
          await this.router.archiveSession(p.sessionId, p.backend);
          return ok({ archived: true });
        }
        case 'model.list': {
          const p = payload as { backend?: string };
          return ok({ items: await this.router.listModels(p.backend) });
        }
        case 'model.select': {
          const p = payload as { sessionId: string; model: unknown };
          await this.router.selectModel(p.sessionId, p.model as never);
          return ok({ accepted: true });
        }
        case 'device.list':
          return ok({ items: this.auth.listDevices() });
        case 'device.revoke': {
          const p = payload as { deviceId: string };
          return ok({ revoked: this.auth.revokeDevice(p.deviceId) });
        }
        default:
          return err('method-not-found', `unknown method: ${method}`);
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code ? err(code as never, (e as Error).message) : foldError(e);
    }
  }

  private hello(): unknown {
    return {
      protoVersion: PROTO_VERSION,
      serverVersion: '0.1.0',
      adapters: this.registry.list().map((a) => ({ id: a.id, capabilities: a.capabilities })),
      defaultBackend: this.registry.default()?.id ?? null,
    };
  }

  /** 会话事件 → server-request 推送帧；审批/提问登记应答映射 */
  private buildPushFrame(gatewaySessionId: string, event: AgentEvent): ServerRequest {
    const rpcId = RpcId(crypto.randomUUID());
    switch (event.type) {
      case 'approval/requested': {
        this.pending.set(rpcId, { gatewaySessionId, adapterRpcId: event.rpcId ?? event.approvalId });
        return {
          type: 'server-request', rpcId, method: 'approval/requested',
          payload: { sessionId: gatewaySessionId, approvalId: event.approvalId, toolName: event.toolName, reason: event.reason },
        };
      }
      case 'question/requested': {
        this.pending.set(rpcId, { gatewaySessionId, adapterRpcId: event.rpcId ?? event.questionRpcId });
        return {
          type: 'server-request', rpcId, method: 'question/requested',
          payload: {
            sessionId: gatewaySessionId,
            questionRpcId: event.questionRpcId,
            questions: event.questions as AskUserQuestionItem[],
          },
        };
      }
      default:
        return { type: 'server-request', rpcId, method: 'session/event', payload: { sessionId: gatewaySessionId, event } };
    }
  }

  private broadcast(frame: ServerRequest): void {
    if (!this.wss) return;
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(frame));
      }
    }
  }

  private send(ws: WebSocket, msg: RpcMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

/** 目录浏览：经隧道访问 PC 本地目录服务（网关侧 127.0.0.1:3081 → 笔记本目录服务；frp 时代经 frp dir 代理，内置隧道后经 /tunnel） */
const DIR_LIST_URL = 'http://127.0.0.1:3081/list';

async function fetchDirList(p: string): Promise<{ ok: boolean; value?: { path: string; dirs?: string[]; roots?: string[] }; error?: string }> {
  try {
    const url = new URL(DIR_LIST_URL);
    url.searchParams.set('p', p);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    const j = (await res.json()) as { ok: boolean; path?: string; dirs?: string[]; roots?: string[]; error?: string };
    if (!j.ok) return { ok: false, error: j.error ?? '目录服务返回错误' };
    return { ok: true, value: { path: j.path ?? '', dirs: j.dirs, roots: j.roots } };
  } catch (e) {
    return { ok: false, error: `目录服务不可达: ${e instanceof Error ? e.message : String(e)}（请确认 PC 端 DSH Link 已启动，且隧道已连通）` };
  }
}
