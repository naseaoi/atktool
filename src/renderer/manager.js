const shared = window.AtkHidShared;

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
const appShellEl = document.querySelector('.app-shell');

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
let preferences = {
  openAtLogin: false,
  displayDeviceName: '',
  overlayVariant: 'full',
};
let pendingAction = '';
let fitHeightTimer = null;
let hidSelection = {
  open: false,
  devices: [],
  selectedDeviceId: '',
  submitting: false,
};
let requestedDeviceBinding = null;

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

  preferences = {
    ...preferences,
    ...patch,
    displayDeviceName: shared.normalizeDeviceName(patch.displayDeviceName ?? preferences.displayDeviceName),
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
  return Boolean(shared.getDeviceKey(preferredDevice));
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

    // 设备管理页改成按需窗口后，仍然按真实内容高度回传，避免重开时尺寸抖动。
    window.atkManager.fitHeight(contentHeight);
  }, 16);
}

function applyState(patch) {
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

  scheduleFitHeight();
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
    grantedDevicesCount: state.grantedDevicesCount,
  });
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
  const devices = shared.sortChooserDevices(Array.isArray(hidSelection.devices) ? hidSelection.devices : []);
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
    const protocolSupport = shared.supportsKnownBatteryProtocol(device);
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

    title.textContent = shared.resolveChooserDeviceName(device);
    topRow.appendChild(title);

    metaRow.textContent = `VID ${shared.formatHexId(device.vendorId)} · PID ${shared.formatHexId(device.productId)}${device.guid ? ` · GUID ${device.guid}` : ''}`;

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

  // 选择面板的数据来自主进程的 select-hid-device 事件，管理页只负责展示与回传所选 deviceId。
  const devices = shared.sortChooserDevices(Array.isArray(payload.devices) ? payload.devices : []);
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
  requestedDeviceBinding = selectedDescriptor ? shared.simplifyDevice(selectedDescriptor) : null;

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

async function authorizeDevice() {
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

  setPendingAction('authorize');

  try {
    await window.atkManager.activateStableSource();
    applyState({
      status: 'authorizing',
      message: hasBoundDevice()
        ? '正在打开设备选择面板，请选择新的鼠标或接收器。'
        : '正在打开设备选择面板，请选择你的鼠标或接收器。',
      needsUserAction: false,
      sampledAt: new Date().toISOString(),
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
    const candidateDevices = shared.mergeUniqueDevices(grantedDevices, knownDevices);
    const selectedDevice = shared.resolveAuthorizedDevice(candidateDevices, requestedDeviceBinding || grantedDevices[0] || null);
    requestedDeviceBinding = null;

    if (selectedDevice) {
      const nextPreferences = await window.atkManager.rememberDevice(shared.simplifyDevice(selectedDevice));
      applyPreferences(nextPreferences);
    }

    applyState({
      status: 'loading',
      message: '设备授权完成，正在建立本地直连...',
      needsUserAction: false,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });
    await window.atkManager.requestRefresh();
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
    applyState({
      status: 'loading',
      message: '正在刷新当前绑定设备...',
      needsUserAction: false,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });
    await window.atkManager.requestRefresh();
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
    const devices = navigator.hid ? await navigator.hid.getDevices().catch(() => []) : [];
    const boundDevice = shared.pickPreferredDevice(devices, preferredDevice);

    if (boundDevice && typeof boundDevice.forget === 'function') {
      await boundDevice.forget().catch(() => {});
    }

    const nextPreferences = await window.atkManager.clearDeviceBinding();
    applyPreferences(nextPreferences);
    showWaitingForBinding('当前设备绑定已解除。如需继续读取电量，请重新选择并绑定设备。');
  } finally {
    setPendingAction('');
  }
}

async function boot() {
  const [initialPreferences, initialOverlayState] = await Promise.all([
    window.atkManager.getPreferences(),
    window.atkManager.getOverlayState(),
  ]);

  preferredDevice = initialPreferences.preferredHidDevice || null;
  applyPreferences(initialPreferences);
  applyState(initialOverlayState);

  window.atkManager.onPreferencesChanged((nextPreferences) => {
    applyPreferences(nextPreferences);
  });
  window.atkManager.onOverlayStateChanged((nextState) => {
    applyState(nextState);
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

  if (!navigator.hid) {
    applyState({
      status: 'error',
      message: '当前 Electron 环境没有打开 WebHID 能力，无法建立稳定直连。',
      needsUserAction: true,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });
  } else if (!hasBoundDevice() && initialOverlayState.status === 'loading') {
    showWaitingForBinding('还没有绑定设备。请先选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
  }
}

boot();
