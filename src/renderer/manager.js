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
    window.atkManager.openFallback();
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

  dom.startupToggle.addEventListener('click', async () => {
    dom.startupToggle.disabled = true;

    try {
      const nextPreferences = await window.atkManager.setOpenAtLogin(!stateModule.getPreferences().openAtLogin);
      stateModule.applyPreferences(nextPreferences);
    } finally {
      dom.startupToggle.disabled = false;
    }
  });

  dom.overlayModeToggle.addEventListener('click', async () => {
    dom.overlayModeToggle.disabled = true;

    try {
      const nextVariant = stateModule.getPreferences().overlayVariant === 'compact' ? 'full' : 'compact';
      const nextPreferences = await window.atkManager.setOverlayVariant(nextVariant);
      stateModule.applyPreferences(nextPreferences);
    } finally {
      dom.overlayModeToggle.disabled = false;
    }
  });

  stateModule.updateActionButtons();
  stateModule.scheduleFitHeight();

  window.requestAnimationFrame(() => {
    document.body.dataset.ready = 'true';
  });

  if (!stateModule.hasBoundDevice() && initialOverlayState.status === 'loading') {
    stateModule.showWaitingForBinding('还没有绑定设备。请先选择并绑定设备，并确保鼠标使用 2.4G 或有线连接。');
  }
}

boot();
