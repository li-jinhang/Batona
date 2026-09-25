'use strict';

const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

const cases = [
  [{}, 'stdio-native-ui'],
  [{ websocketUrl: 'ws://127.0.0.1:45678' }, 'shared-readonly'],
  [{ websocketUrl: 'ws://127.0.0.1:45678', enableSharedWrites: true }, 'shared-write'],
];

for (const [options, expected] of cases) {
  const bridge = new CodexBridge(options);
  assert.equal(bridge.transportMode, expected, `transport mode for ${JSON.stringify(options)}`);
  void bridge.appServer.stop();
}

console.log('PASS Codex transport mode is explicit');
