import './style.css';
import jsQR from 'jsqr';
import { credentialStore } from './storage.js';
import { GatewayClient } from './gateway.js';
import { backendIdAllowed, PRODUCT_BACKENDS, visibleBackendIds } from './backend-policy.js';
import { newestSessionsFirst } from './session-order.js';

const BASE = import.meta.env.BASE_URL;
const E2E_MODE = import.meta.env.MODE === 'e2e';
const app = document.querySelector('#app');
const connectionPill = document.querySelector('#connection-state');
const toastNode = document.querySelector('#toast');
const state = {
  credentials: null,
  view: 'pair',
  notice: '',
  noticeKind: 'info',
  code: '',
  pairing: false,
  pairPoll: null,
  client: null,
  hello: null,
  online: false,
  pcOnline: false,
  backends: PRODUCT_BACKENDS,
  backend: 'dsh',
  sessions: [],
  allSessions: [],
  tree: [],
  showOlder: new Set(),
  current: null,
  events: [],
  draft: '',
  pendingInteractions: [],
  settings: null,
  modelChoices: [],
  profiles: [],
  permissionPresets: null,
  push: { configured: false, subscribed: false, denied: false },
  dir: { open: false, path: '', roots: [], dirs: [], loading: false },
  modal: null,
  requestBusy: false,
  ios: isIOS(),
  standalone: isStandalone(),
  iosVersion: iosVersion(),
};

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function iosVersion() {
  const match = navigator.userAgent.match(/OS (\d+)[_.](\d+)/);
  return match ? Number(match[1]) + Number(match[2]) / 10 : null;
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function showToast(message) {
  toastNode.textContent = message;
  toastNode.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toastNode.hidden = true; }, 3600);
}
function setConnection(kind, label) {
  connectionPill.dataset.state = kind;
  connectionPill.querySelector('span').textContent = label;
}
function setNotice(message, kind = 'info') {
  state.notice = message;
  state.noticeKind = kind;
  render();
}
function alertHtml() {
  if (!state.notice) return '';
  return `<p class="notice ${state.noticeKind === 'error' ? 'error' : state.noticeKind === 'success' ? 'success' : ''}" role="status">${esc(state.notice)}</p>`;
}

async function api(op, body = {}, token = state.credentials?.token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`/api/access/${op}`, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
  let result;
  try { result = await response.json(); } catch { throw new Error('网关返回了无法读取的响应'); }
  if (!response.ok || result.ok !== true) {
    const error = new Error(friendlyError(result.error, response.status));
    error.code = result.error;
    error.status = response.status;
    if (response.status === 401 && token === state.credentials?.token) void authorizationExpired();
    throw error;
  }
  return result;
}

function friendlyError(code, status) {
  const values = {
    'phone-slot-occupied': '这个账号已经绑定了另一部手机。请先在电脑端解除旧手机绑定，再重试。',
    'pair-invalid': '配对码已过期或无效。请在电脑端重新打开配对窗口。',
    'pair-pending': '该配对码已有待确认申请，请在电脑端处理或重新生成配对码。',
    'pc-offline': '电脑当前未连接。请启动 Batona PC 客户端并确认网关状态。',
    unauthorized: '手机授权已失效。请在电脑端解除旧手机绑定后重新配对。',
    'not-implemented': '当前电脑客户端尚未提供此功能。',
    'capability-missing': '当前电脑端没有开放此项能力。',
    'method-not-found': '网关版本尚未支持此操作，请先更新网关。',
  };
  if (typeof code === 'string') return values[code] || (code.startsWith('invalid') ? '输入信息无效，请检查后重试。' : `操作未完成（${code}）。`);
  if (status === 409) return '当前状态暂不允许此操作，请确认电脑端连接与配对状态。';
  return status === 401 ? '授权已失效，请重新配对。' : '连接暂时不可用，请检查网络后重试。';
}

function appName(id) {
  return ({ dsh: 'DSH', codex: 'Codex', mock: '模拟后端' })[id] ?? id;
}
function capabilities(backend) {
  return state.hello?.adapters?.find(adapter => adapter.id === backend)?.capabilities ?? {};
}
function backendReady(backend) {
  return backendIdAllowed(backend, E2E_MODE) && Boolean(state.hello?.adapters?.some(adapter => adapter.id === backend));
}

async function start() {
  registerServiceWorker();
  window.addEventListener('online', () => {
    if (state.credentials?.token) void boot();
    else { setConnection('online', '网络已连接'); render(); }
  });
  window.addEventListener('offline', () => {
    state.online = false;
    state.client?.close();
    setConnection('offline', '离线');
    render();
  });
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'refresh-authoritative-state' && state.credentials?.token) {
      void Promise.all([refreshBackend(true), refreshPendingInteractions()]);
    }
  });
  try { state.credentials = await credentialStore.read() ?? null; }
  catch { state.credentials = null; state.notice = '此浏览器无法保存手机授权信息。请检查网站数据权限后重新打开。'; state.noticeKind = 'error'; }
  if (state.ios && !state.standalone) {
    state.view = 'install';
    setConnection(navigator.onLine ? 'online' : 'offline', navigator.onLine ? '等待安装' : '离线');
    render();
    return;
  }
  if (state.credentials?.token) await boot();
  else {
    state.view = 'pair';
    setConnection(navigator.onLine ? 'online' : 'offline', navigator.onLine ? '尚未配对' : '离线');
    render();
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const appBase = new URL(BASE, document.baseURI);
  navigator.serviceWorker.register(new URL('sw.js', appBase), { scope: appBase.pathname }).catch(() => {
    state.notice = '离线应用外壳暂未缓存；联网功能仍可继续使用。';
  });
}

async function boot() {
  if (!navigator.onLine) {
    state.online = false;
    setConnection('offline', '离线');
    state.view = 'offline';
    render();
    return;
  }
  state.view = 'connecting';
  state.online = false;
  setConnection('connecting', '正在连接');
  render();
  try {
    const status = await api('status');
    state.pcOnline = status.pcOnline === true;
    if (!state.pcOnline) {
      state.view = 'offline';
      setConnection('offline', '电脑未连接');
      render();
      return;
    }
    state.client?.close();
    state.client = new GatewayClient(onGatewayFrame, online => {
      state.online = online;
      setConnection(online ? 'online' : 'offline', online ? '电脑已连接' : '连接中断');
      if (online) {
        state.view = state.current ? 'session' : 'home';
        void refreshBackend(true);
        void refreshPushState();
      } else if (!state.client?.closed) {
        state.view = 'offline';
      }
      render();
    });
    state.hello = await state.client.connect(state.credentials.token);
    state.backends = visibleBackendIds(state.hello?.adapters, E2E_MODE);
    if (state.backends.includes(state.hello?.defaultBackend)) state.backend = state.hello.defaultBackend;
    else if (!backendIdAllowed(state.backend, E2E_MODE)) state.backend = 'dsh';
    state.view = 'home';
    state.online = true;
    setConnection('online', '电脑已连接');
    await Promise.all([refreshBackend(true), refreshPushState(), refreshPendingInteractions()]);
  } catch (error) {
    if (error.status === 401) return;
    state.view = 'offline';
    state.online = false;
    setConnection('offline', '连接不可用');
    state.notice = error.message;
    state.noticeKind = 'error';
  }
  render();
}

async function authorizationExpired() {
  state.client?.close();
  state.online = false;
  state.credentials = await credentialStore.read().catch(() => null);
  if (state.credentials?.deviceSecret) {
    await credentialStore.clearAuthorization().catch(() => {});
    state.credentials = { deviceSecret: state.credentials.deviceSecret };
  }
  state.pendingInteractions = [];
  state.view = state.ios && !state.standalone ? 'install' : 'pair';
  state.notice = '手机授权已撤销。请确认旧绑定状态，再用配对码重新申请。';
  state.noticeKind = 'error';
  setConnection('offline', '需要重新配对');
  render();
}

function beginPairPoll(requestId, proof) {
  clearInterval(state.pairPoll);
  state.pairing = true;
  state.notice = '申请已发送。请在电脑端检查手机名称并批准本次配对。';
  state.noticeKind = 'info';
  state.pairPoll = setInterval(async () => {
    try {
      const result = await api('pair-result', { requestId, proof }, '');
      if (result.pending) return;
      clearInterval(state.pairPoll);
      state.pairPoll = null;
      const existing = state.credentials ?? {};
      state.credentials = { ...existing, token: result.token, deviceId: result.deviceId, accountId: result.accountId };
      await credentialStore.write(state.credentials);
      state.pairing = false;
      state.notice = '';
      setConnection('connecting', '正在连接电脑');
      await boot();
    } catch (error) {
      clearInterval(state.pairPoll);
      state.pairPoll = null;
      state.pairing = false;
      state.notice = error.message;
      state.noticeKind = 'error';
      render();
    }
  }, 1400);
  render();
}

async function requestPair() {
  if (state.pairing || !navigator.onLine) return;
  const code = normalizeCode(state.code);
  if (code.length < 6) { setNotice('请输入电脑端显示的完整配对码。', 'error'); return; }
  try {
    const credentials = state.credentials ?? {};
    const deviceSecret = credentials.deviceSecret || randomSecret();
    state.credentials = { ...credentials, deviceSecret };
    await credentialStore.write(state.credentials);
    state.notice = '';
    render();
    const request = await api('pair-request', { code, deviceSecret, name: 'iPhone · DSH Link' }, '');
    beginPairPoll(request.requestId, request.proof);
  } catch (error) {
    state.notice = error.message;
    state.noticeKind = 'error';
    render();
  }
}

function normalizeCode(raw) {
  let code = String(raw ?? '').trim();
  try {
    if (/^batona-pair:/i.test(code)) code = new URL(code).hostname || new URL(code).pathname.replace(/^\//, '');
  } catch { /* keep manually entered code */ }
  return code.toUpperCase().replace(/[\s-]/g, '').replace(/[^A-Z0-9]/g, '');
}

async function refreshBackend(reloadHistory = false) {
  if (!state.client || !state.online) return;
  if (!backendReady(state.backend)) {
    state.sessions = [];
    state.tree = [];
    render();
    return;
  }
  try {
    const [sessionResult, treeResult] = await Promise.all([
      state.client.request('session.list', { backend: state.backend }),
      state.client.request('workspace.tree', { backend: state.backend }).catch(() => ({ items: [] })),
    ]);
    state.allSessions = sessionResult.sessions ?? [];
    state.sessions = state.allSessions.filter(item => item.backend === state.backend);
    state.tree = treeResult.items ?? [];
    if (reloadHistory && state.current && state.current.backend === state.backend) await loadHistory(state.current.id);
  } catch (error) {
    if (!state.online) return;
    state.notice = error.message;
    state.noticeKind = 'error';
  }
  render();
}

async function refreshPendingInteractions() {
  if (!state.client || !state.online) return;
  try {
    const result = await state.client.request('interaction.pendingList', {});
    const frames = Array.isArray(result.interactions) ? result.interactions.filter(frame =>
      frame?.type === 'server-request' &&
      (frame.method === 'approval/requested' || frame.method === 'question/requested') &&
      typeof frame.rpcId === 'string'
    ) : [];
    const liveRpcIds = new Set(frames.map(frame => frame.rpcId));
    state.pendingInteractions = state.pendingInteractions.filter(item => liveRpcIds.has(item.rpcId));
    for (const frame of frames) onGatewayFrame(frame);
    render();
  } catch { /* a reconciliation failure must not hide requests already received */ }
}

async function switchBackend(backend) {
  state.backend = backend;
  state.current = null;
  state.events = [];
  state.draft = '';
  state.view = 'home';
  state.notice = '';
  state.sessions = [];
  state.tree = [];
  state.modelChoices = [];
  state.profiles = [];
  state.settings = null;
  state.permissionPresets = null;
  if (state.online && backendReady(state.backend)) await refreshBackend(false);
  else render();
}

async function loadHistory(sessionId) {
  if (!state.client || !state.online) return;
  try {
    const result = await state.client.request('session.history', { sessionId, limit: 200 });
    state.events = normalizeEvents(result.events ?? []);
  } catch (error) {
    state.events = [];
    state.notice = error.message;
    state.noticeKind = 'error';
  }
}

function normalizeEvents(events) {
  const output = [];
  for (const event of events) appendEvent(output, event);
  return output;
}

function appendEvent(list, event) {
  if (!event || typeof event !== 'object') return;
  switch (event.type) {
    case 'user/message': list.push({ kind: 'user', text: event.text ?? '' }); break;
    case 'assistant/message': {
      const last = list.at(-1);
      if (last?.kind === 'assistant' && (last.text === event.text || String(event.text ?? '').startsWith(last.text))) last.text = event.text ?? last.text;
      else list.push({ kind: 'assistant', text: event.text ?? '' });
      break;
    }
    case 'assistant/chunk': {
      const last = list.at(-1);
      if (last?.kind === 'assistant') last.text += event.text ?? '';
      else list.push({ kind: 'assistant', text: event.text ?? '' });
      break;
    }
    case 'tool/call': list.push({ kind: 'tool', text: `工具调用 · ${event.toolName ?? '未知工具'}` }); break;
    case 'tool/result': list.push({ kind: 'tool', text: `${event.toolName ?? '工具'} · ${event.ok ? '已完成' : '未完成'}${event.summary ? ` · ${event.summary}` : ''}` }); break;
    case 'error': list.push({ kind: 'assistant', text: event.message ?? '任务执行失败。' }); break;
    default: break;
  }
}

function onGatewayFrame(frame) {
  if (frame.type === 'client-notice' && frame.method === 'authorization-revoked') {
    void authorizationExpired();
    return;
  }
  if (frame.type === 'client-notice' && frame.method === 'reconnected') {
    void Promise.all([refreshBackend(true), refreshPendingInteractions()]);
    return;
  }
  const payload = frame.payload ?? {};
  if (frame.method === 'approval/requested') {
    const interaction = { kind: 'approval', rpcId: frame.rpcId, sessionId: payload.sessionId, toolName: payload.toolName ?? '', reason: payload.reason ?? '' };
    state.pendingInteractions = [...state.pendingInteractions.filter(item => item.rpcId !== interaction.rpcId), interaction];
    if (state.current?.id === payload.sessionId) state.current.state = 'waiting-approval';
    render();
    return;
  }
  if (frame.method === 'question/requested') {
    const interaction = { kind: 'question', rpcId: frame.rpcId, sessionId: payload.sessionId, questions: payload.questions ?? [] };
    state.pendingInteractions = [...state.pendingInteractions.filter(item => item.rpcId !== interaction.rpcId), interaction];
    if (state.current?.id === payload.sessionId) state.current.state = 'waiting-question';
    render();
    return;
  }
  if (frame.method === 'interaction/resolved') {
    const resolved = new Set(payload.requestRpcIds ?? []);
    state.pendingInteractions = state.pendingInteractions.filter(item => !resolved.has(item.rpcId));
    render();
    return;
  }
  if (frame.method !== 'session/event') return;
  const event = payload.event ?? {};
  const session = state.sessions.find(item => item.id === payload.sessionId);
  if (event.type === 'session/title' && session) session.title = event.title;
  if (session) {
    if (event.type === 'turn/start') session.state = 'running';
    if (event.type === 'turn/end' || event.type === 'done') session.state = 'done';
    if (event.type === 'error') session.state = 'error';
  }
  if (state.current?.id === payload.sessionId) appendEvent(state.events, event);
  if (state.view !== 'offline') render();
}

async function openSession(session) {
  if (!state.online || state.requestBusy) return;
  state.requestBusy = true;
  try {
    const opened = await state.client.request('session.resume', { backend: session.backend ?? state.backend, backendSessionId: session.backendSessionId });
    state.current = { ...session, ...opened };
    state.current.backend = session.backend ?? state.backend;
    state.view = 'session';
    state.draft = '';
    await loadHistory(state.current.id);
    await loadSessionSettings();
  } catch (error) { showToast(error.message); }
  finally { state.requestBusy = false; render(); }
}

async function createSession(workspaceId = '', workspacePath = '') {
  if (!state.client || !state.online || !backendReady(state.backend)) return;
  try {
    const session = await state.client.request('session.create', {
      backend: state.backend,
      title: '新会话',
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspacePath ? { workspacePath } : {}),
    });
    state.current = session;
    state.current.backend = state.backend;
    state.view = 'session';
    state.events = [];
    await loadSessionSettings();
    await refreshBackend(false);
    state.view = 'session';
    render();
  } catch (error) { showToast(error.message); }
}

async function loadSessionSettings() {
  if (!state.current || !state.client || !state.online) return;
  const backend = state.current.backend;
  state.settings = null;
  state.modelChoices = [];
  state.profiles = [];
  state.permissionPresets = null;
  const jobs = [
    state.client.request('model.list', { backend }).then(result => { state.modelChoices = result.items ?? []; }).catch(() => {}),
    state.client.request('agent.profile.list', { backend }).then(result => { state.profiles = (result.items ?? []).filter(profile => profile.available); }).catch(() => {}),
  ];
  if (backend === 'dsh') jobs.push(state.client.request('session.permissionPresetList', { sessionId: state.current.id }).then(result => { state.permissionPresets = result; }).catch(() => {}));
  if (backend === 'codex') jobs.push(state.client.request('session.permissionMenu', { sessionId: state.current.id, open: false }).then(result => { state.settings = result; }).catch(() => {}));
  await Promise.all(jobs);
}

async function selectModel(index) {
  const model = state.modelChoices[Number(index)];
  if (!model || !state.current || !state.online) return;
  try {
    await state.client.request('model.select', { sessionId: state.current.id, model });
    state.current.model = model;
    showToast('模型设置已同步到电脑');
  } catch (error) { showToast(error.message); }
  render();
}

async function selectPermission(profileId) {
  if (!state.current || !profileId) return;
  const profile = state.profiles.find(item => item.id === profileId);
  if (profileId.includes('full-access') && !await confirmDialog('切换为完全访问？', '接下来的任务可能在工作区外访问或修改文件。此设置会同步到电脑端。', '确认完全访问')) {
    render();
    return;
  }
  try {
    await state.client.request('session.permissionSelect', { sessionId: state.current.id, profileId });
    state.settings = { ...(state.settings ?? {}), profileId };
    showToast(`${profile?.label ?? '权限档'}已同步`);
  } catch (error) { showToast(error.message); }
  render();
}

async function selectDshPreset(presetId) {
  if (!state.current || !presetId) return;
  if (presetId === 'danger-full-access' && !await confirmDialog('切换为完全访问？', '后续 DSH 回合将拥有完整访问权限。请确认你了解电脑端的安全影响。', '确认完全访问')) { render(); return; }
  try {
    state.permissionPresets = await state.client.request('session.permissionPresetSelect', {
      sessionId: state.current.id, presetId, confirmed: presetId === 'danger-full-access',
    });
    showToast('DSH 权限设置已同步到电脑');
  } catch (error) { showToast(error.message); }
  render();
}

async function sendDraft() {
  if (!state.current || !state.online || state.requestBusy || !state.draft.trim()) return;
  const text = state.draft;
  state.requestBusy = true;
  try {
    await state.client.request('session.prompt', { sessionId: state.current.id, parts: [{ type: 'text', text }], queueAction: 'queue' });
    state.draft = '';
    render();
    document.querySelector('#message-input')?.focus();
  } catch (error) { showToast(`${error.message}。草稿已保留。`); }
  finally { state.requestBusy = false; render(); }
}

async function respond(payload, rpcId) {
  const pending = state.pendingInteractions.find(item => item.rpcId === rpcId);
  if (!pending || !state.online || state.requestBusy) return;
  state.requestBusy = true;
  try {
    await state.client.request('respond', { sessionId: pending.sessionId, serverRequestRpcId: pending.rpcId, payload });
    state.pendingInteractions = state.pendingInteractions.filter(item => item.rpcId !== pending.rpcId);
    render();
  } catch (error) { showToast(error.message); }
  finally { state.requestBusy = false; render(); }
}

async function openPendingSession(rpcId) {
  const pending = state.pendingInteractions.find(item => item.rpcId === rpcId);
  if (!pending || !state.client || !state.online) return;
  let session = state.allSessions.find(item => item.id === pending.sessionId);
  if (!session) {
    try {
      const result = await state.client.request('session.list', {});
      state.allSessions = result.sessions ?? [];
      state.sessions = state.allSessions.filter(item => item.backend === state.backend);
      session = state.allSessions.find(item => item.id === pending.sessionId);
    } catch (error) { showToast(error.message); return; }
  }
  if (!session) { showToast('暂时无法定位这个待处理会话；请重新连接后再试。'); return; }
  if (session.backend !== state.backend) await switchBackend(session.backend);
  await openSession(session);
}

async function enableNotifications() {
  if (!state.credentials?.token || !state.online) return;
  if (state.ios && !state.standalone) { showToast('请先从主屏幕打开 DSH Link，再开启通知。'); return; }
  if (!('Notification' in window) || !('serviceWorker' in navigator)) { showToast('此浏览器不支持系统通知。'); return; }
  try {
    const keys = await api('push-key');
    if (!keys.configured || !keys.publicKey) { showToast('服务器暂未配置 Web Push；你仍可在应用内查看任务状态。'); return; }
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') {
      state.push.denied = permission === 'denied';
      state.push.subscribed = false;
      state.notice = permission === 'denied' ? '通知权限已关闭。可在 iPhone“设置 → 通知”中检查 DSH Link；会话功能仍可正常使用。' : '尚未允许通知。你可以稍后从这里再次尝试。';
      state.noticeKind = 'info';
      render();
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(keys.publicKey),
    });
    await api('push-subscribe', { subscription: subscription.toJSON() });
    state.push = { ...state.push, configured: true, subscribed: true, denied: false };
    state.notice = '通知已开启。提醒只包含事件类型，不包含会话正文。';
    state.noticeKind = 'success';
  } catch (error) {
    state.notice = error.message;
    state.noticeKind = 'error';
  }
  render();
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function refreshPushState() {
  if (!state.credentials?.token || !state.online) return;
  try {
    const push = await api('push-key');
    state.push.configured = push.configured === true;
    const registration = await navigator.serviceWorker?.ready;
    const local = registration ? await registration.pushManager.getSubscription() : null;
    state.push.subscribed = push.subscribed === true && Boolean(local);
    state.push.denied = 'Notification' in window && Notification.permission === 'denied';
  } catch { /* a push feature error must not interrupt session use */ }
  if (state.view === 'home' || state.view === 'session') render();
}

async function signOut() {
  if (!state.credentials?.token || state.requestBusy) return;
  if (!await confirmDialog('退出这部手机？', '网关会撤销手机授权并清除推送订阅；电脑端仍保留手机绑定，之后可用同一部手机重新配对。', '退出登录')) return;
  state.requestBusy = true;
  try {
    await api('push-unsubscribe');
    try {
      const registration = await navigator.serviceWorker?.ready;
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (subscription) await subscription.unsubscribe();
    } catch { /* server-side subscription is already removed */ }
    await api('logout');
    state.client?.close();
    await credentialStore.clearAuthorization();
    const current = state.credentials;
    state.credentials = current?.deviceSecret ? { deviceSecret: current.deviceSecret } : null;
    state.online = false;
    state.pcOnline = false;
    state.current = null;
    state.sessions = [];
    state.tree = [];
    state.events = [];
    state.pendingInteractions = [];
    state.push = { configured: false, subscribed: false, denied: false };
    state.view = state.ios && !state.standalone ? 'install' : 'pair';
    state.notice = '本机授权已撤销。手机身份已保留，可以使用同一部手机重新配对。';
    state.noticeKind = 'success';
    setConnection('online', '已退出');
  } catch (error) {
    state.notice = `${error.message}。尚未清除本机授权，请保持联网后重试。`;
    state.noticeKind = 'error';
  } finally { state.requestBusy = false; render(); }
}

async function openDirectory(path) {
  if (!state.online) return;
  state.dir.loading = true;
  state.dir.path = path;
  render();
  try {
    const result = await state.client.request('fs.listDir', { path });
    state.dir.path = result.path ?? path;
    state.dir.roots = result.roots ?? [];
    state.dir.dirs = result.dirs ?? [];
  } catch (error) { showToast(error.message); }
  state.dir.loading = false;
  render();
}

async function createWorkspace(path) {
  const value = path.trim();
  if (!value || !state.online) return;
  try {
    await state.client.request('workspace.create', { backend: state.backend, path: value });
    state.dir.open = false;
    await refreshBackend(false);
    showToast('工作区已登记。电脑上的目录文件没有被复制或修改。');
  } catch (error) { showToast(error.message); }
}

function confirmDialog(title, body, confirmText = '确认') {
  return new Promise(resolve => {
    state.modal = { kind: 'confirm', title, body, confirmText, resolve };
    render();
  });
}

function render() {
  if (state.ios && !state.standalone && state.view !== 'install') state.view = 'install';
  if (state.view === 'install') app.innerHTML = renderInstall();
  else if (state.view === 'pair') app.innerHTML = renderPair();
  else if (state.view === 'connecting') app.innerHTML = renderConnecting();
  else if (state.view === 'offline' || !navigator.onLine) app.innerHTML = renderOffline();
  else if (state.view === 'session' && state.current) app.innerHTML = renderSession();
  else app.innerHTML = renderHome();
  renderModal();
}

function renderInstall() {
  return `<section class="screen-head"><p class="eyebrow">INSTALL ON IPHONE</p><h1>先把工作台<br><em>放到主屏幕。</em></h1><p class="lede">iPhone 上的主屏幕应用与 Safari 标签页使用不同的网站数据空间。请先安装，再申请手机配对，这样授权会保存在实际使用的应用中。</p></section>
    <div class="pair-layout">
      <article class="paper-card pair-card">
        <p class="micro">SAFARI · ADD TO HOME SCREEN</p>
        <ol class="install-steps"><li>在 iPhone 的 Safari 中打开本页。</li><li>点 Safari 工具栏中的“分享”按钮。</li><li>选择“添加到主屏幕”，确认添加 DSH Link。</li><li>从主屏幕图标打开应用，然后扫描或输入电脑配对码。</li></ol>
        <p class="notice">请勿先在 Safari 标签页中配对。首次完整体验要求 iOS 16.4 或更新版本；系统通知仅在已安装的主屏幕 PWA 中提供。</p>
        ${state.notice ? alertHtml() : ''}
        <button class="button secondary wide" type="button" data-action="check-installed">我已添加，重新检查</button>
      </article>
      <aside class="install-aside"><p class="micro">NO APP STORE REQUIRED</p><h2>像应用一样打开</h2><p>DSH Link 是安装在主屏幕上的网页应用。界面与版本化资源会缓存到手机；离线时只显示应用外壳，不保存会话内容，也不会排队发送请求。</p></aside>
    </div>`;
}

function renderPair() {
  return `<section class="screen-head"><p class="eyebrow">DEVICE PAIRING</p><h1>把这部手机<br><em>接入电脑。</em></h1><p class="lede">在电脑上的 Batona PC 客户端打开“手机配对”，扫描屏幕二维码，或输入配对码。配对仍需电脑端明确批准。</p></section>
    <div class="pair-layout">
      <section class="paper-card pair-card" aria-labelledby="pair-title">
        <div class="pair-mark"><strong>01 / REQUEST ACCESS</strong><span>授权由电脑确认</span></div>
        <h2 id="pair-title" class="micro">输入电脑端配对码</h2>
        <form id="pair-form">
          <label class="code-label" for="pair-code">配对码</label>
          <input class="text-field code" id="pair-code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="24" placeholder="例如 · 8X4M2R9K" value="${esc(state.code)}" ${state.pairing || !navigator.onLine ? 'disabled' : ''} />
          <p class="field-note">配对码只用于申请。电脑端批准前，这部手机不会获得访问权。</p>
          <div class="button-row">
            <button class="button primary" type="submit" ${state.pairing || !navigator.onLine ? 'disabled' : ''}>${state.pairing ? '等待电脑批准…' : '申请配对'} <span aria-hidden="true">↗</span></button>
            <button class="button secondary" type="button" data-action="scan-qr" ${state.pairing || !navigator.onLine ? 'disabled' : ''}>扫描二维码</button>
          </div>
        </form>
        ${alertHtml()}
        <div id="camera-mount"></div>
      </section>
      <aside class="install-aside"><p class="micro">ONE PHONE PER ACCOUNT</p><h2>更换手机前先解绑</h2><p>同一账号一次只绑定一部手机。切换 iPhone 与 Android 时，请先在电脑端解除旧手机绑定，不会自动顶替当前设备。</p><p class="aside-spaced">系统最低版本：iOS 16.4。早期 iOS 仅保证普通网页尽力可用，不承诺主屏幕通知。</p></aside>
    </div>`;
}

function renderConnecting() {
  return `<section class="offline-shell"><div class="paper-card"><div class="waiting-orbit"><div class="orbit-ring">↗</div></div><p class="eyebrow spaced">RECONNECTING</p><h1>正在接回电脑。</h1><p>手机授权已保存在本机。网关会重新连接电脑并从当前会话读取最新状态。</p>${alertHtml()}</div></section>`;
}

function renderOffline() {
  const localAuth = Boolean(state.credentials?.token || state.credentials?.deviceSecret);
  return `<section class="offline-shell"><div class="paper-card">
    <div class="offline-mark" aria-hidden="true">⌁</div><p class="eyebrow spaced-small">OFFLINE APP SHELL</p>
    <h1>${navigator.onLine ? '电脑暂时不可达。' : '现在处于离线状态。'}</h1>
    <p>DSH Link 只缓存应用界面。工作区、会话和历史内容需要联网读取；离线时不会展示旧内容或排队提交操作。</p>
    ${localAuth ? '<p class="notice">手机授权仍保存在此主屏幕应用中。网络恢复后会重新连接；如果浏览器网站数据被清除，请在电脑端解除旧手机绑定后重新配对。</p>' : '<p class="notice">联网后使用电脑端配对码申请手机授权。</p>'}
    <button class="button secondary" type="button" data-action="retry-connect" ${!navigator.onLine ? 'disabled' : ''}>重新连接</button>
  </div></section>`;
}

function renderHome() {
  const supported = backendReady(state.backend);
  const tabs = state.backends.map(id => `<button type="button" class="backend-tab" data-action="backend" data-backend="${esc(id)}" aria-selected="${state.backend === id}" ${!backendReady(id) ? 'title="电脑当前未开放此后端"' : ''}>${esc(appName(id))}</button>`).join('')
    + ['dsh', 'codex'].filter(id => !state.backends.includes(id)).map(id => `<button type="button" class="backend-tab unsupported" data-action="backend" data-backend="${id}" aria-selected="${state.backend === id}">${appName(id)}</button>`).join('');
  return `<section class="workspace-intro">
      <div><p class="eyebrow">YOUR DESKTOP · ${esc(appName(state.backend).toUpperCase())}</p><h1 class="display-title">工作还在继续。</h1><p class="lede">从电脑上的工作区与会话中找到上下文，接着阅读、发送请求，或回应需要你的决定。</p></div>
      <button class="button primary" type="button" data-action="new-session" ${!supported || !state.online ? 'disabled' : ''}>＋ 新建会话</button>
    </section>
    <nav class="backend-switch" aria-label="选择后端" role="tablist">${tabs}</nav>
    ${state.push.configured ? `<section class="notification-strip"><p>${state.push.subscribed ? '系统通知已开启 · 仅提醒审批、提问、完成或失败，不包含会话正文。' : state.push.denied ? '通知权限已关闭 · 会话列表仍可在应用内查看。' : '为审批、问题与任务结果开启系统提醒。消息正文不会出现在通知中。'}</p><button class="button secondary small" data-action="notifications" type="button" ${state.push.subscribed || !state.online || state.iosVersion !== null && state.iosVersion < 16.4 ? 'disabled' : ''}>${state.push.subscribed ? '已开启' : '开启通知'}</button></section>` : ''}
    ${renderPendingQueue()}
    ${alertHtml()}
    ${!supported ? `<div class="empty-state"><strong>${esc(appName(state.backend))} 当前不可用</strong>电脑客户端尚未向网关开放此后端。请检查 PC 端集成状态；不会用另一个后端的会话代替显示。</div>` : renderWorkspaces()}
    <div class="section-bar"><h2>最近会话</h2><span class="micro">${state.sessions.length} SESSIONS</span></div>
    ${supported ? renderLooseSessions() : ''}
    <details class="paper-card settings-panel"><summary class="text-action">手机与通知设置</summary><div class="settings-grid"><p class="field-note">绑定手机：${esc(state.credentials?.deviceId ? state.credentials.deviceId.slice(0, 8) : '当前设备')} · 授权与配对身份保存在本机浏览器数据中。</p><button class="button secondary" type="button" data-action="sign-out">退出此手机</button></div></details>`;
}

function renderWorkspaces() {
  if (!state.tree.length) return `<div class="section-bar"><h2>工作区</h2><button class="text-action" type="button" data-action="new-workspace" ${!capabilities(state.backend).workspace ? 'disabled' : ''}>＋ 添加工作区</button></div><div class="empty-state"><strong>还没有工作区</strong>可以从电脑浏览目录并登记工作区，也可以直接创建一个不归属工作区的新会话。</div>`;
  const cards = state.tree.map(item => {
    const workspace = item.workspace ?? {};
    const sessions = newestSessionsFirst((item.sessions ?? []).map(node => {
      const session = state.sessions.find(entry => entry.id === node.sessionId || entry.backendSessionId === node.sessionId);
      return session ? { ...node, sessionId: session.id, backend: session.backend, title: session.title || node.title } : node;
    }).filter(node => node.sessionId));
    const visible = state.showOlder.has(workspace.workspaceId) ? sessions : sessions.slice(0, 5);
    return `<details class="paper-card workspace-card" open><summary class="workspace-title"><span class="folder-symbol" aria-hidden="true">⌂</span><span class="workspace-title-main"><b>${esc(workspace.title || basename(workspace.path))}</b><small>${esc(workspace.path)}</small></span><span class="chevron" aria-hidden="true">›</span></summary><div class="workspace-session-list">${visible.length ? visible.map(sessionRow).join('') : `<div class="empty-state">此工作区还没有可显示的会话。</div>`}${sessions.length > 5 && !state.showOlder.has(workspace.workspaceId) ? `<button class="text-action" type="button" data-action="older" data-workspace="${esc(workspace.workspaceId)}">查看更早的 ${sessions.length - 5} 个会话</button>` : ''}<div class="button-row"><button class="button secondary small" type="button" data-action="create-in-workspace" data-workspace="${esc(workspace.workspaceId)}" data-path="${esc(workspace.path)}">＋ 在这里新建会话</button><button class="button ghost small" type="button" data-action="remove-workspace" data-workspace="${esc(workspace.workspaceId)}">移除工作区</button></div></div></details>`;
  }).join('');
  return `<div class="section-bar"><h2>工作区</h2><button class="text-action" type="button" data-action="new-workspace" ${!capabilities(state.backend).workspace ? 'disabled' : ''}>＋ 添加工作区</button></div><div class="workspace-list">${cards}</div>`;
}

function sessionRow(session) {
  const id = session.sessionId ?? session.id;
  const stateName = session.state ?? 'idle';
  return `<button type="button" class="session-row" data-action="open-session" data-session="${esc(id)}" data-backend="${esc(session.backend ?? state.backend)}"><span class="state-dot" data-state="${esc(stateName)}"></span><span class="session-row-main"><b>${esc(session.title || '未命名会话')}</b><small>${esc(stateLabel(stateName))}</small></span><span aria-hidden="true">↗</span></button>`;
}

function renderLooseSessions() {
  const grouped = new Set(state.tree.flatMap(item => (item.sessions ?? []).map(s => s.sessionId)));
  const loose = state.sessions.filter(session => !grouped.has(session.id) && !grouped.has(session.backendSessionId)).slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (!loose.length) return '<div class="empty-state">会话会显示在所属工作区中；不属于工作区的会话将在这里列出。</div>';
  return `<div class="workspace-list">${loose.map(session => sessionRow({ ...session, sessionId: session.id })).join('')}</div>`;
}

function renderSession() {
  const session = state.current;
  const busy = !state.online || state.requestBusy;
  return `<div class="session-toolbar"><button class="back-button" type="button" data-action="back" aria-label="返回会话列表">←</button><div class="session-toolbar-main"><p class="micro">${esc(appName(session.backend).toUpperCase())} · ${esc(stateLabel(session.state))}</p><h1>${esc(session.title || '新会话')}</h1></div><div class="toolbar-actions"><button class="button ghost small" type="button" data-action="rename">重命名</button><button class="button ghost small" type="button" data-action="archive">归档</button></div></div>
    ${renderPendingQueue(session.id)}
    ${state.pendingInteractions.filter(item => item.sessionId === session.id).map(renderInteraction).join('')}
    ${alertHtml()}
    <details class="paper-card settings-panel"><summary class="text-action">会话设置 · ${esc(session.model?.displayName || session.model?.model || '模型与权限')}</summary>${renderSessionSettings()}</details>
    <section class="event-list" aria-label="会话内容">${state.events.length ? state.events.map(eventCard).join('') : '<div class="empty-state"><strong>还没有消息</strong>发送一条文字请求，任务会在电脑上继续执行。</div>'}</section>
    <form id="composer" class="composer"><label class="field-label" for="message-input">发送文字请求 <span class="micro">· QUEUE</span></label><div class="composer-row"><textarea id="message-input" class="text-area" name="message" rows="2" maxlength="12000" placeholder="补充你的要求…" ${busy ? 'disabled' : ''}>${esc(state.draft)}</textarea><button class="send-button" type="submit" aria-label="发送请求" ${busy || !state.draft.trim() ? 'disabled' : ''}>↑</button></div><div class="button-row composer-actions"><button class="button secondary small" type="button" data-action="cancel-turn" ${busy || session.state !== 'running' ? 'disabled' : ''}>停止当前回合</button><span class="field-note composer-hint">文本发送到电脑；网络错误会保留草稿。</span></div></form>`;
}

function eventCard(item) {
  if (item.kind === 'tool') return `<article class="message-card" data-kind="tool"><p class="tool-text">${esc(item.text)}</p></article>`;
  const label = item.kind === 'user' ? 'YOU · PHONE' : 'AGENT · DESKTOP';
  return `<article class="message-card" data-kind="${esc(item.kind)}"><p class="message-label">${label}</p><p class="message-text">${esc(item.text)}</p></article>`;
}

function renderPendingQueue(excludeSessionId = '') {
  const pending = state.pendingInteractions.filter(item => item.sessionId !== excludeSessionId);
  if (!pending.length) return '';
  const rows = pending.map(item => {
    const session = state.allSessions.find(entry => entry.id === item.sessionId);
    const title = session?.title || (session ? '新会话' : `会话 ${String(item.sessionId).slice(0, 8)}`);
    const kind = item.kind === 'approval' ? '等待审批' : '等待回答';
    return `<div class="pending-route" data-session-id="${esc(item.sessionId)}"><span><b>${esc(title)}</b><small>${session?.backend ? `${esc(appName(session.backend))} · ` : ''}${kind}</small></span><button class="button secondary small" type="button" data-action="open-pending" data-rpc-id="${esc(item.rpcId)}">前往处理</button></div>`;
  }).join('');
  return `<section class="notification-strip pending-routes" aria-label="其他会话的待处理请求"><p>有会话正在等待你的回应</p><div class="pending-route-list">${rows}</div></section>`;
}

function renderInteraction(pending) {
  const rpcId = esc(pending.rpcId);
  if (pending.kind === 'approval') return `<section class="interaction-card" aria-label="工具调用审批"><p class="micro">ACTION NEEDED · APPROVAL</p><h3>电脑上的任务正在等待批准</h3><p>${esc(pending.toolName || '工具操作')}${pending.reason ? ` · ${esc(pending.reason)}` : ''}</p><div class="button-row"><button class="button danger" type="button" data-action="respond-deny" data-rpc-id="${rpcId}" ${state.requestBusy ? 'disabled' : ''}>拒绝</button><button class="button primary" type="button" data-action="respond-allow" data-rpc-id="${rpcId}" ${state.requestBusy ? 'disabled' : ''}>允许一次</button></div></section>`;
  const questions = pending.questions.length ? pending.questions : [{ id: 'answer', kind: 'text', prompt: '电脑端有一个问题需要回答。' }];
  return `<section class="interaction-card" aria-label="回答电脑端提问"><p class="micro">ACTION NEEDED · QUESTION</p><h3>继续前需要你的回答</h3><form class="question-form" data-rpc-id="${rpcId}">${questions.map((question, index) => `<fieldset class="question-fieldset" data-question-id="${esc(question.id)}"><legend class="field-label">${questions.length > 1 ? `${index + 1}. ` : ''}${esc(question.prompt)}</legend>${(question.options ?? []).map(option => `<label class="question-option"><input type="radio" name="question-${rpcId}-${esc(question.id)}" value="${esc(option.id)}"><span><b>${esc(option.label)}</b>${option.description ? `<br><span>${esc(option.description)}</span>` : ''}</span></label>`).join('')}<input class="text-field" type="${question.isSecret ? 'password' : 'text'}" name="custom-${esc(question.id)}" placeholder="${esc(question.placeholder || '输入你的答案…')}" /></fieldset>`).join('')}<div class="button-row"><button class="button secondary" type="button" data-action="respond-skip" data-rpc-id="${rpcId}">跳过</button><button class="button primary" type="submit">提交回答</button></div></form></section>`;
}

function renderSessionSettings() {
  const session = state.current;
  if (!session) return '';
  const modelRows = state.modelChoices.map((model, index) => {
    const current = session.model && model.provider === session.model.provider && model.model === session.model.model && (model.reasoningEffort ?? '') === (session.model.reasoningEffort ?? '');
    const label = `${model.displayName || `${model.provider} · ${model.model}`}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}`;
    return `<option value="${index}" ${current ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  let settings = `<div class="field-group"><label class="field-label" for="model-select">模型与思考强度</label><select id="model-select" class="select-field" ${!state.online || !state.modelChoices.length ? 'disabled' : ''}>${modelRows || '<option>电脑端没有提供模型目录</option>'}</select></div>`;
  if (session.backend === 'codex' && state.profiles.length) {
    settings += `<div class="field-group"><label class="field-label" for="permission-profile">Codex 权限档</label><select id="permission-profile" class="select-field"><option value="">选择电脑端权限档…</option>${state.profiles.map(profile => `<option value="${esc(profile.id)}" ${state.settings?.profileId === profile.id ? 'selected' : ''}>${esc(profile.label)} · ${esc(profile.description)}</option>`).join('')}</select></div>`;
  }
  if (session.backend === 'dsh' && state.permissionPresets?.supported) {
    settings += `<div class="field-group"><label class="field-label" for="dsh-permission">DSH 会话权限</label><select id="dsh-permission" class="select-field"><option value="">当前：${esc(state.permissionPresets.currentValue || '自定义')}</option>${(state.permissionPresets.options ?? []).filter(item => item.available).map(item => `<option value="${esc(item.id)}">${esc(item.label)} · ${esc(item.description)}</option>`).join('')}</select></div>`;
  }
  if (!state.modelChoices.length && !state.profiles.length && !state.permissionPresets?.supported) settings += '<p class="field-note">权限与模型选项由电脑端能力提供。当前会话没有开放可调整设置。</p>';
  return `<div class="settings-grid">${settings}<p class="field-note">设置会经网关同步到电脑端，不会在手机本地启动 Agent。</p></div>`;
}

function basename(path) { return String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) || '未命名目录'; }
function stateLabel(value) { return ({ idle: '空闲', running: '执行中', 'waiting-approval': '等待审批', 'waiting-question': '等待回答', done: '已完成', error: '失败' })[value] ?? '等待连接'; }

app.addEventListener('input', event => {
  if (event.target.id === 'pair-code') state.code = event.target.value;
  if (event.target.id === 'message-input') {
    state.draft = event.target.value;
    const send = document.querySelector('.send-button');
    if (send) send.disabled = !state.online || state.requestBusy || !state.draft.trim();
  }
  if (event.target.id === 'directory-path') state.dir.path = event.target.value;
});

app.addEventListener('submit', event => {
  if (event.target.id === 'pair-form') { event.preventDefault(); void requestPair(); }
  else if (event.target.id === 'composer') { event.preventDefault(); void sendDraft(); }
  else if (event.target.matches('.question-form')) {
    event.preventDefault();
    const answers = [...event.target.querySelectorAll('fieldset')].map(field => {
      const id = field.dataset.questionId || 'answer';
      return { id, selected: [...field.querySelectorAll('input[type="radio"]:checked')].map(input => input.value), ...(field.querySelector('[name^="custom-"]')?.value.trim() ? { custom: field.querySelector('[name^="custom-"]').value.trim() } : {}) };
    });
    void respond({ answers }, event.target.dataset.rpcId);
  } else if (event.target.id === 'workspace-form') {
    event.preventDefault();
    const path = new FormData(event.target).get('workspace-path');
    void createWorkspace(String(path ?? ''));
  } else if (event.target.id === 'rename-form') {
    event.preventDefault();
    const title = new FormData(event.target).get('title');
    void renameSession(String(title ?? ''));
  }
});

app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'check-installed') { state.standalone = isStandalone(); if (!state.standalone) { showToast('请从主屏幕图标打开 DSH Link。'); return; } state.view = state.credentials?.token ? 'connecting' : 'pair'; render(); if (state.credentials?.token) void boot(); return; }
  if (action === 'scan-qr') { void startScanner(); return; }
  if (action === 'backend') { await switchBackend(button.dataset.backend); return; }
  if (action === 'new-session') { await createSession(); return; }
  if (action === 'new-workspace') { state.dir = { open: true, path: '', roots: [], dirs: [], loading: false }; renderModal(); await openDirectory(''); return; }
  if (action === 'create-in-workspace') { await createSession(button.dataset.workspace, button.dataset.path); return; }
  if (action === 'remove-workspace') { if (await confirmDialog('移除这个工作区？', '这只会取消工作区登记，电脑上的目录与文件不会删除。', '移除工作区')) { try { await state.client.request('workspace.delete', { workspaceId: button.dataset.workspace, backend: state.backend }); await refreshBackend(false); } catch (error) { showToast(error.message); } } return; }
  if (action === 'older') { state.showOlder.add(button.dataset.workspace); render(); return; }
  if (action === 'open-session') {
    const session = state.sessions.find(item => item.id === button.dataset.session || item.backendSessionId === button.dataset.session);
    if (session) await openSession(session);
    else await openSession({ backend: button.dataset.backend, backendSessionId: button.dataset.session, title: '继续会话' });
    return;
  }
  if (action === 'open-pending') { await openPendingSession(button.dataset.rpcId); return; }
  if (action === 'back') { state.current = null; state.events = []; state.view = 'home'; await refreshBackend(false); return; }
  if (action === 'notifications') { await enableNotifications(); return; }
  if (action === 'sign-out') { await signOut(); return; }
  if (action === 'cancel-turn') { try { await state.client.request('session.cancel', { sessionId: state.current.id }); showToast('已向电脑发送停止请求'); } catch (error) { showToast(error.message); } return; }
  if (action === 'respond-allow') { await respond({ outcome: 'allowed-once' }, button.dataset.rpcId); return; }
  if (action === 'respond-deny') { await respond({ outcome: 'rejected' }, button.dataset.rpcId); return; }
  if (action === 'respond-skip') { await respond({ skip: true }, button.dataset.rpcId); return; }
  if (action === 'retry-connect') { state.notice = ''; void boot(); return; }
  if (action === 'rename') { state.modal = { kind: 'rename', title: state.current.title || '' }; render(); return; }
  if (action === 'archive') { if (await confirmDialog('归档这个会话？', '归档会将会话从当前列表中隐藏；电脑上的历史数据不会删除。', '归档')) { try { await state.client.request('workspace.archiveSession', { sessionId: state.current.backendSessionId, backend: state.current.backend }); state.current = null; state.events = []; state.view = 'home'; await refreshBackend(false); } catch (error) { showToast(error.message); } } return; }
  if (action === 'modal-cancel' || action === 'dismiss-modal' && event.target === button) { const resolve = state.modal?.resolve; state.modal = null; resolve?.(false); renderModal(); return; }
  if (action === 'modal-confirm') { const resolve = state.modal?.resolve; state.modal = null; resolve?.(true); renderModal(); return; }
  if (action === 'dir-open') { const path = document.querySelector('#directory-path')?.value ?? ''; await openDirectory(path); return; }
  if (action === 'dir-path') { const path = button.dataset.path; document.querySelector('#directory-path').value = path; await openDirectory(path); return; }
  if (action === 'dir-select') { await createWorkspace(document.querySelector('#directory-path')?.value ?? state.dir.path); return; }
  if (action === 'close-directory' || action === 'dismiss-directory' && event.target === button) { state.dir.open = false; renderModal(); return; }
});

document.body.addEventListener('change', event => {
  if (event.target.id === 'model-select') void selectModel(event.target.value);
  if (event.target.id === 'permission-profile') void selectPermission(event.target.value);
  if (event.target.id === 'dsh-permission') void selectDshPreset(event.target.value);
});

async function renameSession(title) {
  if (!title.trim() || !state.current) { state.modal = null; render(); return; }
  try {
    const result = await state.client.request('session.rename', { sessionId: state.current.backendSessionId, title: title.trim(), backend: state.current.backend });
    state.current.title = result.title ?? title.trim();
    state.modal = null;
    await refreshBackend(false);
    state.view = 'session';
  } catch (error) { showToast(error.message); }
  render();
}

function renderModal() {
  let existing = document.querySelector('#modal-mount');
  if (existing) existing.remove();
  if (!state.modal && !state.dir.open) return;
  const mount = document.createElement('div');
  mount.id = 'modal-mount';
  if (state.modal?.kind === 'confirm') {
    mount.innerHTML = `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><p class="eyebrow">CONFIRM ACTION</p><h2 id="modal-title">${esc(state.modal.title)}</h2><p>${esc(state.modal.body)}</p><div class="modal-actions"><button class="button secondary" type="button" data-action="modal-cancel">返回</button><button class="button primary" type="button" data-action="modal-confirm">${esc(state.modal.confirmText)}</button></div></section></div>`;
  } else if (state.modal?.kind === 'rename') {
    mount.innerHTML = `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title"><p class="eyebrow">SESSION TITLE</p><h2 id="rename-title">重命名会话</h2><form id="rename-form"><label class="field-label" for="rename-title-input">会话名称</label><input class="text-field" id="rename-title-input" name="title" maxlength="120" value="${esc(state.modal.title)}"/><div class="modal-actions"><button class="button secondary" type="button" data-action="modal-cancel">取消</button><button class="button primary" type="submit">保存</button></div></form></section></div>`;
  } else if (state.dir.open) {
    mount.innerHTML = `<div class="modal-backdrop" data-action="dismiss-directory"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="directory-title"><p class="eyebrow">PC DIRECTORY · ${esc(appName(state.backend).toUpperCase())}</p><h2 id="directory-title">从电脑选择工作区</h2><p>目录由电脑端安全代理列出；移除工作区只会取消登记，不会删除目录或文件。</p><label class="field-label" for="directory-path">当前路径</label><input class="text-field" id="directory-path" value="${esc(state.dir.path)}" placeholder="输入电脑上的目录路径"/><div class="button-row directory-actions"><button class="button secondary small" type="button" data-action="dir-open">打开路径</button><button class="button primary small" type="button" data-action="dir-select">登记此路径</button></div><div class="directory-list">${state.dir.loading ? '<p class="field-note">正在读取电脑目录…</p>' : `${state.dir.roots.map(path => `<button class="directory-item" type="button" data-action="dir-path" data-path="${esc(path)}">⌂ ${esc(path)} <span>→</span></button>`).join('')}${state.dir.dirs.map(path => `<button class="directory-item" type="button" data-action="dir-path" data-path="${esc(path)}">📁 ${esc(basename(path))} <span>→</span></button>`).join('')}`}</div><div class="modal-actions"><button class="button secondary" type="button" data-action="close-directory">取消</button></div></section></div>`;
  }
  app.append(mount);
}

async function startScanner() {
  const mount = document.querySelector('#camera-mount');
  if (!mount) return;
  if (!navigator.mediaDevices?.getUserMedia) { showToast('无法使用相机。请检查 Safari 权限，或手动输入配对码。'); return; }
  mount.innerHTML = '<div class="camera-box"><video id="pair-camera" playsinline muted></video></div><button class="button secondary small" type="button" data-action="stop-camera">关闭相机</button>';
  const video = mount.querySelector('video');
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = state.cameraStream;
    await video.play();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const scan = () => {
      if (!state.cameraStream || !video.videoWidth) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
      if (result?.data) {
        state.code = normalizeCode(result.data);
        stopScanner();
        render();
        showToast('已识别配对码，请核对后申请');
        return;
      }
      state.cameraFrame = requestAnimationFrame(scan);
    };
    scan();
  } catch {
    stopScanner();
    showToast('相机无法启动。请允许 Safari 使用相机，或手动输入配对码。');
  }
}
function stopScanner() {
  cancelAnimationFrame(state.cameraFrame);
  for (const track of state.cameraStream?.getTracks() ?? []) track.stop();
  state.cameraStream = null;
}

document.body.addEventListener('click', event => {
  const button = event.target.closest('[data-action="stop-camera"]');
  if (button) { stopScanner(); button.remove(); document.querySelector('#camera-mount .camera-box')?.remove(); }
});

void start();
