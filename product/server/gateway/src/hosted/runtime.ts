import type { IncomingMessage, Server } from 'node:http';
import { AdapterRegistry } from '../adapter/registry.ts';
import { createDshAdapter } from '../adapter/dsh/adapter.ts';
import { createCodexAdapter } from '../adapter/codex/adapter.ts';
import { createMockAdapter } from '../adapter/mock/adapter.ts';
import { SessionRouter } from '../session/router.ts';
import { GatewayWsServer } from '../server/ws.ts';
import { TunnelServer } from '../tunnel/server.ts';
import type { AccountStore } from './store.ts';

/** One PC's private adapter/router/tunnel graph. No global ports, sessions or launch tokens. */
export class PcRuntime {
  tunnel: TunnelServer;
  ws!: GatewayWsServer;
  registry!: AdapterRegistry;
  pcId: string;
  accountId: string;
  private disposed = false;
  constructor(store: AccountStore, accountId: string, pcId: string, disconnected: () => void) {
    this.accountId = accountId; this.pcId = pcId;
    this.tunnel = new TunnelServer({ enabled: true, services: { dsh: 0, dir: 0, codex: 0 }, maxStreams: 64 }, {
      agentKey: 'hosted-device-authorization',
      authenticate: (req: IncomingMessage) => {
        const info = store.validate(String(req.headers.authorization ?? '').replace(/^Bearer /, ''), 'pc');
        return info?.account.id === accountId && info.device.id === pcId;
      },
      onDisconnected: disconnected,
      log: () => {},
    });
  }
  async start(store: AccountStore, server: Server, mock: boolean) {
    const ports = await this.tunnel.start();
    if (!ports.ok) throw new Error('private-tunnel-bind-failed');
    const [dsh, dir, codex] = ports.bound.map(x => 'http://' + x);
    this.registry = await AdapterRegistry.assemble(
      { mock: createMockAdapter, dsh: createDshAdapter, codex: createCodexAdapter },
      mock ? { mock: { enabled: true } } : { dsh: { cfg: { baseUrl: dsh, authority: '127.0.0.1:3080', waitForBaseline: false } }, codex: { cfg: { baseUrl: codex } } },
    );
    this.ws = new GatewayWsServer({
      validateToken: token => {
        const info = store.validate(token, 'phone');
        return !this.disposed && info?.account.id === this.accountId && info.account.pc?.id === this.pcId && this.online()
          ? { deviceId: info.device.id } : null;
      },
      listDevices: () => [], revokeDevice: () => false,
    }, this.registry, new SessionRouter(this.registry), {
      hosted: true, dirUrl: dir + '/list', accepted: () => store.count(this.accountId),
    });
    this.ws.attach(server);
  }
  online() { return this.tunnel.state().active; }
  async close() {
    this.disposed = true;
    this.ws?.close(); this.tunnel.stop();
    for (const a of this.registry?.list() ?? []) await a.dispose();
  }
}
