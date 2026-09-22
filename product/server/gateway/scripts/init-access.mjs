// Explicit provisioning only. Never prints secrets; existing keys are preserved.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const configPath = process.argv[2];
const keyDirectory = process.argv[3];
if (!configPath || !keyDirectory) throw new Error('Usage: node scripts/init-access.mjs <config.json> <protected-key-directory>');
const target = resolve(configPath), secrets = resolve(keyDirectory);
const cfg = JSON.parse(readFileSync(target, 'utf8'));
if (cfg.host && cfg.host !== '127.0.0.1') throw new Error('Hosted gateway must bind loopback');
if (existsSync(join(cfg.dataDir ?? '', 'access.vault')) && (!cfg.access?.vaultKeyFile || !existsSync(cfg.access.vaultKeyFile))) {
  throw new Error('Existing vault has no key; restore its original key. Refusing to generate a replacement.');
}
mkdirSync(secrets, { recursive: true, mode: 0o700 });
cfg.access ??= { adminKeyFile: join(secrets, 'access-admin.key'), vaultKeyFile: join(secrets, 'access-vault.key') };
for (const file of [cfg.access.adminKeyFile, cfg.access.vaultKeyFile]) {
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  if (!/^[a-f0-9]{64}$/.test(readFileSync(file, 'utf8').trim())) throw new Error('Invalid protected key file');
}
cfg.host = '127.0.0.1';
cfg.tunnel = { enabled: true };
if (!existsSync(target + '.pre-hosted')) writeFileSync(target + '.pre-hosted', readFileSync(target), { flag:'wx', mode:0o600 });
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
renameSync(target + '.tmp', target);
console.log('Hosted configuration initialized. Secret values were not printed. Back up configuration, vault and key files together before migration.');
