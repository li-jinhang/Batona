import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapter/dsh/adapter.ts';
import type { AgentSessionRef } from '../src/adapter/contract.ts';

const calls: { method: string; args: Record<string, unknown> }[] = [];
let confirmedEffort = 'max';
const adapter = new DshAdapter();
Object.assign(adapter as unknown as Record<string, unknown>, {
  client: {
    async call(method: string, args: Record<string, unknown>) {
      calls.push({ method, args });
      if (method === 'session/modelCatalog') return { ok: true, value: {
        groups: [{ id: 'deepseek', models: [
          { id: 'reasoning', name: 'Reasoning', reasoning: {
            defaultEffort: 'high', efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id, name: id })),
          } },
          { id: 'plain', name: 'Plain' },
        ] }],
      } };
      if (method === 'session/selectModel') {
        const request = args.request as Record<string, string>;
        return { ok: true, value: { selected: {
          provider: request.provider, model: request.model, reasoningEffort: confirmedEffort,
        } } };
      }
      throw new Error(`unexpected call: ${method}`);
    },
  },
});

const models = await adapter.listModels();
assert.deepEqual(models.filter((model) => model.model === 'reasoning').map((model) => model.reasoningEffort),
  ['high', 'off', 'low', 'max']);
assert.equal(models.filter((model) => model.model === 'plain').length, 1);

const session: AgentSessionRef = {
  backend: 'dsh', backendSessionId: 'session-1', state: 'idle', createdAt: 1,
};
const max = models.find((model) => model.reasoningEffort === 'max')!;
await adapter.selectModel(session, max);
assert.deepEqual(calls.at(-1), { method: 'session/selectModel', args: { request: {
  sessionId: 'session-1', provider: 'deepseek', model: 'reasoning', reasoningEffort: 'max',
} } });

confirmedEffort = 'low';
await assert.rejects(adapter.selectModel(session, max), { code: 'model-select-unconfirmed' });
await adapter.dispose();
console.log('PASS DSH catalog efforts and confirmed selection');
