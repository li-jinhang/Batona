/**
 * session/router.ts — 会话路由
 *
 * gatewaySessionId ↔ {backend, backendSessionId, state} 映射；
 * 订阅各适配器 onEvent，把后端事件按会话归属扇出给网关（server 层再推给手机）。
 * 多设备并发（FR-18）：事件扇出给所有已连接客户端，状态以 DSH 侧为准。
 */

import type {
  AgentAdapter, AgentEvent, AgentSessionRef, CreateSessionOpts, ModelRef, PromptPart, SessionState, WorkspaceTree, WorkspaceView,
} from '../adapter/contract.ts';
import type { AdapterRegistry } from '../adapter/registry.ts';
import { RpcId } from '../proto/envelope.ts';

export interface GatewaySession {
  id: string;               // gatewaySessionId（手机可见）
  backend: string;          // 适配器 id
  backendSessionId: string; // 后端原生会话 id
  title?: string;
  state: SessionState;
  createdAt: number;
}

export type SessionEventSink = (gatewaySessionId: string, event: AgentEvent) => void;

export class SessionRouter {
  private sessions = new Map<string, GatewaySession>();
  private byBackend = new Map<string, string>(); // `${backend}:${backendSessionId}` → gatewaySessionId
  private sinks = new Set<SessionEventSink>();
  private adapters: AdapterRegistry;

  constructor(adapters: AdapterRegistry) {
    this.adapters = adapters;
    for (const a of adapters.list()) {
      a.onEvent((backendSessionId, event) => this.routeEvent(a.id, backendSessionId, event));
    }
  }

  /** 订阅会话事件扇出；返回取消订阅函数 */
  onEvent(sink: SessionEventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  private routeEvent(backend: string, backendSessionId: string, event: AgentEvent): void {
    // Codex Desktop 原生创建的会话也必须可被手机接管。首次事件到来时建立稳定网关映射，
    // 后续 resume 不再生成第二个 gatewaySessionId。
    const key = `${backend}:${backendSessionId}`;
    const gid = this.byBackend.get(key) ?? this.adopt(this.adapters.require(backend), {
      backend, backendSessionId, state: 'idle', createdAt: Date.now(),
    }).id;
    const g = this.sessions.get(gid);
    if (g) {
      const next = stateFromEvent(event);
      if (next) g.state = next;
    }
    for (const s of this.sinks) s(gid, event);
  }

  // ── 会话生命周期 ────────────────────────────────────────────────────

  async create(backendId: string, opts: CreateSessionOpts): Promise<GatewaySession> {
    const adapter = this.adapters.require(backendId);
    const ref = await adapter.createSession(opts);
    return this.adopt(adapter, ref);
  }

  async resume(backendId: string, backendSessionId: string): Promise<GatewaySession> {
    const adapter = this.adapters.require(backendId);
    const ref = await adapter.resumeSession(backendSessionId);
    return this.adopt(adapter, ref);
  }

  private adopt(adapter: AgentAdapter, ref: AgentSessionRef): GatewaySession {
    const key = `${adapter.id}:${ref.backendSessionId}`;
    const existingId = this.byBackend.get(key);
    if (existingId) {
      const existing = this.sessions.get(existingId)!;
      existing.title = ref.title ?? existing.title;
      existing.state = ref.state;
      return existing;
    }
    const gs: GatewaySession = {
      id: RpcId(crypto.randomUUID()),
      backend: adapter.id,
      backendSessionId: ref.backendSessionId,
      title: ref.title,
      state: ref.state,
      createdAt: ref.createdAt,
    };
    this.sessions.set(gs.id, gs);
    this.byBackend.set(key, gs.id);
    return gs;
  }

  get(gatewaySessionId: string): GatewaySession | undefined {
    return this.sessions.get(gatewaySessionId);
  }

  private requireSession(gatewaySessionId: string): GatewaySession {
    const g = this.sessions.get(gatewaySessionId);
    if (!g) throw Object.assign(new Error('session not found'), { code: 'session-not-found' });
    return g;
  }

  /** 从适配器重新发现持久会话（含 Codex Desktop 已有会话），再返回统一映射。 */
  async list(): Promise<GatewaySession[]> {
    await Promise.all(this.adapters.list().map(async (adapter) => {
      const refs = await adapter.listSessions();
      for (const ref of refs) this.adopt(adapter, ref);
    }));
    return [...this.sessions.values()];
  }

  // ── 操作转发 ────────────────────────────────────────────────────────

  async prompt(gatewaySessionId: string, parts: PromptPart[], opts?: { queueAction?: 'prompt' | 'steer' | 'queue'; agentPreset?: string }): Promise<void> {
    const g = this.requireSession(gatewaySessionId);
    await this.adapters.require(g.backend).prompt(refOf(g), parts, opts);
  }

  async respond(gatewaySessionId: string, serverRequestRpcId: string, payload: unknown): Promise<void> {
    const g = this.requireSession(gatewaySessionId);
    await this.adapters.require(g.backend).respond(refOf(g), serverRequestRpcId, payload);
  }

  async cancel(gatewaySessionId: string, itemId?: string): Promise<void> {
    const g = this.requireSession(gatewaySessionId);
    await this.adapters.require(g.backend).cancel(refOf(g), itemId);
  }

  async history(gatewaySessionId: string, opts?: { beforeSeq?: number; limit?: number }): Promise<AgentEvent[]> {
    const g = this.requireSession(gatewaySessionId);
    const adapter = this.adapters.require(g.backend);
    if (!adapter.history) throw Object.assign(new Error('backend has no history'), { code: 'not-implemented' });
    return adapter.history(refOf(g), opts);
  }

  // ── 能力方法（按适配器能力路由）──────────────────────────────────────

  private adapterFor(backendId: string | undefined, capability: keyof NonNullable<AgentAdapter['capabilities']>): AgentAdapter {
    const adapter = backendId ? this.adapters.get(backendId) : this.adapters.default();
    if (!adapter) throw Object.assign(new Error('adapter not found'), { code: 'adapter-not-found' });
    if (!adapter.capabilities[capability]) {
      throw Object.assign(new Error(`backend ${adapter.id} lacks capability: ${String(capability)}`), { code: 'capability-missing' });
    }
    return adapter;
  }

  async listWorkspaces(backendId?: string): Promise<WorkspaceView[]> {
    const a = this.adapterFor(backendId, 'workspace');
    if (!a.listWorkspaces) throw Object.assign(new Error('not implemented'), { code: 'not-implemented' });
    return a.listWorkspaces();
  }

  async createWorkspace(path: string, backendId?: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    const a = this.adapterFor(backendId, 'workspace');
    if (!a.createWorkspace) throw Object.assign(new Error('not implemented'), { code: 'not-implemented' });
    return a.createWorkspace(path);
  }

  async deleteWorkspace(workspaceId: string, backendId?: string): Promise<void> {
    const a = this.adapterFor(backendId, 'workspace');
    if (!a.deleteWorkspace) throw Object.assign(new Error('not implemented'), { code: 'not-implemented' });
    await a.deleteWorkspace(workspaceId);
  }

  async archiveSession(sessionId: string, backendId?: string): Promise<void> {
    const a = this.adapterFor(backendId, 'workspace');
    if (!a.archiveSession) throw Object.assign(new Error('not implemented'), { code: 'not-implemented' });
    await a.archiveSession(sessionId);
  }

  /** 工作区树：优先用适配器聚合；缺省用 listWorkspaces + listSessions 组装 */
  async workspaceTree(backendId?: string): Promise<WorkspaceTree> {
    const a = this.adapterFor(backendId, 'workspace');
    if (a.workspaceTree) return a.workspaceTree();
    if (!a.listWorkspaces) throw Object.assign(new Error('not implemented'), { code: 'not-implemented' });
    const [wslist, seslist] = await Promise.all([a.listWorkspaces(), a.listSessions()]);
    const byId = new Map(seslist.map((s) => [s.backendSessionId, s]));
    const items = wslist.map((w) => ({
      workspace: { workspaceId: w.workspaceId, path: w.path, title: w.title, createdAt: w.createdAt },
      sessions: w.sessionIds.map((id) => {
        const s = byId.get(id);
        return s
          ? { sessionId: id, title: s.title, state: s.state, updatedAt: s.createdAt }
          : { sessionId: id, title: undefined, state: 'idle' as const, updatedAt: 0 };
      }),
    }));
    return { items };
  }

  async listModels(backendId?: string): Promise<ModelRef[]> {
    const a = this.adapterFor(backendId, 'models');
    if (!a.listModels) throw Object.assign(new Error('not implemented'), { code: 'not-implemented' });
    return a.listModels();
  }

  async listPermissionProfiles(backendId?: string): Promise<import('../adapter/contract.ts').AgentProfile[]> {
    const a = this.adapterFor(backendId, 'permissionProfiles');
    if (!a.listPermissionProfiles) throw Object.assign(new Error('not implemented'), { code: 'not-implemented' });
    return a.listPermissionProfiles();
  }

  async selectModel(gatewaySessionId: string, model: ModelRef): Promise<void> {
    const g = this.requireSession(gatewaySessionId);
    const a = this.adapters.require(g.backend);
    if (!a.selectModel) throw Object.assign(new Error('not implemented'), { code: 'not-implemented' });
    await a.selectModel(refOf(g), model);
  }

  async rename(backendSessionId: string, title: string, backendId?: string): Promise<{ title: string }> {
    // 会话可能来自工作区树（DSH 原生 backendSessionId），未必经 adopt 注册进网关 sessions。
    // 因此用 adapter 直接按 backendSessionId 调 rename，而不是 requireSession(gatewaySessionId)。
    const backend = backendId ?? this.adapters.default()?.id;
    if (!backend) throw Object.assign(new Error('no backend configured'), { code: 'adapter-not-found' });
    const a = this.adapters.require(backend);
    if (!a.renameSession) throw Object.assign(new Error('backend has no rename'), { code: 'not-implemented' });
    return a.renameSession(refOfBackend(a.id, backendSessionId), title);
  }
}

function refOf(g: GatewaySession): AgentSessionRef {
  return {
    backend: g.backend,
    backendSessionId: g.backendSessionId,
    title: g.title,
    state: g.state,
    createdAt: g.createdAt,
  };
}

/** 仅凭 backendSessionId 构造 ref（用于工作区树中外显的 DSH 原生会话，未 adopt 到网关 sessions） */
function refOfBackend(backendId: string, backendSessionId: string): AgentSessionRef {
  return { backend: backendId, backendSessionId, state: 'idle', createdAt: Date.now() };
}

function stateFromEvent(event: AgentEvent): SessionState | undefined {
  switch (event.type) {
    case 'approval/requested': return 'waiting-approval';
    case 'question/requested': return 'waiting-question';
    case 'turn/start': return 'running';
    case 'turn/end': return 'done';
    case 'error': return 'error';
    default: return undefined;
  }
}
