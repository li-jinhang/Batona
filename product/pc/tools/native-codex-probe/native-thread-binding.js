'use strict';

const { createHash } = require('node:crypto');

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

function bindingError(code) {
  return Object.assign(new Error(code), { code });
}

function normalize(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function fingerprint(value) {
  return createHash('sha256').update(normalize(value), 'utf8').digest('hex');
}

function titleOf(thread) {
  return normalize(thread?.name || thread?.preview);
}

function latestPair(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const users = items.filter((item) => item?.type === 'userMessage');
  const assistants = items.filter((item) => item?.type === 'agentMessage');
  if (users.length !== 1 || assistants.length !== 1) throw bindingError('native-task-history-incomplete');
  const userText = normalize(users[0].content?.map((part) => part?.type === 'text' ? part.text || '' : '').join(''));
  const assistantText = normalize(assistants[0].text);
  if (!userText || !assistantText) throw bindingError('native-task-history-incomplete');
  return { userHash: fingerprint(userText), assistantHash: fingerprint(assistantText) };
}

async function uniqueListedThread(client, threadId, title) {
  let cursor;
  let targetCount = 0;
  let titleCount = 0;
  const seenCursors = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.request('thread/list', { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw bindingError('native-task-list-unavailable');
    for (const thread of result.data) {
      if (thread?.id === threadId) targetCount += 1;
      if (titleOf(thread) === title) titleCount += 1;
    }
    const next = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    if (!next) {
      if (targetCount !== 1) throw bindingError('native-task-not-listed');
      if (titleCount !== 1) throw bindingError('native-task-ambiguous');
      return;
    }
    if (seenCursors.has(next)) throw bindingError('native-task-list-incomplete');
    seenCursors.add(next);
    cursor = next;
  }
  throw bindingError('native-task-list-incomplete');
}

/**
 * Read-only verification for an already active native Codex task. The caller
 * must reverify immediately before any future write; this result is not a
 * durable authorization token.
 */
async function verifyNativeThreadBinding({ threadId, client, inspect }) {
  if (typeof inspect !== 'function') throw bindingError('native-task-invalid-input');
  const expectation = await readNativeThreadExpectation({ threadId, client });
  const observed = await inspect(expectation.title);
  if (!observed || observed.sidebarMatches !== 1 || observed.titleHash !== expectation.titleHash
    || observed.hasUser !== true || observed.hasAssistant !== true || observed.assistantComplete !== true
    || observed.lastUserHash !== expectation.lastUserHash || observed.lastAssistantHash !== expectation.lastAssistantHash) {
    throw bindingError('native-task-identity-mismatch');
  }
  if (!Number.isInteger(observed.processId) || observed.processId <= 0
    || !/^[0-9a-f]+$/i.test(observed.windowHandle || '')) {
    throw bindingError('native-task-window-unverified');
  }
  return Object.freeze({ ...expectation,
    processId: observed.processId,
    windowHandle: observed.windowHandle,
    verifiedAt: Date.now(),
  });
}

async function readNativeThreadExpectation({ threadId, client }) {
  const titleBinding = await readNativeThreadTitleExpectation({ threadId, client });
  const turns = await client.request('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'full',
  });
  if (!Array.isArray(turns?.data) || turns.data.length !== 1) throw bindingError('native-task-history-incomplete');
  const expected = latestPair(turns.data[0]);
  return Object.freeze({ ...titleBinding,
    lastUserHash: expected.userHash,
    lastAssistantHash: expected.assistantHash,
  });
}

async function readNativeThreadTitleExpectation({ threadId, client }) {
  if (typeof threadId !== 'string' || !threadId.trim() || !client?.request) {
    throw bindingError('native-task-invalid-input');
  }
  const result = await client.request('thread/read', { threadId, includeTurns: false });
  const thread = result?.thread;
  if (thread?.id !== threadId) throw bindingError('native-task-not-found');
  const title = titleOf(thread);
  if (!title) throw bindingError('native-task-title-missing');
  await uniqueListedThread(client, threadId, title);
  return Object.freeze({
    threadId,
    title,
    titleHash: fingerprint(title),
  });
}

module.exports = { verifyNativeThreadBinding, readNativeThreadExpectation, readNativeThreadTitleExpectation, fingerprint };
