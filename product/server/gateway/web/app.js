/* DSH Remote — 手机壳（vanilla JS，零依赖） */
'use strict';

const $ = (id) => document.getElementById(id);
const state = { token: localStorage.getItem('token') || '', ws: null, sessions: [], current: '', pending: new Map() };

// ── 工具 ──────────────────────────────────────────────────────────────
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function httpPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
function setConn(on) {
  const el = $('conn-state');
  el.textContent = on ? '已连接' : '未连接';
  el.className = 'pill ' + (on ? 'on' : 'off');
}
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}

// ── WebSocket 前端协议 ───────────────────────────────────────────────
function connect() {
  if (!state.token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.onopen = () => {
    setConn(true);
    wsSend('auth.hello', {}).then(() => { refreshSessions(); }).catch(() => {});
  };
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'server-response') {
      const p = state.pending.get(msg.rpcId);
      if (p) { state.pending.delete(msg.rpcId); p.resolve(msg.result); }
    } else if (msg.type === 'server-request') {
      handlePush(msg);
    }
  };
}

function wsSend(method, payload) {
  return new Promise((resolve, reject) => {
    const rpcId = crypto.randomUUID();
    state.pending.set(rpcId, { resolve, reject });
    state.ws.send(JSON.stringify({ type: 'client-request', rpcId, method, payload }));
    setTimeout(() => {
      if (state.pending.has(rpcId)) { state.pending.delete(rpcId); reject(new Error('timeout')); }
    }, 30000);
  });
}

// ── 推送处理 ──────────────────────────────────────────────────────────
function handlePush(frame) {
  if (frame.method === 'session/event') renderEvent(frame.payload.sessionId, frame.payload.event);
  else if (frame.method === 'approval/requested') showApproval(frame);
  else if (frame.method === 'question/requested') showQuestion(frame);
}

function renderEvent(sessionId, ev) {
  if (sessionId !== state.current && state.current) return; // 只看当前会话
  const chat = $('chat');
  const mk = (cls, html) => { const d = document.createElement('div'); d.className = 'msg-row ' + cls; d.innerHTML = html; chat.appendChild(d); chat.scrollTop = chat.scrollHeight; };

  switch (ev.type) {
    case 'user/message': mk('user', `<div class="who">你</div>${esc(ev.text)}`); break;
    case 'assistant/message': mk('', `<div class="who">助手</div>${esc(ev.text)}`); break;
    case 'assistant/chunk': {
      let last = chat.lastElementChild;
      if (!last || !last.classList.contains('stream')) {
        last = document.createElement('div');
        last.className = 'msg-row stream';
        last.innerHTML = '<div class="who">助手</div>';
        chat.appendChild(last);
      }
      last.insertAdjacentText('beforeend', ev.text);
      chat.scrollTop = chat.scrollHeight;
      break;
    }
    case 'tool/call': mk('tool', `🔧 ${esc(ev.toolName)}<br><code>${esc(JSON.stringify(ev.args ?? {}))}</code>`); break;
    case 'tool/result': {
      const rows = chat.querySelectorAll('.msg-row.tool');
      if (rows.length) rows[rows.length - 1].insertAdjacentText('beforeend', `\n→ ${ev.ok ? 'OK' : 'ERR'} ${esc(ev.summary ?? '')}`);
      break;
    }
    case 'turn/start': break;
    case 'turn/end': break;
    case 'done': mk('done', '— 回合完成 —'); break;
    case 'session/title': {
      const opt = $('session-select').querySelector(`option[value="${CSS.escape(sessionId)}"]`);
      if (opt) opt.textContent = ev.title;
      break;
    }
    default: break;
  }
}

function showApproval(frame) {
  const bar = $('approval-bar');
  bar.classList.remove('hidden');
  bar.innerHTML = `<div class="q">⚠️ 审批：<b>${esc(frame.payload.toolName)}</b><br>${esc(frame.payload.reason ?? '')}</div>
    <div class="btns">
      <button id="ap-allow" class="secondary">允许一次</button>
      <button id="ap-reject" class="danger">拒绝</button>
    </div>`;
  $('ap-allow').onclick = () => answer(frame, { outcome: 'allowed-once' });
  $('ap-reject').onclick = () => answer(frame, { outcome: 'rejected' });
}
function showQuestion(frame) {
  const bar = $('question-bar');
  bar.classList.remove('hidden');
  const q = frame.payload.questions?.[0];
  bar.innerHTML = `<div class="q">❓ ${esc(q?.prompt ?? '问题')}</div>`;
  if (q?.kind === 'select' && q.options) {
    const sel = document.createElement('select');
    sel.id = 'q-answer';
    q.options.forEach((o) => { const op = document.createElement('option'); op.value = o.id; op.textContent = o.label; sel.appendChild(op); });
    bar.appendChild(sel);
    const btn = document.createElement('button');
    btn.textContent = '提交';
    btn.onclick = () => answer(frame, { answer: sel.value });
    bar.appendChild(btn);
  } else {
    const inp = document.createElement('input');
    inp.id = 'q-answer';
    inp.placeholder = '回答…';
    bar.appendChild(inp);
    const btn = document.createElement('button');
    btn.textContent = '提交';
    btn.onclick = () => answer(frame, { answer: inp.value });
    bar.appendChild(btn);
  }
}
function answer(frame, payload) {
  wsSend('respond', { sessionId: frame.payload.sessionId, serverRequestRpcId: frame.rpcId, payload })
    .then(() => { $('approval-bar').classList.add('hidden'); $('question-bar').classList.add('hidden'); })
    .catch((e) => toast('应答失败: ' + e.message));
}

// ── 会话 ──────────────────────────────────────────────────────────────
async function refreshSessions() {
  const r = await wsSend('session.list', {});
  if (r.ok) {
    state.sessions = r.value.sessions;
    const sel = $('session-select');
    sel.innerHTML = '';
    r.value.sessions.forEach((s) => {
      const op = document.createElement('option');
      op.value = s.id;
      op.textContent = `${s.title ?? s.backendSessionId} [${s.state}]`;
      sel.appendChild(op);
    });
    if (r.value.sessions.length && !state.current) { state.current = r.value.sessions[0].id; }
    if (state.current) sel.value = state.current;
  }
}

async function createSession() {
  const backend = (await wsSend('auth.hello', {})).value?.defaultBackend || 'mock';
  const r = await wsSend('session.create', { backend, title: '新会话' });
  if (r.ok) { state.current = r.value.id; $('chat').innerHTML = ''; await refreshSessions(); toast('会话已创建'); }
  else toast('创建失败: ' + r.error.message);
}

async function resumeSession() {
  const id = $('resume-id').value?.trim();
  if (!id) { toast('请在“恢复”输入框填后端会话 id（mock-1 等）'); return; }
  const backend = (await wsSend('auth.hello', {})).value?.defaultBackend || 'mock';
  const r = await wsSend('session.resume', { backend, backendSessionId: id });
  if (r.ok) { state.current = r.value.id; $('chat').innerHTML = ''; await refreshSessions(); toast('已恢复'); }
  else toast('恢复失败: ' + r.error.message);
}

async function send() {
  const text = $('input').value.trim();
  if (!text || !state.current) return;
  $('input').value = '';
  const r = await wsSend('session.prompt', { sessionId: state.current, parts: [{ type: 'text', text }], queueAction: 'queue' });
  if (!r.ok) toast('发送失败: ' + r.error.message);
}

// ── 工作区 / 模型 / 设备 ──────────────────────────────────────────────
async function refreshWorkspaces() {
  const r = await wsSend('workspace.list', {});
  const ul = $('ws-list');
  ul.innerHTML = '';
  if (!r.ok) { ul.innerHTML = `<li class="row">${esc(r.error.message)}</li>`; return; }
  r.value.items.forEach((w) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `<div><div>${esc(w.title)}</div><div class="sub">${esc(w.path)} · ${w.sessionIds.length} 会话</div></div>`;
    ul.appendChild(li);
  });
}
async function refreshModels() {
  const r = await wsSend('model.list', {});
  const ul = $('model-list');
  ul.innerHTML = '';
  if (!r.ok) { ul.innerHTML = `<li class="row">${esc(r.error.message)}</li>`; return; }
  r.value.items.forEach((m) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `<div><div>${esc(m.displayName ?? m.model)}</div><div class="sub">${esc(m.provider)} / ${esc(m.model)}</div></div>`;
    const btn = document.createElement('button');
    btn.textContent = '应用';
    btn.onclick = async () => {
      const rr = await wsSend('model.select', { sessionId: state.current, model: m });
      toast(rr.ok ? '已切换模型' : '失败: ' + rr.error.message);
    };
    li.appendChild(btn);
    ul.appendChild(li);
  });
}
async function refreshDevices() {
  const res = await fetch(`/api/auth/devices?token=${encodeURIComponent(state.token)}`);
  const data = await res.json();
  const ul = $('device-list');
  ul.innerHTML = '';
  (data.items ?? []).forEach((d) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = `<div><div>${esc(d.name)}</div><div class="sub">${d.deviceId} · ${d.revoked ? '已吊销' : '正常'}</div></div>`;
    if (!d.revoked) {
      const btn = document.createElement('button');
      btn.className = 'danger';
      btn.textContent = '吊销';
      btn.onclick = async () => { await httpPost('/api/auth/revoke', { token: state.token, deviceId: d.deviceId }); refreshDevices(); };
      li.appendChild(btn);
    }
    ul.appendChild(li);
  });
}

// ── 事件绑定与启动 ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('login-btn').onclick = async () => {
    const r = await httpPost('/api/auth/login', {
      username: $('login-user').value.trim(),
      password: $('login-pass').value,
      totp: $('login-totp').value.trim() || undefined,
      deviceName: $('login-device').value.trim() || 'phone',
    });
    if (r.ok) {
      state.token = r.token;
      localStorage.setItem('token', r.token);
      $('login-view').classList.add('hidden');
      $('main-view').classList.remove('hidden');
      $('login-msg').textContent = '';
      if (r.otpauthUri) $('login-msg').textContent = 'TOTP 绑定：' + r.otpauthUri + '（请用 Authenticator 录入后重新登录）';
      connect();
      refreshWorkspaces(); refreshModels(); refreshDevices();
    } else {
      $('login-msg').textContent = '登录失败: ' + (r.error || 'unknown');
    }
  };

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('new-session-btn').onclick = createSession;
  $('send-btn').onclick = send;
  $('cancel-btn').onclick = async () => { await wsSend('session.cancel', { sessionId: state.current }); };
  $('ws-create-btn').onclick = async () => {
    const r = await wsSend('workspace.create', { path: $('ws-path').value.trim() });
    toast(r.ok ? (r.value.created ? '工作区已创建' : '已存在，复用') : '失败: ' + r.error.message);
    refreshWorkspaces();
  };
  $('logout-btn').onclick = () => { localStorage.removeItem('token'); location.reload(); };
  $('session-select').onchange = (e) => { state.current = e.target.value; $('chat').innerHTML = ''; };
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  if (state.token) {
    $('login-view').classList.add('hidden');
    $('main-view').classList.remove('hidden');
    connect();
    refreshWorkspaces(); refreshModels(); refreshDevices();
  }
});
