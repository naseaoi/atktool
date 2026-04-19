const settingsStore = require('../core/settings-store');
const {
  normalizeDeviceName,
  getDeviceProductName,
} = require('./device-name');
const {
  normalizeDeviceBinding,
  getDeviceBindingMatchLevel,
} = require('./device-binding');

// 针对枚举到的 HID 设备打分 + 排序,让"最可能是 ATK 鼠标"的设备排在前面。
// 评分规则是经验值:品牌关键词 > 鼠标 usage > 键盘 usage(负分) + 已绑定设备强加分。

function getDeviceMatchScore(device) {
  const preferred = settingsStore.get().preferredHidDevice;
  const productName = getDeviceProductName(device);
  const collections = Array.isArray(device.collections) ? device.collections : [];
  const hasMouseCollection = collections.some((collection) => collection.usage === 2);
  const hasKeyboardCollection = collections.some((collection) => collection.usage === 6);
  let score = 0;

  if (/ATK|VXE/i.test(productName)) {
    score += 30;
  }

  if (/mouse|鼠标|F1|X1|R1/i.test(productName)) {
    score += 18;
  }

  if (hasMouseCollection) {
    score += 18;
  }

  if (hasKeyboardCollection) {
    score -= 12;
  }

  if (
    preferred &&
    preferred.vendorId === device.vendorId &&
    preferred.productId === device.productId &&
    preferred.productName === productName
  ) {
    score += 100;
  }

  return score;
}

function chooseHidDevice(deviceList) {
  if (!Array.isArray(deviceList) || deviceList.length === 0) {
    return null;
  }

  return [...deviceList]
    .map((device) => ({ device, score: getDeviceMatchScore(device) }))
    .sort((left, right) => right.score - left.score)[0]?.device || null;
}

function serializeHidChooserDevice(device) {
  const binding = normalizeDeviceBinding(device);

  if (!binding || !device?.deviceId) {
    return null;
  }

  return {
    deviceId: device.deviceId,
    vendorId: binding.vendorId,
    productId: binding.productId,
    productName: binding.productName,
    serialNumber: normalizeDeviceName(device.serialNumber),
    guid: normalizeDeviceName(device.guid),
    collections: Array.isArray(device.collections) ? device.collections : [],
    collectionSignature: binding.collectionSignature,
    score: getDeviceMatchScore(device),
    matchLevel: getDeviceBindingMatchLevel(binding, settingsStore.get().preferredHidDevice),
  };
}

function buildHidChooserDeviceList(deviceMap) {
  return Array.from(deviceMap.values())
    .map((device) => serializeHidChooserDevice(device))
    .filter(Boolean)
    .sort((left, right) => {
      if (right.matchLevel !== left.matchLevel) {
        return right.matchLevel - left.matchLevel;
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.productName.localeCompare(right.productName, 'zh-CN');
    });
}

module.exports = {
  getDeviceMatchScore,
  chooseHidDevice,
  serializeHidChooserDevice,
  buildHidChooserDeviceList,
};
