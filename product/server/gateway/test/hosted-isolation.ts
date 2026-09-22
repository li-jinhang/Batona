import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { HostedGateway } from '../src/hosted/gateway.ts';
const { TunnelClient } = createRequire(import.meta.url)('../../../pc/tunnel/client.js');
const { awaitInitialConnection } = createRequire(import.meta.url)('../../../pc/tunnel/startup.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-isolation-'));
const adminKey = randomBytes(32).toString('hex'), vaultKey = randomBytes(32);
let now = Date.now();
let gateway = new HostedGateway({ dataDir: dir, adminKey, vaultKey, webDir: './web', mock: true, now: () => now });
let base = '';
const sockets: WebSocket[] = [], clients: any[] = [], upstreams: Server[] = [];
async function listen() { await new Promise<void>(r => gateway.server.listen(0, '127.0.0.1', r)); const a = gateway.server.address(); assert(a && typeof a !== 'string'); base = `http://127.0.0.1:${a.port}`; }
async function api(op: string, body: object = {}, token = '') {
  const response = await fetch(base + '/api/' + op, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  return { status: response.status, ...await response.json() as any };
}
async function pc(name: string) {
  const account = await api('admin/create', { remark: name }, adminKey);
  const deviceSecret = randomBytes(32).toString('hex');
  const login = await api('access/login', { key: account.key, deviceSecret, name });
  assert.equal(login.status, 200);
  const upstream = createServer((_req, res) => { res.setHeader('content-type', 'application/json');res.end(JSON.stringify({ ok: true, path: name, dirs: [name] })); });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));upstreams.push(upstream);
  const address = upstream.address();assert(address && typeof address !== 'string');
  const connect = async (token: string) => {
    const client = new TunnelClient({ host: '127.0.0.1', gwPort: Number(new URL(base).port), token, tls: false, services: () => [{name:'dir',localPort:address.port}] });
    clients.push(client);
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('tunnel-timeout')), 5000);client.once('connected',()=>{clearTimeout(timer);resolve();});client.start(); });
    return client;
  };
  await connect(login.token); return { account, deviceSecret, login, connect };
}
async function pair(token: string, deviceSecret = randomBytes(32).toString('hex')) {
  const p = await api('access/pair-open', {}, token);assert.equal(p.status,200);
  const request = await api('access/pair-request', { code:p.code,deviceSecret,name:'Phone' });assert.equal(request.status,200);
  const confirm = await api('access/pair-confirm', {pairId:p.pairId,requestId:request.requestId,allow:true},token);assert.equal(confirm.status,200);
  const result = await api('access/pair-result',request);assert.equal(result.status,200);
  return {...result,deviceSecret};
}
async function phone(token: string) {
  const ws=new WebSocket(base.replace('http:','ws:')+'/ws');sockets.push(ws);
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const pushes: any[]=[];ws.on('message',d=>{const r=JSON.parse(String(d));if(r.type==='server-request')pushes.push(r);});
  const rpc=(method:string,payload:object={})=>new Promise<any>((resolve,reject)=>{
    const rpcId=randomBytes(8).toString('hex');
    const timer=setTimeout(()=>{ws.off('message',read);reject(new Error('rpc-timeout:'+method));},5000);
    const read=(d:unknown)=>{const r=JSON.parse(String(d));if(r.rpcId===rpcId){clearTimeout(timer);ws.off('message',read);resolve(r.result);}};
    ws.on('message',read);ws.send(JSON.stringify({type:'client-request',rpcId,method,payload}));
  });
  assert.equal((await rpc('auth.hello',{token})).ok,true);return {ws,rpc,pushes};
}
try {
  await listen();
  const a=await pc('PC-A'),b=await pc('PC-B');
  const pa=await pair(a.login.token),pb=await pair(b.login.token);
  const ma=await phone(pa.token),mb=await phone(pb.token);
  assert.equal((await ma.rpc('fs.listDir')).value.path,'PC-A');
  assert.equal((await mb.rpc('fs.listDir')).value.path,'PC-B');
  const session=(await ma.rpc('session.create',{backend:'mock'})).value;
  assert.equal((await mb.rpc('session.history',{sessionId:session.id})).ok,false);
  const spy=new WebSocket(base.replace('http:','ws:')+'/ws');sockets.push(spy);
  await new Promise<void>(r=>spy.once('open',r));let spyMessages=0;spy.on('message',()=>spyMessages++);
  await ma.rpc('session.prompt',{sessionId:session.id,parts:[{type:'text',text:'fixture'}]});
  await new Promise(r=>setTimeout(r,100));
  assert(ma.pushes.length>0);assert.equal(mb.pushes.length,0);assert.equal(spyMessages,0);
  assert.equal((await api('admin/accounts',{},adminKey)).items.find((x:any)=>x.id===a.account.id).requests24h,1);
  now+=86400001;
  assert.equal((await api('admin/accounts',{},adminKey)).items.find((x:any)=>x.id===a.account.id).requests24h,0);
  assert.equal((await api('access/logout',{},a.login.token)).status,200);
  assert.equal((await api('access/status',{},pa.token)).pcOnline,false);
  const loginA=await api('access/login',{key:a.account.key,deviceSecret:a.deviceSecret});a.login=loginA;await a.connect(loginA.token);
  assert.equal((await api('access/status',{},pa.token)).status,200);
  const restored=await phone(pa.token);assert.equal((await restored.rpc('fs.listDir')).value.path,'PC-A');
  assert.equal((await api('access/logout',{},pa.token)).status,200);
  assert.equal((await api('access/devices',{},loginA.token)).items.length,1);
  const pairedAgain=await pair(loginA.token,pa.deviceSecret);assert.notEqual(pairedAgain.token,pa.token);
  const opened=await api('access/pair-open',{},loginA.token);
  assert.equal((await api('access/pair-request',{code:opened.code,deviceSecret:randomBytes(32).toString('hex')})).status,409);
  await api('access/pair-close',{pairId:opened.pairId},loginA.token);
  assert.equal((await api('access/pair-request',{code:opened.code,deviceSecret:pa.deviceSecret})).status,404);
  const replacement=await api('access/login',{key:a.account.key,deviceSecret:randomBytes(32).toString('hex')});assert.equal(replacement.status,409);
  assert.equal((await api('access/status',{},loginA.token)).status,200);
  now += 5000;
  const timestamped = await phone(pairedAgain.token);
  assert.equal((await api('access/devices',{},loginA.token)).items[0].lastSeen, now);
  timestamped.ws.terminate();
  await api('access/rename-phone',{name:'Renamed phone'},loginA.token);
  assert.equal((await api('access/devices',{},loginA.token)).items[0].name,'Renamed phone');
  await api('access/unbind-phone',{},loginA.token);
  assert.equal((await api('access/status',{},pairedAgain.token)).status,401);
  assert.equal((await api('access/devices',{},loginA.token)).items.length,0);
  const newPhone=await pair(loginA.token);
  const newPc=await api('access/login',{key:a.account.key,deviceSecret:randomBytes(32).toString('hex'),replace:true});
  assert.equal(newPc.status,200);
  assert.equal((await api('access/status',{},newPhone.token)).status,401);
  assert.equal((await api('access/status',{},loginA.token)).status,401);
  assert.equal((await api('access/devices',{},newPc.token)).items.length,0);
  await a.connect(newPc.token);
  // A UI deadline may expire before start/connect; the client must still connect later.
  const delayed = new TunnelClient({host:'127.0.0.1',gwPort:Number(new URL(base).port),token:newPc.token,tls:false,services:()=>[{name:'dir',localPort:1}]});
  clients.push(delayed);
  assert.equal((await awaitInitialConnection(delayed,5)).ok,false);
  const eventually=awaitInitialConnection(delayed,5000);delayed.start();assert.equal((await eventually).ok,true);
  const reset=await api('admin/reset',{id:a.account.id},adminKey);assert.notEqual(reset.id,a.account.id);
  assert.equal((await api('access/status',{},loginA.token)).status,401);
  assert.equal((await api('access/status',{},pairedAgain.token)).status,401);
  assert.equal((await mb.rpc('fs.listDir')).value.path,'PC-B');
  await api('admin/disable',{id:b.account.id},adminKey);
  assert.equal((await api('access/login',{key:b.account.key,deviceSecret:b.deviceSecret})).status,401);
  for(const client of clients)client.stop();for(const ws of sockets)ws.terminate();
  await gateway.close();
  gateway=new HostedGateway({dataDir:dir,adminKey,vaultKey,webDir:'./web',mock:true,now:()=>now});await listen();
  const accounts=await api('admin/accounts',{},adminKey);
  assert.equal(accounts.items.find((x:any)=>x.id===b.account.id).disabled,true);
  assert.equal(accounts.items.find((x:any)=>x.id===reset.id).requests24h,0);
  assert.equal((await api('access/status',{},pb.token)).status,401);
  await api('admin/delete',{id:reset.id},adminKey);
  assert.equal((await api('admin/accounts',{},adminKey)).items.length,1);
  console.log('PASS two real PC tunnel clients: routing, cross-account rejection, zero leaked pushes, logout recovery, pair reuse, reset/disable/delete, rolling count and restart persistence');
} finally {
  for(const client of clients)client.stop();for(const ws of sockets)ws.terminate();
  for(const server of upstreams){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  await gateway.close();rmSync(dir,{recursive:true,force:true});
}
