const { EventEmitter } = require('node:events');
const settingsStore = require('./settings-store');
const { OVERLAY_VARIANTS } = require('./constants');
const {
  resolveOverlayDeviceName,
  rememberDisplayDeviceName,
  hasRememberedDeviceBinding,
  getBoundDisplayDeviceName,
} = require('../device/device-binding');

// 主进程统一维护悬浮窗状态,避免托盘/管理页/同步官网电量页彼此漂移。
// 通过 EventEmitter 广播变更,订阅者无需感知彼此。

const emitter = new EventEmitter();
emitter.setMaxListeners(32);

function normalizeOverlayVariant(value) {
  return value === 'compact' ? 'compact' : 'full';
}

function getOverlayVariant() {
  return normalizeOverlayVariant(settingsStore.get().overlayVariant);
}

function getOverlayMetrics(variant = getOverlayVariant()) {
  return OVERLAY_VARIANTS[normalizeOverlayVariant(variant)] || OVERLAY_VARIANTS.full;
}

function getOverlayBoundsKey(variant = getOverlayVariant()) {
  return normalizeOverlayVariant(variant) === 'compact' ? 'compactOverlayBounds' : 'overlayBounds';
}

function getStoredOverlayBounds(variant = getOverlayVariant()) {
  return settingsStore.get()[getOverlayBoundsKey(variant)] || null;
}

let state = {
  status: 'loading',
  message: '正在启动悬浮窗...',
  batteryPercent: null,
  batteryText: '--',
  deviceName: '',
  charging: false,
  needsUserAction: true,
  sampledAt: null,
  protocolName: '',
  mode: 'stable',
  alwaysOnTop: settingsStore.get().alwaysOnTop,
  overlayVariant: getOverlayVariant(),
  grantedDevicesCount: 0,
};

function getOverlayMessage(nextState) {
  if (nextState.mode === 'fallback') {
    if (nextState.status === 'connected') {
      return '同步官网电量已接管电量读取。';
    }

    if (nextState.status === 'waiting') {
      return '同步官网电量页已打开，等待设备信息出现。';
    }

    return '同步官网电量页可继续完成连接。';
  }

  if (nextState.status === 'connected') {
    return nextState.batteryPercent === null ? '本地直连已建立。' : '本地直连工作中。';
  }

  if (nextState.status === 'unsupported') {
    return nextState.batteryPercent === null ? '直连适配中，可打开设备管理继续处理。' : '本地直连工作中。';
  }

  if (nextState.status === 'waiting') {
    return hasRememberedDeviceBinding()
      ? '当前绑定设备待连接，可在设备管理里刷新当前设备。'
      : '请在设备管理里选择并绑定设备。';
  }

  if (nextState.status === 'error') {
    return '读取异常，请打开设备管理查看详情。';
  }

  return nextState.message || '正在准备 HID 直连采集...';
}

function getStatusLabel(status) {
  switch (status) {
    case 'connected':
      return '已连接';
    case 'unsupported':
      return '待适配';
    case 'waiting':
      return hasRememberedDeviceBinding() ? '待连接' : '待绑定';
    case 'error':
      return '异常';
    default:
      return '加载中';
  }
}

function buildManagerPreferences() {
  const settings = settingsStore.get();
  return {
    preferredHidDevice: settings.preferredHidDevice || null,
    displayDeviceName: getBoundDisplayDeviceName(),
    alwaysOnTop: settings.alwaysOnTop,
    openAtLogin: Boolean(settings.openAtLogin),
    overlayVariant: getOverlayVariant(),
  };
}

function get() {
  return state;
}

function merge(patch) {
  const nextDeviceName = resolveOverlayDeviceName(patch.deviceName ?? state.deviceName);
  const didUpdateDisplayDeviceName = rememberDisplayDeviceName(nextDeviceName);

  state = {
    ...state,
    ...patch,
    deviceName: nextDeviceName,
    alwaysOnTop: settingsStore.get().alwaysOnTop,
    overlayVariant: getOverlayVariant(),
  };
  state.message = getOverlayMessage(state);

  emitter.emit('changed', state);

  if (didUpdateDisplayDeviceName) {
    // displayDeviceName 写回 settings 会自然触发 settings:changed,
    // 但显式再发一次 preferences-changed 让 manager 端不用重复比较。
    emitter.emit('preferences-changed');
  }
}

function on(event, listener) {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

// alwaysOnTop / overlayVariant 由 settings 承载,被其他模块直接改写后需要让 overlayState 跟着同步,
// 避免托盘菜单、悬浮窗内边框状态错位。
settingsStore.on('changed', ({ patch }) => {
  if (
    Object.prototype.hasOwnProperty.call(patch, 'alwaysOnTop') ||
    Object.prototype.hasOwnProperty.call(patch, 'overlayVariant')
  ) {
    state = {
      ...state,
      alwaysOnTop: settingsStore.get().alwaysOnTop,
      overlayVariant: getOverlayVariant(),
    };
    emitter.emit('changed', state);
  }
});

module.exports = {
  get,
  merge,
  on,
  getOverlayVariant,
  getOverlayMetrics,
  getOverlayBoundsKey,
  getStoredOverlayBounds,
  normalizeOverlayVariant,
  getOverlayMessage,
  getStatusLabel,
  buildManagerPreferences,
};
