const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeHubState } = require('../src/core/hub-state');

test('sanitizeHubState accepts a valid connected snapshot', () => {
  const state = sanitizeHubState({
    status: 'connected',
    message: '设备已连接',
    batteryPercent: 67.4,
    deviceName: 'ATK X1',
    chargeStatus: 'charging',
    sampledAt: '2026-07-25T12:00:00.000Z',
  });

  assert.deepEqual(state, {
    status: 'connected',
    message: '设备已连接',
    batteryPercent: 67,
    batteryText: '67%',
    deviceName: 'ATK X1',
    charging: true,
    chargeStatus: 'charging',
    needsUserAction: false,
    sampledAt: '2026-07-25T12:00:00.000Z',
  });
});

test('sanitizeHubState rejects invalid shapes and normalizes unsafe fields', () => {
  const fallbackDate = new Date('2026-07-25T13:00:00.000Z');

  assert.equal(sanitizeHubState(null, fallbackDate), null);
  assert.equal(sanitizeHubState([], fallbackDate), null);

  const state = sanitizeHubState({
    status: 'connected',
    message: ' bad\u0000 message ',
    batteryPercent: 999,
    deviceName: ' Mouse\nName ',
    chargeStatus: 'full',
    sampledAt: 'invalid',
  }, fallbackDate);

  assert.equal(state.status, 'waiting');
  assert.equal(state.message, 'bad message');
  assert.equal(state.batteryPercent, null);
  assert.equal(state.batteryText, '--');
  assert.equal(state.deviceName, 'Mouse Name');
  assert.equal(state.chargeStatus, 'idle');
  assert.equal(state.needsUserAction, true);
  assert.equal(state.sampledAt, fallbackDate.toISOString());
});
