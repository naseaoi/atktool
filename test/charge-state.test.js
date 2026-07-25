const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChargeState } = require('../src/hid/native-hid');

test('100 percent without a charging flag remains idle', () => {
  assert.deepEqual(normalizeChargeState(100, 0), {
    batteryPercent: 100,
    charging: false,
    chargeStatus: 'idle',
  });
});

test('an explicit full flag reports charging completion', () => {
  assert.deepEqual(normalizeChargeState(99, 2), {
    batteryPercent: 100,
    charging: false,
    chargeStatus: 'full',
  });
});
