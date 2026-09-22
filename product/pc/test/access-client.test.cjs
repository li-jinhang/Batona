// Electron safeStorage and actual local TLS gateway; no UI/user profile/production access.
const {app,safeStorage} = require('electron');
const {AccessClient} = require('../access-client.js');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const https=require('node:https');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-pc-access-'));
app.setPath('userData',dir);
app.whenReady().then(async()=>{
  let code=0;
  try {
    const ca=fs.readFileSync(process.env.DSH_FIXTURE_CA);
    const server='https://127.0.0.1:19443';
    const fixture=op=>new Promise((resolve,reject)=>{https.get(server+'/_fixture/'+op,{ca,agent:false},res=>{let data='';res.on('data',d=>data+=d);res.on('end',()=>{try{assert.equal(res.statusCode,200);resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject);});
    const opts={userData:dir,safeStorage,server,request:(url,options,cb)=>https.request(url,{...options,ca},cb)};
    const account=await fixture('pc-create');
    const client=new AccessClient(opts);
    await client.login(account.key);
    assert.equal((await client.refresh()).loggedIn,true);
    const encrypted=fs.readFileSync(path.join(dir,'access.bin'));
    assert(!encrypted.includes(client.data.token));assert(!encrypted.includes(client.data.deviceSecret));assert(!encrypted.includes(account.key));
    assert(!safeStorage.decryptString(encrypted).includes(account.key));
    const restarted=new AccessClient(opts);
    assert.equal(restarted.data.deviceSecret,client.data.deviceSecret);
    assert.equal((await restarted.refresh()).loggedIn,true);
    restarted.server='https://127.0.0.1:1';
    await assert.rejects(restarted.refresh());assert.equal(restarted.publicState().loggedIn,true);
    restarted.server=server;
    await restarted.logout();assert.equal(restarted.publicState().loggedIn,false);
    assert.equal(restarted.data.deviceSecret,client.data.deviceSecret);
    await restarted.login(account.key);
    await fixture('pc-disable');
    assert.equal((await restarted.refresh()).loggedIn,false);
    await client.logout(); // Old/revoked token must not trap the UI outside login.
    assert.equal(client.publicState().loggedIn,false);
    console.log('PASS Electron native safeStorage, real HTTPS PC login, restart, offline retention, logout and revoked-credential recovery');
  } catch(e) { console.error('FAIL PC access test:',e.code||e.name);code=1; }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
  app.exit(code);
});
