/**
 * adapter/dsh/types.ts — DSH 0.1.2+ Typert Remote 协议类型
 *
 * 全部对齐本机 @deepseek-ai/dsh 0.1.5 的生成描述符
 * （dsh-api-session-controller / dsh-api-workspace-controller / dsh-api-gateway 的 typert.*.js）。
 *
 * 与 0.1.1 的差异（升级回归要点）：
 *   1. 端点：POST /api/<ns>/<method>（旧：/api/<ns>.<method>）；
 *   2. 信封 payload 必须是 { args: {...} }（旧：裸 payload）；
 *      HTTP 层强制 `payload` 只含一个 plain-object `args` 字段；
 *   3. args 键名 = 生成描述符里的 wire 名（如 session/list 的参数 wire 名是 `_request`，其余多为 `request`）；
 *   4. 流式方法（session/follow、workspace/follow、$events）走 WS /api/remote.mux 的
 *      逻辑流（旧：WS /api/events.mux）；
 *   5. 审批/提问经 $events 逻辑流下发（Cordis waterfall），应答走 POST /api/$events/result。
 *
 * 协议仍未版本化（无 protocolVersion 字段）——升级 DSH 后以回归脚本校验。
 */

// ── 一元调用信封 ──────────────────────────────────────────────────────

export interface DshClientRequest<P = unknown> {
  type: 'client-request';
  rpcId: string;
  method: string;
  payload: P;
}

export interface DshServerResponse<T = unknown> {
  type: 'server-response';
  rpcId: string;
  result: DshRpcResult<T>;
}

export type DshRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DshRpcError };

export interface DshRpcError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** 所有 Remote 调用的标准载荷：恰好一个 plain-object `args` 字段 */
export interface DshRemoteArgs<A = Record<string, unknown>> {
  args: A;
}

// ── /api/remote.mux 逻辑流协议 ────────────────────────────────────────

/** 客户端 → Host：开一条逻辑流 / 取消一条逻辑流 */
export type DshStreamClientMessage =
  | { type: 'open'; streamId: string; endpoint: string; payload: DshRemoteArgs }
  | { type: 'cancel'; streamId: string };

/** Host → 客户端：逻辑流帧（键集合精确匹配，多余字段会被判为非法） */
export type DshStreamServerMessage =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'error'; streamId: string; error: DshRpcError }
  | { type: 'end'; streamId: string };

// ── $events 逻辑流（Cordis 事件转发）──────────────────────────────────

/** 开流后的首帧：绑定后续 HTTP 应答到该事件代次 */
export interface DshRemoteEventReadyFrame {
  type: 'ready';
  clientId: string;
  host: { home: string };
}

/** 普通通知（mode: 'emit'），无需应答 */
export interface DshRemoteEventEmitFrame {
  type: 'emit';
  event: string;
  args: unknown[];
}

/** Agent 作用域 waterfall（mode: 'waterfall'），必须应答 */
export interface DshRemoteEventInvocationFrame {
  type: 'waterfall';
  event: string;
  eventId: string;
  agentId: string;
  request: Record<string, unknown>;
}

/** 已下发的 waterfall 被 Host 取消 */
export interface DshRemoteEventCancellationFrame {
  type: 'cancel';
  eventId: string;
}

export type DshRemoteEventFrame =
  | DshRemoteEventReadyFrame
  | DshRemoteEventEmitFrame
  | DshRemoteEventInvocationFrame
  | DshRemoteEventCancellationFrame;

/** POST /api/$events/result 的 args */
export interface DshRemoteEventResultArgs {
  clientId: string;
  eventId: string;
  outcome:
    | { kind: 'next' }
    | { kind: 'result'; value?: unknown }
    | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: unknown } };
}

// ── 会话事件（session/follow 与 session/page 共用）────────────────────

/** 一条 durably 记录的会话事件信封 */
export interface DshSessionWireEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

/** 会话日志记录（history 页与 follow 流同形） */
export interface DshSessionEventEntry {
  type: 'event';
  event: DshSessionWireEvent;
}

/** 内容块（ContentBlock 联合，merge-extensible；此处列核心成员） */
export type DshContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: unknown }
  | { type: 'file'; attachment: unknown }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: string; content: DshContentBlock[]; isError?: boolean }
  | { type: string; [k: string]: unknown };

/** 流式 assistant 呈现帧（session/follow 且 assistantStream=true 时下发） */
export type DshAssistantStreamFrame =
  | { type: 'start'; attemptId: string; revision: number; startedAfterSeq: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: Record<string, unknown> }
  | { type: 'end'; attemptId: string; revision: number; index: number; outcome: { kind: string; [k: string]: unknown } };

/** 会话事件流帧 */
export type DshSessionFollowFrame =
  | {
      type: 'snapshot';
      header: DshSessionWireHeader;
      cursor: number;
      records: DshSessionEventEntry[];
      hasMore: boolean;
      projections: { asOfSeq: number; values: Record<string, unknown> };
      assistantStream?: DshAssistantStreamBaseline;
    }
  | DshSessionEventEntry
  | { type: 'assistant-stream'; frame: DshAssistantStreamFrame };

/** 开窗时的进程内流式增量基线（revision + 进行中的 attempt 进度） */
export interface DshAssistantStreamBaseline {
  revision: number;
  activeAttempt?: { attemptId: string; nextIndex: number };
}

export interface DshSessionWireHeader {
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  isSeeded: boolean;
  origin?: 'subagent';
  agentPreset?: string;
}

/** 会话地址（普通会话；子代理地址本适配器不使用） */
export interface DshSessionAddress {
  kind: 'session';
  sessionId: string;
}

// ── session/* 请求与返回值（wire 名见各 Request 的注释）────────────────

/** session/list：args = { _request: {} } */
export interface DshSessionListRequest {
  cursor?: string;
}

export interface DshSessionListValue {
  items: DshSessionSummary[];
}

/** 会话列表条目；标题在 projections.values.{title, sessionListMetadata} */
export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: 'subagent';
  cwd?: string;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
}

/** session/create：args = { request } */
export interface DshSessionCreateRequest {
  workspaceId?: string;
  cwd?: string;
  sessionId?: string;
  agentPreset?: string;
}

export interface DshSessionCreateValue {
  sessionId: string;
  agentPreset?: string;
}

/** session/selectModel：args = { request }（Selection 平铺，非嵌套 selection） */
export interface DshSessionSelectModelRequest {
  sessionId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshSessionSelectModelValue {
  selected: { provider: string; model: string; reasoningEffort?: string };
}

/** session/prompt：args = { request }；requestId 为必填（客户端铸造的用户消息身份） */
export interface DshSessionPromptRequest {
  requestId: string;
  sessionId: string;
  mode: 'queue' | 'steer';
  content: DshPromptContentPart[];
  clientTimeZone?: string;
}

export type DshPromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; receiptId: string };

export interface DshSessionPromptValue {
  accepted: true;
}

/** session/cancel：args = { request } */
export interface DshSessionCancelRequest {
  sessionId: string;
}

/** session/rename：args = { request } */
export interface DshSessionRenameRequest {
  sessionId: string;
  title: string;
}

export interface DshSessionRenameValue {
  title: string;
  seq: number;
}

/** session/page：args = { request }；throughSeq 取自对应 follow 的开窗 cursor */
export interface DshSessionPageRequest {
  address: DshSessionAddress;
  throughSeq: number;
  beforeSeq?: number;
  maxMessages?: number;
}

export interface DshSessionPage {
  records: DshSessionEventEntry[];
  hasMore: boolean;
}

/** session/follow：args = { request }（流式） */
export interface DshSessionFollowRequest {
  address: DshSessionAddress;
  maxMessages?: number;
  assistantStream?: true;
}

/** session/modelCatalog：args = {} */
export interface DshModelCatalog {
  default: { provider: string; model: string; reasoningEffort?: string };
  routableProviders: string[];
  groups: DshModelProviderGroup[];
  failures: { id: string; name: string; message: string }[];
}

export interface DshModelProviderGroup {
  id: string;
  name: string;
  models: {
    id: string;
    name: string;
    description?: string;
    reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string };
  }[];
}

// ── workspace/* ───────────────────────────────────────────────────────

export interface DshWorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** workspace/create：args = { request } */
export interface DshWorkspaceCreateValue {
  workspace: DshWorkspaceView;
  created: boolean;
}

/** workspace/rename：args = { request: { workspaceId, title } } */
export interface DshWorkspaceRenameValue {
  workspace: DshWorkspaceView;
}

/** workspace/archiveSession：args = { request } */
export interface DshWorkspaceArchiveValue {
  archivedSessionIds: string[];
}

/** workspace/follow（流式）：每个代次先发恰好一条 baseline */
export type DshWorkspaceFollowFrame =
  | { type: 'baseline'; value: { items: DshWorkspaceView[]; archivedSessionIds: string[] } }
  | { type: 'upsert'; workspace: DshWorkspaceView }
  | { type: 'remove'; workspaceId: string }
  | { type: 'order'; workspaceIds: string[] }
  | { type: 'archived'; archivedSessionIds: string[] };

// ── 审批 / 提问（$events waterfall 载荷）──────────────────────────────

/** approval/request 的 request 字段（无 approvalId/orderId；关联 id 用 waterfall 的 eventId） */
export interface DshApprovalRequestPayload {
  toolName: string;
  callId?: string;
  reason?: string;
}

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** user-questions/request 的 request 字段 */
export interface DshAskUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  intent?: { kind: string; [k: string]: unknown };
}

export interface DshAskUserQuestionAnswer {
  answers: { id: string; selected: string[]; custom?: string }[];
}
