const { logWarn } = require('./logger');

// 统一封装 webContents.send 的空值/销毁态防御,避免各处重复 isDestroyed 判空。
function sendToWindow(targetWindow, channel, payload, label) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  try {
    targetWindow.webContents.send(channel, payload);
  } catch (error) {
    logWarn(`${label} 发送失败`, {
      channel,
      error,
    });
  }
}

function isWindowVisible(targetWindow) {
  return Boolean(targetWindow && !targetWindow.isDestroyed() && targetWindow.isVisible());
}

module.exports = {
  sendToWindow,
  isWindowVisible,
};
