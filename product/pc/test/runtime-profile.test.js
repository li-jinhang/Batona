'use strict';

const assert = require('node:assert/strict');
const { configureUserData, createRuntimeProfile, getTunnelServices } = require('../runtime-profile.js');

const standard = createRuntimeProfile({});
assert.equal(standard.kind, 'standard');
assert.equal(standard.dshEnabled, true);
assert.deepEqual(standard.ports, { dsh: 3080, dir: 3081, codex: 3082 });
assert.deepEqual(getTunnelServices(standard, 3087), [
  { name: 'dsh', localPort: 3087 },
  { name: 'dir', localPort: 3081 },
  { name: 'codex', localPort: 3082 },
]);
assert.equal(configureUserData({ getPath: () => 'unused', setPath: () => assert.fail('standard profile must keep its existing data path') }, standard), null);

const testProfile = createRuntimeProfile({ BATONA_CODEX_TEST_PROFILE: '1' });
assert.equal(testProfile.kind, 'codex-test');
assert.equal(testProfile.dshEnabled, false);
assert.deepEqual(testProfile.ports, { dsh: 3180, dir: 3181, codex: 3182 });
assert.deepEqual(getTunnelServices(testProfile, null), [
  { name: 'dir', localPort: 3181 },
  { name: 'codex', localPort: 3182 },
]);

const calls = [];
const testPath = configureUserData({
  getPath: name => name === 'appData' ? 'C:/Users/Test/AppData/Roaming' : assert.fail(`unexpected path: ${name}`),
  setPath: (name, value) => calls.push(['setPath', name, value]),
}, testProfile, {
  mkdirSync: (dir, options) => calls.push(['mkdirSync', dir, options]),
}, {
  join: (...parts) => parts.join('/'),
});
assert.equal(testPath, 'C:/Users/Test/AppData/Roaming/Batona PC Codex Test');
assert.deepEqual(calls, [
  ['mkdirSync', testPath, { recursive: true }],
  ['setPath', 'userData', testPath],
]);

console.log('PC runtime profile tests passed');
