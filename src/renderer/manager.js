import * as dom from './manager/dom-refs.js';
import * as stateModule from './manager/state.js';
import * as dialog from './manager/hid-dialog.js';
import * as actions from './manager/actions.js';

async function boot() {
  const [initialPreferences, initialOverlayState] = await Promise.all([
    window.atkManager.getPreferences(),
    window.atkManager.getOverlayState(),
  ]);

  stateModule.setPreferredDevice(initialPreferences.preferredHidDevice || null);
  stateModule.applyPreferences(initialPreferences);
  stateModule.applyState(initialOverlayState);

  window.atkManager.onPreferencesChanged((nextPreferences) => {
    stateModule.applyPreferences(nextPreferences);
  });
  window.atkManager.onOverlayStateChanged((nextState) => {
    stateModule.applyState(nextState);
  });
  window.atkManager.onHidSelectionChanged((payload) => {
    dialog.applyHidSelectionPayload(payload);
  });

  dom.refreshButton.addEventListener('click', () => {
    actions.refreshBoundDevice();
  });

  dom.authorizeButton.addEventListener('click', () => {
    actions.authorizeDevice();
  });

  dom.unbindButton.addEventListener('click', () => {
    actions.unbindCurrentDevice();
  });

  dom.fallbackButton.addEventListener('click', () => {
    actions.toggleHubSync();
  });

  dom.hidPickerCancelButton.addEventListener('click', () => {
    dialog.cancelHidSelection();
  });

  dom.hidPickerConfirmButton.addEventListener('click', () => {
    dialog.confirmHidSelection();
  });

  dom.hidPickerBackdrop.addEventListener('click', (event) => {
    if (event.target === dom.hidPickerBackdrop) {
      dialog.cancelHidSelection();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dialog.isDialogOpen()) {
      event.preventDefault();
      dialog.cancelHidSelection();
    }
  });

  async function submit(controls, save) {
    for (const control of controls) control.disabled = true;
    dom.settingsError.hidden = true;
    try {
      await save();
    } catch (error) {
      stateModule.applyPreferences(stateModule.getPreferences());
      dom.settingsError.textContent = `设置保存失败：${error.message || error}`;
      dom.settingsError.hidden = false;
    } finally {
      for (const control of controls) control.disabled = false;
    }
  }

  dom.startupToggle.addEventListener('click', () => submit([dom.startupToggle], () =>
    window.atkManager.setOpenAtLogin(!stateModule.getPreferences().openAtLogin)));
  for (const button of dom.variantButtons) {
    button.addEventListener('click', () => submit(dom.variantButtons, () =>
      window.atkManager.setOverlayVariant(button.dataset.variant)));
  }
  for (const button of dom.sizeButtons) {
    button.addEventListener('click', () => submit(dom.sizeButtons, () =>
      window.atkManager.updatePreferences({ overlaySize: button.dataset.size })));
  }
  for (const button of dom.preferenceToggles) {
    const key = button.dataset.pref;
    button.addEventListener('click', () => submit([button], () =>
      window.atkManager.updatePreferences({ [key]: !stateModule.getPreferences()[key] })));
  }
  dom.opacityInput.addEventListener('input', () => {
    stateModule.renderOpacity(dom.opacityInput.valueAsNumber);
  });
  dom.opacityInput.addEventListener('change', () => submit([dom.opacityInput], () =>
    window.atkManager.updatePreferences({ overlayOpacity: dom.opacityInput.valueAsNumber })));

  stateModule.updateActionButtons();

  // 离线读数的相对时间需要随时间推移刷新。
  window.setInterval(() => stateModule.applyState({}), 30000);

  if (!initialPreferences.hubSync && !stateModule.hasBoundDevice() && initialOverlayState.status === 'loading') {
    stateModule.showWaitingForBinding('还没有绑定设备。请先选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
  }

  // 窗口在首次上报高度后才显示；隐藏窗口里的定时器会被节流，因此首次测量直接同步执行。
  stateModule.fitHeight();
  window.addEventListener('resize', stateModule.scheduleFitHeight);
}

boot();
