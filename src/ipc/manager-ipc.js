const { ipcMain } = require('electron');
const overlayState = require('../core/overlay-state');
const overlaySource = require('../core/overlay-source');
const batteryRuntime = require('../core/battery-runtime');
const hidSelection = require('../device/hid-selection');
const managerWindow = require('../windows/manager-window');
const overlayWindow = require('../windows/overlay-window');
const hubWindow = require('../windows/hub-window');
const {
  rememberPreferredDevice,
  clearPreferredDeviceBinding,
} = require('../core/device-actions');
const loginItem = require('../system/login-item');

// 设备管理相关的 IPC 注册。对应 manager-preload.js 暴露的 atkManager API。

function register() {
  ipcMain.handle('manager:get-preferences', () => overlayState.buildManagerPreferences());
  ipcMain.handle('manager:get-overlay-state', () => overlayState.get());

  ipcMain.handle('manager:request-refresh', () => {
    managerWindow.refresh();
    return true;
  });

  ipcMain.handle('manager:begin-hid-selection', async () => {
    const runtime = batteryRuntime.get();
    if (!runtime) {
      return false;
    }
    const devices = await runtime.listChooserDevices();
    hidSelection.set(devices);
    return devices.length > 0;
  });

  ipcMain.handle('manager:end-hid-selection', () => hidSelection.clear());

  ipcMain.handle('manager:pick-hid-device', async (_event, deviceId) => {
    if (!hidSelection.hasDeviceId(deviceId)) {
      return false;
    }
    const runtime = batteryRuntime.get();
    if (!runtime) {
      return false;
    }
    const binding = await runtime.bindDeviceById(deviceId);
    if (!binding) {
      return false;
    }
    rememberPreferredDevice(binding);
    hidSelection.clear();
    managerWindow.refresh();
    return true;
  });

  ipcMain.handle('manager:cancel-hid-selection', () => hidSelection.cancel());

  ipcMain.handle('manager:clear-device-binding', async () => {
    clearPreferredDeviceBinding();
    return overlayState.buildManagerPreferences();
  });

  ipcMain.handle('manager:set-open-at-login', (_event, enabled) => {
    loginItem.setOpenAtLogin(enabled);
    return overlayState.buildManagerPreferences();
  });

  ipcMain.handle('manager:set-overlay-variant', async (_event, overlayVariant) => {
    return overlayWindow.applyVariant(overlayVariant);
  });

  ipcMain.on('manager:fit-height', (_event, contentHeight) => {
    managerWindow.fitHeight(contentHeight);
  });

  ipcMain.handle('manager:activate-stable-source', async () => overlaySource.activateStable());

  ipcMain.on('manager:open-fallback', () => {
    hubWindow.show();
  });
}

module.exports = {
  register,
};
