const { ipcMain } = require('electron');
const overlaySource = require('../core/overlay-source');
const overlayState = require('../core/overlay-state');
const { sanitizeHubState } = require('../core/hub-state');
const hubWindow = require('../windows/hub-window');

// 官网同步窗口 preload 收集到的状态回写到主进程。
// 仅在 source === 'hub' 时接受,避免本地直连模式下被官网页面覆盖。

function register() {
  ipcMain.on('hub:state', (event, hubState) => {
    if (overlaySource.get() !== 'hub') {
      return;
    }

    const currentHubWindow = hubWindow.get();
    if (
      !currentHubWindow
      || currentHubWindow.isDestroyed()
      || event.sender !== currentHubWindow.webContents
      || event.senderFrame !== currentHubWindow.webContents.mainFrame
    ) {
      return;
    }

    const nextState = sanitizeHubState(hubState);
    if (!nextState) {
      return;
    }

    overlayState.merge({
      ...nextState,
      mode: 'fallback',
      protocolName: '官网同步电量',
    });
  });
}

module.exports = {
  register,
};
