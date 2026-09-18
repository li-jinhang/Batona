/**
 * proto/result.ts — RpcResult / RpcError（对齐 DSH 官方错误模型）
 *
 * 错误码 = DSH 官方封闭联合（见设计文档附录 C）+ 网关自有扩展码。
 * 业务方法永不 throw：一律返回 RpcResult。
 */

/** DSH 官方错误码（dsh-host-apiproxy api/rpc） */
export type DshErrorCode =
  | 'bad-request' | 'cancelled' | 'session-not-found' | 'model-unavailable' | 'session-conflict'
  | 'invalid-time-zone' | 'workspace-attach-failed' | 'workspace-not-found' | 'workspace-invalid-path'
  | 'workspace-name-conflict' | 'workspace-move-invalid' | 'directory-unreadable' | 'directory-exists'
  | 'directory-create-failed' | 'directory-picker-unavailable' | 'agent-preset-read-only'
  | 'agent-preset-locked' | 'agent-preset-conflict' | 'agent-preset-not-found' | 'agent-preset-invalid'
  | 'agent-busy' | 'attachment-error' | 'queue-item-not-found' | 'steer-unavailable' | 'command-error'
  | 'unknown-command' | 'settings-rejected' | 'settings-conflict' | 'credential-rejected'
  | 'model-discovery-failed' | 'title-invalid' | 'fork-unavailable' | 'subagent-parent-unavailable'
  | 'subagent-not-found' | 'subagent-catalog-diagnostic' | 'subagent-not-resumable'
  | 'subagent-unauthorized' | 'subagent-delivery-unavailable' | 'internal';

/** 网关自有扩展错误码 */
export type GatewayErrorCode =
  | 'unauthorized'      // 未认证 / 令牌无效
  | 'auth-required'     // 需要先 auth.hello
  | 'totp-required'     // 需要 TOTP 二次验证
  | 'totp-invalid'
  | 'device-not-registered'
  | 'rate-limited'
  | 'adapter-not-found' // 请求的后端适配器不存在
  | 'capability-missing'// 后端不具备该能力（如 workspace/models）
  | 'method-not-found'
  | 'not-implemented'
  | 'backend-unavailable'
  | 'session-busy'
  | 'conflict';

export type RpcErrorCode = DshErrorCode | GatewayErrorCode;

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError };

export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

export function err(code: RpcErrorCode, message: string, details: Record<string, unknown> = {}): RpcResult<never> {
  return { ok: false, error: { code, message, details } };
}

/** 把抛出值折叠为 RpcResult（与 DSH transportError 同思路） */
export function foldError<T>(error: unknown): RpcResult<T> {
  if (isRpcError(error)) return { ok: false, error };
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}

export function isRpcError(v: unknown): v is RpcError {
  return (
    typeof v === 'object' && v !== null &&
    'code' in v && typeof (v as any).code === 'string' &&
    'message' in v && typeof (v as any).message === 'string'
  );
}

export function isOk<T>(r: RpcResult<T>): r is { ok: true; value: T } {
  return r.ok;
}
