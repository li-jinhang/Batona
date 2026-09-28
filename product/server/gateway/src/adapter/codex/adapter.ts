/** Codex Adapter — 将 PC 本机桥的 App Server 能力归一化为 AgentAdapter。 */

import type {
  AdapterCapabilities, AdapterConfig, AgentAdapter, AgentEvent, AgentProfile, AgentSessionRef,
  CreateSessionOpts, ModelRef, PromptPart, SessionState, WorkspaceTree, WorkspaceView,
} from '../contract.ts';
import { CodexBridgeClient, type BridgeThread, type CodexBridgeMessage } from './client.ts';

export interface CodexAdapterConfig extends AdapterConfig {
  /** 服务器侧仅回环的端口，经既有隧道映射到 PC CodexBridge。 */
  baseUrl: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly capabilities: AdapterCapabilities = {
    text: true,
    images: false,
    approvals: true,
    questions: true,
    resume: true,
    workspace: true,
    models: true,
    permissionProfiles: true,
    concurrency: 'parallel', // Codex 原生线程/回合调度；Batona 不额外排队。
    voice: 'none',
  };

  private client: CodexBridgeClient | null = null;
  private listeners = new Set<(backendSessionId: string, event: AgentEvent) => void>();
  private states = new Map<string, SessionState>();
  private titles = new Map<string, string>();
  private updated = new Map<string, number>();
  private workspacePaths = new Map<string, string>();

  async connect(cfg: AdapterConfig): Promise<boolean> {
    const baseUrl = String((cfg as CodexAdapterConfig).baseUrl ?? '');
    if (!baseUrl) throw new Error('codex adapter: missing baseUrl');
    const client = new CodexBridgeClient(baseUrl);
    const ok = await client.connect();
    if (!ok) return false;
    client.onEvent((message) => this.onBridgeMessage(message));
    this.client = client;
    return true;
  }

  onEvent(listener: (backendSessionId: string, event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listSessions(): Promise<AgentSessionRef[]> {
    const result = await this.requireClient().get<{ threads?: BridgeThread[] }>('/v1/sessions');
    return (result.threads ?? []).map((thread) => this.record(thread));
  }

  async createSession(opts: CreateSessionOpts): Promise<AgentSessionRef> {
    const cwd = opts.workspacePath ?? (opts.workspaceId ? this.workspacePaths.get(opts.workspaceId) : undefined);
    const result = await this.requireClient().post<{ thread: BridgeThread }>('/v1/sessions', {
      cwd,
      title: opts.title,
      profileId: opts.agentPreset,
      model: opts.model,
    });
    return this.record(result.thread);
  }

  async resumeSession(backendSessionId: string): Promise<AgentSessionRef> {
    const result = await this.requireClient().post<{ thread: BridgeThread }>(`/v1/sessions/${encodeURIComponent(backendSessionId)}/resume`);
    return this.record(result.thread);
  }

  async prompt(session: AgentSessionRef, parts: PromptPart[], opts?: { queueAction?: 'prompt' | 'steer' | 'queue'; agentPreset?: string }): Promise<void> {
    const text = parts.filter((part): part is Extract<PromptPart, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('');
    if (!text) throw Object.assign(new Error('Codex mobile v1 only accepts text input'), { code: 'capability-missing' });
    await this.requireClient().post(`/v1/sessions/${encodeURIComponent(session.backendSessionId)}/prompt`, { text, profileId: opts?.agentPreset });
  }

  async respond(session: AgentSessionRef, serverRequestRpcId: string, payload: unknown): Promise<void> {
    await this.requireClient().post(`/v1/sessions/${encodeURIComponent(session.backendSessionId)}/respond`, { rpcId: serverRequestRpcId, payload });
  }

  async cancel(session: AgentSessionRef): Promise<void> {
    await this.requireClient().post(`/v1/sessions/${encodeURIComponent(session.backendSessionId)}/cancel`);
  }

  async history(session: AgentSessionRef): Promise<AgentEvent[]> {
    const result = await this.requireClient().get<{ events?: AgentEvent[] }>(`/v1/sessions/${encodeURIComponent(session.backendSessionId)}/history`);
    return (result.events ?? []).filter(isAgentEvent);
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const tree = await this.workspaceTree();
    return tree.items.map((item) => ({ ...item.workspace, sessionIds: item.sessions.map((session) => session.sessionId), updatedAt: new Date().toISOString() }));
  }

  async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    const result = await this.requireClient().post<{ workspace: WorkspaceView; created: boolean }>('/v1/workspaces', { path });
    this.workspacePaths.set(result.workspace.workspaceId, result.workspace.path);
    return result;
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceView> {
    const result = await this.requireClient().post<{ workspace: WorkspaceView }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rename`, { title });
    this.workspacePaths.set(result.workspace.workspaceId, result.workspace.path);
    return result.workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.requireClient().delete(`/v1/workspaces/${encodeURIComponent(workspaceId)}`);
    this.workspacePaths.delete(workspaceId);
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.requireClient().post(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`);
  }

  async workspaceTree(): Promise<WorkspaceTree> {
    const result = await this.requireClient().get<WorkspaceTree>('/v1/workspaces');
    const items = result.items ?? [];
    for (const item of items) this.workspacePaths.set(item.workspace.workspaceId, item.workspace.path);
    return { items, ungroupedSessions: result.ungroupedSessions ?? [] };
  }

  async listModels(): Promise<ModelRef[]> {
    const result = await this.requireClient().get<{ items?: ModelRef[] }>('/v1/models');
    return result.items ?? [];
  }

  async selectModel(session: AgentSessionRef, model: ModelRef): Promise<void> {
    const result = await this.requireClient().post<{ accepted?: boolean; model?: ModelRef }>(
      `/v1/sessions/${encodeURIComponent(session.backendSessionId)}/model`, { model });
    if (result.accepted !== true || result.model?.provider !== model.provider
      || result.model.model !== model.model || result.model.reasoningEffort !== model.reasoningEffort)
      throw Object.assign(new Error('Codex 后端模型与思考强度未确认'), { code: 'native-model-unconfirmed' });
  }

  async listPermissionProfiles(): Promise<AgentProfile[]> {
    const result = await this.requireClient().get<{ items?: AgentProfile[] }>('/v1/profiles');
    return result.items ?? [];
  }

  async permissionMenu(session: AgentSessionRef, open: boolean): Promise<{ profileId?: string | null }> {
    return this.requireClient().post(`/v1/sessions/${encodeURIComponent(session.backendSessionId)}/permission-menu`, { open });
  }

  async selectPermission(session: AgentSessionRef, profileId: string, confirmed: boolean): Promise<{ profileId: string }> {
    return this.requireClient().post(`/v1/sessions/${encodeURIComponent(session.backendSessionId)}/permission`, { profileId, confirmed });
  }

  async renameSession(session: AgentSessionRef, title: string): Promise<{ title: string }> {
    return this.requireClient().post<{ title: string }>(`/v1/sessions/${encodeURIComponent(session.backendSessionId)}/name`, { name: title });
  }

  async dispose(): Promise<void> {
    this.client?.stop();
    this.client = null;
    this.listeners.clear();
    this.states.clear();
    this.titles.clear();
    this.updated.clear();
    this.workspacePaths.clear();
  }

  private onBridgeMessage(message: CodexBridgeMessage): void {
    if (message.type === 'agent-event') {
      if (!isAgentEvent(message.event)) return;
      this.updateFromEvent(message.threadId, message.event);
      this.emit(message.threadId, message.event);
      return;
    }
    if (message.type === 'thread-status') {
      const previous = this.states.get(String(message.thread.id));
      const next = this.record(message.thread);
      if (previous === next.state) return;
      if (next.state === 'running') this.emit(next.backendSessionId, { type: 'turn/start' });
      else if (next.state === 'error') this.emit(next.backendSessionId, { type: 'error', code: 'codex-thread-error', message: 'Codex 会话执行失败' });
      else if (next.state === 'done') this.emit(next.backendSessionId, { type: 'turn/end' });
    }
  }

  private record(thread: BridgeThread): AgentSessionRef {
    const id = String(thread.id);
    const state = normalizeState(thread.state);
    const title = thread.title || this.titles.get(id);
    if (title) this.titles.set(id, title);
    this.states.set(id, state);
    this.updated.set(id, Number(thread.updatedAt) || Date.now());
    const model = thread.model ? { provider: 'openai', model: thread.model, reasoningEffort: thread.reasoningEffort } : undefined;
    return { backend: this.id, backendSessionId: id, title, state, model, createdAt: Number(thread.createdAt) || Date.now() };
  }

  private updateFromEvent(id: string, event: AgentEvent): void {
    if (event.type === 'session/title') this.titles.set(id, event.title);
    const state = event.type === 'turn/start' ? 'running'
      : event.type === 'approval/requested' ? 'waiting-approval'
      : event.type === 'question/requested' ? 'waiting-question'
      : event.type === 'error' ? 'error'
      : event.type === 'turn/end' || event.type === 'done' ? 'done' : undefined;
    if (state) this.states.set(id, state);
  }

  private emit(id: string, event: AgentEvent): void {
    for (const listener of this.listeners) listener(id, event);
  }

  private requireClient(): CodexBridgeClient {
    if (!this.client) throw Object.assign(new Error('Codex PC bridge is not connected'), { code: 'not-connected' });
    return this.client;
  }
}

function normalizeState(value: string | undefined): SessionState {
  switch (value) {
    case 'running': case 'waiting-approval': case 'waiting-question': case 'error': case 'idle': return value;
    default: return 'done';
  }
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

export function createCodexAdapter(_cfg: AdapterConfig): AgentAdapter {
  return new CodexAdapter();
}
