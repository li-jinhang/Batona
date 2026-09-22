'use strict';
const $ = id => document.getElementById(id);
let adminKey = '';
const errors = { unauthorized:'管理员密钥无效，请重新登录。', 'rate-limited':'操作过于频繁，请稍后重试。', 'internal-error':'操作未完成，请刷新核对状态。' };
async function api(op, body = {}) {
  const r = await fetch('/api/admin/' + op, { method:'POST', headers:{ 'content-type':'application/json', authorization:'Bearer ' + adminKey }, body:JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(errors[data.error] || '操作失败，请刷新后重试。');
  return data;
}
async function run(action) { $('message').textContent=''; try { await action(); } catch(e) { $('message').textContent=e.message; } }
function showKey(key) { $('revealed-key').value=key; $('key-dialog').showModal(); }
$('close-key').onclick=()=>$('key-dialog').close();
$('key-dialog').addEventListener('close',()=>{$('revealed-key').value='';});
async function refresh() {
  const data=await api('accounts'); $('accounts').replaceChildren(); $('empty').hidden=data.items.length>0;
  for(const a of data.items) {
    const row=document.createElement('tr');
    for(const text of [a.remark || '未备注', a.disabled?'已永久禁用':'可使用',a.requests24h == null ? '暂不可用' : String(a.requests24h)]) { const td=document.createElement('td'); td.textContent=text; row.append(td); }
    const actions=document.createElement('td');
    for(const [label,op] of [['查看密钥','reveal'],['修改备注','remark'],['禁用','disable'],['重置','reset'],['删除','delete']]) {
      const button=document.createElement('button');button.textContent=label;
      if(['disable','reset','delete'].includes(op))button.className='danger';
      if(op==='disable'&&a.disabled)button.disabled=true;
      button.onclick=()=>run(async()=>{
        let body={id:a.id};
        if(op==='remark'){const value=prompt('修改账号备注（不参与登录）',a.remark);if(value===null)return;body.remark=value;}
        const warning={disable:'永久禁用此账号？无法重新启用，全部设备远程访问会断开。',reset:'重置为新账号？旧密钥、设备登记和统计会清除，用户必须重新接入。',delete:'删除此账号？密钥、设备登记与统计将清除，无法撤销。'};
        if(warning[op]&&!confirm(warning[op]))return;
        button.disabled=true;
        try { const result=await api(op,body);if(result.key)showKey(result.key);await refresh(); } finally { button.disabled=false; }
      });actions.append(button);
    }row.append(actions);$('accounts').append(row);
  }
}
$('login').onsubmit=e=>{e.preventDefault();void run(async()=>{adminKey=$('admin-key').value.trim();await refresh();$('admin-key').value='';$('login').hidden=true;$('panel').hidden=false;$('logout').hidden=false;});};
$('create').onsubmit=e=>{e.preventDefault();void run(async()=>{const r=await api('create',{remark:$('remark').value});$('remark').value='';showKey(r.key);await refresh();});};
$('refresh').onclick=()=>run(refresh);
$('logout').onclick=()=>{adminKey='';$('admin-key').value='';$('accounts').replaceChildren();$('key-dialog').close();$('panel').hidden=true;$('logout').hidden=true;$('login').hidden=false;};
window.addEventListener('pagehide',()=>{adminKey='';$('revealed-key').value='';});
