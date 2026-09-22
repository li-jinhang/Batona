/**
 * tunnel/protocol.js — Batona PC Tunnel v1 线格式（PC 端 CJS 实现）
 *
 * ⚠️ 与 `product/server/gateway/src/tunnel/protocol.ts` 是**同一线格式的两份实现**。
 *    改常量或帧形状必须两处同改；两侧一致性由 `test/tunnel-vectors.json` 黄金向量把关
 *    （网关侧 test/tunnel-protocol.ts、PC 侧 test/tunnel-protocol.test.js 共同消费）。
 *
 * 线格式总览：
 *   - 控制帧 = WebSocket 文本帧（JSON，`t` 为判别式）
 *   - 数据帧 = WebSocket 二进制帧：[sid u32 BE][payload ≤ MAX_FRAME_PAYLOAD]
 *   - 方向命名以数据来源为准：c2s = 笔记本 DSH → 服务端；s2c = 服务端 → 笔记本
 */

'use strict';

// ── 常量 ───────────────────────────────────────────────────────────────────

const TUNNEL_PATH = '/tunnel';

const PROTO_VERSION = 1;
const SUPPORTED_VERSIONS = [1];

const MAX_FRAME_PAYLOAD = 256 * 1024;
const WS_MAX_PAYLOAD = 1 * 1024 * 1024;

const INITIAL_WINDOW = 256 * 1024;
const MAX_STREAM_WINDOW = 4 * 1024 * 1024;
const GLOBAL_BUDGET = 16 * 1024 * 1024;
const MAX_STREAMS = 128;
const READ_CHUNK = 64 * 1024;
const WS_INFLIGHT_HIGH = 2 * 1024 * 1024;
const WS_INFLIGHT_LOW = 512 * 1024;

const HEARTBEAT_MS = 20000;
const PONG_TIMEOUT_MS = 60000;

const HANDSHAKE_TIMEOUT_MS = 10000;
const OPEN_TIMEOUT_MS = 10000;

const SID_MAX = 0xffffffff;

// 隧道级错误码（与网关 TUNNEL_ERROR 同值）
const TUNNEL_ERROR = {
  unauthorized: 'unauthorized',
  tunnelDisabled: 'tunnel-disabled',
  versionMismatch: 'version-mismatch',
  badHello: 'bad-hello',
  bindFailed: 'bind-failed',
  superseded: 'superseded',
  protocolError: 'protocol-error',
  flowControlViolation: 'flow-control-violation',
};

// 流级错误
const STREAM_ERROR = {
  connectRefused: 'connect-refused',
  connectFailed: 'connect-failed',
  openTimeout: 'open-timeout',
  unknownService: 'unknown-service',
  tooManyStreams: 'too-many-streams',
  duplicateSid: 'duplicate-sid',
  localClosed: 'local-closed',
  peerReset: 'peer-reset',
  sessionClosed: 'session-closed',
};

// ── 校验原语 ───────────────────────────────────────────────────────────────

function isValidSid(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= SID_MAX;
}

function isValidWindow(n) {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_STREAM_WINDOW;
}

function isStreamDir(v) {
  return v === 'c2s' || v === 's2c';
}

// ── 数据帧（二进制）────────────────────────────────────────────────────────

function encodeDataFrame(sid, payload) {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(sid >>> 0, 0);
  payload.copy(out, 4);
  return out;
}

function decodeDataFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const sid = buf.readUInt32BE(0);
  if (!isValidSid(sid)) return null;
  return { sid, payload: buf.subarray(4) };
}

// ── 控制帧（文本 JSON）─────────────────────────────────────────────────────

function encodeControl(frame) {
  return JSON.stringify(frame);
}

/** 解析服务端 → 客户端控制帧（PC 端主用） */
function parseServerFrame(text) {
  const o = parseObject(text);
  if (!o) return null;
  switch (o.t) {
    case 'welcome': {
      if (typeof o.v !== 'number' || typeof o.tunnelId !== 'string') return null;
      const w = o.window;
      if (!isPlainObject(w) || typeof w.initial !== 'number' || typeof w.max !== 'number' || typeof w.global !== 'number') return null;
      if (!Array.isArray(o.services)) return null;
      const services = [];
      for (const s of o.services) {
        if (!isPlainObject(s) || typeof s.name !== 'string' || !Array.isArray(s.bind) || s.bind.length !== 2) return null;
        const host = s.bind[0];
        const port = s.bind[1];
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

/** 解析客户端 → 服务端控制帧（向量一致性测试用；网关侧为权威实现） */
function parseClientFrame(text) {
  const o = parseObject(text);
  if (!o) return null;
  switch (o.t) {
    case 'hello': {
      const v = o.v;
      if (typeof v !== 'number') return null;
      const client = isPlainObject(o.client)
        ? { app: strOrUndef(o.client.app), appVersion: strOrUndef(o.client.appVersion), os: strOrUndef(o.client.os) }
        : undefined;
      let services;
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

// ── 内部工具 ───────────────────────────────────────────────────────────────

function parseObject(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64 * 1024) return null;
  try {
    const o = JSON.parse(text);
    return isPlainObject(o) && typeof o.t === 'string' ? o : null;
  } catch (_) {
    return null;
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrUndef(v) {
  return typeof v === 'string' ? v : undefined;
}

module.exports = {
  // 常量
  TUNNEL_PATH,
  PROTO_VERSION,
  SUPPORTED_VERSIONS,
  MAX_FRAME_PAYLOAD,
  WS_MAX_PAYLOAD,
  INITIAL_WINDOW,
  MAX_STREAM_WINDOW,
  GLOBAL_BUDGET,
  MAX_STREAMS,
  READ_CHUNK,
  WS_INFLIGHT_HIGH,
  WS_INFLIGHT_LOW,
  HEARTBEAT_MS,
  PONG_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  OPEN_TIMEOUT_MS,
  SID_MAX,
  TUNNEL_ERROR,
  STREAM_ERROR,
  // 校验
  isValidSid,
  isValidWindow,
  isStreamDir,
  // 编解码
  encodeDataFrame,
  decodeDataFrame,
  encodeControl,
  parseServerFrame,
  parseClientFrame,
};
