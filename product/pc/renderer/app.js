/* DSH Link — renderer 逻辑（vanilla JS，经 preload 的 window.dshLink 与主进程通信） */
'use strict';

const api = window.dshLink;
const $ = (id) => document.getElementById(id);

// 轻量 toast 提示（底部短暂消息）
function toast(msg) {
  let t = document.getElementById('dsh-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'dsh-toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:9px 18px;border-radius:99px;font-size:13px;z-index:99;transition:opacity .3s;max-width:80%;text-align:center;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

// ── 摄像头扫码（jsQR）────────────────────────────────────────────────
let scanStream = null;
let scanRaf = 0;

async function startScan() {
  const panel = $('scan-panel');
  panel.classList.remove('hidden');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('scan-video');
    video.srcObject = scanStream;
    await video.play();
    const tick = () => {
      scanRaf = requestAnimationFrame(tick);
      if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const res = jsQR(img.data, img.width, img.height);
      if (res && res.data.startsWith('dsh-gw://')) {
        $('conn-input').value = res.data;
        stopScan();
        parseAndSave(res.data);
      }
    };
    scanRaf = requestAnimationFrame(tick);
  } catch (e) {
    $('bind-msg').textContent = '扫码不可用（' + e.message + '），请手动粘贴连接串';
  }
}

function stopScan() {
  cancelAnimationFrame(scanRaf);
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  $('scan-panel').classList.add('hidden');
}

// ── 绑定 ─────────────────────────────────────────────────────────────
async function parseAndSave(text) {
  const r = await api.bindingSave(text);
  $('bind-msg').textContent = r.ok ? `已绑定 ${r.binding.serverIp}，开始启动服务…` : '绑定失败：' + r.error;
  if (r.ok) {
    await api.serviceStart();
    showMain();
  }
}

// ── 状态轮询 ─────────────────────────────────────────────────────────
async function refreshStatus() {
  const s = await api.serviceStatus();
  if (!s) return;
  setDot('dot-dsh', s.dsh);
  setDot('dot-frpc', s.frpc);
  setDot('dot-gw', s.gateway);
  // DSH 0.1.2+ 需要 launch token 才能建连：单独把 token 状态说清楚，避免"灯全绿但手机连不上"
  const hint = $('dsh-hint');
  if (hint) {
    hint.textContent = !s.dsh
      ? 'DSH 未运行'
      : s.dshAuthed
        ? 'launch token 有效，手机端可建连'
        : s.dshToken
          ? '已捕获 launch token，但认证未通过（DSH 可能刚重启，等待自动补报）'
          : '未捕获 launch token：手机端无法建连（可用 DSHLINK_DSH_TOKEN 手动指定）';
  }
  // 服务状态灯 = 三灯与门（全部正常才绿）
  setDot('dot-all', s.dsh && s.frpc && s.gateway);
}

function setDot(dotId, on) {
  const d = $(dotId); if (!d) return;
  d.classList.remove('on', 'off');
  d.classList.add(on ? 'on' : 'off');
}

async function refreshQr() {
  const r = await api.qrPair();
  if (r.ok) $('qr-img').src = r.dataUrl;
}

async function refreshConn() {
  // 二维码验证链接备选：展示连接串，可一键复制（二维码失效/模糊时改用）
  const conn = await api.connString();
  $('conn-text').textContent = conn || '';
}

async function refreshAutostart() {
  $('autostart').checked = !!(await api.autostartGet());
}

// ── 视图切换 ─────────────────────────────────────────────────────────
async function showMain() {
  $('view-bind').classList.add('hidden');
  $('view-main').classList.remove('hidden');
  await refreshStatus(); await refreshQr(); await refreshConn(); await refreshAutostart();
}

async function showBind() {
  $('view-main').classList.add('hidden');
  $('view-bind').classList.remove('hidden');
}

// ── 启动 ─────────────────────────────────────────────────────────────
async function init() {
  $('btn-parse').onclick = () => parseAndSave($('conn-input').value);
  $('btn-scan').onclick = startScan;
  $('btn-scan-stop').onclick = stopScan;
  $('btn-start').onclick = async () => { await api.serviceStart(); refreshStatus(); };
  $('btn-frpc').onclick = async () => {
    const r = await api.serviceStartFrpc();
    toast(r.ok ? '隧道已启动' : '启动失败，请查看日志');
    refreshStatus();
  };
  $('btn-stop').onclick = async () => { await api.serviceStop(); refreshStatus(); };
  $('btn-unbind').onclick = async () => {
    if (confirm('解绑将停止隧道并清除服务器信息，继续？')) {
      await api.bindingClear(); await api.serviceStop(); showBind();
    }
  };
  $('btn-copy-conn').onclick = async () => {
    const conn = await api.connString();
    if (!conn) { toast('无可复制内容'); return; }
    try { await navigator.clipboard.writeText(conn); toast('验证链接已复制'); }
    catch (e) { toast('复制失败：' + e.message); }
  };
  $('btn-pc-settings').onclick = () => toast('电脑设置功能开发中');
  $('btn-cloud-info').onclick = () => toast('云端信息功能开发中');
  $('autostart').onchange = async (e) => { await api.autostartSet(e.target.checked); };

  const b = await api.bindingGet();
  // 服务生命周期由主进程统一自动启动；渲染进程重复调用会并发建立两条隧道。
  if (b) { showMain(); }
  else { showBind(); }
  setInterval(refreshStatus, 4000);
}

init();
