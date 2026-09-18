/**
 * adapter/mock/adapter.ts — Mock 后端适配器
 *
 * 用途：
 *   1) 冒烟测试（无真实 DSH 时端到端验证网关全链路）；
 *   2) FR-52 扩展性演示（新增后端 = 新增适配器，网关核心零改动）。
 *
 * 行为（事件驱动）：prompt() 触发"回合剧本"——
 *   assistant/chunk 流 → tool/call → approval/requested（等待应答）→
 *   respond() 继续 → tool/result → assistant/message → done；
 *   消息含 "[ask]" 前缀时改为触发 question/requested，respond() 继续。
 */

import type {
  AgentAdapter, AgentEvent, AgentSessionRef, AdapterCapabilities, AdapterConfig,
  CreateSessionOpts, ModelRef, PromptPart, WorkspaceTree, WorkspaceView,
} from '../contract.ts';

interface MockSession {
  ref: AgentSessionRef;
  log: AgentEvent[];
  pending: 'none' | 'approval' | 'question';
  pendingId: string;
}

export class MockAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly capabilities: AdapterCapabilities = {
    text: true,
    images: true,
    approvals: true,
    questions: true,
    resume: true,
    workspace: true,
    models: true,
    concurrency: 'single',
    voice: 'forward',
  };

  private sessions = new Map<string, MockSession>();
  private workspaces: WorkspaceView[] = [];
  private models: ModelRef[] = [
    { provider: 'mock', model: 'mock-chat', displayName: 'Mock Chat' },
    { provider: 'mock', model: 'mock-reasoner', displayName: 'Mock Reasoner', reasoningEffort: 'high' },
  ];
  private seq = 0;
  private listeners = new Set<(backendSessionId: string, event: AgentEvent) => void>();

  async connect(_cfg: AdapterConfig): Promise<boolean> {
    return true;
  }

  onEvent(listener: (backendSessionId: string, event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(sid: string, event: AgentEvent): void {
    const s = this.sessions.get(sid);
    if (s) s.log.push(event);
    for (const l of this.listeners) l(sid, event);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  private sid(): string {
    return `mock-${++this.seq}`;
  }

  async listSessions(): Promise<AgentSessionRef[]> {
    return [...this.sessions.values()].map((s) => ({ ...s.ref }));
  }

  async createSession(opts: CreateSessionOpts): Promise<AgentSessionRef> {
    const ref: AgentSessionRef = {
      backend: this.id,
      backendSessionId: this.sid(),
      title: opts.title ?? `Mock 会话 ${this.seq}`,
      state: 'idle',
      createdAt: Date.now(),
    };
    this.sessions.set(ref.backendSessionId, { ref, log: [], pending: 'none', pendingId: '' });
    this.emit(ref.backendSessionId, { type: 'session/title', title: ref.title! });
    return ref;
  }

  async resumeSession(backendSessionId: string): Promise<AgentSessionRef> {
    const s = this.sessions.get(backendSessionId);
    if (!s) throw Object.assign(new Error('session not found'), { code: 'session-not-found' });
    return { ...s.ref };
  }

  /** 触发回合剧本（事件经 onEvent 推送） */
  async prompt(session: AgentSessionRef, parts: PromptPart[], _opts?: unknown): Promise<void> {
    const s = this.sessions.get(session.backendSessionId);
    if (!s) throw Object.assign(new Error('session not found'), { code: 'session-not-found' });

    const text = parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text).join('\n');

    s.ref.state = 'running';
    this.emit(s.ref.backendSessionId, { type: 'user/message', text });
    this.emit(s.ref.backendSessionId, { type: 'turn/start' });

    // 提问剧本
    if (text.includes('[ask]')) {
      const qRpcId = `q-${this.sid()}`;
      s.pending = 'question';
      s.pendingId = qRpcId;
      s.ref.state = 'waiting-question';
      this.emit(s.ref.backendSessionId, {
        type: 'question/requested',
        questionRpcId: qRpcId,
        questions: [
          { id: 'q1', kind: 'select', prompt: '请选择完成方式：', options: [{ id: 'a', label: '快速' }, { id: 'b', label: '详细' }] },
        ],
        rpcId: qRpcId,
      });
      return;
    }

    // 普通剧本：思考流 → 工具调用审批
    for (const word of ['正在', '分析', '任务', '…']) {
      await this.sleep(10);
      this.emit(s.ref.backendSessionId, { type: 'assistant/chunk', text: word });
    }

    const approvalId = `ap-${this.sid()}`;
    const callId = `call-${this.sid()}`;
    s.pending = 'approval';
    s.pendingId = approvalId;
    s.ref.state = 'waiting-approval';
    this.emit(s.ref.backendSessionId, { type: 'tool/call', toolName: 'mock.write', callId, args: { path: '/tmp/mock.txt' } });
    this.emit(s.ref.backendSessionId, {
      type: 'approval/requested',
      approvalId,
      toolName: 'mock.write',
      callId,
      reason: 'Mock：需要写文件 /tmp/mock.txt',
      rpcId: approvalId,
    });
  }

  /** 应答：审批或提问 → 继续剧本 */
  async respond(session: AgentSessionRef, serverRequestRpcId: string, payload: unknown): Promise<void> {
    const s = this.sessions.get(session.backendSessionId);
    if (!s) return;

    const p = payload as { outcome?: string; answer?: unknown };
    if (s.pending === 'approval' && s.pendingId === serverRequestRpcId) {
      const allowed = p.outcome === 'allowed-once';
      s.pending = 'none';
      s.ref.state = 'running';
      this.emit(s.ref.backendSessionId, {
        type: 'approval/resolved',
        approvalId: serverRequestRpcId,
        outcome: allowed ? 'allowed-once' : 'rejected',
      });
      if (allowed) {
        await this.sleep(10);
        this.emit(s.ref.backendSessionId, { type: 'tool/result', toolName: 'mock.write', ok: true, summary: '文件已写入' });
        for (const word of ['任务', '完成', '！']) {
          await this.sleep(10);
          this.emit(s.ref.backendSessionId, { type: 'assistant/chunk', text: word });
        }
        this.emit(s.ref.backendSessionId, { type: 'assistant/message', text: '任务完成！' });
      } else {
        this.emit(s.ref.backendSessionId, { type: 'assistant/message', text: '已拒绝该工具调用。' });
      }
      this.finish(s);
      return;
    }

    if (s.pending === 'question' && s.pendingId === serverRequestRpcId) {
      s.pending = 'none';
      s.ref.state = 'running';
      this.emit(s.ref.backendSessionId, { type: 'question/resolved', questionRpcId: serverRequestRpcId, outcome: 'answered' });
      await this.sleep(10);
      this.emit(s.ref.backendSessionId, { type: 'assistant/message', text: `已收到你的选择（${JSON.stringify(p.answer)}），开始执行…` });
      this.finish(s);
      return;
    }

    throw Object.assign(new Error('no pending interaction'), { code: 'bad-request' });
  }

  private finish(s: MockSession): void {
    s.ref.state = 'done';
    this.emit(s.ref.backendSessionId, { type: 'turn/end' });
    this.emit(s.ref.backendSessionId, { type: 'done' });
  }

  async cancel(session: AgentSessionRef, _itemId?: string): Promise<void> {
    const s = this.sessions.get(session.backendSessionId);
    if (s && s.ref.state === 'running') {
      s.pending = 'none';
      this.finish(s);
    }
  }

  async history(session: AgentSessionRef, _opts?: { beforeSeq?: number; limit?: number }): Promise<AgentEvent[]> {
    const s = this.sessions.get(session.backendSessionId);
    if (!s) throw Object.assign(new Error('session not found'), { code: 'session-not-found' });
    return [...s.log];
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    return [...this.workspaces];
  }

  async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    const existing = this.workspaces.find((w) => w.path === path);
    if (existing) return { workspace: existing, created: false };
    const w: WorkspaceView = {
      workspaceId: `ws-${++this.seq}`,
      path,
      title: path.split(/[\\/]/).pop() || path,
      sessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.push(w);
    return { workspace: w, created: true };
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    this.workspaces = this.workspaces.filter((w) => w.workspaceId !== workspaceId);
  }

  async archiveSession(_sessionId: string): Promise<void> {
    // mock：归档为 no-op（真实实现挂到 workspace.archiveSession）
  }

  async workspaceTree(): Promise<WorkspaceTree> {
    return {
      items: this.workspaces.map((w) => ({
        workspace: { workspaceId: w.workspaceId, path: w.path, title: w.title, createdAt: w.createdAt },
        sessions: [],
      })),
    };
  }

  async listModels(): Promise<ModelRef[]> {
    return [...this.models];
  }

  async selectModel(session: AgentSessionRef, model: ModelRef): Promise<void> {
    const s = this.sessions.get(session.backendSessionId);
    if (s) s.ref.title = `${s.ref.title} [${model.model}]`;
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    this.sessions.clear();
  }
}

/** 工厂（供 AdapterRegistry.assemble 使用） */
export function createMockAdapter(_cfg: AdapterConfig): AgentAdapter {
  return new MockAdapter();
}
