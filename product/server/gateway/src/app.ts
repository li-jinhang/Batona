/**
 * app.ts — 网关入口：装配配置 → 认证 → 适配器 → 会话路由 → HTTP/WS
 *
 * 启动：
 *   node src/app.ts                 # 使用 config.json（不存在则用默认值）
 *   GATEWAY_CONFIG=... node src/app.ts
 *   PORT=3090 DSH_BASE_URL=http://127.0.0.1:3080 node src/app.ts   # 启用 DSH 后端
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { AuthService } from './auth/index.ts';
import { AdapterRegistry } from './adapter/registry.ts';
import { createMockAdapter } from './adapter/mock/adapter.ts';
import { createDshAdapter } from './adapter/dsh/adapter.ts';
import { SessionRouter } from './session/router.ts';
import { GatewayHttpServer } from './server/http.ts';
import { GatewayWsServer } from './server/ws.ts';
import { createUpgradeRouter } from './server/upgrade.ts';
import { TunnelServer } from './tunnel/server.ts';
import { TUNNEL_PATH } from './tunnel/protocol.ts';

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 首次运行无初始账号时：生成随机密码并打印（dev 模式）
  if (!cfg.auth.initialUser) {
    const password = randomBytes(6).toString('hex');
    cfg.auth.initialUser = { username: 'admin', password };
    console.log(`[gateway] 未配置初始账号，已生成：admin / ${password}（请尽快修改并启用 TOTP）`);
  }

  const auth = new AuthService(cfg.dataDir, cfg.auth);

  // 内置隧道：始终装配（disabled 时也要能对 /tunnel 回 tunnel-disabled，供 PC 回退 frp），
  // 但只有 enabled 才真正绑端口——且必须在 AdapterRegistry.assemble 之前绑：
  // assemble 会立刻去连 127.0.0.1:3080，端口没绑上首连必然 ECONNRESET。
  const tunnel = new TunnelServer(
    { enabled: cfg.tunnel.enabled, services: cfg.tunnel.services, maxStreams: cfg.tunnel.maxStreams },
    { agentKey: cfg.agentKey },
  );
  if (cfg.tunnel.enabled) {
    const r = await tunnel.start();
    if (!r.ok) console.error(`[gateway] 隧道监听失败：${r.error}（/tunnel 将回 bind-failed，PC 应回退 frpc）`);
    else console.log(`[gateway] 隧道监听（内置，仅回环）：${r.bound.join(', ')}`);
  } else {
    console.log('[gateway] 内置隧道未启用（tunnel.enabled=false）—— /tunnel 回 tunnel-disabled，PC 回退 frpc');
  }

  const registry = await AdapterRegistry.assemble(
    { mock: createMockAdapter, dsh: createDshAdapter },
    cfg.adapters,
  );

  if (registry.list().length === 0) {
    throw new Error('no adapters enabled — configure at least one in config.json');
  }

  const router = new SessionRouter(registry);

  // PC 软件上报 DSH launch token → 热更新适配器并强制重连（DSH 0.1.2+ 每进程随机、
  // 不落盘，只能运行期注入；config.agentKey 为共享密钥，缺省则该通道关闭）。
  const dsh = registry.get('dsh');
  const http = new GatewayHttpServer(auth, {
    webDir: cfg.webDir,
    agentKey: cfg.agentKey,
    onDshLaunchToken: async (token) => {
      if (!dsh?.setAuthToken) throw new Error('dsh adapter not enabled');
      await dsh.setAuthToken(token);
    },
    tunnelState: () => tunnel.state(),
  });
  const ws = new GatewayWsServer(auth, registry, router);
  ws.attach(http.server);

  // 全服务器唯一的 upgrade 路由：/ws（手机/PC 前端协议）与 /tunnel（内置隧道）
  createUpgradeRouter(http.server, [
    { path: '/ws', handle: ws.handleUpgrade },
    { path: TUNNEL_PATH, handle: tunnel.handleUpgrade },
  ]);

  http.server.listen(cfg.port, cfg.host, () => {
    console.log(`[gateway] version: ${gatewayVersion()}`);
    console.log(`[gateway] listening on http://${cfg.host}:${cfg.port}`);
    console.log(`[gateway] backends: ${registry.list().map((a) => a.id).join(', ')}`);
    if (dsh) console.log(`[gateway] dsh adapter baseUrl: ${(cfg.adapters.dsh?.cfg as { baseUrl?: string })?.baseUrl}`);
    console.log(`[gateway] DSH launch token 上报通道：${cfg.agentKey ? '已启用（POST /api/dsh/launch-token）' : '未配置 agentKey，已关闭'}`);
    console.log('[gateway] TOTP: 首次登录后请用 Authenticator 扫码绑定（登录响应返回 otpauthUri）');
  });

  const shutdown = (): void => {
    console.log('[gateway] 收到停止信号，正在收尾…');
    tunnel.stop();
    http.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/** 读 package.json 的 version（部署后绝对路径稳定） */
function gatewayVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

main().catch((e) => {
  console.error('[gateway] fatal:', e);
  process.exit(1);
});
