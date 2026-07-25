const deviceNameEl = document.getElementById('deviceName');
const batteryTextEl = document.getElementById('batteryText');
const statusTextEl = document.getElementById('statusText');
const batteryStateTextEl = document.getElementById('batteryStateText');
const updatedAtEl = document.getElementById('updatedAt');
const batteryBarEl = document.getElementById('batteryBar');
const messageTextEl = document.getElementById('messageText');
const refreshButton = document.getElementById('refreshButton');
const pinButton = document.getElementById('pinButton');
const switchButton = document.getElementById('switchButton');
const panelEl = document.querySelector('.panel');
const panelShellEl = document.getElementById('panelShell');

let lastSampledAt = '';
let refreshPulseTimer = null;
let fitHeightTimer = null;

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

function getChargeStatus(state) {
  if (state?.chargeStatus === 'full') {
    return 'full';
  }

  if (state?.charging || state?.chargeStatus === 'charging') {
    return 'charging';
  }

  return 'idle';
}

function getStatusLabel(status, chargeStatus) {
  if (status === 'connected' && chargeStatus === 'full') {
    return '充电完成';
  }

  if (status === 'connected' && chargeStatus === 'charging') {
    return '充电中';
  }

  switch (status) {
    case 'connected':
      return '已连接';
    case 'unsupported':
      return '待适配';
    case 'waiting':
      return '待授权';
    case 'error':
      return '异常';
    default:
      return '加载中';
  }
}

function normalizeBatteryPercent(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function getBatteryTone(percent, chargeStatus) {
  if (chargeStatus === 'charging') {
    return 'charging';
  }

  if (percent === null) {
    return 'idle';
  }

  if (percent <= 20) {
    return 'low';
  }

  if (percent <= 55) {
    return 'medium';
  }

  return 'high';
}

function getBatteryStateLabel(percent, chargeStatus) {
  if (chargeStatus === 'full' || percent === 100) {
    return '电量已满';
  }

  if (chargeStatus === 'charging') {
    return '正在充电';
  }

  if (percent === null) {
    return '等待电量';
  }

  if (percent <= 20) {
    return '电量偏低';
  }

  if (percent <= 55) {
    return '电量适中';
  }

  return '电量充足';
}

function triggerRefreshPulse() {
  if (refreshPulseTimer) {
    window.clearTimeout(refreshPulseTimer);
  }

  // 先移除再强制回流，确保每次拿到新采样时间都能重新触发一圈流光动画。
  document.body.classList.remove('refresh-pulse');
  void document.body.offsetWidth;
  document.body.classList.add('refresh-pulse');

  refreshPulseTimer = window.setTimeout(() => {
    document.body.classList.remove('refresh-pulse');
  }, 1220);
}

function scheduleFitHeight() {
  if (fitHeightTimer) {
    window.clearTimeout(fitHeightTimer);
  }

  fitHeightTimer = window.setTimeout(() => {
    fitHeightTimer = null;

    if (document.body.dataset.variant === 'compact' || !panelEl || !panelShellEl) {
      return;
    }

    const panelStyle = window.getComputedStyle(panelEl);
    const paddingTop = Number.parseFloat(panelStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(panelStyle.paddingBottom) || 0;
    const shellHeight = panelShellEl.getBoundingClientRect().height;
    const contentHeight = Math.ceil(shellHeight + paddingTop + paddingBottom);

    // 悬浮窗改成按需创建后，继续按内容高度回传，避免每次重开出现底部裁切。
    window.atkOverlay.fitHeight(contentHeight);
  }, 16);
}

function renderState(state) {
  const nextSampledAt = state.sampledAt || '';
  const batteryPercent = normalizeBatteryPercent(state.batteryPercent);
  const chargeStatus = getChargeStatus(state);

  document.body.dataset.status = state.status || 'loading';
  document.body.dataset.variant = state.overlayVariant || 'full';
  document.body.dataset.batteryTone = getBatteryTone(batteryPercent, chargeStatus);
  deviceNameEl.textContent = state.deviceName || '等待连接';
  deviceNameEl.title = state.deviceName || '';
  batteryTextEl.textContent = state.batteryText || '--';
  statusTextEl.textContent = getStatusLabel(state.status, chargeStatus);
  batteryStateTextEl.textContent = getBatteryStateLabel(batteryPercent, chargeStatus);
  updatedAtEl.textContent = formatTime(state.sampledAt);
  updatedAtEl.dateTime = state.sampledAt || '';
  messageTextEl.textContent = state.message || '正在准备页面...';
  panelShellEl.style.setProperty('--battery-level', `${batteryPercent ?? 0}%`);
  if (batteryPercent === null) {
    batteryBarEl.removeAttribute('aria-valuenow');
    batteryBarEl.setAttribute('aria-valuetext', '电量未知');
  } else {
    batteryBarEl.setAttribute('aria-valuenow', String(batteryPercent));
    batteryBarEl.setAttribute('aria-valuetext', `${batteryPercent}%`);
  }
  pinButton.dataset.active = state.alwaysOnTop ? 'true' : 'false';
  pinButton.title = state.alwaysOnTop ? '取消置顶' : '切换置顶';
  pinButton.setAttribute('aria-label', state.alwaysOnTop ? '取消置顶' : '切换置顶');
  switchButton.title = state.overlayVariant === 'compact' ? '切换为完整版' : '切换为简略版';
  switchButton.setAttribute('aria-label', state.overlayVariant === 'compact' ? '切换为完整版' : '切换为简略版');

  if (nextSampledAt && nextSampledAt !== lastSampledAt) {
    triggerRefreshPulse();
  }

  lastSampledAt = nextSampledAt;
  scheduleFitHeight();
}

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  try {
    await window.atkOverlay.requestRefresh();
  } finally {
    refreshButton.disabled = false;
  }
});

pinButton.addEventListener('click', async () => {
  const state = await window.atkOverlay.togglePin();
  renderState(state);
});

switchButton.addEventListener('click', async () => {
  const state = await window.atkOverlay.toggleVariant();
  renderState(state);
});

panelShellEl.addEventListener('click', async (event) => {
  if (document.body.dataset.variant !== 'compact') {
    return;
  }

  if (event.target.closest('.no-drag')) {
    return;
  }

  const state = await window.atkOverlay.toggleVariant();
  renderState(state);
});

window.addEventListener('resize', () => {
  scheduleFitHeight();
});

async function boot() {
  const initialState = await window.atkOverlay.getInitialState();
  renderState(initialState);

  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      scheduleFitHeight();
    });
  }

  window.atkOverlay.onStateChange((state) => {
    renderState(state);
  });
}

boot();
