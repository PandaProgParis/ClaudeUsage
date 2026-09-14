// Bridge between the tray panel and the agent. The panel is a dumb view:
// it never computes anything, it only renders what main.js sends.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  getState: () => ipcRenderer.invoke('usage:get-state'),
  onState: (callback) => ipcRenderer.on('usage:state', (_event, state) => callback(state)),
  sync: () => ipcRenderer.send('usage:sync'),
  relogin: () => ipcRenderer.send('usage:relogin'),
  logout: () => ipcRenderer.send('usage:logout'),
  openSettings: () => ipcRenderer.send('usage:open-settings'),
  quit: () => ipcRenderer.send('usage:quit'),
  hide: () => ipcRenderer.send('usage:hide'),
  reportHeight: (height) => ipcRenderer.send('usage:height', height),
})
