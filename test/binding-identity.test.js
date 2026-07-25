const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCollectionSignature,
  normalizeDeviceBinding,
  getDeviceBindingMatchLevel,
} = require('../src/device/binding-identity');

test('binding identity preserves native HID signatures', () => {
  const device = {
    vendorId: 0x3554,
    productId: 0x11fe,
    product: ' Wireless mouse 8k NANO dongle-L ',
    interface: 1,
    usagePage: 65282,
    usage: 2,
    release: 769,
    serialNumber: '541505796617',
  };

  assert.equal(buildCollectionSignature(device), '1/65282/2/769/541505796617');
  assert.deepEqual(normalizeDeviceBinding(device), {
    vendorId: 0x3554,
    productId: 0x11fe,
    productName: 'Wireless mouse 8k NANO dongle-L',
    collectionSignature: '1/65282/2/769/541505796617',
  });
});

test('binding identity distinguishes exact and loose matches', () => {
  const first = {
    vendorId: 1,
    productId: 2,
    productName: 'ATK X1',
    collectionSignature: '1/2/3',
  };

  assert.equal(getDeviceBindingMatchLevel(first, { ...first }), 2);
  assert.equal(getDeviceBindingMatchLevel(first, { ...first, collectionSignature: '4/5/6' }), 1);
  assert.equal(getDeviceBindingMatchLevel(first, { ...first, productId: 3 }), 0);
});
