'use strict';

const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

async function main() {
  const bridge = new CodexBridge({ nativeControl: {} });
  const calls = [];
  let response = { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'private@example.test' } };
  bridge.appServer.request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    if (response instanceof Error) throw response;
    return response;
  };

  assert.equal(await bridge.accountStatus(), 'unknown');
  assert.equal(calls.length, 0);

  bridge.appServer.ready = true;
  assert.equal(await bridge.accountStatus(), 'signed-in');
  assert.deepEqual(calls[0], { method: 'account/read', params: { refreshToken: false }, timeoutMs: 3000 });

  response = { requiresOpenaiAuth: true, account: null };
  assert.equal(await bridge.accountStatus(), 'signed-out');
  response = { requiresOpenaiAuth: false, account: null };
  assert.equal(await bridge.accountStatus(), 'not-required');
  response = { requiresOpenaiAuth: true };
  assert.equal(await bridge.accountStatus(), 'unknown');
  response = new Error('transient failure');
  assert.equal(await bridge.accountStatus(), 'unknown');
  console.log('PASS Codex local account status');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
