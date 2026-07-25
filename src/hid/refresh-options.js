const RETRY_BASE_DELAY_MS = 5 * 1000;
const RETRY_FOREGROUND_MAX_DELAY_MS = 30 * 1000;
const RETRY_BACKGROUND_MAX_DELAY_MS = 2 * 60 * 1000;

function mergeRefreshOptions(currentOptions, nextOptions = {}) {
  return {
    forceReopen: Boolean(currentOptions?.forceReopen || nextOptions.forceReopen),
    scanDevices: Boolean(currentOptions?.scanDevices || nextOptions.scanDevices),
  };
}

function getRetryDelayMs(consecutiveFailures, overlayVisible) {
  const failures = Number.isFinite(consecutiveFailures)
    ? Math.max(1, Math.floor(consecutiveFailures))
    : 1;
  const maximumDelay = overlayVisible
    ? RETRY_FOREGROUND_MAX_DELAY_MS
    : RETRY_BACKGROUND_MAX_DELAY_MS;
  const exponent = Math.min(failures - 1, 8);

  return Math.min(RETRY_BASE_DELAY_MS * (2 ** exponent), maximumDelay);
}

module.exports = {
  mergeRefreshOptions,
  getRetryDelayMs,
};
