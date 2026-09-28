'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { restartDshService } = require('../dsh-launcher');

test('restart waits for old listener to exit, clears old auth, then starts once', async () => {
  const calls = []; let checks = 0;
  const result = await restartDshService({
    stop: async () => calls.push('stop'),
    isListening: async () => ++checks < 3,
    wait: async () => calls.push('wait'),
    reset: () => calls.push('reset'),
    start: async () => { calls.push('start'); return true; },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, ['stop', 'wait', 'wait', 'reset', 'start']);
});
test('failed termination or occupied port must not start a duplicate DSH', async () => {
  for (const fails of [true, false]) {
    let restarted = false;
    await assert.rejects(restartDshService({
      stop: async () => { if (fails) throw new Error('unverified'); },
      isListening: async () => true, wait: async () => {},
      reset: () => { restarted = true; }, start: async () => { restarted = true; },
    }));
    assert.equal(restarted, false);
  }
});
