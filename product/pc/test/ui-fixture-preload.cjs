'use strict';
// Isolated renderer contract fixture. Never packaged or connected to a real gateway.
const { contextBridge } = require('electron');
let loggedIn = true,
  started = true,
  codeOpen = false,
  approved = false;
const calls = [];
contextBridge.exposeInMainWorld('batona', {
  bindingGet: async () => ({ loggedIn, appVersion: 'UI test' }),
  accessLogin: async () => {
    loggedIn = true;
    return { ok: true };
  },
  bindingClear: async () => {
    loggedIn = false;
    return { ok: true };
  },
  serviceStatus: async () => ({
    bound: loggedIn,
    dsh: true,
    dshProcess: true,
    codexDesktop: true,
    codexBridge: true,
    frpc: started,
    gateway: true,
    serverIp: '示例网关',
  }),
  serviceStart: async () => {
    started = true;
    return { dsh: true, frpc: true };
  },
  serviceStop: async () => {
    started = false;
    calls.push('service-stop');
    return { ok: true };
  },
  logTail: async () => [
    '[2026-09-22T08:56:00Z] DSH 本地认证通过',
    '[2026-09-22T08:56:10Z] 加密隧道已连接',
    '[2026-09-22T08:57:00Z] Codex 历史读取可用',
  ],
  autostartGet: async () => true,
  autostartSet: async (on) => ({ ok: true, on }),
  accessCall: async (op, body) => {
    calls.push(op);
    if (op === 'devices') return { ok: true, items: [] };
    if (op === 'pair-open') {
      codeOpen = true;
      approved = false;
      return {
        ok: true,
        pairId: 'fixture',
        code: 'TEST-CODE',
        dataUrl:
          'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="210" height="210"><rect width="210" height="210" fill="white"/><text x="20" y="110">TEST FIXTURE</text></svg>',
      };
    }
    if (op === 'pair-close') {
      codeOpen = false;
      return { ok: true };
    }
    if (op === 'pair-status')
      return {
        ok: true,
        approved,
        pending: codeOpen ? { requestId: 'request', name: '测试手机' } : null,
      };
    if (op === 'pair-confirm') {
      approved = body.allow;
      return { ok: true };
    }
    return { ok: true };
  },
});
contextBridge.exposeInMainWorld('uiFixture', {
  calls: () => calls.slice(),
  revoke: () => {
    loggedIn = false;
  },
});
