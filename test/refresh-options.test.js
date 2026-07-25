const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeRefreshOptions } = require('../src/hid/refresh-options');

test('mergeRefreshOptions preserves the strongest pending request', () => {
  assert.deepEqual(
    mergeRefreshOptions({ forceReopen: true, scanDevices: false }, { scanDevices: true }),
    { forceReopen: true, scanDevices: true }
  );
});
