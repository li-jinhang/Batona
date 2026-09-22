/**
 * auth/index.ts — 认证服务
 *
 * - 账号存储：data/auth.json（scrypt 密码哈希 + TOTP 密钥）
 * - 登录：密码 →（若已启用 TOTP）→ TOTP → 签发随机令牌（存哈希）
 * - 设备注册：登录成功自动注册设备；可吊销
 * - 限速：按 IP 滑动窗口（login 失败 5 次/分钟 触发延迟）
 *
 * 安全属性：令牌随机 32 字节；服务端只存 sha256(令牌)；HttpOnly Cookie 由 HTTP 层设置。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateSecret, verifyTotp, otpauthUri } from './totp.ts';

const scrypt = promisify(scryptCb) as (p: string, s: string, k: number) => Promise<Buffer>;

export interface AuthConfig {
  /** 初始账号（首次启动写入） */
  initialUser?: { username: string; password: string };
}

interface StoredUser {
  username: string;
  salt: string;
  hash: string;          // scrypt hash（hex）
  totpSecret?: string;   // 已启用 TOTP 时的密钥
  createdAt: number;
}

interface Device {
  deviceId: string;
  name: string;
  registeredAt: number;
  revoked: boolean;
}

interface AuthStore {
  users: StoredUser[];
  devices: Device[];
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  token?: string;
  deviceId?: string;
  totpRequired?: boolean;
  otpauthUri?: string; // 首次登录且未启用 TOTP 时返回，供绑定
}

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const MAX_FAILS = 5;
const WINDOW_MS = 60_000;

export class AuthService {
  private store: AuthStore;
  private storePath: string;
  private tokensPath: string;
  private tokens = new Map<string, { deviceId: string; expiresAt: number }>();
  private fails = new Map<string, number[]>(); // ip → timestamps

  constructor(dataDir: string, cfg: AuthConfig = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.storePath = `${dataDir}/auth.json`;
    this.tokensPath = `${dataDir}/tokens.json`;
    this.store = this.load();
    this.tokens = this.loadTokens();
    if (this.store.users.length === 0 && cfg.initialUser) {
      this.upsertUser(cfg.initialUser.username, cfg.initialUser.password, undefined);
      this.save();
    }
  }

  private load(): AuthStore {
    if (existsSync(this.storePath)) {
      try {
        return JSON.parse(readFileSync(this.storePath, 'utf8')) as AuthStore;
      } catch { /* fallthrough */ }
    }
    return { users: [], devices: [] };
  }

  private save(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf8');
  }

  /** token 持久化（重启不失效）：data/tokens.json */
  private loadTokens(): Map<string, { deviceId: string; expiresAt: number }> {
    if (existsSync(this.tokensPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.tokensPath, 'utf8')) as Record<string, { deviceId: string; expiresAt: number }>;
        const m = new Map<string, { deviceId: string; expiresAt: number }>();
        for (const [hash, v] of Object.entries(raw)) m.set(hash, v);
        return m;
      } catch { /* fallthrough */ }
    }
    return new Map();
  }

  private saveTokens(): void {
    mkdirSync(dirname(this.tokensPath), { recursive: true });
    writeFileSync(this.tokensPath, JSON.stringify(Object.fromEntries(this.tokens), null, 2), 'utf8');
  }

  /** 登录：返回 token + deviceId；未启用 TOTP 时返回 otpauthUri 供绑定 */
  async login(username: string, password: string, totpCode: string | undefined, deviceName: string, ip: string): Promise<LoginResult> {
    if (this.rateLimited(ip)) {
      return { ok: false, error: 'rate-limited' };
    }
    const user = this.store.users.find((u) => u.username === username);
    if (!user) {
      this.recordFail(ip);
      return { ok: false, error: 'invalid-credentials' };
    }
    const derived = await scrypt(password, user.salt, 64);
    const stored = Buffer.from(user.hash, 'hex');
    if (stored.length !== derived.length || !timingSafeEqual(stored, derived)) {
      this.recordFail(ip);
      return { ok: false, error: 'invalid-credentials' };
    }

    // TOTP
    if (user.totpSecret) {
      if (!totpCode || !verifyTotp(user.totpSecret, totpCode)) {
        this.recordFail(ip);
        return { ok: false, error: 'totp-invalid' };
      }
    } else if (totpCode) {
      // 首次绑定：以用户输入的一次性码验证并启用
      const secret = generateSecret();
      if (verifyTotp(secret, totpCode)) {
        user.totpSecret = secret;
        this.save();
      } else {
        this.recordFail(ip);
        return { ok: false, error: 'totp-invalid' };
      }
    }

    this.clearFails(ip);
    const token = randomBytes(32).toString('hex');
    const deviceId = this.registerDevice(deviceName);
    this.tokens.set(sha256(token), { deviceId, expiresAt: Date.now() + TOKEN_TTL_MS });
    this.saveTokens();
    this.save();

    const result: LoginResult = { ok: true, token, deviceId };
    if (!user.totpSecret && totpCode) {
      // 本次绑定后仍返回 URI 供重录
      result.otpauthUri = otpauthUri(user.totpSecret!, 'batona-gateway', username);
    }
    return result;
  }

  /** 校验令牌（WS 连接 / HTTP 认证中间件） */
  validateToken(token: string): { deviceId: string } | null {
    const entry = this.tokens.get(sha256(token));
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.tokens.delete(sha256(token));
      this.saveTokens();
      return null;
    }
    const device = this.store.devices.find((d) => d.deviceId === entry.deviceId);
    if (!device || device.revoked) return null;
    return { deviceId: entry.deviceId };
  }

  /** 吊销设备（手机丢失场景） */
  revokeDevice(deviceId: string): boolean {
    const d = this.store.devices.find((x) => x.deviceId === deviceId);
    if (!d) return false;
    d.revoked = true;
    this.save();
    // 使该设备的令牌立即失效
    for (const [k, v] of this.tokens) {
      if (v.deviceId === deviceId) this.tokens.delete(k);
    }
    this.saveTokens();
    return true;
  }

  listDevices(): { deviceId: string; name: string; registeredAt: number; revoked: boolean }[] {
    return this.store.devices.map((d) => ({ ...d }));
  }

  /** 是否已启用 TOTP（供登录流程判断） */
  totpEnabled(username: string): boolean {
    return !!this.store.users.find((u) => u.username === username)?.totpSecret;
  }

  private registerDevice(name: string): string {
    const deviceId = randomBytes(8).toString('hex');
    this.store.devices.push({ deviceId, name: name || 'unknown-device', registeredAt: Date.now(), revoked: false });
    return deviceId;
  }

  private upsertUser(username: string, password: string, totpSecret: string | undefined): void {
    const salt = randomBytes(16).toString('hex');
    const user: StoredUser = { username, salt, hash: '', totpSecret, createdAt: Date.now() };
    void scrypt(password, salt, 64).then((derived) => {
      user.hash = derived.toString('hex');
      this.save();
    });
    const existing = this.store.users.findIndex((u) => u.username === username);
    if (existing >= 0) this.store.users[existing] = user;
    else this.store.users.push(user);
  }

  private rateLimited(ip: string): boolean {
    const now = Date.now();
    const list = (this.fails.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    return list.length >= MAX_FAILS;
  }

  private recordFail(ip: string): void {
    const now = Date.now();
    const list = (this.fails.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    list.push(now);
    this.fails.set(ip, list);
  }

  private clearFails(ip: string): void {
    this.fails.delete(ip);
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
