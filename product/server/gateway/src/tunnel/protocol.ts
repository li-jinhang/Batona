/**
 * tunnel/protocol.ts — Batona Tunnel v1 线格式（编解码 + 常量 + 校验）
 *
 * 与 `product/pc/tunnel/protocol.js` 是**同一线格式的两份实现**（此处 TS、PC 端 CJS）。
 * 改常量或帧形状必须两处同改，由 test/tunnel-vectors.json 黄金向量双向把关。
 *
 * 线格式总览：
 *   - 控制帧 = WebSocket 文本帧（JSON，`t` 为判别式）
 *   - 数据帧 = WebSocket 二进制帧：[sid u32 BE][payload ≤ MAX_FRAME_PAYLOAD]
 *   - 方向命名以数据来源为准：c2s = 笔记本 DSH → 服务端；s2c = 服务端 → 笔记本
 *
 * 约束（tsconfig）：erasableSyntaxOnly → 不用 enum/namespace，一律 as const + 联合类型；
 *                  verbatimModuleSyntax → 类型导入必须 `import type`。
 */

// ── 常量 ───────────────────────────────────────────────────────────────────

/** WS 升级路径（与 /ws 同挂在一个 http server 上，由 upgrade 路由器分发） */
export const TUNNEL_PATH = '/tunnel';

/** 协议版本（hello/welcome 双方声明，不匹配即明确报错——吸取 DSH 协议未版本化的教训） */
export const PROTO_VERSION = 1;
export const SUPPORTED_VERSIONS: readonly number[] = [1];

/** 单帧 payload 上限 256 KiB；WS 层再留 4 倍余量防止单一巨帧吃掉内存 */
export const MAX_FRAME_PAYLOAD = 256 * 1024;
export const WS_MAX_PAYLOAD = 1 * 1024 * 1024;

/** 背压三层参数（见 stream.ts。GLOBAL_BUDGET 是硬约束，防止多流累加打爆 512MiB 堆） */
export const INITIAL_WINDOW = 256 * 1024;
export const MAX_STREAM_WINDOW = 4 * 1024 * 1024;
export const GLOBAL_BUDGET = 16 * 1024 * 1024;
export const MAX_STREAMS = 128;
export const READ_CHUNK = 64 * 1024;
export const WS_INFLIGHT_HIGH = 2 * 1024 * 1024;
export const WS_INFLIGHT_LOW = 512 * 1024;

/** 心跳：双方各 20s 发 WS ping，60s 无 pong 判死（半死 TCP 不产生 close 事件） */
export const HEARTBEAT_MS = 20_000;
export const PONG_TIMEOUT_MS = 60_000;

/** 握手与建流超时 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const OPEN_TIMEOUT_MS = 10_000;

/** sid 是 u32；0 保留为"未设置"哨兵 */
export const SID_MAX = 0xffff_ffff;

// ── 类型 ───────────────────────────────────────────────────────────────────

export type StreamDir = 'c2s' | 's2c';

export interface ClientInfo {
  app?: string;
  appVersion?: string;
  os?: string;
}

export interface HelloService {
  name: string;
  /** 仅信息/日志用途：实际端口由客户端在 open 到达时实时求值（DSH 重启会换端口） */
  localPort?: number;
}

/** 客户端 → 服务端控制帧 */
export type ClientFrame =
  | { t: 'hello'; v: number; client?: ClientInfo; services?: HelloService[] }
  | { t: 'open-result'; sid: number; ok: boolean; err?: string }
  | { t: 'close'; sid: number; half: StreamDir }
  | { t: 'reset'; sid: number; reason?: string }
  | { t: 'win'; sid: number; dir: StreamDir; n: number };

/** 服务端 → 客户端控制帧 */
export type ServerFrame =
  | {
      t: 'welcome';
      v: number;
      tunnelId: string;
      heartbeatSec: number;
      window: { initial: number; max: number; global: number };
      services: { name: string; bind: [string, number] }[];
    }
  | { t: 'open'; sid: number; service: string }
  | { t: 'close'; sid: number; half: StreamDir }
  | { t: 'reset'; sid: number; reason?: string }
  | { t: 'win'; sid: number; dir: StreamDir; n: number }
  | { t: 'error'; code: string; message: string };

/** 隧道级错误码（error 帧的 code） */
export const TUNNEL_ERROR = {
  unauthorized: 'unauthorized',
  tunnelDisabled: 'tunnel-disabled',
  versionMismatch: 'version-mismatch',
  badHello: 'bad-hello',
  bindFailed: 'bind-failed',
  superseded: 'superseded',
  protocolError: 'protocol-error',
  flowControlViolation: 'flow-control-violation',
} as const;

export type TunnelErrorCode = (typeof TUNNEL_ERROR)[keyof typeof TUNNEL_ERROR];

/** 流级错误（open-result.err / reset.reason 的取值） */
export const STREAM_ERROR = {
  connectRefused: 'connect-refused',
  connectFailed: 'connect-failed',
  openTimeout: 'open-timeout',
  unknownService: 'unknown-service',
  tooManyStreams: 'too-many-streams',
  duplicateSid: 'duplicate-sid',
  localClosed: 'local-closed',
  peerReset: 'peer-reset',
  sessionClosed: 'session-closed',
} as const;

export type StreamErrorCode = (typeof STREAM_ERROR)[keyof typeof STREAM_ERROR];

// ── 校验原语 ───────────────────────────────────────────────────────────────

export function isValidSid(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= SID_MAX;
}

/** win 帧的 n：正整数且不超过单流窗口上限（防止对端用巨量信用诱导缓冲膨胀） */
export function isValidWindow(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_STREAM_WINDOW;
}

export function isStreamDir(v: unknown): v is StreamDir {
  return v === 'c2s' || v === 's2c';
}

// ── 数据帧（二进制）────────────────────────────────────────────────────────

/** [sid u32 BE][payload] */
export function encodeDataFrame(sid: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(sid >>> 0, 0);
  payload.copy(out, 4);
  return out;
}

/** 解析数据帧；长度不足或 sid 非法返回 null（调用方按"未知/非法帧"处理） */
export function decodeDataFrame(buf: Buffer): { sid: number; payload: Buffer } | null {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const sid = buf.readUInt32BE(0);
  if (!isValidSid(sid)) return null;
  return { sid, payload: buf.subarray(4) };
}

// ── 控制帧（文本 JSON）─────────────────────────────────────────────────────

export function encodeControl(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame);
}

/** 严格解析客户端控制帧；形状不符返回 null（调用方按 protocol-error 处理） */
export function parseClientFrame(text: string): ClientFrame | null {
  const o = parseObject(text);
  if (!o) return null;
  switch (o.t) {
    case 'hello': {
      const v = o.v;
      if (typeof v !== 'number') return null;
      const client = isPlainObject(o.client)
        ? {
            app: strOrUndef(o.client.app),
            appVersion: strOrUndef(o.client.appVersion),
            os: strOrUndef(o.client.os),
          }
        : undefined;
      let services: HelloService[] | undefined;
      if (o.services !== undefined) {
        if (!Array.isArray(o.services)) return null;
        services = [];
        for (const s of o.services) {
          if (!isPlainObject(s) || typeof s.name !== 'string' || !s.name) return null;
          services.push({
            name: s.name,
            localPort: typeof s.localPort === 'number' && Number.isInteger(s.localPort) ? s.localPort : undefined,
          });
        }
      }
      return { t: 'hello', v, client, services };
    }
    case 'open-result': {
      if (!isValidSid(o.sid) || typeof o.ok !== 'boolean') return null;
      return { t: 'open-result', sid: o.sid, ok: o.ok, err: strOrUndef(o.err) };
    }
    case 'close': {
      if (!isValidSid(o.sid) || !isStreamDir(o.half)) return null;
      return { t: 'close', sid: o.sid, half: o.half };
    }
    case 'reset': {
      if (!isValidSid(o.sid)) return null;
      return { t: 'reset', sid: o.sid, reason: strOrUndef(o.reason) };
    }
    case 'win': {
      if (!isValidSid(o.sid) || !isStreamDir(o.dir) || !isValidWindow(o.n)) return null;
      return { t: 'win', sid: o.sid, dir: o.dir, n: o.n };
    }
    default:
      return null;
  }
}

/** 严格解析服务端控制帧（PC 端使用） */
export function parseServerFrame(text: string): ServerFrame | null {
  const o = parseObject(text);
  if (!o) return null;
  switch (o.t) {
    case 'welcome': {
      if (typeof o.v !== 'number' || typeof o.tunnelId !== 'string') return null;
      const w = o.window;
      if (!isPlainObject(w) || typeof w.initial !== 'number' || typeof w.max !== 'number' || typeof w.global !== 'number') return null;
      if (!Array.isArray(o.services)) return null;
      const services: { name: string; bind: [string, number] }[] = [];
      for (const s of o.services) {
        if (!isPlainObject(s) || typeof s.name !== 'string' || !Array.isArray(s.bind) || s.bind.length !== 2) return null;
        const [host, port] = s.bind as [unknown, unknown];
        if (typeof host !== 'string' || typeof port !== 'number' || !Number.isInteger(port)) return null;
        services.push({ name: s.name, bind: [host, port] });
      }
      return {
        t: 'welcome',
        v: o.v,
        tunnelId: o.tunnelId,
        heartbeatSec: typeof o.heartbeatSec === 'number' ? o.heartbeatSec : HEARTBEAT_MS / 1000,
        window: { initial: w.initial, max: w.max, global: w.global },
        services,
      };
    }
    case 'open': {
      if (!isValidSid(o.sid) || typeof o.service !== 'string' || !o.service) return null;
      return { t: 'open', sid: o.sid, service: o.service };
    }
    case 'close': {
      if (!isValidSid(o.sid) || !isStreamDir(o.half)) return null;
      return { t: 'close', sid: o.sid, half: o.half };
    }
    case 'reset': {
      if (!isValidSid(o.sid)) return null;
      return { t: 'reset', sid: o.sid, reason: strOrUndef(o.reason) };
    }
    case 'win': {
      if (!isValidSid(o.sid) || !isStreamDir(o.dir) || !isValidWindow(o.n)) return null;
      return { t: 'win', sid: o.sid, dir: o.dir, n: o.n };
    }
    case 'error': {
      if (typeof o.code !== 'string' || typeof o.message !== 'string') return null;
      return { t: 'error', code: o.code, message: o.message };
    }
    default:
      return null;
  }
}

// ── 内部工具 ───────────────────────────────────────────────────────────────

function parseObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64 * 1024) return null;
  try {
    const o = JSON.parse(text) as unknown;
    return isPlainObject(o) && typeof o.t === 'string' ? o : null;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
