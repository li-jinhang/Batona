'use strict';

const assert = require('node:assert/strict');
const { NativeCodexControl } = require('../native-codex-control');

function appServerForThread() {
  return {
    async request(method, params) {
      if (method === 'thread/read')
        return { thread: { id: params.threadId, name: '运行测试' } };
      if (method === 'thread/list')
        return { data: [{ id: 'thread-1', name: '运行测试' }], nextCursor: null };
      if (method === 'thread/turns/list') return { data: [{ items: [
        { type: 'userMessage', content: [{ type: 'text', text: '上一条用户消息' }] },
        { type: 'agentMessage', text: '上一条完整回复' },
      ] }] };
      throw new Error(`Unexpected app-server request: ${method}`);
    },
  };
}

(async () => {
  const processIds = [];
  let locateCalls = 0;
  const control = new NativeCodexControl({
    appServer: appServerForThread(),
    executable: __filename,
    locateWindow: async () => [101, 202][locateCalls++],
    run: async (_file, args) => {
      processIds.push(Number(args[1]));
      if (processIds.length === 1) {
        throw Object.assign(new Error('stale cached process'), {
          stderr: 'native-control-failed:process-lookup:ArgumentException',
        });
      }
      return { stdout: '{"accepted":true}' };
    },
  });

  assert.deepEqual(await control.send('thread-1', '新消息', 'keep-current'), { accepted: true });
  assert.deepEqual(processIds, [101, 202], 'refreshes a stale PID and retries once');
  assert.equal(locateCalls, 2);

  let sendButtonCalls = 0;
  let sendButtonLocateCalls = 0;
  const afterSendFailure = new NativeCodexControl({
    appServer: appServerForThread(),
    executable: __filename,
    locateWindow: async () => { sendButtonLocateCalls += 1; return 303; },
    run: async () => {
      sendButtonCalls += 1;
      throw Object.assign(new Error('send result may be uncertain'), {
        stderr: 'native-control-failed:confirm-submission:ArgumentException',
      });
    },
  });
  await assert.rejects(afterSendFailure.send('thread-1', '不要重复发送', 'keep-current'),
    (error) => error.code === 'native-control-failed:confirm-submission:ArgumentException');
  assert.equal(sendButtonCalls, 1, 'never retries after a submission may have happened');
  assert.equal(sendButtonLocateCalls, 1);
  console.log('PASS stale Codex PID refreshes once before UI control and uncertain sends are never retried');
})().catch((error) => { console.error(error); process.exitCode = 1; });
