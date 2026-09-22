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

// ── 状态轮询 ─────────────────────────────────────────────────────────
async function refreshStatus() {
  const s = await api.serviceStatus();
  if (!s) return;
  setDot('dot-dsh', s.dsh ? true : s.dshProcess ? 'warn' : s.dshProcess);
  setDot('dot-codex', s.codexDesktop);
  setDot('dot-frpc', s.frpc);
  setDot('dot-gw', s.gateway);
  $('dsh-status').textContent = s.dsh ? '运行中 · 已认证' : s.dshProcess === null ? '状态未知' : s.dshProcess ? '运行中 · 认证失败' : '未运行';
  $('codex-status').textContent = s.codexDesktop === null ? '状态未知' : s.codexDesktop ? '运行中' : '未运行';
  $('codex-hint').textContent = s.codexBridge ? '本地桥已连接，可读取历史。电脑端持有会话的手机发送仍受限制。' : '本地桥未连接，请启动服务后重试。';
  const hint = $('dsh-hint');
  if (hint) {
    hint.textContent = s.dsh ? '本地认证正常；远程访问还需要隧道与网关在线。'
      : s.dshProcess ? '进程存在，但启动令牌未通过认证，手机暂时无法读取 DSH。'
      : s.dshProcess === null ? '无法检测本体进程，请稍后重试。' : '请启动 DSH 服务。';
  }
  const allReady = s.dsh && s.codexDesktop && s.codexBridge && s.frpc && s.gateway;
  const someReady = s.frpc && s.gateway && (s.dsh || s.codexBridge);
  setDot('dot-all', allReady ? true : someReady ? 'warn' : false);
  $('all-status').textContent = allReady ? '连接就绪' : someReady ? '部分可用' : '未就绪';
}

function setDot(dotId, on) {
  const d = $(dotId); if (!d) return;
  d.classList.remove('on', 'off', 'warn', 'unknown');
  d.classList.add(on === 'warn' ? 'warn' : on == null ? 'unknown' : on ? 'on' : 'off');
}


let pair = null, pending = null, busy = false;
const messages = {
  'unauthorized':'登录已失效，请重新登录。', 'upgrade-required':'服务器尚未切换新版，请等待管理员发布。',
  'pc-offline':'隧道未连接，请先启动隧道。', 'phone-slot-occupied':'已有其他手机，请先在设备管理中解绑。',
  'pair-invalid':'配对已失效，请重新打开配对页。', 'invalid-credentials':'账号密钥无效或已被禁用。',
  'rate-limited':'请求过于频繁，请稍后重试。'
};
async function action(op, body={}) {
  const r=await api.accessCall(op,body);
  if(!r.ok)throw new Error(messages[r.error]||r.error||'操作失败');
  return r;
}
async function guard(fn){try{await fn();}catch(e){toast(e.message);}}
function closePairUi(){pair=null;pending=null;$('pair-panel').hidden=true;$('qr-img').removeAttribute('src');$('pair-code').textContent='';}
async function showMain(){ $('view-bind').classList.add('hidden');$('view-main').classList.remove('hidden');$('autostart').checked=!!await api.autostartGet();await refreshStatus();await refreshDevices(); }
function showBind(){closePairUi();$('view-main').classList.add('hidden');$('view-bind').classList.remove('hidden');}
async function refreshDevices(){
  const r=await action('devices'), phone=r.items[0];
  $('phone-state').textContent=phone ? phone.name+' · '+(phone.online?'在线':'离线')+' · 最近连接 '+new Date(phone.lastSeen).toLocaleString() : '尚未绑定手机';
  $('btn-phone-rename').disabled=!phone;$('btn-phone-unbind').disabled=!phone;
}
async function pollPair(){
  if(!pair)return;
  const r=await action('pair-status',{pairId:pair.pairId});
  if(r.approved){$('pair-pending').textContent='配对成功，可在手机上使用';$('btn-pair-allow').hidden=true;$('btn-pair-deny').hidden=true;return;}
  pending=r.pending;
  $('pair-pending').textContent=pending ? pending.name+' 请求访问这台电脑，请核对正在配对的手机。' : '等待手机发起配对';
  $('btn-pair-allow').hidden=!pending;$('btn-pair-deny').hidden=!pending;
}
$('btn-login').onclick=async()=>{
  if(busy)return;busy=true;$('btn-login').disabled=true;
  try{
    const key=$('account-key').value.trim();
    let r=await api.accessLogin(key,false);
    if(r.error==='replace-confirmation-required'&&confirm('此账号已登记另一台电脑。替换将断开旧电脑，手机需要重新配对。继续？'))r=await api.accessLogin(key,true);
    if(!r.ok){$('bind-msg').textContent=messages[r.error]||r.error;return;}
    $('account-key').value='';$('bind-msg').textContent='';
    await showMain();void guard(async()=>{await api.serviceStart();await refreshStatus();});
  }finally{busy=false;$('btn-login').disabled=false;}
};
$('btn-start').onclick=()=>guard(async()=>{await api.serviceStart();await refreshStatus();});
$('btn-frpc').onclick=()=>guard(async()=>{const r=await api.serviceStartFrpc();toast(r.ok?'隧道已启动':'连接失败，请检查登录与服务端');});
$('btn-stop').onclick=()=>guard(async()=>{await api.serviceStop();closePairUi();await refreshStatus();});
$('btn-unbind').onclick=()=>guard(async()=>{
  if(!confirm('退出登录将停止远程访问，保留设备绑定，不停止本地任务。继续？'))return;
  const r=await api.bindingClear();if(!r.ok)throw new Error(messages[r.error]||r.error);showBind();
});
$('btn-pair-open').onclick=()=>guard(async()=>{pair=await action('pair-open');$('pair-panel').hidden=false;$('qr-img').src=pair.dataUrl;$('pair-code').textContent=pair.code;await pollPair();});
$('btn-pair-close').onclick=()=>guard(async()=>{if(pair)await action('pair-close',{pairId:pair.pairId});closePairUi();});
for(const [id,allow] of [['btn-pair-allow',true],['btn-pair-deny',false]])$(id).onclick=()=>guard(async()=>{
  if(!pair||!pending)return;
  await action('pair-confirm',{pairId:pair.pairId,requestId:pending.requestId,allow});
  if(!allow)closePairUi();else await pollPair();
  await refreshDevices();
});
$('btn-phone-rename').onclick=()=>guard(async()=>{const name=prompt('手机名称');if(name?.trim()){await action('rename-phone',{name:name.trim()});await refreshDevices();}});
$('btn-phone-unbind').onclick=()=>guard(async()=>{if(confirm('解除绑定后旧手机立即失去远程访问。继续？')){await action('unbind-phone');closePairUi();await refreshDevices();}});
$('btn-pc-settings').onclick=()=>toast('服务只在电脑本地执行。账号操作不停止 DSH/Codex 任务。');
$('btn-cloud-info').onclick=()=>toast('117.72.10.87 · 可信 HTTPS · 自研 WSS 隧道');
$('autostart').onchange=e=>api.autostartSet(e.target.checked);
async function tick(){
  if(busy)return;
  const b=await api.bindingGet();
  if(!b.loggedIn){showBind();return;}
  try{await pollPair();await refreshStatus();await refreshDevices();}
  catch(e){if(pair){closePairUi();toast(e.message);}}
}
void guard(async()=>{const b=await api.bindingGet();if(b.loggedIn)await showMain();else showBind();if(b.storageError)$('bind-msg').textContent=b.storageError;});
setInterval(()=>{void guard(tick);},4000);
