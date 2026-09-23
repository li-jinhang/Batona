/**
 * adapter/contract.ts — AgentAdapter 统一契约（核心扩展点，FR-31/FR-51/FR-52）
 *
 * 事件模型与 DSH 官方一致：**事件驱动**（后端 → 网关经 onEvent 订阅推送，
 * 应答经 respond() 继续，后续事件继续推送），而非迭代器式。
 * AgentEvent 词汇以 DSH 官方 SessionEvent 为准（见 dsh-host-apiproxy / dsh-session），
 * 其他后端的差异在适配器内部归一化。
 */

/** 会话状态（手机端可感知） */
export type SessionState =
  | 'idle'        // 已创建，未运行
  | 'running'     // 回合执行中
  | 'waiting-approval'  // 等待工具调用审批
  | 'waiting-question'  // 等待回答提问
  | 'done'        // 回合完成
  | 'error';

/** 后端会话引用（网关 session 路由的 value 部分） */
export interface AgentSessionRef {
  backend: string;          // 适配器 id
  backendSessionId: string; // 后端原生会话 id
  title?: string;
  model?: ModelRef;
  state: SessionState;
  createdAt: number;
}

/** 对话内容 part（与 DSH PromptContentPart 对齐：文本 + base64 图片） */
export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string };

/** 归一化 agent 事件（网关对外推送词汇，对齐 DSH SessionEvent） */
export type AgentEvent =
  | { type: 'user/message'; text: string }
  | { type: 'assistant/message'; text: string; reasoning?: string }
  | { type: 'assistant/chunk'; text: string; reasoning?: string }
  | { type: 'tool/call'; toolName: string; callId?: string; args?: unknown }
  | { type: 'tool/result'; toolName: string; callId?: string; ok: boolean; summary?: string }
  | { type: 'turn/start' } | { type: 'turn/end' }
  | { type: 'step/start' } | { type: 'step/end' }
  | { type: 'approval/requested'; approvalId: string; toolName: string; callId?: string; reason?: string; rpcId?: string }
  | { type: 'approval/resolved'; approvalId: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' }
  | { type: 'question/requested'; questionRpcId: string; questions: AskUserQuestionItem[]; rpcId?: string }
  | { type: 'question/resolved'; questionRpcId: string; outcome: 'answered' | 'cancelled' }
  | { type: 'session/title'; title: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

/** 提问项（对齐 dsh-user-questions AskUserQuestionItem） */
export interface AskUserQuestionItem {
  id: string;
  kind: 'text' | 'select' | 'confirm';
  prompt: string;
  placeholder?: string;
  /** 输入框是否必须遮蔽；例如 Codex request_user_input 的 isSecret。 */
  isSecret?: boolean;
  options?: { id: string; label: string; description?: string }[];
}

/** 创建会话选项 */
export interface CreateSessionOpts {
  agentPreset?: string;   // DSH agent 预设（code / standard / minimal…）
  title?: string;
  workspacePath?: string; // DSH 工作区目录（可选）
  workspaceId?: string;   // DSH 工作区 id（归属到某工作区，可选）
  model?: { provider: string; model: string; reasoningEffort?: string };
}

/** PC 端定义、手机仅可选择的固定权限档。 */
export interface AgentProfile {
  id: string;
  label: string;
  description: string;
  available: boolean;
}

/** 适配器能力声明（网关据此路由 workspace.* / model.* / respond） */
export interface AdapterCapabilities {
  text: boolean;
  images: boolean;
  approvals: boolean;      // 是否产生 approval/requested 且可应答
  questions: boolean;      // 是否产生 question/requested 且可应答
  resume: boolean;         // 是否支持恢复历史会话
  workspace: boolean;      // 是否提供工作区管理（workspace.*）
  models: boolean;         // 是否提供模型目录与选择（model.*）
  permissionProfiles: boolean; // 是否提供由 PC 校验的固定权限档
  concurrency: 'single' | 'queue' | 'parallel';
  voice: 'none' | 'forward'; // v2 语音：agent 不感知，网关模态层透传
}

/** 适配器配置（网关 secrets/配置层持有） */
export interface AdapterConfig {
  [key: string]: unknown;
}

/** 模型目录条目 */
export interface ModelRef {
  provider: string;
  model: string;
  reasoningEffort?: string;
  displayName?: string;
}

/** 工作区视图（对齐 DSH WorkspaceView 的网关投影） */
export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** 统一契约：一个后端 agent 的接入面（事件驱动） */
export interface AgentAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;

  /** 建立与后端的连接（幂等） */
  connect(cfg: AdapterConfig): Promise<boolean>;

  /**
   * 订阅后端会话事件（归一化 AgentEvent）。
   * @returns 取消订阅函数
   */
  onEvent(listener: (backendSessionId: string, event: AgentEvent) => void): () => void;

  listSessions(): Promise<AgentSessionRef[]>;
  createSession(opts: CreateSessionOpts): Promise<AgentSessionRef>;
  /** 恢复历史会话（capabilities.resume 为 false 时返回 not-implemented） */
  resumeSession(backendSessionId: string): Promise<AgentSessionRef>;

  /** 触发回合；结果与中间事件经 onEvent 推送（含 approval/requested 等可应答帧） */
  prompt(session: AgentSessionRef, parts: PromptPart[], opts?: { queueAction?: 'prompt' | 'steer' | 'queue'; agentPreset?: string }): Promise<void>;

  /**
   * 应答 server-request（审批 / 提问）；后续事件继续经 onEvent 推送。
   * @param serverRequestRpcId 事件帧携带的 rpcId（approval/requested 或 question/requested 的 rpcId 字段）
   */
  respond(session: AgentSessionRef, serverRequestRpcId: string, payload: unknown): Promise<void>;

  /** 取消当前回合 / 排队项 */
  cancel(session: AgentSessionRef, itemId?: string): Promise<void>;

  /** 读取会话历史（归一化 AgentEvent；可选，capabilities.resume 为 true 时建议实现） */
  history?(session: AgentSessionRef, opts?: { beforeSeq?: number; limit?: number }): Promise<AgentEvent[]>;

  /** 以下为可选能力方法（capabilities 声明为 false 时网关不路由） */
  listWorkspaces?(): Promise<WorkspaceView[]>;
  createWorkspace?(path: string): Promise<{ workspace: WorkspaceView; created: boolean }>;
  /** 删除工作区（DSH：workspace.delete，仅取消注册，目录/数据保留） */
  deleteWorkspace?(workspaceId: string): Promise<void>;
  /** 归档会话（DSH：workspace.archiveSession，从分组表面隐藏） */
  archiveSession?(sessionId: string): Promise<void>;
  /**
   * 工作区树：一次返回"工作区→会话"层级（网关聚合 listWorkspaces + listSessions）。
   * 可选；缺省时路由层用 listWorkspaces/listSessions 组装。
   */
  workspaceTree?(): Promise<WorkspaceTree>;
  listModels?(): Promise<ModelRef[]>;
  selectModel?(session: AgentSessionRef, model: ModelRef): Promise<void>;
  listPermissionProfiles?(): Promise<AgentProfile[]>;
  /** Codex Desktop 的原生权限菜单；其它后端不提供此能力。 */
  permissionMenu?(session: AgentSessionRef, open: boolean): Promise<{ profileId?: string | null }>;
  selectPermission?(session: AgentSessionRef, profileId: string): Promise<{ profileId: string }>;
  /** 重命名会话（DSH：session.rename，标题以 session/title 事件持久化） */
  renameSession?(session: AgentSessionRef, title: string): Promise<{ title: string }>;

  /**
   * 可选：运行期注入/轮换后端凭证并重建连接。
   * 目前只有 DSH 需要——0.1.2+ 每个进程随机生成 launch token 且不落盘，
   * 只能由 PC 端在启动后上报给网关（见 server/http.ts 的 /api/dsh/launch-token）。
   */
  setAuthToken?(token: string): Promise<void>;

  dispose(): Promise<void>;
}

/** 工作区树（手机端工作区→会话层级展示） */
export interface WorkspaceTree {
  items: {
    workspace: { workspaceId: string; path: string; title: string; createdAt: string };
    sessions: { sessionId: string; title?: string; state: SessionState; updatedAt: number }[];
  }[];
}
