import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { HostedGateway } from '../src/hosted/gateway.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-hosted-test-'));
const adminKey = randomBytes(32).toString('hex');
const gateway = new HostedGateway({ dataDir, adminKey, vaultKey: randomBytes(32), webDir: './web', mock: true });
await new Promise<void>(r => gateway.server.listen(0, '127.0.0.1', r));
const address = gateway.server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
async function call(path: string, body: object = {}, token = '') {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
try {
  assert.equal((await call('/api/admin/accounts', {}, 'wrong')).status, 401);
  const created = await call('/api/admin/create', { remark: 'fixture' }, adminKey);
  assert.equal(created.status, 200);
  const key = created.body.key;
  assert.equal(typeof key, 'string');
  const pc = await call('/api/access/login', { key, deviceSecret: 'fixture-pc-secret-00000000000000000000', name: 'PC A' });
  assert.equal(pc.status, 200);
  assert.equal(typeof pc.body.token, 'string');
  assert.equal((await call('/api/admin/accounts', {}, key)).status, 401);
  assert.equal((await call('/api/access/login', { key: adminKey, deviceSecret: 'fixture-pc-secret-00000000000000000000' })).status, 401);
  assert.equal((await call('/api/auth/login', { username: 'admin', password: 'old' })).status, 410);
  const tunnel = new WebSocket(base.replace('http:', 'ws:') + '/tunnel', { headers: { authorization: `Bearer ${pc.body.token}` } });
  await new Promise<void>((resolve, reject) => { tunnel.once('open', resolve); tunnel.once('error', reject); });
  const welcome = new Promise<void>(resolve => tunnel.once('message', () => resolve()));
  tunnel.send(JSON.stringify({ t: 'hello', v: 1, client: { app: 'test', appVersion: '1' }, services: [{ name: 'dsh' }, { name: 'dir' }, { name: 'codex' }] }));
  await welcome;
  const pair = await call('/api/access/pair-open', {}, pc.body.token);
  assert.equal(pair.status, 200);
  const request = await call('/api/access/pair-request', { code: pair.body.code, deviceSecret: 'fixture-phone-secret-000000000000000', name: 'Phone A' });
  assert.equal(request.status, 200);
  assert.equal((await call('/api/access/pair-result', request.body)).body.pending, true);
  for (let i = 0; i < 45; i++) assert.equal((await call('/api/access/pair-result', request.body)).status, 200, 'pending polling must survive more than 30 seconds');
  assert.equal((await call('/api/access/pair-confirm', { pairId: pair.body.pairId, requestId: request.body.requestId, allow: true }, pc.body.token)).status, 200);
  const phone = await call('/api/access/pair-result', request.body);
  assert.equal(typeof phone.body.token, 'string');
  assert.equal((await call('/api/access/pair-request', { code: pair.body.code, deviceSecret: 'fixture-phone-secret-000000000000000' })).status, 404);
  const mobile = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  await new Promise<void>(resolve => mobile.once('open', resolve));
  const rpc = (method: string, payload: object = {}, rpcId = randomBytes(8).toString('hex')) => new Promise<any>(resolve => {
    const listen = (data: unknown) => { const r = JSON.parse(String(data)); if (r.rpcId === rpcId) { mobile.off('message', listen); resolve(r.result); } };
    mobile.on('message', listen); mobile.send(JSON.stringify({ type: 'client-request', rpcId, method, payload }));
  });
  assert.equal((await rpc('auth.hello', { token: phone.body.token })).ok, true);
  const session = await rpc('session.create', { backend: 'mock' });
  assert.equal(session.ok, true);
  assert.equal((await rpc('session.prompt', { sessionId: session.value.id, parts: [{ type: 'text', text: 'fixture' }] }, 'one-submission')).ok, true);
  assert.equal((await rpc('session.prompt', { sessionId: session.value.id, parts: [{ type: 'text', text: 'fixture' }] }, 'one-submission')).ok, true);
  const list = await call('/api/admin/accounts', {}, adminKey);
  assert.equal(list.body.items[0].requests24h, 1);
  assert.equal((await rpc('session.prompt', { sessionId: session.value.id, parts: [{ type: 'text', text: '大段文本'.repeat(1000) }] }, 'large-submission')).ok, true);
  console.log('Hosted fixture encrypted storage bytes:', statSync(join(dataDir, 'access.vault')).size);
  mkdirSync(join(dataDir, 'access.vault.tmp'));
  assert.equal((await rpc('session.prompt', { sessionId: session.value.id, parts: [{ type: 'text', text: '[ask] disk failure fixture' }] }, 'storage-failure')).ok, true);
  assert.equal((await call('/api/admin/accounts', {}, adminKey)).body.items[0].requests24h, null);
  rmSync(join(dataDir, 'access.vault.tmp'), { recursive: true });
  assert.equal((await call('/api/access/logout', {}, phone.body.token)).status, 200);
  assert.equal((await call('/api/access/status', {}, phone.body.token)).status, 401);
  assert.equal((await call('/api/access/devices', {}, pc.body.token)).body.items.length, 1);
  mobile.terminate(); tunnel.terminate();
  console.log('PASS hosted admin key -> account key -> PC login; credential domains isolated');
} finally {
  await gateway.close();
  rmSync(dataDir, { recursive: true, force: true });
}
