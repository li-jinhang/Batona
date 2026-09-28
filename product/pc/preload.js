/**
 * Batona PC — preload：向渲染进程暴露安全的 IPC API
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('batona', {
  bindingGet: () => ipcRenderer.invoke('binding:get'),
  accessLogin: (key, replace) => ipcRenderer.invoke('access:login', key, replace),
  accessCall: (op, body = {}) => ipcRenderer.invoke('access:call', op, body),
  copyPairCode: () => ipcRenderer.invoke('pair:copy-code'),
  bindingClear: () => ipcRenderer.invoke('binding:clear'),
  serviceStart: () => ipcRenderer.invoke('service:start'),
  serviceStartFrpc: () => ipcRenderer.invoke('service:startFrpc'),
  dshStart: () => ipcRenderer.invoke('dsh:start'),
  dshRestart: () => ipcRenderer.invoke('dsh:restart'),
  dshOpen: () => ipcRenderer.invoke('dsh:open'),
  serviceStop: () => ipcRenderer.invoke('service:stop'),
  serviceStatus: () => ipcRenderer.invoke('service:status'),
  codexControlSet: (mode) => ipcRenderer.invoke('codex:control:set', mode),
  logTail: () => ipcRenderer.invoke('log:tail'),
  autostartGet: () => ipcRenderer.invoke('settings:autostart:get'),
  autostartSet: (on) => ipcRenderer.invoke('settings:autostart:set', on),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateOpenDownloadPage: () => ipcRenderer.invoke('update:open-download-page'),
});
