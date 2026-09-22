/** Hosted production entry. Legacy shared-password auth is deliberately not mounted. */
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { HostedGateway } from './hosted/gateway.ts';

async function main() {
  const cfg = loadConfig();
  if (cfg.host !== '127.0.0.1') throw new Error('Hosted gateway requires loopback binding behind TLS proxy');
  if (!cfg.access?.adminKeyFile || !cfg.access?.vaultKeyFile) throw new Error('Hosted access is not initialized. Run scripts/init-access.mjs against an isolated config before migration.');
  const gateway = new HostedGateway({
    dataDir: cfg.dataDir, webDir: cfg.webDir,
    adminKey: readFileSync(cfg.access.adminKeyFile, 'utf8').trim(),
    vaultKey: Buffer.from(readFileSync(cfg.access.vaultKeyFile, 'utf8').trim(), 'hex'),
  });
  gateway.server.listen(cfg.port, cfg.host, () => console.log('[gateway] hosted access listening; no legacy login routes'));
  let closing = false;
  const close = () => { if (closing) return; closing = true; void gateway.close().then(() => process.exit(0)); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
main().catch(() => { console.error('[gateway] startup failed: check hosted access configuration and protected key files'); process.exitCode = 1; });
