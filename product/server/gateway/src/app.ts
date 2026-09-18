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

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 首次运行无初始账号时：生成随机密码并打印（dev 模式）
  if (!cfg.auth.initialUser) {
    const password = randomBytes(6).toString('hex');
    cfg.auth.initialUser = { username: 'admin', password };
    console.log(`[gateway] 未配置初始账号，已生成：admin / ${password}（请尽快修改并启用 TOTP）`);
  }

  const auth = new AuthService(cfg.dataDir, cfg.auth);
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
  });
  const ws = new GatewayWsServer(auth, registry, router);
  ws.attach(http.server);

  http.server.listen(cfg.port, cfg.host, () => {
    console.log(`[gateway] version: ${gatewayVersion()}`);
    console.log(`[gateway] listening on http://${cfg.host}:${cfg.port}`);
    console.log(`[gateway] backends: ${registry.list().map((a) => a.id).join(', ')}`);
    if (dsh) console.log(`[gateway] dsh adapter baseUrl: ${(cfg.adapters.dsh?.cfg as { baseUrl?: string })?.baseUrl}`);
    console.log(`[gateway] DSH launch token 上报通道：${cfg.agentKey ? '已启用（POST /api/dsh/launch-token）' : '未配置 agentKey，已关闭'}`);
    console.log('[gateway] TOTP: 首次登录后请用 Authenticator 扫码绑定（登录响应返回 otpauthUri）');
  });
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
