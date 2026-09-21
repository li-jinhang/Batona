/**
 * test/tunnel-protocol.test.js — 隧道协议黄金向量测试（PC 侧）
 *
 * 与网关侧 product/server/gateway/test/tunnel-protocol.ts 消费同一份向量文件：
 * 两份实现（protocol.js / protocol.ts）必须对每一组向量给出相同结果。
 *
 * 运行：node product/pc/test/tunnel-protocol.test.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const P = require('../tunnel/protocol.js');

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name} ${detail}`); }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function main() {
  const vectorsPath = path.resolve(__dirname, '../../server/gateway/test/tunnel-vectors.json');
  const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

  // ── 常量一致性 ──────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(vectors.constants)) {
    check(`常量 ${k}=${v}`, P[k] === v, `实现值 ${String(P[k])}`);
  }
  check('协议版本在支持集内', P.SUPPORTED_VERSIONS.includes(vectors.constants.PROTO_VERSION));

  // ── 错误码表 ────────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(vectors.errorCodes.tunnel)) {
    check(`隧道错误码 ${k}`, P.TUNNEL_ERROR[k] === v);
  }
  for (const [k, v] of Object.entries(vectors.errorCodes.stream)) {
    check(`流错误码 ${k}`, P.STREAM_ERROR[k] === v);
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
    const normalized = parsed === null ? null : JSON.parse(JSON.stringify(parsed));
    check(`控制帧 ${c.dir} 解析 (${c.why})`, deepEqual(normalized, c.expect), JSON.stringify(normalized));
  }
  for (const c of vectors.controlInvalid) {
    const parsed = c.dir === 'c2s' ? P.parseClientFrame(c.text) : P.parseServerFrame(c.text);
    check(`非法控制帧拒绝 ${c.dir} (${c.why})`, parsed === null, JSON.stringify(parsed));
  }

  // ── 编码往返 ────────────────────────────────────────────────────────
  const roundTrip = P.encodeControl({ t: 'open', sid: 42, service: 'dsh' });
  check('encodeControl 往返', deepEqual(P.parseServerFrame(roundTrip), { t: 'open', sid: 42, service: 'dsh' }), roundTrip);

  console.log(`\n[tunnel-protocol/pc] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
