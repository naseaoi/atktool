const { app } = require('electron');
const settingsStore = require('../core/settings-store');

// 开机启动项:打包后使用 execPath 无参启动;开发期补一个 app path 参数让 Electron 能找到工程。
function getLoginItemArgs() {
  return app.isPackaged ? [] : [app.getAppPath()];
}

function setOpenAtLogin(enabled) {
  const nextValue = Boolean(enabled);
  const args = getLoginItemArgs();

  app.setLoginItemSettings({
    openAtLogin: nextValue,
    path: process.execPath,
    args,
  });

  // 回读系统实际状态为准,避免权限/策略阻止时 settings 与实际不一致。
  const loginItemState = app.getLoginItemSettings({
    path: process.execPath,
    args,
  });

  settingsStore.update({
    openAtLogin: Boolean(loginItemState.openAtLogin),
  });

  return loginItemState;
}

module.exports = {
  setOpenAtLogin,
  getLoginItemArgs,
};
