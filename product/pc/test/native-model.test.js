'use strict';

const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

(async () => {
  const calls = [];
  let applied = null;
  const bridge = new CodexBridge({ nativeControl: {
    async setModel(threadId, model) { calls.push([threadId, model]); applied = { model: 'gpt-6-sol', reasoningEffort: 'medium' }; return { accepted: true }; },
  } });
  bridge.appServer.request = async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'Codex Desktop', ...applied } };
    assert.equal(method, 'model/list');
    return { data: [{ model: 'gpt-6-sol', displayName: 'GPT-6-Sol',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'medium', description: 'Balanced' },
      ], defaultReasoningEffort: 'medium' }] };
  };
  assert.deepEqual(await bridge.listModels(), [
    { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'low', displayName: 'GPT-6-Sol', defaultReasoningEffort: 'medium' },
    { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'medium', displayName: 'GPT-6-Sol', defaultReasoningEffort: 'medium' },
  ]);
  await bridge.selectModel('desktop-thread', { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'medium' });
  assert.deepEqual(calls, [['desktop-thread', { displayName: 'GPT-6-Sol', effortIndex: 2, effortCount: 2 }]]);
  applied = null;
  bridge.nativeControl.setModel = async () => ({ accepted: true });
  await assert.rejects(bridge.selectModel('desktop-thread',
    { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'medium' }),
  (error) => error.code === 'native-model-unconfirmed');
  await assert.rejects(bridge.selectModel('desktop-thread',
    { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'ultra' }),
  (error) => error.code === 'native-model-invalid');
  await assert.rejects(bridge.selectModel('desktop-thread',
    { provider: 'other', model: 'gpt-6-sol', reasoningEffort: 'medium' }),
  (error) => error.code === 'native-model-invalid');
  const owned = new CodexBridge();
  let nextTurn;
  owned.appServer.request = async (method, params) => {
    if (method === 'model/list') return { data: [{ model: 'gpt-6-sol', supportedReasoningEfforts: ['medium'] }] };
    if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'batona' } };
    if (method === 'thread/resume') return {};
    if (method === 'turn/start') { nextTurn = params; return {}; }
    throw new Error(`unexpected ${method}`);
  };
  assert.deepEqual(await owned.selectModel('owned-thread',
    { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'medium' }),
  { provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'medium' });
  await owned.prompt('owned-thread', { text: 'next turn' });
  assert.equal(nextTurn.model, 'gpt-6-sol');
  assert.equal(nextTurn.effort, 'medium');
  console.log('PASS Codex model catalog reasoning efforts');
})().catch((error) => { console.error(error); process.exitCode = 1; });
