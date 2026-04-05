const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atkManager', {
  getPreferences: () => ipcRenderer.invoke('manager:get-preferences'),
  getOverlayState: () => ipcRenderer.invoke('manager:get-overlay-state'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('manager:set-open-at-login', enabled),
  setOverlayVariant: (overlayVariant) => ipcRenderer.invoke('manager:set-overlay-variant', overlayVariant),
  requestRefresh: () => ipcRenderer.invoke('manager:request-refresh'),
  fitHeight: (contentHeight) => ipcRenderer.send('manager:fit-height', contentHeight),
  activateStableSource: () => ipcRenderer.invoke('manager:activate-stable-source'),
  beginHidSelection: () => ipcRenderer.invoke('manager:begin-hid-selection'),
  endHidSelection: () => ipcRenderer.invoke('manager:end-hid-selection'),
  pickHidDevice: (deviceId) => ipcRenderer.invoke('manager:pick-hid-device', deviceId),
  cancelHidSelection: () => ipcRenderer.invoke('manager:cancel-hid-selection'),
  clearDeviceBinding: () => ipcRenderer.invoke('manager:clear-device-binding'),
  rememberDevice: (device) => ipcRenderer.invoke('manager:remember-device', device),
  openFallback: () => ipcRenderer.send('manager:open-fallback'),
  onPreferencesChanged: (callback) => {
    const listener = (_event, preferences) => callback(preferences);
    ipcRenderer.on('manager:preferences', listener);

    return () => {
      ipcRenderer.removeListener('manager:preferences', listener);
    };
  },
  onOverlayStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('manager:overlay-state', listener);

    return () => {
      ipcRenderer.removeListener('manager:overlay-state', listener);
    };
  },
  onHidSelectionChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('manager:hid-selection', listener);

    return () => {
      ipcRenderer.removeListener('manager:hid-selection', listener);
    };
  },
});
