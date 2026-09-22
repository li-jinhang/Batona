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
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
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
  console.log('PASS bridge model survives adapter and gateway; absent model clears stale selection');
} finally {
  await adapter.dispose();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
