const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDeviceName,
  getDeviceDisplayName,
  resolveDeviceDisplayName,
} = require('../src/device/device-name');

test('device names are sanitized before display and binding', () => {
  assert.equal(normalizeDeviceName('  Wireless\nMouse\uFFFD  '), 'Wireless Mouse');
  assert.equal(normalizeDeviceName(null), '');
});

test('display name preserves raw HID names and prefers known model names', () => {
  const genericName = 'Wireless mouse 8k NANO dongle-L';

  assert.equal(resolveDeviceDisplayName(genericName), genericName);
  assert.equal(resolveDeviceDisplayName(genericName, 'ATK X1 Ultimate'), 'ATK X1 Ultimate');
  assert.equal(resolveDeviceDisplayName('VXE R1 Pro', 'ATK X1 Ultimate'), 'VXE R1 Pro');
});

test('unnamed HID interfaces have a stable hardware fallback name', () => {
  assert.equal(getDeviceDisplayName({ vendorId: 0x3554, productId: 0x11fe }), 'HID 3554:11FE');
  assert.equal(getDeviceDisplayName({ manufacturer: 'ATK', vendorId: 1, productId: 2 }), 'ATK');
});
