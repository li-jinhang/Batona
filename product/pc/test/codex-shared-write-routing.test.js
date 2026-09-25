'use strict';

const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

(async () => {
  const calls = [];
  const nativeCalls = [];
  const bridge = new CodexBridge({
    websocketUrl: 'ws://127.0.0.1:45678',
    enableSharedWrites: true,
    nativeControl: {
      async send(...args) { nativeCalls.push(['send', ...args]); },
      async setModel(...args) { nativeCalls.push(['setModel', ...args]); },
    },
  });

  bridge.appServer.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'Codex Desktop' } };
    if (method === 'model/list') return { data: [{
      model: 'gpt-test', displayName: 'Test model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    }] };
    if (method === 'thread/settings/update') {
      bridge.onNotification({
        method: 'thread/settings/updated',
        params: { threadId: params.threadId, threadSettings: { model: params.model, effort: params.effort } },
      });
      return {};
    }
    return {};
  };

  try {
    await bridge.prompt('desktop-thread', { text: '手机直发' });
    await bridge.selectModel('desktop-thread', {
      provider: 'openai', model: 'gpt-test', reasoningEffort: 'high',
    });

    assert.deepEqual(calls.map(([method]) => method), [
      'thread/read', 'thread/resume', 'turn/start',
      'model/list', 'thread/read', 'thread/settings/update',
    ]);
    assert.deepEqual(calls[2][1], { threadId: 'desktop-thread', input: [{ type: 'text', text: '手机直发' }] });
    assert.deepEqual(calls[5][1], { threadId: 'desktop-thread', model: 'gpt-test', effort: 'high' });
    assert.deepEqual(nativeCalls, [], 'shared writes must not type into or click the Codex desktop UI');

    // The server may apply a setting without publishing a notification to this
    // connection. An authoritative readback should finish the phone request.
    const readbackBridge = new CodexBridge({ websocketUrl: 'ws://127.0.0.1:45678', enableSharedWrites: true });
    let savedModel = 'gpt-old';
    readbackBridge.appServer.request = async (method, params) => {
      if (method === 'model/list') return { data: [{ model: 'gpt-test', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
      if (method === 'thread/read') return { thread: {
        id: params.threadId, originator: 'Codex Desktop', model: savedModel, reasoningEffort: 'high',
      } };
      if (method === 'thread/settings/update') { savedModel = params.model; return {}; }
      return {};
    };
    const guard = setTimeout(() => {}, 3_500);
    try {
      const started = Date.now();
      await readbackBridge.selectModel('desktop-unsubscribed', {
        provider: 'openai', model: 'gpt-test', reasoningEffort: 'high',
      });
      assert.equal(savedModel, 'gpt-test');
      assert.ok(Date.now() - started < 2_000, 'confirmed model selection must not wait for a missing notification');
    } finally {
      clearTimeout(guard);
      await readbackBridge.appServer.stop();
    }

    let savedPermission = ':workspace';
    let savedApproval = 'on-request';
    const permissionUpdates = [];
    const permissionNativeCalls = [];
    const permissionBridge = new CodexBridge({
      websocketUrl: 'ws://127.0.0.1:45678', enableSharedWrites: true,
      nativeControl: {
        async setPermission(...args) { permissionNativeCalls.push(args); throw new Error('unexpected native permission control'); },
      },
    });
    permissionBridge.appServer.request = async (method, params) => {
      if (method === 'permissionProfile/list') return { data: [
        { id: ':workspace', allowed: true }, { id: ':danger-full-access', allowed: true },
      ] };
      if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'Codex Desktop' } };
      if (method === 'thread/resume') return {
        activePermissionProfile: { id: savedPermission }, approvalPolicy: savedApproval,
      };
      if (method === 'thread/settings/update') {
        permissionUpdates.push(params);
        savedPermission = params.permissions;
        savedApproval = params.approvalPolicy;
        return {};
      }
      return {};
    };
    const permissionGuard = setTimeout(() => {}, 3_500);
    try {
      assert.deepEqual(await permissionBridge.permissionMenu('desktop-permission', true), { profileId: 'assist-approval' });
      const started = Date.now();
      assert.deepEqual(await permissionBridge.selectPermission('desktop-permission', 'request-approval'),
        { profileId: 'request-approval' });
      assert.ok(Date.now() - started < 2_000, 'permission readback must avoid a missing-notification delay');
      assert.equal(savedApproval, 'untrusted');
      assert.deepEqual(permissionUpdates[0], {
        threadId: 'desktop-permission', permissions: ':workspace', approvalPolicy: 'untrusted',
      });
      assert.deepEqual(permissionNativeCalls, [], 'shared permissions must not depend on the visible Desktop task');
      assert.deepEqual(await permissionBridge.permissionMenu('desktop-permission', true), { profileId: 'request-approval' });
      await assert.rejects(permissionBridge.selectPermission('desktop-permission', 'full-access'),
        (error) => error.code === 'full-access-confirmation-required');
      assert.equal(savedPermission, ':workspace', 'missing confirmation must not write the backend');
      assert.equal(permissionUpdates.length, 1);
      assert.deepEqual(await permissionBridge.selectPermission('desktop-permission', 'full-access', true),
        { profileId: 'full-access' });
      assert.deepEqual(permissionNativeCalls, []);
      assert.equal(savedPermission, ':danger-full-access');
      assert.equal(savedApproval, 'never');
      assert.deepEqual(permissionUpdates[1], {
        threadId: 'desktop-permission', permissions: ':danger-full-access', approvalPolicy: 'never',
      });
      assert.deepEqual(await permissionBridge.permissionMenu('desktop-permission', true), { profileId: 'full-access' });
      permissionBridge.appServer.request = async (method, params) => {
        if (method === 'permissionProfile/list') return { data: [
          { id: ':workspace', allowed: true }, { id: ':danger-full-access', allowed: true },
        ] };
        if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'Codex Desktop' } };
        if (method === 'thread/settings/update') throw Object.assign(new Error('update refused'), { code: 'rpc-refused' });
        throw new Error(`unexpected ${method}`);
      };
      await assert.rejects(permissionBridge.selectPermission('desktop-permission', 'assist-approval'),
        (error) => error.code === 'rpc-refused');
      assert.equal(permissionBridge.threadOptions.get('desktop-permission').profileId, 'full-access',
        'the phone must not show a profile that the shared server rejected');

      // A long-lived app-server connection can report an empty permission
      // snapshot after Desktop has already changed the setting. The phone
      // must use a fresh authoritative read before reporting failure.
      const staleBridge = new CodexBridge({
        websocketUrl: 'ws://127.0.0.1:45678', enableSharedWrites: true,
      });
      staleBridge.requireProfile = async () => ({ permissions: ':danger-full-access', approvalPolicy: 'never' });
      staleBridge.appServer.request = async (method, params) => {
        if (method === 'thread/read') return { thread: { id: params.threadId, originator: 'Codex Desktop' } };
        if (method === 'thread/resume') return { activePermissionProfile: null, approvalPolicy: null };
        if (method === 'thread/settings/update') return {};
        throw new Error(`unexpected ${method}`);
      };
      let freshReads = 0;
      staleBridge.readFreshSharedPermission = async () => {
        freshReads += 1;
        return { permissionProfileId: ':danger-full-access', approvalPolicy: 'never', profileId: 'full-access' };
      };
      assert.deepEqual(await staleBridge.permissionMenu('desktop-stale', true), { profileId: 'full-access' });
      assert.deepEqual(await staleBridge.selectPermission('desktop-stale', 'full-access', true), { profileId: 'full-access' });
      assert.equal(freshReads, 2);
    } finally {
      clearTimeout(permissionGuard);
      await permissionBridge.appServer.stop();
    }
    console.log('PASS native Desktop send and model selection use shared App Server RPCs');
  } finally {
    await bridge.appServer.stop();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
