// Explicit, one-shot probe against the designated native test task.
// Prints protocol metadata only; never logs message or tool content.
'use strict';

const { AppServerClient } = require('../../codex-bridge');

const url = process.argv[process.argv.indexOf('--attach') + 1];
const threadId = process.argv[process.argv.indexOf('--thread') + 1];
const effort = process.argv[process.argv.indexOf('--effort') + 1];
const mode = process.argv[process.argv.indexOf('--mode') + 1];
if (!/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(url || '')
  || !/^[0-9a-f-]{36}$/.test(threadId || '')
  || !['high', 'xhigh'].includes(effort)
  || !['question', 'restore'].includes(mode)) {
  console.error('Usage: node live-turn.cjs --attach ws://127.0.0.1:45678 --thread UUID --effort high|xhigh --mode question|restore');
  process.exit(2);
}

const prompt = mode === 'question'
  ? '共享连接联调：请使用提问工具问我“是否继续测试？”，选项“继续”和“停止”。收到“继续”后只回复“提问路由测试完成”。不要读写文件、运行命令或调用其他工具。'
  : '共享连接设置恢复测试：请只回复“已恢复高思考强度”。不要调用工具。';

async function main() {
  const client = new AppServerClient({ websocketUrl: url });
  let turnId = null;
  let completed = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const events = new Map();
  const started = Date.now();
  client.on('notification', (message) => {
    if (message.params?.threadId !== threadId) return;
    events.set(message.method, (events.get(message.method) || 0) + 1);
    if (message.method === 'turn/started') {
      turnId ||= message.params?.turn?.id;
      console.log(JSON.stringify({ phase: 'turn-started', elapsedMs: Date.now() - started }));
    }
    if (message.method === 'thread/settings/updated') {
      const settings = message.params?.threadSettings;
      console.log(JSON.stringify({ phase: 'settings', model: settings?.model, effort: settings?.effort, elapsedMs: Date.now() - started }));
    }
    if (message.method === 'turn/completed' && message.params?.turn?.id === turnId) {
      completed = true;
      finish();
    }
  });
  client.on('server-request', (message) => {
    if (message.params?.threadId !== threadId) return;
    const belongs = message.params?.turnId === turnId;
    console.log(JSON.stringify({ phase: 'server-request', method: message.method, belongs, elapsedMs: Date.now() - started }));
    if (!belongs) return;
    if (message.method === 'item/tool/requestUserInput' && mode === 'question') {
      const answers = Object.fromEntries((message.params?.questions || []).map((q) => [q.id, { answers: ['继续'] }]));
      client.respond(message.id, { answers });
      console.log(JSON.stringify({ phase: 'question-answered-by-probe', elapsedMs: Date.now() - started }));
    }
    // All other interactions remain with the native client; this probe cannot approve them.
  });
  try {
    if (!await client.start()) throw new Error('Shared app-server unavailable');
    const before = (await client.request('thread/read', { threadId, includeTurns: false })).thread;
    if (before.id !== threadId || before.status?.type !== 'idle' || before.originator !== 'Codex Desktop')
      throw new Error('Designated native task is not idle');
    await client.request('thread/resume', { threadId, excludeTurns: true });
    const response = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      model: before.model,
      effort,
    });
    turnId ||= response.turn?.id;
    console.log(JSON.stringify({ phase: 'accepted', model: before.model, requestedEffort: effort, elapsedMs: Date.now() - started }));
    let timer;
    try { await Promise.race([done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Turn did not complete in 240s')), 240_000);
    })]); } finally { clearTimeout(timer); }
    const after = (await client.request('thread/read', { threadId, includeTurns: false })).thread;
    console.log(JSON.stringify({ result: completed ? 'PASS' : 'INCOMPLETE', mode, model: after.model,
      effort: after.reasoningEffort, events: Object.fromEntries(events), elapsedMs: Date.now() - started }, null, 2));
  } finally {
    client.stop();
  }
}

main().catch((error) => { console.error(JSON.stringify({ result: 'FAIL', error: error.message })); process.exitCode = 1; });
