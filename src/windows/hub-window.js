const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BrowserWindow, session } = require('electron');
const overlayState = require('../core/overlay-state');
const overlaySource = require('../core/overlay-source');
const windowIcons = require('./window-icons');
const { HUB_URL, HUB_SESSION_PARTITION } = require('../core/constants');
const { logWarn } = require('../utils/logger');
const { logMemorySnapshot } = require('../utils/memory-log');

// 官网同步窗口:直连失败时由用户显式打开,加载 hub.atk.pro 作为备用数据来源。
// 窗口可见性由 overlaySource 单向驱动:source 切回 manager 时自动销毁。

const emitter = new EventEmitter();
let fallbackHubWindow = null;

function get() {
  return fallbackHubWindow;
}

function create() {
  if (fallbackHubWindow && !fallbackHubWindow.isDestroyed()) {
    return fallbackHubWindow;
  }

  fallbackHubWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#081219',
    title: 'ATK HUB 同步官网电量',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'hub-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: HUB_SESSION_PARTITION,
    },
  });

  fallbackHubWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  fallbackHubWindow.loadURL(HUB_URL);
  windowIcons.applyTo(fallbackHubWindow, '官网同步窗口');

  fallbackHubWindow.webContents.on('did-start-loading', () => {
    if (overlaySource.get() !== 'hub') {
      return;
    }

    overlayState.merge({
      status: 'loading',
      message: '同步官网电量页加载中...',
      needsUserAction: true,
      mode: 'fallback',
    });
  });

  fallbackHubWindow.webContents.on('did-finish-load', () => {
    if (overlaySource.get() !== 'hub') {
      return;
    }

    overlayState.merge({
      status: 'waiting',
      message: '同步官网电量页已打开，如直连失败可在这里手动连接。',
      needsUserAction: true,
      mode: 'fallback',
    });
  });

  fallbackHubWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (overlaySource.get() !== 'hub') {
      return;
    }

    overlayState.merge({
      status: 'error',
      message: `同步官网电量页加载失败：${errorDescription} (${errorCode})`,
      needsUserAction: true,
      mode: 'fallback',
    });
  });

  fallbackHubWindow.on('closed', () => {
    fallbackHubWindow = null;
    emitter.emit('visibility-changed', false);
    logMemorySnapshot('fallback-window-closed');

    // 窗口销毁后主动清理 Hub partition 的 HTTP 缓存,把 hub.atk.pro 在磁盘/内存中占用的
    // Chromium 缓存(约 80-150MB)释放回系统。cookie/localStorage 仍保留在 persist 分区里,
    // 用户下次打开无需重登。
    try {
      void session.fromPartition(HUB_SESSION_PARTITION).clearCache().catch((error) => {
        logWarn('同步官网电量窗口缓存清理失败', error);
      });
    } catch (error) {
      logWarn('同步官网电量窗口缓存清理调度失败', error);
    }
  });

  return fallbackHubWindow;
}

function show() {
  overlaySource.set('hub');
  const hubWindow = create();
  hubWindow.show();
  hubWindow.focus();
  emitter.emit('visibility-changed', true);
  logMemorySnapshot('fallback-window-opened');
}

function hide() {
  if (!fallbackHubWindow || fallbackHubWindow.isDestroyed()) {
    return;
  }
  fallbackHubWindow.close();
}

function toggle() {
  if (fallbackHubWindow && !fallbackHubWindow.isDestroyed() && fallbackHubWindow.isVisible()) {
    hide();
    return;
  }
  show();
}

function on(event, listener) {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

function init() {
  // overlaySource 切回 manager 时主动关掉 hub 窗口,释放渲染进程 + 网页缓存。
  overlaySource.on('changed', (source) => {
    if (source !== 'hub' && fallbackHubWindow && !fallbackHubWindow.isDestroyed()) {
      fallbackHubWindow.destroy();
      fallbackHubWindow = null;
    }
  });

  overlayState.on('changed', (state) => {
    if (!fallbackHubWindow || fallbackHubWindow.isDestroyed()) {
      return;
    }
    windowIcons.applyTo(fallbackHubWindow, '官网同步窗口');
    if (state.batteryPercent !== null && fallbackHubWindow.isVisible()) {
      fallbackHubWindow.setTitle(`${state.deviceName || 'ATK 设备'} ${state.batteryPercent}%`);
    }
  });
}

module.exports = {
  init,
  get,
  show,
  hide,
  toggle,
  create,
  on,
};
