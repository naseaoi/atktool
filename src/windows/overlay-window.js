const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BrowserWindow } = require('electron');
const settingsStore = require('../core/settings-store');
const overlayState = require('../core/overlay-state');
const batteryRuntime = require('../core/battery-runtime');
const { sendToWindow } = require('../utils/window-helpers');
const { logMemorySnapshot } = require('../utils/memory-log');

// 悬浮窗生命周期 + 尺寸/位置/置顶同步。对外只暴露 show/hide/toggle/applyVariant 等动作。
// 状态推送通过订阅 overlayState/settings 自动完成,无需外部调用。

const emitter = new EventEmitter();
let overlayWindow = null;

function get() {
  return overlayWindow;
}

function isVisible() {
  return Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
}

function persistOverlayVisibility(visible) {
  // 悬浮窗开/关状态跟随用户操作落盘,重启/升级后仍按最后一次选择恢复。
  const nextValue = Boolean(visible);
  if (Boolean(settingsStore.get().overlayVisible) === nextValue) {
    return;
  }
  settingsStore.update({ overlayVisible: nextValue });
}

function persistOverlayBounds(bounds) {
  if (!bounds) {
    return;
  }

  // 两种形态共用同一套锚点,保证移动完整版后切到简略版仍停在同一位置。
  settingsStore.update({
    overlayBounds: { x: bounds.x, y: bounds.y },
    compactOverlayBounds: { x: bounds.x, y: bounds.y },
  });
}

function fitHeight(contentHeight) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !Number.isFinite(contentHeight)) {
    return;
  }

  if (overlayWindow.isMaximized() || overlayWindow.isFullScreen() || overlayState.getOverlayVariant() !== 'full') {
    return;
  }

  const metrics = overlayState.getOverlayMetrics('full');
  const targetHeight = Math.max(340, Math.ceil(contentHeight));
  const currentBounds = overlayWindow.getContentBounds();

  if (Math.abs(currentBounds.height - targetHeight) <= 2) {
    return;
  }

  // 完整版高度由渲染层回传的真实内容高度驱动,避免底部操作区被压缩。
  overlayWindow.setMinimumSize(metrics.width, targetHeight);
  overlayWindow.setMaximumSize(metrics.width, targetHeight);
  overlayWindow.setContentSize(metrics.width, targetHeight);
}

function create() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  const settings = settingsStore.get();
  const overlayVariant = overlayState.getOverlayVariant();
  const metrics = overlayState.getOverlayMetrics(overlayVariant);
  const storedBounds = overlayState.getStoredOverlayBounds(overlayVariant);

  overlayWindow = new BrowserWindow({
    width: metrics.width,
    height: metrics.height,
    minWidth: metrics.width,
    minHeight: metrics.height,
    maxWidth: metrics.width,
    maxHeight: metrics.height,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    movable: true,
    roundedCorners: true,
    ...(storedBounds ? { x: storedBounds.x, y: storedBounds.y } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
    overlayState.merge({ message: '正在准备 HID 直连采集...' });
    batteryRuntime.get()?.setOverlayVisible(true);
    emitter.emit('visibility-changed', true);
    logMemorySnapshot('overlay-window-ready');
  });

  overlayWindow.on('move', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }
    persistOverlayBounds(overlayWindow.getBounds());
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    batteryRuntime.get()?.setOverlayVisible(false);
    emitter.emit('visibility-changed', false);
    logMemorySnapshot('overlay-window-closed');
  });

  return overlayWindow;
}

function show() {
  persistOverlayVisibility(true);

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    create();
    return;
  }

  overlayWindow.show();
  overlayWindow.focus();
  batteryRuntime.get()?.setOverlayVisible(true);
  emitter.emit('visibility-changed', true);
}

function hide() {
  persistOverlayVisibility(false);

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  overlayWindow.close();
}

function toggle() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    show();
    return;
  }

  if (overlayWindow.isVisible()) {
    hide();
    return;
  }

  show();
}

function applyVariantImmediately(overlayVariant) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const metrics = overlayState.getOverlayMetrics(overlayVariant);
  const nextBounds = overlayState.getStoredOverlayBounds(overlayVariant);

  overlayWindow.setMinimumSize(metrics.width, metrics.height);
  overlayWindow.setMaximumSize(metrics.width, metrics.height);
  overlayWindow.setSize(metrics.width, metrics.height);

  if (nextBounds) {
    overlayWindow.setPosition(nextBounds.x, nextBounds.y);
  }
}

async function applyVariant(nextVariant) {
  const overlayVariant = overlayState.normalizeOverlayVariant(nextVariant);
  const currentBounds = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : null;
  const storedBounds = overlayState.getStoredOverlayBounds(overlayVariant);
  const fallbackBounds = currentBounds
    ? { x: currentBounds.x, y: currentBounds.y }
    : null;
  const nextBounds = storedBounds || fallbackBounds;

  const patch = { overlayVariant };

  if (nextBounds && !storedBounds) {
    patch[overlayState.getOverlayBoundsKey(overlayVariant)] = nextBounds;
  }

  // 直接切换尺寸和布局,避免隐藏/重显带来的过渡动画。
  settingsStore.update(patch);
  applyVariantImmediately(overlayVariant);

  return overlayState.buildManagerPreferences();
}

function on(event, listener) {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

function init() {
  // 悬浮窗状态变化 → 推送给渲染进程,由 overlay.js 更新 UI。
  overlayState.on('changed', (state) => {
    sendToWindow(overlayWindow, 'overlay:state-changed', state, '悬浮窗状态同步');
  });

  // 置顶开关落盘后立即同步到窗口,避免 settings 与窗口状态漂移。
  settingsStore.on('changed', ({ patch }) => {
    if (
      Object.prototype.hasOwnProperty.call(patch, 'alwaysOnTop') &&
      overlayWindow &&
      !overlayWindow.isDestroyed()
    ) {
      overlayWindow.setAlwaysOnTop(Boolean(settingsStore.get().alwaysOnTop), 'screen-saver');
    }
  });
}

module.exports = {
  init,
  get,
  isVisible,
  show,
  hide,
  toggle,
  create,
  applyVariant,
  fitHeight,
  on,
};
