use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalRect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::{
    battery_service::BatteryService,
    models::{Preferences, WindowBounds, WindowPosition},
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
                    scale_factor: Some(scale),
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

pub fn overlay_geometry(preferences: &Preferences) -> (f64, f64, Option<WindowPosition>) {
    if preferences.overlay_variant == "compact" {
        (80.0, 80.0, preferences.compact_overlay_bounds)
    } else {
        (360.0, 262.0, preferences.overlay_bounds)
    }
}

fn create_overlay(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    let preferences = app.state::<AppState>().preferences();
    let (width, height, position) = overlay_geometry(&preferences);
    let builder = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("ATK 电量悬浮窗")
        .inner_size(width, height)
        .min_inner_size(width, height)
        .max_inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(preferences.always_on_top)
        .skip_taskbar(true)
        .visible(false);
    let window = builder.build().map_err(|error| error.to_string())?;
    configure_overlay_events(app, &window);
    restore_created_window(app, &window, position)?;
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
        position: WindowPosition {
            x: position.x.round() as i32,
            y: position.y.round() as i32,
            scale_factor: Some(scale),
        },
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
    let builder = WebviewWindowBuilder::new(app, "manager", WebviewUrl::App("manager.html".into()))
        .title("ATK 设备管理")
        .inner_size(width, 720.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .visible(false);
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
    restore_created_window(app, &window, bounds.map(|bounds| bounds.position))?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn reset_overlay_position(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("overlay").is_none() {
        show_overlay(app)?;
    }
    let window = app.get_webview_window("overlay").ok_or("找不到悬浮窗")?;
    place_window(app, &window, None)
}

type WorkArea = PhysicalRect<i32, u32>;

fn visible_position(
    saved: WindowPosition,
    size: LogicalSize<f64>,
    monitors: impl IntoIterator<Item = (WorkArea, f64)>,
) -> Option<PhysicalPosition<i32>> {
    monitors.into_iter().find_map(|(area, scale)| {
        // 旧偏好只有逻辑坐标，按候选显示器的 DPI 还原；新偏好使用保存时的 DPI。
        let saved_scale = saved.scale_factor.unwrap_or(scale);
        let x = (f64::from(saved.x) * saved_scale).round();
        let y = (f64::from(saved.y) * saved_scale).round();
        let left = f64::from(area.position.x);
        let top = f64::from(area.position.y);
        // 保留顶部中央的 40×40 逻辑像素，避免只露出底边而无法拖动标题栏。
        let grip = 40.0 * scale;
        let grip_x = x + (size.width * scale - grip) / 2.0;
        (grip_x >= left
            && grip_x + grip <= left + f64::from(area.size.width)
            && y >= top
            && y + grip <= top + f64::from(area.size.height))
        .then_some(PhysicalPosition::new(x as i32, y as i32))
    })
}

fn centered_position(area: WorkArea, scale: f64, size: LogicalSize<f64>) -> PhysicalPosition<i32> {
    let size = size.to_physical::<f64>(scale);
    PhysicalPosition::new(
        (f64::from(area.position.x) + ((f64::from(area.size.width) - size.width) / 2.0).max(0.0))
            .round() as i32,
        (f64::from(area.position.y) + ((f64::from(area.size.height) - size.height) / 2.0).max(0.0))
            .round() as i32,
    )
}

pub fn place_window(
    app: &AppHandle,
    window: &WebviewWindow,
    saved: Option<WindowPosition>,
) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = window
        .outer_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    if let Some(saved) = saved {
        let monitors = app
            .available_monitors()
            .map_err(|error| error.to_string())?;
        if let Some(position) = visible_position(
            saved,
            size,
            monitors.iter().map(|m| (*m.work_area(), m.scale_factor())),
        ) {
            return window
                .set_position(position)
                .map_err(|error| error.to_string());
        }
    }
    let primary = app
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("找不到主显示器")?;
    window
        .set_position(centered_position(
            *primary.work_area(),
            primary.scale_factor(),
            size,
        ))
        .map_err(|error| error.to_string())
}

fn restore_created_window(
    app: &AppHandle,
    window: &WebviewWindow,
    position: Option<WindowPosition>,
) -> Result<(), String> {
    if let Some(position) = position {
        if let Err(error) = place_window(app, window, Some(position)) {
            let _ = window.destroy();
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: i32, y: i32, width: u32, height: u32) -> WorkArea {
        WorkArea {
            position: (x, y).into(),
            size: (width, height).into(),
        }
    }

    #[test]
    fn restores_negative_mixed_dpi_position_only_while_visible() {
        let primary = (area(0, 0, 1920, 1040), 1.0);
        let secondary = (area(-2400, 0, 2400, 1400), 1.5);
        let saved = WindowPosition {
            x: -1200,
            y: 100,
            scale_factor: None,
        };
        let size = LogicalSize::new(360.0, 262.0);
        assert_eq!(
            visible_position(saved, size, [primary, secondary]),
            Some((-1800, 150).into())
        );
        assert_eq!(visible_position(saved, size, [primary]), None);
        let saved = WindowPosition {
            scale_factor: Some(2.0),
            ..saved
        };
        assert_eq!(
            visible_position(saved, size, [secondary]),
            Some((-2400, 200).into())
        );
    }

    #[test]
    fn requires_top_drag_area_inside_work_area() {
        let monitors = [(area(0, 30, 800, 600), 1.0)];
        let visible = |x, y| {
            visible_position(
                WindowPosition {
                    x,
                    y,
                    scale_factor: None,
                },
                LogicalSize::new(80.0, 80.0),
                monitors,
            )
            .is_some()
        };
        assert!(visible(-20, 590));
        assert!(!visible(-21, 590));
        assert!(!visible(0, 591));
        assert!(!visible(0, 29));
    }

    #[test]
    fn centers_each_variant_in_scaled_offset_work_area() {
        let area = area(40, 20, 1800, 1200);
        assert_eq!(
            centered_position(area, 1.5, LogicalSize::new(80.0, 80.0)),
            (880, 560).into()
        );
        assert_eq!(
            centered_position(area, 1.5, LogicalSize::new(360.0, 262.0)),
            (670, 424).into()
        );
    }
}
