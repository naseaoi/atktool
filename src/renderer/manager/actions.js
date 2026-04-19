import * as stateModule from './state.js';
import * as dialog from './hid-dialog.js';

export async function authorizeDevice() {
  stateModule.setPendingAction('authorize');

  try {
    await window.atkManager.activateStableSource();
    stateModule.applyState({
      status: 'authorizing',
      message: stateModule.hasBoundDevice()
        ? '正在枚举原生 HID 设备，请选择新的鼠标或接收器。'
        : '正在枚举原生 HID 设备，请选择你的鼠标或接收器。',
      needsUserAction: false,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });

    const hasDevices = await window.atkManager.beginHidSelection();
    if (!hasDevices) {
      stateModule.showWaitingForBinding(
        stateModule.hasBoundDevice()
          ? '本次没有选择新设备，当前仍保留原绑定。若鼠标未出现，请确认它使用的是 2.4G 接收器或有线连接。'
          : '本次没有选中设备。若鼠标未出现，请确认它使用的是 2.4G 接收器或有线连接。'
      );
      return;
    }

    dialog.renderHidSelectionDialog();
  } catch (error) {
    stateModule.applyState({
      status: 'error',
      message: `枚举原生 HID 设备失败：${error.message}`,
      needsUserAction: true,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });
  } finally {
    stateModule.setPendingAction('');
  }
}

export async function refreshBoundDevice() {
  await window.atkManager.activateStableSource();

  if (!stateModule.hasBoundDevice()) {
    stateModule.showWaitingForBinding('当前还没有绑定设备，请先选择并绑定设备。');
    return;
  }

  stateModule.setPendingAction('refresh');

  try {
    stateModule.applyState({
      status: 'loading',
      message: '正在刷新当前绑定设备...',
      needsUserAction: false,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });
    await window.atkManager.requestRefresh();
  } finally {
    stateModule.setPendingAction('');
  }
}

export async function unbindCurrentDevice() {
  if (!stateModule.hasBoundDevice()) {
    stateModule.showWaitingForBinding('当前还没有绑定设备，请先选择并绑定设备。');
    return;
  }

  stateModule.setPendingAction('unbind');

  try {
    const nextPreferences = await window.atkManager.clearDeviceBinding();
    stateModule.applyPreferences(nextPreferences);
    stateModule.showWaitingForBinding('当前设备绑定已解除。如需继续读取电量，请重新选择并绑定设备。');
  } finally {
    stateModule.setPendingAction('');
  }
}
