import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'batona-web-push-keys-'));
const config = join(dir, 'config.json');
const keyDirectory = join(dir, 'protected', 'push');
const script = resolve('scripts/init-web-push.mjs');
const provision = () => spawnSync(process.execPath, [script, config, keyDirectory, 'mailto:ops@example.test'], { encoding: 'utf8' });
try {
  writeFileSync(config, JSON.stringify({ host: '127.0.0.1', dataDir: dir, webPush: null }));
  const first = provision();
  assert.equal(first.status, 0, first.stderr);
  assert(!first.stdout.includes('privateKey') && !first.stdout.includes('publicKey'));
  const cfg = JSON.parse(readFileSync(config, 'utf8'));
  assert.equal(cfg.webPush.subject, 'mailto:ops@example.test');
  assert.equal(cfg.webPush.publicKeyFile, join(keyDirectory, 'web-push-public.key'));
  assert.equal(cfg.webPush.privateKeyFile, join(keyDirectory, 'web-push-private.key'));
  const publicKey = readFileSync(cfg.webPush.publicKeyFile, 'utf8');
  const privateKey = readFileSync(cfg.webPush.privateKeyFile, 'utf8');
  assert.match(publicKey.trim(), /^[A-Za-z0-9_-]{80,120}$/);
  assert.match(privateKey.trim(), /^[A-Za-z0-9_-]{40,80}$/);
  assert.equal(readFileSync(config + '.before-web-push', 'utf8'), JSON.stringify({ host: '127.0.0.1', dataDir: dir, webPush: null }));

  const second = provision();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(cfg.webPush.publicKeyFile, 'utf8'), publicKey);
  assert.equal(readFileSync(cfg.webPush.privateKeyFile, 'utf8'), privateKey);
  const escapeConfig = join(dir, 'escape.json');
  writeFileSync(escapeConfig, JSON.stringify({ webPush: { publicKeyFile: '../outside.key' } }));
  const escape = spawnSync(process.execPath, [script, escapeConfig, join(dir, 'other-protected'), 'https://example.test/'], { encoding: 'utf8' });
  assert.notEqual(escape.status, 0, 'key paths outside the protected directory must be refused');
  assert.equal(existsSync(join(dir, 'outside.key')), false);
  console.log('PASS Web Push key provisioning, idempotence, backup, no secret output, and path confinement');
} finally { rmSync(dir, { recursive: true, force: true }); }
