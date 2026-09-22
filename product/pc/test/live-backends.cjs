// Diagnostic only: list existing sessions and open one; never send a prompt.
// Credentials stay in process memory. Output only counts, status and error codes.
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  let failed = false;
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`); failed ||= !ok; };
  const cached = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Batona PC', 'dsh-token.json'), 'utf8'));
  const base = `http://127.0.0.1:${cached.port || 3080}`;
  const login = await fetch(`${base}/?token=${encodeURIComponent(cached.token)}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  const list = await fetch(`${base}/api/session/list`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: 'diagnostic-list', method: 'session/list', payload: { args: { _request: {} } } }), signal: AbortSignal.timeout(10000) });
  const dsh = await list.json().catch(() => ({}));
  check('DSH cached-token session list', list.ok && dsh.result?.ok === true, { http: list.status, cookie: !!cookie, code: dsh.result?.error?.code });
  const threads = await fetch('http://127.0.0.1:3082/v1/sessions').then(r => r.json());
  check('Codex session list', threads.threads?.length > 0, { count: threads.threads?.length });
  const thread = threads.threads?.find(t => t.status?.type !== 'active') || threads.threads?.[0];
  if (thread) {
    const resumed = await fetch(`http://127.0.0.1:3082/v1/sessions/${encodeURIComponent(thread.id)}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
    const body = await resumed.json();
    check('Codex open existing conversation', resumed.ok && !!body.thread, { http: resumed.status, code: body.error?.code, message: body.error?.message?.replace(/(?:[A-Z]:\\|\/)[^\s]+/g, '<path>').slice(0, 400) });
    const history = await fetch(`http://127.0.0.1:3082/v1/sessions/${encodeURIComponent(thread.id)}/history`).then(r => r.json());
    check('Codex history', Array.isArray(history.events) && history.events.length > 0, { count: history.events?.length, code: history.error?.code });
  }
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error('FAIL diagnostic transport', e.code || e.name); process.exitCode = 1; });
