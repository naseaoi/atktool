use std::sync::{Mutex, MutexGuard};

use tauri::{
    image::Image,
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem,
    },
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};
use tauri_plugin_autostart::ManagerExt;

use crate::{
    commands::{apply_overlay_variant, emit_overlay, emit_preferences, refresh_active_source},
    state::{save_preferences, AppState},
    tray_text, window_manager,
};

const TRAY_ID: &str = "main";

const TRAY_SIZE: usize = 32;
const TEXT_MAX_WIDTH: usize = 26;
const TEXT_MAX_HEIGHT: usize = 24;

fn fill_rect(
    pixels: &mut [u8],
    size: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    color: [u8; 4],
) {
    for row in y..y.saturating_add(height).min(size) {
        for column in x..x.saturating_add(width).min(size) {
            let index = (row * size + column) * 4;
            pixels[index..index + 4].copy_from_slice(&color);
        }
    }
}

fn tray_label(percent: Option<u8>) -> String {
    match percent {
        Some(100) => "F".to_owned(),
        Some(value) => value.to_string(),
        None => "--".to_owned(),
    }
}

fn tray_color(percent: Option<u8>, charging: bool) -> [u8; 4] {
    if charging {
        [126, 230, 168, 255]
    } else if percent.is_some_and(|value| value < 20) {
        [255, 166, 70, 255]
    } else {
        [255, 255, 255, 255]
    }
}

fn tray_image(percent: Option<u8>, charging: bool) -> Image<'static> {
    let text = tray_label(percent);
    let color = tray_color(percent, charging);
    let mut pixels =
        tray_text::render_centered(TRAY_SIZE, &text, color, TEXT_MAX_WIDTH, TEXT_MAX_HEIGHT)
            .unwrap_or_else(|| vec![0u8; TRAY_SIZE * TRAY_SIZE * 4]);
    let border = [228, 244, 244, 255];
    fill_rect(&mut pixels, TRAY_SIZE, 1, 1, 30, 1, border);
    fill_rect(&mut pixels, TRAY_SIZE, 1, 30, 30, 1, border);
    fill_rect(&mut pixels, TRAY_SIZE, 1, 2, 1, 28, border);
    fill_rect(&mut pixels, TRAY_SIZE, 30, 2, 1, 28, border);
    Image::new_owned(pixels, TRAY_SIZE as u32, TRAY_SIZE as u32)
}

const MENU_LABEL_WIDTH: usize = 18;
const MENU_ELLIPSIS: char = '…';

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayMenuSnapshot {
    toggle_text: String,
    status_text: String,
    battery_text: String,
    device_text: String,
    protocol_text: String,
    always_on_top: bool,
    compact: bool,
    autostart: bool,
    battery_percent: Option<u8>,
    charging: bool,
}

struct TrayMenuState {
    menu: Menu<Wry>,
    toggle: MenuItem<Wry>,
    status: MenuItem<Wry>,
    battery: MenuItem<Wry>,
    device: MenuItem<Wry>,
    protocol: MenuItem<Wry>,
    pin: CheckMenuItem<Wry>,
    compact: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    snapshot: Mutex<TrayMenuSnapshot>,
}

impl TrayMenuState {
    fn lock_snapshot(&self) -> MutexGuard<'_, TrayMenuSnapshot> {
        self.snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

fn char_width(character: char) -> usize {
    if (character as u32) < 0x1100 {
        1
    } else {
        2
    }
}

fn ellipsize(label: &str, max_width: usize) -> String {
    let total: usize = label.chars().map(char_width).sum();
    if total <= max_width {
        return label.to_owned();
    }
    let budget = max_width.saturating_sub(char_width(MENU_ELLIPSIS));
    let mut width = 0;
    let mut result = String::new();
    for character in label.chars() {
        let next = width + char_width(character);
        if next > budget {
            break;
        }
        width = next;
        result.push(character);
    }
    result.push(MENU_ELLIPSIS);
    result
}

fn menu_snapshot(app: &AppHandle) -> TrayMenuSnapshot {
    let state = app.state::<AppState>();
    let overlay = state.overlay();
    let preferences = state.preferences();
    let visible = app
        .get_webview_window("overlay")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);

    TrayMenuSnapshot {
        toggle_text: if visible {
            "隐藏悬浮窗".to_owned()
        } else {
            "显示悬浮窗".to_owned()
        },
        status_text: format!("连接状态：{}", status_label(&overlay.status)),
        battery_text: overlay
            .battery_percent
            .map(|percent| format!("当前电量：{percent}%"))
            .unwrap_or_else(|| "当前电量：--".to_owned()),
        device_text: ellipsize(
            &format!(
                "设备：{}",
                if overlay.device_name.is_empty() {
                    "尚未识别到设备"
                } else {
                    &overlay.device_name
                }
            ),
            MENU_LABEL_WIDTH,
        ),
        protocol_text: ellipsize(
            &format!(
                "协议：{}",
                if overlay.protocol_name.is_empty() {
                    "尚未建立稳定直连"
                } else {
                    &overlay.protocol_name
                }
            ),
            MENU_LABEL_WIDTH,
        ),
        always_on_top: preferences.always_on_top,
        compact: preferences.overlay_variant == "compact",
        autostart: preferences.open_at_login,
        battery_percent: overlay.battery_percent,
        charging: overlay.charging,
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<TrayMenuState> {
    let snapshot = menu_snapshot(app);
    let toggle = MenuItemBuilder::with_id("toggle-overlay", &snapshot.toggle_text).build(app)?;
    let manager = MenuItemBuilder::with_id("show-manager", "打开设备管理").build(app)?;
    let refresh = MenuItemBuilder::with_id("refresh", "刷新直连状态").build(app)?;
    let status = MenuItemBuilder::with_id("status", &snapshot.status_text)
        .enabled(false)
        .build(app)?;
    let battery = MenuItemBuilder::with_id("battery", &snapshot.battery_text)
        .enabled(false)
        .build(app)?;
    let device = MenuItemBuilder::with_id("device", &snapshot.device_text)
        .enabled(false)
        .build(app)?;
    let protocol = MenuItemBuilder::with_id("protocol", &snapshot.protocol_text)
        .enabled(false)
        .build(app)?;
    let pin = CheckMenuItemBuilder::with_id("toggle-pin", "保持置顶")
        .checked(snapshot.always_on_top)
        .build(app)?;
    let compact = CheckMenuItemBuilder::with_id("toggle-compact", "简略悬浮窗")
        .checked(snapshot.compact)
        .build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("toggle-autostart", "开机启动")
        .checked(snapshot.autostart)
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let separator3 = PredefinedMenuItem::separator(app)?;
    let separator4 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &manager,
            &separator1,
            &refresh,
            &separator2,
            &status,
            &battery,
            &device,
            &protocol,
            &separator3,
            &pin,
            &compact,
            &autostart,
            &separator4,
            &quit,
        ],
    )?;
    Ok(TrayMenuState {
        menu,
        toggle,
        status,
        battery,
        device,
        protocol,
        pin,
        compact,
        autostart,
        snapshot: Mutex::new(snapshot),
    })
}

fn status_label(status: &str) -> &'static str {
    match status {
        "connected" => "已连接",
        "unsupported" => "待适配",
        "waiting" => "待连接",
        "error" => "异常",
        _ => "加载中",
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "toggle-overlay" => {
            let _ = window_manager::toggle_overlay(app);
        }
        "show-manager" => {
            let _ = window_manager::show_manager(app);
        }
        "refresh" => {
            let _ = refresh_active_source(app);
        }
        "toggle-pin" => {
            let state = app.state::<AppState>();
            let (preferences, overlay) = state.toggle_pin();
            if let Some(window) = app.get_webview_window("overlay") {
                let _ = window.set_always_on_top(preferences.always_on_top);
            }
            let _ = save_preferences(app, &preferences);
            let _ = emit_preferences(app, &preferences);
            let _ = emit_overlay(app, &overlay);
            let _ = update(app);
        }
        "toggle-compact" => {
            let state = app.state::<AppState>();
            let next = if state.preferences().overlay_variant == "compact" {
                "full"
            } else {
                "compact"
            };
            let (preferences, overlay) = state.set_overlay_variant(next);
            let _ = apply_overlay_variant(app, &preferences);
            let _ = save_preferences(app, &preferences);
            let _ = emit_preferences(app, &preferences);
            let _ = emit_overlay(app, &overlay);
            let _ = update(app);
        }
        "toggle-autostart" => {
            let next = !app.state::<AppState>().preferences().open_at_login;
            let result = if next {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
            if result.is_ok() {
                let actual = app.autolaunch().is_enabled().unwrap_or(next);
                let preferences = app.state::<AppState>().set_open_at_login(actual);
                let _ = save_preferences(app, &preferences);
                let _ = emit_preferences(app, &preferences);
                let _ = update(app);
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn create(app: &AppHandle) -> Result<(), String> {
    let overlay = app.state::<AppState>().overlay();
    let menu_state = build_menu(app).map_err(|error| error.to_string())?;
    if !app.manage(menu_state) {
        return Err("托盘菜单状态已初始化".to_owned());
    }
    let menu_state = app.state::<TrayMenuState>();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_image(overlay.battery_percent, overlay.charging))
        .tooltip("ATK 电量悬浮窗")
        .menu(&menu_state.menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = window_manager::toggle_overlay(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn update(app: &AppHandle) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let menu_state = app.state::<TrayMenuState>();
    let next = menu_snapshot(app);
    let current = menu_state.lock_snapshot().clone();
    let battery_changed = current.battery_percent != next.battery_percent;

    if battery_changed || current.charging != next.charging {
        tray.set_icon(Some(tray_image(next.battery_percent, next.charging)))
            .map_err(|error| error.to_string())?;
    }
    if battery_changed {
        let tooltip = next
            .battery_percent
            .map(|percent| format!("ATK 电量 {percent}%"))
            .unwrap_or_else(|| "ATK 电量悬浮窗".to_owned());
        tray.set_tooltip(Some(tooltip))
            .map_err(|error| error.to_string())?;
    }
    if current.toggle_text != next.toggle_text {
        menu_state
            .toggle
            .set_text(&next.toggle_text)
            .map_err(|error| error.to_string())?;
    }
    if current.status_text != next.status_text {
        menu_state
            .status
            .set_text(&next.status_text)
            .map_err(|error| error.to_string())?;
    }
    if current.battery_text != next.battery_text {
        menu_state
            .battery
            .set_text(&next.battery_text)
            .map_err(|error| error.to_string())?;
    }
    if current.device_text != next.device_text {
        menu_state
            .device
            .set_text(&next.device_text)
            .map_err(|error| error.to_string())?;
    }
    if current.protocol_text != next.protocol_text {
        menu_state
            .protocol
            .set_text(&next.protocol_text)
            .map_err(|error| error.to_string())?;
    }
    if current.always_on_top != next.always_on_top {
        menu_state
            .pin
            .set_checked(next.always_on_top)
            .map_err(|error| error.to_string())?;
    }
    if current.compact != next.compact {
        menu_state
            .compact
            .set_checked(next.compact)
            .map_err(|error| error.to_string())?;
    }
    if current.autostart != next.autostart {
        menu_state
            .autostart
            .set_checked(next.autostart)
            .map_err(|error| error.to_string())?;
    }
    *menu_state.lock_snapshot() = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ellipsize, tray_label, MENU_LABEL_WIDTH};

    #[test]
    fn shows_full_marker_instead_of_hundred() {
        assert_eq!(tray_label(Some(100)), "F");
        assert_eq!(tray_label(Some(90)), "90");
        assert_eq!(tray_label(Some(5)), "5");
        assert_eq!(tray_label(None), "--");
    }

    #[test]
    fn truncates_long_menu_labels_by_character_width() {
        assert_eq!(ellipsize("设备：ATK X1", 20), "设备：ATK X1");
        assert_eq!(
            ellipsize("设备：ATK A9 Ultra Max 2.0 Tri-Mode", 20),
            "设备：ATK A9 Ultra…"
        );
        assert_eq!(ellipsize("中文设备名称超长测试用例文本", 12), "中文设备名…");
        assert_eq!(
            ellipsize("设备：ATK A9 Ultra Max", MENU_LABEL_WIDTH),
            "设备：ATK A9 Ult…"
        );
    }
}
