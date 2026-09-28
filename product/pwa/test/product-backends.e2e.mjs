import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { HostedGateway } from '../../server/gateway/src/hosted/gateway.ts';

const require = createRequire(import.meta.url);
const { TunnelClient } = require('../../pc/tunnel/client.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const { WebSocketServer } = createRequire(resolve(HERE, '../../server/gateway/package.json'))('ws');
const BASE_PATH = '/site-prefix/projects/dsh-link/pwa/';
const DIST = resolve('dist');
const TEMP = mkdtempSync(join(tmpdir(), 'batona-pwa-backends-'));
const adminKey = randomBytes(32).toString('hex');
const dshCalls = [];
const dshStreams = [];
const codexCalls = [];
const timestamp = Date.now();
const dshSessions = new Map([['dsh-fixture-session', { id: 'dsh-fixture-session', title: 'DSH Fixture Session', cwd: 'C:\\Projects\\DSH', updatedAt: timestamp }]]);
const dshWorkspace = { workspaceId: 'dsh-fixture-workspace', path: 'C:\\Projects\\DSH', title: 'DSH Fixture Workspace', sessionIds: ['dsh-fixture-session'], createdAt: new Date(timestamp).toISOString(), updatedAt: new Date(timestamp).toISOString() };
const codexSessions = new Map([['codex-fixture-session', { id: 'codex-fixture-session', title: 'Codex Fixture Session', cwd: 'C:\\Projects\\Codex', createdAt: timestamp, updatedAt: timestamp, state: 'done', model: 'fixture-model' }]]);
const codexWorkspace = { workspace: { workspaceId: 'codex-fixture-workspace', path: 'C:\\Projects\\Codex', title: 'Codex Fixture Workspace', createdAt: new Date(timestamp).toISOString() }, sessions: [{ sessionId: 'codex-fixture-session', title: 'Codex Fixture Session', state: 'done', updatedAt: timestamp }] };

const dshHost = createDshHost();
const dshAddress = await listen(dshHost.server);
const codexHost = createCodexHost();
const codexAddress = await listen(codexHost.server);
const directoryServer = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://local').searchParams.get('p') ?? '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path, roots: path ? [] : ['C:\\'], dirs: path ? [] : ['C:\\Projects'] }));
});
const directoryAddress = await listen(directoryServer);
const gateway = new HostedGateway({
  dataDir: TEMP,
  adminKey,
  vaultKey: randomBytes(32),
  webDir: '../server/gateway/web',
  mock: false,
});
const gatewayAddress = await listen(gateway.server);
const front = createFrontend(gatewayAddress.port);
const frontAddress = await listen(front);
const origin = `http://127.0.0.1:${frontAddress.port}`;
const account = await api(gatewayAddress.port, '/api/admin/create', { remark: 'PWA DSH/Codex fixture' }, adminKey);
const pc = await api(gatewayAddress.port, '/api/access/login', { key: account.key, deviceSecret: randomBytes(32).toString('hex'), name: 'DSH/Codex fixture PC' });
const tunnel = new TunnelClient({
  host: '127.0.0.1', gwPort: gatewayAddress.port, token: pc.token, tls: false,
  services: () => [
    { name: 'dsh', localPort: dshAddress.port },
    { name: 'dir', localPort: directoryAddress.port },
    { name: 'codex', localPort: codexAddress.port },
  ],
});

let context;
const browser = await chromium.launch({ headless: true });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PC tunnel did not connect')), 8000);
    tunnel.once('connected', () => { clearTimeout(timer); resolve(); });
    tunnel.once('error', error => { clearTimeout(timer); reject(error); });
    tunnel.start();
  });

  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 3 });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    window.__gatewaySocket = null;
    window.__sentFrames = [];
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    NativeWebSocket.prototype.send = function (data) {
      try { window.__sentFrames.push(JSON.parse(String(data))); } catch { /* ignore non-JSON frames */ }
      return nativeSend.call(this, data);
    };
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); window.__gatewaySocket = this; }
    };
  });
  const page = await context.newPage();
  const pair = await api(gatewayAddress.port, '/api/access/pair-open', {}, pc.token);
  await page.goto(origin + BASE_PATH);
  await page.getByRole('heading', { name: /把这部手机/ }).waitFor();
  await page.locator('#pair-code').fill(pair.code);
  await page.getByRole('button', { name: /申请配对/ }).click();
  await page.getByText(/等待电脑批准/).waitFor();
  const pending = await waitForPair(gatewayAddress.port, pair.pairId, pc.token);
  await api(gatewayAddress.port, '/api/access/pair-confirm', { pairId: pair.pairId, requestId: pending.requestId, allow: true }, pc.token);
  await page.getByRole('heading', { name: /工作还在继续/ }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'DSH', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Codex', exact: true }).waitFor();
  await page.getByText('DSH Fixture Workspace').waitFor({ timeout: 15000 });
  await page.getByText('DSH Fixture Session', { exact: true }).click();
  await page.getByRole('heading', { name: 'DSH Fixture Session' }).waitFor();
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.getByRole('button', { name: /在这里新建会话/ }).click();
  await page.getByLabel(/发送文字请求/).waitFor();
  await page.locator('#message-input').fill('DSH PWA fixture prompt');
  await page.getByRole('button', { name: '发送请求' }).click();
  await waitUntil(() => dshCalls.some(call => call.method === 'session/create') && dshCalls.some(call => call.method === 'session/prompt'));
  await page.getByRole('button', { name: '返回会话列表' }).click();

  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  await page.getByText('Codex Fixture Workspace').waitFor({ timeout: 15000 });
  await page.getByText('Codex Fixture Session', { exact: true }).click();
  await page.getByRole('heading', { name: 'Codex Fixture Session' }).waitFor();
  await page.getByText('Codex fixture history loaded.').waitFor();
  await page.getByRole('button', { name: '返回会话列表' }).click();
  await page.locator('[data-action="new-session"]').click();
  await page.getByLabel(/发送文字请求/).waitFor();
  await page.locator('#message-input').fill('Codex PWA fixture prompt');
  await page.getByRole('button', { name: '发送请求' }).click();
  await waitUntil(() => codexCalls.some(call => call.method === 'POST' && call.path === '/v1/sessions') && codexCalls.some(call => call.method === 'POST' && call.path.endsWith('/prompt')));

  const authCount = await page.evaluate(() => window.__sentFrames.filter(frame => frame.method === 'auth.hello').length);
  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 400 ? 30000 : delay, ...args);
    window.__gatewaySocket.close();
  });
  await page.waitForFunction(() => document.querySelector('#connection-state span')?.textContent === '连接中断');
  const serviceWorker = context.serviceWorkers().find(worker => worker.url().endsWith('/sw.js'));
  assert.ok(serviceWorker, 'product PWA service worker must be active');
  await serviceWorker.evaluate(async () => {
    const actualClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    Object.defineProperty(self.clients, 'matchAll', { configurable: true, value: async () => actualClients.map(client => ({ url: client.url, focus: async () => {}, postMessage: message => client.postMessage(message) })) });
    const waits = [];
    const event = new Event('notificationclick');
    Object.defineProperty(event, 'notification', { value: { data: { url: new URL('./', self.location).href }, close() {} } });
    event.waitUntil = promise => waits.push(promise);
    self.dispatchEvent(event);
    await Promise.all(waits);
  });
  await page.waitForFunction(count => window.__sentFrames.filter(frame => frame.method === 'auth.hello').length > count, authCount, { timeout: 10000 });
  await page.getByRole('heading', { name: 'Codex PWA Session' }).waitFor({ timeout: 10000 });
  assert.match(await page.locator('#app').innerText(), /CODEX/, 'notification reconnect must preserve the active Codex session and backend');

  assert.ok(dshCalls.some(call => call.method === 'session/list'), 'DSH adapter must list actual DSH fixture sessions');
  assert.ok(dshStreams.includes('session/follow'), 'DSH adapter must open the DSH event stream');
  assert.ok(codexCalls.some(call => call.method === 'GET' && call.path === '/v1/sessions'), 'Codex adapter must list actual Codex fixture sessions');
  assert.ok(codexCalls.some(call => call.method === 'GET' && call.path === '/v1/workspaces'), 'Codex adapter must load actual Codex fixture workspaces');
  console.log('PASS PWA product-backend E2E: Hosted Gateway tunnel, DSH/Codex discovery, session resume, create and prompt');
} finally {
  await context?.close();
  await browser.close();
  tunnel.stop();
  for (const server of [front, directoryServer, dshHost.server, codexHost.server]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await gateway.close();
  rmSync(TEMP, { recursive: true, force: true });
}

function createDshHost() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) { res.writeHead(404).end(); return; }
    void readJson(req).then(frame => {
      const method = new URL(req.url ?? '/', 'http://local').pathname.replace(/^\/api\//, '');
      const args = frame.payload?.args ?? {};
      dshCalls.push({ method, args });
      let value = {};
      if (method === 'session/list') value = { items: [...dshSessions.values()].map(session => ({
        sessionId: session.id,
        updatedAt: session.updatedAt,
        running: false,
        blank: false,
        cwd: session.cwd,
        projections: { asOfSeq: 0, values: { title: session.title } },
      })) };
      else if (method === 'session/create') {
        const id = `dsh-created-${dshSessions.size}`;
        const workspace = args.request?.workspaceId === dshWorkspace.workspaceId ? dshWorkspace : null;
        const session = { id, title: 'DSH PWA Session', cwd: workspace?.path ?? args.request?.cwd ?? 'C:\\Projects\\DSH', updatedAt: Date.now() };
        dshSessions.set(id, session);
        if (workspace && !workspace.sessionIds.includes(id)) workspace.sessionIds.push(id);
        value = { sessionId: id };
      } else if (method === 'session/modelCatalog') value = { groups: [] };
      else if (method === 'session/selectModel') value = { selected: { provider: args.request?.provider ?? 'fixture', model: args.request?.model ?? 'fixture' } };
      else if (method === 'session/prompt') value = { accepted: true };
      else if (method === 'session/rename') value = { title: args.request?.title ?? 'DSH PWA Session' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result: { ok: true, value } }));
    }).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  const mux = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => mux.handleUpgrade(req, socket, head, ws => mux.emit('connection', ws, req)));
  mux.on('connection', ws => ws.on('message', data => {
    let frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    if (frame.type !== 'open') return;
    dshStreams.push(frame.endpoint);
    let value;
    if (frame.endpoint === '$events') value = { type: 'ready', clientId: 'dsh-fixture-client', host: { home: 'C:\\Projects' } };
    else if (frame.endpoint === 'workspace/follow') value = { type: 'baseline', value: { items: [dshWorkspace], archivedSessionIds: [] } };
    else if (frame.endpoint === 'session/follow') {
      const id = frame.payload?.args?.request?.address?.sessionId;
      const session = dshSessions.get(id) ?? { id, title: 'DSH PWA Session', cwd: dshWorkspace.path, updatedAt: Date.now() };
      value = {
        type: 'snapshot',
        header: { version: 1, id: session.id, createdAt: session.updatedAt, cwd: session.cwd, isSeeded: false },
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 0, values: { title: session.title, permissions: { currentValue: 'workspace-write', options: [{ value: 'read-only' }, { value: 'workspace-write' }] } } },
        assistantStream: { revision: 0 },
      };
    }
    if (value) ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value }));
  }));
  return { server };
}

function createCodexHost() {
  const server = createServer((req, res) => {
    void readJson(req).catch(() => ({})).then(body => {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      codexCalls.push({ method, path, body });
      const id = path.split('/')[3];
      let value = {};
      if (method === 'GET' && path === '/v1/sessions') value = { threads: [...codexSessions.values()] };
      else if (method === 'GET' && path === '/v1/workspaces') value = { items: [codexWorkspace] };
      else if (method === 'GET' && path === '/v1/models') value = { items: [{ provider: 'openai', model: 'fixture-model', displayName: 'Fixture Model' }] };
      else if (method === 'GET' && path === '/v1/profiles') value = { items: [{ id: 'fixture-profile', name: 'Fixture Profile', available: true }] };
      else if (method === 'GET' && path.endsWith('/history')) value = { events: [{ type: 'assistant/message', text: 'Codex fixture history loaded.' }] };
      else if (method === 'POST' && path === '/v1/sessions') {
        const nextId = `codex-created-${codexSessions.size}`;
        const thread = { id: nextId, title: 'Codex PWA Session', cwd: body.cwd ?? codexWorkspace.workspace.path, createdAt: Date.now(), updatedAt: Date.now(), state: 'done', model: 'fixture-model' };
        codexSessions.set(nextId, thread);
        value = { thread };
      } else if (method === 'POST' && path.endsWith('/resume')) value = { thread: codexSessions.get(id) };
      else if (method === 'POST' && path.endsWith('/permission-menu')) value = { profileId: null };
      else if (method === 'POST' && path.endsWith('/permission')) value = { profileId: body.profileId };
      else if (method === 'POST' && path.endsWith('/name')) {
        const thread = codexSessions.get(id);
        if (thread) thread.title = body.name;
        value = { title: body.name };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    }).catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  const events = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => events.handleUpgrade(req, socket, head, ws => events.emit('connection', ws, req)));
  return { server };
}

function createFrontend(gatewayPort) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      const upstream = httpRequest({ hostname: '127.0.0.1', port: gatewayPort, path: req.url, method: req.method, headers: { ...req.headers, host: req.headers.host } }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream); return;
    }
    if (!url.pathname.startsWith(BASE_PATH)) { res.writeHead(404).end('not found'); return; }
    const relative = decodeURIComponent(url.pathname.slice(BASE_PATH.length));
    const file = resolve(DIST, relative || 'index.html');
    if (!file.startsWith(DIST + '\\') && file !== join(DIST, 'index.html')) { res.writeHead(404).end('not found'); return; }
    let body;
    try { body = readFileSync(file); } catch { res.writeHead(404).end('not found'); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': file.includes('assets\\') ? 'public, max-age=31536000, immutable' : 'no-cache', 'x-content-type-options': 'nosniff', 'permissions-policy': 'camera=(self), notifications=(self)' });
    res.end(body);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = connect(gatewayPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [name, value] of Object.entries({ ...req.headers, host: req.headers.host })) {
        if (Array.isArray(value)) lines.push(...value.map(entry => `${name}: ${entry}`));
        else if (value !== undefined) lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  return server;
}

async function api(port, path, body = {}, token = '') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(`${path} failed (${response.status}): ${result.error}`);
  return result;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

async function listen(server) {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address;
}

async function waitForPair(port, pairId, token) {
  let result;
  await waitUntil(async () => {
    result = await api(port, '/api/access/pair-status', { pairId }, token);
    return Boolean(result.pending?.requestId);
  });
  return result.pending;
}

async function waitUntil(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for product adapter fixture state');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
