const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('caidanDesktop', {
  startup: enabled => ipcRenderer.invoke('app:startup', enabled),
  openTaobao: () => ipcRenderer.invoke('app:taobao'),
  pendingOrder: () => ipcRenderer.invoke('app:pending'),
  acknowledge: id => ipcRenderer.invoke('app:ack', id),
  syncInvoices: purchaseIds => ipcRenderer.invoke('app:sync-invoices', purchaseIds).catch(error => {
    throw new Error(error.message.replace(/^Error invoking remote method 'app:sync-invoices': Error: /, ''));
  }),
  onOrder: callback => { const listener = (_, order) => callback(order); ipcRenderer.on('app:order', listener); return () => ipcRenderer.removeListener('app:order', listener); },
  onSync: callback => { const listener = () => callback(); ipcRenderer.on('app:sync', listener); return () => ipcRenderer.removeListener('app:sync', listener); }
});
