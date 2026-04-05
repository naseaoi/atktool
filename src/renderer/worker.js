const shared = window.AtkHidShared;

const POLL_INTERVAL_VISIBLE_MS = 10 * 1000;
const POLL_INTERVAL_HIDDEN_DEFAULT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_HIDDEN_MEDIUM_MS = 5 * 60 * 1000;
const POLL_INTERVAL_HIDDEN_LOW_MS = 2 * 60 * 1000;
const RETRY_INTERVAL_MS = 5000;
const PROTOCOL_RESET_FAILURE_LIMIT = 3;
const COMPX_PROTOCOL_LABEL = 'COMPX 直连';
const HECHI_PROTOCOL_LABEL = 'HECHI 直连';

let state = {
  status: 'loading',
  message: '正在准备 WebHID 直连器...',
  batteryPercent: null,
  batteryText: '--',
  deviceName: '',
  charging: false,
  needsUserAction: true,
  sampledAt: null,
  protocolName: '',
  mode: 'stable',
  grantedDevicesCount: 0,
};

let preferences = {
  preferredHidDevice: null,
  displayDeviceName: '',
  overlayVariant: 'full',
  openAtLogin: false,
};
let preferredDevice = null;
let currentDevice = null;
let currentDeviceKey = '';
let currentProtocolKey = null;
let refreshNonce = 0;
let pollTimer = null;
let consecutiveReadFailures = 0;
let lastStableSnapshot = null;
let overlayVisible = false;
let runtimeSuspended = false;

function hasBoundDevice() {
  return Boolean(shared.getDeviceKey(preferredDevice));
}

function resolveDisplayDeviceName(name) {
  const normalized = shared.normalizeDeviceName(name);
  const savedName = shared.normalizeDeviceName(preferences.displayDeviceName);
  const boundName = shared.normalizeDeviceName(preferredDevice?.productName);

  if (normalized && !shared.isGenericDeviceName(normalized)) {
    return normalized;
  }

  if (boundName && !shared.isGenericDeviceName(boundName)) {
    return boundName;
  }

  if (savedName && !shared.isGenericDeviceName(savedName)) {
    return savedName;
  }

  if (normalized) {
    return 'ATK 设备';
  }

  return '';
}

function applyPreferences(patch) {
  const hasPreferredDevicePatch = Object.prototype.hasOwnProperty.call(patch, 'preferredHidDevice');
  const previousPreferredKey = shared.getDeviceKey(preferredDevice);

  preferences = {
    ...preferences,
    ...patch,
    displayDeviceName: shared.normalizeDeviceName(patch.displayDeviceName ?? preferences.displayDeviceName),
    overlayVariant: (patch.overlayVariant ?? preferences.overlayVariant) === 'compact' ? 'compact' : 'full',
    openAtLogin: Boolean(patch.openAtLogin ?? preferences.openAtLogin),
  };

  if (hasPreferredDevicePatch) {
    preferredDevice = patch.preferredHidDevice || null;
  }

  const nextPreferredKey = shared.getDeviceKey(preferredDevice);
  if (hasPreferredDevicePatch && previousPreferredKey && previousPreferredKey !== nextPreferredKey && currentDeviceKey !== nextPreferredKey) {
    resetCurrentDeviceState();
  }

  if (hasPreferredDevicePatch && !nextPreferredKey && state.mode !== 'fallback') {
    resetCurrentDeviceState({ clearPreferred: true });
    showWaitingForBinding('还没有绑定设备。请先在设备管理里选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
  }
}

function applyState(patch) {
  state = {
    ...state,
    ...patch,
  };

  window.atkWorker.updateState({
    status: state.status,
    message: state.message,
    batteryPercent: state.batteryPercent,
    batteryText: state.batteryText,
    deviceName: resolveDisplayDeviceName(state.deviceName),
    charging: state.charging,
    needsUserAction: state.needsUserAction,
    sampledAt: state.sampledAt,
    protocolName: state.protocolName,
    mode: state.mode,
    grantedDevicesCount: state.grantedDevicesCount,
  });
}

function clearPollTimer() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getBackgroundPollInterval() {
  const batteryPercent = Number.isFinite(lastStableSnapshot?.batteryPercent)
    ? lastStableSnapshot.batteryPercent
    : Number.isFinite(state.batteryPercent)
      ? state.batteryPercent
      : null;

  if (state.charging || batteryPercent === null) {
    return POLL_INTERVAL_HIDDEN_DEFAULT_MS;
  }

  if (batteryPercent <= 20) {
    return POLL_INTERVAL_HIDDEN_LOW_MS;
  }

  if (batteryPercent <= 40) {
    return POLL_INTERVAL_HIDDEN_MEDIUM_MS;
  }

  return POLL_INTERVAL_HIDDEN_DEFAULT_MS;
}

function getNextPollInterval() {
  if (overlayVisible) {
    return POLL_INTERVAL_VISIBLE_MS;
  }

  return getBackgroundPollInterval();
}

function scheduleRefresh(delay = getNextPollInterval()) {
  if (runtimeSuspended || state.mode === 'fallback') {
    clearPollTimer();
    return;
  }

  clearPollTimer();
  pollTimer = window.setTimeout(() => {
    refreshDevices();
  }, delay);
}

function startStableRefresh(message) {
  runtimeSuspended = false;
  applyState({
    status: 'loading',
    message,
    needsUserAction: false,
    sampledAt: new Date().toISOString(),
    mode: 'stable',
  });
}

function resetCurrentDeviceState({ clearPreferred = false } = {}) {
  currentDevice = null;
  currentDeviceKey = '';
  currentProtocolKey = null;
  consecutiveReadFailures = 0;
  lastStableSnapshot = null;

  if (clearPreferred) {
    preferredDevice = null;
  }

  clearPollTimer();
}

function showWaitingForBinding(message) {
  runtimeSuspended = false;
  applyState({
    status: 'waiting',
    message,
    batteryPercent: null,
    batteryText: '--',
    deviceName: '',
    charging: false,
    needsUserAction: true,
    sampledAt: new Date().toISOString(),
    protocolName: '',
    mode: 'stable',
    grantedDevicesCount: state.grantedDevicesCount,
  });
}

function collectionHasReportId(reports, reportId) {
  return Array.isArray(reports) && reports.some((report) => report.reportId === reportId);
}

function inspectReportSupport(device, reportId) {
  // 先看设备声明里是否真的存在目标 reportId，避免对明显不匹配的接口盲发命令。
  let hasOutputReport = false;
  let hasFeatureReport = false;
  let sawOutputDescriptor = false;
  let sawFeatureDescriptor = false;

  shared.visitCollections(device?.collections, (collection) => {
    if (Array.isArray(collection.outputReports)) {
      sawOutputDescriptor = true;
      if (collectionHasReportId(collection.outputReports, reportId)) {
        hasOutputReport = true;
      }
    }

    if (Array.isArray(collection.featureReports)) {
      sawFeatureDescriptor = true;
      if (collectionHasReportId(collection.featureReports, reportId)) {
        hasFeatureReport = true;
      }
    }
  });

  return {
    hasOutputReport,
    hasFeatureReport,
    hasDescriptor: sawOutputDescriptor || sawFeatureDescriptor,
  };
}

function getReportTransports(device, reportId) {
  const support = inspectReportSupport(device, reportId);

  if (!support.hasOutputReport && !support.hasFeatureReport && !support.hasDescriptor) {
    return ['output', 'feature'];
  }

  const transports = [];
  if (support.hasOutputReport) {
    transports.push('output');
  }
  if (support.hasFeatureReport) {
    transports.push('feature');
  }

  return transports;
}

function getBoundDevice(devices, preferredCandidate = preferredDevice) {
  return shared.pickPreferredDevice(devices, preferredCandidate);
}

async function openDevice(device, forceReopen = false) {
  if (!device) {
    throw new Error('未找到可用设备');
  }

  const nextDeviceKey = shared.getDeviceKey(device);
  if (currentDeviceKey && currentDeviceKey !== nextDeviceKey) {
    currentProtocolKey = null;
    consecutiveReadFailures = 0;
    lastStableSnapshot = null;
  }

  if (forceReopen && device.opened) {
    await device.close().catch(() => {});
  }

  if (!device.opened) {
    await device.open();
  }

  currentDevice = device;
  currentDeviceKey = nextDeviceKey;
  const nextPreferences = await window.atkWorker.rememberDevice(shared.simplifyDevice(device));
  applyPreferences(nextPreferences);
}

function waitForInputReport(device, matcher, timeoutMs = 3000) {
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const handleCleanup = (timeoutId, handleInputReport) => {
      window.clearTimeout(timeoutId);
      device.removeEventListener('inputreport', handleInputReport);
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('等待输入报告超时'));
    }, timeoutMs);

    const handleInputReport = (event) => {
      try {
        if (!matcher(event)) {
          return;
        }

        cleanup();
        resolve(event.data);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    cleanup = () => handleCleanup(timeoutId, handleInputReport);
    device.addEventListener('inputreport', handleInputReport);
  });

  return {
    promise,
    cancel: () => cleanup(),
  };
}

function buildCompxBatteryRequest() {
  // COMPX 鼠标的电量命令来自官方驱动 bundle，16 字节报文且尾字节带校验。
  const bytes = new Uint8Array(16);
  bytes[0] = 4;

  let sum = shared.COMPX_REPORT_ID;
  for (let index = 0; index < 15; index += 1) {
    sum += bytes[index];
  }

  bytes[15] = (85 - (sum & 0xff)) & 0xff;
  return bytes;
}

function buildHechiMouseInfoRequest() {
  // HECHI 鼠标把电量塞在 getMouseInfo 返回里，这里只发送最小查询报文。
  const bytes = new Uint8Array(63);
  bytes[0] = 19;
  return bytes;
}

async function sendAndReceive(device, reportId, requestData, matcher, timeoutMs = 3000) {
  const transports = getReportTransports(device, reportId);
  const errors = [];

  if (transports.length === 0) {
    throw new Error(`设备未暴露 reportId ${reportId} 的 Output/Feature Report`);
  }

  for (const transport of transports) {
    try {
      if (transport === 'output') {
        const pending = waitForInputReport(device, matcher, timeoutMs);

        try {
          await device.sendReport(reportId, requestData);
          return await pending.promise;
        } catch (error) {
          pending.cancel();
          throw error;
        }
      }

      if (typeof device.sendFeatureReport !== 'function' || typeof device.receiveFeatureReport !== 'function') {
        throw new Error('当前环境不支持 Feature Report');
      }

      await device.sendFeatureReport(reportId, requestData);
      const response = await device.receiveFeatureReport(reportId);

      if (typeof matcher === 'function' && !matcher({ reportId, data: response, transport })) {
        throw new Error('Feature Report 返回内容不匹配');
      }

      return response;
    } catch (error) {
      errors.push(`${transport === 'output' ? 'Output Report' : 'Feature Report'}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | ') || '发送 HID 报告失败');
}

function isWriteReportFailure(error) {
  return /Failed to write the report|write the report|sendReport|sendFeatureReport|feature report/i.test(error?.message || '');
}

function isAggregateTransportCompatibilityFailure(error) {
  const message = error?.message || '';

  return (
    message.includes(COMPX_PROTOCOL_LABEL) &&
    message.includes(HECHI_PROTOCOL_LABEL) &&
    /(write the report|sendReport|sendFeatureReport|feature report)/i.test(message)
  );
}

function isProtocolCompatibilityFailure(error) {
  return (
    /返回失败状态|无效电量|没有可用的直连协议|unsupported|not supported|未暴露 reportId/i.test(error?.message || '') ||
    isAggregateTransportCompatibilityFailure(error)
  );
}

const protocols = {
  compx: {
    label: COMPX_PROTOCOL_LABEL,
    async read(device) {
      const response = await sendAndReceive(
        device,
        shared.COMPX_REPORT_ID,
        buildCompxBatteryRequest(),
        (event) => event.reportId === shared.COMPX_REPORT_ID && event.data.byteLength >= 7 && event.data.getUint8(0) === 4
      );

      const commandStatus = response.getUint8(1);
      const batteryPercent = Math.min(response.getUint8(5), 100);
      const chargingFlag = response.getUint8(6);

      if (commandStatus === 255) {
        throw new Error('COMPX 返回失败状态');
      }

      if (!Number.isFinite(batteryPercent) || batteryPercent < 0 || batteryPercent > 100) {
        throw new Error('COMPX 返回了无效电量');
      }

      return {
        batteryPercent,
        charging: chargingFlag === 1,
        protocolName: this.label,
      };
    },
  },
  hechi: {
    label: HECHI_PROTOCOL_LABEL,
    async read(device) {
      const response = await sendAndReceive(
        device,
        shared.HECHI_REPORT_ID,
        buildHechiMouseInfoRequest(),
        (event) => event.reportId === shared.HECHI_REPORT_ID && event.data.byteLength >= 18 && event.data.getUint8(0) === 19
      );

      const resultCode = response.getUint8(2);
      const chargingFlag = response.getUint8(16);
      const batteryPercent = Math.min(response.getUint8(17), 100);

      if (resultCode === 255) {
        throw new Error('HECHI 返回失败状态');
      }

      if (!Number.isFinite(batteryPercent) || batteryPercent < 0 || batteryPercent > 100) {
        throw new Error('HECHI 返回了无效电量');
      }

      return {
        batteryPercent,
        charging: chargingFlag === 1,
        protocolName: this.label,
      };
    },
  },
};

function getProtocolEntries(allowProtocolFallback = false) {
  const entries = Object.entries(protocols);

  if (!currentProtocolKey || !protocols[currentProtocolKey]) {
    return entries;
  }

  if (!allowProtocolFallback) {
    return [[currentProtocolKey, protocols[currentProtocolKey]]];
  }

  return [
    [currentProtocolKey, protocols[currentProtocolKey]],
    ...entries.filter(([key]) => key !== currentProtocolKey),
  ];
}

async function readBattery(device, { allowProtocolFallback = false } = {}) {
  // 先尝试上一次成功的协议，再按已知协议顺序回退，尽量缩短后台采集的恢复时间。
  const errors = [];

  for (const [key, protocol] of getProtocolEntries(allowProtocolFallback)) {
    try {
      const result = await protocol.read(device);
      currentProtocolKey = key;
      return result;
    } catch (error) {
      errors.push(`${protocol.label}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | ') || '没有可用的直连协议');
}

async function readBatteryWithRecovery(device, options = {}) {
  try {
    return await readBattery(device, options);
  } catch (error) {
    if (!isWriteReportFailure(error)) {
      throw error;
    }

    currentProtocolKey = null;
    await device.close().catch(() => {});
    await sleep(260);
    await openDevice(device, true);
    await sleep(120);
    return readBattery(device, { allowProtocolFallback: true });
  }
}

async function refreshDevices({ forceReopen = false, preferredDeviceHint = null, explicitDevice = null } = {}) {
  const nonce = ++refreshNonce;
  clearPollTimer();

  try {
    const devices = await navigator.hid.getDevices();
    if (nonce !== refreshNonce || runtimeSuspended) {
      return;
    }

    applyState({
      grantedDevicesCount: devices.length,
    });

    const device = explicitDevice || getBoundDevice(devices, preferredDeviceHint || preferredDevice);
    if (!device) {
      resetCurrentDeviceState();
      showWaitingForBinding(
        hasBoundDevice()
          ? '当前绑定设备未接入，请连接后刷新，或改为更换绑定设备。'
          : '还没有绑定设备。请先在设备管理里选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。'
      );
      return;
    }

    await openDevice(device, forceReopen);
    if (nonce !== refreshNonce || runtimeSuspended) {
      return;
    }

    const allowProtocolFallback = forceReopen || !currentProtocolKey || consecutiveReadFailures >= PROTOCOL_RESET_FAILURE_LIMIT;
    const result = await readBatteryWithRecovery(device, { allowProtocolFallback });
    if (nonce !== refreshNonce || runtimeSuspended) {
      return;
    }

    consecutiveReadFailures = 0;
    lastStableSnapshot = {
      batteryPercent: result.batteryPercent,
      batteryText: `${result.batteryPercent}%`,
      charging: result.charging,
      deviceName: shared.getDeviceProductName(device) || 'ATK 设备',
      sampledAt: new Date().toISOString(),
      protocolName: result.protocolName,
    };

    applyState({
      status: 'connected',
      message: overlayVisible
        ? '本地 WebHID 直连已建立，后续启动会优先直接读鼠标电量。'
        : `托盘后台采集中，当前为${Math.round(getNextPollInterval() / 60000)}分钟级轮询。`,
      ...lastStableSnapshot,
      needsUserAction: false,
      mode: 'stable',
      grantedDevicesCount: devices.length,
    });

    scheduleRefresh();
  } catch (error) {
    if (nonce !== refreshNonce || runtimeSuspended) {
      return;
    }

    const isPermissionProblem = /denied|not found|user gesture/i.test(error.message);
    const hasDevice = !!currentDevice;
    const isProtocolFailure = isProtocolCompatibilityFailure(error);
    const shouldAutoRetry = hasDevice && (!isProtocolFailure || Boolean(lastStableSnapshot));
    consecutiveReadFailures += 1;

    if (
      hasDevice &&
      lastStableSnapshot &&
      (!isProtocolFailure || consecutiveReadFailures <= PROTOCOL_RESET_FAILURE_LIMIT)
    ) {
      applyState({
        status: 'connected',
        ...lastStableSnapshot,
        message: `本次轮询读取失败，已沿用上次成功结果（${consecutiveReadFailures} 次）。正在自动重试...`,
        needsUserAction: false,
        mode: 'stable',
        grantedDevicesCount: state.grantedDevicesCount,
      });

      scheduleRefresh(RETRY_INTERVAL_MS);
      return;
    }

    if (hasDevice && consecutiveReadFailures >= PROTOCOL_RESET_FAILURE_LIMIT) {
      currentProtocolKey = null;
    }

    applyState({
      status: hasDevice && !isPermissionProblem && isProtocolFailure ? 'unsupported' : 'error',
      message: hasDevice
        ? isProtocolFailure
          ? `直连协议暂未完全适配：${error.message}。当前不会自动反复重试，你可以点击“刷新”或打开设备管理。`
          : shouldAutoRetry
            ? `本地直连读取异常：${error.message}。正在自动重试，你也可以手动刷新。`
            : `本地直连读取异常：${error.message}。请点击“刷新”重试。`
        : `读取设备失败：${error.message}`,
      batteryPercent: lastStableSnapshot?.batteryPercent ?? null,
      batteryText: lastStableSnapshot?.batteryText ?? '--',
      deviceName: lastStableSnapshot?.deviceName || shared.getDeviceProductName(currentDevice) || '',
      charging: lastStableSnapshot?.charging ?? false,
      needsUserAction: !hasDevice,
      sampledAt: lastStableSnapshot?.sampledAt || new Date().toISOString(),
      protocolName: hasDevice ? lastStableSnapshot?.protocolName || (isProtocolFailure ? '待补充协议适配' : '') : '',
      mode: hasDevice ? 'stable' : state.mode,
      grantedDevicesCount: state.grantedDevicesCount,
    });

    if (shouldAutoRetry) {
      scheduleRefresh(RETRY_INTERVAL_MS);
      return;
    }

    clearPollTimer();
  }
}

function handleDisconnect(event) {
  if (runtimeSuspended || state.mode === 'fallback') {
    return;
  }

  if (!currentDevice) {
    return;
  }

  const isCurrent =
    shared.getDeviceKey(event.device) === currentDeviceKey ||
    (event.device.vendorId === currentDevice.vendorId &&
      event.device.productId === currentDevice.productId &&
      event.device.productName === currentDevice.productName);

  if (!isCurrent) {
    return;
  }

  resetCurrentDeviceState();
  showWaitingForBinding('当前绑定设备已断开连接，等待鼠标重新接入。');
}

function handleConnect() {
  if (runtimeSuspended || state.mode === 'fallback' || !hasBoundDevice()) {
    return;
  }

  refreshDevices({ forceReopen: true, preferredDeviceHint: preferredDevice });
}

async function handleManualRefresh() {
  if (runtimeSuspended) {
    return;
  }

  if (!hasBoundDevice()) {
    showWaitingForBinding('当前还没有绑定设备，请先在设备管理里选择并绑定设备。');
    return;
  }

  startStableRefresh('正在刷新当前绑定设备...');
  await refreshDevices({ forceReopen: true, preferredDeviceHint: preferredDevice });
}

function handleOverlayVisibilityChange(visible) {
  overlayVisible = Boolean(visible);

  if (runtimeSuspended || state.mode === 'fallback') {
    return;
  }

  if (overlayVisible && hasBoundDevice()) {
    void refreshDevices({ preferredDeviceHint: preferredDevice });
    return;
  }

  if (hasBoundDevice()) {
    scheduleRefresh();
  }
}

function handleRuntimeModeChange(mode) {
  const wasSuspended = runtimeSuspended || state.mode === 'fallback';

  if (mode === 'fallback') {
    runtimeSuspended = true;
    refreshNonce += 1;
    clearPollTimer();
    return;
  }

  runtimeSuspended = false;

  if (!wasSuspended) {
    return;
  }

  if (hasBoundDevice()) {
    void refreshDevices({ preferredDeviceHint: preferredDevice });
  } else {
    showWaitingForBinding('还没有绑定设备。请先在设备管理里选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
  }
}

async function boot() {
  const [initialState, initialPreferences, bootstrapState] = await Promise.all([
    window.atkWorker.getInitialState(),
    window.atkWorker.getPreferences(),
    window.atkWorker.getBootstrapState(),
  ]);

  preferredDevice = initialPreferences.preferredHidDevice || null;
  overlayVisible = Boolean(bootstrapState?.overlayVisible);
  runtimeSuspended = bootstrapState?.runtimeMode === 'fallback';
  applyPreferences(initialPreferences);
  applyState(initialState);

  if (!navigator.hid) {
    applyState({
      status: 'error',
      message: '当前 Electron 环境没有打开 WebHID 能力，无法建立稳定直连。',
      needsUserAction: true,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });
    return;
  }

  navigator.hid.addEventListener('disconnect', handleDisconnect);
  navigator.hid.addEventListener('connect', handleConnect);

  window.atkWorker.onPreferencesChanged((nextPreferences) => {
    applyPreferences(nextPreferences);
  });
  window.atkWorker.onRefreshRequested(() => {
    void handleManualRefresh();
  });
  window.atkWorker.onOverlayVisibilityChanged((visible) => {
    handleOverlayVisibilityChange(visible);
  });
  window.atkWorker.onRuntimeModeChanged((mode) => {
    handleRuntimeModeChange(mode);
  });

  if (runtimeSuspended) {
    return;
  }

  if (hasBoundDevice()) {
    await refreshDevices({ preferredDeviceHint: preferredDevice });
  } else {
    showWaitingForBinding('还没有绑定设备。请先在设备管理里选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
  }
}

boot();
