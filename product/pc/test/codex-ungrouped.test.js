'use strict';
const assert = require('node:assert/strict');
const { CodexBridge } = require('../codex-bridge');

(async () => {
  const bridge = new CodexBridge();
  bridge.listThreads = async () => [
    { id: 'grouped', cwd: 'C:/repo', title: 'Grouped', state: 'idle', createdAt: 1, updatedAt: 4 },
    { id: 'needs-read', cwd: '', title: 'Resolved', state: 'idle', createdAt: 2, updatedAt: 3 },
    { id: 'loose', cwd: '', title: 'Loose', state: 'idle', createdAt: 3, updatedAt: 2 },
  ];
  bridge.appServer.request = async (_method, params) => ({ thread: {
    id: params.threadId, cwd: params.threadId === 'needs-read' ? 'C:/other' : '',
  } });
  const tree = await bridge.workspaceTree();
  assert.equal(tree.items.length, 0, 'cwd alone must never manufacture a workspace');
  assert.deepEqual(tree.ungroupedSessions.map((session) => session.sessionId), ['grouped', 'needs-read', 'loose']);
  assert.equal(tree.items.flatMap((item) => item.sessions).length, 0);
  const large = new CodexBridge();
  large.listThreads = async () => Array.from({ length: 30 }, (_, index) => ({
    id: `missing-${index}`, cwd: '', title: '', state: 'idle', createdAt: index, updatedAt: 30 - index,
  }));
  let reads = 0;
  large.appServer.request = async () => { reads++; return { thread: { id: `missing-${reads - 1}`, cwd: '' } }; };
  assert.equal((await large.workspaceTree()).ungroupedSessions.length, 30);
  assert.equal(reads, 24);
  assert.equal((await large.workspaceTree()).ungroupedSessions.length, 30);
  assert.equal(reads, 30);
  console.log('PASS Codex missing directories resolve before ungrouped classification');
})().catch((error) => { console.error(error); process.exitCode = 1; });
