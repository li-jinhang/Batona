'use strict';

const api = window.batona;
const $ = (id) => document.getElementById(id);
const paths = {
  home: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',
  file: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  settings:
    '<path d="m10 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 3 2 3-2v-3l2-2-1-4-3-1-1-3z"/><circle cx="11" cy="11" r="3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  server:
    '<rect x="3" y="3" width="18" height="6" rx="2"/><rect x="3" y="9" width="18" height="6" rx="2"/><rect x="3" y="15" width="18" height="6" rx="2"/><path d="M7 6h.01M7 12h.01M7 18h.01"/>',
  refresh: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  terminal: '<path d="m4 5 7 7-7 7M13 19h7"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
function icon(node, name) {
  node.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
document.querySelectorAll('[data-icon]').forEach((node) => icon(node, node.dataset.icon));
let lastStatus = null,
  pair = null,
  pending = null,
  logs = [],
  polling = false,
  operating = false;
let pollDone = Promise.resolve();
let toastTimer;
const messages = {
  unauthorized: '登录已失效，请重新登录。',
  'upgrade-required': '服务器尚未切换新版，请等待管理员发布。',
  'pc-offline': '隧道未连接，请先启动服务。',
  'phone-slot-occupied': '已有其他手机，请先在设置中解绑。',
  'pair-invalid': '配对已失效，请重新打开配对窗口。',
  'invalid-credentials': '接入密钥无效或已被禁用。',
  'rate-limited': '请求过于频繁，请稍后重试。',
};
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 4000);
}
async function guard(fn, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(messages[e.code] || e.message || '操作失败，请重试');
  } finally {
    if (button) button.disabled = false;
  }
}
async function action(op, body = {}) {
  const r = await api.accessCall(op, body);
  if (!r.ok) {
    if (r.error === 'unauthorized') showBind();
    throw Object.assign(new Error(messages[r.error] || r.error || '操作失败'), { code: r.error });
  }
  return r;
}
function setState(id, label, tone = '') {
  $(id).textContent = label;
  $(id).className = `status ${tone}`;
}
function badge(id, label, tone) {
  $(id).textContent = label;
  $(id).className = `badge ${tone}`;
}
async function refreshStatus() {
  const s = await api.serviceStatus();
  if (!s) return;
  if (!s.bound) {
    showBind();
    return;
  }
  lastStatus = s;
  setState('tunnel-status', s.frpc ? '已连接' : '未连接', s.frpc ? 'good' : 'warn');
  setState('gateway-status', s.gateway ? '已连接' : '未连接', s.gateway ? 'good' : 'warn');
  setState(
    'dsh-process',
    s.dshProcess == null ? '状态未知' : s.dshProcess ? '运行中' : '未运行',
    s.dshProcess ? 'good' : '',
  );
  setState(
    'dsh-auth',
    s.dsh ? '已通过' : s.dshProcess ? '认证失败' : '待启动',
    s.dsh ? 'good' : s.dshProcess ? 'warn' : '',
  );
  const dshReady = s.dsh && s.frpc && s.gateway;
  badge(
    'dsh-badge',
    dshReady ? '远程就绪' : s.dsh ? '等待连接' : s.dshProcess ? '认证异常' : '未启动',
    dshReady ? 'good' : 'neutral',
  );
  $('dsh-hint').textContent = dshReady
    ? '隧道与网关已连接，可从手机访问'
    : s.dsh
      ? '本地认证正常，等待隧道与网关连接。'
      : s.dshProcess
        ? '进程正在运行，但本地认证未通过。请查看详情。'
        : '请启动服务，或检查本机 DSH 安装。';
  setState(
    'codex-process',
    s.codexDesktop == null ? '状态未知' : s.codexDesktop ? '运行中' : '未运行',
    s.codexDesktop ? 'good' : '',
  );
  // Bridge readiness is not proof of provider authentication. Do not promote it to an authenticated state.
  setState('codex-auth', '待验证');
  badge('codex-badge', s.codexBridge ? '能力受限' : '未连接', s.codexBridge ? 'warn' : 'neutral');
  $('codex-hint').textContent = s.codexBridge
    ? '可读取历史；桌面端占用的会话暂不支持手机发送。'
    : '本地桥未连接，请启动服务后重试。';
  $('service-action-label').textContent = s.frpc ? '停止服务' : '启动服务';
  icon($('btn-service').querySelector('[data-icon]'), s.frpc ? 'stop' : 'play');
  $('server-address').textContent = s.serverIp || '—';
  if (pair && !s.frpc) await closePair();
}
function selectPage(page) {
  document
    .querySelectorAll('.page')
    .forEach((node) => node.classList.toggle('hidden', node.id !== `page-${page}`));
  document.querySelectorAll('.nav-item').forEach((node) => {
    const active = node.dataset.page === page;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  if (page === 'logs') void guard(refreshLogs);
  if (page === 'settings') void guard(refreshDevices);
}
document.querySelectorAll('[data-page]').forEach((node) => {
  node.onclick = () => selectPage(node.dataset.page);
});

function renderLogs() {
  const filter = $('log-filter').value.toLowerCase();
  for (const [id, entries] of [
    ['recent-logs', logs.slice(-3)],
    [
      'full-logs',
      logs
        .filter((line) => line.toLowerCase().includes(filter))
        .slice()
        .reverse(),
    ],
  ]) {
    const container = $(id);
    container.replaceChildren();
    if (!entries.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = filter && id === 'full-logs' ? '没有匹配的记录' : '暂无运行记录';
      container.append(p);
    }
    for (const line of entries) {
      const match = line.match(/^\[([^\]]+)\]\s*(.*)$/s);
      const row = document.createElement('div');
      row.className = 'log-row';
      const time = document.createElement('time');
      const date = match ? new Date(match[1]) : null;
      time.textContent =
        date && !Number.isNaN(date.getTime())
          ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
          : '—';
      const dot = document.createElement('span');
      dot.className = /失败|错误|限制|error|fail/i.test(line) ? 'dot warn' : 'dot';
      const message = document.createElement('p');
      message.textContent = match ? match[2] : line;
      message.title = message.textContent;
      row.append(time, dot, message);
      container.append(row);
    }
  }
}
async function refreshLogs() {
  logs = (await api.logTail()).map(String);
  renderLogs();
}
$('log-filter').oninput = renderLogs;
async function refreshDevices() {
  const r = await action('devices'),
    phone = r.items?.[0];
  const seen = phone?.lastSeen ? new Date(phone.lastSeen).toLocaleString() : '暂无记录';
  $('phone-state').textContent = phone
    ? `${phone.name} · ${phone.online ? '在线' : '离线'} · 最近连接 ${seen}`
    : '尚未绑定手机';
  $('btn-phone-rename').disabled = !phone;
  $('btn-phone-unbind').disabled = !phone;
}
function clearPairUi() {
  pair = null;
  pending = null;
  $('qr-img').removeAttribute('src');
  $('qr-box').hidden = true;
  $('pair-code').textContent = '';
  $('btn-pair-allow').hidden = true;
  $('btn-pair-deny').hidden = true;
}
async function closePair() {
  const pairId = pair?.pairId;
  clearPairUi();
  $('pair-dialog').close();
  if (pairId) await action('pair-close', { pairId });
}
async function openPair() {
  if (pair) {
    if (!$('pair-dialog').open) $('pair-dialog').showModal();
    return;
  }
  pair = await action('pair-open');
  pending = null;
  $('qr-box').hidden = false;
  $('qr-img').src = pair.dataUrl;
  $('pair-code').textContent = pair.code;
  $('pair-pending').textContent = '等待手机发起配对';
  $('pair-dialog').showModal();
}
async function pollPair() {
  if (!pair) return;
  const pairId = pair.pairId;
  const r = await action('pair-status', { pairId });
  if (pair?.pairId !== pairId) return;
  if (r.approved) {
    clearPairUi();
    $('pair-pending').textContent = '配对成功，可以在手机上使用。';
    await refreshDevices();
    return;
  }
  pending = r.pending;
  $('pair-pending').textContent = pending
    ? `${pending.name} 请求访问这台电脑，请核对正在配对的手机。`
    : '等待手机发起配对';
  $('btn-pair-allow').hidden = !pending;
  $('btn-pair-deny').hidden = !pending;
}
function showBind() {
  clearPairUi();
  $('pair-dialog').close();
  $('detail-dialog').close();
  lastStatus = null;
  $('view-main').classList.add('hidden');
  $('view-bind').classList.remove('hidden');
}
async function showMain() {
  $('view-bind').classList.add('hidden');
  $('view-main').classList.remove('hidden');
  $('autostart').checked = !!(await api.autostartGet());
  await refreshStatus();
  await refreshLogs();
  void guard(refreshDevices);
}
async function pairOperation(fn, button) {
  if (operating) return;
  operating = true;
  try {
    await pollDone;
    await guard(fn, button);
  } finally {
    operating = false;
  }
}
$('login-form').onsubmit = (event) => {
  event.preventDefault();
  void guard(async () => {
    operating = true;
    try {
      const key = $('account-key').value.trim();
      if (!key) return;
      let r = await api.accessLogin(key, false);
      if (
        r.error === 'replace-confirmation-required' &&
        confirm('此账号已登记另一台电脑。替换将断开旧电脑，手机需要重新配对。继续？')
      )
        r = await api.accessLogin(key, true);
      if (!r.ok) {
        $('bind-msg').textContent = messages[r.error] || r.error;
        return;
      }
      $('account-key').value = '';
      $('bind-msg').textContent = '';
      selectPage('overview');
      await showMain();
      await api.serviceStart();
      await refreshStatus();
    } finally {
      operating = false;
    }
  }, $('btn-login'));
};
$('btn-refresh').onclick = () =>
  guard(async () => {
    await refreshStatus();
    await refreshLogs();
  }, $('btn-refresh'));
$('btn-refresh-logs').onclick = () => guard(refreshLogs, $('btn-refresh-logs'));
$('btn-service').onclick = () =>
  pairOperation(async () => {
    if (lastStatus?.frpc) {
      if (!confirm('停止远程连接？DSH 与 Codex 本地任务会继续运行。')) return;
      await closePair();
      await api.serviceStop();
    } else {
      const result = await api.serviceStart();
      if (!result.frpc) toast('隧道未连接，请查看运行日志。');
    }
    await refreshStatus();
    await refreshLogs();
  }, $('btn-service'));
$('btn-pair-open').onclick = () => pairOperation(openPair, $('btn-pair-open'));
$('btn-pair-copy').onclick = () =>
  pairOperation(async () => {
    await openPair();
    await navigator.clipboard.writeText(pair.code);
    toast('配对码已复制，请保持配对窗口打开。');
  }, $('btn-pair-copy'));
$('btn-pair-close').onclick = () => pairOperation(closePair, $('btn-pair-close'));
$('pair-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  void pairOperation(closePair);
});
for (const [id, allow] of [
  ['btn-pair-allow', true],
  ['btn-pair-deny', false],
])
  $(id).onclick = () =>
    pairOperation(async () => {
      if (!pair || !pending) return;
      await action('pair-confirm', { pairId: pair.pairId, requestId: pending.requestId, allow });
      if (allow) await pollPair();
      else {
        clearPairUi();
        $('pair-dialog').close();
      }
    }, $(id));
$('btn-phone-rename').onclick = () =>
  guard(async () => {
    const name = prompt('手机名称');
    if (name?.trim()) {
      await action('rename-phone', { name: name.trim() });
      await refreshDevices();
    }
  });
$('btn-phone-unbind').onclick = () =>
  pairOperation(async () => {
    if (confirm('解除绑定后旧手机立即失去远程访问。继续？')) {
      await action('unbind-phone');
      await closePair();
      await refreshDevices();
    }
  });
$('btn-unbind').onclick = () =>
  pairOperation(async () => {
    if (!confirm('退出登录将停止远程访问，保留设备绑定和本地任务。继续？')) return;
    await closePair();
    const r = await api.bindingClear();
    if (!r.ok) throw new Error(messages[r.error] || r.error);
    showBind();
  }, $('btn-unbind'));
$('autostart').onchange = () =>
  guard(async () => {
    const requested = $('autostart').checked;
    try {
      const result = await api.autostartSet(requested);
      if (!result.ok) throw new Error('开机启动设置失败');
    } catch (e) {
      $('autostart').checked = !requested;
      throw e;
    }
  });
document.querySelectorAll('[data-detail]').forEach((button) => {
  button.onclick = () => {
    const s = lastStatus;
    $('detail-title').textContent =
      button.dataset.detail === 'dsh' ? 'DSH · 服务详情' : 'Codex · 服务详情';
    $('detail-body').textContent =
      button.dataset.detail === 'dsh'
        ? `${$('dsh-hint').textContent}\n\n本地认证：${s?.dsh ? '已通过' : '未通过'}\n隧道：${s?.frpc ? '已连接' : '未连接'}\n\n认证失败时请检查现有 DSH 进程与启动记录。不会自动终止未知进程。`
        : `桌面应用：${$('codex-process').textContent}\n本地桥接：${s?.codexBridge ? '已连接' : '未连接'}\n本地认证：尚无独立认证探测结果\n\n桥接连接不代表账号认证通过。当前可读取已有会话的历史；桌面端占用的会话暂不支持手机发送。请在电脑端完成 Codex 登录。`;
    $('detail-dialog').showModal();
  };
});
$('btn-detail-close').onclick = () => $('detail-dialog').close();
async function tick() {
  if (polling || operating) return;
  polling = true;
  let finishPoll;
  pollDone = new Promise((resolve) => {
    finishPoll = resolve;
  });
  try {
    const b = await api.bindingGet();
    if (!b.loggedIn) {
      showBind();
      return;
    }
    if ($('view-main').classList.contains('hidden')) await showMain();
    try {
      await pollPair();
    } catch (e) {
      if (pair) {
        await closePair().catch(() => {});
        toast(e.message);
      }
    }
    await refreshStatus();
    await refreshLogs();
    if (!$('page-settings').classList.contains('hidden')) await refreshDevices();
  } finally {
    polling = false;
    finishPoll();
  }
}
void guard(async () => {
  const b = await api.bindingGet();
  $('app-version').textContent = b.appVersion ? `v${b.appVersion}` : 'Batona PC';
  $('settings-version').textContent = b.appVersion || '—';
  if (b.loggedIn) await showMain();
  else showBind();
  if (b.storageError) $('bind-msg').textContent = b.storageError;
});
setInterval(() => {
  void guard(tick);
}, 4000);
