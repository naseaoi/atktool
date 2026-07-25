const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeRefreshOptions, getRetryDelayMs } = require('../src/hid/refresh-options');

test('mergeRefreshOptions preserves the strongest pending request', () => {
  assert.deepEqual(
    mergeRefreshOptions({ forceReopen: true, scanDevices: false }, { scanDevices: true }),
    { forceReopen: true, scanDevices: true }
  );
});

test('retry delay backs off with separate foreground and background caps', () => {
  assert.equal(getRetryDelayMs(1, true), 5_000);
  assert.equal(getRetryDelayMs(2, true), 10_000);
  assert.equal(getRetryDelayMs(4, true), 30_000);
  assert.equal(getRetryDelayMs(4, false), 40_000);
  assert.equal(getRetryDelayMs(8, false), 120_000);
});
