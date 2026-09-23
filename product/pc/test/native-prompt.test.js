'use strict';

const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

(async () => {
  const calls = [];
  const nativeControl = {
    async send(threadId, text, profileId) { calls.push(['native', threadId, text, profileId]); return { accepted: true }; },
  };
  const bridge = new CodexBridge({ nativeControl });
  bridge.requireProfile = async () => ({ sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' });
  bridge.appServer.request = async (method, params) => {
    calls.push(['app-server', method]);
    if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'Codex Desktop' } };
    throw new Error(`native task must not call ${method}`);
  };
  await bridge.prompt('desktop-thread', { text: '手机发送', profileId: 'request-approval' });
  assert.deepEqual(calls, [
    ['app-server', 'thread/read'],
    ['native', 'desktop-thread', '手机发送', 'request-approval'],
  ]);

  calls.length = 0;
  await bridge.prompt('desktop-thread', { text: '沿用电脑端权限' });
  assert.deepEqual(calls, [
    ['app-server', 'thread/read'],
    ['native', 'desktop-thread', '沿用电脑端权限', 'keep-current'],
  ]);

  calls.length = 0;
  nativeControl.send = async () => { throw Object.assign(new Error('identity mismatch'), { code: 'native-task-identity-mismatch' }); };
  await assert.rejects(bridge.prompt('desktop-thread', { text: '保留草稿', profileId: 'request-approval' }),
    (error) => error.code === 'native-task-identity-mismatch');
  assert.equal(bridge.nativePromptInFlight, false);
  assert.deepEqual(calls, [['app-server', 'thread/read']]);

  await assert.rejects(bridge.requireAppServerWriter('desktop-thread', 'native-model-control-unavailable'),
    (error) => error.code === 'native-model-control-unavailable');
  assert.deepEqual(calls, [['app-server', 'thread/read'], ['app-server', 'thread/read']]);

  calls.length = 0;
  bridge.appServer.request = async (method, params) => {
    calls.push(method);
    if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'unrecognized' } };
    throw new Error('unknown task must not acquire writer');
  };
  await assert.rejects(bridge.prompt('unknown-thread', { text: '不能发送' }),
    (error) => error.code === 'codex-native-control-unavailable');
  assert.deepEqual(calls, ['thread/read']);
  console.log('PASS native Desktop prompt routing and fail-closed behavior');
})().catch((error) => { console.error(error); process.exitCode = 1; });
