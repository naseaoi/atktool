const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atkWorker', {
  getInitialState: () => ipcRenderer.invoke('overlay:get-state'),
  getPreferences: () => ipcRenderer.invoke('manager:get-preferences'),
  getBootstrapState: () => ipcRenderer.invoke('worker:get-bootstrap-state'),
  updateState: (state) => ipcRenderer.send('worker:state', state),
  rememberDevice: (device) => ipcRenderer.invoke('manager:remember-device', device),
  onPreferencesChanged: (callback) => {
    const listener = (_event, preferences) => callback(preferences);
    ipcRenderer.on('manager:preferences', listener);

    return () => {
      ipcRenderer.removeListener('manager:preferences', listener);
    };
  },
  onRefreshRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('worker:refresh-requested', listener);

    return () => {
      ipcRenderer.removeListener('worker:refresh-requested', listener);
    };
  },
  onOverlayVisibilityChanged: (callback) => {
    const listener = (_event, visible) => callback(visible);
    ipcRenderer.on('worker:overlay-visibility', listener);

    return () => {
      ipcRenderer.removeListener('worker:overlay-visibility', listener);
    };
  },
  onRuntimeModeChanged: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('worker:runtime-mode', listener);

    return () => {
      ipcRenderer.removeListener('worker:runtime-mode', listener);
    };
  },
});
