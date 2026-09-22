'use strict';
const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');
(async () => {
  const bridge = new CodexBridge();
  const calls = [];
  bridge.appServer.request = async (method, params) => {
    calls.push(method);
    if (method === 'thread/read') return { thread: { id: params.threadId, name: 'Existing conversation', status: { type: 'idle' } } };
    if (method === 'thread/resume') throw Object.assign(new Error('already has an active writer'), { code: 'codex-desktop-owned' });
    throw new Error(`Unexpected call ${method}`);
  };
  const thread = await bridge.resumeThread('desktop-thread', {});
  assert.equal(thread.id, 'desktop-thread');
  assert.deepEqual(calls, ['thread/read'], 'opening history must not acquire a second writer');
  console.log('PASS open a Desktop-owned conversation without acquiring writer');
})().catch(e => { console.error(e); process.exitCode = 1; });
