import * as dom from './dom-refs.js';
import * as stateModule from './state.js';

const shared = window.AtkHidShared;

let hidSelection = {
  open: false,
  devices: [],
  selectedDeviceId: '',
  submitting: false,
};

export function isDialogOpen() {
  return hidSelection.open;
}

export function closeHidSelectionDialog() {
  hidSelection = {
    open: false,
    devices: [],
    selectedDeviceId: '',
    submitting: false,
  };

  document.body.dataset.dialogOpen = 'false';
  dom.hidPickerBackdrop.hidden = true;
  dom.hidPickerListEl.replaceChildren();
  dom.hidPickerEmptyEl.hidden = true;
  dom.hidPickerConfirmButton.disabled = true;
  dom.hidPickerCancelButton.disabled = false;
}

export function renderHidSelectionDialog() {
  const devices = shared.sortChooserDevices(Array.isArray(hidSelection.devices) ? hidSelection.devices : []);
  const hasDevices = devices.length > 0;

  document.body.dataset.dialogOpen = hidSelection.open ? 'true' : 'false';
  dom.hidPickerBackdrop.hidden = !hidSelection.open;

  if (!hidSelection.open) {
    return;
  }

  dom.hidPickerHintEl.textContent = stateModule.hasBoundDevice()
    ? '请选择新的鼠标或接收器。确认后会把当前绑定切换到所选设备。'
    : '请从下方列表里选择你的鼠标或接收器，再继续绑定。';

  dom.hidPickerEmptyEl.hidden = hasDevices;
  dom.hidPickerListEl.replaceChildren();

  for (const device of devices) {
    const item = document.createElement('button');
    const topRow = document.createElement('div');
    const title = document.createElement('strong');
    const metaRow = document.createElement('div');
    const chipRow = document.createElement('div');
    const protocolSupport = shared.supportsKnownBatteryProtocol(device);
    const chips = [];
    const metaParts = [
      `VID ${shared.formatHexId(device.vendorId)}`,
      `PID ${shared.formatHexId(device.productId)}`,
    ];

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

    if (Number.isFinite(device.interface)) {
      metaParts.push(`接口 ${device.interface}`);
    }

    if (Number.isFinite(device.usagePage)) {
      metaParts.push(`UsagePage ${device.usagePage}`);
    }

    if (device.guid) {
      metaParts.push(`GUID ${device.guid}`);
    }

    metaRow.textContent = metaParts.join(' · ');

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

    if ((device.candidateCount || 0) > 1) {
      chips.push({ label: `候选接口 x${device.candidateCount}`, type: '' });
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

    dom.hidPickerListEl.appendChild(item);
  }

  dom.hidPickerCancelButton.disabled = hidSelection.submitting;
  dom.hidPickerConfirmButton.disabled = hidSelection.submitting || !hidSelection.selectedDeviceId || !hasDevices;
}

export function applyHidSelectionPayload(payload) {
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

export async function confirmHidSelection() {
  if (!hidSelection.selectedDeviceId || hidSelection.submitting) {
    return;
  }

  hidSelection = {
    ...hidSelection,
    submitting: true,
  };
  renderHidSelectionDialog();

  const didSubmit = await window.atkManager.pickHidDevice(hidSelection.selectedDeviceId).catch(() => false);
  if (!didSubmit) {
    closeHidSelectionDialog();
    hidSelection = {
      ...hidSelection,
      submitting: false,
    };
    stateModule.showWaitingForBinding('当前没有可用的待选设备，请重新点击"选择并绑定设备"再试一次。');
  }
}

export async function cancelHidSelection() {
  if (hidSelection.submitting) {
    return;
  }

  hidSelection = {
    ...hidSelection,
    submitting: true,
  };
  renderHidSelectionDialog();

  const didCancel = await window.atkManager.cancelHidSelection().catch(() => false);
  if (!didCancel) {
    closeHidSelectionDialog();
    stateModule.showWaitingForBinding('设备选择已取消。需要时可重新点击"选择并绑定设备"。');
  }
}
