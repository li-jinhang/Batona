'use strict';

const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');
const { NativeCodexControl } = require('../native-codex-control');

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

  let historyReads = 0;
  let invoked;
  const permissionControl = new NativeCodexControl({
    executable: __filename,
    locateWindow: async () => 1234,
    appServer: { async request(method, params) {
      if (method === 'thread/read') return { thread: { id: params.threadId, name: '运行测试' } };
      if (method === 'thread/list') return { data: [{ id: 'desktop-thread', name: '运行测试' }], nextCursor: null };
      if (method === 'thread/turns/list') { historyReads += 1; throw new Error('latest turn is not available'); }
      throw new Error(`unexpected ${method}`);
    } },
    run: async (_file, args) => { invoked = args; return { stdout: '{"profileId":"assist-approval"}' }; },
  });
  assert.deepEqual(await permissionControl.setPermission('desktop-thread', 'assist-approval'),
    { profileId: 'assist-approval' });
  assert.equal(historyReads, 0, 'permission selection must not depend on transcript rendering');
  assert.equal(invoked[0], 'set-permission');

  let permissionAttempts = 0;
  const transientTitle = new NativeCodexControl({
    executable: __filename,
    locateWindow: async () => 1234,
    appServer: permissionControl.appServer,
    run: async () => {
      permissionAttempts += 1;
      if (permissionAttempts === 1) throw { stderr: 'native-task-identity-mismatch\n' };
      return { stdout: '{"profileId":"full-access"}' };
    },
  });
  assert.deepEqual(await transientTitle.setPermission('desktop-thread', 'full-access', true),
    { profileId: 'full-access' });
  assert.equal(permissionAttempts, 2, 'a transient pre-write title mismatch may be retried once');

  await assert.rejects(bridge.selectPermission('desktop-thread', 'full-access'),
    (error) => error.code === 'full-access-confirmation-required');
  bridge.nativeControl.setPermission = async () => ({ profileId: 'request-approval' });
  await assert.rejects(bridge.selectPermission('desktop-thread', 'full-access', true),
    (error) => error.code === 'native-profile-unavailable');
  assert.equal(bridge.threadOptions.get('desktop-thread').profileId, 'assist-approval');
  console.log('PASS native Desktop permission menu and confirmed selection');
})().catch((error) => { console.error(error); process.exitCode = 1; });
