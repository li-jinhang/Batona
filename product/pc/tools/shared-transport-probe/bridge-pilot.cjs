// One-shot HTTP/WS pilot through the Batona bridge to an explicit native test task.
// Requires both --attach and --thread; does not change the installed PC app.
'use strict';

const { WebSocket } = require('ws');
const { CodexBridge } = require('../../codex-bridge');

const url = process.argv[process.argv.indexOf('--attach') + 1];
const threadId = process.argv[process.argv.indexOf('--thread') + 1];
if (!/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(url || '') || !/^[0-9a-f-]{36}$/.test(threadId || '')) {
  console.error('Usage: node bridge-pilot.cjs --attach ws://127.0.0.1:45678 --thread UUID');
  process.exit(2);
}

async function main() {
  const bridge = new CodexBridge({ port: 0, websocketUrl: url, enableSharedWrites: true,
    nativeControl: { warm() {}, send() { throw new Error('Native UI path must not be used'); } } });
  let socket;
  const started = Date.now();
  try {
    if (!await bridge.start() || !bridge.appServer.ready) throw new Error('Bridge unavailable');
    const base = `http://127.0.0.1:${bridge.server.address().port}`;
    const open = await fetch(`${base}/v1/sessions/${threadId}/resume`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!open.ok || (await open.json()).thread?.id !== threadId) throw new Error('Native task did not open');
    const before = (await bridge.appServer.request('thread/read', { threadId, includeTurns: false })).thread;
    if (before.originator !== 'Codex Desktop' || before.status?.type !== 'idle')
      throw new Error('Designated native task is not idle');
    socket = new WebSocket(`${base.replace('http:', 'ws:')}/v1/events`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const events = new Map();
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.type !== 'agent-event' || message.threadId !== threadId) return;
      const kind = message.event?.type;
      events.set(kind, (events.get(kind) || 0) + 1);
      if (kind === 'turn/end') finish();
    });
    const sent = await fetch(`${base}/v1/sessions/${threadId}/prompt`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '共享桥 HTTP 联调：请只回复“桥接成功”。不要调用工具。' }) });
    if (!sent.ok || (await sent.json()).accepted !== true) throw new Error('Bridge prompt rejected');
    const acceptedMs = Date.now() - started;
    let timer;
    try { await Promise.race([completed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Turn did not complete in 180s')), 180_000);
    })]); } finally { clearTimeout(timer); }
    const history = await bridge.history(threadId);
    const replyVisible = history.some((event) => event.type === 'assistant/message' && event.text === '桥接成功');
    console.log(JSON.stringify({ result: replyVisible ? 'PASS' : 'FAIL', acceptedMs,
      elapsedMs: Date.now() - started, replyVisible, events: Object.fromEntries(events) }, null, 2));
    if (!replyVisible) process.exitCode = 1;
  } finally {
    socket?.close();
    await bridge.stop();
  }
}

main().catch((error) => { console.error(JSON.stringify({ result: 'FAIL', error: error.message })); process.exitCode = 1; });
