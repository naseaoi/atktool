const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atkOverlay', {
  getInitialState: () => ipcRenderer.invoke('overlay:get-state'),
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('overlay:state-changed', listener);

    return () => {
      ipcRenderer.removeListener('overlay:state-changed', listener);
    };
  },
  openHubWindow: () => ipcRenderer.send('overlay:open-hub-window'),
  refreshHub: () => ipcRenderer.send('overlay:refresh-hub'),
  togglePin: () => ipcRenderer.invoke('overlay:toggle-pin'),
  toggleVariant: () => ipcRenderer.invoke('overlay:toggle-variant'),
  fitHeight: (contentHeight) => ipcRenderer.send('overlay:fit-height', contentHeight),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
});
