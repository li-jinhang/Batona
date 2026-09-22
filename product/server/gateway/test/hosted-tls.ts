import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer, get } from 'node:https';
const dir=mkdtempSync(join(tmpdir(),'dsh-tls-'));
const file=(name:string)=>join(dir,name);
const openssl=(...args:string[])=>{
  const r=spawnSync(process.env.OPENSSL || (process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl'),args,{encoding:'utf8'});
  assert.equal(r.status,0,'test certificate generation: '+r.stderr);
};
openssl('req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',file('ca.key'),'-out',file('ca.pem'),'-subj','/CN=Isolated test root','-addext','basicConstraints=critical,CA:TRUE');
function leaf(name:string,ip:string,days:string){
  openssl('req','-new','-newkey','rsa:2048','-nodes','-keyout',file(name+'.key'),'-out',file(name+'.csr'),'-subj','/CN=Test leaf','-addext','subjectAltName=IP:'+ip);
  openssl('x509','-req','-in',file(name+'.csr'),'-CA',file('ca.pem'),'-CAkey',file('ca.key'),'-CAcreateserial','-out',file(name+'.pem'),...(days === '-1' ? ['-not_before','20190101000000Z','-not_after','20200101000000Z'] : ['-days',days]),'-copy_extensions','copy');
  return {key:readFileSync(file(name+'.key')),cert:readFileSync(file(name+'.pem'))};
}
const first=leaf('first','127.0.0.1','1'), rotated=leaf('rotated','127.0.0.1','1');
const mismatch=leaf('mismatch','127.0.0.2','1'), expired=leaf('expired','127.0.0.1','-1');
const server=createServer(first,(_req,res)=>res.end('ok'));
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const a=server.address();assert(a&&typeof a!=='string');
const request=(trusted=true)=>new Promise<void>((resolve,reject)=>{
  const req=get({hostname:'127.0.0.1',port:a.port,ca:trusted?readFileSync(file('ca.pem')):undefined,rejectUnauthorized:true,agent:false},res=>{res.resume();res.on('end',resolve);});
  req.on('error',reject);
});
try {
  await request();
  await assert.rejects(request(false));
  server.setSecureContext(rotated);await request();
  server.setSecureContext(mismatch);await assert.rejects(request(),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
  server.setSecureContext(expired);await assert.rejects(request(),{code:'CERT_HAS_EXPIRED'});
  console.log('PASS TLS trusted IP, unknown CA rejection, valid leaf/key rotation, wrong IP rejection and expired certificate rejection');
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
