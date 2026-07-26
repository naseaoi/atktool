use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::{
    battery_service::BatteryService,
    commands::apply_overlay_variant,
    models::{WindowBounds, WindowPosition},
    state::{save_preferences, AppState},
    system_tray,
};

fn configure_overlay_events(app: &tauri::AppHandle, window: &WebviewWindow) {
    let app_handle = app.clone();
    let tracked_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(position) => {
            let scale = tracked_window.scale_factor().unwrap_or(1.0);
            let logical = position.to_logical::<f64>(scale);
            let preferences = app_handle
                .state::<AppState>()
                .set_overlay_position(WindowPosition {
                    x: logical.x.round() as i32,
                    y: logical.y.round() as i32,
                });
            let _ = save_preferences(&app_handle, &preferences);
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let preferences = app_handle.state::<AppState>().set_overlay_visible(false);
            let _ = save_preferences(&app_handle, &preferences);
            let _ = app_handle.state::<BatteryService>().set_visible(false);
            let _ = tracked_window.destroy();
            let _ = system_tray::update(&app_handle);
        }
        _ => {}
    });
}

fn create_overlay(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    let preferences = app.state::<AppState>().preferences();
    let (width, height, position) = if preferences.overlay_variant == "compact" {
        (80.0, 80.0, preferences.compact_overlay_bounds)
    } else {
        (360.0, 262.0, preferences.overlay_bounds)
    };
    let mut builder =
        WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
            .title("ATK 电量悬浮窗")
            .inner_size(width, height)
            .min_inner_size(width, height)
            .max_inner_size(width, height)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(preferences.always_on_top)
            .skip_taskbar(true);
    if let Some(position) = position {
        builder = builder.position(f64::from(position.x), f64::from(position.y));
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    configure_overlay_events(app, &window);
    apply_overlay_variant(app, &preferences)?;
    Ok(window)
}

pub fn show_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    let window = if let Some(window) = app.get_webview_window("overlay") {
        window
    } else {
        create_overlay(app)?
    };
    window.show().map_err(|error| error.to_string())?;
    let preferences = app.state::<AppState>().set_overlay_visible(true);
    save_preferences(app, &preferences)?;
    app.state::<BatteryService>().set_visible(true)?;
    system_tray::update(app)
}

pub fn hide_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.destroy().map_err(|error| error.to_string())?;
    }
    let preferences = app.state::<AppState>().set_overlay_visible(false);
    save_preferences(app, &preferences)?;
    app.state::<BatteryService>().set_visible(false)?;
    system_tray::update(app)
}

pub fn toggle_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("overlay").is_some() {
        hide_overlay(app)
    } else {
        show_overlay(app)
    }
}

fn remember_manager_bounds(app: &tauri::AppHandle, window: &WebviewWindow) {
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let position = position.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let preferences = app.state::<AppState>().set_manager_bounds(WindowBounds {
        x: position.x.round() as i32,
        y: position.y.round() as i32,
        width: size.width,
    });
    let _ = save_preferences(app, &preferences);
}

pub fn show_manager(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("manager") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let bounds = app.state::<AppState>().preferences().manager_bounds;
    let width = bounds.map_or(880.0, |bounds| bounds.width.max(820.0));
    let mut builder =
        WebviewWindowBuilder::new(app, "manager", WebviewUrl::App("manager.html".into()))
            .title("ATK 设备管理")
            .inner_size(width, 720.0)
            .min_inner_size(820.0, 560.0)
            .resizable(true);
    if let Some(bounds) = bounds {
        builder = builder.position(f64::from(bounds.x), f64::from(bounds.y));
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    let app_handle = app.clone();
    let tracked_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            remember_manager_bounds(&app_handle, &tracked_window);
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            remember_manager_bounds(&app_handle, &tracked_window);
            let _ = tracked_window.destroy();
        }
        _ => {}
    });
    window.set_focus().map_err(|error| error.to_string())
}
