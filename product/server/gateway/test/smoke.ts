/**
 * test/smoke.ts — 冒烟测试（Mock 适配器端到端）
 *
 * 覆盖：登录 → WS 认证 → 建会话 → 对话 → 审批应答 → 提问应答 →
 *       工作区 → 模型 → 断线重连 → 未认证拒绝。
 *
 * 运行：node test/smoke.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';

import { AuthService } from '../src/auth/index.ts';
import { AdapterRegistry } from '../src/adapter/registry.ts';
import { createMockAdapter } from '../src/adapter/mock/adapter.ts';
import { SessionRouter } from '../src/session/router.ts';
import { GatewayHttpServer } from '../src/server/http.ts';
import { GatewayWsServer } from '../src/server/ws.ts';
import type { RpcMessage, ServerRequest } from '../src/proto/envelope.ts';
import type { RpcResult } from '../src/proto/result.ts';

const HERE = resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name} ${detail}`); }
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-gw-smoke-'));
  const auth = new AuthService(dataDir, { initialUser: { username: 'admin', password: 'pass' } });
  const registry = await AdapterRegistry.assemble({ mock: createMockAdapter }, { mock: { enabled: true } });
  const router = new SessionRouter(registry);
  const http = new GatewayHttpServer(auth, { webDir: join(HERE, 'web') });
  const ws = new GatewayWsServer(auth, registry, router);
  ws.attach(http.server);

  await new Promise<void>((r) => http.server.listen(0, '127.0.0.1', r));
  const port = (http.server.address() as { port: number }).port;
  console.log(`[smoke] gateway on 127.0.0.1:${port}, dataDir=${dataDir}`);

  // ── 登录（HTTP）────────────────────────────────────────────────────
  const loginRes = (await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'pass', deviceName: 'smoke-device' }),
  }).then((r) => r.json())) as { ok?: boolean; token?: string; error?: string };
  check('登录成功并返回 token', loginRes.ok === true && typeof loginRes.token === 'string', JSON.stringify(loginRes));
  const token: string = loginRes.token ?? '';

  // ── WS 连接 ────────────────────────────────────────────────────────
  const wsUrl = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
  const client = await openWs(wsUrl);

  type PushHandler = (f: ServerRequest) => void;
  const pushHandlers = new Set<PushHandler>();
  const pending = new Map<string, (r: RpcResult<unknown>) => void>();

  client.on('message', (data) => {
    const msg = JSON.parse(String(data)) as RpcMessage;
    if (msg.type === 'server-response') {
      const p = pending.get(msg.rpcId);
      if (p) { pending.delete(msg.rpcId); p(msg.result); }
    } else if (msg.type === 'server-request') {
      for (const h of pushHandlers) h(msg);
    }
  });

  const call = (method: string, payload: unknown, timeoutMs = 8000): Promise<RpcResult<unknown>> =>
    new Promise((resolveP, rejectP) => {
      const rpcId = crypto.randomUUID();
      pending.set(rpcId, resolveP);
      client.send(JSON.stringify({ type: 'client-request', rpcId, method, payload }));
      setTimeout(() => { if (pending.delete(rpcId)) rejectP(new Error(`timeout: ${method}`)); }, timeoutMs);
    });

  const waitPush = (pred: (f: ServerRequest) => boolean, timeoutMs = 8000): Promise<ServerRequest> =>
    new Promise((resolveP, rejectP) => {
      const h: PushHandler = (f) => { if (pred(f)) { pushHandlers.delete(h); resolveP(f); } };
      pushHandlers.add(h);
      setTimeout(() => { if (pushHandlers.delete(h)) rejectP(new Error('push timeout')); }, timeoutMs);
    });

  // ── 1. 认证与握手 ──────────────────────────────────────────────────
  let r = await call('auth.hello', {});
  check('auth.hello 返回协议版本与适配器', r.ok && (r.value as any).protoVersion === 1 && (r.value as any).adapters[0]?.id === 'mock');

  // ── 2. 会话创建 / 列表 ─────────────────────────────────────────────
  r = await call('session.create', { backend: 'mock', title: 'smoke-session' });
  check('session.create 成功', r.ok && typeof (r.ok ? (r.value as any).id : '') === 'string', JSON.stringify(r));
  const g1 = r.ok ? (r.value as any).id as string : '';

  r = await call('session.list', {});
  check('session.list 包含新会话', r.ok && (r.value as any).sessions.some((s: any) => s.id === g1));

  // ── 3. 对话 + 审批流 ───────────────────────────────────────────────
  // 注意：chunk 事件在 prompt 响应返回前即推送，须先注册监听
  const approvalFrame = waitPush((f) => f.method === 'approval/requested');
  const chunkFrame = waitPush((f) => f.method === 'session/event' && (f.payload as any).event?.type === 'assistant/chunk', 5000);
  r = await call('session.prompt', { sessionId: g1, parts: [{ type: 'text', text: 'do work' }] });
  check('session.prompt 受理', r.ok);
  const ap = await approvalFrame;
  check('收到 approval/requested 推送', (ap.payload as { toolName?: string }).toolName === 'mock.write');
  check('收到 assistant/chunk 流式事件', await chunkFrame.then(() => true).catch(() => false));

  const doneFrame = waitPush((f) => f.method === 'session/event' && (f.payload as any).event?.type === 'done');
  r = await call('respond', { sessionId: g1, serverRequestRpcId: ap.rpcId, payload: { outcome: 'allowed-once' } });
  check('审批应答受理', r.ok);
  const done = await doneFrame;
  check('审批后回合完成（done）', (done.payload as { sessionId?: string }).sessionId === g1);

  // ── 4. 提问流 ──────────────────────────────────────────────────────
  r = await call('session.create', { backend: 'mock', title: 'ask-session' });
  const g2 = r.ok ? (r.value as any).id as string : '';
  const qFrame = waitPush((f) => f.method === 'question/requested');
  await call('session.prompt', { sessionId: g2, parts: [{ type: 'text', text: '[ask] 怎么做' }] });
  const q = await qFrame;
  check('收到 question/requested 推送', (q.payload as any).questions?.length > 0);
  const qDone = waitPush((f) => f.method === 'session/event' && (f.payload as any).event?.type === 'done');
  await call('respond', { sessionId: g2, serverRequestRpcId: q.rpcId, payload: { answer: 'a' } });
  check('提问应答后回合完成', ((await qDone).payload as { sessionId?: string }).sessionId === g2);

  // ── 5. 工作区 ──────────────────────────────────────────────────────
  r = await call('workspace.create', { path: '/tmp/smoke-ws' });
  check('workspace.create 成功', r.ok && (r.value as any).created === true);
  r = await call('workspace.list', {});
  check('workspace.list 包含新工作区', r.ok && (r.value as any).items.some((w: any) => w.path === '/tmp/smoke-ws'));

  r = await call('workspace.tree', {});
  check('workspace.tree 返回工作区树', r.ok && Array.isArray((r.value as any).items) && (r.value as any).items.length >= 1);
  const wsCreate = await call('workspace.create', { path: '/tmp/smoke-ws2' });
  const wsId = wsCreate.ok ? (wsCreate.value as any)?.workspace?.workspaceId : undefined;
  if (wsId) {
    r = await call('workspace.delete', { workspaceId: wsId });
    check('workspace.delete 成功', r.ok && (r.value as any).deleted === true);
  }
  r = await call('workspace.archiveSession', { sessionId: 'mock-1' });
  check('workspace.archiveSession 受理', r.ok && (r.value as any).archived === true);

  // ── 6. 模型 ────────────────────────────────────────────────────────
  r = await call('model.list', {});
  check('model.list 返回 2 个模型', r.ok && (r.value as any).items.length === 2);
  r = await call('model.select', { sessionId: g1, model: { provider: 'mock', model: 'mock-reasoner' } });
  check('model.select 受理', r.ok);

  // ── 7. 会话历史 ────────────────────────────────────────────────────
  r = await call('session.history', { sessionId: g1 });
  check('session.history 返回事件', r.ok && Array.isArray((r.value as any).events) && (r.value as any).events.length > 0);

  // ── 8. 断线重连 ────────────────────────────────────────────────────
  client.close();
  const client2 = await openWs(wsUrl);
  client2.on('message', () => { /* 忽略 */ });
  const call2 = (method: string, payload: unknown): Promise<RpcResult<unknown>> =>
    new Promise((resolveP) => {
      const rpcId = crypto.randomUUID();
      client2.once('message', (data) => {
        const msg = JSON.parse(String(data)) as RpcMessage;
        if (msg.type === 'server-response' && msg.rpcId === rpcId) resolveP(msg.result);
      });
      client2.send(JSON.stringify({ type: 'client-request', rpcId, method, payload }));
    });
  r = await call2('session.list', {});
  check('重连后 session.list 仍可用', r.ok);
  client2.close();

  // ── 9. 未认证拒绝 ──────────────────────────────────────────────────
  const anon = await openWs(`ws://127.0.0.1:${port}/ws`);
  const anonResult = await new Promise<RpcResult<unknown>>((resolveP) => {
    anon.once('message', (data) => {
      const msg = JSON.parse(String(data)) as RpcMessage;
      if (msg.type === 'server-response') resolveP(msg.result);
    });
    anon.send(JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {} }));
  });
  check('未认证调用被拒', !anonResult.ok && anonResult.error.code === 'auth-required');
  anon.close();

  ws['wss']?.close();
  await new Promise((r2) => http.server.close(r2));
  rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n[smoke] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolveP(ws));
    ws.once('error', rejectP);
  });
}

main().catch((e) => {
  console.error('[smoke] fatal:', e);
  process.exit(1);
});
