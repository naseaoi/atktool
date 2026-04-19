const { GENERIC_DEVICE_NAME_PATTERN } = require('../core/constants');

// 设备名字符串纯函数:归一化、通用名识别。无副作用、无外部依赖。

function normalizeDeviceName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function getDeviceProductName(device) {
  return normalizeDeviceName(device?.productName || device?.name);
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

module.exports = {
  normalizeDeviceName,
  getDeviceProductName,
  isGenericDeviceName,
};
