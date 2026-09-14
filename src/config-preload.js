// Bridge between the settings window and the agent. The form only ever sees
// the three config keys and the labels to display; validation and persistence
// stay in main.js, where the rest of the config logic lives.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settings', {
  load: () => ipcRenderer.invoke('config:get'),
  save: (values) => ipcRenderer.invoke('config:save', values),
  close: () => ipcRenderer.send('config:close'),
  reportHeight: (height) => ipcRenderer.send('config:height', height),
})
