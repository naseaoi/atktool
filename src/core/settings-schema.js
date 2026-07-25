const MAX_STORED_COORDINATE = 1000000;

function getDefaultSettings() {
  return {
    overlayBounds: null,
    compactOverlayBounds: null,
    preferredHidDevice: null,
    displayDeviceName: '',
    displayDeviceNameBinding: null,
    alwaysOnTop: true,
    openAtLogin: false,
    overlayVariant: 'full',
    overlayVisible: true,
  };
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  if (
    !Number.isFinite(value.x)
    || !Number.isFinite(value.y)
    || Math.abs(value.x) > MAX_STORED_COORDINATE
    || Math.abs(value.y) > MAX_STORED_COORDINATE
  ) {
    return null;
  }

  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
  };
}

function normalizeDeviceBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  if (
    !Number.isInteger(value.vendorId)
    || !Number.isInteger(value.productId)
    || value.vendorId < 0
    || value.vendorId > 0xffff
    || value.productId < 0
    || value.productId > 0xffff
  ) {
    return null;
  }

  return {
    vendorId: value.vendorId,
    productId: value.productId,
    productName: normalizeText(value.productName, 128),
    collectionSignature: normalizeText(value.collectionSignature, 2048),
  };
}

function normalizeSettings(value = {}) {
  const defaults = getDefaultSettings();
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  return {
    overlayBounds: normalizeBounds(input.overlayBounds),
    compactOverlayBounds: normalizeBounds(input.compactOverlayBounds),
    preferredHidDevice: normalizeDeviceBinding(input.preferredHidDevice),
    displayDeviceName: normalizeText(input.displayDeviceName, 128),
    displayDeviceNameBinding: normalizeDeviceBinding(input.displayDeviceNameBinding),
    alwaysOnTop: typeof input.alwaysOnTop === 'boolean' ? input.alwaysOnTop : defaults.alwaysOnTop,
    openAtLogin: typeof input.openAtLogin === 'boolean' ? input.openAtLogin : defaults.openAtLogin,
    overlayVariant: input.overlayVariant === 'compact' ? 'compact' : defaults.overlayVariant,
    overlayVisible: typeof input.overlayVisible === 'boolean' ? input.overlayVisible : defaults.overlayVisible,
  };
}

module.exports = {
  getDefaultSettings,
  normalizeBounds,
  normalizeDeviceBinding,
  normalizeSettings,
};
