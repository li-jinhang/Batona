import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapter/dsh/adapter.ts';
import type { AgentSessionRef } from '../src/adapter/contract.ts';

const session: AgentSessionRef = {
  backend: 'dsh',
  backendSessionId: 'dsh-session-1',
  title: 'Permission test',
  state: 'idle',
  createdAt: 1,
};

let currentValue = 'workspace-write';
let projectionAvailable = true;
let exposePermissionCommand = true;
const calls: { method: string; args: Record<string, unknown> }[] = [];
const client = {
  async call(method: string, args: Record<string, unknown> = {}) {
    calls.push({ method, args });
    if (method === 'commands/list') {
      return { ok: true, value: exposePermissionCommand ? [{ name: 'permission', description: 'Switch permission preset' }] : [] };
    }
    if (method === 'commands/execute') {
      const line = String(args.line ?? '');
      currentValue = line.replace(/^\/permission\s+/, '');
      return { ok: true, value: { commandId: 'command-1', result: { kind: 'success' } } };
    }
    throw new Error(`unexpected DSH call: ${method}`);
  },
};
const mux = {
  open(endpoint: string, _args: Record<string, unknown>, handlers: { onItem(value: unknown): void }) {
    const streamId = `stream-${Date.now()}-${Math.random()}`;
    if (endpoint === 'session/follow') {
      queueMicrotask(() => handlers.onItem({
        type: 'snapshot',
        header: { kind: 'session', sessionId: session.backendSessionId },
        cursor: 1,
        records: [],
        hasMore: false,
        projections: {
          asOfSeq: 1,
          values: projectionAvailable ? {
            permissions: {
              currentValue,
              options: ['read-only', 'workspace-write', 'danger-full-access'].map((value) => ({ value, name: value })),
            },
          } : {},
        },
      }));
    }
    return streamId;
  },
  cancel() {},
  async stop() {},
};
const adapter = new DshAdapter();
Object.assign(adapter as unknown as Record<string, unknown>, {
  client,
  mux,
});

const initial = await adapter.sessionPermissionPresets(session);
assert.equal(initial.supported, true);
assert.equal(initial.currentValue, 'workspace-write');
assert.deepEqual(initial.options.map((option) => [option.id, option.available]), [
  ['read-only', true], ['workspace-write', true], ['danger-full-access', true],
]);

await assert.rejects(adapter.selectSessionPermissionPreset(session, 'danger-full-access', false), {
  code: 'permission-confirmation-required',
});
await assert.rejects(adapter.selectSessionPermissionPreset(session, 'auto', true), { code: 'bad-request' });
assert.equal(calls.some((call) => call.method === 'commands/execute'), false, 'rejected choices must not reach DSH');

const selected = await adapter.selectSessionPermissionPreset(session, 'danger-full-access', true);
assert.equal(selected.currentValue, 'danger-full-access');
assert.deepEqual(calls.filter((call) => call.method === 'commands/execute').map((call) => call.args), [{
  agentId: 'dsh-session-1',
  line: '/permission danger-full-access',
  submittedAttachments: [],
}]);

projectionAvailable = false;
const unavailable = await adapter.sessionPermissionPresets(session);
assert.equal(unavailable.supported, false);
assert.equal(unavailable.options.some((option) => option.available), false);
await assert.rejects(adapter.selectSessionPermissionPreset(session, 'read-only', false), { code: 'capability-missing' });

projectionAvailable = true;
currentValue = 'workspace-write';
exposePermissionCommand = false;
await assert.rejects(adapter.selectSessionPermissionPreset(session, 'read-only', false), { code: 'capability-missing' });
assert.equal(calls.some((call) => call.method === 'commands/execute' && call.args.line === '/permission read-only'), false);

await adapter.dispose();
console.log('PASS DSH session permission presets are projection-validated, allowlisted, confirmed, and read back');
