/**
 * test/tunnel-client-interop.ts — PC 端真实隧道客户端 ↔ 真实网关的互通测试
 *
 * 为什么放在网关侧：PC 端（Electron 工程）没有测试基建，而本文件是 client.js 唯一的自动化验证。
 * 通过 createRequire 直接加载 product/pc/tunnel/client.js（CJS），与真实 TunnelServer 对跑。
 *
 * 覆盖：握手/鉴权 → 隧道内 HTTP 往返（Host 透明）→ 服务端主动断开后的自动重连 →
 *       tunnel-disabled 触发 fatal（main.js 据此回退 frp）
 *
 * 运行：node test/tunnel-client-interop.ts
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { get as httpGetRaw, createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuthService } from '../src/auth/index.ts';
import { AdapterRegistry } from '../src/adapter/registry.ts';
import { createMockAdapter } from '../src/adapter/mock/adapter.ts';
import { SessionRouter } from '../src/session/router.ts';
import { GatewayHttpServer } from '../src/server/http.ts';
import { GatewayWsServer } from '../src/server/ws.ts';
import { createUpgradeRouter } from '../src/server/upgrade.ts';
import { TunnelServer } from '../src/tunnel/server.ts';
import { TUNNEL_PATH } from '../src/tunnel/protocol.ts';

const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { TunnelClient } = require_('../../../pc/tunnel/client.js') as { TunnelClient: any };

const HERE = resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name} ${detail}`); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, rejectP) => {
    const req = httpGetRaw({ host: '127.0.0.1', port, path, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', rejectP);
  });
}

async function startGateway(opts: { tunnelEnabled: boolean; services: Record<string, number>; agentKey: string }): Promise<{ port: number; tunnel: TunnelServer; close: () => Promise<void> }> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-interop-'));
  const auth = new AuthService(dataDir, { initialUser: { username: 'admin', password: 'pass' } });
  const registry = await AdapterRegistry.assemble({ mock: createMockAdapter }, { mock: { enabled: true } });
  const router = new SessionRouter(registry);
  const tunnel = new TunnelServer(
    { enabled: opts.tunnelEnabled, services: opts.services, maxStreams: 128 },
    { agentKey: opts.agentKey, log: () => {}, openTimeoutMs: 2000 },
  );
  if (opts.tunnelEnabled) await tunnel.start();
  const http = new GatewayHttpServer(auth, { webDir: join(HERE, 'web'), tunnelState: () => tunnel.state() });
  const ws = new GatewayWsServer(auth, registry, router);
  ws.attach(http.server);
  createUpgradeRouter(http.server, [
    { path: '/ws', handle: ws.handleUpgrade },
    { path: TUNNEL_PATH, handle: tunnel.handleUpgrade },
  ]);
  await new Promise<void>((r) => http.server.listen(port, '127.0.0.1', r));
  return {
    port,
    tunnel,
    close: async () => {
      tunnel.stop();
      await new Promise<void>((r) => http.server.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  // 假 DSH：只回显 Host（验证透明转发）
  const fakeDsh = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ host: req.headers.host, url: req.url }));
  });
  await new Promise<void>((r) => fakeDsh.listen(0, '127.0.0.1', r));
  const dshPort = (fakeDsh.address() as { port: number }).port;

  const tunnelListenPort = await freePort();
  const gw = await startGateway({ tunnelEnabled: true, services: { dsh: tunnelListenPort }, agentKey: 'itest-key' });

  const client = new TunnelClient({
    host: '127.0.0.1',
    gwPort: gw.port,
    token: 'itest-key',
    services: () => [{ name: 'dsh', localPort: dshPort }],
    tls: false,   // 测试网关是明文 HTTP（生产由 Nginx 终结 TLS）
    log: () => {},
  });
  const fatalBox: { v: { code?: string } | null } = { v: null };
  client.on('fatal', (info: { code: string }) => { fatalBox.v = info; });

  // ── H1 握手 ─────────────────────────────────────────────────────────
  client.start();
  check('H1 真实客户端完成握手', await waitFor(() => client.connected, 8000), JSON.stringify(client.getStatus()));
  check('H2 网关侧状态 active', await waitFor(() => gw.tunnel.state().active, 2000), JSON.stringify(gw.tunnel.state()));

  // ── H3 隧道内 HTTP 往返（Host 透明）──────────────────────────────────
  const r1 = await httpGet(tunnelListenPort, '/hello').catch((e) => ({ status: 0, body: String(e) }));
  const j1 = (() => { try { return JSON.parse(r1.body) as { host: string }; } catch { return { host: '' }; } })();
  check('H3 隧道内 HTTP 往返 + Host 逐字节保持', r1.status === 200 && j1.host === `127.0.0.1:${tunnelListenPort}`, r1.body);

  // ── H4 服务端断开 → 客户端自动重连 ───────────────────────────────────
  const sess1 = gw.tunnel.activeSession();
  sess1?.terminate('test-kill', '测试主动断开');
  check('H4a 断开后状态离开 connected', await waitFor(() => !client.connected, 3000), client.getStatus().state);
  check('H4b 自动重连成功', await waitFor(() => client.connected, 15000), JSON.stringify(client.getStatus()));
  const r2 = await httpGet(tunnelListenPort, '/again').catch((e) => ({ status: 0, body: String(e) }));
  check('H4c 重连后隧道恢复可用', r2.status === 200 && r2.body.includes('/again'), r2.body);

  client.stop();

  // ── H5 tunnel-disabled → fatal（main.js 据此回退 frp）─────────────────
  const offPort = await freePort();
  const gwOff = await startGateway({ tunnelEnabled: false, services: { dsh: offPort }, agentKey: 'itest-key' });
  const client2 = new TunnelClient({
    host: '127.0.0.1',
    gwPort: gwOff.port,
    token: 'itest-key',
    services: () => [{ name: 'dsh', localPort: dshPort }],
    tls: false,
    log: () => {},
  });
  const fatalBox2: { v: { code?: string } | null } = { v: null };
  client2.on('fatal', (info: { code: string }) => { fatalBox2.v = info; });
  client2.start();
  check('H5 tunnel-disabled 触发 fatal（供回退 frp）', await waitFor(() => fatalBox2.v !== null, 8000) && fatalBox2.v?.code === 'tunnel-disabled', JSON.stringify(fatalBox2.v));
  client2.stop();

  // ── H6 错误密钥 → 升级被拒（401）→ 不崩溃、可重试 ────────────────────
  const client3 = new TunnelClient({
    host: '127.0.0.1',
    gwPort: gw.port,
    token: 'wrong-key',
    services: () => [{ name: 'dsh', localPort: dshPort }],
    tls: false,
    log: () => {},
  });
  const fatalBox3: { v: { code?: string } | null } = { v: null };
  client3.on('fatal', (info: { code: string }) => { fatalBox3.v = info; });
  client3.start();
  await sleep(1500);
  check('H6 错误密钥：不 fatal、保持退避重试', fatalBox3.v === null && !client3.connected, JSON.stringify(client3.getStatus()));
  client3.stop();

  await gw.close();
  await gwOff.close();
  await new Promise<void>((r) => fakeDsh.close(() => r()));
  await sleep(200);

  console.log(`\n[tunnel-client-interop] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
