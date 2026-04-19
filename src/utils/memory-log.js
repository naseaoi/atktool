const { app } = require('electron');
const { logInfo, logWarn } = require('./logger');

function formatMemoryMegabytes(valueInKilobytes = 0) {
  return `${(valueInKilobytes / 1024).toFixed(1)}MB`;
}

function logMemorySnapshot(label) {
  if (!app.isReady()) {
    return;
  }

  try {
    const metrics = app.getAppMetrics()
      .map((metric) => {
        const memory = metric.memory || {};
        return `${metric.type}:${metric.pid}:${formatMemoryMegabytes(memory.workingSetSize)}`;
      })
      .join(', ');

    logInfo(`[memory] ${label} => ${metrics}`);
  } catch (error) {
    logWarn(`[memory] ${label} => ${error.message}`, error);
  }
}

module.exports = {
  formatMemoryMegabytes,
  logMemorySnapshot,
};
