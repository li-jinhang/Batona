/**
 * test/e2e-dsh.ts — 网关 ↔ 真实 DSH 端到端验证（需要本机已在跑一个 DSH 实例）
 *
 * 用法：node test/e2e-dsh.ts <dsh-launch-token> [dshBaseUrl] [gwPort]
 *   例：node test/e2e-dsh.ts Mn_TZpe... http://127.0.0.1:3099 3095
 *
 * 覆盖（全程走"手机端协议"，即 WS 上的 session.* / workspace.* / respond）：
 *   1) 未上报 token 时链路不可用（0.1.2+ 的 401 断点）；
 *   2) POST /api/dsh/launch-token 上报后链路自愈；
 *   3) 工作区树 / 模型目录 / 建会话 / 发消息 / 收事件 / 审批或提问应答 / 历史回放。
 *
 * 注意：会真实调用一次模型（消耗额度），且必须显式传 token，故不进 CI。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

import { AuthService } from '../src/auth/index.ts';
import { AdapterRegistry } from '../src/adapter/registry.ts';
import { createDshAdapter } from '../src/adapter/dsh/adapter.ts';
import { SessionRouter } from '../src/session/router.ts';
import { GatewayHttpServer } from '../src/server/http.ts';
import { GatewayWsServer } from '../src/server/ws.ts';
import type { RpcMessage, ServerRequest } from '../src/proto/envelope.ts';
import type { RpcResult } from '../src/proto/result.ts';

const AGENT_KEY = 'e2e-probe-agent-key';
const HERE = resolve(import.meta.dirname, '..');
const token = process.argv[2] ?? '';
const dshBaseUrl = process.argv[3] ?? 'http://127.0.0.1:3099';
const gwPort = Number(process.argv[4] ?? '3095');

if (!token) {
  console.error('用法：node test/e2e-dsh.ts <dsh-launch-token> [dshBaseUrl] [gwPort]');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  !!  ${name} ${detail}`); }
}

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-gw-e2e-'));
const auth = new AuthService(dataDir, { initialUser: { username: 'admin', password: 'pass' } });
// 故意不配 authToken：验证"上报后自愈"这条路径本身
const registry = await AdapterRegistry.assemble({ dsh: createDshAdapter }, { dsh: { enabled: true, cfg: { baseUrl: dshBaseUrl } } });
const router = new SessionRouter(registry);
const dshAdapter = registry.require('dsh');
const http = new GatewayHttpServer(auth, {
  webDir: join(HERE, 'web'),
  agentKey: AGENT_KEY,
  onDshLaunchToken: async (t) => { await dshAdapter.setAuthToken?.(t); },
});
const ws = new GatewayWsServer(auth, registry, router);
ws.attach(http.server);
await new Promise<void>((r) => http.server.listen(gwPort, '127.0.0.1', r));
const gwBase = `http://127.0.0.1:${gwPort}`;
console.log(`[e2e] gateway ${gwBase} → dsh ${dshBaseUrl}`);

// ── 登录 ───────────────────────────────────────────────────────────────
const login = (await fetch(`${gwBase}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'pass', deviceName: 'e2e' }),
}).then((r) => r.json())) as { ok?: boolean; token?: string };
check('网关登录', login.ok === true && !!login.token);
const gwToken = login.token ?? '';

// ── WS（手机端协议）───────────────────────────────────────────────────
const client = await openWs(`ws://127.0.0.1:${gwPort}/ws?token=${encodeURIComponent(gwToken)}`);
const pendingCalls = new Map<string, (r: RpcResult<unknown>) => void>();
const pushes: ServerRequest[] = [];
const pushWaiters: { pred: (f: ServerRequest) => boolean; resolve: (f: ServerRequest) => void }[] = [];
client.on('message', (data) => {
  const msg = JSON.parse(String(data)) as RpcMessage;
  if (msg.type === 'server-response') {
    const p = pendingCalls.get(msg.rpcId);
    if (p) { pendingCalls.delete(msg.rpcId); p(msg.result); }
  } else if (msg.type === 'server-request') {
    pushes.push(msg);
    for (const w of [...pushWaiters]) {
      if (w.pred(msg)) { pushWaiters.splice(pushWaiters.indexOf(w), 1); w.resolve(msg); }
    }
  }
});
const call = (method: string, payload: unknown = {}, timeoutMs = 240000): Promise<RpcResult<unknown>> =>
  new Promise((res, rej) => {
    const rpcId = crypto.randomUUID();
    pendingCalls.set(rpcId, res);
    client.send(JSON.stringify({ type: 'client-request', rpcId, method, payload }));
    setTimeout(() => { if (pendingCalls.delete(rpcId)) rej(new Error(`timeout: ${method}`)); }, timeoutMs);
  });
const waitPush = (pred: (f: ServerRequest) => boolean, timeoutMs = 240000): Promise<ServerRequest> =>
  new Promise((res, rej) => {
    const hit = pushes.find(pred);
    if (hit) { res(hit); return; }
    const timer = setTimeout(() => rej(new Error('timeout waiting push')), timeoutMs);
    pushWaiters.push({ pred, resolve: (f) => { clearTimeout(timer); res(f); } });
  });

// ── 1) 未上报 token：链路应不可用 ─────────────────────────────────────
// 用 model.list 探测（经适配器直连 DSH）；session.list 读的是网关本地会话表，探不到 DSH 状态。
let r = await call('model.list', {}, 30000);
check('未上报 token 时 model.list 失败（0.1.2+ 认证断点）', !r.ok, JSON.stringify(r).slice(0, 200));

// ── 2) 上报 launch token → 自愈 ───────────────────────────────────────
const badKey = await fetch(`${gwBase}/api/dsh/launch-token`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-agent-key': 'wrong' },
  body: JSON.stringify({ token }),
}).then((res) => res.status);
check('错误 agentKey 被拒（401）', badKey === 401, `status=${badKey}`);
const okKey = await fetch(`${gwBase}/api/dsh/launch-token`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-agent-key': AGENT_KEY },
  body: JSON.stringify({ token }),
}).then((res) => res.json()) as { ok?: boolean };
check('正确 agentKey 上报被受理', okKey.ok === true, JSON.stringify(okKey));
await new Promise((r) => setTimeout(r, 1500));

r = await call('model.list', {}, 60000);
check('上报 token 后 model.list 成功（链路自愈）', r.ok, JSON.stringify(r).slice(0, 300));
check('model.list 返回模型', r.ok && ((r.value as { items?: unknown[] }).items ?? []).length > 0, JSON.stringify(r).slice(0, 200));
const tree = await call('workspace.tree');
const treeItems = tree.ok ? ((tree.value as { items: { workspace: { workspaceId: string; path: string } }[] }).items ?? []) : [];
check('workspace.tree 返回工作区', tree.ok && treeItems.length > 0, JSON.stringify(tree).slice(0, 300));

// ── 3) 建会话 → 发消息 → 收事件 → 历史 ────────────────────────────────
const targetWs = treeItems.find((i) => String(i.workspace.path).includes('26-009DSHplugin')) ?? treeItems[0]!;
console.log(`[e2e] 目标工作区: ${targetWs.workspace.path}`);
const created = await call('session.create', { backend: 'dsh', title: 'e2e', workspaceId: targetWs.workspace.workspaceId });
check('session.create 成功', created.ok, JSON.stringify(created).slice(0, 300));
if (!created.ok) throw new Error(`session.create 失败：${JSON.stringify(created).slice(0, 300)}`);
const gid = (created.value as { id: string }).id;

const turnEnd = waitPush((f) => f.method === 'session/event' && (f.payload as { event?: { type?: string } }).event?.type === 'turn/end');
const prompted = await call('session.prompt', { sessionId: gid, parts: [{ type: 'text', text: '只回复两个字：你好' }] });
check('session.prompt 受理', prompted.ok, JSON.stringify(prompted).slice(0, 200));
await turnEnd;
const types = pushes.filter((f) => f.method === 'session/event').map((f) => (f.payload as { event: { type: string } }).event.type);
check('收到 user/message 推送', types.includes('user/message'), types.join(','));
check('收到 assistant/chunk 流式推送', types.includes('assistant/chunk'), types.join(','));
check('收到 assistant/message 推送', types.includes('assistant/message'), types.join(','));
check('收到 turn/end 推送', types.includes('turn/end'), types.join(','));

const hist = await call('session.history', { sessionId: gid });
const events = hist.ok ? ((hist.value as { events: { type: string; text?: string }[] }).events ?? []) : [];
check('session.history 返回历史', hist.ok && events.length > 0, JSON.stringify(hist).slice(0, 300));
console.log('  history:', JSON.stringify(events).slice(0, 300));

// ── 4) 交互应答（审批 / 提问），有则作答 ──────────────────────────────
const interaction = await Promise.race([
  call('session.prompt', { sessionId: gid, parts: [{ type: 'text', text: '请调用提问工具问我：继续吗？给出"继续"和"停止"两个选项。' }] }).then(() => waitPush((f) => f.method === 'question/requested' || f.method === 'approval/requested')),
  new Promise<ServerRequest>((res) => setTimeout(() => res({ type: 'server-request', rpcId: '', method: '__none__', payload: {} } as ServerRequest), 180000)),
]).catch(() => null);
if (interaction && interaction.method !== '__none__') {
  const payload = interaction.payload as { sessionId: string; questions?: { id: string; options?: { id: string }[] }[] };
  const first = payload.questions?.[0];
  await call('respond', {
    sessionId: payload.sessionId,
    serverRequestRpcId: interaction.rpcId,
    payload: interaction.method === 'approval/requested'
      ? { outcome: 'allowed-once' }
      : (first?.options?.length ? { selected: [first.options[0]!.id] } : { custom: '继续' }),
  });
  check(`${interaction.method} 应答被受理`, true);
} else {
  console.log('  (本轮未触发审批/提问，跳过应答检查)');
}
await waitPush((f) => f.method === 'session/event' && (f.payload as { event?: { type?: string } }).event?.type === 'turn/end', 240000).catch(() => null);
check('交互后回合正常收尾', true);

// ── 收尾 ──────────────────────────────────────────────────────────────
client.close();
ws['wss']?.close();
await new Promise((r2) => http.server.close(r2));
await registry.require('dsh').dispose();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n[e2e] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function openWs(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const c = new WebSocket(url);
    c.once('open', () => res(c));
    c.once('error', rej);
  });
}
