/**
 * adapter/dsh/adapter.ts — DSH 后端适配器（Typert Remote 协议直连，零补丁）
 *
 * 协议基线：DSH 0.1.2+（本机实测 0.1.5）。0.1.1 的 `/api/<ns>.<method>` + 裸 payload
 * + `/api/events.mux` 已全部废弃，差异清单见 types.ts 顶部。
 *
 * 事件模型：
 *   - 一元调用：POST /api/<ns>/<method>（见 client.ts）
 *   - 会话事件：WS /api/remote.mux 的 `session/follow` 逻辑流（首帧 snapshot = 历史，
 *     其后逐条 event = 实时；assistant-stream 帧 = 流式增量）
 *   - 工作区：`workspace/follow` 逻辑流（基线 + 增量），替代旧的 workspace.list
 *   - 审批/提问：`$events` 逻辑流下发的 Cordis waterfall，应答走 POST /api/$events/result
 *
 * 归一化：DSH 会话事件词汇与网关 AgentEvent 基本同名，直接映射；审批/提问在 0.1.2+
 * 不再携带 approvalId/questionRpcId，用 waterfall 的 eventId 顶替（对手机端稳定且幂等）。
 */

import type {
  AgentAdapter, AgentEvent, AgentSessionRef, AdapterCapabilities, AdapterConfig, SessionPermissionPresetState,
  AskUserQuestionItem, CreateSessionOpts, ModelRef, PromptPart, SessionState, WorkspaceTree, WorkspaceView,
} from '../contract.ts';
import { DshApiClient } from './client.ts';
import { DshRemoteMux, type DshStreamHandlers } from './streams.ts';
import type {
  DshApprovalRequestPayload, DshAskUserQuestionAnswer, DshModelCatalog, DshRemoteEventFrame,
  DshAssistantStreamFrame, DshSessionCreateValue, DshSessionFollowFrame, DshSessionListValue, DshSessionPage,
  DshSessionSelectModelValue, DshSessionWireEvent, DshWorkspaceArchiveValue, DshWorkspaceCreateValue,
  DshWorkspaceFollowFrame, DshWorkspaceView,
} from './types.ts';

export interface DshAdapterConfig extends AdapterConfig {
  /** DSH Host 基址，如 http://127.0.0.1:3080（经隧道回环） */
  baseUrl: string;
  /** DSH 进程 launch token（启动时打印；由 PC 端上报，见 server/http.ts 的 /api/dsh/launch-token） */
  authToken?: string;
  /** HTTP/WS authority of the actual PC service, independent of private tunnel port. */
  authority?: string;
  waitForBaseline?: boolean;
}

interface PendingInteraction {
  kind: 'approval' | 'question';
  sessionId: string;
  questions?: AskUserQuestionItem[];   // 提问 pending：保存归一化后的问题，应答时构造 answers
}

interface Snapshot {
  records: DshSessionWireEvent[];
  hasMore: boolean;
  projections?: Record<string, unknown>;
}

const SESSION_PERMISSION_PRESETS = [
  { id: 'read-only', label: '只读', description: '只读权限，不允许修改工作区文件。' },
  { id: 'workspace-write', label: '工作区写入', description: '允许在工作区内修改；需要审批的操作仍会请求确认。' },
  { id: 'danger-full-access', label: '完全访问', description: '移除沙箱限制并跳过工具审批。' },
] as const;

/** 每个会话的流式增量连续性状态（与 DSH 官方 SessionAssistantStreamAccumulator 同规则） */
interface StreamProgress {
  revision: number;
  attempt: { attemptId: string; nextIndex: number } | null;
}

interface Waiter {
  resolve(snap: Snapshot): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Follower {
  streamId: string | null;
  cursor: number | null;
  snapshot: Snapshot | null;
  waiters: Waiter[];
  lastTouch: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/** 会话 follow 流的开窗大小（消息条数）；只用于给手机端回放最近一段，避免大会话 OOM */
const FOLLOW_MAX_MESSAGES = 100;
/** 同时保持的会话 follow 流上限（LRU 淘汰；手机端同一时刻只在一两个会话里） */
const FOLLOWER_CAP = 8;
/** history() 返回的 AgentEvent 上限（防止超大会话一次性回放） */
const HISTORY_MAX_EVENTS = 400;
export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly capabilities: AdapterCapabilities = {
    text: true,
    images: true,
    approvals: true,
    questions: true,
    resume: true,
    workspace: true,
    models: true,
    permissionProfiles: false,
    concurrency: 'queue',      // DSH 官方队列（session/prompt mode: 'queue'）
    voice: 'forward',
  };

  private cfg: DshAdapterConfig | null = null;
  private client: DshApiClient | null = null;
  private mux: DshRemoteMux | null = null;

  /** $events 逻辑流：clientId 由 ready 帧给出，应答 waterfall 时必须回传 */
  private eventStreamId: string | null = null;
  private eventClientId: string | null = null;

  private workspaceStreamId: string | null = null;
  private workspaceResolve: (() => void) | null = null;
  private workspaceBaseline: Promise<void> | null = null;
  private workspaceReady = false;
  private workspaces = new Map<string, DshWorkspaceView>();
  private workspaceOrder: string[] = [];

  private listeners = new Set<(backendSessionId: string, event: AgentEvent) => void>();
  private states = new Map<string, SessionState>();
  /** waterfall eventId → 交互信息 */
  private pending = new Map<string, PendingInteraction>();
  /** 已归档会话（由 workspace/follow 的 archived 帧维护） */
  private archivedSessions = new Set<string>();
  /** 会话标题缓存（session/title 事件与 projections 双写，投影更新可能滞后） */
  private sessionTitles = new Map<string, string>();
  private followers = new Map<string, Follower>();
  /** tool/call 的 callId → 工具名（tool/result 只带 callId，名称需回填给手机端卡片） */
  private toolNames = new Map<string, string>();
  /** 每个会话的流式增量连续性状态（丢弃重复/乱序的 reasoning/text delta） */
  private streamProgress = new Map<string, StreamProgress>();
  private permissionStates = new Map<string, SessionPermissionPresetState>();

  // ── 连接 ────────────────────────────────────────────────────────────

  async connect(cfg: AdapterConfig): Promise<boolean> {
    const c = cfg as DshAdapterConfig;
    if (!c.baseUrl) throw new Error('dsh adapter: missing baseUrl');
    this.cfg = { baseUrl: c.baseUrl, authToken: c.authToken, authority: c.authority, waitForBaseline: c.waitForBaseline };
    await this.open();
    return true;
  }

  /** 用当前 cfg 建立 client + mux 并打开常驻逻辑流（connect / reconnect 共用） */
  private async open(): Promise<void> {
    const cfg = this.cfg;
    if (!cfg) throw new Error('dsh adapter: not configured');
    const client = new DshApiClient({ baseUrl: cfg.baseUrl, timeoutMs: 8000, authToken: cfg.authToken, authority: cfg.authority });
    await client.ensureAuthenticated();
    this.client = client;
    console.log(`[dsh] auth=${cfg.authToken ? 'launch-token ✓' : 'none'} cookie=${client.getCookie() ? 'set' : 'none'}`);

    const mux = new DshRemoteMux(
      cfg.baseUrl,
      {
        getCookie: () => this.client?.getCookie() ?? null,
        authority: cfg.authority,
        onUnauthorized: async () => {
          this.client?.resetAuth();
          await this.client?.ensureAuthenticated();
        },
      },
      {
        onStateChange: (s) => { if (s !== 'open') { this.workspaceReady = false; console.log(`[dsh] remote.mux ${s}`); } },
        // 逻辑流由 mux 跨代次自动重开（streamId 不变），这里只重置派生状态
        onGeneration: () => this.resetGeneration(),
      },
    );
    this.mux = mux;
    mux.start();

    this.openCoreStreams();
    // 工作区基线（首帧 baseline）就绪后再返回，保证首个 workspace.tree 有数据
    if (cfg.waitForBaseline !== false) await Promise.race([this.workspaceBaseline ?? Promise.resolve(), sleep(8000)]);
  }

  /** 打开两条常驻逻辑流（$events / workspace/follow）：只做一次，重连由 mux 重发 open */
  private openCoreStreams(): void {
    const mux = this.mux;
    if (!mux) return;
    this.eventStreamId = mux.open('$events', {}, {
      name: '$events',
      onItem: (v) => this.onEventFrame(v as DshRemoteEventFrame),
      onError: () => { this.eventStreamId = null; this.eventClientId = null; },
      onEnd: () => { this.eventStreamId = null; this.eventClientId = null; },
    });

    this.workspaceStreamId = mux.open('workspace/follow', {}, {
      name: 'workspace/follow',
      onItem: (v) => this.onWorkspaceFrame(v as DshWorkspaceFollowFrame),
      onError: () => { this.workspaceStreamId = null; },
      onEnd: () => { this.workspaceStreamId = null; },
    });
    this.resetGeneration();
  }

  /**
   * 新连接代次：旧代次的派生状态全部作废（首帧 baseline/snapshot 会重新对齐），
   * 但逻辑流本身（及其 streamId）由 mux 跨代次保留并自动重开。
   */
  private resetGeneration(): void {
    this.eventClientId = null;
    this.workspaceReady = false;
    this.workspaceResolve?.();
    this.workspaceBaseline = new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(done, 8000);
      this.workspaceResolve = () => { clearTimeout(timer); done(); };
    });
    for (const f of this.followers.values()) {
      f.snapshot = null;
      f.cursor = null;
    }
  }

  /**
   * 热更新 launch token（DSH 每进程随机、重启即变）：换 cookie 并重建整条连接。
   * 由网关的 /api/dsh/launch-token 端点调用。
   */
  async setAuthToken(token: string): Promise<void> {
    if (this.cfg?.authToken === token && this.client?.getCookie()) return;
    console.log('[dsh] launch token 更新 → 重建连接');
    if (this.cfg) this.cfg = { ...this.cfg, authToken: token };
    await this.reconnect();
  }

  /** 拆掉现有连接并重建（token 轮换 / 手工重连） */
  async reconnect(): Promise<void> {
    const mux = this.mux;
    this.mux = null;
    this.eventStreamId = null;
    this.eventClientId = null;
    this.workspaceStreamId = null;
    this.pending.clear();
    for (const f of this.followers.values()) {
      this.clearFollowerTimers(f);
      f.streamId = null;
      f.snapshot = null;
      f.cursor = null;
      for (const w of f.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('dsh reconnecting')); }
    }
    this.workspaces.clear();
    this.workspaceOrder = [];
    await mux?.stop();
    await this.open();
  }
  onEvent(listener: (backendSessionId: string, event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(sid: string, event: AgentEvent): void {
    for (const l of this.listeners) l(sid, event);
  }

  // ── $events（审批 / 提问 / 会话状态广播）──────────────────────────────

  private onEventFrame(frame: DshRemoteEventFrame): void {
    if (!frame || typeof frame !== 'object') return;
    switch (frame.type) {
      case 'ready':
        this.eventClientId = frame.clientId;
        console.log(`[dsh] $events ready clientId=${frame.clientId}`);
        break;
      case 'emit':
        this.onHostEmit(frame.event, frame.args);
        break;
      case 'waterfall':
        this.onWaterfall(frame);
        break;
      case 'cancel': {
        const pending = this.pending.get(frame.eventId);
        if (!pending) break;
        this.pending.delete(frame.eventId);
        if (pending.kind === 'approval') {
          this.emit(pending.sessionId, { type: 'approval/resolved', approvalId: frame.eventId, outcome: 'cancelled' });
        } else {
          this.emit(pending.sessionId, { type: 'question/resolved', questionRpcId: frame.eventId, outcome: 'cancelled' });
        }
        break;
      }
      default:
        break;
    }
  }

  /** 普通通知（mode: 'emit'）：只消费与手机端会话状态有关的少数几个 */
  private onHostEmit(event: string, args: unknown[]): void {
    if (event === 'api-session/status') {
      const sid = String(args[0] ?? '');
      if (sid && args[1] === true) this.setState(sid, 'running');
    }
    // 其余（settings/document-updated、llm/adapters-updated、cordis/* 等）与手机端 v1 无关
  }

  private onWaterfall(frame: { event: string; eventId: string; agentId: string; request: Record<string, unknown> }): void {
    // Agent 身份在普通会话下即 SessionId（dsh-agent: Agent.id === SessionId）
    const sid = frame.agentId;
    if (frame.event === 'approval/request') {
      const req = frame.request as unknown as DshApprovalRequestPayload;
      this.pending.set(frame.eventId, { kind: 'approval', sessionId: sid });
      this.setState(sid, 'waiting-approval');
      this.emit(sid, {
        type: 'approval/requested',
        approvalId: frame.eventId,
        toolName: String(req?.toolName ?? ''),
        callId: req?.callId,
        reason: req?.reason,
        rpcId: frame.eventId,
      });
      console.log(`[dsh] approval/request sid=${sid} tool=${req?.toolName} eventId=${frame.eventId}`);
      return;
    }
    if (frame.event === 'user-questions/request') {
      const qs = normalizeQuestions((frame.request as { questions?: unknown })?.questions);
      this.pending.set(frame.eventId, { kind: 'question', sessionId: sid, questions: qs });
      this.setState(sid, 'waiting-question');
      this.emit(sid, { type: 'question/requested', questionRpcId: frame.eventId, questions: qs, rpcId: frame.eventId });
      console.log(`[dsh] user-questions/request sid=${sid} questions=${qs.length} eventId=${frame.eventId}`);
    }
  }

  // ── workspace/follow ────────────────────────────────────────────────

  private onWorkspaceFrame(frame: DshWorkspaceFollowFrame): void {
    if (!frame || typeof frame !== 'object') return;
    switch (frame.type) {
      case 'baseline': {
        this.workspaceReady = true;
        const items = frame.value?.items ?? [];
        this.workspaces = new Map(items.map((w) => [w.workspaceId, w]));
        this.workspaceOrder = items.map((w) => w.workspaceId);
        this.archivedSessions = new Set(frame.value?.archivedSessionIds ?? []);
        this.workspaceResolve?.();
        this.workspaceResolve = null;
        break;
      }
      case 'upsert': {
        if (!frame.workspace) break;
        if (!this.workspaces.has(frame.workspace.workspaceId)) this.workspaceOrder.push(frame.workspace.workspaceId);
        this.workspaces.set(frame.workspace.workspaceId, frame.workspace);
        break;
      }
      case 'remove':
        this.workspaces.delete(frame.workspaceId);
        this.workspaceOrder = this.workspaceOrder.filter((id) => id !== frame.workspaceId);
        break;
      case 'order':
        this.workspaceOrder = [...frame.workspaceIds];
        break;
      case 'archived':
        this.archivedSessions = new Set(frame.archivedSessionIds ?? []);
        break;
      default:
        break;
    }
  }
  // ── session/follow ──────────────────────────────────────────────────

  /** 取（必要时新建）会话 follow 流；`fresh` 为真时重开以拿到最新 snapshot */
  private ensureFollower(sessionId: string, fresh = false): Follower {
    this.evictFollowers(sessionId);
    let f = this.followers.get(sessionId);
    if (!f) {
      f = { streamId: null, cursor: null, snapshot: null, waiters: [], lastTouch: Date.now(), retryTimer: null };
      this.followers.set(sessionId, f);
    }
    f.lastTouch = Date.now();
    if (fresh) {
      // 强制刷新：必须丢弃缓存的开窗数据，否则 history() 会拿到开流时的旧 snapshot
      if (f.streamId) this.cancelFollower(f);
      f.snapshot = null;
      f.cursor = null;
    }
    if (!f.streamId) this.openFollower(sessionId, f);
    return f;
  }

  private openFollower(sessionId: string, f: Follower): void {
    const mux = this.mux;
    if (!mux || this.followers.get(sessionId) !== f) return;
    if (f.streamId) this.cancelFollower(f);   // 防御：同一条会话的旧流不再继续投递
    const handlers: DshStreamHandlers = {
      name: `session/follow[${sessionId.slice(0, 8)}]`,
      onItem: (v) => this.onFollowFrame(sessionId, f, v as DshSessionFollowFrame),
      onError: (e) => {
        f.streamId = null;
        for (const w of f.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error(`dsh session/follow 失败：${e.code} ${e.message}`));
        }
        // 服务端错误多为临时（会话正被另一进程激活等），退避重开以保住实时流
        if (this.followers.get(sessionId) === f && !f.retryTimer) {
          f.retryTimer = setTimeout(() => {
            f.retryTimer = null;
            if (this.followers.get(sessionId) === f) this.openFollower(sessionId, f);
          }, 3000);
        }
      },
      onEnd: () => { f.streamId = null; },
    };
    f.streamId = mux.open(
      'session/follow',
      { request: { address: { kind: 'session', sessionId }, maxMessages: FOLLOW_MAX_MESSAGES, assistantStream: true } },
      handlers,
    );
  }

  private cancelFollower(f: Follower): void {
    if (!f.streamId) return;
    const id = f.streamId;
    f.streamId = null;
    this.mux?.cancel(id);
  }

  private clearFollowerTimers(f: Follower): void {
    if (f.retryTimer) clearTimeout(f.retryTimer);
    f.retryTimer = null;
  }

  /** LRU 淘汰：只保留最近活跃的 FOLLOWER_CAP 条会话流 */
  private evictFollowers(keep: string): void {
    if (this.followers.size < FOLLOWER_CAP) return;
    const victims = [...this.followers.entries()]
      .filter(([sid]) => sid !== keep)
      .sort((a, b) => a[1].lastTouch - b[1].lastTouch)
      .slice(0, this.followers.size - FOLLOWER_CAP + 1);
    for (const [sid, f] of victims) {
      this.cancelFollower(f);
      this.clearFollowerTimers(f);
      for (const w of f.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('dsh follower evicted')); }
      this.followers.delete(sid);
    }
  }

  private onFollowFrame(sessionId: string, f: Follower, frame: DshSessionFollowFrame): void {
    if (!frame || typeof frame !== 'object') return;
    f.lastTouch = Date.now();
    if (frame.type === 'snapshot') {
      const records = (frame.records ?? []).map((r) => r.event).filter(Boolean);
      f.cursor = typeof frame.cursor === 'number' ? frame.cursor : null;
      f.snapshot = {
        records,
        hasMore: frame.hasMore === true,
        projections: frame.projections?.values,
      };
      const permissions = sessionPermissionState(f.snapshot.projections?.permissions);
      this.permissionStates.set(sessionId, permissions);
      if (permissions.supported && permissions.currentValue !== null) {
        this.emit(sessionId, { type: 'session/permissionPreset', permissionPresetId: permissions.currentValue });
      }
      // 标题在 projections.values.title（0.1.5 投影键）——顺手补一次缓存
      const title = (frame.projections?.values as { title?: unknown } | undefined)?.title;
      if (typeof title === 'string' && title) this.sessionTitles.set(sessionId, title);
      // 流式增量基线：据此对齐 revision/attempt 进度（跨重连不重复也不丢帧）
      const baseline = frame.assistantStream;
      this.streamProgress.set(sessionId, {
        revision: baseline?.revision ?? 0,
        attempt: baseline?.activeAttempt
          ? { attemptId: baseline.activeAttempt.attemptId, nextIndex: baseline.activeAttempt.nextIndex }
          : null,
      });
      const snapshot = f.snapshot;
      for (const w of f.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(snapshot); }
      return;
    }
    if (frame.type === 'event') {
      this.onSessionEvent(sessionId, frame.event);
      return;
    }
    if (frame.type === 'assistant-stream') {
      const e = this.acceptStreamFrame(sessionId, frame.frame);
      if (e) this.emit(sessionId, e);
    }
  }

  /**
   * 流式增量连续性闸门（与 DSH 官方 SessionAssistantStreamAccumulator 同规则）：
   * revision 必须连续（重试会让 revision 重置，此时丢弃该帧），chunk 的 index 必须
   * 恰好接在上一个之后 —— 否则该 delta 是重复或乱序帧，直接丢弃，避免手机端文本翻倍。
   */
  private acceptStreamFrame(sessionId: string, af: DshAssistantStreamFrame): AgentEvent | null {
    let p = this.streamProgress.get(sessionId);
    if (!p) { p = { revision: 0, attempt: null }; this.streamProgress.set(sessionId, p); }
    // 新 attempt 从 revision=1 重新开始：先把本地 revision 归零，避免误判为乱序
    if (af.type === 'start' && af.revision === 1 && p.revision !== 0) {
      p.revision = 0;
      p.attempt = null;
    }
    if (af.revision !== p.revision + 1) {
      p.revision = af.revision;
      p.attempt = null;
      return null;
    }
    p.revision = af.revision;
    if (af.type === 'start') {
      p.attempt = { attemptId: af.attemptId, nextIndex: 0 };
      return null;
    }
    if (af.type === 'end') {
      p.attempt = null;
      return null;
    }
    if (!p.attempt || p.attempt.attemptId !== af.attemptId || af.index !== p.attempt.nextIndex) {
      p.attempt = null;
      return null;
    }
    p.attempt.nextIndex += 1;
    return mapChunkData(af.chunk);
  }

  /** 一条会话事件 → 状态更新 + 归一化 AgentEvent 推送 */
  private onSessionEvent(sessionId: string, ev: DshSessionWireEvent): void {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'permission/preset') {
      const selected = (ev.data as { preset?: unknown } | undefined)?.preset;
      const current = this.permissionStates.get(sessionId);
      if (typeof selected === 'string' && current?.options.some((option) => option.id === selected && option.available)) {
        const next = { ...current, currentValue: selected };
        this.permissionStates.set(sessionId, next);
        this.emit(sessionId, { type: 'session/permissionPreset', permissionPresetId: selected });
      }
    }
    if (ev.type === 'session/title') {
      const t = String((ev.data as { title?: unknown } | undefined)?.title ?? '');
      if (t) this.sessionTitles.set(sessionId, t);
    }
    if (ev.type === 'tool/call') {
      const callId = (ev.data as { callId?: unknown } | undefined)?.callId;
      const name = (ev.data as { name?: unknown } | undefined)?.name;
      if (typeof callId === 'string' && typeof name === 'string' && name) this.toolNames.set(callId, name);
    }
    for (const e of mapEvent(ev)) {
      // tool/result 只带 callId：用它回填工具名，手机端才能渲染工具卡片标题
      if (e.type === 'tool/result' && !e.toolName && e.callId) e.toolName = this.toolNames.get(e.callId) ?? '';
      this.updateStateFromEvent(sessionId, e);
      this.emit(sessionId, e);
    }
  }

  /** 等待会话 snapshot（history 用） */
  private waitForSnapshot(f: Follower, timeoutMs: number): Promise<Snapshot> {
    if (f.snapshot && f.cursor !== null) return Promise.resolve(f.snapshot);
    return new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        f.waiters = f.waiters.filter((w) => w.timer !== timer);
        reject(new Error('dsh session/follow 开窗超时'));
      }, timeoutMs);
      f.waiters.push({ resolve, reject, timer });
    });
  }

  private updateStateFromEvent(sessionId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'turn/start': this.setState(sessionId, 'running'); break;
      case 'turn/end': this.setState(sessionId, 'done'); break;
      case 'approval/requested': this.setState(sessionId, 'waiting-approval'); break;
      case 'question/requested': this.setState(sessionId, 'waiting-question'); break;
      default: break;
    }
  }

  private setState(sessionId: string, state: SessionState): void {
    this.states.set(sessionId, state);
  }

  private refOf(sessionId: string, title?: string, createdAt?: number): AgentSessionRef {
    return {
      backend: this.id,
      backendSessionId: sessionId,
      title,
      state: this.states.get(sessionId) ?? 'idle',
      createdAt: createdAt ?? Date.now(),
    };
  }

  private requireClient(): DshApiClient {
    if (!this.client) throw toError('not-connected', 'dsh adapter 未连接');
    return this.client;
  }
  // ── 契约方法 ────────────────────────────────────────────────────────

  async listSessions(): Promise<AgentSessionRef[]> {
    // session/list 的参数 wire 名是 `_request`（保留空列表请求）
    const r = await this.requireClient().call<DshSessionListValue>('session/list', { _request: {} });
    if (!r.ok) throw toError(r.error.code, r.error.message);
    return (r.value.items ?? [])
      .filter((s) => s.origin !== 'subagent')   // 子代理会话不进手机端会话列表
      .map((s) => {
        const projected = (s.projections?.values as { title?: unknown } | undefined)?.title;
        const ref = this.refOf(s.sessionId, this.titleOf(s.sessionId, typeof projected === 'string' ? projected : undefined), s.updatedAt);
        ref.model = projectedModel(s.projections?.values?.modelSelection);
        return ref;
      });
  }

  /** 标题优先取缓存（session/title 事件更及时），否则用 DSH projections */
  private titleOf(sessionId: string, fallback?: string): string | undefined {
    return this.sessionTitles.get(sessionId) ?? fallback;
  }

  async createSession(opts: CreateSessionOpts): Promise<AgentSessionRef> {
    // DSH 0.1.2+ 校验：workspaceId 与 cwd 二选一（同时给会报 bad-request）；
    // 归属工作区时由 DSH 从工作区推导目录，故 workspaceId 优先。
    const request: Record<string, unknown> = { agentPreset: opts.agentPreset };
    if (opts.workspaceId) request.workspaceId = opts.workspaceId;
    else if (opts.workspacePath) request.cwd = opts.workspacePath;
    const r = await this.requireClient().call<DshSessionCreateValue>('session/create', { request });
    if (!r.ok) throw toError(r.error.code, r.error.message);
    const sessionId = r.value.sessionId;
    this.setState(sessionId, 'idle');
    const ref = this.refOf(sessionId, opts.title);
    if (opts.model) {
      const sel = await this.requireClient().call<DshSessionSelectModelValue>('session/selectModel', {
        request: {
          sessionId,
          provider: opts.model.provider,
          model: opts.model.model,
          reasoningEffort: opts.model.reasoningEffort,
        },
      });
      if (!sel.ok) throw toError(sel.error.code, sel.error.message);
    }
    ref.model = opts.model;
    return ref;
  }

  async resumeSession(backendSessionId: string): Promise<AgentSessionRef> {
    // DSH：恢复 = 附加会话（prompt 时自动附加）。这里顺手开 follow 流，
    // 让手机端进入会话后立刻拿到实时事件（含电脑端正跑着的回合）。
    const session = (await this.listSessions()).find(s => s.backendSessionId === backendSessionId);
    if (!session) throw toError('session-not-found', 'DSH 会话不存在');
    this.ensureFollower(backendSessionId);
    return session;
  }

  async prompt(session: AgentSessionRef, parts: PromptPart[], opts?: { queueAction?: 'prompt' | 'steer' | 'queue'; agentPreset?: string }): Promise<void> {
    const sessionId = session.backendSessionId;
    // 先开 follow 流再提交，避免漏掉回合最初的事件
    this.ensureFollower(sessionId);
    const mode = opts?.queueAction === 'steer' ? 'steer' : 'queue';
    const r = await this.requireClient().call('session/prompt', {
      request: {
        requestId: crypto.randomUUID(),   // 客户端铸造的用户消息身份（0.1.2+ 必填）
        sessionId,
        mode,
        content: parts,
      },
    });
    if (!r.ok) throw toError(r.error.code, r.error.message);
  }

  async respond(session: AgentSessionRef, serverRequestRpcId: string, payload: unknown): Promise<void> {
    const pending = this.pending.get(serverRequestRpcId);
    if (!pending) throw toError('bad-request', 'no pending interaction for rpcId');
    const clientId = this.eventClientId;
    if (!clientId) throw toError('not-ready', 'DSH $events 流尚未就绪，请稍后重试');

    if (pending.kind === 'approval') {
      const p = payload as { outcome?: string } | null;
      const outcome = p?.outcome === 'rejected' ? 'rejected' : 'allowed-once';
      const r = await this.requireClient().respondEvent({ clientId, eventId: serverRequestRpcId, outcome: { kind: 'result', value: outcome } });
      if (!r.ok) throw toError(r.error.code, r.error.message);
      this.pending.delete(serverRequestRpcId);
      this.setState(pending.sessionId, 'running');
      this.emit(pending.sessionId, { type: 'approval/resolved', approvalId: serverRequestRpcId, outcome });
      return;
    }

    // 提问：{ skip:true } = 放弃应答（交给下一个 answerer）；否则回填 answers
    const p = payload as {
      selected?: unknown; custom?: unknown; answer?: unknown; skip?: unknown;
      answers?: { id?: unknown; selected?: unknown; custom?: unknown; answer?: unknown }[];
    } | null;
    if (p?.skip === true) {
      const r = await this.requireClient().respondEvent({ clientId, eventId: serverRequestRpcId, outcome: { kind: 'next' } });
      if (!r.ok) throw toError(r.error.code, r.error.message);
      this.pending.delete(serverRequestRpcId);
      this.setState(pending.sessionId, 'running');
      this.emit(pending.sessionId, { type: 'question/resolved', questionRpcId: serverRequestRpcId, outcome: 'cancelled' });
      return;
    }

    const questions = pending.questions ?? [];
    const submitted = Array.isArray(p?.answers) ? p.answers : [];
    const legacySelected = Array.isArray(p?.selected) ? p.selected.map(String) : (p?.selected ? [String(p.selected)] : []);
    const legacyCustom = typeof p?.custom === 'string' ? p.custom : (typeof p?.answer === 'string' ? p.answer : undefined);
    const value: DshAskUserQuestionAnswer = {
      answers: questions.map((q) => {
        const answer = submitted.find((item) => String(item?.id ?? '') === q.id);
        const selected = answer
          ? (Array.isArray(answer.selected) ? answer.selected.map(String) : (answer.selected ? [String(answer.selected)] : []))
          : legacySelected;
        const custom = answer
          ? (typeof answer.custom === 'string' ? answer.custom : (typeof answer.answer === 'string' ? answer.answer : undefined))
          : legacyCustom;
        return custom === undefined ? { id: q.id, selected } : { id: q.id, selected, custom };
      }),
    };
    const r = await this.requireClient().respondEvent({ clientId, eventId: serverRequestRpcId, outcome: { kind: 'result', value } });
    if (!r.ok) throw toError(r.error.code, r.error.message);
    this.pending.delete(serverRequestRpcId);
    this.setState(pending.sessionId, 'running');
    this.emit(pending.sessionId, { type: 'question/resolved', questionRpcId: serverRequestRpcId, outcome: 'answered' });
  }

  async cancel(session: AgentSessionRef, _itemId?: string): Promise<void> {
    const r = await this.requireClient().call('session/cancel', { request: { sessionId: session.backendSessionId } });
    if (!r.ok) throw toError(r.error.code, r.error.message);
  }
  async history(session: AgentSessionRef, opts?: { beforeSeq?: number; limit?: number }): Promise<AgentEvent[]> {
    const sessionId = session.backendSessionId;
    const limit = opts?.limit ?? HISTORY_MAX_EVENTS;
    // 强制重开 follow 流拿一份最新 snapshot：它同时给出 history 内容与分页 cursor
    const f = this.ensureFollower(sessionId, true);
    const snap = await this.waitForSnapshot(f, 30_000);

    if (opts?.beforeSeq != null && opts.beforeSeq > 0 && f.cursor !== null) {
      const r = await this.requireClient().call<DshSessionPage>('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: f.cursor,
          beforeSeq: opts.beforeSeq,
          maxMessages: limit,   // 实测 DSH 接受大值（400 也照给），按调用方的 limit 要页
        },
      });
      if (!r.ok) {
        console.log(`[dsh-history] FAIL sid=${sessionId}: ${r.error.code} ${r.error.message}`);
        return [];
      }
      const events = (r.value.records ?? []).map((x) => x.event).filter(Boolean);
      console.log(`[dsh-history] sid=${sessionId} page events=${events.length} hasMore=${r.value.hasMore}`);
      return aggregateHistory(events);
    }

    const events = snap.records.length > limit ? snap.records.slice(-limit) : snap.records;
    console.log(`[dsh-history] sid=${sessionId} snapshot events=${events.length}/${snap.records.length} hasMore=${snap.hasMore}`);
    return aggregateHistory(events);
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    // Login need not wait for a PC, but a list must not mistake a pending baseline for an empty workspace.
    const generation = this.workspaceBaseline;
    await generation;
    if (!this.workspaceReady && generation !== this.workspaceBaseline) await this.workspaceBaseline;
    if (!this.workspaceReady) throw toError('not-connected', 'DSH 工作区尚未同步，请稍后重试');
    return this.orderedWorkspaces().map(toWorkspaceView);
  }

  private orderedWorkspaces(): DshWorkspaceView[] {
    const out: DshWorkspaceView[] = [];
    const seen = new Set<string>();
    for (const id of this.workspaceOrder) {
      const w = this.workspaces.get(id);
      if (w) { out.push(w); seen.add(id); }
    }
    // 防御：order 帧缺失时兜底补全（baseline 之外的 upsert 可能先到）
    for (const [id, w] of this.workspaces) if (!seen.has(id)) out.push(w);
    return out;
  }

  async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    const r = await this.requireClient().call<DshWorkspaceCreateValue>('workspace/create', { request: { path } });
    if (!r.ok) throw toError(r.error.code, r.error.message);
    const w = r.value.workspace;
    if (w) {
      this.workspaces.set(w.workspaceId, w);
      if (!this.workspaceOrder.includes(w.workspaceId)) this.workspaceOrder.push(w.workspaceId);
    }
    return { workspace: toWorkspaceView(w), created: r.value.created };
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const r = await this.requireClient().call('workspace/delete', { request: { workspaceId } });
    if (!r.ok) throw toError(r.error.code, r.error.message);
  }

  async archiveSession(sessionId: string): Promise<void> {
    const r = await this.requireClient().call<DshWorkspaceArchiveValue>('workspace/archiveSession', { request: { sessionId } });
    if (!r.ok) throw toError(r.error.code, r.error.message);
    // DSH 返回 archivedSessionIds（当前全部已归档会话），据此同步本地归档集合
    const ids = r.value?.archivedSessionIds;
    if (Array.isArray(ids)) this.archivedSessions = new Set(ids);
    else this.archivedSessions.add(sessionId);
  }

  /** 工作区树：workspace/follow 基线 + session/list，按 WorkspaceView.sessionIds 关联；过滤已归档会话 */
  async workspaceTree(): Promise<WorkspaceTree> {
    const [wslist, seslist] = await Promise.all([this.listWorkspaces(), this.listSessions()]);
    const byId = new Map(seslist.map((s) => [s.backendSessionId, s]));
    const assigned = new Set<string>();
    const items = wslist.map((w) => ({
      workspace: { workspaceId: w.workspaceId, path: w.path, title: w.title, createdAt: w.createdAt },
      sessions: w.sessionIds.flatMap((id) => {
        if (this.archivedSessions.has(id)) return [];   // 归档会话：从工作区树隐藏
        const s = byId.get(id);
        if (!s || assigned.has(id)) return [];
        assigned.add(id);
        return [{ sessionId: id, title: s.title, state: s.state, updatedAt: s.createdAt }];
      }),
    }));
    const ungroupedSessions = seslist.filter((s) => !assigned.has(s.backendSessionId)
      && !this.archivedSessions.has(s.backendSessionId))
      .map((s) => ({ sessionId: s.backendSessionId, title: s.title, state: s.state, updatedAt: s.createdAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { items, ungroupedSessions };
  }

  async listModels(): Promise<ModelRef[]> {
    const r = await this.requireClient().call<DshModelCatalog>('session/modelCatalog', {});
    if (!r.ok) throw toError(r.error.code, r.error.message);
    const out: ModelRef[] = [];
    for (const g of r.value.groups ?? []) {
      for (const m of g.models ?? []) {
        const available = [...new Set((m.reasoning?.efforts ?? []).map((effort) => effort.id).filter(Boolean))];
        if (available.length === 0) {
          out.push({ provider: g.id, model: m.id, displayName: m.name, reasoningEffort: m.reasoning?.defaultEffort });
          continue;
        }
        const defaultEffort = m.reasoning?.defaultEffort;
        const ordered = defaultEffort && available.includes(defaultEffort)
          ? [defaultEffort, ...available.filter((effort) => effort !== defaultEffort)] : available;
        for (const reasoningEffort of ordered) out.push({ provider: g.id, model: m.id, displayName: m.name, reasoningEffort });
      }
    }
    return out;
  }

  async selectModel(session: AgentSessionRef, model: ModelRef): Promise<void> {
    const r = await this.requireClient().call<DshSessionSelectModelValue>('session/selectModel', {
      request: {
        sessionId: session.backendSessionId,
        provider: model.provider,
        model: model.model,
        reasoningEffort: model.reasoningEffort,
      },
    });
    if (!r.ok) throw toError(r.error.code, r.error.message);
    const selected = r.value.selected;
    if (selected?.provider !== model.provider || selected?.model !== model.model ||
        (model.reasoningEffort != null && selected.reasoningEffort !== model.reasoningEffort)) {
      throw toError('model-select-unconfirmed', 'DSH 未确认所选模型与思考强度');
    }
  }

  async sessionPermissionPresets(session: AgentSessionRef): Promise<SessionPermissionPresetState> {
    const f = this.ensureFollower(session.backendSessionId, true);
    const snapshot = await this.waitForSnapshot(f, 30_000);
    const state = sessionPermissionState(snapshot.projections?.permissions);
    this.permissionStates.set(session.backendSessionId, state);
    return state;
  }

  async selectSessionPermissionPreset(
    session: AgentSessionRef,
    presetId: string,
    confirmed: boolean,
  ): Promise<SessionPermissionPresetState> {
    if (!SESSION_PERMISSION_PRESETS.some((preset) => preset.id === presetId)) {
      throw toError('bad-request', '不支持的 DSH 权限预设');
    }
    if (presetId === 'danger-full-access' && !confirmed) {
      throw toError('permission-confirmation-required', '完全访问必须先在手机端二次确认');
    }

    const sessionId = session.backendSessionId;
    const before = await this.sessionPermissionPresets(session);
    if (!before.supported) throw toError('capability-missing', '当前 DSH 未提供会话权限预设投影');
    if (!before.options.some((option) => option.id === presetId && option.available)) {
      throw toError('capability-missing', '当前 DSH 会话未开放此权限预设');
    }

    const listed = await this.requireClient().call<{ name: string; description: string }[]>('commands/list', { agentId: sessionId });
    if (!listed.ok) throw toError(listed.error.code, listed.error.message);
    if (!Array.isArray(listed.value) || !listed.value.some((command) => command?.name === 'permission')) {
      throw toError('capability-missing', '当前 DSH 未提供权限切换命令');
    }

    const executed = await this.requireClient().call<{
      commandId: string;
      result: { kind: 'success'; text?: string } | { kind: 'error'; text: string };
    } | undefined>('commands/execute', {
      agentId: sessionId,
      line: `/permission ${presetId}`,
      submittedAttachments: [],
    });
    if (!executed.ok) throw toError(executed.error.code, executed.error.message);
    if (!executed.value) throw toError('dsh-command-unavailable', 'DSH 未执行权限切换命令');
    if (executed.value.result?.kind !== 'success') {
      throw toError('dsh-command-rejected', executed.value.result?.text ?? 'DSH 拒绝了权限切换');
    }

    const after = await this.sessionPermissionPresets(session);
    if (after.currentValue !== presetId) {
      throw toError('permission-sync-pending', 'DSH 尚未确认新的权限状态，请刷新后重试');
    }
    return after;
  }

  async renameSession(session: AgentSessionRef, title: string): Promise<{ title: string }> {
    const r = await this.requireClient().call<{ title: string }>('session/rename', {
      request: { sessionId: session.backendSessionId, title },
    });
    if (!r.ok) throw toError(r.error.code, r.error.message);
    const t = r.value?.title ?? title;
    this.sessionTitles.set(session.backendSessionId, t);
    return { title: t };
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    this.pending.clear();
    this.states.clear();
    this.permissionStates.clear();
    for (const f of this.followers.values()) this.clearFollowerTimers(f);
    this.followers.clear();
    const mux = this.mux;
    this.mux = null;
    await mux?.stop();
  }
}

/** 工厂（供 AdapterRegistry.assemble 使用） */
export function createDshAdapter(_cfg: AdapterConfig): AgentAdapter {
  return new DshAdapter();
}

function sessionPermissionState(value: unknown): SessionPermissionPresetState {
  const projection = value && typeof value === 'object' ? value as { options?: unknown; currentValue?: unknown } : undefined;
  const rawOptions = Array.isArray(projection?.options) ? projection.options : [];
  const supported = !!projection && typeof projection.currentValue === 'string' && Array.isArray(projection.options);
  const availableIds = new Set(rawOptions.flatMap((option) => {
    if (!option || typeof option !== 'object') return [];
    const id = (option as { value?: unknown }).value;
    return typeof id === 'string' ? [id] : [];
  }));
  return {
    supported,
    currentValue: typeof projection?.currentValue === 'string' ? projection.currentValue : null,
    options: SESSION_PERMISSION_PRESETS.map((preset) => ({ ...preset, available: supported && availableIds.has(preset.id) })),
  };
}

// ── 归一化：DSH 会话事件 → AgentEvent ─────────────────────────────────

/** 一条 session 事件 → AgentEvent[]（对齐 DSH SessionEvent 词汇；不含状态与推送） */
function mapEvent(ev: DshSessionWireEvent): AgentEvent[] {
  const data = ev.data as Record<string, unknown> | undefined;
  switch (ev.type) {
    case 'user/message':
      if (isSystemUserEvent(data)) return [];   // 系统提示词（plugin/catalog 注入）隐藏
      return [{ type: 'user/message', text: extractText(data) }];
    case 'assistant/message':
      return [mapAssistantMessage(data)];
    case 'tool/call':
      return [{
        type: 'tool/call',
        toolName: stringOf(data?.name),
        callId: data?.callId as string | undefined,
        args: data?.arguments,
      }];
    case 'tool/result': {
      const msg = data?.message as Record<string, unknown> | undefined;
      const block = (Array.isArray(msg?.content) ? msg?.content[0] : undefined) as Record<string, unknown> | undefined;
      const error = data?.error as { code?: string } | undefined;
      return [{
        type: 'tool/result',
        toolName: stringOf(data?.name ?? ''),
        callId: (block?.toolCallId as string | undefined) ?? (data?.callId as string | undefined),
        ok: !error && block?.isError !== true,
        summary: extractText(msg),
      }];
    }
    case 'turn/start': return [{ type: 'turn/start' }];
    case 'turn/end': return [{ type: 'turn/end' }];
    case 'step/start': return [{ type: 'step/start' }];
    case 'step/end': return [{ type: 'step/end' }];
    case 'session/title':
      return [{ type: 'session/title', title: stringOf(data?.title) }];
    default:
      return []; // 其余事件（compaction / plan / goal / jobs…）手机端 v1 不展示
  }
}

/** assistant-stream 的 chunk → assistant/chunk 增量（text-delta / reasoning-delta） */
function mapChunkData(chunk: unknown): AgentEvent | null {
  const c = chunk as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return null;
  const text = typeof c.text === 'string' ? c.text : '';
  if (!text) return null;
  if (c.type === 'reasoning-delta') return { type: 'assistant/chunk', text: '', reasoning: text };
  if (c.type === 'text-delta') return { type: 'assistant/chunk', text };
  return null;
}

/** assistant/message → AgentEvent：text 取 content 里 type="text" 块，reasoning 取 type="reasoning" 块 */
function mapAssistantMessage(data: Record<string, unknown> | undefined): AgentEvent {
  const msg = data?.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (!Array.isArray(content)) return { type: 'assistant/message', text: extractText(data) };
  let text = '';
  let reasoning = '';
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    if (o.type === 'text' && typeof o.text === 'string') text += o.text;
    else if (o.type === 'reasoning' && typeof o.text === 'string') reasoning += o.text;
  }
  return reasoning ? { type: 'assistant/message', text, reasoning } : { type: 'assistant/message', text };
}

/** 判断是否为"系统提示"性质的 user/message（DSH source.kind 标记系统注入，非用户真实消息） */
function isSystemUserEvent(data: Record<string, unknown> | undefined): boolean {
  const kind = (data?.source as { kind?: string } | undefined)?.kind;
  // plugin（<system-reminder>/sandbox:policy/approval:policy）、skill-catalog 等注入 → 过滤
  return kind === 'plugin' || kind === 'skill-catalog' || kind === 'system' || kind === 'reminder';
}

/** 从 DSH 消息载荷里提取可读正文（user / assistant / tool-result 三处结构略有差异） */
function extractText(data: Record<string, unknown> | undefined): string {
  if (!data) return '';
  const joinBlocks = (blocks: unknown): string => {
    if (!Array.isArray(blocks)) return '';
    return blocks.map((b) => {
      if (!b || typeof b !== 'object') return '';
      const o = b as Record<string, unknown>;
      if (typeof o.text === 'string') return o.text;
      if (Array.isArray(o.content)) return joinBlocks(o.content);   // tool-result 的嵌套 content
      return '';
    }).join('');
  };
  const msg = data.message as Record<string, unknown> | undefined;
  if (msg && Array.isArray(msg.content)) {
    const t = joinBlocks(msg.content);
    if (t) return t;
  }
  if (Array.isArray(data.content)) return joinBlocks(data.content);
  return '';
}

/**
 * history 事件回放 → 可读 AgentEvent[]。
 * assistant/message 每个 step 一条完整结果（已含正文），故 assistant-stream 增量忽略；
 * 策略：user/message、assistant/message 直出，tool/call、tool/result 直出，其余骨架过滤。
 * tool/result 的缺失名称经 tool/call 的 callId 关联补齐。
 */
function aggregateHistory(events: DshSessionWireEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  const nameByCall = new Map<string, string>();
  for (const ev of events) {
    const data = ev.data as Record<string, unknown> | undefined;
    switch (ev.type) {
      case 'user/message':
        if (!isSystemUserEvent(data)) out.push({ type: 'user/message', text: extractText(data) });
        break;
      case 'assistant/message':
        out.push(mapAssistantMessage(data));
        break;
      case 'tool/call': {
        const callId = data?.callId as string | undefined;
        const name = stringOf(data?.name);
        if (callId && name) nameByCall.set(callId, name);
        out.push({ type: 'tool/call', toolName: name, callId, args: data?.arguments });
        break;
      }
      case 'tool/result': {
        const msg = data?.message as Record<string, unknown> | undefined;
        const block = (Array.isArray(msg?.content) ? msg?.content[0] : undefined) as Record<string, unknown> | undefined;
        const callId = (block?.toolCallId as string | undefined) ?? (data?.callId as string | undefined);
        const error = data?.error as { code?: string } | undefined;
        out.push({
          type: 'tool/result',
          toolName: (callId ? nameByCall.get(callId) : undefined) ?? stringOf(data?.name ?? ''),
          callId,
          ok: !error && block?.isError !== true,
          summary: extractText(msg),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * 归一化 DSH user-questions 的 questions → 网关统一 AskUserQuestionItem。
 * DSH：{ id, question, detail?, header?, options?: [{ label, description? }] }
 * 网关：{ id, kind:'select'|'text', prompt, placeholder?, options?: [{ id, label, description? }] }
 * options[].id 用 label 顶替（DSH 的应答按 label 匹配，手机端回传的 selected 也是 label）。
 */
function normalizeQuestions(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q, i) => {
    const o = (q ?? {}) as Record<string, unknown>;
    const id = stringOf(o.id ?? `q${i}`);
    const header = stringOf(o.header ?? '');
    const detail = stringOf(o.detail ?? '');
    const prompt = [stringOf(o.question ?? '') || header, detail].filter(Boolean).join('\n');
    const opts = Array.isArray(o.options) ? o.options : null;
    if (opts && opts.length > 0) {
      return {
        id,
        kind: 'select' as const,
        prompt,
        options: opts.map((opt) => {
          const oo = (opt ?? {}) as Record<string, unknown>;
          const label = stringOf(oo.label ?? '');
          return { id: label, label, description: stringOf(oo.description ?? '') || undefined };
        }),
      };
    }
    return { id, kind: 'text' as const, prompt, placeholder: header || undefined };
  });
}

function toWorkspaceView(w: DshWorkspaceView): WorkspaceView {
  return {
    workspaceId: w?.workspaceId ?? '',
    path: w?.path ?? '',
    title: w?.title ?? '',
    sessionIds: w?.sessionIds ?? [],
    createdAt: w?.createdAt ?? '',
    updatedAt: w?.updatedAt ?? '',
  };
}

/** Only copy the public model-selection projection; never forward raw config. */
export function projectedModel(value: unknown): ModelRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const projection = value as { next?: unknown; lastUsed?: unknown };
  const selected = projection.next ?? projection.lastUsed;
  if (!selected || typeof selected !== 'object') return undefined;
  const m = selected as Record<string, unknown>;
  if (typeof m.provider !== 'string' || !m.provider || typeof m.model !== 'string' || !m.model) return undefined;
  return { provider: m.provider, model: m.model,
    ...(typeof m.reasoningEffort === 'string' ? { reasoningEffort: m.reasoningEffort } : {}) };
}

function stringOf(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function toError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
