import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function equal(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b))); }
export class AccessError extends Error {
  status: number;
  constructor(code: string, status = 400) { super(code); this.status = status; }
}
export function required(value: unknown, min = 1, max = 256): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new AccessError('invalid-input');
  return value;
}
export interface Device { id: string; secretHash: string; name: string; lastSeen: number }
export interface Account {
  id: string; key: string; remark: string; disabled: boolean; createdAt: number;
  pc?: Device; phone?: Device; counts: [number, number][];
  countUncertainAt?: number;
}
interface Token { accountId: string; deviceId: string; kind: 'pc' | 'phone' }
interface Data { version: 1; accounts: Account[]; tokens: Record<string, Token> }

/** One authenticated, encrypted snapshot. Parse/decrypt failure is fatal, never reset to an empty account registry. */
export class AccountStore {
  private data: Data = { version: 1, accounts: [], tokens: {} };
  private file: string;
  private key: Buffer;
  now: () => number;
  constructor(dir: string, key: Buffer, now = Date.now) {
    if (key.length !== 32) throw new Error('vault-key-must-be-32-bytes');
    this.key = key; this.now = now;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'access.vault');
    if (existsSync(this.file)) {
      const bytes = readFileSync(this.file);
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      this.data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
      if (this.data.version !== 1 || !Array.isArray(this.data.accounts)) throw new Error('unsupported-access-vault');
    }
  }
  change<T>(fn: () => T): T {
    const before = structuredClone(this.data);
    try {
      const result = fn();
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
      writeFileSync(this.file + '.tmp', Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
      return result;
    } catch (e) { this.data = before; throw e; }
  }
  accounts() { return this.data.accounts; }
  account(id: string): Account {
    const a = this.data.accounts.find(a => a.id === id);
    if (!a) throw new AccessError('account-not-found', 404);
    return a;
  }
  create(remark: string): Account {
    const a: Account = { id: randomUUID(), key: 'batona_' + secret(), remark, disabled: false, createdAt: this.now(), counts: [] };
    this.data.accounts.push(a); return a;
  }
  revoke(a: Account, kind?: Token['kind']) {
    for (const [key, token] of Object.entries(this.data.tokens)) {
      if (token.accountId === a.id && (!kind || token.kind === kind)) delete this.data.tokens[key];
    }
  }
  remove(a: Account) { this.revoke(a); this.data.accounts = this.data.accounts.filter(x => x.id !== a.id); }
  issue(a: Account, kind: Token['kind']): string {
    this.revoke(a, kind);
    const token = secret();
    this.data.tokens[digest(token)] = { accountId: a.id, deviceId: a[kind]!.id, kind };
    return token;
  }
  validate(token: string, kind?: Token['kind']): { account: Account; device: Device; kind: Token['kind'] } | null {
    const entry = this.data.tokens[digest(token)];
    if (!entry || (kind && entry.kind !== kind)) return null;
    const a = this.data.accounts.find(a => a.id === entry.accountId);
    const d = a?.[entry.kind];
    return a && !a.disabled && d?.id === entry.deviceId ? { account: a, device: d, kind: entry.kind } : null;
  }
  login(key: string, deviceSecret: string, name: string, replace: boolean) {
    const a = this.data.accounts.find(a => equal(a.key, key));
    if (!a || a.disabled) throw new AccessError('invalid-credentials', 401);
    const hash = digest(deviceSecret);
    if (a.pc && a.pc.secretHash !== hash) {
      if (!replace) throw new AccessError('replace-confirmation-required', 409);
      this.revoke(a); delete a.pc; delete a.phone;
    }
    a.pc ??= { id: randomUUID(), secretHash: hash, name, lastSeen: this.now() };
    a.pc.name = name; a.pc.lastSeen = this.now();
    return { accountId: a.id, deviceId: a.pc.id, token: this.issue(a, 'pc') };
  }
  summary(a: Account) {
    return { id: a.id, remark: a.remark, disabled: a.disabled, createdAt: a.createdAt,
      requests24h: a.countUncertainAt !== undefined && a.countUncertainAt > this.now() - 86400000 ? null : a.counts.filter(([time]) => time > this.now() - 86400000).reduce((n, [, c]) => n + c, 0) };
  }
  count(id: string) {
    // An already accepted Agent request must never be reported as rejected by a statistics write failure.
    if (!this.data.accounts.some(a => a.id === id)) return;
    try { this.change(() => {
      const a = this.account(id), now = this.now();
      a.counts = a.counts.filter(([t]) => t > now - 86400000);
      const last = a.counts.at(-1);
      if (last?.[0] === now) last[1]++; else a.counts.push([now, 1]);
    }); } catch {
      this.account(id).countUncertainAt = this.now(); // Retained by the next successful snapshot write.
      console.error('[access] request-count-unavailable: storage write failed');
    }
  }
  prune() {
    if (this.data.accounts.some(a => a.counts.some(([t]) => t <= this.now() - 86400000))) {
      this.change(() => { for (const a of this.data.accounts) a.counts = a.counts.filter(([t]) => t > this.now() - 86400000); });
    }
  }
}
