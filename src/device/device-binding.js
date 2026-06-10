const settingsStore = require('../core/settings-store');
const {
  normalizeDeviceName,
  getDeviceProductName,
  isGenericDeviceName,
} = require('./device-name');

// HID collection 签名 + 绑定键 + 展示名记忆。
// 核心职责:把"物理设备"映射为稳定的字符串指纹,并按这个指纹记忆用户选择的展示名。

function visitCollections(collections, visitor) {
  for (const collection of Array.isArray(collections) ? collections : []) {
    visitor(collection);
    visitCollections(collection.children, visitor);
  }
}

function buildCollectionSignature(device) {
  const signatures = [];

  visitCollections(device?.collections, (collection) => {
    const inputReports = Array.isArray(collection.inputReports)
      ? collection.inputReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';
    const outputReports = Array.isArray(collection.outputReports)
      ? collection.outputReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';
    const featureReports = Array.isArray(collection.featureReports)
      ? collection.featureReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';

    signatures.push([
      collection.usagePage ?? '',
      collection.usage ?? '',
      inputReports,
      outputReports,
      featureReports,
    ].join('/'));
  });

  return signatures.sort().join('|');
}

function normalizeDeviceBinding(device) {
  if (!device || !Number.isFinite(device.vendorId) || !Number.isFinite(device.productId)) {
    return null;
  }

  return {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: getDeviceProductName(device),
    collectionSignature: normalizeDeviceName(device.collectionSignature) || buildCollectionSignature(device),
  };
}

function getDeviceBindingKey(device) {
  const normalized = normalizeDeviceBinding(device);

  if (!normalized) {
    return '';
  }

  return [normalized.vendorId, normalized.productId, normalized.productName, normalized.collectionSignature].join(':');
}

function getLooseDeviceBindingKey(device) {
  const normalized = normalizeDeviceBinding(device);

  if (!normalized) {
    return '';
  }

  return [normalized.vendorId, normalized.productId, normalized.productName].join(':');
}

// 2 = 严格匹配(包含 collection 签名);1 = 宽松匹配(仅 VID/PID/名称);0 = 不匹配。
function getDeviceBindingMatchLevel(left, right) {
  const exactLeft = getDeviceBindingKey(left);
  const exactRight = getDeviceBindingKey(right);

  if (exactLeft && exactLeft === exactRight) {
    return 2;
  }

  const looseLeft = getLooseDeviceBindingKey(left);
  const looseRight = getLooseDeviceBindingKey(right);

  if (looseLeft && looseLeft === looseRight) {
    return 1;
  }

  return 0;
}

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
  visitCollections,
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
