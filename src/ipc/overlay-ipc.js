const { ipcMain } = require('electron');
const overlayState = require('../core/overlay-state');
const overlayWindow = require('../windows/overlay-window');
const { togglePinState } = require('../core/device-actions');

// 悬浮窗相关的 IPC 注册。对应 overlay-preload.js 暴露的 atkOverlay API。

function register() {
  ipcMain.handle('overlay:get-state', () => overlayState.get());
  ipcMain.handle('overlay:toggle-pin', () => togglePinState());
  ipcMain.handle('overlay:toggle-variant', async () => {
    const nextVariant = overlayState.getOverlayVariant() === 'compact' ? 'full' : 'compact';
    await overlayWindow.applyVariant(nextVariant);
    return overlayState.get();
  });
  ipcMain.on('overlay:fit-height', (_event, contentHeight) => {
    overlayWindow.fitHeight(contentHeight);
  });
  ipcMain.on('overlay:hide', () => {
    overlayWindow.hide();
  });
}

module.exports = {
  register,
};
