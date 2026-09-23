'use strict';

const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

(async () => {
  const calls = [];
  const bridge = new CodexBridge({ nativeControl: {
    async setModel(threadId, model) { calls.push([threadId, model]); return { accepted: true }; },
  } });
  bridge.appServer.request = async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'Codex Desktop' } };
    assert.equal(method, 'model/list');
    return { data: [{ model: 'gpt-6-sol', displayName: 'GPT-6-Sol',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'medium', description: 'Balanced' },
      ], defaultReasoningEffort: 'medium' }] };
  };
  assert.deepEqual(await bridge.listModels(), [
    { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'low', displayName: 'GPT-6-Sol' },
    { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'medium', displayName: 'GPT-6-Sol' },
  ]);
  await bridge.selectModel('desktop-thread', { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'medium' });
  assert.deepEqual(calls, [['desktop-thread', { displayName: 'GPT-6-Sol', effortIndex: 2, effortCount: 2 }]]);
  await assert.rejects(bridge.selectModel('desktop-thread',
    { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'ultra' }),
  (error) => error.code === 'native-model-invalid');
  await assert.rejects(bridge.selectModel('desktop-thread',
    { provider: 'other', model: 'gpt-6-sol', reasoningEffort: 'medium' }),
  (error) => error.code === 'native-model-invalid');
  console.log('PASS Codex model catalog reasoning efforts');
})().catch((error) => { console.error(error); process.exitCode = 1; });
