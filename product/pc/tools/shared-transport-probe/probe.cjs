// Throwaway transport probe. Never points at the user's live Codex home or threads.
// Run: node product/pc/tools/shared-transport-probe/probe.cjs
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

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
  const scratchBase = path.join(process.cwd(), 'output', '.shared-transport-probe');
  fs.mkdirSync(scratchBase, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchBase, 'run-'));
  const port = await unusedPort();
  const exe = findCodex();
  const url = `ws://127.0.0.1:${port}`;
  const child = spawn(exe, ['app-server', '--listen', url], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HOME: scratch },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => {});
  let a;
  let b;
  try {
    let lastError;
    for (let attempt = 0; attempt < 40 && !a; attempt++) {
      try { a = await connect(url, 'a'); }
      catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!a) throw lastError || new Error('App server did not start');
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
    a?.close();
    b?.close();
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    // Keep isolated scratch state for inspection. It is under ignored output/.
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
