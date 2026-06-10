const { app, BrowserWindow } = require('electron');
const batteryRuntime = require('../core/battery-runtime');
const hidSelection = require('../device/hid-selection');
const { logInfo, logWarn } = require('../utils/logger');

const WM_DEVICECHANGE = 0x0219;
const DEVICE_REFRESH_DELAY_MS = 180;
const DEVICE_REFRESH_MIN_GAP_MS = 1200;

let messageWindow = null;
let refreshTimer = null;
let refreshRunning = false;
let refreshQueued = false;
let lastRefreshAt = 0;
let registered = false;

function clearRefreshTimer() {
  if (!refreshTimer) {
    return;
  }

  clearTimeout(refreshTimer);
  refreshTimer = null;
}

function getRuntimeRefresh(runtime) {
  if (!runtime || runtime.runtimeSuspended) {
    return null;
  }

  if (typeof runtime.refreshAfterDeviceChange === 'function') {
    return () => runtime.refreshAfterDeviceChange();
  }

  if (typeof runtime.refreshNow === 'function') {
    return () => runtime.refreshNow({ forceReopen: true, scanDevices: true });
  }

  return null;
}

async function runRefresh() {
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }

  refreshRunning = true;

  try {
    do {
      refreshQueued = false;
      lastRefreshAt = Date.now();

      const runtime = batteryRuntime.get();

      if (hidSelection.isActive() && runtime && typeof runtime.listChooserDevices === 'function') {
        const devices = await runtime.listChooserDevices();
        hidSelection.set(devices);
      }

      const refresh = getRuntimeRefresh(runtime);
      if (refresh) {
        await refresh();
      }
    } while (refreshQueued);
  } catch (error) {
    logWarn('Windows 设备变化刷新失败', error);
  } finally {
    refreshRunning = false;
  }
}

function scheduleRefresh() {
  const elapsedMs = Date.now() - lastRefreshAt;
  const delayMs = Math.max(DEVICE_REFRESH_DELAY_MS, DEVICE_REFRESH_MIN_GAP_MS - elapsedMs);

  clearRefreshTimer();
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void runRefresh();
  }, delayMs);
  refreshTimer.unref?.();
}

function register() {
  if (registered || process.platform !== 'win32') {
    return;
  }

  registered = true;
  messageWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  messageWindow.hookWindowMessage(WM_DEVICECHANGE, scheduleRefresh);
  messageWindow.on('closed', () => {
    messageWindow = null;
  });
  app.on('before-quit', dispose);

  logInfo('Windows 设备变化监听已启用');
}

function dispose() {
  clearRefreshTimer();
  registered = false;

  if (messageWindow && !messageWindow.isDestroyed()) {
    messageWindow.close();
  }

  messageWindow = null;
}

module.exports = {
  register,
  dispose,
};
