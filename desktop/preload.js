const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buildid', {
  onConfig: (cb) => ipcRenderer.on('config', (_e, cfg) => cb(cfg)),
  listSources: () => ipcRenderer.invoke('capture:list-sources'),
  setDisplay: (id) => ipcRenderer.invoke('capture:set-display', id),
  sendInput: (event) => ipcRenderer.send('input:event', event),

  trust: {
    list: () => ipcRenderer.invoke('trust:list'),
    hashes: () => ipcRenderer.invoke('trust:hashes'),
    confirm: (info) => ipcRenderer.invoke('trust:confirm', info),
    approve: (info) => ipcRenderer.invoke('trust:approve', info),
    revoke: (id) => ipcRenderer.invoke('trust:revoke', id),
  },
});
