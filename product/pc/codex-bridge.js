'use strict';

/**
 * 本机 Codex App Server 桥。
 *
 * 此模块只监听 127.0.0.1。服务器只能经既有 Batona PC 出站隧道访问它；
 * 绝不启动公网监听，也不把 Codex 的认证材料、原始 App Server 帧或敏感工具输出写日志。
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { NativeCodexControl } = require('./native-codex-control');

const MAX_BODY_BYTES = 64 * 1024;
const HISTORY_EVENT_LIMIT = 200;
const THREAD_PAGE_LIMIT = 100;

class AppServerClient extends EventEmitter {
  constructor({ executable, log = () => {} } = {}) {
    super();
    this.executable = executable || resolveCodexExecutable();
    this.log = log;
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.starting = null;
  }

  async start() {
    if (this.ready) return true;
    if (this.starting) return this.starting;
    this.starting = this.startOnce().finally(() => { this.starting = null; });
    return this.starting;
  }

  async startOnce() {
    if (!this.executable || !fs.existsSync(this.executable)) {
      this.log('Codex 本机桥不可用：未找到 Codex Desktop CLI');
      return false;
    }
    const proc = spawn(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout.on('data', (chunk) => this.onStdout(String(chunk)));
    // stderr 可能带用户路径、命令或其他诊断，桥不转发其正文。
    proc.stderr.on('data', () => {});
    proc.on('error', () => this.onStopped('start-failed'));
    proc.on('exit', () => this.onStopped('stopped'));
    try {
      await this.request('initialize', {
        clientInfo: { name: 'batona', title: 'Batona PC', version: '0.3.0' },
        capabilities: { experimentalApi: true },
      }, 20_000);
      this.send({ method: 'initialized', params: {} });
      this.ready = true;
      this.emit('ready');
      return true;
    } catch {
      this.stop();
      this.log('Codex 本机桥不可用：App Server 初始化失败');
      return false;
    }
  }

  onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(rpcError(msg.error));
        else pending.resolve(msg.result);
        continue;
      }
      // App Server 可向客户端发 JSON-RPC request（带 id + method），例如审批。
      if (msg.id !== undefined && typeof msg.method === 'string') {
        this.emit('server-request', msg);
      } else if (typeof msg.method === 'string') {
        this.emit('notification', msg);
      }
    }
  }

  request(method, params, timeoutMs = 60_000) {
    if (!this.proc || !this.proc.stdin.writable) return Promise.reject(Object.assign(new Error('Codex App Server 未连接'), { code: 'not-connected' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Codex App Server 请求超时'), { code: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ method, id, params }); } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  respond(id, result) {
    if (!this.proc || !this.proc.stdin.writable) throw Object.assign(new Error('Codex App Server 未连接'), { code: 'not-connected' });
    this.send({ id, result });
  }

  send(message) {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onStopped(reason) {
    const wasReady = this.ready;
    this.ready = false;
    if (this.proc) this.proc = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('Codex App Server 已断开'), { code: 'not-connected' }));
    }
    this.pending.clear();
    if (wasReady) this.emit('stopped', reason);
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('Codex App Server 已停止'), { code: 'not-connected' }));
    }
    this.pending.clear();
    try { proc?.stdin.end(); } catch {}
    try { proc?.kill(); } catch {}
  }
}

class CodexBridge {
  constructor({ host = '127.0.0.1', port = 3082, userDataDir, executable, nativeControl, log = () => {} } = {}) {
    this.host = host;
    this.port = port;
    this.log = log;
    this.appServer = new AppServerClient({ executable, log });
    this.nativeControl = nativeControl || new NativeCodexControl({ appServer: this.appServer });
    this.nativePromptInFlight = false;
    this.bridgeOwnedThreads = new Set();
    this.server = null;
    this.wss = null;
    this.starting = null;
    this.pendingRequests = new Map();
    this.threadOptions = new Map();
    this.knownThreads = new Map();
    this.pollTimer = null;
    this.workspaceStore = userDataDir ? path.join(userDataDir, 'codex-workspaces.json') : null;
    this.explicitWorkspaces = loadWorkspaceStore(this.workspaceStore);

    this.appServer.on('notification', (msg) => this.onNotification(msg));
    this.appServer.on('server-request', (msg) => this.onServerRequest(msg));
    this.appServer.on('stopped', () => this.broadcast({ type: 'bridge-status', available: false }));
  }

  async start() {
    if (this.server) return this.starting || Promise.resolve(true);
    const server = http.createServer((req, res) => { void this.handleHttp(req, res); });
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/v1/events') { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
        ws.send(JSON.stringify({ type: 'bridge-status', available: this.appServer.ready }));
      });
    });
    this.starting = new Promise((resolve) => {
      const fail = () => {
        if (this.server === server) this.server = null;
        this.wss?.close(); this.wss = null;
        this.starting = null;
        this.log(`Codex 本机桥启动失败（${this.host}:${this.port}）`);
        resolve(false);
      };
      server.once('error', fail);
      server.listen(this.port, this.host, async () => {
        server.off('error', fail);
        server.on('error', () => this.log('Codex 本机桥运行异常'));
        this.starting = null;
        this.log(`Codex 本机桥就绪 http://${this.host}:${this.port}`);
        const compatible = await this.appServer.start();
        this.broadcast({ type: 'bridge-status', available: compatible });
        if (compatible) this.startPolling();
        resolve(true);
      });
    });
    return this.starting;
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.appServer.stop();
    const wss = this.wss; this.wss = null;
    try { wss?.clients.forEach((ws) => ws.close()); wss?.close(); } catch {}
    const server = this.server; this.server = null; this.starting = null;
    if (!server) return;
    await new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
  }

  startPolling() {
    if (this.pollTimer) return;
    void this.pollThreads();
    this.pollTimer = setInterval(() => { void this.pollThreads(); }, 5_000);
  }

  async ensureAppServer() {
    if (this.appServer.ready) return true;
    const ok = await this.appServer.start();
    this.broadcast({ type: 'bridge-status', available: ok });
    if (ok) this.startPolling();
    return ok;
  }

  async handleHttp(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const available = await this.ensureAppServer();
        writeJson(res, available ? 200 : 503, { ok: available, appServer: available, version: '0.3.0' });
        return;
      }
      if (!(await this.ensureAppServer())) throw Object.assign(new Error('Codex Desktop App Server 当前不可用'), { code: 'codex-unavailable' });
      if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        writeJson(res, 200, { threads: await this.listThreads() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/workspaces') {
        writeJson(res, 200, { items: await this.workspaceTree() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        writeJson(res, 200, { items: await this.listModels() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/profiles') {
        writeJson(res, 200, { items: await this.listProfiles() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/workspaces') {
        const body = await readJson(req);
        const cwd = asString(body.path);
        if (!cwd) throw Object.assign(new Error('工作区路径不能为空'), { code: 'bad-request' });
        const absolute = path.resolve(cwd);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw Object.assign(new Error('工作区目录不可用'), { code: 'workspace-invalid-path' });
        this.explicitWorkspaces.set(absolute, { path: absolute, createdAt: Date.now() });
        saveWorkspaceStore(this.workspaceStore, this.explicitWorkspaces);
        writeJson(res, 200, { workspace: workspaceFor(absolute, this.explicitWorkspaces.get(absolute).createdAt), created: true });
        return;
      }
      const workspaceDelete = /^\/v1\/workspaces\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && workspaceDelete) {
        const cwd = decodeWorkspaceId(decodeURIComponent(workspaceDelete[1]));
        if (!cwd) throw Object.assign(new Error('未知工作区'), { code: 'workspace-not-found' });
        this.explicitWorkspaces.delete(cwd);
        saveWorkspaceStore(this.workspaceStore, this.explicitWorkspaces);
        writeJson(res, 200, { deleted: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/sessions') {
        const body = await readJson(req);
        const thread = await this.createThread(body);
        writeJson(res, 200, { thread });
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)(?:\/(resume|prompt|cancel|respond|history|model|archive|name))?$/.exec(url.pathname);
      if (!match) { writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } }); return; }
      const threadId = decodeURIComponent(match[1]);
      const action = match[2];
      if (req.method === 'POST' && action === 'resume') {
        const body = await readJson(req);
        const thread = await this.resumeThread(threadId, body);
        writeJson(res, 200, { thread });
        return;
      }
      if (req.method === 'POST' && action === 'prompt') {
        const body = await readJson(req);
        await this.prompt(threadId, body);
        writeJson(res, 200, { accepted: true });
        return;
      }
      if (req.method === 'POST' && action === 'cancel') {
        await this.requireAppServerWriter(threadId);
        await this.appServer.request('turn/interrupt', { threadId });
        writeJson(res, 200, { accepted: true });
        return;
      }
      if (req.method === 'POST' && action === 'respond') {
        const body = await readJson(req);
        await this.respond(threadId, body);
        writeJson(res, 200, { accepted: true });
        return;
      }
      if (req.method === 'POST' && action === 'model') {
        const body = await readJson(req);
        await this.requireAppServerWriter(threadId, 'native-model-control-unavailable');
        this.threadOptions.set(threadId, modelOptions(body.model));
        writeJson(res, 200, { accepted: true });
        return;
      }
      if (req.method === 'POST' && action === 'name') {
        const body = await readJson(req);
        const name = asString(body.name).trim();
        if (!name) throw Object.assign(new Error('会话标题不能为空'), { code: 'bad-request' });
        await this.requireAppServerWriter(threadId);
        await this.appServer.request('thread/name/set', { threadId, name });
        this.broadcast({ type: 'agent-event', threadId, event: { type: 'session/title', title: redactText(name) } });
        writeJson(res, 200, { title: redactText(name) });
        return;
      }
      if (req.method === 'POST' && action === 'archive') {
        await this.requireAppServerWriter(threadId);
        await this.appServer.request('thread/archive', { threadId });
        writeJson(res, 200, { archived: true });
        return;
      }
      if (req.method === 'GET' && action === 'history') {
        writeJson(res, 200, { events: await this.history(threadId) });
        return;
      }
      writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'bridge-error';
      writeJson(res, code === 'not-connected' || code === 'codex-unavailable' ? 503 : 400, {
        ok: false,
        error: { code, message: safeErrorMessage(error) },
      });
    }
  }

  async listThreads() {
    const data = await this.listAllThreads();
    return data.map(normalizeThread);
  }

  async listAllThreads() {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const result = await this.appServer.request('thread/list', { limit: THREAD_PAGE_LIMIT, cursor });
      const rows = Array.isArray(result?.data) ? result.data : [];
      out.push(...rows);
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
      if (!cursor || rows.length === 0) break;
    }
    return out;
  }

  async workspaceTree() {
    const threads = (await this.listThreads()).sort((a, b) => b.updatedAt - a.updatedAt);
    const byPath = new Map();
    for (const item of this.explicitWorkspaces.values()) byPath.set(item.path, { createdAt: item.createdAt, sessions: [] });
    for (const thread of threads) {
      const cwd = thread.cwd || '';
      if (!cwd) continue; // 用户选择了“无工作区”的会话不造假分组，仍可从“新建会话”继续。
      if (!byPath.has(cwd)) byPath.set(cwd, { createdAt: thread.createdAt, sessions: [] });
      byPath.get(cwd).sessions.push({ sessionId: thread.id, title: thread.title, state: thread.state, updatedAt: thread.updatedAt });
    }
    return [...byPath.entries()]
      .map(([cwd, value]) => ({ workspace: workspaceFor(cwd, value.createdAt), sessions: value.sessions.sort((a, b) => b.updatedAt - a.updatedAt) }))
      .sort((a, b) => b.sessions[0]?.updatedAt - a.sessions[0]?.updatedAt || a.workspace.title.localeCompare(b.workspace.title));
  }

  async listModels() {
    const result = await this.appServer.request('model/list', {});
    const models = Array.isArray(result?.data) ? result.data : [];
    return models.flatMap((entry) => {
      if (entry?.hidden === true) return [];
      const model = asString(entry?.model) || asString(entry?.id);
      if (!model) return [];
      const efforts = Array.isArray(entry?.supportedReasoningEfforts) && entry.supportedReasoningEfforts.length
        ? entry.supportedReasoningEfforts.map(asString).filter(Boolean)
        : [asString(entry?.defaultReasoningEffort)].filter(Boolean);
      const useEfforts = efforts.length ? efforts : [''];
      return useEfforts.map((reasoningEffort) => ({
        provider: 'openai', model, reasoningEffort: reasoningEffort || undefined,
        displayName: redactText(asString(entry?.displayName) || model),
      }));
    });
  }

  async listProfiles() {
    const result = await this.appServer.request('permissionProfile/list', { limit: 20 });
    const allowed = new Map((Array.isArray(result?.data) ? result.data : []).map((p) => [asString(p?.id), p?.allowed === true]));
    // 手机上的三种名称是 Batona PC 的固定交互；底层仅使用 App Server 声明 allowed 的内建配置档。
    return [
      { id: 'request-approval', label: '请求批准', description: '仅在当前工作区内操作；需要越界时请求你的确认。', permissions: ':workspace', approvalPolicy: 'untrusted' },
      { id: 'assist-approval', label: '帮我审批', description: '允许当前工作区内常规操作；需要额外权限时再询问。', permissions: ':workspace', approvalPolicy: 'on-request' },
      { id: 'full-access', label: '完全访问', description: '不设本地沙箱限制；仅在你明确需要时使用。', permissions: ':danger-full-access', approvalPolicy: 'never' },
    ].map((profile) => ({ id: profile.id, label: profile.label, description: profile.description, available: allowed.get(profile.permissions) === true }));
  }

  async createThread(body) {
    const cwd = asString(body?.cwd);
    if (!cwd) throw Object.assign(new Error('请先选择电脑上的工作区目录'), { code: 'workspace-required' });
    const profile = await this.requireProfile(asString(body?.profileId));
    const model = modelOptions(body?.model);
    const result = await this.appServer.request('thread/start', {
      cwd,
      serviceName: 'batona',
      sandbox: profile.sandbox,
      approvalPolicy: profile.approvalPolicy,
      ...model,
    });
    const thread = normalizeThread(result?.thread || {});
    if (thread.id) this.bridgeOwnedThreads.add(thread.id);
    this.threadOptions.set(thread.id, { profile, ...model });
    this.broadcast({ type: 'thread-status', thread });
    return thread;
  }

  async resumeThread(threadId, body) {
    // Opening a conversation is a read, not a second writer. Desktop keeps
    // ownership of its running threads; acquire a writer only when sending.
    const profileId = asString(body?.profileId);
    const profile = profileId ? await this.requireProfile(profileId) : null;
    const result = await this.appServer.request('thread/read', { threadId, includeTurns: false });
    const thread = normalizeThread(result?.thread || { id: threadId });
    if (profile) this.threadOptions.set(threadId, { ...(this.threadOptions.get(threadId) || {}), profile });
    this.broadcast({ type: 'thread-status', thread });
    return thread;
  }

  async prompt(threadId, body) {
    const text = asString(body?.text);
    if (!text) throw Object.assign(new Error('消息不能为空'), { code: 'bad-request' });
    const profileId = asString(body?.profileId);
    const previous = this.threadOptions.get(threadId) || {};
    const profile = profileId ? await this.requireProfile(profileId) : previous.profile;
    const model = body?.model ? modelOptions(body.model) : modelOptions(previous);
    const read = await this.appServer.request('thread/read', { threadId, includeTurns: false });
    if (read?.thread?.id !== threadId) throw Object.assign(new Error('Codex 任务不存在'), { code: 'session-not-found' });
    if (read.thread.originator === 'Codex Desktop') {
      if (model.model || model.effort) throw Object.assign(new Error('请先在 Codex 电脑端确认模型选择'), { code: 'native-model-control-unavailable' });
      if (this.nativePromptInFlight) throw Object.assign(new Error('原生 Codex 正在提交另一条消息'), { code: 'native-control-busy' });
      const selectedProfileId = profileId || previous.profileId || 'request-approval';
      await this.requireProfile(selectedProfileId);
      this.nativePromptInFlight = true;
      try {
        await this.nativeControl.send(threadId, text, selectedProfileId);
        this.threadOptions.set(threadId, { ...previous, profileId: selectedProfileId, profile });
      } finally { this.nativePromptInFlight = false; }
      return;
    }
    if (!this.bridgeOwnedThreads.has(threadId) && read.thread.originator !== 'batona'
      && read.thread.originator !== 'Batona PC') {
      throw Object.assign(new Error('无法确认此 Codex 任务的写入来源'), { code: 'codex-native-control-unavailable' });
    }
    await this.appServer.request('thread/resume', { threadId, excludeTurns: true });
    // App Server 的 turn/start 原生调度决定是否排队/steer；Batona PC 不另造队列。
    await this.appServer.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      ...(profile ? { sandboxPolicy: profile.sandboxPolicy, approvalPolicy: profile.approvalPolicy } : {}),
      ...model,
    });
    this.threadOptions.set(threadId, { ...previous, profile, ...model });
  }

  async requireAppServerWriter(threadId, nativeCode = 'codex-native-control-unavailable') {
    const read = await this.appServer.request('thread/read', { threadId, includeTurns: false });
    if (read?.thread?.id !== threadId) throw Object.assign(new Error('Codex 任务不存在'), { code: 'session-not-found' });
    if (read.thread.originator === 'Codex Desktop')
      throw Object.assign(new Error('该操作尚未接入 Codex 原生窗口'), { code: nativeCode });
    if (!this.bridgeOwnedThreads.has(threadId) && read.thread.originator !== 'batona'
      && read.thread.originator !== 'Batona PC')
      throw Object.assign(new Error('无法确认此 Codex 任务的写入来源'), { code: 'codex-native-control-unavailable' });
  }

  async history(threadId) {
    try {
      const result = await this.appServer.request('thread/turns/list', {
        threadId, limit: 50, sortDirection: 'desc', itemsView: 'full',
      });
      const turns = Array.isArray(result?.data) ? result.data.slice().reverse() : [];
      return turns.flatMap((turn) => eventsFromItems(turn?.items)).slice(-HISTORY_EVENT_LIMIT);
    } catch {
      // 旧版持久化记录不支持分页时，不订阅/恢复它；只读回退同样经过输出脱敏。
      const result = await this.appServer.request('thread/read', { threadId, includeTurns: true });
      const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
      return turns.flatMap((turn) => eventsFromItems(turn?.items)).slice(-HISTORY_EVENT_LIMIT);
    }
  }

  async respond(threadId, body) {
    await this.requireAppServerWriter(threadId);
    const rpcId = body?.rpcId;
    const pending = this.pendingRequests.get(String(rpcId));
    if (!pending || pending.threadId !== threadId) throw Object.assign(new Error('该请求已处理或不属于当前会话'), { code: 'interaction-resolved' });
    const result = responseFor(pending, body?.payload || {});
    this.appServer.respond(pending.rpcId, result);
    this.pendingRequests.delete(pending.rpcId);
  }

  async requireProfile(id) {
    const profiles = await this.listProfiles();
    const selected = profiles.find((p) => p.id === (id || 'request-approval'));
    if (!selected?.available) throw Object.assign(new Error('该权限配置档在当前 Codex 环境不可用'), { code: 'capability-missing' });
    return profileDetails(selected.id);
  }

  onNotification(msg) {
    const threadId = asString(msg?.params?.threadId) || asString(msg?.params?.turn?.threadId);
    const event = eventFromNotification(msg);
    if (threadId && event) this.broadcast({ type: 'agent-event', threadId, event });
    if (msg?.method === 'serverRequest/resolved') {
      const requestId = asString(msg?.params?.requestId);
      if (requestId) this.pendingRequests.delete(requestId);
    }
    if (msg?.method === 'thread/status/changed' && msg?.params?.thread) {
      this.broadcast({ type: 'thread-status', thread: normalizeThread(msg.params.thread) });
    }
  }

  onServerRequest(msg) {
    const normalized = normalizeServerRequest(msg);
    if (!normalized) {
      // 未实现的 App Server 请求一律安全拒绝，不能因手机 UI 缺失而默认放行。
      try { this.appServer.respond(msg.id, { action: 'decline', content: null }); } catch {}
      return;
    }
    this.pendingRequests.set(normalized.rpcId, normalized);
    this.broadcast({ type: 'agent-event', threadId: normalized.threadId, event: normalized.event });
  }

  async pollThreads() {
    if (!this.appServer.ready) return;
    try {
      const threads = await this.listThreads();
      for (const thread of threads) {
        const fingerprint = `${thread.updatedAt}|${thread.state}|${thread.title}`;
        if (this.knownThreads.get(thread.id) !== fingerprint) {
          this.knownThreads.set(thread.id, fingerprint);
          this.broadcast({ type: 'thread-status', thread });
        }
      }
    } catch { /* 下一轮重试；不把本地诊断或会话数据写入日志 */ }
  }

  broadcast(value) {
    if (!this.wss) return;
    const text = JSON.stringify(value);
    for (const client of this.wss.clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  }
}

function resolveCodexExecutable() {
  const override = process.env.BATONA_CODEX_PATH;
  if (override && fs.existsSync(override)) return override;
  const root = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (!root || !fs.existsSync(root)) return null;
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const candidate = path.join(root, entry.name, 'codex.exe');
        return { candidate, mtime: fs.existsSync(candidate) ? fs.statSync(candidate).mtimeMs : 0 };
      })
      .filter((entry) => entry.mtime > 0)
      .sort((a, b) => b.mtime - a.mtime)[0]?.candidate || null;
  } catch { return null; }
}

function normalizeThread(value) {
  const status = asString(value?.status?.type).toLowerCase();
  return {
    id: asString(value?.id),
    title: redactText(asString(value?.name) || asString(value?.preview) || '未命名会话'),
    cwd: asString(value?.cwd),
    createdAt: toEpochMs(value?.createdAt),
    updatedAt: toEpochMs(value?.updatedAt || value?.recencyAt || value?.createdAt),
    state: stateFromStatus(status),
    model: asString(value?.model) || undefined,
    reasoningEffort: asString(value?.reasoningEffort) || undefined,
  };
}

function stateFromStatus(status) {
  if (status.includes('approval')) return 'waiting-approval';
  if (status.includes('question') || status.includes('input')) return 'waiting-question';
  if (status.includes('active') || status.includes('running') || status.includes('progress')) return 'running';
  if (status.includes('error') || status.includes('fail')) return 'error';
  return 'done';
}

function workspaceFor(cwd, createdAt) {
  return { workspaceId: workspaceId(cwd), path: cwd, title: path.basename(cwd) || cwd, sessionIds: [], createdAt: new Date(createdAt || Date.now()).toISOString(), updatedAt: new Date().toISOString() };
}
function workspaceId(cwd) { return `cwd:${Buffer.from(cwd, 'utf8').toString('base64url')}`; }
function decodeWorkspaceId(id) {
  if (!id.startsWith('cwd:')) return null;
  try { return Buffer.from(id.slice(4), 'base64url').toString('utf8'); } catch { return null; }
}

function modelOptions(value) {
  if (!value || typeof value !== 'object') return {};
  const model = asString(value.model);
  const effort = asString(value.reasoningEffort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
function profileDetails(id) {
  return {
    // 此台 Codex App Server 的协议 schema 仍使用 sandbox / sandboxPolicy。
    // permissionProfile/list 负责确认对应内建 profile 未被本机策略禁用；这里仅做一对一
    // 的兼容映射，绝不接受来自手机的任意 sandbox 参数。
    'request-approval': { permissions: ':workspace', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'untrusted' },
    'assist-approval': { permissions: ':workspace', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' },
    'full-access': { permissions: ':danger-full-access', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' },
  }[id] || null;
}

function eventFromNotification(msg) {
  const p = msg?.params || {};
  switch (msg?.method) {
    case 'turn/started': return { type: 'turn/start' };
    case 'turn/completed': {
      const error = p?.turn?.error;
      return error ? { type: 'error', code: 'turn-failed', message: redactText(asString(error.message) || 'Codex 回合失败') } : { type: 'turn/end' };
    }
    case 'item/agentMessage/delta': return { type: 'assistant/chunk', text: redactText(asString(p?.delta)) };
    case 'item/started': return eventFromItem(p?.item, false);
    case 'item/completed': return eventFromItem(p?.item, true);
    default: return null;
  }
}

function eventsFromItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => eventFromItem(item, true)).filter(Boolean);
}

function eventFromItem(item, completed) {
  const type = asString(item?.type);
  if (type === 'userMessage') return { type: 'user/message', text: redactText(contentText(item?.content) || asString(item?.text)) };
  if (type === 'agentMessage') return { type: 'assistant/message', text: redactText(asString(item?.text)) };
  if (type === 'commandExecution') return completed
    ? { type: 'tool/result', toolName: '执行命令', callId: asString(item?.id) || undefined, ok: asString(item?.status) !== 'failed' && asString(item?.status) !== 'declined', summary: redactText(asString(item?.aggregatedOutput)).slice(0, 2000) || undefined }
    : { type: 'tool/call', toolName: '执行命令', callId: asString(item?.id) || undefined };
  if (type === 'fileChange') return completed
    ? { type: 'tool/result', toolName: '修改文件', callId: asString(item?.id) || undefined, ok: asString(item?.status) !== 'failed' && asString(item?.status) !== 'declined', summary: '文件修改已处理' }
    : { type: 'tool/call', toolName: '修改文件', callId: asString(item?.id) || undefined };
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'webSearch') {
    const name = redactText(asString(item?.tool) || asString(item?.name) || (type === 'webSearch' ? '网页搜索' : '工具调用'));
    return completed
      ? { type: 'tool/result', toolName: name, callId: asString(item?.id) || undefined, ok: item?.success !== false && asString(item?.status) !== 'failed', summary: redactText(asString(item?.error) || asString(item?.result)).slice(0, 2000) || undefined }
      : { type: 'tool/call', toolName: name, callId: asString(item?.id) || undefined };
  }
  return null;
}

function normalizeServerRequest(msg) {
  const method = asString(msg?.method);
  const p = msg?.params || {};
  const threadId = asString(p.threadId);
  const rpcId = String(msg.id ?? '');
  if (!threadId || !rpcId) return null;
  if (method === 'item/commandExecution/requestApproval') {
    return { rpcId, threadId, method, params: p, event: { type: 'approval/requested', approvalId: rpcId, rpcId, toolName: '执行命令', reason: redactText(asString(p.reason) || asString(p.command) || 'Codex 请求执行命令') } };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { rpcId, threadId, method, params: p, event: { type: 'approval/requested', approvalId: rpcId, rpcId, toolName: '修改文件', reason: redactText(asString(p.reason) || 'Codex 请求修改文件') } };
  }
  if (method === 'item/permissions/requestApproval') {
    return { rpcId, threadId, method, params: p, event: { type: 'approval/requested', approvalId: rpcId, rpcId, toolName: '额外权限', reason: redactText(asString(p.reason) || 'Codex 请求额外权限') } };
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(p.questions) ? p.questions : [];
    const normalized = questions.map((question, questionIndex) => {
      const options = Array.isArray(question?.options) ? question.options.map((option, optionIndex) => {
        const label = redactText(asString(option?.label) || asString(option?.text) || String(optionIndex + 1));
        // Codex 的 request_user_input 用 option label 作为 answer 值，不能让手机凭空编造 ID。
        return { id: label, label, description: redactText(asString(option?.description)) || undefined };
      }) : undefined;
      return {
        id: asString(question?.id) || `answer-${questionIndex + 1}`,
        kind: options?.length ? 'select' : 'text',
        prompt: redactText(asString(question?.question) || asString(question?.prompt) || asString(p.message) || 'Codex 需要你的输入'),
        isSecret: question?.isSecret === true,
        options,
      };
    });
    return { rpcId, threadId, method, params: p, event: { type: 'question/requested', questionRpcId: rpcId, rpcId, questions: normalized.length ? normalized : [{ id: 'answer', kind: 'text', prompt: 'Codex 需要你的输入' }] } };
  }
  return null;
}

function responseFor(pending, payload) {
  const outcome = asString(payload?.outcome);
  if (pending.method === 'item/commandExecution/requestApproval' || pending.method === 'item/fileChange/requestApproval') {
    return { decision: outcome === 'allowed-once' ? 'accept' : outcome === 'cancelled' ? 'cancel' : 'decline' };
  }
  if (pending.method === 'item/permissions/requestApproval') {
    if (outcome !== 'allowed-once') return { permissions: {}, scope: 'turn' };
    const requested = pending.params?.permissions && typeof pending.params.permissions === 'object' ? pending.params.permissions : {};
    return { permissions: requested, scope: 'turn' };
  }
  if (pending.method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(pending.params?.questions) ? pending.params.questions : [];
    const submitted = Array.isArray(payload?.answers) ? payload.answers : [];
    const answers = {};
    for (let index = 0; index < Math.max(questions.length, 1); index++) {
      const question = questions[index] || {};
      const questionId = asString(question?.id) || (index ? `answer-${index + 1}` : 'answer');
      const selectedInput = submitted.find((item) => asString(item?.id) === questionId) || (index === 0 ? payload : {});
      const selected = payload?.skip === true ? [] : Array.isArray(selectedInput?.selected) ? selectedInput.selected.map(asString).filter(Boolean) : [];
      const custom = payload?.skip === true ? '' : asString(selectedInput?.custom) || asString(selectedInput?.answer);
      answers[questionId] = { answers: selected.length ? selected : custom ? [custom] : [] };
    }
    return { answers };
  }
  return { action: 'decline', content: null };
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((part) => asString(part?.text) || asString(part?.content)).join('');
}
function asString(value) { return typeof value === 'string' ? value : ''; }
function toEpochMs(value) { const n = Number(value); return Number.isFinite(n) ? (n < 10_000_000_000 ? n * 1000 : n) : Date.now(); }
function rpcError(error) {
  if (/already has an active writer/i.test(asString(error?.message))) {
    return Object.assign(new Error('此会话由 Codex 电脑端持有，历史仍可查看；当前独立桥无法代替电脑端发送，请在电脑端继续。'), { code: 'codex-desktop-owned' });
  }
  return Object.assign(new Error('Codex App Server 拒绝请求'), { code: `rpc-${String(error?.code ?? 'error')}` });
}
function safeErrorMessage(error) { return redactText(asString(error?.message) || 'Codex 本机桥请求失败').slice(0, 200); }

/** 保守脱敏：规则命中时宁可少显示，也不能把连接串、认证头或常见凭据值发出电脑。 */
function redactText(value) {
  return asString(value)
    .replace(/batona-gw:\/\/\S+/gi, '[已隐藏连接串]')
    .replace(/\bbearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
    .replace(/(["']?(?:[a-z0-9_-]*token|api[_-]?key|password|passwd|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,;"']+/gi, '$1[已隐藏]')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[已隐藏私钥]');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { size += Buffer.byteLength(chunk); if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('请求过大'), { code: 'payload-too-large' })); req.destroy(); } else text += chunk; });
    req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(Object.assign(new Error('JSON 格式无效'), { code: 'bad-request' })); } });
    req.on('error', reject);
  });
}
function writeJson(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function loadWorkspaceStore(file) {
  if (!file) return new Map();
  try { const rows = JSON.parse(fs.readFileSync(file, 'utf8')); return new Map(Array.isArray(rows) ? rows.filter((r) => typeof r?.path === 'string').map((r) => [r.path, { path: r.path, createdAt: Number(r.createdAt) || Date.now() }]) : []); } catch { return new Map(); }
}
function saveWorkspaceStore(file, entries) { if (!file) return; try { fs.writeFileSync(file, JSON.stringify([...entries.values()], null, 2), 'utf8'); } catch {} }

module.exports = { AppServerClient, CodexBridge, resolveCodexExecutable, redactText };
