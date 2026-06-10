import * as dom from './dom-refs.js';
import { formatTime, getStatusLabel, normalizeOverlayVariant } from './ui-utils.js';

// hid-shared.js 仍以全局 IIFE 挂在 window.AtkHidShared，保持与 overlay 共享不变。
const shared = window.AtkHidShared;

let state = {
  status: 'loading',
  message: '正在准备原生 HID 直连器...',
  batteryPercent: null,
  batteryText: '--',
  deviceName: '',
  charging: false,
  chargeStatus: 'idle',
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

export function getState() {
  return state;
}

export function getPreferences() {
  return preferences;
}

export function setPreferredDevice(nextDevice) {
  preferredDevice = nextDevice || null;
}

export function hasBoundDevice() {
  return Boolean(shared.getDeviceKey(preferredDevice));
}

export function setPendingAction(action) {
  pendingAction = action || '';
  updateActionButtons();
}

export function updateActionButtons() {
  const bound = hasBoundDevice();
  const busy = Boolean(pendingAction);

  dom.authorizeButton.textContent = bound ? '更换绑定设备' : '选择并绑定设备';
  dom.refreshButton.textContent = '刷新当前设备';
  dom.unbindButton.textContent = '解绑当前设备';

  dom.authorizeButton.disabled = busy;
  dom.refreshButton.disabled = busy || !bound;
  dom.unbindButton.disabled = busy || !bound;
  dom.fallbackButton.disabled = busy;
}

export function scheduleFitHeight() {
  if (fitHeightTimer) {
    window.clearTimeout(fitHeightTimer);
  }

  fitHeightTimer = window.setTimeout(() => {
    fitHeightTimer = null;
    const bodyStyle = window.getComputedStyle(document.body);
    const paddingTop = Number.parseFloat(bodyStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(bodyStyle.paddingBottom) || 0;
    const shellHeight = dom.appShellEl ? Math.ceil(dom.appShellEl.scrollHeight) : 0;
    const contentHeight = Math.ceil(shellHeight + paddingTop + paddingBottom);

    // 设备管理页改成按需窗口后，仍然按真实内容高度回传，避免重开时尺寸抖动。
    window.atkManager.fitHeight(contentHeight);
  }, 16);
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

function getChargeStatus(nextState) {
  if (nextState.chargeStatus === 'full') {
    return 'full';
  }

  if (nextState.charging || nextState.chargeStatus === 'charging') {
    return 'charging';
  }

  return 'idle';
}

function getChargeText(nextState) {
  const chargeStatus = getChargeStatus(nextState);

  if (chargeStatus === 'full') {
    return '充电完成';
  }

  if (chargeStatus === 'charging') {
    return '充电中';
  }

  return nextState.batteryPercent === null ? '--' : '未充电';
}

export function applyPreferences(patch) {
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

  dom.startupToggle.dataset.enabled = preferences.openAtLogin ? 'true' : 'false';
  dom.startupToggle.setAttribute('aria-pressed', String(preferences.openAtLogin));
  dom.startupValueEl.textContent = preferences.openAtLogin ? '已开启' : '已关闭';
  dom.startupHintEl.textContent = preferences.openAtLogin
    ? '登录 Windows 后自动启动悬浮窗。'
    : '需要手动双击或从脚本启动。';

  const isCompact = preferences.overlayVariant === 'compact';
  dom.overlayModeToggle.dataset.enabled = isCompact ? 'true' : 'false';
  dom.overlayModeToggle.setAttribute('aria-pressed', String(isCompact));
  dom.overlayModeValueEl.textContent = isCompact ? '简略版' : '完整版';
  dom.overlayModeHintEl.textContent = isCompact
    ? '当前为圆形简略版，仅显示电量数字。'
    : '当前为完整版，显示状态、时间与操作按钮。';

  updateActionButtons();
  scheduleFitHeight();
}

export function applyState(patch) {
  state = {
    ...state,
    ...patch,
  };

  const displayDeviceName = resolveDisplayDeviceName(state.deviceName);

  document.body.dataset.status = state.status || 'loading';
  dom.heroMessageEl.textContent = state.message || '等待采集器完成初始化...';
  dom.heroBatteryEl.textContent = state.batteryText || '--';
  dom.statusChipEl.textContent = getStatusLabel(state.status, hasBoundDevice());
  dom.deviceNameEl.textContent = displayDeviceName || '等待连接';
  dom.modeTextEl.textContent = state.mode === 'fallback' ? '同步官网电量' : '本地 HID 直连';
  dom.protocolTextEl.textContent = state.protocolName || '--';
  dom.updatedAtEl.textContent = formatTime(state.sampledAt);
  dom.grantedCountEl.textContent = String(state.grantedDevicesCount ?? 0);
  dom.chargingTextEl.textContent = getChargeText(state);

  scheduleFitHeight();
}

export function showWaitingForBinding(message) {
  applyState({
    status: 'waiting',
    message,
    batteryPercent: null,
    batteryText: '--',
    deviceName: '',
    charging: false,
    chargeStatus: 'idle',
    needsUserAction: true,
    sampledAt: new Date().toISOString(),
    protocolName: '',
    mode: 'stable',
    grantedDevicesCount: state.grantedDevicesCount,
  });
}
