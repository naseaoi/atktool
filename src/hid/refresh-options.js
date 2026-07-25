function mergeRefreshOptions(currentOptions, nextOptions = {}) {
  return {
    forceReopen: Boolean(currentOptions?.forceReopen || nextOptions.forceReopen),
    scanDevices: Boolean(currentOptions?.scanDevices || nextOptions.scanDevices),
  };
}

module.exports = {
  mergeRefreshOptions,
};
