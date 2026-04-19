const settingsStore = require('./settings-store');
const overlayState = require('./overlay-state');
const batteryRuntime = require('./battery-runtime');
const {
  normalizeDeviceBinding,
  getDeviceBindingKey,
} = require('../device/device-binding');
const { isGenericDeviceName } = require('../device/device-name');

// 跨模块协调的"动作"聚合在这里,避免让 ipc handler 里手写多步串联。
// 这些动作通常需要同时写 settings + 通知 runtime + 调整 overlayState。

function rememberPreferredDevice(device) {
  const normalized = normalizeDeviceBinding(device);

  if (!normalized) {
    return;
  }

  batteryRuntime.get()?.setPreferredBinding(normalized);

  const settings = settingsStore.get();
  const currentKey = getDeviceBindingKey(settings.preferredHidDevice);
  const nextKey = getDeviceBindingKey(normalized);
  const currentDisplayBindingKey = getDeviceBindingKey(settings.displayDeviceNameBinding);
  const patch = {
    preferredHidDevice: normalized,
  };

  if (!isGenericDeviceName(normalized.productName)) {
    patch.displayDeviceName = normalized.productName;
    patch.displayDeviceNameBinding = normalized;
  } else if (currentKey !== nextKey || currentDisplayBindingKey !== nextKey) {
    // 换了个设备又拿不到干净名称,就把遗留的 displayName 清掉,避免把旧名套在新设备上。
    patch.displayDeviceName = '';
    patch.displayDeviceNameBinding = null;
  }

  settingsStore.update(patch);
}

function clearPreferredDeviceBinding() {
  batteryRuntime.get()?.setPreferredBinding(null);
  settingsStore.update({
    preferredHidDevice: null,
    displayDeviceName: '',
    displayDeviceNameBinding: null,
  });

  if (overlayState.get().mode !== 'fallback') {
    overlayState.merge({
      status: 'waiting',
      batteryPercent: null,
      batteryText: '--',
      deviceName: '',
      charging: false,
      needsUserAction: true,
      sampledAt: new Date().toISOString(),
      protocolName: '',
      mode: 'stable',
    });
  }
}

function togglePinState() {
  const current = settingsStore.get().alwaysOnTop;
  // settings.changed 订阅会把 alwaysOnTop 同步到 overlayState 并触发 overlay 窗口 setAlwaysOnTop。
  settingsStore.update({ alwaysOnTop: !current });
  return overlayState.get();
}

module.exports = {
  rememberPreferredDevice,
  clearPreferredDeviceBinding,
  togglePinState,
};
