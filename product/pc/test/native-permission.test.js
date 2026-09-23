'use strict';

const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

(async () => {
  const calls = [];
  const bridge = new CodexBridge({ nativeControl: {
    async permissionMenu(threadId, open) {
      calls.push(['menu', threadId, open]);
      return { profileId: 'request-approval' };
    },
    async setPermission(threadId, profileId) {
      calls.push(['select', threadId, profileId]);
      return { profileId };
    },
  } });
  bridge.requireProfile = async (id) => ({ id, approvalPolicy: 'on-request' });
  bridge.appServer.request = async (method, params) => {
    assert.equal(method, 'thread/read');
    return { thread: { id: params.threadId, originator: 'Codex Desktop' } };
  };

  assert.deepEqual(await bridge.permissionMenu('desktop-thread', true), { profileId: 'request-approval' });
  assert.deepEqual(await bridge.permissionMenu('desktop-thread', false), { profileId: 'request-approval' });
  assert.deepEqual(await bridge.selectPermission('desktop-thread', 'assist-approval'),
    { profileId: 'assist-approval' });
  assert.deepEqual(calls, [
    ['menu', 'desktop-thread', true],
    ['menu', 'desktop-thread', false],
    ['select', 'desktop-thread', 'assist-approval'],
  ]);
  assert.equal(bridge.threadOptions.get('desktop-thread').profileId, 'assist-approval');

  bridge.nativeControl.setPermission = async () => ({ profileId: 'request-approval' });
  await assert.rejects(bridge.selectPermission('desktop-thread', 'full-access'),
    (error) => error.code === 'native-profile-unavailable');
  assert.equal(bridge.threadOptions.get('desktop-thread').profileId, 'assist-approval');
  console.log('PASS native Desktop permission menu and confirmed selection');
})().catch((error) => { console.error(error); process.exitCode = 1; });
