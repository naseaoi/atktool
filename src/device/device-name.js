const { GENERIC_DEVICE_NAME_PATTERN } = require('../core/constants');

// 设备名字符串纯函数:归一化、通用名识别。无副作用、无外部依赖。

function normalizeDeviceName(name) {
  if (typeof name !== 'string') {
    return '';
  }

  return name
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\uFFFD/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128);
}

function getDeviceProductName(device) {
  return normalizeDeviceName(device?.productName || device?.product || device?.name);
}

function formatDeviceId(value) {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(0xffff, Math.round(value))).toString(16).toUpperCase().padStart(4, '0')
    : '----';
}

function getDeviceDisplayName(device) {
  const name = getDeviceProductName(device) || normalizeDeviceName(device?.manufacturer);
  if (name) {
    return name;
  }

  if (!Number.isFinite(device?.vendorId) || !Number.isFinite(device?.productId)) {
    return '';
  }

  return `HID ${formatDeviceId(device.vendorId)}:${formatDeviceId(device.productId)}`;
}

// 判断一个名称是否"过于通用"(比如"Wireless Mouse"),没有品牌辨识度,不值得持久化为展示名。
function isGenericDeviceName(name) {
  const normalized = normalizeDeviceName(name);
  if (!normalized) {
    return true;
  }

  if (/ATK|VXE/i.test(normalized)) {
    return false;
  }

  return GENERIC_DEVICE_NAME_PATTERN.test(normalized);
}

function resolveDeviceDisplayName(reportedName, savedName = '') {
  const reported = normalizeDeviceName(reportedName);
  const saved = normalizeDeviceName(savedName);

  if (reported && !isGenericDeviceName(reported)) {
    return reported;
  }

  if (saved && !isGenericDeviceName(saved)) {
    return saved;
  }

  return reported || saved;
}

module.exports = {
  normalizeDeviceName,
  getDeviceProductName,
  getDeviceDisplayName,
  isGenericDeviceName,
  resolveDeviceDisplayName,
};
