// Isolated live probe for server-request ownership across two WS clients.
// Uses a throwaway task and archives it when complete; never logs task content.
'use strict';

const { AppServerClient } = require('../../codex-bridge');

const url = process.argv[process.argv.indexOf('--attach') + 1];
if (!/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(url || '')) {
  console.error('Usage: node request-route.cjs --attach ws://127.0.0.1:45678');
  process.exit(2);
}

async function main() {
  const clients = ['initiator', 'observer'].map(() => new AppServerClient({ websocketUrl: url }));
  const [initiator, observer] = clients;
  let threadId;
  let turnId;
  let turnDone;
  const finished = new Promise((resolve) => { turnDone = resolve; });
  const requests = [];
  const resolutions = [];
  const events = { initiator: new Map(), observer: new Map() };
  const started = Date.now();
  for (const [index, client] of clients.entries()) {
    const name = index ? 'observer' : 'initiator';
    client.on('notification', (message) => {
      if (message.params?.threadId !== threadId) return;
      events[name].set(message.method, (events[name].get(message.method) || 0) + 1);
      if (message.method === 'serverRequest/resolved') {
        resolutions.push({ receiver: name, requestId: String(message.params?.requestId),
          elapsedMs: Date.now() - started });
      }
      if (message.method === 'turn/completed' && message.params?.turn?.id === turnId) turnDone();
    });
    client.on('server-request', (message) => {
      if (message.params?.threadId !== threadId) return;
      requests.push({ receiver: name, requestId: String(message.id), method: message.method,
        turnMatches: message.params?.turnId === turnId,
        elapsedMs: Date.now() - started });
      if (!index && /requestApproval$/.test(message.method)) {
        // Give the observer a chance to see a broadcast before declining.
        setTimeout(() => client.respond(message.id, { decision: 'decline' }), 400);
      }
    });
  }
  try {
    if (!await initiator.start() || !await observer.start()) throw new Error('Shared app-server unavailable');
    const created = await initiator.request('thread/start', {
      cwd: process.cwd(), model: 'gpt-5.6-sol', serviceName: 'batona-shared-probe',
      sandbox: 'read-only', approvalPolicy: 'on-request',
    });
    threadId = created.thread.id;
    await initiator.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'isolated approval-routing probe' }] }] });
    await observer.request('thread/resume', { threadId, excludeTurns: true });
    const startedTurn = await initiator.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '联调测试：请使用终端在 output/.shared-transport-probe/approval-ownership-test.txt 创建空文件。若只读沙箱阻止写入，请申请一次权限并等待结果；被拒绝后直接回复“审批路由测试结束”。不要读取其他文件或执行其他操作。' }],
      model: 'gpt-5.6-sol', effort: 'low', approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    turnId = startedTurn.turn.id;
    let timer;
    try { await Promise.race([finished, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Turn did not complete in 180s')), 180_000);
    })]); } finally { clearTimeout(timer); }
    console.log(JSON.stringify({ result: requests.length ? 'REQUEST_OBSERVED' : 'NO_REQUEST',
      requests, resolutions,
      events: Object.fromEntries(Object.entries(events).map(([k, v]) => [k, Object.fromEntries(v)])),
      elapsedMs: Date.now() - started }, null, 2));
  } finally {
    if (threadId) {
      try {
        const current = (await initiator.request('thread/read', { threadId, includeTurns: false })).thread;
        if (current.status?.type === 'active') await initiator.request('turn/interrupt', { threadId, turnId: turnId || '' });
        await initiator.request('thread/archive', { threadId });
      } catch (error) { console.error(`Probe cleanup failed: ${error.message}`); process.exitCode = 1; }
    }
    for (const client of clients) client.stop();
  }
}

main().catch((error) => { console.error(JSON.stringify({ result: 'FAIL', error: error.message })); process.exitCode = 1; });
