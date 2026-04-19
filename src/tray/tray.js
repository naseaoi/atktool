const { app, Menu, Tray } = require('electron');
const { logError } = require('../utils/logger');
const settingsStore = require('../core/settings-store');
const overlayState = require('../core/overlay-state');
const { togglePinState } = require('../core/device-actions');
const { loadTrayIconFromFile } = require('./tray-icon-renderer');
const { isWindowVisible } = require('../utils/window-helpers');
const overlayWindow = require('../windows/overlay-window');
const managerWindow = require('../windows/manager-window');
const loginItem = require('../system/login-item');
const runtimeDiagnostics = require('../system/runtime-diagnostics');

// 系统托盘入口:图标 + 右键菜单 + 左键切换悬浮窗。
// 菜单内容由 overlayState/settings 组合而成,订阅变更事件自动刷新。

let tray = null;

function buildMenuTemplate() {
  const state = overlayState.get();
  const settings = settingsStore.get();
  const overlayVisible = isWindowVisible(overlayWindow.get());

  return [
    {
      label: overlayVisible ? '隐藏悬浮窗' : '显示悬浮窗',
      click: () => overlayWindow.toggle(),
    },
    {
      label: '打开设备管理',
      click: () => managerWindow.show(),
    },
    { type: 'separator' },
    {
      label: '刷新直连状态',
      click: () => managerWindow.refresh(),
    },
    { type: 'separator' },
    {
      label: state.status === 'connected' ? '连接状态：已连接' : `连接状态：${overlayState.getStatusLabel(state.status)}`,
      enabled: false,
    },
    {
      label: state.batteryPercent !== null
        ? `当前电量：${state.batteryPercent}%${state.charging ? '（充电中）' : ''}`
        : '当前电量：--',
      enabled: false,
    },
    {
      label: `设备：${state.deviceName || '尚未识别到设备'}`,
      enabled: false,
    },
    {
      label: `协议：${state.protocolName || '尚未建立稳定直连'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '保持置顶',
      type: 'checkbox',
      checked: Boolean(settings.alwaysOnTop),
      click: () => togglePinState(),
    },
    {
      label: '简略悬浮窗',
      type: 'checkbox',
      checked: overlayState.getOverlayVariant() === 'compact',
      click: (menuItem) => {
        void overlayWindow.applyVariant(menuItem.checked ? 'compact' : 'full');
      },
    },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: Boolean(settings.openAtLogin),
      click: (menuItem) => {
        loginItem.setOpenAtLogin(menuItem.checked);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        runtimeDiagnostics.markQuitting();
        app.quit();
      },
    },
  ];
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const state = overlayState.get();
  const contextMenu = Menu.buildFromTemplate(buildMenuTemplate());

  try {
    tray.setContextMenu(contextMenu);
    tray.setImage(loadTrayIconFromFile(state.batteryPercent, state.charging));
    tray.setToolTip(
      state.batteryPercent !== null
        ? `ATK 电量 ${state.batteryPercent}%${state.charging ? '（充电中）' : ''}`
        : 'ATK 电量悬浮窗'
    );
  } catch (error) {
    logError('托盘菜单刷新失败', {
      status: state.status,
      batteryPercent: state.batteryPercent,
      charging: state.charging,
      error,
    });
  }
}

function create() {
  try {
    tray = new Tray(loadTrayIconFromFile());
    tray.on('click', () => overlayWindow.toggle());
    updateTrayMenu();
  } catch (error) {
    logError('创建托盘失败', error);
    throw error;
  }
}

function init() {
  // 电量/状态变 → 图标+菜单跟着变;settings 变 → 勾选项跟着变;窗口显隐变 → "显示/隐藏悬浮窗"标签跟着变。
  overlayState.on('changed', updateTrayMenu);
  settingsStore.on('changed', updateTrayMenu);
  overlayWindow.on('visibility-changed', updateTrayMenu);
  managerWindow.on('visibility-changed', updateTrayMenu);
}

module.exports = {
  init,
  create,
  updateTrayMenu,
};
