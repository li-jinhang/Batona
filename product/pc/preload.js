/**
 * DSH Link — preload：向渲染进程暴露安全的 IPC API
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshLink', {
  bindingGet: () => ipcRenderer.invoke('binding:get'),
  bindingSave: (text) => ipcRenderer.invoke('binding:save', text),
  bindingClear: () => ipcRenderer.invoke('binding:clear'),
  connString: () => ipcRenderer.invoke('binding:connString'),
  serviceStart: () => ipcRenderer.invoke('service:start'),
  serviceStartFrpc: () => ipcRenderer.invoke('service:startFrpc'),
  serviceStop: () => ipcRenderer.invoke('service:stop'),
  serviceStatus: () => ipcRenderer.invoke('service:status'),
  logTail: () => ipcRenderer.invoke('log:tail'),
  qrPair: () => ipcRenderer.invoke('qr:pair'),
  autostartGet: () => ipcRenderer.invoke('settings:autostart:get'),
  autostartSet: (on) => ipcRenderer.invoke('settings:autostart:set', on),
});
