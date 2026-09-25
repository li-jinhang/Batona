'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadControlMode, saveControlMode, sharedUrl } = require('../codex-control-mode.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'batona-control-mode-'));
const file = path.join(directory, 'mode.json');
try {
  assert.equal(sharedUrl('ws://127.0.0.1:45678'), 'ws://127.0.0.1:45678');
  assert.equal(sharedUrl('ws://0.0.0.0:45678'), null);
  assert.deepEqual(loadControlMode(file, {}), { mode: 'interface' });
  assert.deepEqual(loadControlMode(file, { BATONA_SHARED_CODEX_WS_URL: 'ws://127.0.0.1:45678' }), {
    mode: 'shared', websocketUrl: 'ws://127.0.0.1:45678', enableSharedWrites: false,
  });
  saveControlMode(file, { mode: 'shared', websocketUrl: 'ws://127.0.0.1:49152', enableSharedWrites: true });
  assert.deepEqual(loadControlMode(file, {}), {
    mode: 'shared', websocketUrl: 'ws://127.0.0.1:49152', enableSharedWrites: true,
  });
  saveControlMode(file, { mode: 'interface' });
  assert.deepEqual(loadControlMode(file, { BATONA_SHARED_CODEX_WS_URL: 'ws://127.0.0.1:45678' }), { mode: 'interface' });
  assert.throws(() => saveControlMode(file, { mode: 'shared', websocketUrl: 'ws://0.0.0.0:45678' }));
  console.log('PASS: Codex control mode persistence and loopback validation');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
