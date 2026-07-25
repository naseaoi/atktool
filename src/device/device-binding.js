const settingsStore = require('../core/settings-store');
const {
  normalizeDeviceName,
  isGenericDeviceName,
} = require('./device-name');
const {
  buildCollectionSignature,
  normalizeDeviceBinding,
  getDeviceBindingKey,
  getLooseDeviceBindingKey,
  getDeviceBindingMatchLevel,
} = require('./binding-identity');

function hasRememberedDeviceBinding() {
  return Boolean(normalizeDeviceBinding(settingsStore.get().preferredHidDevice));
}

function getBoundDisplayDeviceName(device = settingsStore.get().preferredHidDevice) {
  const settings = settingsStore.get();
  const savedName = normalizeDeviceName(settings.displayDeviceName);
  const binding = settings.displayDeviceNameBinding;

  if (!savedName || isGenericDeviceName(savedName)) {
    return '';
  }

  if (!binding) {
    return '';
  }

  // 展示名只复用到明确匹配的 HID 绑定。
  if (!getDeviceBindingMatchLevel(binding, device)) {
    return '';
  }

  return savedName;
}

function resolveOverlayDeviceName(name) {
  const normalized = normalizeDeviceName(name);
  const savedName = getBoundDisplayDeviceName();

  if (normalized && !isGenericDeviceName(normalized)) {
    return normalized;
  }

  if (savedName && !isGenericDeviceName(savedName)) {
    return savedName;
  }

  if (normalized) {
    return 'ATK 设备';
  }

  return savedName;
}

function rememberDisplayDeviceName(name, device = settingsStore.get().preferredHidDevice) {
  const normalized = normalizeDeviceName(name);
  const binding = normalizeDeviceBinding(device);
  const settings = settingsStore.get();
  const currentBindingKey = getDeviceBindingKey(settings.displayDeviceNameBinding);
  const nextBindingKey = getDeviceBindingKey(binding);

  if (!normalized || isGenericDeviceName(normalized) || !binding) {
    return false;
  }

  if (normalized === settings.displayDeviceName && currentBindingKey === nextBindingKey) {
    return false;
  }

  settingsStore.update({
    displayDeviceName: normalized,
    displayDeviceNameBinding: binding,
  });

  return true;
}

module.exports = {
  buildCollectionSignature,
  normalizeDeviceBinding,
  getDeviceBindingKey,
  getLooseDeviceBindingKey,
  getDeviceBindingMatchLevel,
  hasRememberedDeviceBinding,
  getBoundDisplayDeviceName,
  resolveOverlayDeviceName,
  rememberDisplayDeviceName,
};
