import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapter/dsh/adapter.ts';
import type { AgentSessionRef, WorkspaceView } from '../src/adapter/contract.ts';

const adapter = new DshAdapter();
const now = new Date().toISOString();
const workspaces: WorkspaceView[] = [
  { workspaceId: 'a', path: 'C:/a', title: 'A', sessionIds: ['one', 'shared'], createdAt: now, updatedAt: now },
  { workspaceId: 'b', path: 'C:/b', title: 'B', sessionIds: ['shared'], createdAt: now, updatedAt: now },
];
const sessions: AgentSessionRef[] = ['one', 'shared', 'loose'].map((backendSessionId, index) => ({
  backend: 'dsh', backendSessionId, title: backendSessionId, state: 'idle', createdAt: index + 1,
}));
adapter.listWorkspaces = async () => workspaces;
adapter.listSessions = async () => sessions;
const tree = await adapter.workspaceTree();
assert.deepEqual(tree.items.map((item) => item.sessions.map((session) => session.sessionId)), [['one', 'shared'], []]);
assert.deepEqual(tree.ungroupedSessions?.map((session) => session.sessionId), ['loose']);
assert.deepEqual([...tree.items.flatMap((item) => item.sessions), ...(tree.ungroupedSessions || [])]
  .map((session) => session.sessionId).sort(), sessions.map((session) => session.backendSessionId).sort());
workspaces[0].sessionIds.push('loose');
const moved = await adapter.workspaceTree();
assert.deepEqual(moved.ungroupedSessions, []);
assert.equal(moved.items[0].sessions.at(-1)?.sessionId, 'loose');
console.log('PASS DSH ungrouped membership and reassignment');
