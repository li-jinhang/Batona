'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { randomBytes } = require('node:crypto');

const SERVER = 'https://117.72.10.87';
class AccessClient {
  constructor({ userData, safeStorage, server = SERVER, request = https.request }) {
    this.server = server; this.request = request;
    this.file = path.join(userData, 'access.bin'); this.crypto = safeStorage;
    this.data = { deviceSecret: randomBytes(32).toString('base64url'), token: null };
    if (fs.existsSync(this.file)) {
      try { this.data = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.file))); }
      catch { this.storageError = '本机登录资料无法解密，请重新登录；可能需要确认替换电脑。'; }
    }
  }
  save() {
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法保存登录。');
    fs.writeFileSync(this.file + '.tmp', this.crypto.encryptString(JSON.stringify(this.data)));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  async call(op, body = {}, token = this.data.token) {
    const result = await new Promise((resolve, reject) => {
      const req = this.request(this.server + '/api/access/' + op, { method:'POST', rejectUnauthorized:true,
        headers:{'content-type':'application/json', authorization:'Bearer ' + (token || '')} }, res => {
        let text='';res.setEncoding('utf8');res.on('data',c=>{text+=c;if(text.length>65536)req.destroy(new Error('response-too-large'));});
        res.on('end',()=>{try{resolve(JSON.parse(text));}catch{reject(new Error('服务器尚未升级或响应无效'));}});
      });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('连接超时')));req.end(JSON.stringify(body));
    });
    if (!result.ok) { const error=new Error(result.error || '请求失败');error.code=result.error;throw error; }
    return result;
  }
  async login(key, replace = false) {
    this.save(); // Persist device identity before a request whose response may be lost.
    const r = await this.call('login', {key, replace, deviceSecret:this.data.deviceSecret, name:require('node:os').hostname()}, '');
    this.data.token=r.token;this.data.accountId=r.accountId;this.data.deviceId=r.deviceId;this.save();
    return {ok:true, accountId:r.accountId};
  }
  binding() { return this.data.token ? {serverIp:'117.72.10.87',gwPort:443,deviceToken:this.data.token,hosted:true} : null; }
  publicState() { return {loggedIn:!!this.data.token,accountId:this.data.accountId || null,storageError:this.storageError || null}; }
  async refresh() {
    if (this.data.token) try { await this.call('status'); } catch(e) { if(e.code === 'unauthorized') this.clear(); else throw e; }
    return this.publicState();
  }
  async logout() { try { await this.call('logout'); } catch(e) { if (e.code !== 'unauthorized') throw e; } this.clear(); }
  clear() { this.data.token=null;delete this.data.accountId;delete this.data.deviceId;this.save(); }
}
module.exports={AccessClient};
