import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AccountStore } from '../src/hosted/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dsh-provision-'));
const config = join(dir, 'config.json');
const script = resolve('scripts/init-access.mjs');
const provision = () => spawnSync(process.execPath, [script, config, dir], { encoding: 'utf8' });
try {
  const legacy = JSON.stringify({ host: '127.0.0.1', dataDir: dir, auth: { legacyFixture: true } });
  writeFileSync(config, legacy);
  assert.equal(provision().status, 0);
  const cfg = JSON.parse(readFileSync(config, 'utf8'));
  const master = readFileSync(cfg.access.vaultKeyFile, 'utf8');
  const admin = readFileSync(cfg.access.adminKeyFile, 'utf8');
  assert.notEqual(master, admin);
  assert.equal(readFileSync(config + '.pre-hosted', 'utf8'), legacy);
  assert.equal(cfg.tunnel.enabled, true);
  const rerun = provision();
  assert.equal(rerun.status, 0);
  assert.equal(readFileSync(cfg.access.vaultKeyFile, 'utf8'), master);
  assert(!rerun.stdout.includes(master) && !rerun.stdout.includes(admin));
  const store = new AccountStore(dir, Buffer.from(master, 'hex'));
  const account = store.change(() => store.create('recovery fixture'));
  const vault = join(dir, 'access.vault');
  assert(!readFileSync(vault).includes(account.key));
  cpSync(vault, vault + '.backup');
  store.change(() => store.remove(account));
  assert.equal(new AccountStore(dir, Buffer.from(master, 'hex')).accounts().length, 0);
  cpSync(vault + '.backup', vault);
  assert.equal(new AccountStore(dir, Buffer.from(master, 'hex')).accounts()[0].id, account.id);
  assert.throws(() => new AccountStore(dir, Buffer.alloc(32)));
  unlinkSync(cfg.access.vaultKeyFile);
  assert.notEqual(provision().status, 0, 'must not invent a new key for an existing vault');
  console.log('PASS provisioning, idempotence, no secret output, encrypted snapshot restore, wrong/missing key fail closed');
} finally { rmSync(dir, { recursive: true, force: true }); }
