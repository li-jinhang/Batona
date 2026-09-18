/**
 * proto/envelope.ts — 网关对外前端协议 v1
 *
 * 四象限 RPC 信封，形状与 DSH 官方消息模型（dsh-host-apiproxy/api/rpc）对齐：
 *   - client-request  → 客户端发起调用（本网关走单条 WebSocket 全双工）
 *   - server-response → 对 client-request 的应答（rpcId 回显）
 *   - server-request  → 网关主动推送（事件 / 审批 / 提问 / 语音输出）
 *   - client-response → 对 server-request 的应答（审批 / 提问）
 *
 * rpcId 由发起方铸造 UUID，响应回显、绝不新铸；审批/提问帧的 rpcId 为稳定逻辑 id。
 * 协议版本：PROTO_VERSION=1；握手或 auth.hello 时声明，网关侧做兼容矩阵。
 */

/** rpcId：发起方铸造的 UUID（branded string） */
export type RpcId = string & { readonly __rpcId: unique symbol };

export function RpcId(id: string): RpcId {
  return id as RpcId;
}

export function newRpcId(): RpcId {
  return RpcId(crypto.randomUUID());
}

/** 客户端 → 网关：调用 */
export interface ClientRequest<P = unknown> {
  type: 'client-request';
  rpcId: RpcId;
  method: string;
  payload: P;
}

/** 网关 → 客户端：调用应答（rpcId 回显） */
export interface ServerResponse<T = unknown> {
  type: 'server-response';
  rpcId: RpcId;
  result: RpcResult<T>;
}

/** 网关 → 客户端：主动推送（可应答帧 = 审批/提问，rpcId 稳定） */
export interface ServerRequest<P = unknown> {
  type: 'server-request';
  rpcId: RpcId;
  method: string;
  payload: P;
}

/** 客户端 → 网关：对推送帧的应答（rpcId 回显） */
export interface ClientResponse<T = unknown> {
  type: 'client-response';
  rpcId: RpcId;
  result: RpcResult<T>;
}

/** 四象限消息判别联合（权威 wire 形状） */
export type RpcMessage = ClientRequest | ServerResponse | ServerRequest | ClientResponse;

/** 网关前端协议版本（兼容矩阵用） */
export const PROTO_VERSION = 1;

/** 客户端握手：声明协议版本与令牌（WebSocket 连接后首帧） */
export interface AuthHelloPayload {
  protoVersion: number;
  /** 登录令牌（HTTP POST /api/auth/login 换发，或连接 URL ?token=） */
  token?: string;
  deviceId?: string;
}

export function isRpcMessage(v: unknown): v is RpcMessage {
  return (
    typeof v === 'object' && v !== null &&
    'type' in v && typeof (v as any).type === 'string' &&
    ['client-request', 'server-response', 'server-request', 'client-response'].includes((v as any).type) &&
    'rpcId' in v && typeof (v as any).rpcId === 'string'
  );
}

// 仅类型导入提示（result 类型在 result.ts 中定义）
import type { RpcResult } from './result.ts';
