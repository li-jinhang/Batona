// Real protocol check in a fresh CODEX_HOME. No login, model call or user project writes.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { AppServerClient, CodexBridge } = require('../codex-bridge');

(async () => {
  const executable = process.argv[2];
  assert.ok(executable && fs.existsSync(executable), 'Pass the installed Codex CLI executable');
  const root = fs.mkdtempSync(path.resolve(__dirname, '../build/project-integration-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${listener.address().port}`;
  await new Promise(resolve => listener.close(resolve));
  const proc = spawn(executable, ['-c', 'features.code_mode_host=true', 'app-server', '--listen', url], {
    env: { ...process.env, CODEX_HOME: home }, stdio: 'ignore', windowsHide: true,
  });
  const bridge = new CodexBridge({ websocketUrl: url, enableSharedWrites: true });
  const observer = new AppServerClient({ websocketUrl: url });
  const notifications = [];
  observer.on('notification', message => { if (message.method === 'project/changed') notifications.push(message.params); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      ready = await bridge.appServer.start();
    }
    assert.ok(ready); assert.ok(await observer.start());
    assert.equal((await bridge.listProjects()).length, 0);
    const { project } = await bridge.createWorkspace(cwd);
    assert.equal((await observer.request('project/list', {})).data[0].id, project.id);
    assert.equal((await bridge.createWorkspace(cwd)).created, false);
    await bridge.renameProject(cwd, '手机重命名验证');
    assert.equal((await observer.request('project/read', { projectId: project.id })).project.name, '手机重命名验证');
    await bridge.deleteProject(cwd);
    assert.equal((await observer.request('project/list', {})).data.length, 0);
    assert.ok(fs.statSync(cwd).isDirectory());
    assert.deepEqual(notifications.map(event => event.changeType), ['created', 'updated', 'deleted']);
    assert.equal((await bridge.createWorkspace(cwd)).created, true);
    bridge.requireProfile = async () => ({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    const thread = await bridge.createThread({ cwd });
    assert.ok(thread.id);
    const read = await observer.request('thread/read', { threadId: thread.id, includeTurns: true });
    assert.equal(read.thread.name, '新会话');
    assert.equal(read.thread.historyMode, 'legacy');
    assert.equal((await observer.request('thread/resume', { threadId: thread.id })).thread.id, thread.id);
    assert.deepEqual((await observer.request('thread/turns/list', { threadId: thread.id })).data, []);
    assert.deepEqual(await bridge.history(thread.id), []);
    console.log('PASS real new empty conversation can be read, resumed and paginated by a second Desktop-like client');
    console.log('PASS real Codex project create/read/update/delete and cross-client notifications; isolated profile only');
  } finally {
    bridge.appServer.stop(); observer.stop();
    proc.kill();
    if (proc.exitCode === null) await new Promise(resolve => proc.once('exit', resolve));
    // Keep isolated output for diagnostics; no user files are read or removed.
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
