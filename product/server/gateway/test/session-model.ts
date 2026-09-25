import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CodexAdapter } from '../src/adapter/codex/adapter.ts';
import { AdapterRegistry } from '../src/adapter/registry.ts';
import { SessionRouter } from '../src/session/router.ts';
import { projectedModel } from '../src/adapter/dsh/adapter.ts';

assert.deepEqual(projectedModel({ next: { provider: 'dsh', model: 'next', secret: 'never-forward' }, lastUsed: { provider: 'dsh', model: 'previous' } }), { provider: 'dsh', model: 'next' });
assert.deepEqual(projectedModel({ lastUsed: { provider: 'dsh', model: 'used' } }), { provider: 'dsh', model: 'used' });
assert.equal(projectedModel({ next: { model: 'missing-provider' } }), undefined);

let model: string | undefined = 'actual-model';
let modelReply: unknown = { accepted: true };
const routedPaths: string[] = [];
const permissionBodies: unknown[] = [];
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/model')) { res.end(JSON.stringify(modelReply)); return; }
  if (req.url?.endsWith('/permission-menu') || req.url?.endsWith('/permission')) {
    routedPaths.push(req.url);
    if (req.url.endsWith('/permission')) {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        permissionBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.end(JSON.stringify({ profileId: 'request-approval' }));
      });
    } else res.end(JSON.stringify({ profileId: 'request-approval' }));
    return;
  }
  const thread = { id: 'existing', model, reasoningEffort: 'high', state: 'idle' };
  res.end(JSON.stringify(req.url?.endsWith('/resume') ? { thread } : { ok: true }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const adapter = new CodexAdapter();
try {
  await adapter.connect({ baseUrl: `http://127.0.0.1:${address.port}` });
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const router = new SessionRouter(registry);
  const session = await router.resume('codex', 'existing');
  assert.deepEqual((session as unknown as { model?: unknown }).model,
    { provider: 'openai', model: 'actual-model', reasoningEffort: 'high' });
  model = undefined;
  const refreshed = await router.resume('codex', 'existing');
  assert.equal((refreshed as unknown as { model?: unknown }).model, undefined);
  await assert.rejects(router.selectModel(session.id, { provider: 'openai', model: 'next', reasoningEffort: 'high' }),
    (error: unknown) => (error as { code?: string }).code === 'native-model-unconfirmed');
  assert.equal(router.get(session.id)?.model, undefined);
  modelReply = { accepted: true, model: { provider: 'openai', model: 'next', reasoningEffort: 'high' } };
  await router.selectModel(session.id, { provider: 'openai', model: 'next', reasoningEffort: 'high' });
  assert.equal(router.get(session.id)?.model?.model, 'next');
  assert.deepEqual(await router.permissionMenu(session.id, true), { profileId: 'request-approval' });
  assert.deepEqual(await router.selectPermission(session.id, 'request-approval', true), { profileId: 'request-approval' });
  assert.deepEqual(routedPaths, ['/v1/sessions/existing/permission-menu', '/v1/sessions/existing/permission']);
  assert.deepEqual(permissionBodies, [{ profileId: 'request-approval', confirmed: true }]);
  console.log('PASS bridge model survives adapter and gateway; absent model clears stale selection');
} finally {
  await adapter.dispose();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
