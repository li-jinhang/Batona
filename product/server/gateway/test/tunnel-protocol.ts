/**
 * test/tunnel-protocol.ts — 隧道协议黄金向量测试（网关侧）
 *
 * 与 product/pc/test/tunnel-protocol.test.js 消费同一份 tunnel-vectors.json：
 * 两份实现（protocol.ts / protocol.js）必须对每一组向量给出相同结果。
 *
 * 运行：node test/tunnel-protocol.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as P from '../src/tunnel/protocol.ts';

const HERE = resolve(import.meta.dirname);
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name} ${detail}`); }
}

interface Vectors {
  constants: Record<string, number | string>;
  errorCodes: { tunnel: Record<string, string>; stream: Record<string, string> };
  dataFrames: { why: string; sid: number; payloadHex: string; frameHex: string }[];
  dataFrameInvalid: { why: string; frameHex: string }[];
  controlValid: { dir: 'c2s' | 's2c'; why: string; text: string; expect: unknown }[];
  controlInvalid: { dir: 'c2s' | 's2c'; why: string; text: string }[];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function main(): void {
  const vectors = JSON.parse(readFileSync(resolve(HERE, 'tunnel-vectors.json'), 'utf8')) as Vectors;

  // ── 常量一致性（两侧实现 + 向量三方对齐）────────────────────────────
  const constMap: Record<string, number | string | readonly number[]> = {
    TUNNEL_PATH: P.TUNNEL_PATH,
    PROTO_VERSION: P.PROTO_VERSION,
    MAX_FRAME_PAYLOAD: P.MAX_FRAME_PAYLOAD,
    WS_MAX_PAYLOAD: P.WS_MAX_PAYLOAD,
    INITIAL_WINDOW: P.INITIAL_WINDOW,
    MAX_STREAM_WINDOW: P.MAX_STREAM_WINDOW,
    GLOBAL_BUDGET: P.GLOBAL_BUDGET,
    MAX_STREAMS: P.MAX_STREAMS,
    READ_CHUNK: P.READ_CHUNK,
    WS_INFLIGHT_HIGH: P.WS_INFLIGHT_HIGH,
    WS_INFLIGHT_LOW: P.WS_INFLIGHT_LOW,
    HEARTBEAT_MS: P.HEARTBEAT_MS,
    PONG_TIMEOUT_MS: P.PONG_TIMEOUT_MS,
    HANDSHAKE_TIMEOUT_MS: P.HANDSHAKE_TIMEOUT_MS,
    OPEN_TIMEOUT_MS: P.OPEN_TIMEOUT_MS,
    SID_MAX: P.SID_MAX,
  };
  for (const [k, v] of Object.entries(vectors.constants)) {
    check(`常量 ${k}=${String(v)}`, constMap[k] === v, `实现值 ${String(constMap[k])}`);
  }
  check('协议版本在支持集内', P.SUPPORTED_VERSIONS.includes(vectors.constants.PROTO_VERSION as number));

  // ── 错误码表 ────────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(vectors.errorCodes.tunnel)) {
    check(`隧道错误码 ${k}`, (P.TUNNEL_ERROR as Record<string, string>)[k] === v);
  }
  for (const [k, v] of Object.entries(vectors.errorCodes.stream)) {
    check(`流错误码 ${k}`, (P.STREAM_ERROR as Record<string, string>)[k] === v);
  }

  // ── 数据帧 ──────────────────────────────────────────────────────────
  for (const c of vectors.dataFrames) {
    const payload = Buffer.from(c.payloadHex, 'hex');
    const frame = P.encodeDataFrame(c.sid, payload);
    check(`数据帧编码 sid=${c.sid} (${c.why})`, frame.toString('hex') === c.frameHex, `${frame.toString('hex')} != ${c.frameHex}`);
    const back = P.decodeDataFrame(Buffer.from(c.frameHex, 'hex'));
    check(
      `数据帧解码 sid=${c.sid} (${c.why})`,
      back !== null && back.sid === c.sid && back.payload.toString('hex') === c.payloadHex,
      JSON.stringify(back === null ? null : { sid: back.sid, hex: back.payload.toString('hex') }),
    );
  }
  for (const c of vectors.dataFrameInvalid) {
    check(`非法数据帧拒绝 (${c.why})`, P.decodeDataFrame(Buffer.from(c.frameHex, 'hex')) === null);
  }

  // ── 控制帧 ──────────────────────────────────────────────────────────
  for (const c of vectors.controlValid) {
    const parsed = c.dir === 'c2s' ? P.parseClientFrame(c.text) : P.parseServerFrame(c.text);
    // 归一化 undefined（parse 结果里可选的字段视为"不存在"）
    const normalized = parsed === null ? null : (JSON.parse(JSON.stringify(parsed)) as unknown);
    check(`控制帧 ${c.dir} 解析 (${c.why})`, deepEqual(normalized, c.expect), JSON.stringify(normalized));
  }
  for (const c of vectors.controlInvalid) {
    const parsed = c.dir === 'c2s' ? P.parseClientFrame(c.text) : P.parseServerFrame(c.text);
    check(`非法控制帧拒绝 ${c.dir} (${c.why})`, parsed === null, JSON.stringify(parsed));
  }

  // ── 编码往返 ────────────────────────────────────────────────────────
  const roundTrip = P.encodeControl({
    t: 'open',
    sid: 42,
    service: 'dsh',
  });
  check('encodeControl 往返', deepEqual(P.parseServerFrame(roundTrip), { t: 'open', sid: 42, service: 'dsh' }), roundTrip);

  console.log(`\n[tunnel-protocol] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
