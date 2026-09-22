/** Opt-in: reads running local backends through the new isolated hosted graph; never sends prompts. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { HostedGateway } from '../src/hosted/gateway.ts';
const { TunnelClient }=createRequire(import.meta.url)('../../../pc/tunnel/client.js');
const dir=mkdtempSync(join(tmpdir(),'batona-hosted-readonly-'));
const adminKey=randomBytes(32).toString('hex');
const gateway=new HostedGateway({dataDir:dir,adminKey,vaultKey:randomBytes(32),webDir:'./web'});
let tunnel:any,mobile:WebSocket|undefined;
try{
  await new Promise<void>(r=>gateway.server.listen(0,'127.0.0.1',r));const addr=gateway.server.address();assert(addr&&typeof addr!=='string');
  const base=`http://127.0.0.1:${addr.port}`;
  const api=async(path:string,body:object={},token='')=>{
    const r=await fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
    assert.equal(r.status,200,path);return await r.json() as any;
  };
  const account=await api('admin/create',{remark:'read-only temporary fixture'},adminKey);
  const pc=await api('access/login',{key:account.key,deviceSecret:randomBytes(32).toString('hex')});
  const cached=JSON.parse(readFileSync(join(process.env.APPDATA!,'Batona PC','dsh-token.json'),'utf8'));
  tunnel=new TunnelClient({host:'127.0.0.1',gwPort:addr.port,token:pc.token,tls:false,services:()=>[{name:'dsh',localPort:cached.port||3080},{name:'dir',localPort:3081},{name:'codex',localPort:3082}]});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('tunnel-timeout')),10000);tunnel.once('connected',()=>{clearTimeout(timer);resolve();});tunnel.start();});
  await api('access/launch-token',{token:cached.token},pc.token);
  const p=await api('access/pair-open',{},pc.token);
  const request=await api('access/pair-request',{code:p.code,deviceSecret:randomBytes(32).toString('hex')});
  await api('access/pair-confirm',{pairId:p.pairId,requestId:request.requestId,allow:true},pc.token);
  const phone=await api('access/pair-result',request);
  mobile=new WebSocket(base.replace('http:','ws:')+'/ws');await new Promise<void>(r=>mobile!.once('open',r));
  const rpc=(method:string,payload:object={})=>new Promise<any>((resolve,reject)=>{
    const rpcId=randomBytes(8).toString('hex');
    const timer=setTimeout(()=>reject(new Error('rpc-timeout:'+method)),20000);
    const read=(data:unknown)=>{const msg=JSON.parse(String(data));if(msg.rpcId!==rpcId)return;clearTimeout(timer);mobile!.off('message',read);msg.result.ok?resolve(msg.result.value):reject(new Error('rpc-failed:'+method+':'+msg.result.error?.code));};
    mobile!.on('message',read);mobile!.send(JSON.stringify({type:'client-request',rpcId,method,payload}));
  });
  await rpc('auth.hello',{token:phone.token});
  for(const backend of ['dsh','codex']){
    const tree=await rpc('workspace.tree',{backend});assert(tree.items.length>0,backend+' workspace list');
    const models=await rpc('model.list',{backend});assert(models.items.length>0,backend+' models');
    const sessions=await rpc('session.list',{backend});
    const first=sessions.sessions.find((s:any)=>s.backend===backend);assert(first,backend+' sessions');
    const restored=await rpc('session.resume',{backend,backendSessionId:first.backendSessionId});
    const history=await rpc('session.history',{sessionId:restored.id});assert(Array.isArray(history.events));
    console.log(`PASS hosted real ${backend}: workspaces=${tree.items.length}, models=${models.items.length}, history=${history.events.length}; no prompt sent`);
  }
  const profiles=await rpc('agent.profile.list',{backend:'codex'});assert(profiles.items.length>0);
  assert.equal((await api('admin/accounts',{},adminKey)).items[0].requests24h,0);
}finally{mobile?.terminate();tunnel?.stop();await gateway.close();rmSync(dir,{recursive:true,force:true});}
