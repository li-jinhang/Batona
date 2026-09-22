import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
const dir=mkdtempSync(join(tmpdir(),'dsh-bundle-'));let processUnderTest:ChildProcess|undefined;
const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));
const addr=reservation.address();assert(addr&&typeof addr!=='string');await new Promise<void>(r=>reservation.close(()=>r()));
const config=join(dir,'config.json');
try{
  writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:addr.port,dataDir:dir,webDir:resolve('web')}));
  const env: NodeJS.ProcessEnv={...process.env,GATEWAY_CONFIG:config};delete env.PORT;delete env.GATEWAY_HOST;
  const uninitialized=spawnSync(process.execPath,['dist/app.mjs'],{env,encoding:'utf8'});assert.notEqual(uninitialized.status,0);
  assert.equal(spawnSync(process.execPath,['scripts/init-access.mjs',config,dir],{encoding:'utf8'}).status,0);
  processUnderTest=spawn(process.execPath,['dist/app.mjs'],{env,stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('bundle startup timeout')),10000);
    processUnderTest!.once('exit',()=>{clearTimeout(timer);reject(new Error('bundle stopped early'));});
    processUnderTest!.stdout!.on('data',()=>{clearTimeout(timer);resolve();});
  });
  const base=`http://127.0.0.1:${addr.port}`;
  const health=await fetch(base+'/healthz').then(r=>r.json()) as any;
  assert.equal(health.accessMode,'hosted');assert.equal(health.version,JSON.parse(readFileSync('package.json','utf8')).version);
  assert.equal((await fetch(base+'/access-admin')).status,200);
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST'})).status,410);
  assert.equal((await fetch(base+'/api/dsh/launch-token',{method:'POST'})).status,410);
  assert.equal((await fetch(base+'/remote/')).status,410);
  console.log('PASS production bundle fails closed before provisioning, starts after provisioning, reports version and rejects legacy entry points');
}finally{
  if(processUnderTest&&processUnderTest.exitCode===null){const exited=new Promise<void>(r=>processUnderTest!.once('exit',()=>r()));processUnderTest.kill();await exited;}
  rmSync(dir,{recursive:true,force:true});
}
