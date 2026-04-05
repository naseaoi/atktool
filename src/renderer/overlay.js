const deviceNameEl = document.getElementById('deviceName');
const batteryTextEl = document.getElementById('batteryText');
const statusTextEl = document.getElementById('statusText');
const updatedAtEl = document.getElementById('updatedAt');
const messageTextEl = document.getElementById('messageText');
const connectButton = document.getElementById('connectButton');
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

function getStatusLabel(status) {
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

function getBatteryTone(percent, charging) {
  if (charging) {
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
    const contentHeight = Math.ceil(panelShellEl.scrollHeight + paddingTop + paddingBottom);

    // 悬浮窗改成按需创建后，继续按内容高度回传，避免每次重开出现底部裁切。
    window.atkOverlay.fitHeight(contentHeight);
  }, 16);
}

function renderState(state) {
  const nextSampledAt = state.sampledAt || '';
  const batteryPercent = normalizeBatteryPercent(state.batteryPercent);

  document.body.dataset.status = state.status || 'loading';
  document.body.dataset.variant = state.overlayVariant || 'full';
  document.body.dataset.batteryTone = getBatteryTone(batteryPercent, state.charging);
  document.body.dataset.batteryFull = batteryPercent === 100 ? 'true' : 'false';
  deviceNameEl.textContent = state.deviceName || '等待连接';
  deviceNameEl.title = state.deviceName || '';
  batteryTextEl.textContent = state.batteryText || '--';
  statusTextEl.textContent = getStatusLabel(state.status);
  updatedAtEl.textContent = formatTime(state.sampledAt);
  messageTextEl.textContent = state.message || '正在准备页面...';
  panelShellEl.style.setProperty('--battery-level', String(batteryPercent ?? 0));
  pinButton.dataset.active = state.alwaysOnTop ? 'true' : 'false';
  pinButton.title = state.alwaysOnTop ? '取消置顶' : '切换置顶';
  pinButton.setAttribute('aria-label', state.alwaysOnTop ? '取消置顶' : '切换置顶');
  switchButton.title = state.overlayVariant === 'compact' ? '切换为完整版' : '切换为简略版';
  switchButton.setAttribute('aria-label', state.overlayVariant === 'compact' ? '切换为完整版' : '切换为简略版');
  connectButton.textContent = state.needsUserAction ? '设备管理' : '查看管理';

  if (nextSampledAt && nextSampledAt !== lastSampledAt) {
    triggerRefreshPulse();
  }

  lastSampledAt = nextSampledAt;
  scheduleFitHeight();
}

connectButton.addEventListener('click', () => {
  window.atkOverlay.openHubWindow();
});

refreshButton.addEventListener('click', async () => {
  await window.atkOverlay.requestRefresh();
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
