// Throwaway transport probe. Live mode reads the user's profile but never loads a thread.
// Run: node product/pc/tools/shared-transport-probe/probe.cjs
// Read-only live-profile check: --live-readonly starts a server; --attach URL joins one.
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { CodexBridge } = require('../../codex-bridge');

const timeout = (ms, label) => new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms));

function findCodex() {
  if (process.env.BATONA_CODEX_EXE) return process.env.BATONA_CODEX_EXE;
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  const matches = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(base, entry.name, 'codex.exe'))
    .filter(file => fs.existsSync(file));
  if (!matches.length) throw new Error('No accessible Codex CLI binary found; set BATONA_CODEX_EXE');
  return matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

class Client {
  constructor(socket, name) {
    this.socket = socket;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    socket.addEventListener('message', event => this.receive(JSON.parse(String(event.data))));
  }

  receive(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${this.name} ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    if (!message.method) return;
    this.events.push(message);
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(message)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return Promise.race([
      new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.socket.send(JSON.stringify({ id, method, params }));
      }),
      timeout(8000, `${this.name} ${method}`),
    ]).finally(() => this.pending.delete(id));
  }

  notify(method, params = {}) {
    this.socket.send(JSON.stringify({ method, params }));
  }

  event(method, match = () => true) {
    const predicate = message => message.method === method && match(message.params);
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return Promise.race([
      new Promise(resolve => this.waiters.push({ match: predicate, resolve })),
      timeout(1500, `${this.name} ${method} event`),
    ]);
  }

  close() {
    this.socket.close();
  }
}

async function connect(url, name) {
  const socket = await Promise.race([
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(ws), { once: true });
      ws.addEventListener('error', () => reject(new Error(`WebSocket unavailable for ${name}`)), { once: true });
    }),
    timeout(2000, `${name} connect`),
  ]);
  const client = new Client(socket, name);
  await client.request('initialize', { clientInfo: { name: `batona_probe_${name}`, title: 'Batona Shared Transport Probe', version: '0.0.0' } });
  client.notify('initialized');
  return client;
}

async function main() {
  const attachIndex = process.argv.indexOf('--attach');
  const attachUrl = attachIndex >= 0 ? process.argv[attachIndex + 1] : null;
  const threadIndex = process.argv.indexOf('--thread');
  const observeThreadId = threadIndex >= 0 ? process.argv[threadIndex + 1] : null;
  const testAttach = process.argv.includes('--test-attach');
  if (attachIndex >= 0 && !attachUrl) throw new Error('--attach requires a loopback WebSocket URL');
  if (threadIndex >= 0 && (!attachUrl || !/^[0-9a-f-]{36}$/.test(observeThreadId || '')))
    throw new Error('--thread requires --attach and a thread UUID');
  const liveReadOnly = process.argv.includes('--live-readonly') || Boolean(attachUrl) || testAttach;
  let scratch = null;
  if (!liveReadOnly) {
    const scratchBase = path.join(process.cwd(), 'output', '.shared-transport-probe');
    fs.mkdirSync(scratchBase, { recursive: true });
    scratch = fs.mkdtempSync(path.join(scratchBase, 'run-'));
  }
  let bridge = attachUrl ? new CodexBridge({ port: 0, websocketUrl: attachUrl, nativeControl: { warm() {} } }) : null;
  const port = attachUrl ? null : await unusedPort();
  const url = bridge?.appServer.websocketUrl || `ws://127.0.0.1:${port}`;
  const child = attachUrl ? null : spawn(findCodex(),
    ['-c', 'features.code_mode_host=true', 'app-server', '--listen', url, '--analytics-default-enabled'], {
      cwd: process.cwd(),
      env: liveReadOnly ? { ...process.env } : { ...process.env, CODEX_HOME: scratch },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  child?.stderr.on('data', () => {});
  let a;
  let b;
  try {
    let lastError;
    for (let attempt = 0; attempt < 40 && !a; attempt++) {
      try { a = await connect(url, 'a'); }
      catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!a) throw lastError || new Error('App server did not start');
    if (testAttach) {
      const attached = spawnSync(process.execPath, [__filename, '--attach', url], {
        cwd: process.cwd(), windowsHide: true, encoding: 'utf8', timeout: 30_000,
      });
      if (attached.error || attached.status !== 0) throw new Error(`Attach mode failed: ${attached.error?.message || attached.stderr || attached.status}`);
      const result = JSON.parse(attached.stdout);
      console.log(JSON.stringify({ ...result, mode: 'test-attach', sharedServerReused: true }, null, 2));
      return;
    }
    if (liveReadOnly) {
      bridge ||= new CodexBridge({ port: 0, websocketUrl: url, nativeControl: { warm() {} } });
      if (!await bridge.start() || !bridge.appServer.ready) throw new Error('Batona WebSocket bridge did not initialize');
      const bridgeUrl = `http://127.0.0.1:${bridge.server.address().port}`;
      const responses = await Promise.all(['/healthz', '/v1/sessions', '/v1/models', '/v1/profiles']
        .map(async (endpoint) => {
          const response = await fetch(`${bridgeUrl}${endpoint}`);
          return { status: response.status, body: await response.json() };
        }));
      const blockedWrite = await fetch(`${bridgeUrl}/v1/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const blockedWriteBody = await blockedWrite.json();
      let subscribed = null;
      if (observeThreadId) {
        const opened = await fetch(`${bridgeUrl}/v1/sessions/${observeThreadId}/resume`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        const openedBody = await opened.json();
        subscribed = opened.status === 200 && openedBody.thread?.id === observeThreadId;
      }
      const checks = {
        mode: attachUrl ? 'attach-readonly' : 'live-readonly',
        codeModeHost: attachUrl ? 'unknown' : true,
        health: responses[0].status === 200 && responses[0].body.ok === true,
        threadListReadable: responses[1].status === 200 && Array.isArray(responses[1].body.threads),
        modelsAvailable: responses[2].status === 200 && responses[2].body.items.length > 0,
        profilesReadable: responses[3].status === 200 && Array.isArray(responses[3].body.items),
        writesBlocked: blockedWrite.status === 400 && blockedWriteBody.error?.code === 'shared-transport-readonly',
        ...(observeThreadId ? { subscribed } : {}),
        nativeDesktopAttached: attachUrl ? 'unverified' : false,
      };
      const passed = checks.health && checks.threadListReadable && checks.modelsAvailable
        && checks.profilesReadable && checks.writesBlocked && subscribed !== false;
      console.log(JSON.stringify({ result: passed ? 'PASS' : 'FAIL', ...checks }, null, 2));
      if (!passed) process.exitCode = 1;
      return;
    }
    b = await connect(url, 'b');
    const started = await a.request('thread/start', { cwd: process.cwd() });
    const threadId = started.thread.id;
    // A fresh thread has no rollout file until it receives an item. Persist one
    // inert item without invoking a model or touching any existing user thread.
    await a.request('thread/inject_items', {
      threadId,
      items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'isolated transport probe' }] }],
    });
    await b.request('thread/resume', { threadId });

    const nameA = 'Batona A';
    await a.request('thread/name/set', { threadId, name: nameA });
    const bEvent = await b.event('thread/name/updated', params => params.threadId === threadId && params.threadName === nameA).catch(() => null);
    const bRead = await b.request('thread/read', { threadId, includeTurns: false });
    const nameB = 'Batona B';
    await b.request('thread/name/set', { threadId, name: nameB });
    const aEvent = await a.event('thread/name/updated', params => params.threadId === threadId && params.threadName === nameB).catch(() => null);

    const read = await a.request('thread/read', { threadId, includeTurns: false });
    const result = {
      result: bRead.thread.name === nameA && read.thread.name === nameB ? 'PASS' : 'FAIL',
      sameProcess: true,
      twoClients: true,
      bReadAName: bRead.thread.name === nameA,
      aReadBName: read.thread.name === nameB,
      bSawANameEvent: Boolean(bEvent),
      aSawBNameEvent: Boolean(aEvent),
      crossClientEvents: Boolean(bEvent && aEvent),
      aEventMethods: [...new Set(a.events.map(event => event.method))],
      bEventMethods: [...new Set(b.events.map(event => event.method))],
      aNameEvents: a.events.filter(event => event.method === 'thread/name/updated').map(event => event.params),
      bNameEvents: b.events.filter(event => event.method === 'thread/name/updated').map(event => event.params),
      modelTurnTested: false,
      nativeDesktopAttached: false,
      scratch,
    };
    console.log(JSON.stringify(result, null, 2));
    if (result.result !== 'PASS') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ result: 'FAIL', error: error.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await bridge?.stop();
    a?.close();
    b?.close();
    if (child) {
      child.kill();
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    }
    // Keep isolated scratch state for inspection. It is under ignored output/.
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
