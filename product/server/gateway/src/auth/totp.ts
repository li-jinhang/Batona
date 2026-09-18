/**
 * auth/totp.ts — RFC 6238 TOTP（HMAC-SHA1，30s 步长，6 位）
 * 零依赖实现（node:crypto），与标准 Authenticator App（Google/Microsoft/1Password）兼容。
 */

import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 生成随机 base32 密钥（默认 20 字节 = 160bit，标准强度） */
export function generateSecret(bytes = 20): string {
  return toBase32(randomBytes(bytes));
}

/** 计算指定时间片（默认当前时间）的 6 位动态码 */
export function totp(secretBase32: string, atMs: number = Date.now(), digits = 6, periodSec = 30): string {
  const counter = Math.floor(atMs / 1000 / periodSec);
  const key = fromBase32(secretBase32.replace(/\s+/g, ''));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

/** 校验动态码（允许 ±1 时间片漂移，防时钟偏差） */
export function verifyTotp(secretBase32: string, code: string, atMs: number = Date.now(), window = 1): boolean {
  const clean = code.trim();
  for (let w = -window; w <= window; w++) {
    if (totp(secretBase32, atMs + w * 30_000) === clean) return true;
  }
  return false;
}

/** 生成 otpauth:// URI（供二维码/手动录入） */
export function otpauthUri(secretBase32: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
