/**
 * test/probe-live.ts — 适配器 ↔ 真实 DSH 的回归探针（协议迁移/DSH 升级后先跑这个）
 *
 * 用法：node test/probe-live.ts <launch-token> [baseUrl] [mode]
 *   mode = basic（默认）| approval | question
 * 例：node test/probe-live.ts batona_xxx http://127.0.0.1:3080 basic
 *
 * 注意：必须显式传 token（DSH 0.1.2+ 的 /api 强制会话认证），会真实调用模型，故不进 CI。
 */

import { DshAdapter } from '../src/adapter/dsh/adapter.ts';
import type { AgentEvent } from '../src/adapter/contract.ts';

const token = process.argv[2] ?? '';
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:3099';
const mode = process.argv[4] ?? 'basic';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  !!  ${name} ${detail}`); }
}

const adapter = new DshAdapter();
const seen: string[] = [];
const waiters: { pred: (t: string, e: unknown) => boolean; resolve: (e: unknown) => void }[] = [];

adapter.onEvent((sid, ev) => {
  seen.push(`${sid.slice(0, 8)} ${ev.type}`);
  const line = JSON.stringify(ev);
  console.log(`EV ${sid.slice(0, 8)} ${ev.type} ${line.length > 220 ? `${line.slice(0, 220)}…` : line}`);
  for (const w of [...waiters]) {
    if (w.pred(sid, ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
  }
});
function waitSettled(timeoutMs = 180000): Promise<AgentEvent | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting turn settle')), timeoutMs);
    waiters.push({
      pred: (_s, e) => { const t = (e as { type: string }).type; return t === 'turn/end' || t === 'approval/requested' || t === 'question/requested'; },
      resolve: (e) => { clearTimeout(timer); resolve(e as AgentEvent); },
    });
  });
}

console.log(`[probe] baseUrl=${baseUrl} token=${token ? `${token.slice(0, 6)}…` : '(none)'}`);
check('connect 成功', await adapter.connect({ baseUrl, authToken: token }));

const models = await adapter.listModels();
check('session/modelCatalog 返回模型', models.length > 0, JSON.stringify(models).slice(0, 200));
console.log('  models:', models.map((m) => `${m.provider}/${m.model}`).join(', ').slice(0, 300));

const workspaces = await adapter.listWorkspaces();
check('workspace/follow 基线返回工作区', Array.isArray(workspaces), `count=${workspaces.length}`);
console.log('  workspaces:', workspaces.map((w) => w.path).join(' | ').slice(0, 300));

const sessions = await adapter.listSessions();
check('session/list 返回会话', Array.isArray(sessions), `count=${sessions.length}`);

const ws = await adapter.createWorkspace('D:\\_Projects\\26-009DSHplugin');
check('workspace/create 成功', !!ws.workspace.workspaceId, JSON.stringify(ws).slice(0, 200));
console.log('  workspace:', ws.workspace.workspaceId, ws.workspace.path, `created=${ws.created}`);

const ref = await adapter.createSession({ title: 'probe', workspaceId: ws.workspace.workspaceId, workspacePath: 'D:\\_Projects\\26-009DSHplugin' });
check('session/create 返回 sessionId', !!ref.backendSessionId, JSON.stringify(ref));
console.log('  sessionId:', ref.backendSessionId);

const tree = await adapter.workspaceTree();
const node = tree.items.find((i) => i.workspace.workspaceId === ws.workspace.workspaceId);
check('workspaceTree 含新会话', !!node?.sessions.some((s) => s.sessionId === ref.backendSessionId), JSON.stringify(node?.sessions).slice(0, 300));

// 模型选择
if (process.argv[5]) {
  const wanted = models.find((m) => m.model === process.argv[5]);
  if (wanted) { await adapter.selectModel(ref, wanted); console.log('  selectModel ok:', wanted.model); }
}

const PROMPTS: Record<string, string> = {
  basic: '只回复两个字：你好',
  approval: '请用 pwsh 工具在 C:\\Users\\QH\\dsh-probe-approval\\out.txt 创建目录并写入 ok（必须使用该工作区之外的绝对路径），然后告诉我结果。',
  question: '请调用提问工具向我提问：你更喜欢哪个？给出两个选项。',
};
await adapter.prompt(ref, [{ type: 'text', text: PROMPTS[mode] ?? PROMPTS.basic ?? '' }]);
console.log('[probe] prompt 已受理，等待事件…');

const settled = await waitSettled();
const settledType = settled?.type ?? '';
console.log(`[probe] 首个终态事件：${settledType}`);
check('回合产生了 turn/start', seen.some((s) => s.endsWith('turn/start')), seen.join(' | '));

if (settledType === 'approval/requested' || settledType === 'question/requested') {
  const ev = settled as { rpcId?: string };
  if (!ev.rpcId) throw new Error('interaction frame without rpcId');
  if (settledType === 'approval/requested') {
    await adapter.respond(ref, ev.rpcId, { outcome: 'allowed-once' });
    console.log('[probe] 已应答 approval=allowed-once');
  } else {
    const opts = (settled as { questions?: { options?: { id: string }[] }[] }).questions?.[0]?.options ?? [];
    await adapter.respond(ref, ev.rpcId, opts.length ? { selected: [opts[0]!.id] } : { custom: 'probe-answer' });
    console.log(`[probe] 已应答 question selected=${opts[0]?.id ?? '(custom)'}`);
  }
  await waitSettled();
}

if (mode === 'approval') {
  const chain = await adapter.history(ref);
  const ok = chain.some((e) => e.type === 'tool/call');
  check('history 含 tool/call', ok, JSON.stringify(chain.map((e) => e.type)));
  console.log('  history types:', chain.map((e) => e.type).join(','));
}

const hist = await adapter.history(ref);
check('history 返回事件', hist.length > 0, `count=${hist.length}`);
console.log('  history:', JSON.stringify(hist).slice(0, 600));

await adapter.dispose();
console.log(`\n[probe] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
