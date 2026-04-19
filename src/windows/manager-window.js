const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BrowserWindow } = require('electron');
const settingsStore = require('../core/settings-store');
const overlayState = require('../core/overlay-state');
const overlaySource = require('../core/overlay-source');
const batteryRuntime = require('../core/battery-runtime');
const hidSelection = require('../device/hid-selection');
const windowIcons = require('./window-icons');
const { sendToWindow } = require('../utils/window-helpers');
const { logMemorySnapshot } = require('../utils/memory-log');
const { MANAGER_MIN_HEIGHT } = require('../core/constants');

// 设备管理窗口。首次显示前会等待渲染内容布局完成,避免白屏。
// 状态/偏好/HID 选择器列表通过订阅自动推送,不再需要外部显式 notify。

const emitter = new EventEmitter();
let managerWindow = null;
let pendingInitialShow = false;
let isReady = false;
let showTimer = null;

function get() {
  return managerWindow;
}

function clearShowTimer() {
  if (!showTimer) {
    return;
  }
  clearTimeout(showTimer);
  showTimer = null;
}

function flushInitialShow() {
  if (!managerWindow || managerWindow.isDestroyed() || !pendingInitialShow || !isReady) {
    return;
  }

  pendingInitialShow = false;
  clearShowTimer();
  managerWindow.show();
  managerWindow.focus();
  emitter.emit('visibility-changed', true);
  logMemorySnapshot('manager-window-opened');
}

function scheduleInitialShow(delay = 96) {
  if (!managerWindow || managerWindow.isDestroyed() || !pendingInitialShow || !isReady) {
    return;
  }

  clearShowTimer();
  showTimer = setTimeout(flushInitialShow, delay);
  showTimer.unref?.();
}

function fitHeight(contentHeight) {
  if (!managerWindow || managerWindow.isDestroyed() || !Number.isFinite(contentHeight)) {
    return;
  }

  if (managerWindow.isMaximized() || managerWindow.isFullScreen()) {
    return;
  }

  const targetHeight = Math.max(MANAGER_MIN_HEIGHT, Math.ceil(contentHeight));
  const currentBounds = managerWindow.getContentBounds();

  if (Math.abs(currentBounds.height - targetHeight) <= 2) {
    scheduleInitialShow();
    return;
  }

  managerWindow.setContentSize(currentBounds.width, targetHeight);
  scheduleInitialShow(120);
}

function create() {
  pendingInitialShow = true;
  isReady = false;
  clearShowTimer();

  managerWindow = new BrowserWindow({
    width: 880,
    height: 720,
    show: false,
    useContentSize: true,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#081219',
    title: 'ATK 设备管理',
    minWidth: 820,
    minHeight: MANAGER_MIN_HEIGHT,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'manager-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  managerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'manager.html'));

  managerWindow.once('ready-to-show', () => {
    if (!managerWindow || managerWindow.isDestroyed()) {
      return;
    }

    isReady = true;
    scheduleInitialShow(180);
  });

  managerWindow.webContents.on('did-finish-load', () => {
    windowIcons.applyTo(managerWindow, '设备管理窗口');
    sendToWindow(managerWindow, 'manager:preferences', overlayState.buildManagerPreferences(), '设备管理偏好同步');
    sendToWindow(managerWindow, 'manager:overlay-state', overlayState.get(), '设备管理状态同步');
    sendToWindow(managerWindow, 'manager:hid-selection', hidSelection.getPayload(), '设备管理 HID 选择同步');
  });

  managerWindow.on('close', () => {
    hidSelection.cancel();
  });

  managerWindow.on('closed', () => {
    clearShowTimer();
    isReady = false;
    pendingInitialShow = false;
    managerWindow = null;
    emitter.emit('visibility-changed', false);
    logMemorySnapshot('manager-window-closed');
  });

  return managerWindow;
}

function show() {
  if (!managerWindow || managerWindow.isDestroyed()) {
    create();
    return;
  }

  managerWindow.show();
  managerWindow.focus();
  sendToWindow(managerWindow, 'manager:preferences', overlayState.buildManagerPreferences(), '设备管理偏好同步');
  sendToWindow(managerWindow, 'manager:hid-selection', hidSelection.getPayload(), '设备管理 HID 选择同步');
  sendToWindow(managerWindow, 'manager:overlay-state', overlayState.get(), '设备管理状态同步');
  emitter.emit('visibility-changed', true);
}

function hide() {
  if (!managerWindow || managerWindow.isDestroyed()) {
    return;
  }

  hidSelection.cancel();
  managerWindow.close();
}

function toggle() {
  if (!managerWindow || managerWindow.isDestroyed()) {
    return;
  }

  if (managerWindow.isVisible()) {
    hide();
    return;
  }

  show();
}

function refresh() {
  overlaySource.set('manager');
  overlayState.merge({
    status: 'loading',
    message: '正在刷新 HID 直连状态...',
    needsUserAction: false,
    sampledAt: new Date().toISOString(),
    mode: 'stable',
  });

  void batteryRuntime.get()?.refreshNow({ forceReopen: true });
}

function on(event, listener) {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

function init() {
  overlayState.on('changed', () => {
    windowIcons.applyTo(managerWindow, '设备管理窗口');
    sendToWindow(managerWindow, 'manager:overlay-state', overlayState.get(), '设备管理状态同步');
  });

  // settings 变更意味着 preferences(displayDeviceName/alwaysOnTop/openAtLogin/variant) 可能变,都推一遍。
  settingsStore.on('changed', () => {
    sendToWindow(managerWindow, 'manager:preferences', overlayState.buildManagerPreferences(), '设备管理偏好同步');
  });

  // device-binding.rememberDisplayDeviceName 走的是 settings.update,已经会被上面捕获,
  // 但 overlayState 里还会再发一次 preferences-changed,兜底确保同步。
  overlayState.on('preferences-changed', () => {
    sendToWindow(managerWindow, 'manager:preferences', overlayState.buildManagerPreferences(), '设备管理偏好同步');
  });

  hidSelection.on('changed', (payload) => {
    sendToWindow(managerWindow, 'manager:hid-selection', payload, '设备管理 HID 选择同步');
  });
}

module.exports = {
  init,
  get,
  show,
  hide,
  toggle,
  create,
  refresh,
  fitHeight,
  on,
};
