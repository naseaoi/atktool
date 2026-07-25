const HUB_STATUS_VALUES = new Set(['loading', 'waiting', 'connected', 'error']);
const CHARGE_STATUS_VALUES = new Set(['idle', 'charging', 'full']);

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

function normalizeBatteryPercent(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }

  return Math.round(value);
}

function normalizeSampledAt(value, fallbackDate) {
  if (typeof value === 'string' && value.length <= 64) {
    const sampledAt = new Date(value);
    if (!Number.isNaN(sampledAt.getTime())) {
      return sampledAt.toISOString();
    }
  }

  return fallbackDate.toISOString();
}

function sanitizeHubState(value, fallbackDate = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const batteryPercent = normalizeBatteryPercent(value.batteryPercent);
  let status = HUB_STATUS_VALUES.has(value.status) ? value.status : 'waiting';
  let chargeStatus = CHARGE_STATUS_VALUES.has(value.chargeStatus) ? value.chargeStatus : 'idle';

  if (status === 'connected' && batteryPercent === null) {
    status = 'waiting';
  }

  if (chargeStatus === 'full' && batteryPercent !== 100) {
    chargeStatus = 'idle';
  }

  const message = normalizeText(value.message, 240);

  return {
    status,
    message: message || (status === 'connected' ? '同步官网电量工作中。' : '等待官网设备信息出现。'),
    batteryPercent,
    batteryText: batteryPercent === null ? '--' : `${batteryPercent}%`,
    deviceName: normalizeText(value.deviceName, 80),
    charging: chargeStatus === 'charging',
    chargeStatus,
    needsUserAction: status !== 'connected',
    sampledAt: normalizeSampledAt(value.sampledAt, fallbackDate),
  };
}

module.exports = {
  normalizeText,
  normalizeBatteryPercent,
  sanitizeHubState,
};
