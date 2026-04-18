const HID = require('node-hid');

const { logInfo, logWarn } = require('./logger');

const POLL_INTERVAL_VISIBLE_MS = 10 * 1000;
const POLL_INTERVAL_HIDDEN_DEFAULT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_HIDDEN_MEDIUM_MS = 5 * 60 * 1000;
const POLL_INTERVAL_HIDDEN_LOW_MS = 2 * 60 * 1000;
const RETRY_INTERVAL_MS = 5000;
const PROTOCOL_RESET_FAILURE_LIMIT = 3;
const COMPX_REPORT_ID = 8;
const HECHI_REPORT_ID = 11;
const COMPX_PROTOCOL_LABEL = 'COMPX 直连';
const HECHI_PROTOCOL_LABEL = 'HECHI 直连';

function normalizeDeviceName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function getDeviceProductName(device) {
  return normalizeDeviceName(device?.productName || device?.product || device?.name);
}

function buildCollectionSignature(device) {
  return [
    Number.isFinite(device?.interface) ? device.interface : '',
    Number.isFinite(device?.usagePage) ? device.usagePage : '',
    Number.isFinite(device?.usage) ? device.usage : '',
    Number.isFinite(device?.release) ? device.release : '',
    normalizeDeviceName(device?.serialNumber),
  ].join('/');
}

function normalizeDeviceBinding(device) {
  if (!device || !Number.isFinite(device.vendorId) || !Number.isFinite(device.productId)) {
    return null;
  }

  return {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: getDeviceProductName(device),
    collectionSignature: normalizeDeviceName(device.collectionSignature) || buildCollectionSignature(device),
  };
}

function getDeviceBindingKey(device) {
  const normalized = normalizeDeviceBinding(device);

  if (!normalized) {
    return '';
  }

  return [normalized.vendorId, normalized.productId, normalized.productName, normalized.collectionSignature].join(':');
}

function getLooseDeviceBindingKey(device) {
  const normalized = normalizeDeviceBinding(device);

  if (!normalized) {
    return '';
  }

  return [normalized.vendorId, normalized.productId, normalized.productName].join(':');
}

function getDeviceBindingMatchLevel(left, right) {
  const exactLeft = getDeviceBindingKey(left);
  const exactRight = getDeviceBindingKey(right);

  if (exactLeft && exactLeft === exactRight) {
    return 2;
  }

  const looseLeft = getLooseDeviceBindingKey(left);
  const looseRight = getLooseDeviceBindingKey(right);

  if (looseLeft && looseLeft === looseRight) {
    return 1;
  }

  return 0;
}

function isGenericDeviceName(name) {
  const normalized = normalizeDeviceName(name);
  if (!normalized) {
    return true;
  }

  if (/ATK|VXE/i.test(normalized)) {
    return false;
  }

  return /wireless mouse|mouse|dongle|receiver|nano|hid|bluetooth|keyboard/i.test(normalized);
}

function supportsKnownBatteryProtocolHint(device) {
  const productName = getDeviceProductName(device);
  const usagePage = Number.isFinite(device?.usagePage) ? device.usagePage : null;
  const usage = Number.isFinite(device?.usage) ? device.usage : null;

  return {
    compx: /ATK|VXE|F1|X1|R1/i.test(productName) || usagePage === 65280,
    hechi: /ATK|VXE|F1|X1|R1/i.test(productName) || usage === 2,
  };
}

function getDeviceMatchScore(device, preferredBinding = null) {
  const productName = getDeviceProductName(device);
  const hasMouseUsage = device?.usage === 2;
  const hasKeyboardUsage = device?.usage === 6;
  const protocolHint = supportsKnownBatteryProtocolHint(device);
  let score = 0;

  if (/virtual multitouch/i.test(productName)) {
    score -= 40;
  }

  if (/ATK|VXE/i.test(productName)) {
    score += 36;
  }

  if (/mouse|鼠标|dongle|receiver|2\.4/i.test(productName)) {
    score += 28;
  }

  if (/nano/i.test(productName)) {
    score += 10;
  }

  if (/keyboard/i.test(productName)) {
    score -= 18;
  }

  if (protocolHint.compx) {
    score += 28;
  }

  if (protocolHint.hechi) {
    score += 28;
  }

  if (hasMouseUsage && !hasKeyboardUsage) {
    score += 18;
  } else if (hasKeyboardUsage) {
    score -= 10;
  }

  score += getDeviceBindingMatchLevel(device, preferredBinding) * 120;
  return score;
}

function normalizeNativeDevice(device) {
  const binding = normalizeDeviceBinding(device);

  if (!binding || !normalizeDeviceName(device?.path)) {
    return null;
  }

  return {
    deviceId: device.path,
    path: device.path,
    vendorId: binding.vendorId,
    productId: binding.productId,
    productName: binding.productName,
    serialNumber: normalizeDeviceName(device.serialNumber),
    manufacturer: normalizeDeviceName(device.manufacturer),
    usagePage: Number.isFinite(device.usagePage) ? device.usagePage : null,
    usage: Number.isFinite(device.usage) ? device.usage : null,
    interface: Number.isFinite(device.interface) ? device.interface : null,
    release: Number.isFinite(device.release) ? device.release : null,
    collectionSignature: binding.collectionSignature,
    protocolSupport: supportsKnownBatteryProtocolHint(device),
  };
}

function shouldIncludeInChooser(device, preferredBinding = null) {
  const productName = getDeviceProductName(device);
  const matchLevel = getDeviceBindingMatchLevel(device, preferredBinding);
  const protocolHint = device?.protocolSupport || supportsKnownBatteryProtocolHint(device);
  const isAtkFamily = /ATK|VXE|F1|X1|R1/i.test(productName);
  const isMouseLike = /mouse|鼠标|dongle|receiver|2\.4|wireless/i.test(productName) || device?.usage === 2;
  const isLikelyNoise = /virtual multitouch|trackpad|touchpad|touch bar|consumer control|keyboard|apple internal/i.test(productName);

  if (matchLevel > 0) {
    return true;
  }

  if (protocolHint.compx || protocolHint.hechi) {
    return true;
  }

  if (isAtkFamily) {
    return true;
  }

  if (isMouseLike && !isLikelyNoise) {
    return true;
  }

  return false;
}

function buildChooserGroupKey(device) {
  const serialNumber = normalizeDeviceName(device?.serialNumber);

  return [
    Number.isFinite(device?.vendorId) ? device.vendorId : '',
    Number.isFinite(device?.productId) ? device.productId : '',
    serialNumber || getDeviceProductName(device) || normalizeDeviceName(device?.manufacturer),
  ].join(':');
}

function groupDevicesByChooserKey(devices) {
  const deviceGroups = new Map();

  for (const device of Array.isArray(devices) ? devices : []) {
    const groupKey = buildChooserGroupKey(device);
    if (!groupKey) {
      continue;
    }

    if (!deviceGroups.has(groupKey)) {
      deviceGroups.set(groupKey, []);
    }

    deviceGroups.get(groupKey).push(device);
  }

  return deviceGroups;
}

function chooseBestDeviceCandidate(devices, preferredBinding = null) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return null;
  }

  return [...devices]
    .sort((left, right) => getDeviceMatchScore(right, preferredBinding) - getDeviceMatchScore(left, preferredBinding))[0] || null;
}

async function listNativeDevices() {
  const devices = await HID.devicesAsync();

  return devices
    .map((device) => normalizeNativeDevice(device))
    .filter(Boolean);
}

function serializeChooserDevice(device, preferredBinding = null, groupSize = 1) {
  return {
    deviceId: buildChooserGroupKey(device),
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName,
    serialNumber: device.serialNumber,
    guid: '',
    interface: device.interface,
    usagePage: device.usagePage,
    usage: device.usage,
    collectionSignature: device.collectionSignature,
    score: getDeviceMatchScore(device, preferredBinding),
    matchLevel: getDeviceBindingMatchLevel(device, preferredBinding),
    protocolSupport: device.protocolSupport,
    candidateCount: groupSize,
  };
}

function buildChooserDeviceList(devices, preferredBinding = null) {
  const filteredDevices = devices.filter((device) => shouldIncludeInChooser(device, preferredBinding));
  const chooserDevices = filteredDevices.length > 0 ? filteredDevices : devices;
  const deviceGroups = groupDevicesByChooserKey(chooserDevices);

  return Array.from(deviceGroups.values())
    .map((deviceGroup) => {
      const representative = chooseBestDeviceCandidate(deviceGroup, preferredBinding);
      return representative ? serializeChooserDevice(representative, preferredBinding, deviceGroup.length) : null;
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.matchLevel !== left.matchLevel) {
        return right.matchLevel - left.matchLevel;
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.productName.localeCompare(right.productName, 'zh-CN');
    });
}

function normalizeInputBuffer(buffer, reportId) {
  if (!Buffer.isBuffer(buffer)) {
    return Buffer.alloc(0);
  }

  if (buffer.length > 0 && buffer[0] === reportId) {
    return buffer.subarray(1);
  }

  return buffer;
}

function buildCompxBatteryRequest() {
  const bytes = new Uint8Array(16);
  bytes[0] = 4;

  let sum = COMPX_REPORT_ID;
  for (let index = 0; index < 15; index += 1) {
    sum += bytes[index];
  }

  bytes[15] = (85 - (sum & 0xff)) & 0xff;
  return bytes;
}

function buildHechiMouseInfoRequest() {
  const bytes = new Uint8Array(63);
  bytes[0] = 19;
  return bytes;
}

async function closeHandle(handle) {
  if (!handle) {
    return;
  }

  try {
    await Promise.resolve(handle.close());
  } catch (_error) {
    // 关闭失败不影响后续重连，这里吞掉底层句柄异常。
  }
}

async function readUntilMatch(handle, reportId, matcher, timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs;

  while (Date.now() < deadlineAt) {
    const remaining = Math.max(120, deadlineAt - Date.now());
    const response = await handle.read(remaining);
    const data = normalizeInputBuffer(Buffer.from(response), reportId);

    if (matcher(data)) {
      return data;
    }
  }

  throw new Error('等待输入报告超时');
}

async function sendAndReceive(handle, reportId, requestData, matcher, options = {}) {
  const { featureLength = 0, timeoutMs = 3000 } = options;
  const requestPayload = [reportId, ...Array.from(requestData)];
  const errors = [];

  try {
    await handle.write(requestPayload);
    return await readUntilMatch(handle, reportId, matcher, timeoutMs);
  } catch (error) {
    errors.push(`Output Report: ${error.message}`);
  }

  try {
    await handle.sendFeatureReport(requestPayload);
    const response = await handle.getFeatureReport(reportId, featureLength || requestPayload.length + 1);
    const data = normalizeInputBuffer(Buffer.from(response), reportId);

    if (!matcher(data)) {
      throw new Error('Feature Report 返回内容不匹配');
    }

    return data;
  } catch (error) {
    errors.push(`Feature Report: ${error.message}`);
  }

  throw new Error(errors.join(' | ') || '发送 HID 报告失败');
}

function isProtocolCompatibilityFailure(error) {
  return /返回失败状态|无效电量|没有可用的直连协议|unsupported|not supported/i.test(error?.message || '');
}

// 协议兼容类错误以外，都视为可恢复的底层 IO 故障：读写超时、句柄失效、设备暂时离线等。
// 这类错误走 close + reopen 一次重试，避免句柄僵死后一直沿用旧 handle。
function isRecoverableIoFailure(error) {
  return !isProtocolCompatibilityFailure(error);
}

const protocols = {
  compx: {
    label: COMPX_PROTOCOL_LABEL,
    async read(handle) {
      const response = await sendAndReceive(
        handle,
        COMPX_REPORT_ID,
        buildCompxBatteryRequest(),
        (data) => data.length >= 7 && data[0] === 4,
        { featureLength: 18 }
      );

      const commandStatus = response[1];
      const batteryPercent = Math.min(response[5], 100);
      const chargingFlag = response[6];

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
    async read(handle) {
      const response = await sendAndReceive(
        handle,
        HECHI_REPORT_ID,
        buildHechiMouseInfoRequest(),
        (data) => data.length >= 18 && data[0] === 19,
        { featureLength: 65 }
      );

      const resultCode = response[2];
      const chargingFlag = response[16];
      const batteryPercent = Math.min(response[17], 100);

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

class NativeBatteryRuntime {
  constructor(options = {}) {
    this.preferredBinding = null;
    this.overlayVisible = false;
    this.runtimeSuspended = false;
    this.currentHandle = null;
    this.currentDevice = null;
    this.currentProtocolKey = null;
    this.currentDeviceKey = '';
    this.consecutiveReadFailures = 0;
    this.lastStableSnapshot = null;
    this.pollTimer = null;
    this.refreshNonce = 0;
    this.state = {
      status: 'loading',
      message: '正在准备原生 HID 直连器...',
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
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
    this.onBindingDetected = typeof options.onBindingDetected === 'function' ? options.onBindingDetected : async () => {};
  }

  emitState(patch) {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.onStateChange(this.state);
  }

  setPreferredBinding(binding) {
    const previousKey = getDeviceBindingKey(this.preferredBinding);
    const nextBinding = normalizeDeviceBinding(binding);
    const nextKey = getDeviceBindingKey(nextBinding);

    this.preferredBinding = nextBinding;

    if (!nextKey) {
      void this.resetCurrentDevice({ clearPreferred: true });
      return;
    }

    if (previousKey && previousKey !== nextKey && this.currentDeviceKey !== nextKey) {
      void this.resetCurrentDevice();
    }
  }

  async resetCurrentDevice(options = {}) {
    const { clearPreferred = false } = options;

    this.currentProtocolKey = null;
    this.currentDeviceKey = '';
    this.currentDevice = null;
    this.consecutiveReadFailures = 0;
    this.lastStableSnapshot = null;
    this.clearPollTimer();
    await closeHandle(this.currentHandle);
    this.currentHandle = null;

    if (clearPreferred) {
      this.preferredBinding = null;
    }
  }

  setOverlayVisible(visible) {
    this.overlayVisible = Boolean(visible);

    if (this.runtimeSuspended || this.state.mode === 'fallback') {
      return;
    }

    if (this.overlayVisible && this.hasBoundDevice()) {
      void this.refreshNow();
      return;
    }

    if (this.hasBoundDevice()) {
      this.scheduleRefresh();
    }
  }

  setSuspended(suspended) {
    const nextValue = Boolean(suspended);
    const wasSuspended = this.runtimeSuspended || this.state.mode === 'fallback';
    this.runtimeSuspended = nextValue;

    if (nextValue) {
      this.refreshNonce += 1;
      this.clearPollTimer();
      return;
    }

    if (!wasSuspended) {
      return;
    }

    if (this.hasBoundDevice()) {
      void this.refreshNow({ forceReopen: true });
      return;
    }

    this.showWaitingForBinding('还没有绑定设备。请先在设备管理里选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
  }

  clearPollTimer() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  hasBoundDevice() {
    return Boolean(getDeviceBindingKey(this.preferredBinding));
  }

  getBackgroundPollInterval() {
    const batteryPercent = Number.isFinite(this.lastStableSnapshot?.batteryPercent)
      ? this.lastStableSnapshot.batteryPercent
      : Number.isFinite(this.state.batteryPercent)
        ? this.state.batteryPercent
        : null;

    // 充电过程中电量变化最快，用最短的后台轮询保证托盘数字能跟上真实进度。
    if (this.state.charging) {
      return POLL_INTERVAL_HIDDEN_LOW_MS;
    }

    if (batteryPercent === null) {
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

  getNextPollInterval() {
    if (this.overlayVisible) {
      return POLL_INTERVAL_VISIBLE_MS;
    }

    return this.getBackgroundPollInterval();
  }

  scheduleRefresh(delay = this.getNextPollInterval()) {
    if (this.runtimeSuspended || this.state.mode === 'fallback') {
      this.clearPollTimer();
      return;
    }

    this.clearPollTimer();
    this.pollTimer = setTimeout(() => {
      void this.refreshNow();
    }, delay);
  }

  showWaitingForBinding(message) {
    this.runtimeSuspended = false;
    this.emitState({
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
      grantedDevicesCount: this.state.grantedDevicesCount,
    });
  }

  getCandidateDevices(devices) {
    const exactMatches = devices.filter((device) => getDeviceBindingMatchLevel(device, this.preferredBinding) === 2);
    const looseMatches = devices.filter((device) => getDeviceBindingMatchLevel(device, this.preferredBinding) === 1);
    const restDevices = devices.filter((device) => getDeviceBindingMatchLevel(device, this.preferredBinding) === 0);
    const sortByScore = (list) => [...list].sort((left, right) => getDeviceMatchScore(right, this.preferredBinding) - getDeviceMatchScore(left, this.preferredBinding));

    if (exactMatches.length > 0) {
      return [...sortByScore(exactMatches), ...sortByScore(looseMatches)];
    }

    if (looseMatches.length > 0) {
      return [...sortByScore(looseMatches), ...sortByScore(restDevices)];
    }

    return sortByScore(restDevices);
  }

  async listChooserDevices() {
    const devices = await listNativeDevices();
    return buildChooserDeviceList(devices, this.preferredBinding);
  }

  async bindDeviceById(deviceId) {
    const devices = await listNativeDevices();
    const deviceGroup = groupDevicesByChooserKey(devices).get(deviceId) || [];
    const device = chooseBestDeviceCandidate(deviceGroup, this.preferredBinding);

    if (!device) {
      return null;
    }

    const binding = normalizeDeviceBinding(device);
    this.setPreferredBinding(binding);
    await this.onBindingDetected(binding);
    return binding;
  }

  async commitSuccessfulRead(candidate, result, deviceCount) {
    const previousSnapshot = this.lastStableSnapshot;
    const binding = normalizeDeviceBinding(candidate);
    await this.onBindingDetected(binding);
    this.preferredBinding = binding;
    this.consecutiveReadFailures = 0;
    this.lastStableSnapshot = {
      batteryPercent: result.batteryPercent,
      batteryText: `${result.batteryPercent}%`,
      charging: result.charging,
      deviceName: getDeviceProductName(candidate) || 'ATK 设备',
      sampledAt: new Date().toISOString(),
      protocolName: result.protocolName,
    };

    this.emitState({
      status: 'connected',
      message: this.overlayVisible
        ? '原生 HID 直连已建立，当前不再依赖后台浏览器采集。'
        : `托盘后台采集中，当前为${Math.round(this.getNextPollInterval() / 60000)}分钟级轮询。`,
      ...this.lastStableSnapshot,
      needsUserAction: false,
      mode: 'stable',
      grantedDevicesCount: Number.isFinite(deviceCount) ? deviceCount : this.state.grantedDevicesCount,
    });

    if (
      !previousSnapshot
      || previousSnapshot.deviceName !== this.lastStableSnapshot.deviceName
      || previousSnapshot.protocolName !== this.lastStableSnapshot.protocolName
    ) {
      logInfo('原生 HID 已建立稳定连接', {
        deviceName: this.lastStableSnapshot.deviceName,
        protocolName: result.protocolName,
        batteryPercent: result.batteryPercent,
        deviceCount,
      });
    }

    this.scheduleRefresh();
  }

  async tryReadCurrentDevice(nonce, forceReopen = false) {
    if (!this.currentDevice || (!this.currentHandle && !forceReopen)) {
      return false;
    }

    try {
      await this.openDevice(this.currentDevice, forceReopen);
      if (nonce !== this.refreshNonce || this.runtimeSuspended) {
        return true;
      }

      const allowProtocolFallback = forceReopen || !this.currentProtocolKey || this.consecutiveReadFailures >= PROTOCOL_RESET_FAILURE_LIMIT;
      const result = await this.readBatteryWithRecovery(allowProtocolFallback);
      if (nonce !== this.refreshNonce || this.runtimeSuspended) {
        return true;
      }

      await this.commitSuccessfulRead(this.currentDevice, result, this.state.grantedDevicesCount);
      return true;
    } catch (_error) {
      await closeHandle(this.currentHandle);
      this.currentHandle = null;
      return false;
    }
  }

  keepLastStableSnapshot(reason) {
    if (!this.lastStableSnapshot) {
      return false;
    }

    this.emitState({
      status: 'connected',
      ...this.lastStableSnapshot,
      message: reason || `本次轮询读取失败，已沿用上次成功结果（${this.consecutiveReadFailures} 次）。正在自动重试...`,
      needsUserAction: false,
      mode: 'stable',
      grantedDevicesCount: this.state.grantedDevicesCount,
    });
    this.scheduleRefresh(RETRY_INTERVAL_MS);
    return true;
  }

  async openDevice(device, forceReopen = false) {
    const nextDeviceKey = getDeviceBindingKey(device);

    if (this.currentHandle && this.currentDevice?.deviceId !== device.deviceId) {
      await closeHandle(this.currentHandle);
      this.currentHandle = null;
    }

    if (this.currentDeviceKey && this.currentDeviceKey !== nextDeviceKey) {
      this.currentProtocolKey = null;
      this.consecutiveReadFailures = 0;
    }

    if (forceReopen && this.currentHandle) {
      await closeHandle(this.currentHandle);
      this.currentHandle = null;
    }

    if (!this.currentHandle) {
      this.currentHandle = await HID.HIDAsync.open(device.path);
    }

    this.currentDevice = device;
    this.currentDeviceKey = nextDeviceKey;
  }

  getProtocolEntries(allowProtocolFallback = false) {
    const entries = Object.entries(protocols);

    if (!this.currentProtocolKey || !protocols[this.currentProtocolKey]) {
      return entries;
    }

    if (!allowProtocolFallback) {
      return [[this.currentProtocolKey, protocols[this.currentProtocolKey]]];
    }

    return [
      [this.currentProtocolKey, protocols[this.currentProtocolKey]],
      ...entries.filter(([key]) => key !== this.currentProtocolKey),
    ];
  }

  async readBattery(allowProtocolFallback = false) {
    const errors = [];

    for (const [key, protocol] of this.getProtocolEntries(allowProtocolFallback)) {
      try {
        const result = await protocol.read(this.currentHandle);
        this.currentProtocolKey = key;
        return result;
      } catch (error) {
        errors.push(`${protocol.label}: ${error.message}`);
      }
    }

    throw new Error(errors.join(' | ') || '没有可用的直连协议');
  }

  async readBatteryWithRecovery(allowProtocolFallback = false) {
    try {
      return await this.readBattery(allowProtocolFallback);
    } catch (error) {
      // 协议兼容性问题重开 handle 也没用，直接冒泡给上层按"待适配"处理。
      if (!isRecoverableIoFailure(error)) {
        throw error;
      }

      // 其他任何读写/超时/IO 故障，都先把当前 handle 彻底关闭再重建一次，
      // 避免底层句柄僵死后持续失败只能靠用户解绑重选才能恢复。
      this.currentProtocolKey = null;
      await closeHandle(this.currentHandle);
      this.currentHandle = null;
      await new Promise((resolve) => setTimeout(resolve, 260));
      await this.openDevice(this.currentDevice, true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return this.readBattery(true);
    }
  }

  async refreshNow(options = {}) {
    const { forceReopen = false } = options;
    const nonce = ++this.refreshNonce;
    this.clearPollTimer();

    try {
      if (!this.hasBoundDevice()) {
        await this.resetCurrentDevice({ clearPreferred: true });
        this.showWaitingForBinding('还没有绑定设备。请先在设备管理里选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
        return;
      }

      if (await this.tryReadCurrentDevice(nonce, forceReopen)) {
        return;
      }

      const devices = await listNativeDevices();
      if (nonce !== this.refreshNonce || this.runtimeSuspended) {
        return;
      }

      this.emitState({
        grantedDevicesCount: devices.length,
      });

      const candidates = this.getCandidateDevices(devices);
      if (candidates.length === 0) {
        await this.resetCurrentDevice();
        this.showWaitingForBinding('当前绑定设备未接入，请连接后刷新，或改为更换绑定设备。');
        return;
      }

      const candidateErrors = [];

      for (const candidate of candidates) {
        try {
          await this.openDevice(candidate, forceReopen && candidate.deviceId === this.currentDevice?.deviceId);
          if (nonce !== this.refreshNonce || this.runtimeSuspended) {
            return;
          }

          const allowProtocolFallback = forceReopen || !this.currentProtocolKey || this.consecutiveReadFailures >= PROTOCOL_RESET_FAILURE_LIMIT;
          const result = await this.readBatteryWithRecovery(allowProtocolFallback);
          if (nonce !== this.refreshNonce || this.runtimeSuspended) {
            return;
          }

          await this.commitSuccessfulRead(candidate, result, devices.length);
          return;
        } catch (error) {
          candidateErrors.push(error.message);

          if (this.currentDevice?.deviceId === candidate.deviceId) {
            await closeHandle(this.currentHandle);
            this.currentHandle = null;
          }
        }
      }

      throw new Error(candidateErrors.join(' | ') || '读取设备失败');
    } catch (error) {
      if (nonce !== this.refreshNonce || this.runtimeSuspended) {
        return;
      }

      const hasDevice = Boolean(this.currentDevice);
      const isProtocolFailure = isProtocolCompatibilityFailure(error);
      this.consecutiveReadFailures += 1;

      logWarn('原生 HID 轮询失败', {
        message: error.message,
        hasDevice,
        deviceName: getDeviceProductName(this.currentDevice),
        currentProtocolKey: this.currentProtocolKey,
        consecutiveReadFailures: this.consecutiveReadFailures,
        isProtocolFailure,
        forceReopen,
      });

      if (this.lastStableSnapshot) {
        if (hasDevice && this.consecutiveReadFailures >= PROTOCOL_RESET_FAILURE_LIMIT) {
          // 连续失败达到阈值，清协议键 + 强制关闭僵死句柄，
          // 下次 tryReadCurrentDevice 会看到没有 handle 而落入完整重扫+重开路径。
          this.currentProtocolKey = null;
          await closeHandle(this.currentHandle);
          this.currentHandle = null;
        }

        if (this.keepLastStableSnapshot()) {
          return;
        }
      }

      if (hasDevice && this.consecutiveReadFailures >= PROTOCOL_RESET_FAILURE_LIMIT) {
        this.currentProtocolKey = null;
        await closeHandle(this.currentHandle);
        this.currentHandle = null;
      }

      const shouldAutoRetry = hasDevice && !isProtocolFailure;
      if (shouldAutoRetry) {
        this.emitState({
          status: 'error',
          message: `原生 HID 读取异常：${error.message}。正在自动重试...`,
          batteryPercent: null,
          batteryText: '--',
          deviceName: getDeviceProductName(this.currentDevice) || '',
          charging: false,
          needsUserAction: false,
          sampledAt: new Date().toISOString(),
          protocolName: '',
          mode: 'stable',
          grantedDevicesCount: this.state.grantedDevicesCount,
        });
        this.scheduleRefresh(RETRY_INTERVAL_MS);
        return;
      }

      this.emitState({
        status: hasDevice && isProtocolFailure ? 'unsupported' : 'error',
        message: hasDevice
          ? isProtocolFailure
            ? `直连协议暂未完全适配：${error.message}。当前不会自动反复重试，你可以点击“刷新”或打开设备管理。`
            : `原生 HID 读取异常：${error.message}。请点击“刷新”重试。`
          : `读取设备失败：${error.message}`,
        batteryPercent: this.lastStableSnapshot?.batteryPercent ?? null,
        batteryText: this.lastStableSnapshot?.batteryText ?? '--',
        deviceName: this.lastStableSnapshot?.deviceName || getDeviceProductName(this.currentDevice) || '',
        charging: this.lastStableSnapshot?.charging ?? false,
        needsUserAction: !hasDevice,
        sampledAt: this.lastStableSnapshot?.sampledAt || new Date().toISOString(),
        protocolName: hasDevice ? this.lastStableSnapshot?.protocolName || (isProtocolFailure ? '待补充协议适配' : '') : '',
        mode: 'stable',
        grantedDevicesCount: this.state.grantedDevicesCount,
      });

      if (shouldAutoRetry) {
        this.scheduleRefresh(RETRY_INTERVAL_MS);
        return;
      }

      this.clearPollTimer();
    }
  }

  async dispose() {
    this.clearPollTimer();
    await closeHandle(this.currentHandle);
    this.currentHandle = null;
  }
}

module.exports = {
  NativeBatteryRuntime,
  normalizeDeviceBinding,
  getDeviceBindingKey,
  getLooseDeviceBindingKey,
  getDeviceBindingMatchLevel,
  normalizeDeviceName,
  getDeviceProductName,
  isGenericDeviceName,
  listNativeDevices,
};
