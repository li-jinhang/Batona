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
  const userItem = { type: 'userMessage', content: [{ type: 'text', text: 'hello' }] };
  const replyItem = { type: 'agentMessage', text: 'hi' };
  for (const method of ['item/started', 'item/completed']) {
    shared.onNotification({ method, params: { threadId: 'desktop-thread', item: userItem } });
    shared.onNotification({ method, params: { threadId: 'desktop-thread', item: replyItem } });
  }
  assert.deepEqual(forwarded.slice(1).map((entry) => entry.event.type), ['user/message', 'assistant/message']);
  const pilot = new CodexBridge({ websocketUrl: 'ws://127.0.0.1:45678/', enableSharedWrites: true,
    nativeControl: { send() { throw new Error('native UI must not be used by the shared pilot'); } } });
  const pilotCalls = [];
  pilot.appServer.request = async (method, params) => {
    pilotCalls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'Codex Desktop' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    throw new Error(`Unexpected call ${method}`);
  };
  await pilot.prompt('desktop-thread', { text: 'phone text' });
  assert.deepEqual(pilotCalls.map((call) => call.method), ['thread/read', 'thread/resume', 'turn/start']);
  assert.deepEqual(pilotCalls[2].params, { threadId: 'desktop-thread', input: [{ type: 'text', text: 'phone text' }] });
  const pilotEvents = [];
  pilot.wss = { clients: [{ readyState: WebSocket.OPEN, send: (value) => pilotEvents.push(JSON.parse(value)) }] };
  const approval = (id) => ({ id, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'desktop-thread', turnId: 'turn-1', reason: 'test' } });
  pilot.onServerRequest(approval(122));
  assert.equal(pilot.pendingRequests.size, 1);
  pilot.onNotification({ method: 'serverRequest/resolved', params: { threadId: 'desktop-thread', requestId: 122 } });
  assert.equal(pilot.pendingRequests.size, 0);
  assert.deepEqual(pilotEvents.map((event) => event.event.type), ['approval/requested', 'interaction/resolved']);
  await assert.rejects(pilot.respond('desktop-thread', { rpcId: '122', payload: { outcome: 'rejected' } }),
    (error) => error.code === 'interaction-resolved');
  pilot.onServerRequest(approval(123));
  let replied;
  pilot.appServer.respond = (id, result) => { replied = { id, result }; };
  await pilot.respond('desktop-thread', { rpcId: '123', payload: { outcome: 'rejected' } });
  assert.deepEqual(replied, { id: 123, result: { decision: 'decline' } });
  console.log('PASS open Desktop conversation with stdio read or shared-server subscription');
})().catch(e => { console.error(e); process.exitCode = 1; });
