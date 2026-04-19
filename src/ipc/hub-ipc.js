const { ipcMain } = require('electron');
const overlaySource = require('../core/overlay-source');
const overlayState = require('../core/overlay-state');

// 官网同步窗口 preload 收集到的状态回写到主进程。
// 仅在 source === 'hub' 时接受,避免本地直连模式下被官网页面覆盖。

function register() {
  ipcMain.on('hub:state', (_event, hubState) => {
    if (overlaySource.get() !== 'hub') {
      return;
    }

    overlayState.merge({
      ...hubState,
      mode: 'fallback',
      protocolName: hubState.protocolName || '官网同步电量',
    });
  });
}

module.exports = {
  register,
};
