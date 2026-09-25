'use strict';
const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

const bridge = new CodexBridge();
const frames = [];
bridge.broadcast = (frame) => frames.push(frame);
const notify = (method, params = {}) => bridge.onNotification({ method, params: { threadId: 'thread', ...params } });
notify('turn/started');
notify('item/started', { item: { type: 'reasoning' } });
notify('error', { willRetry: true, error: { message: 'transient' } });
notify('turn/completed', { turn: {} });
assert.deepEqual(frames.map((frame) => frame.event?.type), [
  'turn/start', 'session/thinking', 'session/reconnecting', 'turn/end',
]);
assert.equal(frames[2].event.attempt, undefined, 'retry count must not be fabricated');
(async () => {
  const nativeFrames = [];
  let status = { state: 'thinking' };
  const native = new CodexBridge({ nativeControl: { readProgress: async () => status } });
  native.appServer.ready = true;
  native.wss = { clients: { size: 1 } };
  native.nativeObservedThreadId = 'desktop-thread';
  native.broadcast = (frame) => nativeFrames.push(frame);
  await native.pollNativeProgress();
  await native.pollNativeProgress();
  status = { state: 'reconnecting', attempt: 2, maxAttempts: 5 };
  await native.pollNativeProgress();
  status = { state: 'reconnecting' };
  await native.pollNativeProgress();
  assert.deepEqual(nativeFrames.map((frame) => frame.event), [
    { type: 'session/thinking' },
    { type: 'session/reconnecting', attempt: 2, maxAttempts: 5 },
    { type: 'session/reconnecting' },
  ]);
  console.log('PASS Codex progress reflects backend and bound native statuses without invented retry count');
})().catch((error) => { console.error(error); process.exitCode = 1; });
