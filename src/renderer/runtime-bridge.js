(() => {
  if (window.atkManager || window.atkOverlay) {
    return;
  }

  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke || !tauri?.event?.listen) {
    return;
  }

  const invoke = (command, args) => tauri.core.invoke(command, args);
  const send = (command, args) => {
    void invoke(command, args).catch((error) => console.error(error));
  };
  const subscribe = (eventName, callback) => {
    let unlisten = null;
    let disposed = false;

    void tauri.event.listen(eventName, (event) => callback(event.payload)).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  };

  window.atkManager = {
    getPreferences: () => invoke('get_preferences'),
    getOverlayState: () => invoke('get_overlay_state'),
    setOpenAtLogin: (enabled) => invoke('set_open_at_login', { enabled }),
    setOverlayVariant: (overlayVariant) => invoke('set_overlay_variant', { overlayVariant }),
    updatePreferences: (patch) => invoke('update_preferences', { patch }),
    requestRefresh: () => invoke('request_refresh'),
    fitHeight: (contentHeight) => send('fit_manager_height', { contentHeight }),
    activateStableSource: () => invoke('activate_stable_source'),
    beginHidSelection: () => invoke('begin_hid_selection'),
    pickHidDevice: (deviceId) => invoke('pick_hid_device', { deviceId }),
    cancelHidSelection: () => invoke('cancel_hid_selection'),
    clearDeviceBinding: () => invoke('clear_device_binding'),
    openFallback: () => invoke('open_fallback'),
    onPreferencesChanged: (callback) => subscribe('manager:preferences', callback),
    onOverlayStateChanged: (callback) => subscribe('manager:overlay-state', callback),
    onHidSelectionChanged: (callback) => subscribe('manager:hid-selection', callback),
  };

  window.atkOverlay = {
    getInitialState: () => invoke('get_overlay_state'),
    onStateChange: (callback) => subscribe('overlay:state-changed', callback),
    requestRefresh: () => invoke('request_refresh'),
    togglePin: () => invoke('toggle_pin'),
    toggleVariant: () => invoke('toggle_variant'),
    fitSize: (width, height) => send('fit_overlay_size', { width, height }),
    hideOverlay: () => send('hide_overlay'),
    showMenu: () => send('show_overlay_menu'),
    openManager: () => send('open_manager'),
    startDragging: () => tauri.window.getCurrentWindow().startDragging(),
  };
})();
