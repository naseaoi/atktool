const { powerMonitor } = require('electron');
const { logInfo } = require('../utils/logger');
const batteryRuntime = require('../core/battery-runtime');

// 系统休眠/恢复后强制重连 HID:防止休眠期间驱动/receiver 被断开后设备状态漂移。
function register() {
  powerMonitor.on('suspend', () => {
    logInfo('系统即将挂起');
  });

  powerMonitor.on('resume', () => {
    logInfo('系统恢复运行，触发 HID 重连刷新');
    void batteryRuntime.get()?.refreshNow({ forceReopen: true, scanDevices: true });
  });
}

module.exports = {
  register,
};
