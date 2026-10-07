const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopShell', {
  command: (action, value) => ipcRenderer.invoke('shell:command', action, value),
  onState: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('shell:state', listener); return () => ipcRenderer.removeListener('shell:state', listener); }
});
