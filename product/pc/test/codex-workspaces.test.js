'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CodexBridge } = require('../codex-bridge');

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batona-workspace-test-'));
  const calls = [];
  const bridge = new CodexBridge({ userDataDir: root, codexStatePath: path.join(root, 'desktop.json'),
    websocketUrl: 'ws://127.0.0.1:45678', enableSharedWrites: true,
    nativeControl: {
      async createWorkspace(cwd) { calls.push(['create', cwd]); return { accepted: true }; },
      async renameWorkspace(...args) { calls.push(['rename', ...args]); return { accepted: true }; },
    },
  });
  bridge.ensureAppServer = async () => true;
  bridge.listThreads = async () => [];
  bridge.listAllThreads = async () => [];
  const projects = new Map();
  bridge.appServer.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'project/list') return { data: [...projects.values()], nextCursor: null };
    if (method === 'project/create') {
      const project = { id: 'project-1', name: params.name, roots: params.roots, createdAt: 1 };
      projects.set(project.id, project);
      return { project };
    }
    if (method === 'project/read') return { project: projects.get(params.projectId) };
    if (method === 'project/update') { Object.assign(projects.get(params.projectId), { name: params.name }); return { project: projects.get(params.projectId) }; }
    if (method === 'project/delete') { projects.delete(params.projectId); return {}; }
    throw new Error(`Unexpected method: ${method}`);
  };
  const server = http.createServer((req, res) => bridge.handleHttp(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === 'DELETE' ? 'DELETE' : body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
      body: body && body !== 'DELETE' ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ bridge, root, calls, api, projects }); }
  finally { await new Promise(resolve => server.close(resolve)); bridge.appServer.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('legacy refresh removes archived-only Desktop roots without waiting for the archive TTL', async () => fixture(async ({ bridge, root }) => {
  bridge.appServer.ready = true;
  bridge.listProjects = async () => null;
  fs.writeFileSync(bridge.codexStatePath, JSON.stringify({ 'electron-saved-workspace-roots': [root] }));
  bridge.explicitWorkspaces.set('old', { path: root });
  bridge.archivedWorkspacePathsLoadedAt = Date.now();
  bridge.listAllThreads = async () => [{ id: 'archived', cwd: root }];
  assert.deepEqual((await bridge.workspaceTree()).items, []);
  bridge.listThreads = async () => [{ id: 'active', cwd: root, updatedAt: 1 }];
  assert.equal((await bridge.workspaceTree()).items.length, 1, 'an active conversation keeps its workspace visible');
}));

test('failed archive validation rejects refresh instead of returning a falsely validated tree', async () => fixture(async ({ bridge }) => {
  bridge.appServer.ready = true;
  bridge.listProjects = async () => null;
  bridge.listAllThreads = async () => { throw new Error('archive service unavailable'); };
  await assert.rejects(bridge.workspaceTree(), /archive service unavailable/);
}));

test('authoritative projects exclude removed and phantom roots; cwd does not create projects', async () => fixture(async ({ bridge, root, projects }) => {
  fs.writeFileSync(bridge.codexStatePath, JSON.stringify({ 'electron-saved-workspace-roots': [path.join(root, 'removed')] }));
  bridge.explicitWorkspaces.set('phantom', { path: path.join(root, '_Documents') });
  projects.set('real', { id: 'real', name: 'Real', roots: [{ path: root }] });
  bridge.listThreads = async () => [
    { id: 'nih', cwd: path.join(root, '..', 'nih'), projectId: null },
    { id: 'yo', cwd: path.join(root, '..', 'yo'), projectId: null },
    { id: 'xia', cwd: path.join(root, '..', 'xia'), projectId: null },
    { id: 'assigned', cwd: root, projectId: 'real' },
    { id: 'legacy-assigned', cwd: root, projectId: null },
  ];
  let tree = await bridge.workspaceTree();
  assert.deepEqual(tree.items.map(x => x.workspace.title), ['Real']);
  assert.deepEqual(tree.items[0].sessions.map(x => x.sessionId), ['assigned', 'legacy-assigned']);
  assert.deepEqual(tree.ungroupedSessions.map(x => x.sessionId), ['nih', 'yo', 'xia']);
  projects.clear();
  tree = await bridge.workspaceTree();
  assert.deepEqual(tree.items, []);
  assert.equal(tree.ungroupedSessions.length, 5);
}));

test('creating a workspace must register the directory in Desktop before reporting success', async () => fixture(async ({ root, calls, api }) => {
  const result = await api('/v1/workspaces', { path: root });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(([method]) => method), ['project/list', 'project/create', 'project/read']);
  assert.deepEqual(calls[1][1].roots, [{ path: root }]);
  assert.equal((await api('/v1/workspaces', { path: root })).body.created, false);
  assert.equal(calls.filter(([method]) => method === 'project/create').length, 1);
}));

test('Desktop registration failure must not leave a phantom workspace', async () => fixture(async ({ bridge, root, api }) => {
  bridge.appServer.request = async method => {
    if (method === 'project/list') return { data: [] };
    throw Object.assign(new Error('failed'), { code: 'workspace-write-unconfirmed' });
  };
  const result = await api('/v1/workspaces', { path: root });
  assert.equal(result.status, 400);
  assert.equal(bridge.explicitWorkspaces.size, 0);
}));

test('rename binds to the real project ID rather than stale mobile labels', async () => fixture(async ({ bridge, root, calls, api, projects }) => {
  const { body } = await api('/v1/workspaces', { path: root });
  fs.writeFileSync(bridge.codexStatePath, JSON.stringify({
    'electron-saved-workspace-roots': [root], 'electron-workspace-root-labels': { [root]: 'Desktop title' },
  }));
  projects.get('project-1').name = 'Desktop title';
  calls.length = 0;
  const renamed = await api(`/v1/workspaces/${body.workspace.workspaceId}/rename`, { title: 'New title' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(calls, [
    ['project/list', { cursor: null, limit: 100 }],
    ['project/update', { projectId: 'project-1', name: 'New title' }],
    ['project/read', { projectId: 'project-1' }],
  ]);
  projects.get('project-1').name = 'Renamed on Desktop';
  assert.equal((await api('/v1/workspaces')).body.items[0].workspace.title, 'Renamed on Desktop');
}));

test('failed readback must not commit a new title to the mobile cache', async () => fixture(async ({ bridge, root, api }) => {
  const { body } = await api('/v1/workspaces', { path: root });
  const original = bridge.appServer.request;
  bridge.appServer.request = async (method, params) => method === 'project/update' ? {} : original(method, params);
  const result = await api(`/v1/workspaces/${body.workspace.workspaceId}/rename`, { title: 'Not applied' });
  assert.equal(result.body.error.code, 'workspace-write-unconfirmed');
  assert.equal(bridge.workspaceIndex.get(body.workspace.workspaceId).title, path.basename(root));
}));

test('read-only shared connections reject project writes without changing Desktop or cache', async () => fixture(async ({ bridge, root, calls, api }) => {
  bridge.enableSharedWrites = false;
  assert.equal((await api('/v1/workspaces', { path: root })).body.error.code, 'shared-transport-readonly');
  assert.equal(calls.length, 0);
  assert.equal(bridge.explicitWorkspaces.size, 0);
}));

test('removal updates the project catalog without deleting the directory', async () => fixture(async ({ root, api, projects }) => {
  const { body } = await api('/v1/workspaces', { path: root });
  assert.equal((await api(`/v1/workspaces/${body.workspace.workspaceId}`, 'DELETE')).status, 200);
  assert.equal(projects.size, 0);
  assert.ok(fs.statSync(root).isDirectory());
}));

test('new shared tasks include the real project ID', async () => fixture(async ({ bridge, root, api }) => {
  await api('/v1/workspaces', { path: root });
  bridge.requireProfile = async () => ({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  const original = bridge.appServer.request;
  let started;
  bridge.appServer.request = async (method, params) => {
    if (method === 'thread/name/set') { assert.equal(params.name, '新会话'); return {}; }
    if (method === 'thread/read') return { thread: { id: 'new-thread', cwd: root, name: '新会话' } };
    if (method !== 'thread/start') return original(method, params);
    started = params;
    return { thread: { id: 'new-thread', cwd: root } };
  };
  assert.equal((await api('/v1/sessions', { cwd: root })).status, 200);
  assert.equal(started.projectId, 'project-1');
  assert.equal(started.cwd, root);
  assert.equal(started.historyMode, 'legacy');
  assert.equal(started.serviceName, undefined);
}));

test('a removed workspace cannot create an orphan conversation', async () => fixture(async ({ bridge, root, calls, api }) => {
  bridge.requireProfile = async () => ({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  const response = await api('/v1/sessions', { cwd: root });
  assert.equal(response.body.error.code, 'workspace-not-found');
  assert.equal(calls.some(([method]) => method === 'thread/start'), false);
}));

test('unsupported project protocol fails explicitly without phantom registration', async () => fixture(async ({ bridge, root, api }) => {
  bridge.appServer.request = async () => { throw Object.assign(new Error('unsupported'), { code: 'rpc--32601' }); };
  assert.equal((await api('/v1/workspaces', { path: root })).body.error.code, 'codex-projects-unavailable');
  assert.equal(bridge.explicitWorkspaces.size, 0);
}));

test('multi-root projects cannot be removed as if they were a single directory', async () => fixture(async ({ root, api, projects }) => {
  const { body } = await api('/v1/workspaces', { path: root });
  projects.get('project-1').roots.push({ path: path.join(root, 'other') });
  assert.equal((await api(`/v1/workspaces/${body.workspace.workspaceId}`, 'DELETE')).body.error.code, 'workspace-ambiguous');
  assert.equal(projects.size, 1);
}));
