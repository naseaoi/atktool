const panelEl = document.getElementById('panel');
const cardEl = document.getElementById('card');
const deviceNameEl = document.getElementById('deviceName');
const batteryValueEl = document.getElementById('batteryValue');
const statusChipEl = document.getElementById('statusChip');
const statusChipTextEl = document.getElementById('statusChipText');
const batteryMeterEl = document.getElementById('batteryMeter');
const detailTextEl = document.getElementById('detailText');
const managerButton = document.getElementById('managerButton');
const menuButton = document.getElementById('menuButton');
const capsuleFillEl = document.getElementById('capsuleFill');
const capsuleValueEl = document.getElementById('capsuleValue');

const CAPSULE_FILL_WIDTH = 16.5;
const SIZE_ZOOM = { small: 0.9, medium: 1, large: 1.2 };

const STATUS_CHIPS = {
  loading: { text: '连接中', icon: 'dot', kind: 'neutral' },
  waiting: { text: '未连接', icon: 'dot', kind: 'neutral' },
  unsupported: { text: '待适配', icon: 'alert', kind: 'warn' },
  error: { text: '读取异常', icon: 'alert', kind: 'error' },
};

let currentState = null;
let lastSampledAt = '';
let pulseTimer = null;
let lastFitSize = '';

const { describeBattery, formatAgo } = window.AtkBatteryView;

// 把后端状态归纳成界面需要的一份视图，完整版与胶囊共用。
function describe(state) {
  const { status, online, percent, chargeStatus, estimateText, tone } = describeBattery(state);

  let chip = online ? null : STATUS_CHIPS[status] || STATUS_CHIPS.waiting;
  if (chargeStatus === 'charging') {
    chip = { text: '充电中', icon: 'bolt', kind: 'tone' };
  } else if (chargeStatus === 'full') {
    chip = { text: '已充满', icon: 'plug', kind: 'tone' };
  } else if (online && tone === 'critical') {
    chip = { text: '电量极低', icon: 'alert', kind: 'error' };
  } else if (online && tone === 'low') {
    chip = { text: '电量低', icon: 'alert', kind: 'warn' };
  }

  let detail;
  if (online) {
    const updated = `${formatAgo(state.sampledAt)}更新`;
    detail = estimateText ? `${estimateText} · ${updated}` : updated;
  } else if (percent !== null && state.lastSampledAt) {
    detail = `${formatAgo(state.lastSampledAt)}的读数`;
  } else {
    detail = state.message || '';
  }

  return {
    status,
    online,
    percent,
    chargeStatus,
    estimateText,
    tone,
    chip,
    detail,
    deviceName: state.deviceName || '未绑定设备',
    needsManager: ['waiting', 'unsupported', 'error'].includes(status),
  };
}

function capsuleTooltip(view, state) {
  const lines = [view.deviceName];
  if (view.online) {
    const summary = [`${view.percent}%`];
    if (view.chip) {
      summary.push(view.chip.text);
    }
    if (view.estimateText) {
      summary.push(view.estimateText);
    }
    lines.push(summary.join(' · '));
  } else {
    lines.push(view.chip.text);
  }
  if (view.detail && view.detail !== lines[1]) {
    lines.push(view.detail);
  }
  if (!view.online && state.message) {
    lines.push(state.message);
  }
  return lines.join('\n');
}

function renderChip(chip) {
  statusChipEl.hidden = !chip;
  if (!chip) {
    return;
  }
  statusChipEl.dataset.icon = chip.icon;
  statusChipEl.dataset.kind = chip.kind;
  statusChipTextEl.textContent = chip.text;
}

function triggerPulse() {
  window.clearTimeout(pulseTimer);
  // 先移除再强制回流，确保连续采样也能重新播放扫光。
  cardEl.classList.remove('is-pulsing');
  void cardEl.offsetWidth;
  cardEl.classList.add('is-pulsing');
  pulseTimer = window.setTimeout(() => cardEl.classList.remove('is-pulsing'), 950);
}

function render(state) {
  currentState = state;
  const view = describe(state);
  const body = document.body;
  const variant = state.overlayVariant === 'compact' ? 'compact' : 'full';
  const size = SIZE_ZOOM[state.overlaySize] ? state.overlaySize : 'medium';
  const opacity = Number.isFinite(state.overlayOpacity) ? state.overlayOpacity : 100;

  body.dataset.variant = variant;
  body.dataset.status = view.status;
  body.dataset.tone = view.tone;
  body.dataset.offline = String(!view.online);
  body.dataset.empty = String(view.percent === null);
  body.dataset.charging = String(view.chargeStatus === 'charging');
  panelEl.style.zoom = String(SIZE_ZOOM[size]);
  cardEl.style.setProperty('--opacity', String(Math.max(0.4, Math.min(1, opacity / 100))));

  const valueText = view.percent === null ? '--' : String(view.percent);
  deviceNameEl.textContent = view.deviceName;
  deviceNameEl.title = view.deviceName;
  batteryValueEl.textContent = valueText;
  renderChip(view.chip);
  statusChipEl.title = view.online ? '' : state.message || '';
  detailTextEl.textContent = view.detail;
  detailTextEl.title = view.online ? '' : state.message || '';
  managerButton.hidden = !view.needsManager;

  const level = view.percent ?? 0;
  batteryMeterEl.style.setProperty('--level', `${level}%`);
  if (view.percent === null) {
    batteryMeterEl.removeAttribute('aria-valuenow');
    batteryMeterEl.setAttribute('aria-valuetext', '电量未知');
  } else {
    batteryMeterEl.setAttribute('aria-valuenow', String(view.percent));
    batteryMeterEl.setAttribute('aria-valuetext', `${view.percent}%`);
  }

  capsuleFillEl.setAttribute('width', String(((CAPSULE_FILL_WIDTH * level) / 100).toFixed(2)));
  capsuleValueEl.textContent = view.percent === null ? '--' : `${view.percent}%`;
  cardEl.title = variant === 'compact' ? capsuleTooltip(view, state) : '';

  const sampledAt = view.online ? state.sampledAt || '' : '';
  if (sampledAt && sampledAt !== lastSampledAt) {
    triggerPulse();
  }
  lastSampledAt = sampledAt;
  fitWindow();
}

function fitWindow() {
  if (!document.body.dataset.variant) {
    return;
  }
  const rect = panelEl.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const key = `${width}x${height}`;
  if (width === 0 || height === 0 || key === lastFitSize) {
    return;
  }
  lastFitSize = key;
  window.atkOverlay.fitSize(width, height);
}

async function applyResult(request) {
  const state = await request;
  if (state) {
    render(state);
  }
}

// 系统拖动会吞掉 mouseup，click/dblclick 不再可靠；双击改由第二次按下的 detail 识别。
cardEl.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) {
    return;
  }
  if (event.detail === 2) {
    void applyResult(window.atkOverlay.toggleVariant());
    return;
  }
  if (!currentState?.positionLocked) {
    window.atkOverlay.startDragging().catch((error) => console.error(error));
  }
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.atkOverlay.showMenu();
});

menuButton.addEventListener('click', () => {
  window.atkOverlay.showMenu();
});

managerButton.addEventListener('click', () => {
  window.atkOverlay.openManager();
});

new ResizeObserver(fitWindow).observe(panelEl);

// 相对时间需要随时间推移刷新。
window.setInterval(() => {
  if (currentState) {
    render(currentState);
  }
}, 30000);

async function boot() {
  render(await window.atkOverlay.getInitialState());
  document.fonts?.ready.then(fitWindow);
  window.atkOverlay.onStateChange(render);
}

boot();
