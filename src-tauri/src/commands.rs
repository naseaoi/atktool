use hidapi::HidApi;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, State};
use tauri_plugin_autostart::ManagerExt;

use crate::{
    battery_service::BatteryService,
    device::{chooser_devices, group_binding, list_devices},
    hub,
    models::{HidSelectionPayload, OverlayState, Preferences},
    state::{save_preferences, AppState},
    window_manager,
};

pub fn emit_preferences(app: &AppHandle, preferences: &Preferences) -> Result<(), String> {
    app.emit("manager:preferences", preferences)
        .map_err(|error| error.to_string())
}

pub fn emit_overlay(app: &AppHandle, overlay: &OverlayState) -> Result<(), String> {
    app.emit("overlay:state-changed", overlay)
        .map_err(|error| error.to_string())?;
    app.emit("manager:overlay-state", overlay)
        .map_err(|error| error.to_string())
}

pub fn apply_overlay_variant(app: &AppHandle, preferences: &Preferences) -> Result<(), String> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    let (width, height, position) = if preferences.overlay_variant == "compact" {
        (80.0, 80.0, preferences.compact_overlay_bounds)
    } else {
        (360.0, 262.0, preferences.overlay_bounds)
    };
    window
        .set_min_size(Some(Size::Logical(LogicalSize::new(width, height))))
        .map_err(|error| error.to_string())?;
    window
        .set_max_size(Some(Size::Logical(LogicalSize::new(width, height))))
        .map_err(|error| error.to_string())?;
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())?;
    if let Some(position) = position {
        window
            .set_position(Position::Logical(LogicalPosition::new(
                f64::from(position.x),
                f64::from(position.y),
            )))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_preferences(state: State<'_, AppState>) -> Preferences {
    state.preferences()
}

#[tauri::command]
pub fn get_overlay_state(state: State<'_, AppState>) -> OverlayState {
    state.overlay()
}

#[tauri::command]
pub fn set_open_at_login(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<Preferences, String> {
    if enabled {
        app.autolaunch()
            .enable()
            .map_err(|error| error.to_string())?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|error| error.to_string())?;
    }
    let actual = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())?;
    let preferences = state.set_open_at_login(actual);
    save_preferences(&app, &preferences)?;
    emit_preferences(&app, &preferences)?;
    Ok(preferences)
}

#[tauri::command]
pub fn set_overlay_variant(
    app: AppHandle,
    state: State<'_, AppState>,
    overlay_variant: String,
) -> Result<Preferences, String> {
    let (preferences, overlay) = state.set_overlay_variant(&overlay_variant);
    apply_overlay_variant(&app, &preferences)?;
    save_preferences(&app, &preferences)?;
    emit_preferences(&app, &preferences)?;
    emit_overlay(&app, &overlay)?;
    Ok(preferences)
}

#[tauri::command]
pub fn toggle_pin(app: AppHandle, state: State<'_, AppState>) -> Result<OverlayState, String> {
    let (preferences, overlay) = state.toggle_pin();
    if let Some(window) = app.get_webview_window("overlay") {
        window
            .set_always_on_top(overlay.always_on_top)
            .map_err(|error| error.to_string())?;
    }
    save_preferences(&app, &preferences)?;
    emit_preferences(&app, &preferences)?;
    emit_overlay(&app, &overlay)?;
    Ok(overlay)
}

#[tauri::command]
pub fn toggle_variant(app: AppHandle, state: State<'_, AppState>) -> Result<OverlayState, String> {
    let next = if state.overlay().overlay_variant == "compact" {
        "full"
    } else {
        "compact"
    };
    let (preferences, overlay) = state.set_overlay_variant(next);
    apply_overlay_variant(&app, &preferences)?;
    save_preferences(&app, &preferences)?;
    emit_preferences(&app, &preferences)?;
    emit_overlay(&app, &overlay)?;
    Ok(overlay)
}

pub fn refresh_active_source(app: &AppHandle) -> Result<(), String> {
    if !app.state::<AppState>().hub_sync() {
        return app.state::<BatteryService>().refresh(true);
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = hub::reload(&handle);
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn request_refresh(app: AppHandle) -> Result<bool, String> {
    refresh_active_source(&app)?;
    Ok(true)
}

#[tauri::command]
pub fn fit_manager_height(app: AppHandle, content_height: f64) -> Result<(), String> {
    if !content_height.is_finite() {
        return Err("管理页高度无效".to_owned());
    }
    let Some(window) = app.get_webview_window("manager") else {
        return Ok(());
    };
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let current = window.inner_size().map_err(|error| error.to_string())?;
    let logical = current.to_logical::<f64>(scale_factor);
    window
        .set_size(Size::Logical(LogicalSize::new(
            logical.width,
            content_height.max(560.0),
        )))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn fit_overlay_height(
    app: AppHandle,
    state: State<'_, AppState>,
    content_height: f64,
) -> Result<(), String> {
    if !content_height.is_finite() {
        return Err("悬浮窗高度无效".to_owned());
    }
    if state.preferences().overlay_variant == "compact" {
        return Ok(());
    }
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    let height = content_height.max(262.0);
    window
        .set_min_size(Some(Size::Logical(LogicalSize::new(360.0, height))))
        .map_err(|error| error.to_string())?;
    window
        .set_max_size(Some(Size::Logical(LogicalSize::new(360.0, height))))
        .map_err(|error| error.to_string())?;
    window
        .set_size(Size::Logical(LogicalSize::new(360.0, height)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    window_manager::hide_overlay(&app)
}

#[tauri::command]
pub fn activate_stable_source(app: AppHandle) -> Result<bool, String> {
    hub::activate_stable(&app)?;
    Ok(true)
}

#[tauri::command]
pub async fn begin_hid_selection(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut api = HidApi::new().map_err(|error| format!("HID 初始化失败：{error}"))?;
    let native_devices = list_devices(&mut api)?;
    let preferences = state.preferences();
    let devices = chooser_devices(&native_devices, preferences.preferred_hid_device.as_ref());
    let has_devices = !devices.is_empty();
    state.set_chooser_devices(devices.clone());
    app.emit(
        "manager:hid-selection",
        HidSelectionPayload {
            open: has_devices,
            devices,
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(has_devices)
}

#[tauri::command]
pub async fn pick_hid_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<bool, String> {
    if state.chooser_device(&device_id).is_none() {
        return Ok(false);
    }
    let mut api = HidApi::new().map_err(|error| format!("HID 初始化失败：{error}"))?;
    let native_devices = list_devices(&mut api)?;
    let preferences = state.preferences();
    let Some((binding, display_name)) = group_binding(
        &native_devices,
        &device_id,
        preferences.preferred_hid_device.as_ref(),
    ) else {
        return Ok(false);
    };
    hub::activate_stable(&app)?;
    let preferences = state.bind_device(binding.clone(), display_name);
    state.clear_chooser_devices();
    save_preferences(&app, &preferences)?;
    emit_preferences(&app, &preferences)?;
    app.emit("manager:hid-selection", HidSelectionPayload::default())
        .map_err(|error| error.to_string())?;
    app.state::<BatteryService>().set_binding(Some(binding))?;
    app.state::<BatteryService>().refresh(true)?;
    Ok(true)
}

#[tauri::command]
pub fn cancel_hid_selection(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    state.clear_chooser_devices();
    app.emit("manager:hid-selection", HidSelectionPayload::default())
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn clear_device_binding(
    app: AppHandle,
    state: State<'_, AppState>,
    service: State<'_, BatteryService>,
) -> Result<Preferences, String> {
    hub::activate_stable(&app)?;
    let preferences = state.clear_device_binding();
    service.set_binding(None)?;
    save_preferences(&app, &preferences)?;
    emit_preferences(&app, &preferences)?;
    service.refresh(false)?;
    Ok(preferences)
}

#[tauri::command]
pub async fn open_fallback(app: AppHandle) -> Result<(), String> {
    hub::open(&app)
}
