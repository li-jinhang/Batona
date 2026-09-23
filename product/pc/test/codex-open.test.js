'use strict';
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
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
  const shared = new CodexBridge({ websocketUrl: 'ws://127.0.0.1:45678/' });
  const sharedCalls = [];
  shared.appServer.request = async (method, params) => {
    sharedCalls.push(method);
    if (method === 'thread/read') return { thread: { id: params.threadId, name: 'Existing conversation', originator: 'Codex Desktop' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    throw new Error(`Unexpected call ${method}`);
  };
  assert.equal((await shared.resumeThread('desktop-thread', {})).id, 'desktop-thread');
  assert.deepEqual(sharedCalls, ['thread/read', 'thread/resume'], 'shared connection must subscribe to native turn events');
  const forwarded = [];
  shared.wss = { clients: [{ readyState: WebSocket.OPEN, send: (value) => forwarded.push(JSON.parse(value)) }] };
  shared.onNotification({ method: 'item/agentMessage/delta', params: { threadId: 'desktop-thread', delta: 'live reply' } });
  assert.deepEqual(forwarded, [{ type: 'agent-event', threadId: 'desktop-thread',
    event: { type: 'assistant/chunk', text: 'live reply' } }]);
  console.log('PASS open Desktop conversation with stdio read or shared-server subscription');
})().catch(e => { console.error(e); process.exitCode = 1; });
