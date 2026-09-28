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
  check: '<path d="m5 12 4 4L19 6"/>',
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
let codexControlRunning = false;
let dshActionRunning = false;
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
const codexTransportCopyByMode = {
  'shared-write': { label: '共享连接（可写）' },
  'shared-readonly': { label: '共享连接（只读）', hint: '当前连接只读，手机发送和模型切换仍不可用。' },
  'stdio-native-ui': { label: '本地协议 + 界面兼容控制' },
  'not-started': { label: '未启动' },
};
const codexAuthLabels = {
  'signed-in': '已登录',
  'signed-out': '未登录',
  'not-required': '无需登录',
  unknown: '状态未知',
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
function renderCodexControl(s = lastStatus) {
  const mode = s?.codexControlMode || (s?.codexTransport?.startsWith('shared-') ? 'shared' : 'interface');
  document.querySelectorAll('[data-control-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.controlMode === mode));
    button.disabled = codexControlRunning;
  });
}
function renderDetail(s = lastStatus) {
  const dialog = $('detail-dialog');
  const isCodex = dialog.dataset.detail === 'codex';
  $('btn-dsh-open').disabled = dshActionRunning || !s?.dsh;
  $('btn-dsh-start').disabled = dshActionRunning || !!s?.dsh;
  $('btn-dsh-restart').disabled = dshActionRunning;
  $('detail-body').textContent = isCodex
    ? [
      `桌面应用：${$('codex-process').textContent}`,
      `本地桥接：${s?.codexBridge ? '已连接' : '未连接'}`,
      ...(s?.codexControlMode === 'shared' ? [`共享桌面连接：${s.codexSharedAttached === true ? '已连接' : '未连接'}`] : []),
      `登录状态：${codexAuthLabels[s?.codexAuth] || codexAuthLabels.unknown}`,
      $('codex-hint').textContent,
      codexTransportCopyByMode[s?.codexTransport]?.hint,
      s?.codexAuth === 'signed-out' ? '请在电脑端完成 Codex 登录。' : '',
    ].filter(Boolean).join('\n')
    : [
      $('dsh-hint').textContent,
      `本地认证：${s?.dsh ? '已通过' : '未通过'}`,
      `隧道：${s?.frpc ? '已连接' : '未连接'}`,
      '认证失败时请检查现有 DSH 进程与启动记录。不会自动终止未知进程。',
    ].filter(Boolean).join('\n');
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
  $('dsh-hint').hidden = dshReady;
  $('dsh-hint').textContent = dshReady
    ? ''
    : s.dsh
      ? '本地认证正常，等待隧道与网关连接。'
      : s.dshProcess
        ? '进程正在运行，但本地认证未通过。'
        : '请启动服务，或检查本机 DSH 安装。';
  setState(
    'codex-process',
    s.codexDesktop == null ? '状态未知' : s.codexDesktop ? '运行中' : '未运行',
    s.codexDesktop ? 'good' : '',
  );
  renderCodexControl(s);
  const codexAuth = s.codexAuth || 'unknown';
  setState(
    'codex-auth',
    codexAuthLabels[codexAuth] || codexAuthLabels.unknown,
    codexAuth === 'signed-in' || codexAuth === 'not-required' ? 'good' : codexAuth === 'signed-out' ? 'warn' : '',
  );
  const codexAttached = s.codexControlMode !== 'shared' || s.codexSharedAttached === true;
  const codexReady = Boolean(s.codexDesktop && s.codexBridge && codexAttached && s.frpc && s.gateway);
  const codexStatus = codexReady
    ? '远程就绪'
    : s.codexDesktop == null
      ? '状态未知'
      : !s.codexDesktop
        ? '未运行'
        : s.codexBridge
          ? '等待连接'
          : '未连接';
  badge(
    'codex-badge',
    codexStatus,
    codexReady ? 'good' : 'neutral',
  );
  $('codex-hint').hidden = codexReady;
  $('codex-hint').textContent = s.codexDesktop === false
    ? 'Codex 桌面应用未运行。'
    : codexReady
      ? ''
      : s.codexControlMode === 'shared' && !codexAttached
        ? 'Codex 未接入共享连接，请重新选择共享连接并重启。'
      : s.codexBridge
        ? '本地桥接正常，等待隧道与网关连接。'
        : '本地桥未连接，请启动服务后重试。';
  $('service-action-label').textContent = s.frpc ? '停止服务' : '启动服务';
  icon($('btn-service').querySelector('[data-icon]'), s.frpc ? 'stop' : 'play');
  $('server-address').textContent = s.serverIp || '—';
  renderDetail(s);
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
  $('btn-pair-copy').hidden = true;
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
  $('btn-pair-copy').hidden = false;
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
    if (!pair?.code) throw new Error('配对码已失效，请重新打开配对信息。');
    const result = await api.copyPairCode();
    if (!result.ok) throw new Error(messages[result.error] || '复制配对码失败。');
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
$('btn-check-update').onclick = () =>
  guard(async () => {
    const status = $('update-status');
    const note = $('update-note');
    const download = $('btn-open-update-page');
    status.textContent = '正在检查官网版本…';
    note.textContent = '';
    note.hidden = true;
    download.hidden = true;
    const result = await api.updateCheck();
    if (!result?.ok) {
      status.textContent = '无法获取官网更新信息，请检查网络后重试。';
      return;
    }
    if (result.updateAvailable) {
      status.textContent = `发现新版本 v${result.latestVersion}（当前 v${result.currentVersion}）`;
      note.textContent = result.note || '';
      note.hidden = !note.textContent;
      download.hidden = false;
    } else if (result.siteVersionIsOlder) {
      status.textContent = `当前版本 v${result.currentVersion}，高于官网登记版本 v${result.latestVersion}。`;
    } else {
      status.textContent = `当前已是官网最新版本 v${result.latestVersion}。`;
    }
  }, $('btn-check-update'));
$('btn-open-update-page').onclick = () =>
  guard(async () => {
    const result = await api.updateOpenDownloadPage();
    if (!result?.ok) throw new Error('无法打开官网下载页，请稍后重试。');
  }, $('btn-open-update-page'));
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
document.querySelectorAll('.backend-card[data-detail]').forEach((card) => {
  const openDetail = () => {
    const s = lastStatus;
    const isCodex = card.dataset.detail === 'codex';
    $('detail-dialog').dataset.detail = isCodex ? 'codex' : 'dsh';
    $('detail-title').textContent = isCodex ? 'Codex · 服务详情' : 'DSH · 服务详情';
    $('codex-control-panel').hidden = !isCodex;
    $('dsh-detail-actions').hidden = isCodex;
    $('dsh-detail-result').hidden = true;
    renderDetail(s);
    $('detail-dialog').showModal();
    if (isCodex) renderCodexControl(s);
  };
  card.addEventListener('click', openDetail);
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openDetail();
  });
});
$('btn-detail-close').onclick = () => $('detail-dialog').close();
$('btn-dsh-start').onclick = async () => {
  if (dshActionRunning) return;
  dshActionRunning = true;
  renderDetail();
  const button = $('btn-dsh-start');
  button.disabled = true;
  $('dsh-detail-result').hidden = true;
  try {
    const result = await api.dshStart();
    if (!result?.ok) throw new Error(result?.error || 'DSH 启动失败。');
    await refreshStatus();
    $('dsh-detail-result').textContent = result.alreadyRunning ? 'DSH 已在运行。' : 'DSH 服务已启动。';
  } catch (error) { $('dsh-detail-result').textContent = error.message || 'DSH 启动失败。'; }
  finally { dshActionRunning = false; $('dsh-detail-result').hidden = false; renderDetail(); }
};
$('btn-dsh-restart').onclick = async () => {
  if (dshActionRunning) return;
  dshActionRunning = true;
  $('btn-dsh-restart').textContent = '正在重启…';
  $('dsh-detail-result').hidden = true;
  renderDetail();
  try {
    const result = await api.dshRestart();
    if (!result?.ok) throw new Error(result?.error || 'DSH 重启失败。');
    $('dsh-detail-result').textContent = 'DSH 服务已重启。';
  } catch (error) { $('dsh-detail-result').textContent = error.message || 'DSH 重启失败。'; }
  finally {
    dshActionRunning = false;
    $('btn-dsh-restart').textContent = '重启 DSH 服务';
    $('dsh-detail-result').hidden = false;
    await refreshStatus();
    renderDetail();
  }
};
$('btn-dsh-open').onclick = async () => {
  const result = await api.dshOpen();
  if (!result?.ok) {
    $('dsh-detail-result').textContent = result?.error || '请先启动 DSH 服务。';
    $('dsh-detail-result').hidden = false;
    await refreshStatus();
  }
};
async function setCodexControl(mode) {
  if (codexControlRunning) return;
  codexControlRunning = true;
  renderCodexControl();
  const restartButton = $('btn-codex-restart-confirm');
  const cancelButton = $('btn-codex-restart-cancel');
  if (mode === 'shared') {
    restartButton.disabled = true;
    cancelButton.disabled = true;
    restartButton.textContent = '正在重启…';
  }
  $('codex-restart-error').hidden = true;
  try {
    const result = await api.codexControlSet(mode);
    if (!result?.ok) throw new Error(result?.error || '控制方式切换失败。');
    await refreshStatus();
    if (mode === 'shared') $('codex-restart-dialog').close();
    const message = mode === 'shared' ? '已切换到共享连接。' : '已切换到界面控制。';
    $('codex-control-result').textContent = message;
    $('codex-control-result').hidden = false;
    toast(message);
  } catch (error) {
    if (mode === 'shared') {
      $('codex-restart-error').textContent = error.message || '重启失败，请重试。';
      $('codex-restart-error').hidden = false;
    } else toast(error.message || '控制方式切换失败。');
  } finally {
    codexControlRunning = false;
    if (mode === 'shared') {
      restartButton.disabled = false;
      cancelButton.disabled = false;
      restartButton.textContent = '重启';
    }
    renderCodexControl();
  }
}
document.querySelectorAll('[data-control-mode]').forEach((button) => {
  button.onclick = () => {
    if (codexControlRunning) return;
    const mode = button.dataset.controlMode;
    if (mode === 'interface') {
      if (lastStatus?.codexControlMode !== 'interface') void setCodexControl(mode);
      return;
    }
    if (lastStatus?.codexControlMode === 'shared' && lastStatus?.codexTransport === 'shared-write'
      && lastStatus?.codexSharedAttached === true) return;
    $('codex-restart-error').hidden = true;
    $('codex-restart-dialog').showModal();
  };
});
$('btn-codex-restart-cancel').onclick = () => $('codex-restart-dialog').close();
$('codex-restart-dialog').addEventListener('cancel', (event) => {
  if (codexControlRunning) event.preventDefault();
});
$('btn-codex-restart-confirm').onclick = () => void setCodexControl('shared');
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
