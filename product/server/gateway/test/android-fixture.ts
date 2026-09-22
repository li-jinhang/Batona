/** Local-only instrumented acceptance fixture. Never connects to production or real Agent processes. */
import { HostedGateway } from '../src/hosted/gateway.ts';
import { createServer as httpsServer } from 'node:https';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { TunnelClient } = createRequire(import.meta.url)('../../../pc/tunnel/client.js');
const dir = mkdtempSync(join(tmpdir(), 'dsh-android-fixture-'));
const cert = join(dir, 'public-ca.pem'), key = join(dir, 'fixture.key');
const ssl = spawnSync(process.env.OPENSSL || 'C:/Program Files/Git/usr/bin/openssl.exe', ['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',key,'-out',cert,'-subj','/CN=DSH isolated test','-addext','subjectAltName=IP:10.0.2.2,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE'], { encoding:'utf8' });
if (ssl.status !== 0) throw new Error('fixture-certificate-generation-failed');
const adminKey = randomBytes(32).toString('hex');
const gateway = new HostedGateway({ dataDir: dir, adminKey, vaultKey: randomBytes(32), webDir: './web', mock: true });
await new Promise<void>(r => gateway.server.listen(19444,'127.0.0.1',r));
const api = async (path: string, body: object = {}, token = '') => {
  const res = await fetch('http://127.0.0.1:19444/api/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
  if (!res.ok) throw new Error('fixture-api-failed:' + path + ':' + res.status);
  return await res.json() as any;
};
const account = await api('admin/create',{remark:'Android isolated fixture'},adminKey);
const pc = await api('access/login',{key:account.key,deviceSecret:randomBytes(32).toString('hex')});
const tunnel = new TunnelClient({host:'127.0.0.1',gwPort:19444,token:pc.token,tls:false,services:()=>[{name:'dir',localPort:1}]});
await new Promise<void>(r => { tunnel.once('connected',r);tunnel.start(); });
let pair = await api('access/pair-open',{},pc.token);
let desktopFixture: {id:string;key:string} | undefined;
const lease = setInterval(()=>{void api('access/pair-status',{pairId:pair.pairId},pc.token).catch(()=>{});},4000);
const server = httpsServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  if (req.url?.startsWith('/_fixture/')) {
    void (async()=>{
      let result: object = {};
      if (req.url === '/_fixture/pc-create') { desktopFixture = await api('admin/create',{remark:'Electron isolated fixture'},adminKey);result=desktopFixture!; }
      else if (req.url === '/_fixture/pc-disable') { await api('admin/disable',{id:desktopFixture?.id},adminKey); }
      else if (req.url === '/_fixture/open') { await api('access/unbind-phone',{},pc.token); pair=await api('access/pair-open',{},pc.token);result={code:pair.code}; }
      else if(req.url === '/_fixture/approve') { const status=await api('access/pair-status',{pairId:pair.pairId},pc.token);await api('access/pair-confirm',{pairId:pair.pairId,requestId:status.pending.requestId,allow:true},pc.token); }
      else if(req.url === '/_fixture/count') result={count:(await api('admin/accounts',{},adminKey)).items[0].requests24h};
      else if(req.url === '/_fixture/unbind') await api('access/unbind-phone',{},pc.token);
      else if(req.url === '/_fixture/stop') { res.end('{}');setTimeout(()=>void close(),100);return; }
      else {res.statusCode=404;res.end();return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
    })().catch(()=>{res.statusCode=500;res.end('{"error":"fixture-failure"}');});return;
  }
  const upstream=request({host:'127.0.0.1',port:19444,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode??502,r.headers);r.pipe(res);});
  upstream.on('error',()=>{res.statusCode=502;res.end();});req.pipe(upstream);
});
server.on('upgrade',(req,socket,head)=>{
  const upstream=connect(19444,'127.0.0.1',()=>{
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k,v])=>k+': '+v).join('\r\n')}\r\n\r\n`);
    if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
await new Promise<void>(r=>server.listen(19443,'127.0.0.1',r));
console.log(JSON.stringify({fixture:'ready',port:19443,publicCertificate:cert,pid:process.pid}));
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(lease);tunnel.stop();await gateway.close();server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
