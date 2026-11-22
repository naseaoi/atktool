import * as dom from './dom-refs.js';
import { formatTime, getStatusChip, normalizeOverlayVariant } from './ui-utils.js';

const shared = window.AtkHidShared;
const batteryView = window.AtkBatteryView;

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
  hubSync: false,
};
let pendingAction = '';
let fitHeightTimer = null;
let lastFitHeight = 0;

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
  const hubSync = Boolean(preferences.hubSync);

  dom.authorizeButton.textContent = bound ? '更换设备' : '选择并绑定设备';
  dom.fallbackLabelEl.textContent = hubSync ? '正在同步官网电量' : '同步官网电量';
  dom.fallbackButton.setAttribute('aria-pressed', String(hubSync));
  dom.fallbackButton.title = hubSync ? '点击停止同步官网电量' : '直连不可用时，从官网驱动页同步电量';

  dom.authorizeButton.disabled = busy;
  dom.refreshButton.disabled = busy || (!bound && !hubSync);
  dom.unbindButton.disabled = busy || !bound;
  dom.fallbackButton.disabled = busy;
}

function measureContentHeight() {
  const bodyStyle = window.getComputedStyle(document.body);
  const padding = (Number.parseFloat(bodyStyle.paddingTop) || 0) + (Number.parseFloat(bodyStyle.paddingBottom) || 0);
  return Math.ceil(dom.appShellEl.scrollHeight + padding);
}

// 设备卡各状态高度一致，正常情况下只在首次显示和窗口宽度变化导致换行时才会上报新高度。
export function fitHeight() {
  window.clearTimeout(fitHeightTimer);
  fitHeightTimer = null;
  const height = measureContentHeight();
  if (height === lastFitHeight) {
    return;
  }
  lastFitHeight = height;
  window.atkManager.fitHeight(height);
}

export function scheduleFitHeight() {
  window.clearTimeout(fitHeightTimer);
  fitHeightTimer = window.setTimeout(fitHeight, 16);
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

  return normalized || boundName || savedName;
}

function setPressed(buttons, isPressed) {
  for (const button of buttons) {
    button.setAttribute('aria-pressed', String(isPressed(button)));
  }
}

export function renderOpacity(value) {
  dom.opacityInput.value = value;
  dom.opacityValue.textContent = `${value}%`;
  const min = Number(dom.opacityInput.min);
  const max = Number(dom.opacityInput.max);
  dom.opacityInput.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
}

function resolveChip(view) {
  if (view.chargeStatus === 'charging') {
    return { text: '充电中', icon: 'bolt', kind: 'tone' };
  }
  if (view.chargeStatus === 'full') {
    return { text: '已充满', icon: 'plug', kind: 'tone' };
  }
  if (view.online && view.tone === 'critical') {
    return { text: '电量极低', icon: 'alert', kind: 'error' };
  }
  if (view.online && view.tone === 'low') {
    return { text: '电量低', icon: 'alert', kind: 'warn' };
  }
  return getStatusChip(view.status, hasBoundDevice());
}

function renderChip(chip) {
  dom.statusChipEl.dataset.icon = chip.icon;
  dom.statusChipEl.dataset.kind = chip.kind;
  dom.statusChipTextEl.textContent = chip.text;
}

function describeDetail(view) {
  if (view.online) {
    if (view.estimateText) {
      return view.estimateText;
    }
    if (view.chargeStatus === 'charging') {
      return '正在估算充满时间';
    }
    return view.chargeStatus === 'full' ? '' : '正在估算剩余时间';
  }
  const parts = [];
  if (view.percent !== null && state.lastSampledAt) {
    parts.push(`${batteryView.formatAgo(state.lastSampledAt)}的读数`);
  }
  if (state.message) {
    parts.push(state.message);
  }
  return parts.join(' · ');
}

export function applyPreferences(patch) {
  const hasPreferredDevicePatch = Object.prototype.hasOwnProperty.call(patch, 'preferredHidDevice');

  preferences = {
    ...preferences,
    ...patch,
    displayDeviceName: shared.normalizeDeviceName(patch.displayDeviceName ?? preferences.displayDeviceName),
    overlayVariant: normalizeOverlayVariant(patch.overlayVariant ?? preferences.overlayVariant),
    openAtLogin: Boolean(patch.openAtLogin ?? preferences.openAtLogin),
    hubSync: Boolean(patch.hubSync ?? preferences.hubSync),
  };

  if (hasPreferredDevicePatch) {
    preferredDevice = patch.preferredHidDevice || null;
  }

  setPressed(dom.variantButtons, (button) => button.dataset.variant === preferences.overlayVariant);
  setPressed(dom.sizeButtons, (button) => button.dataset.size === preferences.overlaySize);
  setPressed(dom.preferenceToggles, (button) => Boolean(preferences[button.dataset.pref]));
  dom.startupToggle.setAttribute('aria-pressed', String(preferences.openAtLogin));
  renderOpacity(preferences.overlayOpacity);

  updateActionButtons();
  scheduleFitHeight();
}

export function applyState(patch) {
  state = {
    ...state,
    ...patch,
  };

  const displayDeviceName = resolveDisplayDeviceName(state.deviceName);
  const view = batteryView.describeBattery(state);
  const body = document.body;

  body.dataset.status = view.status;
  body.dataset.tone = view.tone;
  body.dataset.offline = String(!view.online);
  body.dataset.empty = String(view.percent === null);
  body.dataset.charging = String(view.chargeStatus === 'charging');

  dom.deviceNameEl.textContent = displayDeviceName || (hasBoundDevice() ? '等待连接' : '未绑定设备');
  dom.deviceNameEl.title = displayDeviceName;
  renderChip(resolveChip(view));
  dom.batteryValueEl.textContent = view.percent === null ? '--' : String(view.percent);
  dom.batteryMeterEl.style.setProperty('--level', `${view.percent ?? 0}%`);
  if (view.percent === null) {
    dom.batteryMeterEl.removeAttribute('aria-valuenow');
    dom.batteryMeterEl.setAttribute('aria-valuetext', '电量未知');
  } else {
    dom.batteryMeterEl.setAttribute('aria-valuenow', String(view.percent));
    dom.batteryMeterEl.setAttribute('aria-valuetext', `${view.percent}%`);
  }
  const detail = describeDetail(view);
  dom.detailTextEl.textContent = detail;
  dom.detailTextEl.title = detail;

  dom.modeTextEl.textContent = state.mode === 'fallback' ? '官网同步' : '本地 HID 直连';
  dom.protocolTextEl.textContent = state.protocolName || '--';
  dom.updatedAtEl.textContent = formatTime(state.sampledAt);
  dom.grantedCountEl.textContent = String(state.grantedDevicesCount ?? 0);

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
