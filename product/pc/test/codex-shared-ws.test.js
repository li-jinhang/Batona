'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { AppServerClient, CodexBridge } = require('../codex-bridge');

async function main() {
  for (const url of ['ws://192.168.1.2:8765/', 'wss://127.0.0.1:8765/',
    'ws://127.0.0.1:8765/other', 'ws://127.0.0.1:8765/?token=x']) {
    assert.throws(() => new AppServerClient({ websocketUrl: url }), /回环|WebSocket/);
  }
  const bridge = new CodexBridge({ websocketUrl: 'ws://127.0.0.1:8765/' });
  bridge.appServer.respond = () => { throw new Error('Shared mode must not answer Desktop approvals'); };
  bridge.onServerRequest({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'desktop' } });
  assert.equal(bridge.pendingRequests.size, 0);

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const messages = [];
  let resolveReply;
  const approvalReply = new Promise((resolve) => { resolveReply = resolve; });
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const msg = JSON.parse(String(data));
      messages.push(msg);
      if (msg.method === 'initialize') socket.send(JSON.stringify({ id: msg.id, result: { userAgent: 'test' } }));
      if (msg.method === 'thread/list') socket.send(JSON.stringify({ id: msg.id, result: { data: [] } }));
      if (msg.method === 'initialized') socket.send(JSON.stringify({ method: 'thread/name/updated', params: { threadId: 'test' } }));
      if (msg.method === 'initialized') socket.send(JSON.stringify({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'test' } }));
      if (msg.id === 99 && msg.result) resolveReply(msg.result);
    });
  });

  const address = server.address();
  const client = new AppServerClient({ websocketUrl: `ws://127.0.0.1:${address.port}` });
  try {
    const notification = once(client, 'notification');
    const serverRequest = once(client, 'server-request');
    assert.equal(await client.start(), true);
    assert.equal((await notification)[0].method, 'thread/name/updated');
    assert.equal((await serverRequest)[0].id, 99);
    client.respond(99, { decision: 'decline' });
    assert.deepEqual(await approvalReply, { decision: 'decline' });
    assert.deepEqual(await client.request('thread/list', { limit: 1 }), { data: [] });
    assert.equal(messages.some((msg) => msg.method === 'initialized'), true);
    assert.equal(client.ready, true);
    client.stop();
    assert.equal(client.ready, false);
    await assert.rejects(client.request('thread/list', {}), (error) => error.code === 'not-connected');
  } finally {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('PASS loopback WebSocket app-server transport');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
