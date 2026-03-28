const authorizeButton = document.getElementById('authorizeButton');
const refreshButton = document.getElementById('refreshButton');
const unbindButton = document.getElementById('unbindButton');
const fallbackButton = document.getElementById('fallbackButton');
const heroMessageEl = document.getElementById('heroMessage');
const heroBatteryEl = document.getElementById('heroBattery');
const statusChipEl = document.getElementById('statusChip');
const deviceNameEl = document.getElementById('deviceName');
const modeTextEl = document.getElementById('modeText');
const protocolTextEl = document.getElementById('protocolText');
const updatedAtEl = document.getElementById('updatedAt');
const grantedCountEl = document.getElementById('grantedCount');
const chargingTextEl = document.getElementById('chargingText');
const startupToggle = document.getElementById('startupToggle');
const startupValueEl = document.getElementById('startupValue');
const startupHintEl = document.getElementById('startupHint');
const overlayModeToggle = document.getElementById('overlayModeToggle');
const overlayModeValueEl = document.getElementById('overlayModeValue');
const overlayModeHintEl = document.getElementById('overlayModeHint');
const hidPickerBackdrop = document.getElementById('hidPickerBackdrop');
const hidPickerHintEl = document.getElementById('hidPickerHint');
const hidPickerEmptyEl = document.getElementById('hidPickerEmpty');
const hidPickerListEl = document.getElementById('hidPickerList');
const hidPickerCancelButton = document.getElementById('hidPickerCancelButton');
const hidPickerConfirmButton = document.getElementById('hidPickerConfirmButton');

const COMPX_REPORT_ID = 8;
const HECHI_REPORT_ID = 11;
const POLL_INTERVAL_MS = 10000;
const RETRY_INTERVAL_MS = 5000;
const TRANSIENT_FAILURE_LIMIT = 2;
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

let preferredDevice = null;
let currentDevice = null;
let currentDeviceKey = '';
let currentProtocolKey = null;
let refreshNonce = 0;
let pollTimer = null;
let consecutiveReadFailures = 0;
let lastStableSnapshot = null;
let fitHeightTimer = null;
const appShellEl = document.querySelector('.app-shell');
let preferences = {
  openAtLogin: false,
  displayDeviceName: '',
  overlayVariant: 'full',
};
let pendingAction = '';
let hidSelection = {
  open: false,
  devices: [],
  selectedDeviceId: '',
  submitting: false,
};
let requestedDeviceBinding = null;

function normalizeDeviceName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function getDeviceProductName(device) {
  return normalizeDeviceName(device?.productName || device?.name);
}

function sanitizeDeviceNameForDisplay(name, fallbackDevice = null) {
  const normalized = normalizeDeviceName(name)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return `HID 设备 ${formatHexId(fallbackDevice?.vendorId)}:${formatHexId(fallbackDevice?.productId)}`;
  }

  const suspiciousTailMatch = normalized.match(/^([\x20-\x7E]{6,}?)([\u0080-\uFFFF])\2{2,}[\u0080-\uFFFF0-9\s-]*$/);
  if (suspiciousTailMatch) {
    return suspiciousTailMatch[1].trim();
  }

  return normalized;
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

function resolveDisplayDeviceName(name) {
  const normalized = normalizeDeviceName(name);
  const savedName = normalizeDeviceName(preferences.displayDeviceName);
  const boundName = normalizeDeviceName(preferredDevice?.productName);

  if (normalized && !isGenericDeviceName(normalized)) {
    return normalized;
  }

  if (boundName && !isGenericDeviceName(boundName)) {
    return boundName;
  }

  if (savedName && !isGenericDeviceName(savedName)) {
    return savedName;
  }

  if (normalized) {
    return 'ATK 设备';
  }

  return '';
}

function formatTime(isoTime) {
  if (!isoTime) {
    return '--';
  }

  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function getStatusLabel(status) {
  switch (status) {
    case 'connected':
      return '直连成功';
    case 'waiting':
      return hasBoundDevice() ? '待连接' : '待绑定';
    case 'unsupported':
      return '待适配';
    case 'error':
      return '异常';
    case 'authorizing':
      return '授权中';
    default:
      return '加载中';
  }
}

function normalizeOverlayVariant(value) {
  return value === 'compact' ? 'compact' : 'full';
}

function applyPreferences(patch) {
  const hasPreferredDevicePatch = Object.prototype.hasOwnProperty.call(patch, 'preferredHidDevice');

  preferences = {
    ...preferences,
    ...patch,
    displayDeviceName: normalizeDeviceName(patch.displayDeviceName ?? preferences.displayDeviceName),
    overlayVariant: normalizeOverlayVariant(patch.overlayVariant ?? preferences.overlayVariant),
    openAtLogin: Boolean(patch.openAtLogin ?? preferences.openAtLogin),
  };

  if (hasPreferredDevicePatch) {
    preferredDevice = patch.preferredHidDevice || null;
  }

  startupToggle.dataset.enabled = preferences.openAtLogin ? 'true' : 'false';
  startupToggle.setAttribute('aria-pressed', String(preferences.openAtLogin));
  startupValueEl.textContent = preferences.openAtLogin ? '已开启' : '已关闭';
  startupHintEl.textContent = preferences.openAtLogin
    ? '登录 Windows 后自动启动悬浮窗。'
    : '需要手动双击或从脚本启动。';

  const isCompact = preferences.overlayVariant === 'compact';
  overlayModeToggle.dataset.enabled = isCompact ? 'true' : 'false';
  overlayModeToggle.setAttribute('aria-pressed', String(isCompact));
  overlayModeValueEl.textContent = isCompact ? '简略版' : '完整版';
  overlayModeHintEl.textContent = isCompact
    ? '当前为圆形简略版，仅显示电量数字。'
    : '当前为完整版，显示状态、时间与操作按钮。';

  updateActionButtons();
  scheduleFitHeight();
}

function hasBoundDevice() {
  return Boolean(getDeviceKey(preferredDevice));
}

function setPendingAction(action) {
  pendingAction = action || '';
  updateActionButtons();
}

function updateActionButtons() {
  const bound = hasBoundDevice();
  const busy = Boolean(pendingAction);

  authorizeButton.textContent = bound ? '更换绑定设备' : '选择并绑定设备';
  refreshButton.textContent = '刷新当前设备';
  unbindButton.textContent = '解绑当前设备';

  authorizeButton.disabled = busy;
  refreshButton.disabled = busy || !bound;
  unbindButton.disabled = busy || !bound;
  fallbackButton.disabled = busy;
}

function formatHexId(value) {
  if (!Number.isFinite(value)) {
    return '----';
  }

  return value.toString(16).toUpperCase().padStart(4, '0');
}

function getCollectionFlags(device) {
  let hasMouse = false;
  let hasKeyboard = false;

  visitCollections(device?.collections, (collection) => {
    if (collection.usage === 2) {
      hasMouse = true;
    }

    if (collection.usage === 6) {
      hasKeyboard = true;
    }
  });

  return { hasMouse, hasKeyboard };
}

function supportsKnownBatteryProtocol(device) {
  const compxSupport = inspectReportSupport(device, COMPX_REPORT_ID);
  const hechiSupport = inspectReportSupport(device, HECHI_REPORT_ID);

  return {
    compx: compxSupport.hasOutputReport || compxSupport.hasFeatureReport,
    hechi: hechiSupport.hasOutputReport || hechiSupport.hasFeatureReport,
  };
}

function getChooserDisplayScore(device) {
  const productName = getDeviceProductName(device);
  const { hasMouse, hasKeyboard } = getCollectionFlags(device);
  const protocolSupport = supportsKnownBatteryProtocol(device);
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

  if (protocolSupport.compx) {
    score += 42;
  }

  if (protocolSupport.hechi) {
    score += 42;
  }

  if (hasMouse && !hasKeyboard) {
    score += 18;
  } else if (hasMouse && hasKeyboard) {
    score += 2;
  } else if (hasKeyboard) {
    score -= 10;
  }

  score += Number.isFinite(device?.matchLevel) ? device.matchLevel * 120 : 0;
  return score;
}

function sortChooserDevices(devices) {
  return [...devices].sort((left, right) => {
    const scoreDiff = getChooserDisplayScore(right) - getChooserDisplayScore(left);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return resolveChooserDeviceName(left).localeCompare(resolveChooserDeviceName(right), 'zh-CN');
  });
}

function resolveChooserDeviceName(device) {
  const normalized = sanitizeDeviceNameForDisplay(getDeviceProductName(device), device);

  if (normalized) {
    return normalized;
  }

  return `未命名设备 ${formatHexId(device?.vendorId)}:${formatHexId(device?.productId)}`;
}

function closeHidSelectionDialog() {
  hidSelection = {
    open: false,
    devices: [],
    selectedDeviceId: '',
    submitting: false,
  };

  document.body.dataset.dialogOpen = 'false';
  hidPickerBackdrop.hidden = true;
  hidPickerListEl.replaceChildren();
  hidPickerEmptyEl.hidden = true;
  hidPickerConfirmButton.disabled = true;
  hidPickerCancelButton.disabled = false;
}

function renderHidSelectionDialog() {
  const devices = sortChooserDevices(Array.isArray(hidSelection.devices) ? hidSelection.devices : []);
  const hasDevices = devices.length > 0;

  document.body.dataset.dialogOpen = hidSelection.open ? 'true' : 'false';
  hidPickerBackdrop.hidden = !hidSelection.open;

  if (!hidSelection.open) {
    return;
  }

  hidPickerHintEl.textContent = hasBoundDevice()
    ? '请选择新的鼠标或接收器。确认后会把当前绑定切换到所选设备。'
    : '请从下方列表里选择你的鼠标或接收器，再继续绑定。';

  hidPickerEmptyEl.hidden = hasDevices;
  hidPickerListEl.replaceChildren();

  for (const device of devices) {
    const item = document.createElement('button');
    const topRow = document.createElement('div');
    const title = document.createElement('strong');
    const metaRow = document.createElement('div');
    const chipRow = document.createElement('div');
    const protocolSupport = supportsKnownBatteryProtocol(device);
    const chips = [];

    item.type = 'button';
    item.className = 'device-picker-item';
    item.dataset.selected = String(device.deviceId === hidSelection.selectedDeviceId);
    item.disabled = hidSelection.submitting;
    item.addEventListener('click', () => {
      hidSelection = {
        ...hidSelection,
        selectedDeviceId: device.deviceId,
      };
      renderHidSelectionDialog();
    });

    topRow.className = 'device-picker-item__top';
    metaRow.className = 'device-picker-item__meta';
    chipRow.className = 'device-chip-row';

    title.textContent = resolveChooserDeviceName(device);
    topRow.appendChild(title);

    metaRow.textContent = `VID ${formatHexId(device.vendorId)} · PID ${formatHexId(device.productId)}${device.guid ? ` · GUID ${device.guid}` : ''}`;

    if (device.matchLevel === 2) {
      chips.push({ label: '当前绑定', type: 'accent' });
    } else if (device.matchLevel === 1) {
      chips.push({ label: '同类设备', type: 'accent' });
    }

    if (protocolSupport.compx) {
      chips.push({ label: 'COMPX 协议', type: 'accent' });
    }

    if (protocolSupport.hechi) {
      chips.push({ label: 'HECHI 协议', type: 'accent' });
    }

    for (const chip of chips) {
      const chipEl = document.createElement('span');
      chipEl.className = `device-chip${chip.type ? ` device-chip--${chip.type}` : ''}`;
      chipEl.textContent = chip.label;
      chipRow.appendChild(chipEl);
    }

    item.append(topRow, metaRow);
    if (chipRow.childElementCount > 0) {
      item.appendChild(chipRow);
    }

    hidPickerListEl.appendChild(item);
  }

  hidPickerCancelButton.disabled = hidSelection.submitting;
  hidPickerConfirmButton.disabled = hidSelection.submitting || !hidSelection.selectedDeviceId || !hasDevices;
}

function applyHidSelectionPayload(payload) {
  if (!payload?.open) {
    closeHidSelectionDialog();
    return;
  }

  // 选择面板的数据来自主进程的 select-hid-device 事件，renderer 只负责展示与回传所选 deviceId。
  const devices = sortChooserDevices(Array.isArray(payload.devices) ? payload.devices : []);
  const nextSelectedDeviceId = devices.some((device) => device.deviceId === hidSelection.selectedDeviceId)
    ? hidSelection.selectedDeviceId
    : devices[0]?.deviceId || '';

  hidSelection = {
    open: true,
    devices,
    selectedDeviceId: nextSelectedDeviceId,
    submitting: false,
  };

  renderHidSelectionDialog();
}

async function confirmHidSelection() {
  if (!hidSelection.selectedDeviceId || hidSelection.submitting) {
    return;
  }

  const selectedDescriptor = hidSelection.devices.find((device) => device.deviceId === hidSelection.selectedDeviceId) || null;
  requestedDeviceBinding = selectedDescriptor ? simplifyDevice(selectedDescriptor) : null;

  hidSelection = {
    ...hidSelection,
    submitting: true,
  };
  renderHidSelectionDialog();

  const didSubmit = await window.atkManager.pickHidDevice(hidSelection.selectedDeviceId).catch(() => false);
  if (!didSubmit) {
    requestedDeviceBinding = null;
    closeHidSelectionDialog();
    hidSelection = {
      ...hidSelection,
      submitting: false,
    };
    showWaitingForBinding('当前没有可用的待选设备，请重新点击“选择并绑定设备”再试一次。');
  }
}

async function cancelHidSelection() {
  if (hidSelection.submitting) {
    return;
  }

  requestedDeviceBinding = null;

  hidSelection = {
    ...hidSelection,
    submitting: true,
  };
  renderHidSelectionDialog();
  const didCancel = await window.atkManager.cancelHidSelection().catch(() => false);

  if (!didCancel) {
    closeHidSelectionDialog();
    showWaitingForBinding('设备选择已取消。需要时可重新点击“选择并绑定设备”。');
  }
}

function scheduleFitHeight() {
  if (fitHeightTimer) {
    window.clearTimeout(fitHeightTimer);
  }

  fitHeightTimer = window.setTimeout(() => {
    fitHeightTimer = null;
    const bodyStyle = window.getComputedStyle(document.body);
    const paddingTop = Number.parseFloat(bodyStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(bodyStyle.paddingBottom) || 0;
    const shellHeight = appShellEl ? Math.ceil(appShellEl.scrollHeight) : 0;
    const contentHeight = Math.ceil(shellHeight + paddingTop + paddingBottom);

    // 直接按内容真实高度回传，避免窗口高度参与测量后反复把底部越撑越高。
    window.atkManager.fitHeight(contentHeight);
  }, 16);
}

function applyState(patch, options = {}) {
  const { syncMain = true } = options;

  state = {
    ...state,
    ...patch,
  };
  const displayDeviceName = resolveDisplayDeviceName(state.deviceName);

  document.body.dataset.status = state.status || 'loading';
  heroMessageEl.textContent = state.message || '等待采集器完成初始化...';
  heroBatteryEl.textContent = state.batteryText || '--';
  statusChipEl.textContent = getStatusLabel(state.status);
  deviceNameEl.textContent = displayDeviceName || '等待连接';
  modeTextEl.textContent = state.mode === 'fallback' ? '同步官网电量' : '本地 HID 直连';
  protocolTextEl.textContent = state.protocolName || '--';
  updatedAtEl.textContent = formatTime(state.sampledAt);
  grantedCountEl.textContent = String(state.grantedDevicesCount ?? 0);
  chargingTextEl.textContent = state.charging ? '充电中' : state.batteryPercent === null ? '--' : '未充电';

  if (syncMain) {
    window.atkManager.updateState({
      status: state.status,
      message: state.message,
      batteryPercent: state.batteryPercent,
      batteryText: state.batteryText,
      deviceName: displayDeviceName,
      charging: state.charging,
      needsUserAction: state.needsUserAction,
      sampledAt: state.sampledAt,
      protocolName: state.protocolName,
      mode: state.mode,
    });
  }

  scheduleFitHeight();
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

function scheduleRefresh(delay = POLL_INTERVAL_MS) {
  if (state.mode === 'fallback') {
    clearPollTimer();
    return;
  }

  clearPollTimer();
  pollTimer = window.setTimeout(() => {
    refreshDevices();
  }, delay);
}

function normalizeCollectionSignature(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildCollectionSignature(device) {
  // 同一接收器可能暴露多个同名 HID 接口，这里把 collection/report 结构压成签名方便精确记忆。
  const signatures = [];

  visitCollections(device?.collections, (collection) => {
    const inputReports = Array.isArray(collection.inputReports)
      ? collection.inputReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';
    const outputReports = Array.isArray(collection.outputReports)
      ? collection.outputReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';
    const featureReports = Array.isArray(collection.featureReports)
      ? collection.featureReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';

    signatures.push([
      collection.usagePage ?? '',
      collection.usage ?? '',
      inputReports,
      outputReports,
      featureReports,
    ].join('/'));
  });

  return signatures.sort().join('|');
}

function startStableRefresh(message) {
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

function getBoundDevice(devices, preferredCandidate = preferredDevice) {
  return pickPreferredDevice(devices, preferredCandidate);
}

function showWaitingForBinding(message) {
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
  });
}

function visitCollections(collections, visitor) {
  for (const collection of Array.isArray(collections) ? collections : []) {
    visitor(collection);
    visitCollections(collection.children, visitor);
  }
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

  visitCollections(device?.collections, (collection) => {
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

function simplifyDevice(device) {
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: getDeviceProductName(device),
    collectionSignature: normalizeCollectionSignature(device.collectionSignature) || buildCollectionSignature(device),
  };
}

function getLooseDeviceKey(device) {
  if (!device) {
    return '';
  }

  return [device.vendorId, device.productId, getDeviceProductName(device)].join(':');
}

function getDeviceKey(device) {
  if (!device) {
    return '';
  }

  return [
    device.vendorId,
    device.productId,
    getDeviceProductName(device),
    normalizeCollectionSignature(device.collectionSignature) || buildCollectionSignature(device),
  ].join(':');
}

function getDeviceMatchLevel(left, right) {
  const exactLeft = getDeviceKey(left);
  const exactRight = getDeviceKey(right);

  if (exactLeft && exactLeft === exactRight) {
    return 2;
  }

  const looseLeft = getLooseDeviceKey(left);
  const looseRight = getLooseDeviceKey(right);

  if (looseLeft && looseLeft === looseRight) {
    return 1;
  }

  return 0;
}

function pickPreferredDevice(devices, preferredCandidate = null) {
  const preferredKey = getDeviceKey(preferredCandidate);

  if (!preferredKey) {
    return null;
  }

  return devices.find((device) => getDeviceKey(device) === preferredKey) || null;
}

function pickLooseMatchedDevices(devices, preferredCandidate = null) {
  const preferredKey = getLooseDeviceKey(preferredCandidate);

  if (!preferredKey) {
    return [];
  }

  return devices.filter((device) => getLooseDeviceKey(device) === preferredKey);
}

function getDeviceScore(device) {
  const productName = getDeviceProductName(device);
  const { hasMouse, hasKeyboard } = getCollectionFlags(device);
  const protocolSupport = supportsKnownBatteryProtocol(device);
  let score = 0;

  if (preferredDevice) {
    score += getDeviceMatchLevel(preferredDevice, device) * 80;
  }

  if (/virtual multitouch/i.test(productName)) {
    score -= 40;
  }

  if (/ATK|VXE/i.test(productName)) {
    score += 32;
  }

  if (/mouse|鼠标|F1|X1|R1/i.test(productName)) {
    score += 26;
  }

  if (/dongle|receiver|nano|2\.4/i.test(productName)) {
    score += 14;
  }

  if (/keyboard/i.test(productName)) {
    score -= 18;
  }

  if (hasMouse && !hasKeyboard) {
    score += 18;
  } else if (hasMouse && hasKeyboard) {
    score += 2;
  } else if (hasKeyboard) {
    score -= 10;
  }

  if (protocolSupport.compx) {
    score += 42;
  }

  if (protocolSupport.hechi) {
    score += 42;
  }

  return score;
}

function chooseDevice(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return null;
  }

  return [...devices]
    .map((device) => ({ device, score: getDeviceScore(device) }))
    .sort((left, right) => right.score - left.score)[0]?.device || null;
}

function resolveDevice(devices, preferredCandidate = null) {
  const exactMatch = pickPreferredDevice(devices, preferredCandidate);

  if (exactMatch) {
    return exactMatch;
  }

  const looseMatches = pickLooseMatchedDevices(devices, preferredCandidate);
  if (looseMatches.length > 0) {
    return chooseDevice(looseMatches);
  }

  return chooseDevice(devices);
}

function mergeUniqueDevices(...deviceLists) {
  const deviceMap = new Map();

  for (const deviceList of deviceLists) {
    for (const device of Array.isArray(deviceList) ? deviceList : []) {
      const key = getDeviceKey(device) || `${device?.vendorId}:${device?.productId}:${getDeviceProductName(device)}`;

      if (key) {
        deviceMap.set(key, device);
      }
    }
  }

  return Array.from(deviceMap.values());
}

function resolveAuthorizedDevice(devices, requestedBinding = null) {
  const exactMatch = pickPreferredDevice(devices, requestedBinding);
  const exactProtocolSupport = exactMatch ? supportsKnownBatteryProtocol(exactMatch) : { compx: false, hechi: false };

  // 用户手动选的是某个物理设备时，优先在同一设备族里挑出真正暴露已知电量协议的 HID 接口，避免选中键盘/通用接口后又被误绑。
  if (exactMatch && (exactProtocolSupport.compx || exactProtocolSupport.hechi)) {
    return exactMatch;
  }

  const looseMatches = pickLooseMatchedDevices(devices, requestedBinding);
  const supportedLooseMatch = chooseDevice(
    looseMatches.filter((device) => {
      const protocolSupport = supportsKnownBatteryProtocol(device);
      return protocolSupport.compx || protocolSupport.hechi;
    })
  );

  if (supportedLooseMatch) {
    return supportedLooseMatch;
  }

  if (exactMatch) {
    return exactMatch;
  }

  if (looseMatches.length > 0) {
    return chooseDevice(looseMatches);
  }

  if (devices.length === 1) {
    return devices[0];
  }

  return chooseDevice(devices);
}

async function openDevice(device, forceReopen = false) {
  if (!device) {
    throw new Error('未找到可用设备');
  }

  const nextDeviceKey = getDeviceKey(device);
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
  preferredDevice = simplifyDevice(device);
  window.atkManager.rememberDevice(preferredDevice);
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

  let sum = COMPX_REPORT_ID;
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
        COMPX_REPORT_ID,
        buildCompxBatteryRequest(),
        (event) => event.reportId === COMPX_REPORT_ID && event.data.byteLength >= 7 && event.data.getUint8(0) === 4
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
        HECHI_REPORT_ID,
        buildHechiMouseInfoRequest(),
        (event) => event.reportId === HECHI_REPORT_ID && event.data.byteLength >= 18 && event.data.getUint8(0) === 19
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
  // 先尝试上一次成功的协议，再按已知协议顺序回退，尽量缩短启动时间。
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
    if (nonce !== refreshNonce) {
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
          : '还没有绑定设备。请先选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。'
      );
      return;
    }

    await openDevice(device, forceReopen);
    if (nonce !== refreshNonce) {
      return;
    }

    const allowProtocolFallback = forceReopen || !currentProtocolKey || consecutiveReadFailures >= PROTOCOL_RESET_FAILURE_LIMIT;
    const result = await readBatteryWithRecovery(device, { allowProtocolFallback });
    if (nonce !== refreshNonce) {
      return;
    }

    consecutiveReadFailures = 0;
    lastStableSnapshot = {
      batteryPercent: result.batteryPercent,
      batteryText: `${result.batteryPercent}%`,
      charging: result.charging,
      deviceName: getDeviceProductName(device) || 'ATK 设备',
      sampledAt: new Date().toISOString(),
      protocolName: result.protocolName,
    };

    applyState({
      status: 'connected',
      message: '本地 WebHID 直连已建立，后续启动会优先直接读鼠标电量。',
      ...lastStableSnapshot,
      needsUserAction: false,
      mode: 'stable',
      grantedDevicesCount: devices.length,
    });

    scheduleRefresh();
  } catch (error) {
    if (nonce !== refreshNonce) {
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
          ? `直连协议暂未完全适配：${error.message}。当前不会自动反复重试，你可以点击“刷新当前设备”或“同步官网电量”。`
          : shouldAutoRetry
            ? `本地直连读取异常：${error.message}。正在自动重试，你也可以手动刷新。`
            : `本地直连读取异常：${error.message}。请点击“刷新当前设备”重试。`
        : `读取设备失败：${error.message}`,
      batteryPercent: lastStableSnapshot?.batteryPercent ?? null,
      batteryText: lastStableSnapshot?.batteryText ?? '--',
      deviceName: lastStableSnapshot?.deviceName || getDeviceProductName(currentDevice) || '',
      charging: lastStableSnapshot?.charging ?? false,
      needsUserAction: !hasDevice,
      sampledAt: lastStableSnapshot?.sampledAt || new Date().toISOString(),
      protocolName: hasDevice ? lastStableSnapshot?.protocolName || (isProtocolFailure ? '待补充协议适配' : '') : '',
      mode: hasDevice ? 'stable' : state.mode,
    });

    if (shouldAutoRetry) {
      scheduleRefresh(RETRY_INTERVAL_MS);
      return;
    }

    clearPollTimer();
  }
}

async function authorizeDevice() {
  setPendingAction('authorize');

  try {
    await window.atkManager.activateStableSource();
    applyState({
      status: 'authorizing',
      message: hasBoundDevice()
        ? '正在打开设备选择面板，请选择新的鼠标或接收器。'
        : '正在打开设备选择面板，请选择你的鼠标或接收器。',
      needsUserAction: false,
      mode: 'stable',
    });

    await window.atkManager.beginHidSelection();
    const grantedDevices = await navigator.hid.requestDevice({ filters: [] });
    if (!grantedDevices.length) {
      requestedDeviceBinding = null;
      showWaitingForBinding(
        hasBoundDevice()
          ? '本次没有选择新设备，当前仍保留原绑定。若鼠标未出现，请确认它使用的是 2.4G 接收器或有线连接。'
          : '本次没有选中设备。若鼠标未出现，请确认它使用的是 2.4G 接收器或有线连接。'
      );
      return;
    }

    const knownDevices = await navigator.hid.getDevices().catch(() => []);
    const candidateDevices = mergeUniqueDevices(grantedDevices, knownDevices);
    const selectedDevice = resolveAuthorizedDevice(candidateDevices, requestedDeviceBinding || grantedDevices[0] || null);
    requestedDeviceBinding = null;

    if (selectedDevice) {
      preferredDevice = simplifyDevice(selectedDevice);
      window.atkManager.rememberDevice(preferredDevice);
    }

    startStableRefresh('设备授权完成，正在建立本地直连...');
    await refreshDevices({
      forceReopen: true,
      preferredDeviceHint: selectedDevice,
      explicitDevice: selectedDevice,
    });
  } catch (error) {
    requestedDeviceBinding = null;
    applyState({
      status: 'error',
      message: `设备授权失败：${error.message}`,
      needsUserAction: true,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });
  } finally {
    await window.atkManager.endHidSelection().catch(() => {});
    setPendingAction('');
  }
}

async function refreshBoundDevice() {
  await window.atkManager.activateStableSource();

  if (!hasBoundDevice()) {
    showWaitingForBinding('当前还没有绑定设备，请先选择并绑定设备。');
    return;
  }

  setPendingAction('refresh');

  try {
    startStableRefresh('正在刷新当前绑定设备...');
    await refreshDevices({ forceReopen: true, preferredDeviceHint: preferredDevice });
  } finally {
    setPendingAction('');
  }
}

async function unbindCurrentDevice() {
  if (!hasBoundDevice()) {
    showWaitingForBinding('当前还没有绑定设备，请先选择并绑定设备。');
    return;
  }

  setPendingAction('unbind');

  try {
    const devices = await navigator.hid.getDevices();
    const boundDevice = getBoundDevice(devices, preferredDevice) || currentDevice;

    if (boundDevice && typeof boundDevice.forget === 'function') {
      await boundDevice.forget().catch(() => {});
    }

    const nextPreferences = await window.atkManager.clearDeviceBinding();
    resetCurrentDeviceState({ clearPreferred: true });
    applyPreferences(nextPreferences);
    showWaitingForBinding('当前设备绑定已解除。如需继续读取电量，请重新选择并绑定设备。');
  } finally {
    setPendingAction('');
  }
}

function handleDisconnect(event) {
  if (state.mode === 'fallback') {
    return;
  }

  if (!currentDevice) {
    return;
  }

  const isCurrent =
    getDeviceKey(event.device) === currentDeviceKey ||
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
  if (state.mode === 'fallback') {
    return;
  }

  if (!hasBoundDevice()) {
    return;
  }

  refreshDevices({ forceReopen: true, preferredDeviceHint: preferredDevice });
}

async function boot() {
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

  const initialPreferences = await window.atkManager.getPreferences();
  preferredDevice = initialPreferences.preferredHidDevice || null;
  applyPreferences(initialPreferences);

  navigator.hid.addEventListener('disconnect', handleDisconnect);
  navigator.hid.addEventListener('connect', handleConnect);
  window.atkManager.onPreferencesChanged((nextPreferences) => {
    applyPreferences(nextPreferences);
  });
  window.atkManager.onOverlayStateChanged((nextState) => {
    if (nextState?.mode === 'fallback') {
      refreshNonce += 1;
      clearPollTimer();
      applyState(nextState, { syncMain: false });
    }
  });
  window.atkManager.onRefreshRequested(async () => {
    await refreshBoundDevice();
  });
  window.atkManager.onHidSelectionChanged((payload) => {
    applyHidSelectionPayload(payload);
  });

  refreshButton.addEventListener('click', () => {
    refreshBoundDevice();
  });

  authorizeButton.addEventListener('click', () => {
    authorizeDevice();
  });

  unbindButton.addEventListener('click', () => {
    unbindCurrentDevice();
  });

  fallbackButton.addEventListener('click', () => {
    window.atkManager.openFallback();
  });

  hidPickerCancelButton.addEventListener('click', () => {
    cancelHidSelection();
  });

  hidPickerConfirmButton.addEventListener('click', () => {
    confirmHidSelection();
  });

  hidPickerBackdrop.addEventListener('click', (event) => {
    if (event.target === hidPickerBackdrop) {
      cancelHidSelection();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && hidSelection.open) {
      event.preventDefault();
      cancelHidSelection();
    }
  });

  startupToggle.addEventListener('click', async () => {
    startupToggle.disabled = true;

    try {
      const nextPreferences = await window.atkManager.setOpenAtLogin(!preferences.openAtLogin);
      applyPreferences(nextPreferences);
    } finally {
      startupToggle.disabled = false;
    }
  });

  overlayModeToggle.addEventListener('click', async () => {
    overlayModeToggle.disabled = true;

    try {
      const nextVariant = preferences.overlayVariant === 'compact' ? 'full' : 'compact';
      const nextPreferences = await window.atkManager.setOverlayVariant(nextVariant);
      applyPreferences(nextPreferences);
    } finally {
      overlayModeToggle.disabled = false;
    }
  });

  updateActionButtons();
  scheduleFitHeight();

  if (hasBoundDevice()) {
    await refreshDevices({ preferredDeviceHint: preferredDevice });
  } else {
    showWaitingForBinding('还没有绑定设备。请先选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
  }
}

boot();
