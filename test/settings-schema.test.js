const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getDefaultSettings,
  normalizeBounds,
  normalizeSettings,
} = require('../src/core/settings-schema');

test('normalizeSettings keeps only valid settings', () => {
  const settings = normalizeSettings({
    overlayBounds: { x: 10.4, y: -20.6 },
    compactOverlayBounds: { x: Infinity, y: 1 },
    preferredHidDevice: {
      vendorId: 0x3554,
      productId: 0xf58a,
      productName: ' ATK X1 ',
      collectionSignature: '1/2/3',
    },
    alwaysOnTop: 'false',
    openAtLogin: true,
    overlayVariant: 'compact',
    overlayVisible: false,
    unknown: 'discarded',
  });

  assert.deepEqual(settings.overlayBounds, { x: 10, y: -21 });
  assert.equal(settings.compactOverlayBounds, null);
  assert.equal(settings.preferredHidDevice.productName, 'ATK X1');
  assert.equal(settings.alwaysOnTop, true);
  assert.equal(settings.openAtLogin, true);
  assert.equal(settings.overlayVariant, 'compact');
  assert.equal(settings.overlayVisible, false);
  assert.equal(Object.hasOwn(settings, 'unknown'), false);
});

test('normalizeSettings returns independent defaults for invalid input', () => {
  assert.deepEqual(normalizeSettings(null), getDefaultSettings());
  assert.equal(normalizeBounds({ x: 1000001, y: 0 }), null);
});
