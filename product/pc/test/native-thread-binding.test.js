'use strict';

const assert = require('node:assert/strict');
const { verifyNativeThreadBinding, readNativeThreadTitleExpectation, fingerprint } = require('../tools/native-codex-probe/native-thread-binding');

const threadId = 'thread-a';
const title = '运行测试';
const userText = '测试输入\n';
const assistantText = '测试回复';
const observation = {
  processId: 1234,
  windowHandle: 'abcd',
  titleHash: fingerprint(title),
  sidebarMatches: 1,
  lastUserHash: fingerprint(userText),
  lastAssistantHash: fingerprint(assistantText),
  hasUser: true,
  hasAssistant: true,
  assistantComplete: true,
};

function clientFor({ list = [{ id: threadId, name: title }], turnItems, secondPage = false } = {}) {
  const items = turnItems || [
    { type: 'userMessage', content: [{ type: 'text', text: userText }] },
    { type: 'agentMessage', text: assistantText },
  ];
  return {
    async request(method, params) {
      if (method === 'thread/read') return { thread: { id: threadId, name: title } };
      if (method === 'thread/turns/list') return { data: [{ items }] };
      if (method === 'thread/list') {
        if (params.cursor) return { data: secondPage ? [{ id: 'other', name: title }] : [], nextCursor: null };
        return { data: list, nextCursor: secondPage ? 'next' : null };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
}

async function rejects(code, options, observed = observation) {
  await assert.rejects(
    verifyNativeThreadBinding({ threadId, client: clientFor(options), inspect: async () => observed }),
    (error) => error.code === code,
  );
}

(async () => {
  const bound = await verifyNativeThreadBinding({
    threadId, client: clientFor(), inspect: async () => observation,
  });
  assert.equal(bound.threadId, threadId);
  assert.equal(bound.windowHandle, observation.windowHandle);
  const titleBound = await readNativeThreadTitleExpectation({ threadId, client: clientFor({ turnItems: [] }) });
  assert.equal(titleBound.titleHash, fingerprint(title));
  await assert.rejects(readNativeThreadTitleExpectation({ threadId,
    client: clientFor({ list: [{ id: threadId, name: title }, { id: 'other', name: title }] }),
  }), (error) => error.code === 'native-task-ambiguous');
  await rejects('native-task-ambiguous', { list: [{ id: threadId, name: title }, { id: 'thread-b', name: title }] });
  await rejects('native-task-ambiguous', { secondPage: true });
  await rejects('native-task-not-listed', { list: [{ id: 'other', name: '别的任务' }] });
  await rejects('native-task-history-incomplete', { turnItems: [{ type: 'userMessage', content: [{ type: 'text', text: userText }] }] });
  await rejects('native-task-identity-mismatch', {}, { ...observation, lastAssistantHash: fingerprint('别的回复') });
  await rejects('native-task-identity-mismatch', {}, { ...observation, sidebarMatches: 2 });
  await rejects('native-task-identity-mismatch', {}, { ...observation, assistantComplete: false });
  console.log('PASS native task binding and fail-closed cases');
})().catch((error) => { console.error(error); process.exitCode = 1; });
