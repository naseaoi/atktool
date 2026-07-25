const {
  normalizeDeviceName,
  getDeviceProductName,
} = require('./device-name');

function visitCollections(collections, visitor) {
  for (const collection of Array.isArray(collections) ? collections : []) {
    visitor(collection);
    visitCollections(collection.children, visitor);
  }
}

function buildCollectionSignature(device) {
  if (!Array.isArray(device?.collections) || device.collections.length === 0) {
    return [
      Number.isFinite(device?.interface) ? device.interface : '',
      Number.isFinite(device?.usagePage) ? device.usagePage : '',
      Number.isFinite(device?.usage) ? device.usage : '',
      Number.isFinite(device?.release) ? device.release : '',
      normalizeDeviceName(device?.serialNumber),
    ].join('/');
  }

  const signatures = [];
  visitCollections(device.collections, (collection) => {
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

module.exports = {
  buildCollectionSignature,
  normalizeDeviceBinding,
  getDeviceBindingKey,
  getLooseDeviceBindingKey,
  getDeviceBindingMatchLevel,
};
