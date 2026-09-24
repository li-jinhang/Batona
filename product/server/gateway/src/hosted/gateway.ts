import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { WebSocketServer } from 'ws';
import { AccountStore, AccessError, digest, equal, required, secret, type Account } from './store.ts';
import { PcRuntime } from './runtime.ts';
import { createPushSender, notificationPayload, parsePushSubscription, type PushCategory, type PushSender, type WebPushConfig } from './push.ts';

export interface HostedOptions { dataDir: string; adminKey: string; vaultKey: Buffer; webDir: string; mock?: boolean; now?: () => number; webPush?: WebPushConfig; pushSender?: PushSender }
interface Pairing {
  accountId: string; pcId: string; pcToken: string; code: string;
  request?: { id: string; proof: string; secretHash: string; name: string };
  approved?: { token: string; deviceId: string }; expires?: number;
}
export class HostedGateway {
  readonly server;
  readonly store: AccountStore;
  private opts: HostedOptions;
  private runtimes = new Map<string, Promise<PcRuntime>>();
  private pairs = new Map<string, Pairing>();
  private waiting = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private limits = new Map<string, { count: number; until: number }>();
  private timer;
  private pushSender?: PushSender;
  constructor(opts: HostedOptions) {
    if (opts.adminKey.length < 32) throw new Error('admin-key-too-short');
    if (opts.webPush) this.pushSender = opts.pushSender ?? createPushSender(opts.webPush);
    this.opts = opts; this.store = new AccountStore(opts.dataDir, opts.vaultKey, opts.now);
    this.server = createServer((req, res) => { void (async () => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-content-type-options', 'nosniff');
      try {
        const path = new URL(req.url ?? '/', 'http://local').pathname;
        if (path === '/healthz' && req.method === 'GET') {
          let version = 'unknown';
          for (const relative of ['../package.json', '../../package.json']) {
            try { const pkg = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')); if (pkg.name === 'batona-gateway') version = pkg.version; } catch {}
          }
          res.end(JSON.stringify({ version, ok: true, accessMode: 'hosted', tunnel: { enabled: true } })); return;
        }
        if (req.method === 'GET' && ['/access-admin', '/access-admin.js', '/access-admin.css'].includes(path)) {
          const file = path === '/access-admin' ? 'access-admin.html' : path.slice(1);
          res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/css');
          res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
          res.end(readFileSync(join(opts.webDir, file))); return;
        }
        if (!path.startsWith('/api/access/') && !path.startsWith('/api/admin/')) throw new AccessError('upgrade-required', 410);
        if (req.method !== 'POST') throw new AccessError('method-not-allowed', 405);
        if (!String(req.headers['content-type']).startsWith('application/json')) throw new AccessError('json-required', 415);
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new AccessError('origin-denied', 403);
        const token = this.bearer(req);
        const known = this.store.validate(token) || equal(token, this.opts.adminKey);
        const peer = req.socket.remoteAddress ?? '';
        const realIp = String(req.headers['x-real-ip'] ?? '');
        const ip = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) && isIP(realIp) ? realIp : peer;
        this.limit(ip + ':ingress', 1800);
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new AccessError('body-too-large', 413); chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new AccessError('invalid-json'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError('invalid-input');
        const pairProof = path === '/api/access/pair-result' && [...this.pairs.values()].some(p => p.request && p.request.id === body.requestId && equal(p.request.proof, String(body.proof ?? '')) && (!p.expires || p.expires > this.store.now()));
        const identity = known ? digest(token) : pairProof ? digest(String(body.proof)) : 'anonymous';
        this.limit(ip + ':' + path + ':' + identity, known || pairProof ? 180 : 20);
        const value = path.startsWith('/api/admin/') ? await this.admin(path.slice(11), token, body) : await this.access(path.slice(12), token, body);
        res.end(JSON.stringify({ ok: true, ...value }));
      } catch (e) {
        res.statusCode = e instanceof AccessError ? e.status : 500;
        res.end(JSON.stringify({ ok: false, error: e instanceof AccessError ? e.message : 'internal-error' }));
      }
    })(); });
    this.server.requestTimeout = 15000;
    this.server.on('upgrade', (req, socket, head) => { void (async () => {
      const path = new URL(req.url ?? '/', 'http://local').pathname;
      if (path === '/tunnel') {
        const info = this.store.validate(this.bearer(req), 'pc');
        if (!info) throw new AccessError('unauthorized', 401);
        const runtime = await this.runtime(info.account);
        runtime.tunnel.handleUpgrade(req, socket, head);
      } else if (path === '/ws' && this.waiting.clients.size < 128) {
        this.waiting.handleUpgrade(req, socket, head, ws => {
          this.waiting.emit('connection', ws, req);
          const timeout = setTimeout(() => ws.close(1008, 'auth-required'), 10000);
          ws.on('error', () => {});
          ws.once('close', () => clearTimeout(timeout));
          ws.once('message', data => { void (async () => {
            if (Buffer.byteLength(String(data)) > 8192) throw new AccessError('invalid-handshake');
            const frame = JSON.parse(String(data));
            const info = frame.type === 'client-request' && frame.method === 'auth.hello' ? this.store.validate(String(frame.payload?.token ?? ''), 'phone') : null;
            if (!info) throw new AccessError('unauthorized', 401);
            const runtime = await this.runtimes.get(info.account.id);
            if (!runtime?.online()) throw new AccessError('pc-offline', 409);
            this.store.change(() => { info.device.lastSeen = this.store.now(); });
            clearTimeout(timeout); this.waiting.clients.delete(ws);
            runtime.ws.accept(ws, req); ws.emit('message', data);
          })().catch(e => { clearTimeout(timeout); ws.close(1008, e instanceof AccessError ? e.message : 'invalid-handshake'); }); });
        });
      } else throw new AccessError('not-found', 404);
    })().catch(() => { if (!socket.destroyed) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); } }); });
    this.timer = setInterval(() => {
      const now = this.store.now();
      for (const [key, entry] of this.limits) if (entry.until < now) this.limits.delete(key);
      for (const [id, p] of this.pairs) if (p.expires && p.expires < now) this.pairs.delete(id);
      try { this.store.prune(); } catch { console.error('[access] counter-maintenance-failed'); }
    }, 60000);
    this.timer.unref();
  }
  private bearer(req: IncomingMessage) { return String(req.headers.authorization ?? '').replace(/^Bearer /, ''); }
  private limit(key: string, max: number) {
    const now = this.store.now(), old = this.limits.get(key);
    if (!old && this.limits.size >= 10000) throw new AccessError('rate-limited', 429);
    const entry = old && old.until > now ? old : { count: 0, until: now + 60000 };
    if (++entry.count > max) throw new AccessError('rate-limited', 429);
    this.limits.set(key, entry);
  }
  private async runtime(a: Account) {
    if (!a.pc || a.disabled) throw new AccessError('pc-offline', 409);
    let pending = this.runtimes.get(a.id);
    if (!pending) {
      const runtime = new PcRuntime(this.store, a.id, a.pc.id, () => { this.clearPairs(a.id); runtime.ws?.disconnectInvalid(); });
      pending = runtime.start(this.store, this.server, !!this.opts.mock, category => { void this.deliverPush(a, category); }).then(() => runtime).catch(async e => {
        this.runtimes.delete(a.id); await runtime.close(); throw e;
      });
      this.runtimes.set(a.id, pending);
    }
    return pending;
  }
  private clearPairs(id: string) { for (const [key, p] of this.pairs) if (p.accountId === id) this.pairs.delete(key); }
  private async stopRuntime(id: string) {
    this.clearPairs(id);
    const old = this.runtimes.get(id); this.runtimes.delete(id);
    if (old) await (await old).close();
  }
  private async deliverPush(account: Account, category: PushCategory): Promise<void> {
    const subscription = account.phone && account.pushSubscription;
    if (!subscription || !this.pushSender || account.disabled) return;
    try {
      await this.pushSender(subscription, notificationPayload(category));
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode;
      if (status === 404 || status === 410) {
        try { this.store.change(() => { if (account.pushSubscription?.endpoint === subscription.endpoint) delete account.pushSubscription; }); }
        catch { console.error('[push] expired-subscription-cleanup-failed'); }
      }
      console.error(`[push] delivery-failed category=${category} status=${typeof status === 'number' ? status : 'unavailable'}`);
    }
  }
  private async admin(op: string, token: string, b: Record<string, unknown>): Promise<object> {
    if (!equal(token, this.opts.adminKey)) throw new AccessError('unauthorized', 401);
    if (op === 'create') return this.store.change(() => { const a = this.store.create(String(b.remark ?? '').slice(0, 100)); return { ...this.store.summary(a), key: a.key }; });
    if (op === 'accounts') return { items: this.store.accounts().map(a => this.store.summary(a)) };
    const a = this.store.account(required(b.id));
    if (op === 'reveal') return { key: a.key };
    if (op === 'remark') return this.store.change(() => { a.remark = String(b.remark ?? '').slice(0, 100); return this.store.summary(a); });
    if (!['disable', 'reset', 'delete'].includes(op)) throw new AccessError('not-found', 404);
    const result = this.store.change(() => {
      if (op === 'disable') { a.disabled = true; this.store.revoke(a); delete a.pushSubscription; return {}; }
      this.store.remove(a);
      if (op === 'reset') { const fresh = this.store.create(a.remark); return { ...this.store.summary(fresh), key: fresh.key }; }
      return {};
    });
    await this.stopRuntime(a.id); return result;
  }
  private async access(op: string, token: string, b: Record<string, unknown>): Promise<object> {
    if (op === 'login') {
      const login = this.store.change(() => this.store.login(required(b.key), required(b.deviceSecret, 32), String(b.name ?? 'PC').slice(0, 100), b.replace === true));
      await this.stopRuntime(login.accountId);
      const info = this.store.validate(login.token, 'pc');
      if (!info) throw new AccessError('login-superseded', 409);
      await this.runtime(info.account); return login;
    }
    if (op === 'pair-request') {
      const code = required(b.code).toUpperCase().replace(/[\s-]/g, '');
      const p = [...this.pairs.values()].find(p => equal(p.code, code) && !p.approved);
      if (!p || (p.expires && p.expires < this.store.now()) || !this.store.validate(p.pcToken, 'pc')) throw new AccessError('pair-invalid', 404);
      const a = this.store.account(p.accountId), hash = digest(required(b.deviceSecret, 32));
      if (a.phone && a.phone.secretHash !== hash) throw new AccessError('phone-slot-occupied', 409);
      if (p.request) throw new AccessError('pair-pending', 409);
      p.request = { id: secret(), proof: secret(), secretHash: hash, name: String(b.name ?? 'Android').slice(0, 100) };
      return { requestId: p.request.id, proof: p.request.proof };
    }
    if (op === 'pair-result') {
      const p = [...this.pairs.values()].find(p => p.request && p.request.id === b.requestId && equal(p.request.proof, String(b.proof ?? '')));
      if (!p || (p.expires && p.expires < this.store.now())) throw new AccessError('pair-invalid', 404);
      if (!p.approved) return { pending: true };
      if (!this.store.validate(p.approved.token, 'phone')) throw new AccessError('pair-invalid', 404);
      return { ...p.approved, accountId: p.accountId };
    }
    const info = this.store.validate(token);
    if (!info) throw new AccessError('unauthorized', 401);
    const a = info.account;
    if (op === 'logout') {
      this.store.change(() => { this.store.revoke(a, info.kind); if (info.kind === 'phone') delete a.pushSubscription; });
      if (info.kind === 'pc') await this.stopRuntime(a.id);
      else (await this.runtimes.get(a.id))?.ws.disconnectInvalid();
      return {};
    }
    if (op === 'status') return { accountId: a.id, deviceId: info.device.id, pcOnline: (await this.runtimes.get(a.id))?.online() ?? false };
    if (op === 'push-key' || op === 'push-status' || op === 'push-subscribe' || op === 'push-unsubscribe') {
      if (info.kind !== 'phone') throw new AccessError('phone-required', 403);
      if (op === 'push-key' || op === 'push-status') return {
        configured: Boolean(this.pushSender && this.opts.webPush?.publicKey),
        publicKey: this.pushSender ? this.opts.webPush?.publicKey ?? null : null,
        subscribed: Boolean(a.pushSubscription),
      };
      if (op === 'push-unsubscribe') {
        this.store.change(() => { delete a.pushSubscription; });
        return { subscribed: false };
      }
      if (!this.pushSender) throw new AccessError('push-not-configured', 503);
      let subscription;
      try { subscription = parsePushSubscription(b.subscription); }
      catch { throw new AccessError('invalid-push-subscription', 400); }
      return this.store.change(() => { a.pushSubscription = subscription; return { subscribed: true }; });
    }
    if (info.kind !== 'pc') throw new AccessError('pc-required', 403);
    const rt = await this.runtime(a);
    if (!this.store.validate(token, 'pc')) throw new AccessError('unauthorized', 401);
    if (op === 'launch-token') { await rt.registry.get('dsh')?.setAuthToken?.(required(b.token, 1, 4096)); return {}; }
    if (op === 'devices') {
      const online = !!a.phone && rt.ws.onlineDevices().has(a.phone.id);
      return { items: a.phone ? [{ deviceId: a.phone.id, name: a.phone.name, lastSeen: a.phone.lastSeen, online }] : [] };
    }
    if (op === 'rename-phone') return this.store.change(() => { if (!a.phone) throw new AccessError('phone-not-found', 404); a.phone.name = required(b.name, 1, 100); return {}; });
    if (op === 'unbind-phone') {
      this.store.change(() => { this.store.revoke(a, 'phone'); delete a.phone; delete a.pushSubscription; }); this.clearPairs(a.id); rt.ws.disconnectInvalid(); return {};
    }
    if (op === 'pair-open') {
      if (!rt.online()) throw new AccessError('pc-offline', 409);
      this.clearPairs(a.id);
      const id = secret(), code = secret().slice(0, 12).toUpperCase().replace(/[-_]/g, 'Z');
      this.pairs.set(id, { accountId: a.id, pcId: info.device.id, pcToken: token, code, expires: this.store.now() + 20000 });
      return { pairId: id, code, qr: 'batona-pair://' + code };
    }
    const p = this.pairs.get(String(b.pairId ?? ''));
    if (!p || p.accountId !== a.id || p.pcId !== info.device.id || p.pcToken !== token || (p.expires && p.expires < this.store.now())) throw new AccessError('pair-invalid', 404);
    if (op === 'pair-close') { this.pairs.delete(String(b.pairId)); return {}; }
    if (op === 'pair-status') { if (!p.approved) p.expires = this.store.now() + 20000; return { pending: p.request && !p.approved ? { requestId: p.request.id, name: p.request.name } : null, approved: !!p.approved }; }
    if (op === 'pair-confirm') {
      if (!rt.online() || p.approved || !p.request || p.request.id !== b.requestId) throw new AccessError('pair-invalid', 409);
      if (b.allow !== true) { this.pairs.delete(String(b.pairId)); return {}; }
      p.approved = this.store.change(() => {
        if (a.phone && a.phone.secretHash !== p.request!.secretHash) throw new AccessError('phone-slot-occupied', 409);
        a.phone ??= { id: secret(), secretHash: p.request!.secretHash, name: p.request!.name, lastSeen: this.store.now() };
        return { token: this.store.issue(a, 'phone'), deviceId: a.phone.id };
      });
      p.expires = this.store.now() + 60000; rt.ws.disconnectInvalid(); return { approved: true };
    }
    throw new AccessError('not-found', 404);
  }
  async close() {
    clearInterval(this.timer);
    for (const ws of this.waiting.clients) ws.terminate(); this.waiting.close();
    for (const id of [...this.runtimes.keys()]) await this.stopRuntime(id);
    this.server.closeAllConnections();
    await new Promise<void>(r => this.server.close(() => r()));
  }
}
