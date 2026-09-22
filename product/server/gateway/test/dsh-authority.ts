import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { DshApiClient } from '../src/adapter/dsh/client.ts';
import { DshRemoteMux } from '../src/adapter/dsh/streams.ts';

const seen: string[] = [];
const server = createServer((req, res) => {
  seen.push(req.headers.host ?? '');
  if (req.url?.startsWith('/?token=')) { res.writeHead(303, { 'set-cookie': 'fixture=authenticated; HttpOnly' }); res.end(); }
  else { assert.equal(req.headers.cookie, 'fixture=authenticated'); res.end(JSON.stringify({ result: { ok: true, value: {} } })); }
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => { seen.push(req.headers.host ?? ''); assert.equal(req.headers.cookie, 'fixture=authenticated'); ws.close(); });
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const addr = server.address(); assert(addr && typeof addr !== 'string');
const baseUrl = `http://127.0.0.1:${addr.port}`, authority = '127.0.0.1:3080';
const client = new DshApiClient({ baseUrl, authority, authToken: 'synthetic-fixture' });
const mux = new DshRemoteMux(baseUrl, { authority, getCookie: () => client.getCookie(), onUnauthorized: async () => {} });
try {
  assert((await client.call('workspace/list')).ok);
  const connected = new Promise<void>(r => wss.once('connection', () => r())); mux.start(); await connected;
  assert.deepEqual(seen, [authority, authority, authority]);
  console.log('PASS DSH cookie exchange, HTTP and WebSocket keep the PC authority across dynamic tunnel ports');
} finally { await mux.stop(); wss.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
