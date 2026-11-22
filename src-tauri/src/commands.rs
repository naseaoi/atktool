use hidapi::HidApi;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Size, State};
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
    let (width, height, position) = window_manager::overlay_geometry(preferences);
    resize_overlay(&window, width, height)?;
    if let Some(position) = position {
        window_manager::place_window(app, &window, Some(position))?;
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
    let actual = if tauri::is_dev() {
        enabled
    } else {
        if enabled {
            app.autolaunch()
                .enable()
                .map_err(|error| error.to_string())?;
        } else {
            app.autolaunch()
                .disable()
                .map_err(|error| error.to_string())?;
        }
        app.autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())?
    };
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
    let mut height = content_height.max(window_manager::MANAGER_MIN_HEIGHT);
    if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
        let work = monitor.work_area();
        let outer = window.outer_size().map_err(|e| e.to_string())?;
        let top = window
            .outer_position()
            .map_err(|e| e.to_string())?
            .y
            .max(work.position.y);
        let available = f64::from(work.position.y - top) + f64::from(work.size.height)
            - f64::from(outer.height.saturating_sub(current.height));
        height = height.min((available / scale_factor).max(window_manager::MANAGER_MIN_HEIGHT));
    }
    window
        .set_size(Size::Logical(LogicalSize::new(logical.width, height)))
        .map_err(|error| error.to_string())?;
    window_manager::reveal_manager(&window)
}

#[tauri::command]
pub fn fit_overlay_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() {
        return Err("悬浮窗尺寸无效".into());
    }
    if let Some(window) = app.get_webview_window("overlay") {
        resize_overlay(&window, width.clamp(40.0, 800.0), height.clamp(40.0, 800.0))?;
    }
    Ok(())
}

fn resize_overlay(window: &tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let size = LogicalSize::new(width, height);
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if window.inner_size().map_err(|e| e.to_string())? == size.to_physical::<u32>(scale) {
        return Ok(());
    }
    crate::overlay_edge::reconfigure(window.app_handle())?;
    let horizontal = Some(tauri::PixelUnit::Logical(tauri::LogicalUnit::new(width)));
    let vertical = Some(tauri::PixelUnit::Logical(tauri::LogicalUnit::new(height)));
    window
        .set_size_constraints(tauri::WindowSizeConstraints {
            min_width: horizontal,
            max_width: horizontal,
            min_height: vertical,
            max_height: vertical,
        })
        .map_err(|e| e.to_string())?;
    window.set_size(size).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencesPatch {
    pub overlay_size: Option<String>,
    pub overlay_opacity: Option<u8>,
    pub position_locked: Option<bool>,
    pub smart_display: Option<bool>,
    pub edge_auto_hide: Option<bool>,
    pub hide_in_fullscreen: Option<bool>,
    pub low_battery_notify: Option<bool>,
}

#[tauri::command]
pub fn update_preferences(app: AppHandle, patch: PreferencesPatch) -> Result<Preferences, String> {
    if patch
        .overlay_size
        .as_ref()
        .is_some_and(|size| !crate::state::OVERLAY_SIZES.contains(&size.as_str()))
        || patch
            .overlay_opacity
            .is_some_and(|v| !(crate::state::OVERLAY_OPACITY_MIN..=100).contains(&v))
    {
        return Err("悬浮窗尺寸或不透明度无效".into());
    }
    let state = app.state::<AppState>();
    let old = state.preferences();
    let preferences = state.edit_preferences(&app, |p| {
        if let Some(v) = patch.overlay_size {
            p.overlay_size = v;
        }
        if let Some(v) = patch.overlay_opacity {
            p.overlay_opacity = v;
        }
        if let Some(v) = patch.position_locked {
            p.position_locked = v;
        }
        if let Some(v) = patch.smart_display {
            p.smart_display = v;
        }
        if let Some(v) = patch.edge_auto_hide {
            p.edge_auto_hide = v;
        }
        if let Some(v) = patch.hide_in_fullscreen {
            p.hide_in_fullscreen = v;
        }
        if let Some(v) = patch.low_battery_notify {
            p.low_battery_notify = v;
        }
    })?;
    emit_preferences(&app, &preferences)?;
    if preferences.overlay_size != old.overlay_size {
        apply_overlay_variant(&app, &preferences)?;
    }
    if preferences.edge_auto_hide != old.edge_auto_hide {
        crate::overlay_edge::reconfigure(&app)?;
    }
    emit_overlay(&app, &state.refresh_overlay_view())?;
    Ok(preferences)
}

#[tauri::command]
pub async fn open_manager(app: AppHandle) -> Result<(), String> {
    window_manager::show_manager(&app)
}

#[tauri::command]
pub fn show_overlay_menu(app: AppHandle) -> Result<(), String> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder};
    let p = app.state::<AppState>().preferences();
    let window = app.get_webview_window("overlay").ok_or("找不到悬浮窗")?;
    let check = |id, text, value| {
        CheckMenuItemBuilder::with_id(id, text)
            .checked(value)
            .build(&app)
            .map_err(|e| e.to_string())
    };
    let pin = check("overlay.pin", "保持置顶", p.always_on_top)?;
    let lock = check("overlay.lock", "锁定位置", p.position_locked)?;
    let compact = check(
        "overlay.variant",
        "简略模式",
        p.overlay_variant == "compact",
    )?;
    let menu = MenuBuilder::new(&app)
        .items(&[&pin, &lock, &compact])
        .separator()
        .text("overlay.refresh", "立即刷新")
        .text("overlay.manager", "打开设备管理")
        .separator()
        .text("overlay.hide", "隐藏悬浮窗")
        .build()
        .map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
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
