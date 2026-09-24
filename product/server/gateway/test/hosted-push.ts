import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccountStore, digest } from '../src/hosted/store.ts';
import { HostedGateway } from '../src/hosted/gateway.ts';
import webpush from 'web-push';
import { attentionCategory, createPushSender, notificationPayload, parsePushSubscription } from '../src/hosted/push.ts';

const dir = mkdtempSync(join(tmpdir(), 'batona-hosted-push-'));
const adminKey = randomBytes(32).toString('hex');
const vaultKey = randomBytes(32);
const publicKey = 'P'.repeat(87), privateKey = 'K'.repeat(43);
const generatedKeys = webpush.generateVAPIDKeys();
assert.equal(typeof createPushSender({ subject: 'mailto:ops@example.test', ...generatedKeys }), 'function');
const gateway = new HostedGateway({
  dataDir: dir, adminKey, vaultKey, webDir: resolve('web'),
  webPush: { subject: 'https://example.test/', publicKey, privateKey },
  pushSender: async () => {},
});
await new Promise<void>(resolveListen => gateway.server.listen(0, '127.0.0.1', resolveListen));
const address = gateway.server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const store = gateway.store as AccountStore;

async function call(path: string, body: object = {}, token = '') {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

function addPhone(remark: string, withPc = false) {
  return store.change(() => {
    const account = store.create(remark);
    account.phone = { id: `phone-${remark}`, secretHash: digest(`secret-${remark}`), name: 'PWA', lastSeen: Date.now() };
    if (withPc) account.pc = { id: `pc-${remark}`, secretHash: digest(`pc-secret-${remark}`), name: 'PC', lastSeen: Date.now() };
    const phoneToken = store.issue(account, 'phone');
    const pcToken = withPc ? store.issue(account, 'pc') : '';
    return { account, phoneToken, pcToken };
  });
}

try {
  const valid = { endpoint: 'https://web.push.apple.com/pwa-fixture-token', expirationTime: null, keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) } };
  assert.equal(parsePushSubscription(valid).endpoint, valid.endpoint);
  assert.throws(() => parsePushSubscription({ ...valid, endpoint: 'https://web.push.apple.com.attacker.test/token' }));
  assert.throws(() => parsePushSubscription({ ...valid, endpoint: 'https://fcm.googleapis.com/token' }));
  assert.equal(attentionCategory({ type: 'approval/requested', approvalId: 'private-id', toolName: 'private-tool' } as any), 'approval');
  assert.equal(attentionCategory({ type: 'question/requested', questionRpcId: 'private-id', questions: [] } as any), 'question');
  assert.equal(attentionCategory({ type: 'turn/end' } as any), 'completed');
  assert.equal(attentionCategory({ type: 'error', message: 'private text' } as any), 'failed');
  assert.equal(attentionCategory({ type: 'assistant/chunk', text: 'private text' } as any), null);
  assert.deepEqual(JSON.parse(notificationPayload('approval')), { category: 'approval' });
  assert.throws(() => notificationPayload('private-id' as any));

  const loggedOut = addPhone('logout');
  const pushKey = await call('/api/access/push-key', {}, loggedOut.phoneToken);
  assert.equal(pushKey.status, 200);
  assert.equal(pushKey.body.configured, true);
  assert.equal(pushKey.body.publicKey, publicKey);
  assert.equal('privateKey' in pushKey.body, false);
  assert.equal((await call('/api/access/push-subscribe', { subscription: { ...valid, endpoint: 'https://evil.test/x' } }, loggedOut.phoneToken)).status, 400);
  assert.equal((await call('/api/access/push-subscribe', { subscription: valid }, loggedOut.phoneToken)).status, 200);
  assert.equal(loggedOut.account.pushSubscription?.endpoint, valid.endpoint);
  assert.equal((await call('/api/access/logout', {}, loggedOut.phoneToken)).status, 200);
  assert.equal(loggedOut.account.pushSubscription, undefined, 'phone logout must clear the stored subscription');
  assert.equal((await call('/api/access/push-status', {}, loggedOut.phoneToken)).status, 401);

  const disabled = addPhone('disable', true);
  await call('/api/access/push-subscribe', { subscription: valid }, disabled.phoneToken);
  assert.equal(disabled.account.pushSubscription?.endpoint, valid.endpoint);
  assert.equal((await call('/api/admin/disable', { id: disabled.account.id }, adminKey)).status, 200);
  assert.equal(disabled.account.disabled, true);
  assert.equal(disabled.account.pushSubscription, undefined, 'account disable must revoke and clear the stored subscription');
  console.log('PASS hosted Web Push allowlist, category-only payloads, phone logout cleanup, and account disable cleanup');
} finally {
  await gateway.close();
  rmSync(dir, { recursive: true, force: true });
}
